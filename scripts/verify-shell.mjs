// 原生外壳联调自检：通过 CDP 检查 tib://ui 页面里「桥是否真的通了」。
// 用法：node scripts/verify-shell.mjs [调试端口，默认 9223]
//
// 为什么需要它：外壳 UI 加载成功 ≠ 桥接成功。UI 在检测不到 window.tib 时会
// 静默降级为 mock 桥（只打印一行提示），看起来一切正常但实际没连上原生。
// 本脚本直接问渲染进程要答案，避免"看起来能跑"的假阳性。
//
// 用 Node 24 内置的全局 WebSocket（服务里的 ws 依赖在此仅作后备）。

const PORT = Number(process.argv[2] ?? 9223)

const WebSocketImpl = globalThis.WebSocket

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  if (!res.ok) throw new Error(`调试端口未响应：HTTP ${res.status}`)
  return res.json()
}

/** 在指定 target 上执行一段表达式，返回其值 */
function evaluate(wsUrl, expression, { awaitPromise = false, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(wsUrl)
    let opened = false
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* 已关闭则忽略 */
      }
      reject(
        new Error(
          opened
            ? `CDP 调用超时（${timeoutMs}ms）：页面可能正忙，或表达式等待的原生响应没有回来`
            : `CDP WebSocket 连接超时（${timeoutMs}ms）：${wsUrl}`
        )
      )
    }, timeoutMs)

    ws.onopen = () => {
      opened = true
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise }
        })
      )
    }
    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (msg.id !== 1) return
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* 忽略 */
      }
      if (msg.result?.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.text ?? '页面内表达式抛出异常'))
        return
      }
      resolve(msg.result?.result?.value)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`CDP 连接错误：${wsUrl}`))
    }
  })
}

const list = await targets()
console.log(`发现 ${list.length} 个调试目标：`)
for (const t of list) console.log(`  - [${t.type}] ${t.url}`)

const page = list.find((t) => t.url.startsWith('tib://ui'))
if (!page) {
  console.error('\n未找到 tib://ui 外壳页面。原生可能仍在启动，或 tib:// 协议未生效。')
  process.exit(1)
}

const probe = `(function () {
  var root = document.documentElement;
  var rootEl = document.getElementById('root');
  var appEl = document.querySelector('.app') || rootEl;
  var cs = appEl ? getComputedStyle(appEl) : null;
  return JSON.stringify({
    href: location.href,
    hasTib: typeof window.tib,
    isMock: !window.tib,
    host: typeof (window.__tibHost && window.__tibHost.call),
    rootKids: rootEl ? rootEl.childElementCount : -1,
    appBox: appEl && appEl.getBoundingClientRect ? Math.round(appEl.getBoundingClientRect().width) + 'x' + Math.round(appEl.getBoundingClientRect().height) : null,
    appBg: cs ? cs.backgroundColor : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    skin: root.dataset.skin || null,
    theme: root.dataset.theme || null,
    perf: root.dataset.perf || null,
    boot: !!window.__TIB_BOOT__,
    title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 200)
  });
})()`

const info = JSON.parse(await evaluate(page.webSocketDebuggerUrl, probe))
console.log('\n=== 外壳页面探针 ===')
for (const [k, v] of Object.entries(info)) console.log(`  ${k}: ${JSON.stringify(v)}`)

const failures = []
if (info.hasTib !== 'object') failures.push('window.tib 不存在（UI 会静默降级为 mock 桥）')
if (info.host !== 'function') failures.push('window.__tibHost.call 不存在（注入脚本未生效）')
if (info.rootKids < 1) failures.push('React 未渲染到 #root')
if (info.bodyBg === 'rgba(0, 0, 0, 0)' && !info.text)
  failures.push('页面既无背景也无文本，疑似空白页')

let state = null
if (info.hasTib === 'object') {
  try {
    const raw = await evaluate(
      page.webSocketDebuggerUrl,
      `window.tib.getState().then(function(s){return JSON.stringify({tabs:(s.tabs||[]).length,activeTabId:s.activeTabId,isIncognito:s.isIncognito,skin:s.settings&&s.settings.skin,url:(s.tabs&&s.tabs[0]&&s.tabs[0].url)||''});})`,
      { awaitPromise: true }
    )
    state = JSON.parse(raw)
    console.log('\n=== getState() 往返结果 ===')
    console.log(' ', JSON.stringify(state))
    if (!(state.tabs > 0)) failures.push('getState() 返回的标签数为 0')
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
