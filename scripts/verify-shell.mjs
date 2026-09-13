// 原生外壳联调自检：通过 CDP 检查 tib://ui 页面里「桥是否真的通了」。
// 用法：node scripts/verify-shell.mjs [调试端口，默认 9223]
//
// 为什么需要它：外壳 UI 加载成功 ≠ 桥接成功。UI 在检测不到 window.tib 时会
// 静默降级为 mock 桥（只打印一行提示），看起来一切正常但实际没连上原生。
// 本脚本直接问渲染进程要答案，避免"看起来能跑"的假阳性。
import { createRequire } from 'node:module'

// ws 是 CommonJS 包，ESM 下用 createRequire 取具名导出
const require = createRequire(import.meta.url)
const { WebSocket } = require('../service/node_modules/ws')

const PORT = Number(process.argv[2] ?? 9223)

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  if (!res.ok) throw new Error(`调试端口未响应：HTTP ${res.status}`)
  return res.json()
}

/** 在指定 target 上执行一段表达式，返回其值 */
function evaluate(wsUrl, expression, { awaitPromise = false, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let opened = false
    const timer = setTimeout(() => {
      ws.terminate()
      reject(
        new Error(
          opened
            ? `CDP 调用超时（${timeoutMs}ms）：页面可能正忙或表达式等待的原生响应没有回来`
            : `CDP WebSocket 连接超时（${timeoutMs}ms）：${wsUrl}`
        )
      )
    }, timeoutMs)
    ws.on('open', () => {
      opened = true
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise }
        })
      )
    })
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.text ?? '页面内表达式抛出异常'))
        return
      }
      resolve(msg.result?.result?.value)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`CDP 连接错误：${err.message}`))
    })
  })
}

const list = await targets()
console.log(`发现 ${list.length} 个调试目标：`)
for (const t of list) console.log(`  - [${t.type}] ${t.url}`)

const page = list.find((t) => t.url.startsWith('tib://'))
if (!page) {
  console.error('\n未找到 tib:// 外壳页面。原生可能仍在启动，或 tib:// 协议未生效。')
  process.exit(1)
}

const probe = `(function () {
  var root = document.documentElement;
  var tabs = document.querySelectorAll('[data-tab-id], .tab, [role="tab"]');
  return JSON.stringify({
    href: location.href,
    hasTib: typeof window.tib,
    tibKeys: window.tib ? Object.keys(window.tib).length : 0,
    isMock: !window.tib,
    rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
    bodyLen: document.body ? document.body.innerHTML.length : 0,
    skin: root.dataset.skin || null,
    theme: root.dataset.theme || null,
    perf: root.dataset.perf || null,
    boot: !!window.__TIB_BOOT__,
    host: typeof (window.__tibHost && window.__tibHost.call),
    preload: typeof window.tibPreload,
    title: document.title,
    tabCount: tabs.length,
    textSample: (document.body ? document.body.innerText : '').slice(0, 160)
  });
})()`

const info = JSON.parse(await evaluate(page.webSocketDebuggerUrl, probe))
console.log('\n=== 外壳页面探针 ===')
for (const [k, v] of Object.entries(info)) console.log(`  ${k}: ${JSON.stringify(v)}`)

// 关键断言：桥必须存在，且必须能真的调通原生
const failures = []
if (info.hasTib !== 'object') failures.push('window.tib 不存在（UI 会静默降级为 mock 桥）')
if (info.host !== 'function') failures.push('window.__tibHost.call 不存在（传输垫片未注入）')
if (info.preload !== 'function') failures.push('window.tibPreload 不存在（CEF 消息路由未生效）')
if (info.rootChildren < 1) failures.push('React 未渲染到 #root')

let stateOk = false
if (info.hasTib === 'object') {
  try {
    const raw = await evaluate(
      page.webSocketDebuggerUrl,
      `window.tib.getState().then(function(s){return JSON.stringify({tabs:(s.tabs||[]).length,activeTabId:s.activeTabId,isIncognito:s.isIncognito,skin:s.settings&&s.settings.skin});})`,
      { awaitPromise: true }
    )
    const state = JSON.parse(raw)
    console.log('\n=== getState() 往返结果 ===')
    console.log(' ', JSON.stringify(state))
    stateOk = state.tabs > 0
    if (!stateOk) failures.push('getState() 返回的标签数为 0')
  } catch (err) {
    failures.push(`getState() 调用失败：${err.message}`)
  }
}

console.log('\n=== 结论 ===')
if (failures.length === 0) {
  console.log('✔ 外壳 UI 已由原生 CEF 提供，window.tib 桥接连通，getState() 往返成功')
  process.exit(0)
}
console.log('✘ 存在问题：')
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)
