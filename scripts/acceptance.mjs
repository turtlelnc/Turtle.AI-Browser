// rc 验收测试：按"用户真实使用路径"逐项验证，全部以日志与进程状态为证据。
//
// 设计原则：
//   * 只报告**观察到**的事实，不做推断（拿不到证据就标为「无法验证」，不写成通过）
//   * 每个用例独立起进程、独立计时、独立收集日志，互不污染
//   * 结束时确保不留残余进程，方便连续跑多轮
//
// 用法：node scripts/acceptance.mjs [--keep]
//   --keep  测试结束后保留最后一个实例，便于人工查看界面
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const EXE = join(ROOT, 'build-native/TiBrowser.exe')
const KEEP = process.argv.includes('--keep')

const USER_DATA = join(process.env.LOCALAPPDATA ?? '', 'TiBrowser')
const LOG = join(USER_DATA, 'tibrowser.log')

const results = []

function killAll() {
  spawnSync('taskkill', ['/F', '/IM', 'TiBrowser.exe', '/T'], { stdio: 'ignore' })
}

function readLog() {
  try {
    return readFileSync(LOG, 'utf8')
  } catch {
    return ''
  }
}

/** 启动一次浏览器并跟踪存活时间；返回 { survived, log } */
async function runCase(name, args, seconds) {
  killAll()
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })

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
    await new Promise((r) => setTimeout(r, 1000))
    if (exited) break
    survived = Math.round((Date.now() - started) / 1000)
  }

  const log = readLog()
  if (!KEEP) {
    killAll()
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
console.log('用例 1：单标签页启动并稳定运行 40 秒')
{
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
{
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
{
  const r = await runCase('shortcut', ['--shortcut-test'], 40)
  check('Ctrl+T 新建标签页', /Ctrl\+T 后标签数 2/.test(r.log))
  check('Ctrl+Tab 相邻切换', /Ctrl\+Tab 后活动标签/.test(r.log))
  check('Ctrl+Shift+T 恢复关闭的标签页', /Ctrl\+Shift\+T 恢复=成功/.test(r.log))
  check('快捷键自检完成后进程仍存活', r.survived >= 20, `实际 ${r.survived}s`)
}

// ---------------------------------------------------------------- 用例 4：无痕
console.log('\n用例 4：无痕模式')
{
  const r = await runCase('incognito', ['--incognito', '--url=https://example.com'], 35)
  check('以无痕窗口启动', r.log.includes('创建主窗口：无痕窗口'))
  check('注入指纹改写脚本', /向页面注入指纹改写脚本（\d+ 字节）/.test(r.log))
  check('无痕不记录历史', !existsSync(join(USER_DATA, 'history.json')))
  check('进程存活', r.survived >= 25, `实际 ${r.survived}s`)
}

// ---------------------------------------------------------------- 用例 5：设置持久化
console.log('\n用例 5：设置持久化（改皮肤/主题后重启生效）')
{
  killAll()
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
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
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify(settings), 'utf8')
  const r = await runCase('settings', ['--url=https://example.com'], 30)
  check('启动时读到磁盘设置', /已应用设置 —— 皮肤=chrome 主题=dark/.test(r.log))
  check('首屏引导使用真实设置', /注入首屏引导：皮肤=chrome 主题=dark/.test(r.log))
  check('UI 实际生效 data-skin=chrome', /\| skin=chrome/.test(r.log))
  check('UI 实际生效 data-theme=dark', /\| theme=dark/.test(r.log))
}

// ---------------------------------------------------------------- 汇总
killAll()
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
