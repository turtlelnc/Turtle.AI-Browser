// 通过 CDP 截取指定 target 的页面截图（GPU 合成窗口无法用 PrintWindow 抓取，
// 但浏览器自己的截图能力总是准确的）。
//
// 用法：node scripts/cdp-shot.mjs <输出目录> [调试端口]
// 产出：<输出目录>/cdp-ui.png（外壳界面）、<输出目录>/cdp-page.png（网页）
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const outDir = resolve(process.argv[2] ?? 'docs/screenshots')
const port = Number(process.argv[3] ?? 9223)
mkdirSync(outDir, { recursive: true })

const WebSocketImpl = globalThis.WebSocket

function cdp(wsUrl, calls, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(wsUrl)
    const results = []
    let i = 0
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* 忽略 */
      }
      reject(new Error(`CDP 超时（${timeoutMs}ms）：${wsUrl}`))
    }, timeoutMs)

    const sendNext = () => {
      if (i >= calls.length) {
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* 忽略 */
        }
        resolve(results)
        return
      }
      ws.send(JSON.stringify({ id: i + 1, ...calls[i] }))
    }

    ws.onopen = sendNext
    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (typeof msg.id !== 'number') return
      results.push(msg)
      i += 1
      sendNext()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`CDP 连接失败：${wsUrl}`))
    }
  })
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
console.log(`发现 ${list.length} 个目标`)

const jobs = [
  { match: (t) => t.url.includes('/ui/index.html'), out: 'cdp-ui.png', label: '外壳界面' },
  { match: (t) => !t.url.includes('/ui/index.html') && !t.url.startsWith('devtools'), out: 'cdp-page.png', label: '网页内容' }
]

for (const job of jobs) {
  const target = list.find(job.match)
  if (!target) {
    console.log(`跳过 ${job.label}：未找到对应目标`)
    continue
  }
  // 让窗口以桌面尺寸渲染，并等一帧再截
  const res = await cdp(target.webSocketDebuggerUrl, [
    { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1200, height: 720, deviceScaleFactor: 1, mobile: false } },
    { method: 'Runtime.evaluate', params: { expression: 'document.documentElement.dataset.skin', returnByValue: true } },
    { method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: false } }
  ])
  const shot = res.find((r) => r.id === 3)
  const data = shot?.result?.data
  if (!data) {
    console.log(`✘ ${job.label} 截图失败：${JSON.stringify(shot?.error ?? shot)}`)
    continue
  }
  const path = join(outDir, job.out)
  writeFileSync(path, Buffer.from(data, 'base64'))
  const skin = res.find((r) => r.id === 2)?.result?.result?.value
  console.log(`✔ ${job.label} → ${path}（${(Buffer.from(data, 'base64').length / 1024).toFixed(1)} KB，皮肤=${skin ?? 'n/a'}）`)
}
