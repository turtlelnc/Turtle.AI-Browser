// 组装可分发的发行目录（release/dist）。
//
// 为什么需要这一步：CMake 的输出目录里混着大量**构建中间产物**
// （libcef_dll/ 的 .obj 有 288 MB、*.pdb 有 48 MB、CMakeFiles/、探针程序等），
// 直接打包会给用户多塞 340 MB 无用内容。这里只挑运行期真正需要的文件。
//
// 用法：node scripts/build-dist.mjs [架构标签，默认 x64]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'build-native')
const OUT = join(ROOT, 'release', 'dist')

/**
 * 版本号从 src/shared/constants.ts 读取（唯一版本来源）。
 * 这里以前是手抄的字面量，版本升级时很容易漏掉发行说明里的那一行 ——
 * 用户拿到包里写着旧版本号，是最容易被投诉、又最难自查的一类问题。
 */
function versionLabel() {
  const text = readFileSync(join(ROOT, 'src/shared/constants.ts'), 'utf8')
  const version = /APP_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1] ?? '0.0.0'
  const build = /APP_BUILD\s*=\s*'(\d+)'/.exec(text)?.[1] ?? '0'
  return { version, build, label: `v${version} (build ${build})` }
}

const VERSION = versionLabel()

/** 运行期必需的文件（libcef.dll 等由 CEF 发行包提供） */
const REQUIRED_FILES = [
  'TiBrowser.exe',
  'libcef.dll',
  'chrome_elf.dll',
  'd3dcompiler_47.dll',
  'libEGL.dll',
  'libGLESv2.dll',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
  'dxil.dll',
  'dxcompiler.dll',
  'v8_context_snapshot.bin',
  'resources.pak',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'icudtl.dat'
]

/** 需要整目录复制的运行期资源 */
const REQUIRED_DIRS = ['locales', 'ui', 'resources', 'service']

function human(mb) {
  return `${mb.toFixed(1)} MB`
}

if (!existsSync(join(SRC, 'TiBrowser.exe'))) {
  console.error(`未找到 ${join(SRC, 'TiBrowser.exe')}，请先执行 npm run native:build`)
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

let total = 0
const missing = []

for (const file of REQUIRED_FILES) {
  const from = join(SRC, file)
  if (!existsSync(from)) {
    missing.push(file)
    continue
  }
  copyFileSync(from, join(OUT, file))
  total += statSync(from).size
}

for (const dir of REQUIRED_DIRS) {
  const from = join(SRC, dir)
  if (!existsSync(from)) {
    missing.push(dir + '/')
    continue
  }
  cpSync(from, join(OUT, dir), { recursive: true })
  const walk = (p) => {
    let n = 0
    for (const entry of readdirSync(p)) {
      const full = join(p, entry)
      const st = statSync(full)
      n += st.isDirectory() ? walk(full) : st.size
    }
    return n
  }
  total += walk(join(OUT, dir))
}

// 便携运行的说明与启动脚本：不依赖任何安装器工具链
writeFileSync(
  join(OUT, '启动 TiBrowser.cmd'),
  ['@echo off', 'rem 便携启动：直接运行本目录下的 TiBrowser.exe', 'start "" "%~dp0TiBrowser.exe" %*', ''].join('\r\n'),
  'utf8'
)

writeFileSync(
  join(OUT, 'README-发行说明.txt'),
  [
    `TiBrowser ${VERSION.label}`,
    '',
    '这是免安装的便携版本：整个目录复制到任意位置，双击「启动 TiBrowser.cmd」或直接运行 TiBrowser.exe 即可。',
    '',
    '本次更新（相对 rc1）',
    '  · 修复：开第二个标签页后约 9 秒必定崩溃（根因是窗口创建过程中摘除网页视图）。',
    '  · 修复：关闭窗口后进程不退出（单进程模式下 CEF 不会自动结束消息循环）。',
    '  · 新增：网页右键菜单（22 项：链接/图片的打开·复制·另存为、编辑、缩放、打印为 PDF 等）。',
    '  · 新增：下载管线（落盘到数据目录 Downloads，进度记入下载列表）。',
    '  · 新增：下载安全判定 —— 不安全安装包只警告不拦截，可自行保留；turtlelnc 发布物直接放行。',
    '  · 无痕模式 2.0 的指纹改写增加了"页面回读比对"验证（页面里读到的值确为改写后的值）。',
    '',
    '系统要求：Windows 10 1809 及以上（64 位）。',
    '',
    '数据目录：%LOCALAPPDATA%\\TiBrowser',
    '  （不使用 %APPDATA%：该目录在本机被 OneDrive 同步，会导致 Chromium 缓存占用冲突）',
    '  可用 --user-data-dir=<路径> 指定其它目录。',
    '',
    '已知限制（如实说明，不是"应该是这样"）：',
    '  1. 本版本在本机使用「单进程兼容模式」运行：Chromium 的网络服务子进程在此环境下',
    '     启动即崩，会导致任何网页都打不开。启动日志里会如实标注当前进程模型。',
    '     在正常环境可用 --multi-process 恢复标准的多进程隔离。',
    '  2. 不支持运行浏览器扩展：当前内核（CEF 150）已移除扩展运行 API，',
    '     「扩展程序」页只能导入、解包、登记与开关，扩展脚本不会被执行（界面已如实说明）。',
    '  3. 未实现系统打印对话框，提供的是「打印为 PDF」（右键菜单里）。',
    '  4. 安装包未做代码签名，Windows SmartScreen 会提示"未知发布者"。',
    '  5. 三档安全浏览中依赖云端威胁库的能力需要自备服务商 API Key，界面会明确标注。',
    '  6. Microsoft / Google 账户云同步需要自备 OAuth client id；本地文件夹同步可直接使用。',
    '',
    'GPL-3.0-only · https://github.com/turtlelnc/Turtle.AI-Browser',
    ''
  ].join('\r\n'),
  'utf8'
)

// 许可证随包分发
const license = join(ROOT, 'LICENSE')
if (existsSync(license)) {
  copyFileSync(license, join(OUT, 'LICENSE'))
  total += statSync(license).size
}

console.log(`发行目录已生成：${OUT}`)
console.log(`体积：${human(total / 1048576)}`)
if (missing.length) {
  console.log(`缺少以下文件（请检查构建是否完整）：${missing.join(', ')}`)
  process.exit(2)
}
