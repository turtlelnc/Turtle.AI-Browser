/**
 * MCP（Model Context Protocol）客户端 —— stdio 传输真实实现。
 *
 * 协议：JSON-RPC 2.0，**换行分隔的 JSON**（NDJSON）走子进程 stdin/stdout。
 * 这是 MCP 官方 stdio 传输的规范（每条消息一行 JSON，消息内不得包含裸换行）。
 *
 * 已实现的方法：`initialize` / `notifications/initialized` / `tools/list` / `tools/call`。
 * 未实现（诚实声明）：resources、prompts、采样（sampling）、日志级别协商等。
 * 调用未实现的方法会返回明确的中文错误，而不是假装成功。
 *
 * 崩溃处理：
 * - 子进程意外退出 → 按指数退避自动重启（默认最多 5 次，间隔 0.5s/1s/2s/4s/8s）；
 * - 重启失败或超过上限 → 标记为 `failed`，后续调用返回中文错误说明；
 * - 所有未完成请求在进程退出时以中文错误 reject，避免调用方永久挂起。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readJson, writeJsonAtomic } from '../store/json-store.js'
import { userDataFile } from '../paths.js'
import { APP_VERSION } from '../shared/constants.js'

/** MCP 服务器配置 */
export interface McpServerConfig {
  /** 服务器名（唯一，作为 RPC 参数与工具前缀） */
  name: string
  /** 启动命令（可执行文件），例如 npx / node / python */
  command: string
  /** 命令参数，例如 ['-y', '@modelcontextprotocol/server-filesystem', 'C:/work'] */
  args?: string[]
  /** 追加的环境变量 */
  env?: Record<string, string>
  /** 工作目录 */
  cwd?: string
  /** 是否启用（默认 true） */
  enabled?: boolean
  /** 是否在边车启动时自动拉起（默认 true） */
  autoStart?: boolean
}

export type McpServerState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed'

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: unknown
}

export interface McpServerStatus {
  name: string
  state: McpServerState
  pid: number | null
  /** 已发现的工具数量 */
  toolCount: number
  /** 工具清单（ready 时有值） */
  tools: McpToolInfo[]
  /** 最近一次错误（中文） */
  lastError: string
  /** 已重启次数 */
  restarts: number
  /** 服务器自报的实现信息 */
  serverInfo: { name: string; version: string } | null
}

/** JSON-RPC 请求 / 响应 */
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_RESTARTS = 5
const RESTART_BASE_DELAY_MS = 500

interface PendingRequest {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  method: string
}

/** 单个 MCP 服务器的 stdio 客户端 */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private buffer = ''
  private state: McpServerState = 'stopped'
  private restarts = 0
  private lastError = ''
  private tools: McpToolInfo[] = []
  private serverInfo: { name: string; version: string } | null = null
  private startPromise: Promise<void> | null = null
  private stopping = false
  private restartTimer: NodeJS.Timeout | null = null

  constructor(
    readonly config: McpServerConfig,
    private readonly options: { requestTimeoutMs?: number } = {}
  ) {}

  get status(): McpServerStatus {
    return {
      name: this.config.name,
      state: this.state,
      pid: this.child?.pid ?? null,
      toolCount: this.tools.length,
      tools: this.tools.slice(),
      lastError: this.lastError,
      restarts: this.restarts,
      serverInfo: this.serverInfo
    }
  }

  /** 启动并完成 initialize 握手（幂等） */
  async start(): Promise<void> {
    if (this.state === 'ready') return
    if (this.startPromise) return this.startPromise
    this.stopping = false
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async doStart(): Promise<void> {
    this.state = 'starting'
    this.tools = []
    this.serverInfo = null

    try {
      const child = spawn(this.config.command, this.config.args ?? [], {
        cwd: this.config.cwd,
        env: { ...process.env, ...(this.config.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      }) as ChildProcessWithoutNullStreams
      this.child = child
      child.stdout.setEncoding('utf-8')
      child.stderr.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
      child.stderr.on('data', (chunk: string) => {
        // MCP 服务器把日志写到 stderr，这里只保留最后一条用于诊断
        const text = chunk.trim()
        if (text) this.lastError = text.split('\n').slice(-1)[0]?.slice(0, 300) ?? ''
      })
      child.on('error', (e) => {
        this.lastError = `无法启动 MCP 服务器「${this.config.name}」：${e.message}`
        this.failAllPending(this.lastError)
        this.state = 'failed'
      })
      child.on('close', (code) => this.onClose(code))
    } catch (e) {
      this.state = 'failed'
      this.lastError = `无法启动 MCP 服务器「${this.config.name}」：${e instanceof Error ? e.message : String(e)}`
      throw new Error(this.lastError)
    }

    // initialize 握手
    try {
      const result = (await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        // 版本号取共享常量，避免像以前那样在这里硬编码一份会过期的字符串
        clientInfo: { name: 'tib-service', version: APP_VERSION }
      })) as { serverInfo?: { name?: string; version?: string } }
      this.serverInfo = {
        name: result?.serverInfo?.name ?? this.config.name,
        version: result?.serverInfo?.version ?? '未知'
      }
      this.notify('notifications/initialized', {})
      await this.refreshTools()
      this.state = 'ready'
      this.lastError = ''
    } catch (e) {
      this.state = 'failed'
      this.lastError = `MCP 服务器「${this.config.name}」初始化失败：${e instanceof Error ? e.message : String(e)}`
      throw new Error(this.lastError)
    }
  }

  /** 拉取工具清单 */
  async refreshTools(): Promise<McpToolInfo[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>
    }
    this.tools = (result?.tools ?? []).map((t) => ({
      name: t.name ?? '',
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} }
    }))
    return this.tools
  }

  /** 调用一个工具 */
  async callTool(name: string, args: unknown, timeoutMs?: number): Promise<unknown> {
    await this.start()
    if (this.state !== 'ready') {
      throw new Error(
        `MCP 服务器「${this.config.name}」当前不可用（${this.state}）${this.lastError ? '：' + this.lastError : ''}`
      )
    }
    return this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs)
  }

  /** 发送请求并等待结果 */
  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const child = this.child
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error(
        `MCP 服务器「${this.config.name}」未在运行${this.lastError ? '：' + this.lastError : ''}`
      )
    }
    const id = this.nextId++
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`调用 MCP 方法「${method}」超时（${timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS} 毫秒）。`))
      }, timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`写入 MCP 服务器 stdin 失败：${e instanceof Error ? e.message : String(e)}`))
      }
    })
  }

  /** 发送通知（无 id，不等待响应） */
  notify(method: string, params?: unknown): void {
    const child = this.child
    if (!child || !child.stdin.writable) return
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })}\n`)
    } catch {
      /* 通知失败不影响主流程 */
    }
  }

  /** 主动停止（不会触发自动重启） */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    this.failAllPending(`MCP 服务器「${this.config.name}」已停止。`)
    this.state = 'stopped'
    if (!child) return
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 忽略 */
        }
        resolve()
      }, 2000)
      child.once('close', () => {
        clearTimeout(done)
        resolve()
      })
      try {
        child.stdin.end()
        child.kill()
      } catch {
        clearTimeout(done)
        resolve()
      }
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx < 0) break
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: JsonRpcResponse
      try {
        msg = JSON.parse(line) as JsonRpcResponse
      } catch {
        // 非 JSON 行（有些服务器混打日志）：忽略
        continue
      }
      if (msg.id === undefined || msg.id === null) continue // 服务器通知，暂不处理
      const pending = this.pending.get(Number(msg.id))
      if (!pending) continue
      this.pending.delete(Number(msg.id))
      clearTimeout(pending.timer)
      if (msg.error) {
        pending.reject(
          new Error(
            `MCP 方法「${pending.method}」返回错误（${msg.error.code ?? '未知'}）：${msg.error.message ?? '无消息'}`
          )
        )
      } else {
        pending.resolve(msg.result)
      }
    }
  }

  private onClose(code: number | null): void {
    const wasReady = this.state === 'ready' || this.state === 'starting'
    this.child = null
    this.failAllPending(
      `MCP 服务器「${this.config.name}」进程已退出（退出码 ${code ?? '未知'}）${this.lastError ? '：' + this.lastError : ''}`
    )
    if (this.stopping) {
      this.state = 'stopped'
      return
    }
    if (!wasReady) {
      this.state = 'failed'
      return
    }
    // 崩溃 → 指数退避重启
    if (this.restarts >= MAX_RESTARTS) {
      this.state = 'failed'
      this.lastError = `MCP 服务器「${this.config.name}」已连续崩溃 ${this.restarts} 次，停止自动重启。请检查命令与参数是否正确。`
      return
    }
    const delay = RESTART_BASE_DELAY_MS * 2 ** this.restarts
    this.restarts++
    this.state = 'restarting'
    this.lastError = `MCP 服务器「${this.config.name}」意外退出，${delay} 毫秒后进行第 ${this.restarts} 次重启。`
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.start().catch(() => {
        /* start 内部已记录错误与状态 */
      })
    }, delay)
    this.restartTimer.unref?.()
  }

  private failAllPending(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.reject(new Error(message))
    }
  }
}

/**
 * MCP 服务器注册表：负责配置持久化、生命周期与统一调用入口。
 */
export class McpRegistry {
  private readonly clients = new Map<string, McpStdioClient>()
  private configs: McpServerConfig[] = []
  private loaded = false

  constructor(private readonly configPath: () => string = () => userDataFile('mcp.json')) {}

  /** 从磁盘加载配置（幂等）；不会自动启动服务器 */
  load(): McpServerConfig[] {
    if (this.loaded) return this.configs.slice()
    const raw = readJson<{ servers?: McpServerConfig[] }>(this.configPath(), { servers: [] })
    this.configs = (raw.servers ?? []).filter((s) => s && typeof s.name === 'string' && typeof s.command === 'string')
    this.loaded = true
    return this.configs.slice()
  }

  private persist(): void {
    writeJsonAtomic(this.configPath(), { version: 1, servers: this.configs })
  }

  /** 添加（或覆盖）一个服务器；enabled 时立即启动 */
  async addServer(config: McpServerConfig): Promise<McpServerStatus> {
    this.load()
    const name = (config.name ?? '').trim()
    if (!name) throw new Error('MCP 服务器名不能为空。')
    if (!(config.command ?? '').trim()) throw new Error('MCP 启动命令不能为空。')
    const normalized: McpServerConfig = {
      name,
      command: config.command.trim(),
      args: config.args ?? [],
      ...(config.env ? { env: config.env } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      enabled: config.enabled !== false,
      autoStart: config.autoStart !== false
    }
    this.configs = [...this.configs.filter((c) => c.name !== name), normalized]
    this.persist()

    const existing = this.clients.get(name)
    if (existing) {
      await existing.stop()
      this.clients.delete(name)
    }
    const client = new McpStdioClient(normalized)
    this.clients.set(name, client)
    if (normalized.enabled) {
      try {
        await client.start()
      } catch (e) {
        // 保留客户端以暴露失败状态，但不抛出（配置已保存，用户可修正后重启）
        return { ...client.status, lastError: e instanceof Error ? e.message : String(e) }
      }
    }
    return client.status
  }

  /** 移除服务器（停止进程并删除配置） */
  async removeServer(name: string): Promise<{ ok: boolean }> {
    this.load()
    const client = this.clients.get(name)
    if (client) {
      await client.stop()
      this.clients.delete(name)
    }
    const before = this.configs.length
    this.configs = this.configs.filter((c) => c.name !== name)
    if (this.configs.length !== before) this.persist()
    return { ok: true }
  }

  /** 列出所有服务器及其运行状态 */
  async listServers(): Promise<{ configPath: string; servers: McpServerStatus[] }> {
    this.load()
    const servers: McpServerStatus[] = []
    for (const cfg of this.configs) {
      let client = this.clients.get(cfg.name)
      if (!client) {
        client = new McpStdioClient(cfg)
        this.clients.set(cfg.name, client)
      }
      // 未启动但启用的服务器：尝试懒启动（失败也返回状态而不是抛错）
      if (cfg.enabled && client.status.state === 'stopped') {
        try {
          await client.start()
        } catch {
          /* 状态里已含 lastError */
        }
      }
      servers.push(client.status)
    }
    return { configPath: this.configPath(), servers }
  }

  /** 调用某个服务器上的工具 */
  async callTool(server: string, tool: string, args: unknown): Promise<unknown> {
    this.load()
    const cfg = this.configs.find((c) => c.name === server)
    if (!cfg) {
      throw new Error(
        `未找到名为「${server}」的 MCP 服务器。已配置：${this.configs.map((c) => c.name).join('、') || '（无）'}`
      )
    }
    let client = this.clients.get(server)
    if (!client) {
      client = new McpStdioClient(cfg)
      this.clients.set(server, client)
    }
    if (client.status.state !== 'ready') {
      await client.start().catch((e) => {
        throw new Error(
          `MCP 服务器「${server}」不可用：${e instanceof Error ? e.message : String(e)}`
        )
      })
    }
    const known = client.status.tools.some((t) => t.name === tool)
    if (!known) {
      throw new Error(
        `MCP 服务器「${server}」上没有名为「${tool}」的工具。可用工具：${client.status.tools
          .map((t) => t.name)
          .join('、') || '（无）'}`
      )
    }
    return client.callTool(tool, args)
  }

  /** 启动所有 autoStart 的服务器（边车启动时调用；失败只记状态不阻塞） */
  async startAutoServers(): Promise<McpServerStatus[]> {
    this.load()
    const out: McpServerStatus[] = []
    for (const cfg of this.configs) {
      if (!cfg.enabled || cfg.autoStart === false) continue
      let client = this.clients.get(cfg.name)
      if (!client) {
        client = new McpStdioClient(cfg)
        this.clients.set(cfg.name, client)
      }
      try {
        await client.start()
      } catch {
        /* 状态里已含 lastError */
      }
      out.push(client.status)
    }
    return out
  }

  /** 关闭所有服务器（边车退出时调用） */
  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.stop().catch(() => {
        /* 忽略关闭错误 */
      })
    }
    this.clients.clear()
  }

  /** 测试/自检：直接注入一个已构造的客户端 */
  useClient(client: McpStdioClient, config: McpServerConfig): void {
    this.load()
    this.configs = [...this.configs.filter((c) => c.name !== config.name), config]
    this.clients.set(config.name, client)
  }

  invalidate(): void {
    this.loaded = false
    this.configs = []
  }
}
