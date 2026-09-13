// 原生外壳的构建编排：解压 CEF、初始化 MSVC 环境、CMake 配置与构建、运行
// 用法：node scripts/build-native.mjs configure|build|run|all
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CACHE = join(ROOT, '.cef-cache')
const CEF_DEST = join(ROOT, 'third_party', 'cef')
const BUILD = join(ROOT, 'build-native')

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

/** 在 cmd /c "vcvars64.bat && <命令>" 下执行，返回退出码 */
function runInMsvcEnv(command, { cwd = ROOT, stdio = 'inherit' } = {}) {
  const vcvars = findVcvars()
  if (!vcvars) {
    console.error('未找到 vcvars64.bat：请安装 Visual Studio 生成工具（含 C++ 生成工具 + Windows SDK）')
    process.exit(1)
  }
  const cmdExe = join(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'cmd.exe')
  const line = `call "${vcvars}" >nul && ${command}`
  const res = spawnSync(cmdExe, ['/d', '/s', '/c', line], { cwd, stdio, shell: false })
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
    `cmake -S "${join(ROOT, 'native')}" -B "${BUILD}" -G Ninja -DCMAKE_BUILD_TYPE=Release -DTIB_CEF_ROOT="${CEF_DEST}"`
  )
  if (code !== 0) process.exit(code)
}

function build() {
  if (!existsSync(join(BUILD, 'CMakeCache.txt'))) configure()
  const code = runInMsvcEnv(`cmake --build "${BUILD}" --parallel`)
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

const action = process.argv[2] ?? 'all'
if (action === 'configure') configure()
else if (action === 'build') build()
else if (action === 'run') run()
else {
  configure()
  build()
  console.log('构建完成。运行：npm run native:run')
}
