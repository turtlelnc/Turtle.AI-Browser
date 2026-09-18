// 端到端自检：不启动浏览器，只检查产物与配置的一致性。
//
// 为什么需要：这个项目里有几处"看起来对、其实没用上"的高风险点 ——
// 版本号分散在 5 个文件、UI 产物必须先于原生构建、边车必须与原生共用数据目录。
// 它们出错时都不会报错，只会静默地表现成"改了没生效"。这个脚本把它们显式检出来。
//
// 用法：node scripts/check-release.mjs
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const failures = []
const notes = []

function ok(label, detail = '') {
  console.log(`  ✔ ${label}${detail ? '  ' + detail : ''}`)
}
function fail(label, detail) {
  console.log(`  ✘ ${label}  ${detail}`)
  failures.push(`${label}: ${detail}`)
}

/** 读取期望的版本号：以 package.json 为唯一权威 */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const sw = readFileSync(join(ROOT, 'src/shared/constants.ts'), 'utf8')
const buildMatch = /APP_BUILD\s*=\s*'(\d+)'/.exec(sw)
const BUILD = buildMatch ? buildMatch[1] : ''
console.log(`期望版本：v${VERSION} (build ${BUILD})\n`)

// ---------------------------------------------------------------- 1. 版本号一致性
console.log('1. 版本号一致性')
{
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
  if (lock.version === VERSION) ok('package-lock.json 与 package.json 一致')
  else fail('package-lock.json 版本不一致', `lock=${lock.version} pkg=${VERSION}`)

  const cmake = readFileSync(join(ROOT, 'native/CMakeLists.txt'), 'utf8')
  const cmVer = /set\(TIB_VERSION\s+"([^"]+)"\)/.exec(cmake)?.[1]
  const cmBuild = /set\(TIB_BUILD\s+"([^"]+)"\)/.exec(cmake)?.[1]
  if (cmVer === VERSION) ok('native/CMakeLists.txt 版本一致')
  else fail('native/CMakeLists.txt 版本不一致', `cmake=${cmVer} pkg=${VERSION}`)
  if (cmBuild === BUILD) ok('native/CMakeLists.txt 构建号一致')
  else fail('native/CMakeLists.txt 构建号不一致', `cmake=${cmBuild} 期望=${BUILD}`)

  const bridge = readFileSync(join(ROOT, 'src/shared/bridge.ts'), 'utf8')
  const brVer = /TIB_VERSION\s*=\s*'([^']+)'/.exec(bridge)?.[1]
  const brBuild = /TIB_BUILD\s*=\s*(\d+)/.exec(bridge)?.[1]
  if (brVer === VERSION) ok('src/shared/bridge.ts 版本一致')
  else fail('src/shared/bridge.ts 版本不一致', `bridge=${brVer} pkg=${VERSION}`)
  if (brBuild === BUILD) ok('src/shared/bridge.ts 构建号一致')
  else fail('src/shared/bridge.ts 构建号不一致', `bridge=${brBuild} 期望=${BUILD}`)

  const svc = JSON.parse(readFileSync(join(ROOT, 'service/package.json'), 'utf8'))
  if (svc.version === VERSION) ok('service/package.json 版本一致')
  else fail('service/package.json 版本不一致', `service=${svc.version} pkg=${VERSION}`)

  if (sw.includes(`APP_VERSION = '${VERSION}'`)) ok('src/shared/constants.ts 版本一致')
  else fail('src/shared/constants.ts 版本不一致', '未找到期望的 APP_VERSION')
}

// ---------------------------------------------------------------- 2. 许可证一致性
console.log('\n2. 许可证一致性')
{
  const lic = readFileSync(join(ROOT, 'LICENSE'), 'utf8').slice(0, 400)
  const isGpl3 = lic.includes('GNU GENERAL PUBLIC LICENSE') && lic.includes('Version 3')
  if (isGpl3) ok('LICENSE 是 GPL-3.0')
  else fail('LICENSE 不是 GPL-3.0', '前 400 字节未匹配到 GPLv3 标识')

  const rootLic = pkg.license
  if (/GPL-3\.0/.test(rootLic)) ok('package.json license 与 LICENSE 一致', rootLic)
  else fail('package.json license 不一致', `package.json=${rootLic} 但 LICENSE 是 GPL-3.0`)

  const svcLic = JSON.parse(readFileSync(join(ROOT, 'service/package.json'), 'utf8')).license
  if (/GPL-3\.0/.test(svcLic)) ok('service/package.json license 一致', svcLic)
  else fail('service/package.json license 不一致', `service=${svcLic}`)

  if (!existsSync(join(ROOT, 'node_modules/is-unicode-supported/package.json'))) {
    notes.push('未安装 node_modules，跳过依赖锁校验')
  } else {
    // package-lock 曾被批量替换污染过：version 与 resolved 里的压缩包版本必须一致
    const lockRaw = readFileSync(join(ROOT, 'package-lock.json'), 'utf8')
    const bad = []
    for (const name of ['is-unicode-supported', 'yocto-queue']) {
      const re = new RegExp(`"node_modules/${name}":\\s*\\{[^}]*"version":\\s*"([^"]+)"[^}]*"resolved":\\s*"[^"]*${name}-([0-9.]+)\\.tgz"`, 's')
      const m = re.exec(lockRaw)
      if (!m) continue
      if (m[1] !== m[2]) bad.push(`${name}: version=${m[1]} 但 tarball=${m[2]}`)
    }
    if (bad.length === 0) ok('package-lock 中 version 与 resolved 一致')
    else fail('package-lock 存在 version/resolved 不一致（曾被污染过）', bad.join('; '))
  }
}

// ---------------------------------------------------------------- 3. 产物完整性
console.log('\n3. 产物完整性')
{
  const uiIndex = join(ROOT, 'dist/ui/index.html')
  const uiBridge = join(ROOT, 'dist/ui/tib-host.js')
  if (existsSync(uiIndex)) ok('UI 产物存在', 'dist/ui/index.html')
  else fail('UI 产物缺失', '请运行 npm run ui:build')

  if (existsSync(uiBridge)) {
    const bridge = readFileSync(uiBridge, 'utf8')
    // 这一条防的是真实踩过的坑：过期的 tib-host.js 里还依赖已废弃的 tibPreload，
    // 桥会"完全不工作且没有任何报错"。
    if (bridge.includes('__TIB_CALL__')) ok('注入脚本使用 console 上行通道（非过期的 tibPreload）')
    else fail('注入脚本已过期', 'tib-host.js 里没有 __TIB_CALL__，说明它早于消息路由废弃之前')
    if (bridge.includes('__tibDeliverReply')) ok('注入脚本提供 __tibDeliverReply 回执入口')
    else fail('注入脚本缺少 __tibDeliverReply', '渲染进程无法收到回执')
  } else {
    fail('注入脚本缺失', 'dist/ui/tib-host.js 不存在')
  }

  const exe = join(ROOT, 'build-native/TiBrowser.exe')
  if (existsSync(exe)) ok('原生可执行文件存在', `${(statSync(exe).size / 1048576).toFixed(2)} MB`)
  else fail('原生可执行文件缺失', '请运行 npm run native:build')

  // 原生输出目录里的 UI 必须与 dist/ui 同步（CMake POST_BUILD 负责，手动构建易漏）
  const outUi = join(ROOT, 'build-native/ui/tib-host.js')
  const distUi = join(ROOT, 'dist/ui/tib-host.js')
  if (existsSync(outUi) && existsSync(distUi)) {
    if (readFileSync(outUi, 'utf8') === readFileSync(distUi, 'utf8')) {
      ok('build-native/ui 与 dist/ui 同步')
    } else {
      fail('build-native/ui 是旧产物', '与 dist/ui 内容不一致，请重新执行 native:build')
    }
  } else {
    notes.push('尚未构建原生输出目录，跳过 UI 同步校验')
  }

  const svc = join(ROOT, 'service/dist/index.js')
  if (existsSync(svc)) ok('边车已构建', 'service/dist/index.js')
  else notes.push('边车尚未构建（AI 能力不可用，浏览器本身可用）')

  const setup = join(ROOT, 'build-installer/TiBrowserSetup.exe')
  if (existsSync(setup)) ok('安装器已构建', `${(statSync(setup).size / 1048576).toFixed(2)} MB`)
  else notes.push('安装器尚未构建（npm run native:setup）')

  const distDir = join(ROOT, 'release/dist')
  if (existsSync(distDir)) {
    const exe = join(distDir, 'TiBrowser.exe')
    if (existsSync(exe)) ok('发行目录完整', 'release/dist/TiBrowser.exe')
    else fail('发行目录缺少 TiBrowser.exe', '请重新执行 npm run dist')
    // 安装器要求 payload 目录与自身同级
    if (existsSync(join(ROOT, 'release/TiBrowserSetup.exe'))) {
      ok('安装器已就位到 release/（与 dist 同级）')
    } else {
      notes.push('安装器未复制到 release/：分发时需与 dist/ 放在同一文件夹')
    }
  } else {
    notes.push('尚未组装发行目录（npm run dist）')
  }
}

// ---------------------------------------------------------------- 4. 危险残留
console.log('\n4. 危险残留检查')
{
  const src = readFileSync(join(ROOT, 'native/src/scheme.cpp'), 'utf8')
  if (src.includes('HostTransportScript')) {
    fail('scheme.cpp 里仍有 tibPreload 垫片', '它会占用 __tibHost 却找不到 tibPreload，导致桥完全不通')
  } else {
    ok('scheme.cpp 无过期的消息路由垫片')
  }

  const win = readFileSync(join(ROOT, 'native/src/window.cpp'), 'utf8')
  const loadCalls = (win.match(/^\s*LoadChromeUi\(\);/gm) ?? []).length
  if (loadCalls <= 1) ok('外壳 UI 只有一处加载入口')
  else fail('外壳 UI 有多处加载入口', `发现 ${loadCalls} 处，会让页面加载多遍并重置 DOM 状态`)

  // 注意要排除注释里的提及：真正的违规是**代码行**上出现该宏
  const codeLines = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  if (/CEF_REQUIRE_IO_THREAD\s*\(/.test(codeLines)) {
    fail('资源处理器里仍在使用 CEF_REQUIRE_IO_THREAD', '会在页面加载时 FATAL')
  } else {
    ok('资源处理器未使用 CEF_REQUIRE_IO_THREAD')
  }
}

// ---------------------------------------------------------------- 汇总
console.log('\n=== 结论 ===')
if (notes.length) {
  for (const n of notes) console.log(`  · ${n}`)
}
if (failures.length === 0) {
  console.log('✔ 全部检查通过')
  process.exit(0)
}
console.log(`✘ ${failures.length} 项未通过：`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)
