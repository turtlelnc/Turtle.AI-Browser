// 原生外壳的构建编排：解压 CEF、初始化 MSVC 环境、CMake 配置与构建、运行
// 用法：node scripts/build-native.mjs configure|build|run|all
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CACHE = join(ROOT, '.cef-cache')
const CEF_DEST = join(ROOT, 'third_party', 'cef')
const BUILD = join(ROOT, 'build-native')
/** 安装器独立构建目录（不依赖 CEF） */
const BUILD_SETUP = join(ROOT, 'build-installer')

/** MSVC / Windows SDK 环境（vcvars64.bat），用于让 cmake 找到 cl.exe */
function findVcvars() {
  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    'C:\\Program Files',
    'C:\\Program Files (x86)'
  ].filter(Boolean)
  for (const root of roots) {
    const vsRoot = join(root, 'Microsoft Visual Studio')
    if (!existsSync(vsRoot)) continue
    for (const year of readdirSync(vsRoot)) {
      for (const edition of ['BuildTools', 'Community', 'Professional', 'Enterprise']) {
        const bat = join(vsRoot, year, edition, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
        if (existsSync(bat)) return bat
      }
    }
  }
  return null
}

/** Windows SDK 根目录（含 Include / Lib / bin） */
function winsdkDir() {
  for (const root of [process.env['ProgramFiles(x86)'], 'C:\\Program Files (x86)']) {
    if (!root) continue
    const kits = join(root, 'Windows Kits', '10')
    if (existsSync(join(kits, 'Include'))) return kits
  }
  return ''
}

/** 取已安装的最新 SDK 版本号（如 10.0.26100.0） */
function pickSdkVersion() {
  const kits = winsdkDir()
  if (!kits) return ''
  const versions = readdirSync(join(kits, 'Include')).filter((v) => /^10\./.test(v))
  versions.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  )
  return versions.at(-1) ?? ''
}

const sdkVersion = pickSdkVersion()

/** 在 vcvars64.bat 环境下执行命令。
 *  通过临时 .bat 文件调用（多层引号经 cmd /c 传递极易出错），并且 **只写纯 ASCII 内容**：
 *  本机用户名含中文（吴桥生），cmd 读取批处理文件用系统 ANSI 代码页，
 *  含中文的 .bat 会被解成乱码路径。路径一律通过环境变量传入（环境块是 UTF-16，不经过代码页转换）。 */
function runInMsvcEnv(command, { cwd = ROOT, stdio = 'inherit', env = {} } = {}) {
  const vcvars = findVcvars()
  if (!vcvars) {
    console.error('未找到 vcvars64.bat：请安装 Visual Studio 生成工具（含 C++ 生成工具 + Windows SDK）')
    process.exit(1)
  }
  const cmdExe = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'cmd.exe')
  const batPath = join(CACHE, 'tib-build.cmd')
  const bat = [
    '@echo off',
    'call "%TIB_VCVARS%" >nul',
    // 本机 vcvars64.bat 未能识别 Windows SDK（WindowsSdkDir 为空、PATH 里没有 rc.exe），
    // 这里显式补齐 SDK 的 bin 目录，否则链接阶段会因找不到 rc.exe 而失败。
    'if "%WindowsSdkDir%"=="" set "WindowsSdkDir=%TIB_WINSDK%"',
    'set "PATH=%TIB_WINSDK%\\bin\\%TIB_SDKVER%\\x64;%TIB_WINSDK%\\bin\\x64;%PATH%"',
    `if "%WindowsSDKVersion%"=="" set "WindowsSDKVersion=${sdkVersion}\\"`,
    // 同理补齐 SDK 的库目录与头文件目录（否则链接器报 LNK1104: 无法打开 kernel32.lib）
    'set "LIB=%TIB_WINSDK%\\Lib\\%TIB_SDKVER%\\ucrt\\x64;%TIB_WINSDK%\\Lib\\%TIB_SDKVER%\\um\\x64;%LIB%"',
    'set "INCLUDE=%TIB_WINSDK%\\Include\\%TIB_SDKVER%\\ucrt;%TIB_WINSDK%\\Include\\%TIB_SDKVER%\\um;%TIB_WINSDK%\\Include\\%TIB_SDKVER%\\shared;%INCLUDE%"',
    command,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n')
  writeFileSync(batPath, bat, 'ascii')

  const res = spawnSync(cmdExe, ['/d', '/c', batPath], {
    cwd,
    stdio,
    shell: false,
    env: {
      ...process.env,
      TIB_VCVARS: vcvars,
      TIB_ROOT: ROOT,
      TIB_NATIVE: join(ROOT, 'native'),
      TIB_BUILD: BUILD,
      TIB_CEF_ROOT: CEF_DEST,
      TIB_WINSDK: winsdkDir(),
      TIB_SDKVER: sdkVersion,
      ...env
    }
  })
  return res.status ?? 1
}

/** 把 CEF 发行包（.tar.bz2）解压到 third_party/cef */
function ensureCefExtracted() {
  const cmakeDir = join(CEF_DEST, 'cmake')
  if (existsSync(cmakeDir)) {
    console.log(`CEF 已就绪：${CEF_DEST}`)
    return
  }
  const archive = readdirSync(CACHE).find((f) => f.endsWith('_windows64.tar.bz2'))
  if (!archive) {
    console.error('未找到 CEF 发行包，请先运行：npm run fetch:cef')
    process.exit(1)
  }
  const archivePath = join(CACHE, archive)
  console.log(`解压 ${archive} → ${CEF_DEST}`)
  mkdirSync(join(ROOT, 'third_party'), { recursive: true })

  // 归档是 .tar.bz2：用 Windows 自带的 bsdtar（System32\tar.exe，支持 bzip2）
  // 注意 Git 自带的 /usr/bin/tar 不含 bzip2，不能用
  const tmp = join(CACHE, 'extract')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const sysTar = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'tar.exe')
  if (!existsSync(sysTar)) {
    console.error(`未找到 ${sysTar}（Windows 10 1803+ 自带），无法解压 bzip2 归档`)
    process.exit(1)
  }
  const res = spawnSync(sysTar, ['-xjf', archivePath, '-C', tmp], { stdio: 'inherit' })
  if (res.status !== 0) {
    console.error('解压失败：bsdtar 返回非零退出码')
    process.exit(1)
  }
  const top = readdirSync(tmp).map((n) => join(tmp, n)).find((p) => statSync(p).isDirectory())
  if (!top) {
    console.error('解压结果为空')
    process.exit(1)
  }
  mkdirSync(CEF_DEST, { recursive: true })
  // Node 自带的 cp 递归复制（不依赖 xcopy）
  cpSync(top, CEF_DEST, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
  console.log(`CEF 就绪：${CEF_DEST}`)
}

function configure() {
  ensureCefExtracted()
  mkdirSync(BUILD, { recursive: true })
  const code = runInMsvcEnv(
    'cmake -S "%TIB_NATIVE%" -B "%TIB_BUILD%" -G Ninja -DCMAKE_BUILD_TYPE=Release -DTIB_CEF_ROOT="%TIB_CEF_ROOT%"'
  )
  if (code !== 0) process.exit(code)
}

function build() {
  if (!existsSync(join(BUILD, 'CMakeCache.txt'))) configure()
  const code = runInMsvcEnv('cmake --build "%TIB_BUILD%" --parallel')
  if (code !== 0) process.exit(code)
}

function run() {
  const exe = join(BUILD, 'TiBrowser.exe')
  if (!existsSync(exe)) {
    console.error(`未找到 ${exe}，请先执行 npm run native:build`)
    process.exit(1)
  }
  console.log(`启动 ${exe}`)
  const child = spawn(exe, [], { cwd: BUILD, stdio: 'inherit', detached: false })
  child.on('exit', (code) => process.exit(code ?? 0))
}

/** 构建安装器（独立工程，不依赖 CEF）。
 *  路径必须经环境变量传入：本机用户名含中文，含中文的 .bat 会被 cmd 按 ANSI 代码页解成乱码。 */
function buildSetup() {
  mkdirSync(BUILD_SETUP, { recursive: true })
  // 配置与构建合并在同一次批处理里执行：分两次调用时第二次会报 "could not load cache"
  // （两次各自起一个 cmd，构建目录与环境变量的关联会丢）。
  const code = runInMsvcEnv(
    'cmake -S "%TIB_INSTALLER%" -B "%TIB_BUILD_SETUP%" -G Ninja -DCMAKE_BUILD_TYPE=Release' +
      ' && cmake --build "%TIB_BUILD_SETUP%" --parallel',
    { env: { TIB_INSTALLER: join(ROOT, 'installer'), TIB_BUILD_SETUP: BUILD_SETUP } }
  )
  if (code !== 0) process.exit(code)
  console.log(`安装器：${join(BUILD_SETUP, 'TiBrowserSetup.exe')}`)
}

const action = process.argv[2] ?? 'all'
if (action === 'setup') buildSetup()
else if (action === 'configure') configure()
else if (action === 'build') build()
else if (action === 'run') run()
else {
  configure()
  build()
  console.log('构建完成。运行：npm run native:run')
}
