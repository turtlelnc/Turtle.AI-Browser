/**
 * 边车本地 RPC 服务器（对接 ARCHITECTURE.md §4）。
 *
 * - 只监听 `127.0.0.1`（绝不监听 0.0.0.0），端口默认由系统分配（port 0），
 *   也可用 `--port` 指定；实际端口写入握手文件并打印到 stdout 的 JSON 就绪行。
 * - 每个请求都要 `Authorization: Bearer <token>`；用 `crypto.timingSafeEqual` 做常数时间比较。
 * - `POST /rpc/<method>`：请求体 `{params}`，响应 `{ok:true,result}` 或
 *   `{ok:false,error:{code,message}}`（message 一律中文）。
 * - `GET /events?token=`：SSE 流（`text/event-stream`），事件名对齐 §3.2，
 *   每 15 秒发送一次心跳注释，客户端断开时清理连接。
 * - `GET /health`：不需要鉴权，只返回版本与能力清单（**不含**任何敏感信息如 token/端口用途）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { APP_BUILD, APP_VERSION, SERVICE_EVENTS, type ServiceEventName } from '../shared/constants.js'

/** 业务错误（可安全返回给调用方） */
export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** 方法处理器：返回任意可 JSON 序列化的值；抛 RpcError 会转成结构化错误 */
export type RpcHandler = (params: Record<string, unknown>, ctx: RpcContext) => unknown | Promise<unknown>

export interface RpcContext {
  /** 调用方 IP（恒为 127.0.0.1） */
  remote: string
  /** 事件广播器（方法内部可主动推事件） */
  emit: (event: ServiceEventName, payload: unknown) => void
  /** 请求到达时间 */
  startedAt: number
}

export interface RpcMethodInfo {
  name: string
  /** 中文说明（同步生成 docs/SERVICE-API.md） */
  summary: string
  handler: RpcHandler
}

/** 方法注册表 */
export class RpcRegistry {
  private readonly methods = new Map<string, RpcMethodInfo>()

  register(name: string, summary: string, handler: RpcHandler): this {
    if (this.methods.has(name)) throw new Error(`RPC 方法重复注册：${name}`)
    this.methods.set(name, { name, summary, handler })
    return this
  }

  get(name: string): RpcMethodInfo | undefined {
    return this.methods.get(name)
  }

  list(): RpcMethodInfo[] {
    return [...this.methods.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get size(): number {
    return this.methods.size
  }
}

/** SSE 订阅者 */
interface Subscriber {
  id: number
  res: ServerResponse
  heartbeat: NodeJS.Timeout
}

export interface RpcServerOptions {
  /** 认证 token；未提供则随机生成 32 字节 */
  token?: string
  /** 期望端口（0 = 系统分配） */
  port?: number
  /** 能力清单（写入 /health 与就绪行） */
  capabilities?: string[]
  /** 日志函数（一律写 stderr，stdout 只留给就绪行） */
  log?: (message: string) => void
  /**
   * 附加请求处理器（在**通过鉴权之后**、内置路由之前调用）。
   * 返回 true 表示已处理。用于挂载 `/automation/*` 等扩展端点，
   * 保证它们复用同一套 Bearer token 鉴权，而不必再实现一遍。
   */
  onRequest?: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    helpers: { readBody: (req: IncomingMessage, limit?: number) => Promise<string> }
  ) => Promise<boolean> | boolean
}

export class RpcServer {
  readonly token: string
  private readonly registry = new RpcRegistry()
  private readonly subscribers = new Set<Subscriber>()
  private server: Server | null = null
  private nextSubscriberId = 1
  private actualPort = 0

  constructor(private readonly options: RpcServerOptions = {}) {
    this.token = options.token?.trim() || randomBytes(32).toString('hex')
  }

  /** 注册一个 RPC 方法 */
  register(name: string, summary: string, handler: RpcHandler): this {
    this.registry.register(name, summary, handler)
    return this
  }

  /** 覆盖能力清单（/health 与就绪行使用） */
  setCapabilities(capabilities: string[]): void {
    this.options.capabilities = capabilities
  }

  /** 底层 HTTP 服务器（挂载 WebSocket upgrade 用）；未启动时为 null */
  get httpServer(): Server | null {
    return this.server
  }

  /** 鉴权判断（WebSocket upgrade 复用同一套逻辑） */
  isAuthorized(req: IncomingMessage, queryToken: string | null): boolean {
    return this.authorized(req, queryToken)
  }

  /** 当前已注册的方法清单 */
  methods(): RpcMethodInfo[] {
    return this.registry.list()
  }

  /** 实际监听端口（start 之后有效） */
  get port(): number {
    return this.actualPort
  }

  get url(): string {
    return `http://127.0.0.1:${this.actualPort}`
  }

  /** 已连接的 SSE 客户端数 */
  get subscriberCount(): number {
    return this.subscribers.size
  }

  /** 向所有 SSE 客户端广播事件 */
  emit(event: ServiceEventName, payload: unknown): void {
    if (!(SERVICE_EVENTS as readonly string[]).includes(event)) {
      this.log(`[rpc] 忽略未定义的事件名：${event}`)
      return
    }
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? null)}\n\n`
    for (const sub of this.subscribers) {
      try {
        sub.res.write(frame)
      } catch {
        this.dropSubscriber(sub)
      }
    }
  }

  /** 启动服务器；返回实际端口 */
  async start(): Promise<number> {
    if (this.server) return this.actualPort
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.log(`[rpc] 未捕获错误：${e instanceof Error ? e.message : String(e)}`)
        if (!res.headersSent) {
          this.sendJson(res, 500, { ok: false, error: { code: 'internal', message: '边车内部错误。' } })
        } else {
          res.end()
        }
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(e)
      server.once('error', onError)
      server.listen(this.options.port ?? 0, '127.0.0.1', () => {
        server.off('error', onError)
        const addr = server.address()
        this.actualPort = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })
    this.log(`[rpc] 已监听 ${this.url}（仅 127.0.0.1，已注册 ${this.registry.size} 个方法）`)
    return this.actualPort
  }

  /** 关闭服务器与所有 SSE 连接 */
  async stop(): Promise<void> {
    for (const sub of [...this.subscribers]) this.dropSubscriber(sub)
    const server = this.server
    this.server = null
    this.actualPort = 0
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // 兜底：500ms 后强制放行，避免 keep-alive 连接阻塞退出
      setTimeout(resolve, 500).unref?.()
    })
  }

  // ---------- 请求处理 ----------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = (req.method ?? 'GET').toUpperCase()

    // 统一的安全响应头（本地服务，禁止被网页嵌入/嗅探）
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')

    if (method === 'OPTIONS') {
      this.sendJson(res, 204, undefined)
      return
    }

    if (url.pathname === '/health') {
      this.sendJson(res, 200, {
        ok: true,
        version: APP_VERSION,
        build: APP_BUILD,
        capabilities: this.options.capabilities ?? []
      })
      return
    }

    if (url.pathname.startsWith('/rpc/')) {
      if (!this.authorized(req, null)) return this.unauthorized(res)
      if (method !== 'POST') {
        this.sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '该端点只接受 POST 请求。' } })
        return
      }
      await this.handleRpc(url.pathname.slice('/rpc/'.length), req, res)
      return
    }

    if (url.pathname === '/events') {
      // SSE 通过 query 传 token（EventSource 无法自定义请求头）
      if (!this.authorized(req, url.searchParams.get('token'))) return this.unauthorized(res)
      this.handleEvents(req, res)
      return
    }

    // 扩展端点（例如 /automation/*）：同样要求 Bearer token
    if (this.options.onRequest) {
      const headerToken = this.extractToken(req)
      const queryToken = url.searchParams.get('token') ?? ''
      if (!constantTimeEqual(headerToken || queryToken, this.token)) {
        return this.unauthorized(res)
      }
      const handled = await this.options.onRequest(req, res, url, { readBody })
      if (handled) return
    }

    this.sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知端点。' } })
  }

  /** 从 Authorization 头提取 token（无则返回空串） */
  private extractToken(req: IncomingMessage): string {
    const header = req.headers['authorization']
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      return header.slice(7).trim()
    }
    return ''
  }

  private async handleRpc(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const decode = decodeURIComponent(name)
    const target = this.registry.get(decode)
    if (!target) {
      this.sendJson(res, 404, {
        ok: false,
        error: { code: 'unknown-method', message: `未知的 RPC 方法：${decode}` }
      })
      return
    }
    let body = ''
    try {
      body = await readBody(req, 8 * 1024 * 1024)
    } catch (e) {
      this.sendJson(res, 413, {
        ok: false,
        error: { code: 'payload-too-large', message: e instanceof Error ? e.message : '请求体过大。' }
      })
      return
    }
    let params: Record<string, unknown> = {}
    if (body.trim()) {
      try {
        const parsed = JSON.parse(body) as { params?: unknown }
        if (parsed && typeof parsed === 'object' && parsed.params && typeof parsed.params === 'object') {
          params = parsed.params as Record<string, unknown>
        } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          // 允许直接传参数对象（对 curl 更友好）
          params = parsed as Record<string, unknown>
        }
      } catch {
        this.sendJson(res, 400, {
          ok: false,
          error: { code: 'bad-json', message: '请求体不是合法的 JSON。' }
        })
        return
      }
    }

    const startedAt = Date.now()
    try {
      const result = await target.handler(params, {
        remote: req.socket.remoteAddress ?? '',
        emit: (event, payload) => this.emit(event, payload),
        startedAt
      })
      this.sendJson(res, 200, { ok: true, result: result ?? null })
    } catch (e) {
      if (e instanceof RpcError) {
        this.sendJson(res, e.httpStatus, { ok: false, error: { code: e.code, message: e.message } })
        return
      }
      // 未预期的异常：只把中文消息回给调用方，细节写日志
      const message = e instanceof Error ? e.message : String(e)
      this.log(`[rpc] 方法 ${decode} 执行失败：${message}`)
      this.sendJson(res, 500, {
        ok: false,
        error: { code: 'handler-failed', message: `执行「${decode}」失败：${message}` }
      })
    }
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(`retry: 3000\n\n`)
    const sub: Subscriber = {
      id: this.nextSubscriberId++,
      res,
      heartbeat: setInterval(() => {
        try {
          res.write(`: heartbeat ${Date.now()}\n\n`)
        } catch {
          this.dropSubscriber(sub)
        }
      }, 15_000)
    }
    sub.heartbeat.unref?.()
    this.subscribers.add(sub)
    // 立刻推一帧，让客户端确认连接可用
    res.write(`event: ready\ndata: ${JSON.stringify({ subscriberId: sub.id, server: 'tib-service' })}\n\n`)
    this.log(`[rpc] SSE 客户端已连接（#${sub.id}），当前 ${this.subscribers.size} 个`)

    const cleanup = (): void => this.dropSubscriber(sub)
    req.on('close', cleanup)
    req.on('aborted', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  private dropSubscriber(sub: Subscriber): void {
    if (!this.subscribers.delete(sub)) return
    clearInterval(sub.heartbeat)
    try {
      sub.res.end()
    } catch {
      /* 连接已断开 */
    }
    this.log(`[rpc] SSE 客户端已断开（#${sub.id}），当前 ${this.subscribers.size} 个`)
  }

  /** 鉴权：请求头优先，其次 query（仅 SSE 使用） */
  private authorized(req: IncomingMessage, queryToken: string | null): boolean {
    const provided = this.extractToken(req) || (queryToken ?? '').trim()
    return constantTimeEqual(provided, this.token)
  }

  private unauthorized(res: ServerResponse): void {
    this.sendJson(res, 401, {
      ok: false,
      error: {
        code: 'unauthorized',
        message: '鉴权失败：缺少或错误的 Bearer token。请在 Authorization 头中携带正确的 token。'
      }
    })
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text)
    })
    res.end(text)
  }

  private log(message: string): void {
    ;(this.options.log ?? ((m: string) => process.stderr.write(m + '\n')))(message)
  }
}

/** 常数时间字符串比较（长度不同直接返回 false，不泄露长度信息以外的时间差） */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a ?? '', 'utf-8')
  const bufB = Buffer.from(b ?? '', 'utf-8')
  if (bufA.length !== bufB.length) {
    // 仍然做一次比较，避免因为提前返回而泄露长度差异的时序特征
    try {
      timingSafeEqual(bufA, bufA)
    } catch {
      /* 忽略 */
    }
    return false
  }
  try {
    return timingSafeEqual(bufA, bufB)
  } catch {
    return false
  }
}

/** 读取请求体（带大小上限） */
export function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过上限（${Math.round(limit / 1024)} KiB）。`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', (e) => reject(e))
  })
}
