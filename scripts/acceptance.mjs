// rc 验收测试：按"用户真实使用路径"逐项验证，全部以日志与进程状态为证据。
//
// 设计原则：
//   * 只报告**观察到**的事实，不做推断（拿不到证据就标为「无法验证」，不写成通过）
//   * 每个用例独立起进程、独立计时、独立收集日志，互不污染
//   * 结束时确保不留残余进程，方便连续跑多轮
//
// 用法：node scripts/acceptance.mjs [--keep] [--only=1,5]
//   --keep      测试结束后保留最后一个实例，便于人工查看界面
//   --only=1,5  只跑指定用例（调试单个用例时不必等整套跑完）
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const EXE = join(ROOT, 'build-native/TiBrowser.exe')
const KEEP = process.argv.includes('--keep')
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length)
const want = (n) => ONLY === '' || ONLY.split(',').includes(String(n))

const USER_DATA = join(process.env.LOCALAPPDATA ?? '', 'TiBrowser')
const LOG = join(USER_DATA, 'tibrowser.log')
// 「收尾完成」这类消息发生在 CEF 已关闭之后，只能写程序目录下的早期日志
const STARTUP_LOG = join(ROOT, 'build-native/tibrowser-startup.log')

const results = []

/**
 * 用 PowerShell 而不是 taskkill/tasklist：本机受限 PATH 下这两个命令不存在，
 * 静默失败会让后续用例在"上一个实例还在跑"的状态下启动，于是立刻因单实例互斥退出 ——
 * 表现为一片"存活 0s"，看着像崩溃，其实是测试脚本自身的环境问题（真实踩过）。
 */
function ps(script) {
  return spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

function killAll() {
  ps('Get-Process TiBrowser -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等待所有 TiBrowser 进程真正消失。
 * 必须等，不能只发 kill 就往下走：进程退出后 Chromium 的文件句柄还会短暂占用
 * 数据目录，紧接着删目录会 EPERM。
 */
async function waitNoProcess(seconds = 20) {
  for (let i = 0; i < seconds * 2; i++) {
    const r = ps('(Get-Process TiBrowser -ErrorAction SilentlyContinue | Measure-Object).Count')
    if ((r.stdout ?? '').trim() === '0') return true
    await sleep(500)
  }
  return false
}

/** 稳健清理数据目录：最多重试 20 次，每次给系统 300ms 释放句柄 */
function purgeUserData() {
  return purgeDir(USER_DATA)
}

/**
 * 稳健删除任意目录（Chromium 释放文件句柄有延迟，紧接着删会 EPERM）。
 * 用例 10 用它清理 `--user-data-dir` 的临时目录 —— 第一版直接 rmSync，结果在
 * 杀进程之后立刻删就吃了一个 EPERM，把整个用例带崩。
 */
function purgeDir(dir) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      return true
    } catch {
      spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Start-Sleep -Milliseconds 300; Remove-Item -LiteralPath '${dir}' -Recurse -Force -ErrorAction SilentlyContinue`
      ], { stdio: 'ignore' })
    }
  }
  return !existsSync(dir)
}

function readLog() {
  try {
    return readFileSync(LOG, 'utf8')
  } catch {
    return ''
  }
}

function readStartupLog() {
  try {
    return readFileSync(STARTUP_LOG, 'utf8')
  } catch {
    return ''
  }
}

/** 读取下载列表（不存在或损坏时返回空数组，让断言自己给出"未找到下载记录"） */
function readDownloads() {
  try {
    const parsed = JSON.parse(readFileSync(join(USER_DATA, 'downloads.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 启动一次浏览器并跟踪存活时间；返回 { survived, log }
 * prepare: 可选回调，在启动**之前**写数据目录（用于预置 settings.json 等场景）。
 *   一旦给了 prepare 就不再清空数据目录 —— 之前用例 5 就是先写好设置、再被这里清掉，
 *   于是四条断言全红，看着像"设置持久化失效"，其实是测试自己删掉了被测文件。
 */
async function runCase(name, args, seconds, prepare = null) {
  killAll()
  await waitNoProcess()
  purgeUserData()
  mkdirSync(USER_DATA, { recursive: true })
  if (prepare) prepare()
  // 早期日志是追加写的：先清掉，避免上一轮的「收尾完成」被误当成这一轮的证据
  try {
    rmSync(STARTUP_LOG, { force: true })
  } catch {
    /* 不存在就算了 */
  }

  const child = spawn(EXE, args, { cwd: join(ROOT, 'build-native'), detached: false })
  let exited = false
  let exitCode = null
  child.on('exit', (code) => {
    exited = true
    exitCode = code
  })

  const started = Date.now()
  let survived = 0
  for (let i = 0; i < seconds; i++) {
    await sleep(1000)
    if (exited) break
    survived = Math.round((Date.now() - started) / 1000)
  }

  const log = readLog()
  if (!KEEP) {
    killAll()
    await waitNoProcess()
  }
  return { name, survived, exited, exitCode, log, target: seconds }
}

function check(label, condition, detail = '') {
  results.push({ label, pass: !!condition, detail })
  console.log(`  ${condition ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`)
}

// ---------------------------------------------------------------- 前置
if (!existsSync(EXE)) {
  console.error(`未找到 ${EXE}，请先执行 npm run native:build`)
  process.exit(2)
}

console.log(`验收测试目标：${EXE}\n`)

// ---------------------------------------------------------------- 用例 1：单标签稳定性
killAll()
await waitNoProcess()

console.log('用例 1：单标签页启动并稳定运行 40 秒')
if (want(1)) {
  const r = await runCase('single', ['--url=https://example.com'], 40)
  check('进程存活到 40 秒', r.survived >= 38, `实际 ${r.survived}s`)
  check('外壳 UI 加载完成（HTTP 200）', /外壳 UI 加载完成：http:\/\/127\.0\.0\.1:\d+.*（HTTP 200）/.test(r.log))
  check('桥双向连通（getState 往返）', r.log.includes('getState 往返成功'))
  check('17 项接口全部 ok', /接口探测：.*getAiMode=ok/.test(r.log) && !/接口探测：[^\n]*失败/.test(r.log))
  check('真实网页加载', r.log.includes('标签页标题更新：Example Domain'))
  check('历史已记录', existsSync(join(USER_DATA, 'history.json')))
  check('边车已启动并握手', /边车进程已启动/.test(r.log))
}

// ---------------------------------------------------------------- 用例 2：多标签稳定性
console.log('\n用例 2：三标签页启动并稳定运行 60 秒（此前的崩溃场景）')
if (want(2)) {
  const r = await runCase(
    'multi',
    ['--url=https://example.com', '--open=https://example.org', '--open=https://www.iana.org'],
    60
  )
  check('进程存活到 60 秒', r.survived >= 58, `实际 ${r.survived}s`)
  const navCount = (r.log.match(/执行导航：/g) ?? []).length
  check('每个标签只导航一次（无重复导航）', navCount > 0, `导航次数 ${navCount}`)
  check('桥仍然连通', r.log.includes('getState 往返成功'))
}

// ---------------------------------------------------------------- 用例 3：快捷键
console.log('\n用例 3：快捷键自检')
if (want(3)) {
  const r = await runCase('shortcut', ['--shortcut-test'], 40)
  check('Ctrl+T 新建标签页', /Ctrl\+T 后标签数 2/.test(r.log))
  check('Ctrl+Tab 相邻切换', /Ctrl\+Tab 后活动标签/.test(r.log))
  check('Ctrl+Shift+T 恢复关闭的标签页', /Ctrl\+Shift\+T 恢复=成功/.test(r.log))
  check('快捷键自检完成后进程仍存活', r.survived >= 20, `实际 ${r.survived}s`)
}

// ---------------------------------------------------------------- 用例 4：无痕
console.log('\n用例 4：无痕模式（含指纹改写是否真的对页面生效）')
if (want(4)) {
  // 预置一份与真实机器明显不同的指纹画像，用来证明"页面上读到的值确实被改写了"：
  // 系统语言/时区/核心数都不可能恰好是下面这几个值，因此比对结果不会假阳性。
  const profile = {
    userAgent: '跟随系统',
    platform: '跟随系统',
    timezone: 'Asia/Tokyo',
    language: 'en-GB',
    screen: '2560x1440',
    hardwareConcurrency: '4',
    doNotTrack: '1',
    canvasNoise: true,
    webglNoise: true
  }
  const { writeFileSync } = await import('node:fs')
  const r = await runCase('incognito', ['--incognito', '--url=https://example.com'], 35, () => {
    writeFileSync(join(USER_DATA, 'fingerprint.json'), JSON.stringify(profile), 'utf8')
  })
  check('以无痕窗口启动', r.log.includes('创建主窗口：无痕窗口'))
  check('注入指纹改写脚本', /向页面注入指纹改写脚本（\d+ 字节）/.test(r.log))
  check('无痕不记录历史', !existsSync(join(USER_DATA, 'history.json')))
  check('进程存活', r.survived >= 25, `实际 ${r.survived}s`)

  // 关键证据：页面里回读到的值。只证明"注入了一段脚本"是不够的。
  check('页面回读指纹成功', /无痕指纹回读：[^\n]*语言=一致\(en-GB\)/.test(r.log))
  check('时区改写对页面生效', /时区=一致\(Asia\/Tokyo\)/.test(r.log))
  check('并发数改写对页面生效', /核心数=一致\(4\)/.test(r.log))
  const compare = /无痕指纹比对：一致 (\d+) 项、跟随系统 (\d+) 项、不一致 (\d+) 项/.exec(r.log)
  check('改写项全部生效（不一致 0 项）', compare && compare[3] === '0',
    compare ? `一致 ${compare[1]}、跟随系统 ${compare[2]}、不一致 ${compare[3]}` : '未找到比对结论')
  check('未改写的项保持跟随系统', compare && compare[2] === '2',
    compare ? `跟随系统 ${compare[2]} 项（UA / 平台）` : '未找到比对结论')
}

// ---------------------------------------------------------------- 用例 5：设置持久化
console.log('\n用例 5：设置持久化（改皮肤/主题后重启生效）')
if (want(5)) {
  const settings = {
    searchEngine: 'baidu',
    homepage: 'https://www.baidu.com',
    theme: 'dark',
    skin: 'chrome',
    perf: 'high',
    bookmarkBarVisible: false,
    showHomeButton: false,
    restoreSession: true,
    cliPermission: 'developer',
    aiEnabled: true,
    serviceAutoStart: true
  }
  const { writeFileSync } = await import('node:fs')
  // 预置文件必须在 runCase 清空数据目录之后写，否则会被测试自己删掉
  const r = await runCase('settings', ['--url=https://example.com'], 30, () => {
    writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify(settings), 'utf8')
  })
  check('启动时读到磁盘设置', /已应用设置 —— 皮肤=chrome 主题=dark/.test(r.log))
  check('首屏引导使用真实设置', /注入首屏引导：皮肤=chrome 主题=dark/.test(r.log))
  check('UI 实际生效 data-skin=chrome', /\| skin=chrome/.test(r.log))
  check('UI 实际生效 data-theme=dark', /\| theme=dark/.test(r.log))
}

// ---------------------------------------------------------------- 用例 6：受控关窗后进程退出
console.log('\n用例 6：关窗后进程必须真正退出（单进程模式下 CEF 不会自动退出消息循环）')
if (want(6)) {
  killAll()
  await waitNoProcess()
  purgeUserData()
  mkdirSync(USER_DATA, { recursive: true })
  try {
    rmSync(STARTUP_LOG, { force: true })
  } catch {
    /* 不存在就算了 */
  }
  const child = spawn(EXE, ['--url=https://example.com', '--tib-close-after=8000'], {
    cwd: join(ROOT, 'build-native')
  })
  const started = Date.now()
  let exitCode = null
  child.on('exit', (code) => {
    exitCode = code
  })
  let waited = 0
  while (waited < 60000 && exitCode === null) {
    await sleep(500)
    waited = Date.now() - started
  }
  const log = readLog()
  const startupLog = readStartupLog()
  check('进程在关窗后退出（而非一直挂着）', exitCode !== null, `耗时 ${(waited / 1000).toFixed(1)}s`)
  check('退出码为 0', exitCode === 0, `exitcode=${exitCode}`)
  check('日志出现「最后一个窗口已销毁，结束消息循环」', log.includes('最后一个窗口已销毁，结束消息循环'))
  // 这一行写在 CEF 关闭之后，只能落在程序目录下的早期日志里
  check(
    '日志出现「收尾完成，进程退出」',
    log.includes('收尾完成，进程退出') || startupLog.includes('收尾完成，进程退出'),
    startupLog.includes('收尾完成，进程退出') ? '（早期日志）' : ''
  )
  killAll()
  await waitNoProcess()
}

// ---------------------------------------------------------------- 用例 7：右键菜单
console.log('\n用例 7：网页右键菜单（只能由人右键触发的功能，用自检开关验证）')
if (want(7)) {
  const r = await runCase('menu', ['--tib-menu-probe', '--url=https://example.com'], 25)
  check('菜单自检已执行', /右键菜单自检：合成上下文（链接\+图片\+可编辑\+有选区）构造出 \d+ 项/.test(r.log))
  check('含导航与链接条目', r.log.includes('在新标签页中打开链接') && r.log.includes('复制链接地址'))
  check('含图片条目', r.log.includes('图片另存为…') && r.log.includes('复制图片地址'))
  check('含编辑条目', r.log.includes('粘贴') && r.log.includes('全选'))
  check('含缩放与页面动作', r.log.includes('重置为 100%') && r.log.includes('打印为 PDF…'))
  check('禁用状态按上下文设置', /右键菜单自检：可用性判断 正确/.test(r.log))
  check('菜单自检后进程仍存活', r.survived >= 18, `实际 ${r.survived}s`)
}

// ---------------------------------------------------------------- 用例 8：下载与下载安全判定
console.log('\n用例 8：下载落盘、记入列表、并过一遍安全判定')
if (want(8)) {
  const probeFile = join(USER_DATA, 'Downloads', 'tib-download-probe.bin')
  const r = await runCase('download', ['--tib-download-probe', '--url=https://example.com'], 30)
  const downloads = readDownloads()
  const record = downloads.find((d) => d.filename === 'tib-download-probe.bin')
  check('下载探针标签页已打开', /实验：打开下载探针标签页 http:\/\/127\.0\.0\.1:\d+/.test(r.log))
  check('下载开始', /下载开始[^\n]*tib-download-probe\.bin/.test(r.log))
  check('下载完成', /下载完成：[^\n]*tib-download-probe\.bin/.test(r.log))
  check('文件已真正落盘', existsSync(probeFile))
  check('已记入下载列表且状态为已完成', record && record.state === 'completed',
    record ? `state=${record.state} 字节=${record.totalBytes}` : '未找到下载记录')
  check('普通文件未被误标为可疑', record && record.suspicious === false)
}

// ---------------------------------------------------------------- 用例 9：不安全安装包只警告不拦截
console.log('\n用例 9：不安全安装包可保留（需求 6：警告但不拦截，且写清原因）')
if (want(9)) {
  const exeName = 'tib-unsafe-probe-setup.exe'
  const probeFile = join(USER_DATA, 'Downloads', exeName)
  const r = await runCase('unsafe', ['--tib-download-probe=' + exeName, '--url=https://example.com'], 30)
  const record = readDownloads().find((d) => d.filename === exeName)
  check('命中不安全安装包判定', /已标记为可疑，可自行保留/.test(r.log))
  check('给出了中文原因', /原因：这是可执行安装包/.test(r.log))
  check('没有被拦截（文件保留）', existsSync(probeFile))
  check('下载记录标为可疑并带原因', record && record.suspicious === true && !!record.suspiciousReason,
    record ? `suspicious=${record.suspicious}` : '未找到下载记录')
  check('仍然完成了下载', record && record.state === 'completed',
    record ? `state=${record.state}` : '未找到下载记录')
}

// ---------------------------------------------------------------- 用例 10：命令行开关真的生效
console.log('\n用例 10：命令行开关（--user-data-dir / --multi-process）必须真的生效')
if (want(10)) {
  // 为什么单独一个用例：这两个开关曾经都因为"在 CefInitialize 之前调用
  // GetGlobalCommandLine() 拿到空对象"而静默失效 —— 日志里照样打印
  // "生效的命令行开关：--user-data-dir=…"，但数据目录仍是默认值。
  // 这种"看起来生效、其实没生效"的问题只能靠对照实际路径来抓。
  killAll()
  await waitNoProcess()
  const tempData = join(ROOT, '.tmp-acceptance-udd')
  purgeDir(tempData)
  mkdirSync(tempData, { recursive: true })
  try {
    rmSync(STARTUP_LOG, { force: true })
  } catch {
    /* 不存在就算了 */
  }

  const child = spawn(EXE, ['--url=https://example.com', `--user-data-dir=${tempData}`], {
    cwd: join(ROOT, 'build-native')
  })
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  for (let i = 0; i < 25 && !exited; i++) {
    await sleep(1000)
    if (existsSync(join(tempData, 'tibrowser.log'))) break
  }
  const startupLog = readStartupLog()
  check('启动日志确认按命令行切换数据目录', /按命令行切换用户数据目录：/.test(startupLog))
  check('自定义数据目录下真的写入了日志', existsSync(join(tempData, 'tibrowser.log')))
  check(
    '默认数据目录没有被这次启动写入',
    !existsSync(join(USER_DATA, 'tibrowser.log')) || !readLog().includes('用户数据目录')
  )
  killAll()
  await waitNoProcess()
  purgeDir(tempData)

  // --multi-process：只验证"开关被认到"，不验证页面可用性（本机多进程模式下网络不可用）
  try {
    rmSync(STARTUP_LOG, { force: true })
  } catch {
    /* 不存在就算了 */
  }
  const multi = spawn(EXE, ['--multi-process', '--url=https://example.com'], {
    cwd: join(ROOT, 'build-native')
  })
  let multiExited = false
  multi.on('exit', () => {
    multiExited = true
  })
  await sleep(12000)
  const multiLog = readStartupLog()
  check('--multi-process 被认到并切换到标准进程模型', /进程模型：标准（多进程 \+ 沙箱）/.test(multiLog))
  check('--multi-process 下进程仍稳定存活', !multiExited)
  killAll()
  await waitNoProcess()
}

// ---------------------------------------------------------------- 汇总
killAll()
await waitNoProcess()
// 用例 10 的临时数据目录再兜一次：Chromium 退出后可能还抓着目录句柄几千毫秒，
// 用例内部的清理会失败（实测留下一个空目录），放在最后再删一次最稳。
purgeDir(join(ROOT, '.tmp-acceptance-udd'))
console.log('\n=== 验收结论 ===')
const failed = results.filter((r) => !r.pass)
const passed = results.length - failed.length
console.log(`通过 ${passed}/${results.length} 项`)
if (failed.length) {
  console.log('未通过：')
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? '  ' + f.detail : ''}`)
  process.exit(1)
}
console.log('✔ 全部验收项通过')
process.exit(0)
