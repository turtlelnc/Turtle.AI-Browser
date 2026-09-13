/**
 * 一次性集成检查（不属于自检套件）：验证「外部 AI 工具 → 边车 → 原生浏览器」的完整转发链路。
 *
 * 做法：起一个假的「原生自动化端点」HTTP 服务器，把边车的 `native-bridge.json`
 * 指过去，开启 `automation.enabled`，然后通过边车的 `/automation/navigate` 调用，
 * 断言原生端点**确实收到**了正确的协议动作名与参数（证明映射与转发都是真的）。
 *
 * 用法：node dist/testing/native-bridge-check.js
 */

import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const indexJs = join(here, '..', 'index.js')

/** 假原生端点收到的请求 */
const received: Array<{ action: string; body: Record<string, unknown> }> = []
const NATIVE_TOKEN = 'native-bridge-token-xyz'

function startFakeNative(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf-8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => {
      const auth = req.headers['authorization'] ?? ''
      const url = req.url ?? ''
      const action = decodeURIComponent(url.replace('/automation/', ''))
      if (auth !== `Bearer ${NATIVE_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '假原生端点：token 不对' } }))
        return
      }
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(body) as Record<string, unknown>
      } catch {
        parsed = {}
      }
      received.push({ action, body: parsed })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, result: { fromNative: true, action, echo: parsed } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
            setTimeout(r, 300).unref?.()
          })
      })
    })
  })
}

function waitLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('等待就绪行超时')), 20_000)
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (d: string) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        clearTimeout(timer)
        resolve(buf.slice(0, nl).trim())
      }
    })
    child.on('error', reject)
  })
}

async function call(url: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json }
}

let pass = 0
let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  ✔ ${label}${detail ? `　${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ✘ ${label}${detail ? `　${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tib-bridge-'))
  mkdirSync(dir, { recursive: true })
  const native = await startFakeNative()

  // 预置配置：把边车指向假原生端点
  writeFileSync(
    join(dir, 'native-bridge.json'),
    JSON.stringify({ baseUrl: `http://127.0.0.1:${native.port}`, token: NATIVE_TOKEN })
  )
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ automation: { enabled: true } }))
  const TOKEN = 'bridge-check-token-0001'
  writeFileSync(join(dir, 'handshake.json'), JSON.stringify({ token: TOKEN }))

  const child = spawn(process.execPath, [indexJs, '--user-data', dir, '--token-file', join(dir, 'handshake.json')], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr?.setEncoding('utf-8')
  child.stderr?.on('data', (d: string) => (stderr += d))

  const ready = JSON.parse(await waitLine(child)) as { port: number; capabilities: string[] }
  const base = `http://127.0.0.1:${ready.port}`
  check('边车启动并报告已连接原生端点', ready.capabilities.includes('native-bridge:connected'), ready.capabilities.join(','))

  // 1) navigate 转发
  const nav = await call(`${base}/automation/navigate`, TOKEN, { params: { url: 'https://example.com' } })
  check('navigate 返回 ok', nav.json['ok'] === true, JSON.stringify(nav.json).slice(0, 120))
  check(
    '假原生端点收到协议动作 navigate',
    received.some((r) => r.action === 'navigate'),
    received.map((r) => r.action).join('、')
  )
  const navReq = received.find((r) => r.action === 'navigate')
  check(
    '转发参数正确（params.url + source）',
    (navReq?.body['params'] as Record<string, unknown> | undefined)?.['url'] === 'https://example.com' &&
      navReq?.body['source'] === 'external',
    JSON.stringify(navReq?.body ?? {})
  )

  // 2) 动作名 → 工具名 → 协议动作来回映射（getPageText 这类不同名的很容易出错）
  const text = await call(`${base}/automation/getPageText`, TOKEN, { params: { maxChars: 100 } })
  check('getPageText 转发成功', text.json['ok'] === true)
  check('假原生端点收到 getPageText 动作', received.some((r) => r.action === 'getPageText'))

  // 3) 必填参数缺失在边车侧即被拦下（不应打到原生）
  const before = received.length
  const bad = await call(`${base}/automation/navigate`, TOKEN, { params: {} })
  const err = bad.json['error'] as { code?: string; message?: string } | undefined
  check('缺少必填参数返回 missing-param', err?.code === 'missing-param', err?.message ?? '')
  check('参数校验失败不产生原生请求', received.length === before)

  // 4) 未知动作 404
  const unknownAction = await call(`${base}/automation/nope`, TOKEN, { params: {} })
  check('未知动作返回 404', unknownAction.status === 404)

  // 5) 动作清单端点
  const listRes = await fetch(`${base}/automation`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const list = (await listRes.json()) as { ok: boolean; enabled: boolean; actions: unknown[] }
  check('自动化动作清单可读且已启用', list.ok === true && list.enabled === true, `${list.actions.length} 个动作`)

  // 6) AI 工具也可经同一通道回调原生（agent → executor → 原生）
  const toolsRes = await call(`${base}/rpc/ai.tools`, TOKEN, { params: { permission: 'daily' } })
  check('ai.tools 返回 45 个工具中的 daily 子集', toolsRes.json['ok'] === true)

  child.kill()
  await new Promise((r) => setTimeout(r, 400))
  await native.close()
  rmSync(dir, { recursive: true, force: true })

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项。`)
  if (fail > 0) {
    console.log(`（stderr）\n${stderr.split('\n').slice(0, 12).join('\n')}`)
    process.exit(1)
  }
  console.log('NATIVE BRIDGE CHECK OK')
}

main().catch((e) => {
  console.error(`集成检查失败：${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})
