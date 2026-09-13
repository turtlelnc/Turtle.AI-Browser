/**
 * RPC 方法注册（全部方法的中文说明与实现）。
 *
 * 命名空间：
 * - `service.*`　　边车自身状态与运维
 * - `store.*`　　　设置与密钥
 * - `bookmarks.*` / `history.*` / `downloads.*`　本地数据
 * - `ai.*`　　　　 模型对话、智能体、MCP、OAuth
 * - `ai.modes.*`　 本地办公模式 / 本地开发模式
 * - `security.*`　 URL 扫描、保护档位、下载闸门、扩展审查
 * - `automation.*` 本地自动化 API 的开关与桥接
 * - `accounts.*`　 账户与同步
 *
 * 全部错误消息为中文；`RpcError` 的 code 为英文常量（机器可读）。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { RpcServer } from './server.js'
import { RpcError, type RpcContext } from './server.js'
import type { ServiceEventName } from '../shared/constants.js'
import { APP_BUILD, APP_VERSION } from '../shared/constants.js'
import { bookmarks } from '../store/bookmarks.js'
import { history } from '../store/history.js'
import { downloads } from '../store/downloads.js'
import { store } from '../store/store.js'
import { userDataDir } from '../paths.js'
import { invalidateStoreCaches } from '../store/index.js'
import type { McpRegistry } from '../ai/mcp.js'
import type { HttpToolExecutor } from '../ai/executor.js'
import { validateAiConfig } from '../ai/client.js'
import { runAgent } from '../ai/agent.js'
import { DEFAULT_BROWSER_TIMEOUT_MS } from '../ai/constants.js'
import { OfficeMode, OFFICE_CAPABILITIES } from '../ai/modes/office.js'
import { DevMode, DEV_CAPABILITIES } from '../ai/modes/dev.js'
import { Workspace } from '../ai/modes/workspace.js'
import { coerceSettingValue, getToolsForLevel, type LocalToolHost, type ToolContext } from '../ai/tools.js'
import {
  PROTECTION_PROFILES,
  availableCapabilities,
  blocklistStats,
  checkReputation,
  gateDownload,
  gateDownloadForLevel,
  isProtectionLevel,
  reviewExtension,
  scanUrl,
  unavailableCapabilities,
  loadRuntimeBlocklists
} from '../security/index.js'
import { nativeBridge } from '../automation/http-api.js'
import { AUTOMATION_ACTIONS } from '../automation/actions.js'
import { exportProfile, importProfile, peekProfile } from '../sync/profile.js'
import type { AccountService, AccountProvider } from '../sync/accounts.js'
import {
  buildAuthorizeUrl,
  ensureFreshTokens,
  loadTokens,
  saveTokens,
  startLoopbackFlow
} from '../ai/oauth.js'
import { PROVIDERS, getProvider } from '../ai/providers.js'
import type {
  AiMessage,
  AppearanceConfig,
  CliPermissionLevel,
  SecurityConfig,
  ServiceSettings,
  ThemeMode
} from '../shared/types.js'

export interface MethodDeps {
  log: (message: string) => void
  accounts: AccountService
  mcp: McpRegistry
  executor: HttpToolExecutor
  secretBackend: () => { mode: string; insecure: boolean; note: string }
  reloadBridge: () => { baseUrl: string; token: string }
  emit: (event: ServiceEventName, payload: unknown) => void
}

/** 把任意输入转成字符串（RPC 参数来自 JSON，类型不可信） */
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v)
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** 边车本地能力宿主（工具的本地实现入口） */
function makeHost(): LocalToolHost & {
  removeHistory: (id: string) => unknown
  clearDownloads: () => unknown
  resetSettings: () => unknown
} {
  return {
    getSettings: () => store.getSettings(),
    updateSetting: (key, value) => applySetting(key, value),
    listBookmarks: () => bookmarks.list(),
    addBookmark: (title, url) => bookmarks.add(title, url),
    removeBookmark: (id) => ({ ok: bookmarks.remove(id) }),
    listHistory: (limit) => history.list(limit),
    clearHistory: () => {
      history.clear()
      return { ok: true }
    },
    listDownloads: (limit) => downloads.list(limit),
    getSecurityReport: () => ({
      level: store.getProtectionLevel(),
      label: PROTECTION_PROFILES[store.getProtectionLevel()].label,
      settings: store.getSecurity(),
      blocklists: blocklistStats(),
      reputationEndpointConfigured: Boolean(store.getReputationEndpoint())
    }),
    getProtectionCapabilities: () => ({
      available: availableCapabilities(store.getProtectionLevel()),
      unavailable: unavailableCapabilities(store.getProtectionLevel())
    }),
    removeHistory: (id) => ({ ok: history.remove(id) }),
    clearDownloads: () => {
      downloads.clear()
      return { ok: true }
    },
    resetSettings: () => store.setSettings(structuredClone(serviceDefaults()))
  }
}

/** 默认设置（不含密钥） */
function serviceDefaults(): Partial<ServiceSettings> {
  return {
    searchEngine: 'bing',
    homepage: 'https://www.bing.com',
    security: {
      safeBrowsing: true,
      httpsUpgrade: true,
      adBlock: true,
      trackerBlock: true,
      blockSuspiciousDownloads: true
    },
    appearance: {
      frostedGlass: true,
      theme: 'system',
      bookmarkBarVisible: true,
      showHomeButton: true
    },
    protectionLevel: 'standard'
  }
}

/** 单个设置项写入（工具与 RPC 共用） */
function applySetting(key: string, value: unknown): unknown {
  switch (key) {
    case 'searchEngine':
      return store.setSettings({ searchEngine: coerceSettingValue(key, value) as never })
    case 'homepage':
      return store.setSettings({ homepage: str(value) })
    case 'theme':
      return store.setSettings({
        appearance: { ...store.getAppearance(), theme: str(value) as ThemeMode }
      })
    case 'frostedGlass':
    case 'bookmarkBarVisible':
    case 'showHomeButton': {
      const appearance: AppearanceConfig = {
        ...store.getAppearance(),
        [key]: coerceSettingValue(key, value) as boolean
      }
      return store.setSettings({ appearance })
    }
    case 'safeBrowsing':
    case 'httpsUpgrade':
    case 'adBlock':
    case 'trackerBlock':
    case 'blockSuspiciousDownloads': {
      const security: SecurityConfig = {
        ...store.getSecurity(),
        [key]: coerceSettingValue(key, value) as boolean
      }
      return store.setSettings({ security })
    }
    case 'protectionLevel': {
      const level = str(value)
      if (!isProtectionLevel(level)) {
        throw new RpcError('bad-param', `无效的保护档位「${level}」，只能是 enhanced / standard / none。`)
      }
      return store.setProtectionLevel(level)
    }
    default:
      throw new RpcError('unknown-setting', `未知设置项：${key}`)
  }
}

/** 构造一次智能体运行所需的上下文 */
function makeToolContext(executor: HttpToolExecutor, mcp: McpRegistry, requestId: string): ToolContext {
  const cfg = store.getWorkspace()
  const workspace = cfg.root ? new Workspace({ root: cfg.root, allowCommands: cfg.allowCommands, dryRun: cfg.dryRun }) : null
  return { executor, host: makeHost(), workspace, mcp, requestId }
}

/** 注册全部 RPC 方法 */
export function registerAllMethods(rpc: RpcServer, deps: MethodDeps): void {
  const { accounts, mcp, executor } = deps
  const emit = deps.emit

  // ================= 服务自身 =================
  rpc.register('service.ping', '健康检查，返回版本与时间戳', () => ({
    pong: true,
    version: APP_VERSION,
    build: APP_BUILD,
    ts: Date.now()
  }))

  rpc.register('service.status', '边车运行状态（端口、密钥后端、黑名单、MCP、自动化、账户）', async () =>
    buildStatus(deps)
  )

  rpc.register('service.capabilities', '返回能力清单，以及当前平台**不可用**能力的中文原因', () => {
    const level = store.getProtectionLevel()
    return {
      capabilities: [
        'store',
        'bookmarks',
        'history',
        'downloads',
        'ai:chat',
        'ai:agent',
        'ai:mcp',
        'ai:oauth',
        'ai:modes',
        'automation:http',
        'automation:ws',
        'sync:profile',
        'sync:local-folder'
      ],
      nativeBridgeConnected: executor.available,
      secretBackend: deps.secretBackend(),
      protection: {
        level,
        available: availableCapabilities(level).map((c) => c.id),
        unavailable: unavailableCapabilities(level).map((c) => ({
          id: c.id,
          name: c.name,
          availability: c.availability,
          limitation: c.limitation ?? ''
        }))
      },
      /** 明确声明本地无法实现、需要云服务的能力 */
      notAvailableLocally: [
        'Google Safe Browsing / 微软 SmartScreen 云端实时威胁库比对',
        '混淆 URL 片段与页面内容向云端上报',
        '登录后跨服务账号级保护',
        '真实 Microsoft / Google 云同步（需用户自备 OAuth client_id）',
        '语音转写（本地无 ASR 模型）',
        'PDF / Word 二进制文档解析（边车不内置解析库）',
        '生成 .pptx 演示文件'
      ]
    }
  })

  rpc.register('service.events', '返回 SSE 事件名清单（与 ARCHITECTURE.md §3.2 一致）', () => ({
    endpoint: '/events?token=<token>',
    events: [
      'aiChunk',
      'aiDone',
      'aiError',
      'aiTool',
      'securityEvent',
      'accountsChanged',
      'appsChanged',
      'extensionsChanged'
    ],
    heartbeatSeconds: 15
  }))

  rpc.register('service.emit', '内部使用：向 SSE 客户端广播一个事件（供原生转发）', (p) => {
    const event = str(p['event']) as ServiceEventName
    const allowed: ServiceEventName[] = [
      'aiChunk',
      'aiDone',
      'aiError',
      'aiTool',
      'securityEvent',
      'accountsChanged',
      'appsChanged',
      'extensionsChanged'
    ]
    if (!allowed.includes(event)) {
      throw new RpcError('bad-param', `不允许广播的事件名：${event}`)
    }
    emit(event, p['payload'] ?? null)
    return { ok: true }
  })

  rpc.register('service.shutdown', '请求边车优雅退出（原生关闭时调用）', () => {
    setTimeout(() => {
      void shutdownHook?.()
    }, 30).unref?.()
    return { ok: true, message: '边车将在 30 毫秒后退出。' }
  })

  // ================= 设置与密钥 =================
  rpc.register('store.getSettings', '读取设置（API Key 只返回掩码 ••••••••）', () => store.getSettings())

  rpc.register('store.setSettings', '写入设置（传入的 apiKey 会被忽略，密钥请用 store.setApiKey）', (p) => {
    const patch = obj(p['patch'] ?? p)
    const updated = store.setSettings(patch as Partial<ServiceSettings>)
    if (patch['workspace'] || patch['syncFolder'] || patch['automation']) onSettingsChanged?.(deps)
    return updated
  })

  rpc.register('store.setApiKey', '保存或清除 API Key（DPAPI 加密写入 secrets.json，绝不落盘明文）', async (p) => {
    const key = str(p['key'] ?? p['apiKey'] ?? p['value'])
    const backend = await store.setApiKey(key)
    return {
      ok: true,
      hasApiKey: store.hasApiKey(),
      insecure: backend.insecure,
      note: backend.note
    }
  })

  rpc.register('store.hasApiKey', '查询是否已设置 API Key（不返回值）', () => ({
    hasApiKey: store.hasApiKey()
  }))

  rpc.register('store.secretBackend', '查询密钥加密后端（dpapi / weak）与安全说明', () => deps.secretBackend())

  rpc.register('store.setProtectionLevel', '设置安全浏览档位（enhanced / standard / none）', (p) => {
    const level = str(p['level'])
    if (!isProtectionLevel(level)) {
      throw new RpcError('bad-param', `无效的保护档位「${level}」，只能是 enhanced / standard / none。`)
    }
    const settings = store.setProtectionLevel(level)
    emit('securityEvent', { level, action: 'protection-level-changed' })
    return settings
  })

  // ================= 书签 / 历史 / 下载 =================
  rpc.register('bookmarks.list', '列出全部书签（按创建时间升序）', () => ({ bookmarks: bookmarks.list() }))

  rpc.register('bookmarks.add', '添加书签', (p) => {
    const url = str(p['url'])
    if (!url) throw new RpcError('bad-param', '缺少必填参数 url。')
    return { bookmark: bookmarks.add(str(p['title']), url, str(p['folder']) || undefined) }
  })

  rpc.register('bookmarks.remove', '删除书签（按 id）', (p) => {
    const id = str(p['id'])
    if (!id) throw new RpcError('bad-param', '缺少必填参数 id。')
    const removed = bookmarks.remove(id)
    if (!removed) throw new RpcError('not-found', `未找到 id 为 ${id} 的书签。`, 404)
    return { ok: true }
  })

  rpc.register('bookmarks.toggle', '切换书签状态（返回切换后是否已收藏）', (p) => {
    const url = str(p['url'])
    if (!url) throw new RpcError('bad-param', '缺少必填参数 url。')
    return { bookmarked: bookmarks.toggle(str(p['title']), url) }
  })

  rpc.register('history.list', '列出浏览历史（默认 500 条，可按关键词过滤）', (p) => {
    const q = str(p['query'])
    const limit = num(p['limit'], 500)
    return { history: q ? history.search(q, limit) : history.list(limit), total: history.count() }
  })

  rpc.register('history.add', '记录一条历史（原生导航完成后调用）', (p) => {
    const url = str(p['url'])
    if (!url) throw new RpcError('bad-param', '缺少必填参数 url。')
    return { item: history.add(str(p['title']), url, num(p['visitedAt'], Date.now())) }
  })

  rpc.register('history.remove', '删除单条历史（按 id）', (p) => {
    const id = str(p['id'])
    if (!id) throw new RpcError('bad-param', '缺少必填参数 id。')
    return { ok: history.remove(id) }
  })

  rpc.register('history.clear', '清空全部浏览历史（危险操作，需用户确认）', () => {
    history.clear()
    return { ok: true }
  })

  rpc.register('downloads.list', '列出下载记录（默认 200 条，按时间倒序去重）', (p) => ({
    downloads: downloads.list(num(p['limit'], 200))
  }))

  rpc.register('downloads.record', '记录或更新一条下载（原生下载进度/完成时调用）', (p) => {
    const filename = str(p['filename'])
    const url = str(p['url'])
    if (!filename && !url) throw new RpcError('bad-param', '至少需要 filename 或 url 之一。')
    const item = downloads.record({
      ...(p['id'] ? { id: str(p['id']) } : {}),
      filename: filename || url,
      url,
      ...(p['savePath'] !== undefined ? { savePath: str(p['savePath']) } : {}),
      ...(p['receivedBytes'] !== undefined ? { receivedBytes: num(p['receivedBytes'], 0) } : {}),
      ...(p['totalBytes'] !== undefined ? { totalBytes: num(p['totalBytes'], 0) } : {}),
      ...(p['state'] !== undefined ? { state: str(p['state']) as never } : {}),
      ...(p['mimeType'] !== undefined ? { mimeType: str(p['mimeType']) } : {})
    })
    return { download: item }
  })

  rpc.register('downloads.remove', '删除一条下载记录（不影响已下载的文件）', (p) => {
    const id = str(p['id'])
    if (!id) throw new RpcError('bad-param', '缺少必填参数 id。')
    return { ok: downloads.remove(id) }
  })

  // ================= AI：对话与智能体 =================
  rpc.register('ai.providers', '列出内置服务商预设（baseUrl / 默认模型 / 是否需要自备 client_id）', () =>
    PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      models: p.models,
      apiKeyUrl: p.apiKeyUrl,
      note: p.note ?? '',
      supportsTools: p.supportsTools,
      oauthSupported: Boolean(p.oauth),
      oauthRequiresOwnClientId: p.oauth?.clientIdRequired ?? false
    }))
  )

  rpc.register('ai.stream', '发起一次流式对话：增量通过 SSE 的 aiChunk/aiDone/aiError 事件推送', (p, ctx) => {
    const requestId = str(p['requestId']) || randomUUID()
    const rawMessages = Array.isArray(p['messages']) ? (p['messages'] as unknown[]) : []
    const messages: AiMessage[] = rawMessages
      .map((m) => obj(m))
      .filter((m) => m['role'] === 'system' || m['role'] === 'user' || m['role'] === 'assistant')
      .map((m) => ({ role: m['role'] as AiMessage['role'], content: str(m['content']) }))
    if (!messages.length) throw new RpcError('bad-param', 'messages 不能为空。')
    return startStream(requestId, messages, deps, ctx)
  })

  rpc.register('ai.abort', '取消一个正在进行的流式请求（按 requestId）', (p) => {
    const requestId = str(p['requestId'])
    const controller = activeStreams.get(requestId)
    if (!controller) return { ok: false, message: `没有正在进行的请求：${requestId}` }
    controller.abort()
    activeStreams.delete(requestId)
    return { ok: true }
  })

  rpc.register(
    'ai.agent',
    '运行一次 AI 智能体（最多 8 轮工具调用）；工具执行回调原生浏览器',
    async (p, ctx) => {
      const requestId = str(p['requestId']) || randomUUID()
      const userMessage = str(p['message'] ?? p['userMessage'])
      if (!userMessage) throw new RpcError('bad-param', '缺少必填参数 message。')
      const level = (str(p['permission'], store.getSettings().ai.cliPermission) || 'daily') as CliPermissionLevel
      const cfg = store.getAi()
      const missing = validateAiConfig({ ...cfg, apiKey: store.getApiKey() })
      if (missing) throw new RpcError('ai-not-configured', missing)
      const controller = new AbortController()
      activeStreams.set(requestId, controller)
      try {
        const result = await runAgent({
          config: { ...cfg, apiKey: store.getApiKey() },
          level,
          history: Array.isArray(p['history']) ? (p['history'] as never[]) : [],
          userMessage,
          ctx: makeToolContext(executor, mcp, requestId),
          signal: controller.signal,
          handlers: {
            onContent: (text) => ctx.emit('aiChunk', { requestId, delta: text }),
            onTool: (name, detail) => ctx.emit('aiTool', { requestId, name, detail, phase: 'start' }),
            onToolDone: (name, detail, phase) =>
              ctx.emit('aiTool', { requestId, name, detail, phase: phase === 'done' ? 'done' : 'error' }),
            onError: (message) => ctx.emit('aiError', { requestId, message })
          }
        })
        if (result.ok) ctx.emit('aiDone', { requestId, content: result.content })
        return { requestId, ...result }
      } finally {
        activeStreams.delete(requestId)
      }
    }
  )

  // ================= AI：MCP =================
  rpc.register('ai.mcp.addServer', '添加（或覆盖）一个 MCP 服务器并立即尝试启动（stdio 传输）', async (p) => {
    const status = await mcp.addServer({
      name: str(p['name']),
      command: str(p['command']),
      args: Array.isArray(p['args']) ? (p['args'] as unknown[]).map((a) => str(a)) : [],
      ...(p['env'] && typeof p['env'] === 'object' ? { env: p['env'] as Record<string, string> } : {}),
      ...(p['cwd'] ? { cwd: str(p['cwd']) } : {}),
      ...(p['enabled'] !== undefined ? { enabled: Boolean(p['enabled']) } : {}),
      ...(p['autoStart'] !== undefined ? { autoStart: Boolean(p['autoStart']) } : {})
    })
    return { server: status }
  })

  rpc.register('ai.mcp.listServers', '列出 MCP 服务器及其状态（含已发现的工具）', async () => {
    const { configPath, servers } = await mcp.listServers()
    return { configPath, servers }
  })

  rpc.register('ai.mcp.removeServer', '移除一个 MCP 服务器（停止进程并删除配置）', async (p) => {
    const name = str(p['name'])
    if (!name) throw new RpcError('bad-param', '缺少必填参数 name。')
    return mcp.removeServer(name)
  })

  rpc.register('ai.mcp.callTool', '调用 MCP 服务器上的工具', async (p) => {
    const server = str(p['server'])
    const tool = str(p['tool'])
    if (!server || !tool) throw new RpcError('bad-param', '缺少必填参数 server 或 tool。')
    const params = p['params'] ?? p['args'] ?? {}
    try {
      return { result: await mcp.callTool(server, tool, params) }
    } catch (e) {
      throw new RpcError('mcp-error', e instanceof Error ? e.message : String(e), 502)
    }
  })

  // ================= AI：OAuth =================
  rpc.register(
    'ai.oauth.start',
    '开始 OAuth 2.0 PKCE 回环授权：返回授权地址与回调地址（需用户自备 client_id）',
    async (p) => {
      const providerId = str(p['provider'], 'custom')
      const preset = getProvider(providerId)
      const authorizeUrl = str(p['authorizeUrl']) || preset?.oauth?.authorizeUrl || ''
      const tokenUrl = str(p['tokenUrl']) || preset?.oauth?.tokenUrl || ''
      const clientId = str(p['clientId'])
      const scopes = Array.isArray(p['scopes'])
        ? (p['scopes'] as unknown[]).map((s) => str(s))
        : (preset?.oauth?.scopes ?? [])
      const flow = await startLoopbackFlow({
        authorizeUrl,
        tokenUrl,
        clientId,
        scopes,
        ...(str(p['clientSecret']) ? { clientSecret: str(p['clientSecret']) } : {}),
        ...(p['loopbackPort'] !== undefined ? { loopbackPort: num(p['loopbackPort'], 0) } : {})
      })
      // 后台等待回调，拿到令牌后加密写入 secrets.json
      void flow.waitForTokens
        .then(async (tokens) => {
          const saved = await saveTokens(providerId, tokens)
          await accounts.signIn(providerId as AccountProvider, str(p['displayName']))
          emit('accountsChanged', { provider: providerId, signedIn: true, insecure: saved.insecure })
        })
        .catch((e: unknown) => {
          deps.log(`[oauth] ${providerId} 授权未完成：${e instanceof Error ? e.message : String(e)}`)
        })
      return {
        providerId,
        authorizeUrl: flow.authorizeUrl,
        redirectUri: flow.redirectUri,
        note: '请在浏览器中打开 authorizeUrl 完成授权；回调后令牌会加密写入 secrets.json。本流程不校验也没有内置任何第三方 client_id。'
      }
    }
  )

  rpc.register('ai.oauth.status', '查询某服务商的 OAuth 令牌状态（不返回令牌本身）', async (p) => {
    const providerId = str(p['provider'], 'custom')
    const tokens = await loadTokens(providerId)
    return {
      providerId,
      signedIn: Boolean(tokens?.accessToken),
      expiresAt: tokens?.expiresAt ?? 0,
      expired: tokens ? Boolean(tokens.expiresAt && Date.now() >= tokens.expiresAt) : false,
      scope: tokens?.scope ?? ''
    }
  })

  rpc.register('ai.oauth.refresh', '刷新 OAuth 令牌', async (p) => {
    const providerId = str(p['provider'], 'custom')
    const preset = getProvider(providerId)
    const tokenUrl = str(p['tokenUrl']) || preset?.oauth?.tokenUrl || ''
    const tokens = await ensureFreshTokens(
      providerId,
      {
        authorizeUrl: str(p['authorizeUrl']) || preset?.oauth?.authorizeUrl || '',
        tokenUrl,
        clientId: str(p['clientId']),
        scopes: []
      }
    )
    return { ok: Boolean(tokens), expiresAt: tokens?.expiresAt ?? 0 }
  })

  rpc.register('ai.oauth.signOut', '删除某服务商的 OAuth 令牌', async (p) => {
    const providerId = str(p['provider'], 'custom')
    return accounts.signOut(providerId as AccountProvider)
  })

  rpc.register('ai.oauth.buildUrl', '仅生成授权 URL（不启动回环监听，便于自定义回调）', (p) => {
    const preset = getProvider(str(p['provider'], 'custom'))
    const url = buildAuthorizeUrl(
      {
        authorizeUrl: str(p['authorizeUrl']) || preset?.oauth?.authorizeUrl || '',
        tokenUrl: str(p['tokenUrl']) || preset?.oauth?.tokenUrl || '',
        clientId: str(p['clientId']),
        scopes: Array.isArray(p['scopes']) ? (p['scopes'] as unknown[]).map((s) => str(s)) : []
      },
      {
        redirectUri: str(p['redirectUri']),
        state: str(p['state']) || randomUUID().replace(/-/g, ''),
        codeChallenge: str(p['codeChallenge'])
      }
    )
    return { authorizeUrl: url }
  })

  // ================= AI：模式 =================
  rpc.register('ai.modes.list', '列出本地办公模式与本地开发模式的全部能力及其边界说明', () => ({
    office: OFFICE_CAPABILITIES,
    dev: DEV_CAPABILITIES
  }))

  rpc.register('ai.modes.office', '执行一项本地办公能力（文档摘要/表格处理/邮件草拟/会议纪要/日程整理/演示大纲）', async (p) => {
    const mode = new OfficeMode(officeDeps(deps))
    return mode.run({
      capability: str(p['capability']) as never,
      input: str(p['input']),
      ...(p['instruction'] !== undefined ? { instruction: str(p['instruction']) } : {}),
      ...(p['options'] && typeof p['options'] === 'object'
        ? { options: p['options'] as Record<string, unknown> }
        : {})
    })
  })

  rpc.register('ai.modes.dev', '执行一项本地开发能力（读/写文件、运行命令、跑测试、生成补丁、解释报错）', async (p) => {
    const mode = new DevMode(devDeps(deps))
    return mode.run({
      action: str(p['action']) as never,
      ...(p['path'] !== undefined ? { path: str(p['path']) } : {}),
      ...(p['content'] !== undefined ? { content: str(p['content']) } : {}),
      ...(p['command'] !== undefined ? { command: str(p['command']) } : {}),
      ...(p['cwd'] !== undefined ? { cwd: str(p['cwd']) } : {}),
      ...(p['errorText'] !== undefined ? { errorText: str(p['errorText']) } : {}),
      ...(p['instruction'] !== undefined ? { instruction: str(p['instruction']) } : {}),
      ...(p['options'] && typeof p['options'] === 'object'
        ? { options: p['options'] as Record<string, unknown> }
        : {})
    })
  })

  rpc.register('ai.modes.devStatus', '查看本地开发模式沙箱状态（工作区根目录、演练模式、命令白名单）', () => {
    const mode = new DevMode(devDeps(deps))
    return mode.status()
  })

  // ================= 安全 =================
  rpc.register('security.scanUrl', '扫描一个 URL（本地启发式，含 turtlelnc 白名单豁免）', (p) => {
    const url = str(p['url'])
    if (!url) throw new RpcError('bad-param', '缺少必填参数 url。')
    const result = scanUrl(url)
    return {
      ...result,
      /** 当前档位下是否真的会拦截 */
      willBlock: result.blocked && store.getProtectionLevel() !== 'none',
      level: store.getProtectionLevel()
    }
  })

  rpc.register('security.checkReputation', '查询用户自建的信誉端点（未配置时返回未查询及原因）', async (p) => {
    const url = str(p['url'])
    if (!url) throw new RpcError('bad-param', '缺少必填参数 url。')
    return checkReputation(url, {
      endpoint: str(p['endpoint']) || store.getReputationEndpoint(),
      ...(p['timeoutMs'] !== undefined ? { timeoutMs: num(p['timeoutMs'], 3000) } : {})
    })
  })

  rpc.register('security.level', '读取当前保护档位与完整能力矩阵', () => ({
    level: store.getProtectionLevel(),
    profile: PROTECTION_PROFILES[store.getProtectionLevel()]
  }))

  rpc.register('security.capabilityMatrix', '读取三档保护的完整能力矩阵（含本地不可用能力的原因）', () => ({
    profiles: PROTECTION_PROFILES,
    note: '标记为 cloud-only 的能力必须使用 Google / 微软云服务，本地边车无法提供，也不会假装启用。'
  }))

  rpc.register('security.downloadVerdict', '对一次下载给出放行/警告/阻断结论（安装包警告但可保留）', (p) => {
    const verdict = gateDownload({
      ...(p['url'] !== undefined ? { url: str(p['url']) } : {}),
      ...(p['filename'] !== undefined ? { filename: str(p['filename']) } : {}),
      ...(p['filePath'] !== undefined ? { filePath: str(p['filePath']) } : {}),
      ...(p['mimeType'] !== undefined ? { mimeType: str(p['mimeType']) } : {}),
      ...(p['signerName'] !== undefined ? { signerName: str(p['signerName']) } : {})
    })
    return { ...verdict, level: store.getProtectionLevel() }
  })

  rpc.register('security.downloadVerdictForLevel', '按指定保护档位给出下载结论（档位可覆盖）', (p) => {
    const level = str(p['level'], store.getProtectionLevel())
    if (!isProtectionLevel(level)) {
      throw new RpcError('bad-param', `无效的保护档位「${level}」。`)
    }
    return gateDownloadForLevel(level, {
      ...(p['url'] !== undefined ? { url: str(p['url']) } : {}),
      ...(p['filename'] !== undefined ? { filename: str(p['filename']) } : {}),
      ...(p['filePath'] !== undefined ? { filePath: str(p['filePath']) } : {})
    })
  })

  rpc.register('security.reviewExtension', '静态审查一个已解包的扩展目录，输出中文风险清单', (p) => {
    const dir = str(p['path'])
    if (!dir) throw new RpcError('bad-param', '缺少必填参数 path（扩展目录绝对路径）。')
    try {
      return reviewExtension(dir)
    } catch (e) {
      throw new RpcError('extension-review-failed', e instanceof Error ? e.message : String(e), 400)
    }
  })

  rpc.register('security.blocklists', '查看本地黑名单统计，并可重新加载运行时黑名单', (p) => {
    if (p['reload']) {
      const dir = str(p['dir'], join(process.cwd(), 'resources', 'blocklists'))
      loadRuntimeBlocklists(dir)
    }
    return blocklistStats()
  })

  // ================= 自动化 =================
  rpc.register('automation.info', '读取自动化接口信息（开关、地址、发现文件路径）', () => ({
    enabled: store.getAutomation().enabled,
    baseUrl: `http://127.0.0.1:${rpc.port}/automation`,
    wsUrl: `ws://127.0.0.1:${rpc.port}/automation-ws`,
    discoveryFile: join(userDataDir(), 'automation.json'),
    docs: 'docs/AUTOMATION.md',
    /** token 需要鉴权接口才返回，避免被无意记录到日志 */
    tokenHint: 'token 与 RPC 相同，见 <userData>/automation.json 或握手文件 service.json'
  }))

  rpc.register('automation.setEnabled', '开启或关闭本地自动化 API（默认关闭）', (p) => {
    const enabled = Boolean(p['enabled'])
    const settings = store.setSettings({ automation: { enabled } })
    onSettingsChanged?.(deps)
    return {
      enabled,
      settings,
      message: enabled
        ? '本地自动化 API 已开启。发现文件已更新（含 token），请勿把它暴露给不可信的本机程序。'
        : '本地自动化 API 已关闭，发现文件中的 token 已移除。'
    }
  })

  rpc.register('automation.bridge', '读取或设置原生浏览器自动化端点（baseUrl + token）', (p) => {
    if (p['baseUrl'] !== undefined || p['token'] !== undefined) {
      const saved = nativeBridge.write({
        ...(p['baseUrl'] !== undefined ? { baseUrl: str(p['baseUrl']) } : {}),
        ...(p['token'] !== undefined ? { token: str(p['token']) } : {})
      })
      const applied = deps.reloadBridge()
      return { ok: true, saved, applied, connected: executor.available }
    }
    return { ...nativeBridge.read(), connected: executor.available }
  })

  rpc.register('automation.actions', '列出全部自动化动作（名称、分组、参数、是否高风险）', () => ({
    actions: automationActionList()
  }))

  // ================= 账户与同步 =================
  rpc.register('accounts.list', '列出账户记录（是否已登录、中文备注）', () => ({
    accounts: accounts.listAccounts()
  }))

  rpc.register('accounts.signIn', '标记某服务商已登录（令牌必须已由 ai.oauth.* 写入，否则不会标记成功）', async (p) => {
    const provider = str(p['provider']) as AccountProvider
    if (!provider) throw new RpcError('bad-param', '缺少必填参数 provider。')
    return { account: await accounts.signIn(provider, str(p['displayName'])) }
  })

  rpc.register('accounts.signOut', '登出某服务商（删除令牌，不删除本地数据）', async (p) => {
    const provider = str(p['provider']) as AccountProvider
    if (!provider) throw new RpcError('bad-param', '缺少必填参数 provider。')
    return accounts.signOut(provider)
  })

  rpc.register('accounts.getSyncState', '读取同步状态（后端、上次同步时间、待同步数、冲突）', () =>
    accounts.getSyncState()
  )

  rpc.register('accounts.syncNow', '立即同步（文件级；冲突需指定 keep-local 或 use-remote）', async (p) => {
    const direction = str(p['direction'], 'both') as 'push' | 'pull' | 'both'
    const resolveConflict = str(p['resolveConflict'], 'skip') as 'keep-local' | 'use-remote' | 'skip'
    return accounts.syncNow(direction, resolveConflict)
  })

  rpc.register('accounts.setSyncFolder', '设置同步目录（可指向 OneDrive 等网盘的本地同步文件夹）', (p) => {
    const folder = str(p['folder'])
    const settings = store.setSettings({ syncFolder: folder })
    accounts.reloadBackend()
    return {
      folder,
      settings,
      message: folder
        ? `同步目录已设置为：${folder}。这是**文件级**同步，不做逐条合并。`
        : '已清除同步目录配置。'
    }
  })

  rpc.register('accounts.backendInfo', '查看当前同步后端信息与限制', () => accounts.getBackend().info())

  // ================= 配置迁移 =================
  rpc.register('profile.export', '导出 .tbuser 配置文件（用户数据目录打包，排除缓存）', async (p) => {
    const outputPath = str(p['path'])
    if (!outputPath) throw new RpcError('bad-param', '缺少必填参数 path（导出目标绝对路径）。')
    try {
      const result = await exportProfile({
        userDataDir: userDataDir(),
        outputPath,
        includeSecrets: p['includeSecrets'] === undefined ? true : Boolean(p['includeSecrets'])
      })
      return { ...result, message: `已导出 ${result.sizeBytes} 字节到 ${result.path}` }
    } catch (e) {
      throw new RpcError('export-failed', e instanceof Error ? e.message : String(e), 500)
    }
  })

  rpc.register('profile.import', '导入 .tbuser 配置文件并覆盖用户数据（含 zip slip 防护）', async (p) => {
    const inputPath = str(p['path'])
    if (!inputPath) throw new RpcError('bad-param', '缺少必填参数 path（.tbuser 文件绝对路径）。')
    try {
      const result = await importProfile({
        inputPath,
        userDataDir: userDataDir(),
        includeSecrets: p['includeSecrets'] === undefined ? true : Boolean(p['includeSecrets'])
      })
      invalidateStoreCaches()
      store.init()
      await store.initSecret()
      accounts.reloadBackend()
      return {
        ...result,
        message: `已导入 ${result.files} 个文件。${result.skipped.length ? `跳过 ${result.skipped.length} 个条目。` : ''}`
      }
    } catch (e) {
      throw new RpcError('import-failed', e instanceof Error ? e.message : String(e), 500)
    }
  })

  rpc.register('profile.peek', '查看 .tbuser 文件的清单（不落地任何文件）', (p) => {
    const inputPath = str(p['path'])
    if (!inputPath) throw new RpcError('bad-param', '缺少必填参数 path。')
    try {
      return { manifest: peekProfile(inputPath) }
    } catch (e) {
      throw new RpcError('peek-failed', e instanceof Error ? e.message : String(e), 400)
    }
  })

  // ================= 工具与工作区 =================
  rpc.register('ai.tools', '列出 AI 智能体可用工具（可按档位过滤）', (p) => {
    const level = str(p['permission'], store.getSettings().ai.cliPermission) as CliPermissionLevel
    return { level, tools: toolListFor(level) }
  })

  rpc.register('workspace.status', '查看工作区授权状态（根目录、演练模式、命令白名单）', () => {
    const cfg = store.getWorkspace()
    const ws = new Workspace({ root: cfg.root, allowCommands: cfg.allowCommands, dryRun: cfg.dryRun })
    return {
      root: ws.root,
      available: ws.available,
      dryRun: ws.dryRun,
      allowCommands: ws.allowCommands,
      note: ws.available
        ? '所有文件操作都被限制在该目录内（含符号链接逃逸检查）。'
        : '尚未授权工作区目录：本地办公/开发模式的文件与命令能力不可用。'
    }
  })

  rpc.register('workspace.grant', '授权工作区根目录（本地办公/开发模式的必需前置条件）', (p) => {
    const root = str(p['root'])
    const settings = store.setSettings({
      workspace: {
        ...store.getWorkspace(),
        root,
        ...(Array.isArray(p['allowCommands'])
          ? { allowCommands: (p['allowCommands'] as unknown[]).map((c) => str(c)) }
          : {}),
        ...(p['dryRun'] !== undefined ? { dryRun: Boolean(p['dryRun']) } : {})
      }
    })
    return {
      settings,
      message: root
        ? `已授权工作区目录：${root}`
        : '已撤销工作区授权，本地文件与命令能力已关闭。'
    }
  })
}

// ---------- 流式请求管理 ----------

const activeStreams = new Map<string, AbortController>()

/** 由 index.ts 注入的退出钩子（避免 rpc/methods 依赖 app 生命周期） */
let shutdownHook: (() => Promise<void>) | null = null
/** 设置变更钩子（刷新自动化发现文件 / 同步后端） */
let onSettingsChanged: ((deps: MethodDeps) => void) | null = null

/** 注册生命周期钩子（index.ts 调用） */
export function setLifecycleHooks(hooks: {
  shutdown?: () => Promise<void>
  onSettingsChanged?: (deps: MethodDeps) => void
}): void {
  if (hooks.shutdown) shutdownHook = hooks.shutdown
  if (hooks.onSettingsChanged) onSettingsChanged = hooks.onSettingsChanged
}

function officeDeps(deps: MethodDeps) {
  const cfg = store.getAi()
  return {
    config: { ...cfg, apiKey: store.getApiKey() },
    level: cfg.cliPermission,
    workspace: workspaceOrNull(),
    makeToolContext: () => makeToolContext(deps.executor, deps.mcp, randomUUID()),
    signal: new AbortController().signal
  }
}

function devDeps(deps: MethodDeps) {
  const cfg = store.getAi()
  return {
    config: { ...cfg, apiKey: store.getApiKey() },
    level: cfg.cliPermission,
    workspace: workspaceOrNull(),
    makeToolContext: () => makeToolContext(deps.executor, deps.mcp, randomUUID()),
    signal: new AbortController().signal
  }
}

function workspaceOrNull(): Workspace | null {
  const cfg = store.getWorkspace()
  if (!cfg.root) return null
  return new Workspace({ root: cfg.root, allowCommands: cfg.allowCommands, dryRun: cfg.dryRun })
}

/** 启动一次流式对话（把增量通过 SSE 推给订阅者） */
function startStream(
  requestId: string,
  messages: AiMessage[],
  deps: MethodDeps,
  ctx: RpcContext
): { requestId: string; streaming: true; note: string } {
  const controller = new AbortController()
  activeStreams.set(requestId, controller)
  const cfg = store.getAi()
  const apiKey = store.getApiKey()
  if (!apiKey) {
    activeStreams.delete(requestId)
    throw new RpcError('ai-not-configured', '尚未设置 API Key，请在设置中填写。')
  }
  void (async () => {
    try {
      const { chatStream } = await import('../ai/client.js')
      chatStream(
        { ...cfg, apiKey },
        messages,
        {
          onChunk: (delta) => ctx.emit('aiChunk', { requestId, delta }),
          onDone: (content) => ctx.emit('aiDone', { requestId, content }),
          onError: (message) => ctx.emit('aiError', { requestId, message })
        },
        { signal: controller.signal }
      )
    } catch (e) {
      ctx.emit('aiError', {
        requestId,
        message: e instanceof Error ? e.message : String(e)
      })
    } finally {
      // 流结束后清理（chatStream 内部异步，这里延迟释放）
      setTimeout(() => activeStreams.delete(requestId), 1000).unref?.()
    }
  })()
  deps.log(`[ai] 已启动流式请求 ${requestId}`)
  return {
    requestId,
    streaming: true,
    note: '增量通过 SSE /events 的 aiChunk / aiDone / aiError 事件推送。'
  }
}

/** 组装 service.status 的结果 */
async function buildStatus(deps: MethodDeps): Promise<unknown> {
  const { servers } = await deps.mcp.listServers().catch(() => ({ servers: [] }))
  return {
    running: true,
    version: APP_VERSION,
    build: APP_BUILD,
    userDataDir: userDataDir(),
    secretBackend: deps.secretBackend(),
    blocklists: blocklistStats(),
    protectionLevel: store.getProtectionLevel(),
    nativeBridge: { ...nativeBridge.read(), connected: deps.executor.available },
    mcpServers: servers.map((s) => ({ name: s.name, state: s.state, tools: s.toolCount })),
    automation: { enabled: store.getAutomation().enabled },
    accounts: deps.accounts.listAccounts().length,
    activeStreams: activeStreams.size,
    workspace: store.getWorkspace().root || '(未授权)',
    defaultBrowserTimeoutMs: DEFAULT_BROWSER_TIMEOUT_MS
  }
}

/** 工具清单（按档位过滤） */
function toolListFor(level: CliPermissionLevel): unknown[] {
  return getToolsForLevel(level).map((t) => ({
    name: t.name,
    description: t.description,
    minLevel: t.minLevel,
    layer: t.layer,
    parameters: t.parameters
  }))
}

/** 自动化动作清单 */
function automationActionList(): unknown[] {
  return AUTOMATION_ACTIONS.map((a) => ({
    name: a.name,
    group: a.group,
    tool: a.tool,
    summary: a.summary,
    required: a.required,
    risky: Boolean(a.risky)
  }))
}
