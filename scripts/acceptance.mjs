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
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      return true
    } catch {
      spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        `Start-Sleep -Milliseconds 300; Remove-Item -LiteralPath '${USER_DATA}' -Recurse -Force -ErrorAction SilentlyContinue`
      ], { stdio: 'ignore' })
    }
  }
  return !existsSync(USER_DATA)
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
console.log('\n用例 4：无痕模式')
if (want(4)) {
  const r = await runCase('incognito', ['--incognito', '--url=https://example.com'], 35)
  check('以无痕窗口启动', r.log.includes('创建主窗口：无痕窗口'))
  check('注入指纹改写脚本', /向页面注入指纹改写脚本（\d+ 字节）/.test(r.log))
  check('无痕不记录历史', !existsSync(join(USER_DATA, 'history.json')))
  check('进程存活', r.survived >= 25, `实际 ${r.survived}s`)
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

// ---------------------------------------------------------------- 汇总
killAll()
await waitNoProcess()
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
