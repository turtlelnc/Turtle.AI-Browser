/**
 * 边车服务容器：把存储、AI、安全、自动化、同步各模块装配成可启动的服务对象，
 * 并统一注册 RPC 方法。
 *
 * 启动顺序（`init()`）：
 * 1. 解析并创建用户数据目录（不可写时回退到临时目录并告警）；
 * 2. 加载设置与加密密钥（探测 DPAPI 后端）；
 * 3. 合并 `resources/blocklists/*.txt` 运行时黑名单；
 * 4. 初始化 MCP 注册表并拉起 autoStart 的服务器；
 * 5. 启动 RPC 服务器（127.0.0.1 + 随机端口 + Bearer token）；
 * 6. 挂载自动化 WebSocket 端点、写握手文件与自动化发现文件。
 *
 * stdout 只输出**一行** JSON 就绪信息（见 `index.ts`），所有日志走 stderr。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { APP_BUILD, APP_VERSION } from './shared/constants.js'
import { initUserDataDir, resolveBlocklistDir, userDataDir, userDataFile } from './paths.js'
import { store } from './store/store.js'
import { bookmarks } from './store/bookmarks.js'
import { history } from './store/history.js'
import { downloads } from './store/downloads.js'
import { invalidateStoreCaches } from './store/index.js'
import { secrets, type SecretBackendStatus } from './store/secrets.js'
import { blocklistStats, initSecurity, PROTECTION_PROFILES, unavailableCapabilities } from './security/index.js'
import { HttpToolExecutor } from './ai/executor.js'
import { McpRegistry } from './ai/mcp.js'
import { Workspace } from './ai/modes/workspace.js'
import { RpcServer } from './rpc/server.js'
import { registerAllMethods } from './rpc/methods.js'
import {
  AutomationWsApi,
  handleAutomationRequest,
  nativeBridge,
  writeAutomationInfo,
  type AutomationDeps,
  type AutomationInfo,
  type NativeBridgeConfig
} from './automation/index.js'
import { AccountService } from './sync/accounts.js'
import { LocalFolderBackend, UnconfiguredBackend } from './sync/backend.js'

/** 服务启动选项 */
export interface ServiceOptions {
  /** 期望端口（0 = 系统分配） */
  port?: number
  /** 从文件读取 token（握手文件） */
  tokenFile?: string
  /** 直接指定 token（自检用，避免读写文件） */
  token?: string
  /** 能效模式（透传给原生用于降级提示） */
  energyMode?: string
  /** 无界面模式（不写自动化发现文件、不自动拉起 MCP） */
  headless?: boolean
  /** 用户数据目录覆盖 */
  userDataDirOverride?: string
  /** 黑名单目录（resources/blocklists） */
  blocklistDir?: string
  /** 日志函数（默认写 stderr） */
  log?: (message: string) => void
  /** 就绪回调（写入 stdout 的唯一一行 JSON 的钩子） */
  onReady?: (info: ReadyInfo) => void
}

/** 就绪信息（写到 stdout 的那一行 JSON） */
export interface ReadyInfo {
  ready: true
  port: number
  version: string
  build: number
  capabilities: string[]
}

export interface ServiceStatus {
  running: boolean
  port: number
  version: string
  build: number
  capabilities: string[]
  userDataDir: string
  secretBackend: SecretBackendStatus
  blocklists: ReturnType<typeof blocklistStats>
  mcpServers: number
  automation: { enabled: boolean; info: AutomationInfo | null; wsClients: number }
  accounts: number
}

/** 边车服务 */
export class TibService {
  readonly rpc: RpcServer
  readonly mcp = new McpRegistry()
  readonly accounts: AccountService
  readonly wsApi: AutomationWsApi
  /** 浏览器工具执行器（转发到原生自动化端点） */
  readonly executor: HttpToolExecutor

  private readonly log: (message: string) => void
  private started = false
  private readyInfo: ReadyInfo | null = null
  private automationInfo: AutomationInfo | null = null
  private secretBackend: SecretBackendStatus = {
    mode: 'weak',
    insecure: true,
    note: '尚未探测密钥后端。'
  }

  constructor(private readonly options: ServiceOptions = {}) {
    this.log = options.log ?? ((m: string) => process.stderr.write(`${m}\n`))
    this.rpc = new RpcServer({
      ...(options.token ? { token: options.token } : {}),
      port: options.port ?? 0,
      capabilities: [],
      log: this.log,
      // 挂载本地自动化 API（/automation/*）：复用同一套 Bearer token 鉴权
      onRequest: (req, res, url, helpers) =>
        handleAutomationRequest(req, res, url, this.automationDeps(), helpers.readBody)
    })
    this.executor = new HttpToolExecutor({
      baseUrl: '',
      timeoutMs: 30_000,
      source: 'agent',
      log: this.log
    })
    this.wsApi = new AutomationWsApi({
      isEnabled: () => store.getAutomation().enabled,
      deps: {
        isEnabled: () => store.getAutomation().enabled,
        executor: this.executor,
        getBridgeConfig: () => nativeBridge.read(),
        version: APP_VERSION,
        log: this.log,
        broadcast: (event, payload) => this.rpc.emit(event as never, payload)
      },
      log: this.log
    })
    this.accounts = new AccountService({
      getSettings: () => store.getSettings(),
      userDataDir: () => userDataDir(),
      emit: (event, payload) => this.rpc.emit(event, payload)
    })
  }

  /** 自动化 HTTP API 的依赖（延迟构造，保证读到最新设置） */
  private automationDeps(): AutomationDeps {
    return {
      isEnabled: () => store.getAutomation().enabled,
      executor: this.executor,
      getBridgeConfig: () => nativeBridge.read(),
      version: APP_VERSION,
      log: this.log,
      broadcast: (event, payload) => this.rpc.emit(event as never, payload)
    }
  }

  /** 当前能力清单 */
  capabilities(): string[] {
    const caps = [
      'store',
      'bookmarks',
      'history',
      'downloads',
      'security:local',
      'ai:chat',
      'ai:agent',
      'ai:mcp',
      'ai:oauth',
      'ai:modes',
      'automation:http',
      'automation:ws',
      'sync:profile',
      'sync:local-folder'
    ]
    if (store.getAutomation().enabled) caps.push('automation:enabled')
    if (this.executor.available) caps.push('native-bridge:connected')
    if (!this.secretBackend.insecure) caps.push('secrets:dpapi')
    else caps.push('secrets:weak')
    return caps
  }

  /** 初始化并启动（幂等） */
  async init(): Promise<ReadyInfo> {
    if (this.started && this.readyInfo) return this.readyInfo

    // 1. 用户数据目录
    if (this.options.userDataDirOverride) {
      process.env['TIB_USER_DATA'] = this.options.userDataDirOverride
    }
    const dir = initUserDataDir(this.options.userDataDirOverride)
    if (!dir.writable) {
      this.log(`[service] 警告：期望的用户数据目录不可写，已回退到 ${dir.dir}`)
    }
    this.log(`[service] 用户数据目录：${dir.dir}`)

    // 2. 设置与密钥
    const initResult = store.init()
    if (initResult.legacyApiKeyIgnored) {
      this.log('[service] 警告：settings.json 中存在残留的 apiKey 字段，已忽略并将在下次写入时清除。')
    }
    this.secretBackend = await store.initSecret()
    this.log(`[service] 密钥后端：${this.secretBackend.mode}${this.secretBackend.insecure ? '（不安全回退）' : ''}`)

    // 3. 黑名单（显式参数 → 环境变量 → 从工作目录/模块目录向上查找 resources/blocklists）
    const blDir = resolveBlocklistDir(this.options.blocklistDir)
    const bl = initSecurity(blDir)
    this.log(
      bl.files > 0
        ? `[service] 黑名单：${blDir} 合并 ${bl.files} 个运行时文件，新增 ${bl.domains} 个域名`
        : `[service] 未找到运行时黑名单目录（已查找 resources/blocklists）：仅使用内置样例列表。`
    )

    // 4. 桥接配置 + MCP
    const bridge = nativeBridge.read()
    if (bridge.baseUrl) {
      this.executor.setBaseUrl(bridge.baseUrl, bridge.token)
      this.log(`[service] 已配置原生自动化端点：${bridge.baseUrl}`)
    } else {
      this.log('[service] 未配置原生自动化端点（native-bridge.json 为空）：浏览器类工具将返回明确错误。')
    }
    if (!this.options.headless) {
      const servers = await this.mcp.startAutoServers()
      if (servers.length) {
        this.log(
          `[service] MCP 服务器：${servers.map((s) => `${s.name}=${s.state}`).join('、')}`
        )
      }
    }

    // 5. RPC
    this.rpc.setCapabilities(this.capabilities())
    registerAllMethods(this.rpc, {
      log: this.log,
      accounts: this.accounts,
      mcp: this.mcp,
      executor: this.executor,
      secretBackend: () => this.secretBackend,
      reloadBridge: () => this.reloadBridge(),
      emit: (event, payload) => this.rpc.emit(event, payload)
    })
    const port = await this.rpc.start()

    // 6. WebSocket + 握手文件 + 发现文件
    const httpServer = this.rpc.httpServer
    if (httpServer) {
      this.wsApi.attach(httpServer, (req, queryToken) => this.rpc.isAuthorized(req, queryToken))
    }
    this.writeHandshakeFile(port)
    if (!this.options.headless) this.refreshAutomationInfo(port)

    this.readyInfo = {
      ready: true,
      port,
      version: APP_VERSION,
      build: APP_BUILD,
      capabilities: this.capabilities()
    }
    this.started = true
    this.options.onReady?.(this.readyInfo)
    return this.readyInfo
  }

  /** 重新读取原生桥接配置（原生重启后端口可能变化） */
  reloadBridge(): NativeBridgeConfig {
    const cfg = nativeBridge.read()
    this.executor.setBaseUrl(cfg.baseUrl, cfg.token)
    return cfg
  }

  /** 设置变更后调用：刷新发现文件、同步后端、能力清单 */
  onSettingsChanged(): void {
    this.accounts.reloadBackend()
    if (!this.options.headless && this.rpc.port) this.refreshAutomationInfo(this.rpc.port)
  }

  /** 写 `<userData>/automation.json` */
  refreshAutomationInfo(port = this.rpc.port): AutomationInfo | null {
    if (!port) return null
    this.automationInfo = writeAutomationInfo({
      enabled: store.getAutomation().enabled,
      port,
      token: this.rpc.token
    })
    return this.automationInfo
  }

  /**
   * 写握手文件 `<userData>/service.json`（ARCHITECTURE.md §4）。
   * 原生启动时生成 token 写该文件；边车启动后回填自己的 port。
   * 这里保留原生写入的 token（若存在且一致则不覆盖），只补充 port/pid/version。
   */
  private writeHandshakeFile(port: number): { path: string; wrote: boolean; note: string } {
    const path = userDataFile('service.json')
    let existing: { token?: string; port?: number; pid?: number } = {}
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, 'utf-8')) as typeof existing
      } catch {
        existing = {}
      }
    }
    const payload = {
      port,
      token: this.rpc.token,
      pid: process.pid,
      version: APP_VERSION,
      build: APP_BUILD,
      updatedAt: Date.now(),
      /** 原生写入的旧 token 与本进程 token 不一致时，说明两侧都要以本文件为准 */
      previousPort: existing.port ?? 0
    }
    try {
      writeFileSync(path, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
      this.log(`[service] 握手文件已写入：${path}`)
      return { path, wrote: true, note: '已写入' }
    } catch (e) {
      const note = `握手文件写入失败：${e instanceof Error ? e.message : String(e)}`
      this.log(`[service] ${note}`)
      return { path, wrote: false, note }
    }
  }

  /** 当前状态（供 RPC service.status 与自检） */
  async status(): Promise<ServiceStatus> {
    const mcp = await this.mcp.listServers().catch(() => ({ configPath: '', servers: [] }))
    return {
      running: this.started,
      port: this.rpc.port,
      version: APP_VERSION,
      build: APP_BUILD,
      capabilities: this.capabilities(),
      userDataDir: userDataDir(),
      secretBackend: this.secretBackend,
      blocklists: blocklistStats(),
      mcpServers: mcp.servers.length,
      automation: {
        enabled: store.getAutomation().enabled,
        info: this.automationInfo,
        wsClients: this.wsApi.clientCount
      },
      accounts: this.accounts.listAccounts().length
    }
  }

  /** 构造一个工作区实例（按当前设置） */
  workspace(): Workspace {
    const cfg = store.getWorkspace()
    return new Workspace({
      root: cfg.root,
      allowCommands: cfg.allowCommands,
      dryRun: cfg.dryRun
    })
  }

  /** 停止服务（关闭 WS、MCP、RPC） */
  async stop(): Promise<void> {
    await this.wsApi.close().catch(() => {
      /* 忽略 */
    })
    await this.mcp.shutdown().catch(() => {
      /* 忽略 */
    })
    await this.rpc.stop().catch(() => {
      /* 忽略 */
    })
    this.started = false
  }
}

/** 供测试/自检：构造一个隔离的服务实例 */
export function createService(options: ServiceOptions = {}): TibService {
  return new TibService(options)
}

/** 供 RPC 使用：把设置里的工作区配置转成 Workspace（带缓存上限保护） */
export function currentWorkspace(): Workspace {
  const cfg = store.getWorkspace()
  return new Workspace({ root: cfg.root, allowCommands: cfg.allowCommands, dryRun: cfg.dryRun })
}

/** 供 RPC 使用：路径工具 */
export const paths = { userDataDir, userDataFile, resolve, dirname }

/** 供 RPC 使用：清空缓存 */
export const caches = { invalidateStoreCaches }

/** 供 RPC 使用：本地集合 */
export const localCollections = { bookmarks, history, downloads, store, secrets }

/** 供 RPC 使用：安全模块 */
export const securityFacade = { PROTECTION_PROFILES, unavailableCapabilities, blocklistStats }

/** 供 RPC 使用：同步后端 */
export const syncBackends = { LocalFolderBackend, UnconfiguredBackend }
