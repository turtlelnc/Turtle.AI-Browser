/**
 * 本地自动化 WebSocket API（特性 15 的推送通道）。
 *
 * 消息协议（JSON 文本帧）：
 * ```jsonc
 * // 客户端 → 服务端（请求）
 * { "id": "req-1", "action": "navigate", "params": { "url": "https://example.com" } }
 * // 服务端 → 客户端（响应）
 * { "id": "req-1", "ok": true, "result": { "tabId": "..." } }
 * { "id": "req-1", "ok": false, "error": { "code": "unknown-action", "message": "……" } }
 * // 服务端 → 客户端（浏览器事件广播，无 id）
 * { "event": "download", "payload": { ... }, "ts": 1726000000000 }
 * ```
 * 另外支持 `{"id":"s1","action":"subscribe","params":{"events":["download","aiChunk"]}}` 订阅，
 * 以及 `ping` / `pong` 心跳（服务端每 30 秒也主动 ping 一次）。
 *
 * 鉴权与 RPC 一致：`Authorization: Bearer <token>` 或 `?token=`；
 * 且只接受来自 127.0.0.1 的连接。
 */

import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ACTION_MAP, AUTOMATION_ACTIONS } from './actions.js'
import type { AutomationDeps } from './http-api.js'
import { runAction } from './http-api.js'

/** 允许订阅的浏览器事件（与 ARCHITECTURE.md §3.2 对齐） */
export const BROADCAST_EVENTS = [
  'state',
  'findResult',
  'windowState',
  'download',
  'aiChunk',
  'aiDone',
  'aiError',
  'aiTool',
  'securityEvent',
  'accountsChanged',
  'appsChanged',
  'extensionsChanged'
] as const

interface Client {
  socket: WebSocket
  /** 已订阅事件；空集合表示「全部事件」 */
  events: Set<string>
  alive: boolean
  id: number
}

export interface WsApiOptions {
  /** 是否启用自动化（默认关闭） */
  isEnabled: () => boolean
  deps: AutomationDeps
  path?: string
  log?: (message: string) => void
}

export class AutomationWsApi {
  private wss: WebSocketServer | null = null
  private readonly clients = new Set<Client>()
  private heartbeat: NodeJS.Timeout | null = null
  private nextId = 1

  constructor(private readonly options: WsApiOptions) {}

  /** 挂载到已存在的 HTTP 服务器上（复用 RPC 服务器的端口，不额外开端口） */
  attach(server: Server, isAuthorized: (req: IncomingMessage, queryToken: string | null) => boolean): void {
    if (this.wss) return
    const path = this.options.path ?? '/automation-ws'
    const wss = new WebSocketServer({ noServer: true })
    this.wss = wss

    server.on('upgrade', (req, socket, head) => {
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        socket.destroy()
        return
      }
      if (url.pathname !== path) {
        socket.destroy()
        return
      }
      // 只接受本机连接
      const remote = req.socket.remoteAddress ?? ''
      if (!isLoopback(remote)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      if (!isAuthorized(req, url.searchParams.get('token'))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    })

    wss.on('connection', (ws: WebSocket) => {
      const client: Client = { socket: ws, events: new Set<string>(), alive: true, id: this.nextId++ }
      this.clients.add(client)
      this.options.log?.(`[ws] 客户端已连接（#${client.id}），当前 ${this.clients.size} 个`)
      this.send(client, {
        event: 'ready',
        payload: {
          clientId: client.id,
          actions: AUTOMATION_ACTIONS.map((a) => a.name),
          subscribableEvents: [...BROADCAST_EVENTS],
          enabled: this.options.isEnabled()
        },
        ts: Date.now()
      })

      ws.on('message', (data) => {
        void this.onMessage(client, data.toString())
      })
      ws.on('pong', () => {
        client.alive = true
      })
      ws.on('close', () => this.drop(client))
      ws.on('error', () => this.drop(client))
    })

    this.heartbeat = setInterval(() => {
      for (const client of [...this.clients]) {
        if (!client.alive) {
          this.options.log?.(`[ws] 客户端 #${client.id} 心跳超时，已断开`)
          try {
            client.socket.terminate()
          } catch {
            /* 忽略 */
          }
          this.drop(client)
          continue
        }
        client.alive = false
        try {
          client.socket.ping()
        } catch {
          this.drop(client)
        }
      }
    }, 30_000)
    this.heartbeat.unref?.()

    this.options.log?.(`[ws] WebSocket 端点已挂载：${path}`)
  }

  /** 广播浏览器事件给所有（已订阅的）客户端 */
  broadcast(event: string, payload: unknown): void {
    for (const client of this.clients) {
      if (client.events.size > 0 && !client.events.has(event)) continue
      this.send(client, { event, payload, ts: Date.now() })
    }
  }

  get clientCount(): number {
    return this.clients.size
  }

  /** 关闭所有连接与监听 */
  async close(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const client of [...this.clients]) {
      try {
        client.socket.close(1001, '服务正在关闭')
      } catch {
        /* 忽略 */
      }
      this.drop(client)
    }
    const wss = this.wss
    this.wss = null
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let msg: { id?: unknown; action?: unknown; params?: unknown; event?: unknown; events?: unknown }
    try {
      msg = JSON.parse(raw) as typeof msg
    } catch {
      this.send(client, {
        id: null,
        ok: false,
        error: { code: 'bad-json', message: '消息不是合法的 JSON。' }
      })
      return
    }
    const id = msg.id ?? null
    const action = String(msg.action ?? msg.event ?? '').trim()
    const params =
      msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {}

    // 心跳
    if (action === 'ping') {
      this.send(client, { id, ok: true, result: { pong: Date.now() } })
      return
    }

    // 订阅 / 退订事件
    if (action === 'subscribe' || action === 'unsubscribe') {
      const list = Array.isArray(msg.events)
        ? (msg.events as unknown[]).map(String)
        : Array.isArray(params['events'])
          ? (params['events'] as unknown[]).map(String)
          : []
      const invalid = list.filter((e) => !(BROADCAST_EVENTS as readonly string[]).includes(e))
      if (invalid.length) {
        this.send(client, {
          id,
          ok: false,
          error: { code: 'unknown-event', message: `不支持订阅的事件：${invalid.join('、')}` }
        })
        return
      }
      for (const e of list) {
        if (action === 'subscribe') client.events.add(e)
        else client.events.delete(e)
      }
      this.send(client, {
        id,
        ok: true,
        result: { subscribed: [...client.events], mode: client.events.size ? 'selected' : 'all' }
      })
      return
    }

    // 动作清单
    if (action === 'actions' || action === 'list') {
      this.send(client, { id, ok: true, result: { actions: [...ACTION_MAP.keys()] } })
      return
    }

    if (!action) {
      this.send(client, {
        id,
        ok: false,
        error: { code: 'missing-action', message: '消息缺少 action 字段。' }
      })
      return
    }

    const result = await runAction(action, params, this.options.deps, 'external')
    this.send(client, {
      id,
      ok: result.ok,
      ...(result.ok ? { result: result.result } : { error: result.error })
    })
  }

  private send(client: Client, body: unknown): void {
    try {
      client.socket.send(JSON.stringify(body))
    } catch {
      this.drop(client)
    }
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client)) return
    try {
      client.socket.terminate()
    } catch {
      /* 忽略 */
    }
    this.options.log?.(`[ws] 客户端已断开（#${client.id}），当前 ${this.clients.size} 个`)
  }
}

/** 是否为本机回环地址（含 IPv4-mapped IPv6） */
export function isLoopback(remote: string): boolean {
  if (!remote) return false
  const r = remote.replace(/^::ffff:/i, '')
  return r === '127.0.0.1' || r === '::1' || r === 'localhost' || r.startsWith('127.')
}
