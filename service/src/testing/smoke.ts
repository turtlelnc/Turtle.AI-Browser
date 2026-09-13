/**
 * 一次性冒烟检查（不属于自检套件）：验证 `--help`、`--token-file`、
 * 自动化接口默认关闭时的中文错误，以及 WebSocket 通道的握手与响应。
 *
 * 用法：node --experimental-strip-types 不适用；请在 build 后运行：
 *   node dist/testing/smoke.js
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import WebSocket from 'ws'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const indexJs = join(here, '..', 'index.js')

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

async function post(url: string, token: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  return { status: res.status, text: await res.text() }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tib-smoke-'))
  const tokenFile = join(dir, 'handshake.json')
  const token = 'smoke-token-abcdef0123456789'
  writeFileSync(tokenFile, JSON.stringify({ token, port: 0, pid: 0 }))
  mkdirSync(dir, { recursive: true })

  // 1) --help
  const help = spawn(process.execPath, [indexJs, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let helpOut = ''
  help.stdout.setEncoding('utf-8')
  help.stdout.on('data', (d: string) => (helpOut += d))
  await new Promise((r) => help.on('close', r))
  console.log(`[1] --help 输出包含用法：${helpOut.includes('用法：node dist/index.js') ? '✔' : '✘'}`)

  // 2) 用 --token-file 启动，并验证自动化/WS
  const child = spawn(
    process.execPath,
    [indexJs, '--token-file', tokenFile, '--user-data', dir, '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr?.setEncoding('utf-8')
  child.stderr?.on('data', (d: string) => (stderr += d))

  const ready = JSON.parse(await waitLine(child)) as { port: number; ready: boolean }
  console.log(`[2] 就绪行：${JSON.stringify(ready)} -> ${ready.ready && ready.port > 0 ? '✔' : '✘'}`)

  const base = `http://127.0.0.1:${ready.port}`
  const handshake = JSON.parse(readFileSync(join(dir, 'service.json'), 'utf-8')) as { token: string }
  console.log(`[3] --token-file 的 token 被采用：${handshake.token === token ? '✔' : '✘'}`)

  const auto = await post(`${base}/automation/getTabs`, token, { params: {} })
  const autoJson = JSON.parse(auto.text) as { ok: boolean; error?: { code: string; message: string } }
  console.log(
    `[4] 自动化默认关闭：${autoJson.ok === false && autoJson.error?.code === 'automation-disabled' ? '✔' : '✘'} ${autoJson.error?.message ?? ''}`
  )

  const autoNoAuth = await fetch(`${base}/automation/getTabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"params":{}}'
  })
  console.log(`[4b] 自动化端点未带 token 返回 401：${autoNoAuth.status === 401 ? '✔' : `✘ HTTP ${autoNoAuth.status}`}`)

  const unknown = await post(`${base}/automation/notAnAction`, token, { params: {} })
  console.log(`[5] 未知动作返回 404：${unknown.status === 404 ? '✔' : '✘'}`)

  // 6) WebSocket 往返
  const wsResult = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/automation-ws?token=${token}`)
    const timer = setTimeout(() => {
      ws.terminate()
      resolve('（超时）')
    }, 8000)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { event?: string; id?: string; ok?: boolean; error?: { code?: string } }
      if (msg.event === 'ready') {
        ws.send(JSON.stringify({ id: 'a1', action: 'getTabs', params: {} }))
        ws.send(JSON.stringify({ id: 'a2', action: 'nope', params: {} }))
        return
      }
      if (msg.id === 'a2') {
        clearTimeout(timer)
        ws.close()
        resolve(msg.ok === false && msg.error?.code === 'unknown-action' ? '✔' : `✘ ${data.toString()}`)
      }
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      resolve(`✘ 连接错误：${e.message}`)
    })
  })
  console.log(`[6] WebSocket 鉴权+响应：${wsResult}`)

  const wsBad = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/automation-ws?token=wrong`)
    ws.on('error', (e) => resolve(e.message.includes('401') ? '✔ 已拒绝（401）' : `✘ ${e.message}`))
    ws.on('open', () => {
      ws.close()
      resolve('✘ 竟然建立连接')
    })
  })
  console.log(`[7] WebSocket 错误 token：${wsBad}`)

  child.kill()
  await new Promise((r) => setTimeout(r, 400))
  rmSync(dir, { recursive: true, force: true })
  console.log(`\n（stderr 片段）\n${stderr.split('\n').slice(0, 8).join('\n')}`)
}

main().catch((e) => {
  console.error(`冒烟检查失败：${e instanceof Error ? e.stack : String(e)}`)
  process.exit(1)
})
