/**
 * 工具执行器抽象。
 *
 * **v1.0.0 的关键变化**：工具**执行**发生在原生浏览器进程（它才拥有标签页/页面），
 * 边车只负责「决策」——模型给出 tool_call，边车做权限校验，然后把动作交给执行器。
 * 因此边车与原生之间的契约是：
 *
 * ```ts
 * interface ToolExecutor {
 *   run(name: string, args: unknown): Promise<unknown>          // 智能体工具调用
 *   action(name: string, params: unknown): Promise<unknown>     // 自动化动作调用（外部工具）
 * }
 * ```
 *
 * 两种调用最终都归一化到**同一套协议动作名**（`PROTOCOL_ACTIONS`），
 * 原生只需要实现这套动作名，不必关心它是由 AI 智能体还是用户自己的 CLI 触发。
 *
 * 本文件提供：
 * - `HttpToolExecutor`：POST 到浏览器本地自动化端点（生产路径）；
 * - `MockToolExecutor`：测试/自检用，可编程返回预设结果并记录调用；
 * - `CompositeToolExecutor`：按名字分流（浏览器工具走原生，本地工具走边车）。
 */

import type { ProtectionLevel } from '../shared/types.js'

/** 统一的工具/动作执行器接口 */
export interface ToolExecutor {
  /** 执行一个智能体工具（工具名 → 协议动作） */
  run(name: string, args: unknown): Promise<unknown>
  /**
   * 执行一个自动化动作（动作名，与 ARCHITECTURE.md §3.1 的 tib.* 对应）。
   * @param source 调用来源，会透传给原生用于审计与权限判断
   */
  action(name: string, params: unknown, source?: 'agent' | 'external'): Promise<unknown>
}

/** 浏览器自动化动作请求（边车 → 原生） */
export interface AutomationActionRequest {
  action: string
  params: Record<string, unknown>
  /** 调用来源：agent（AI 智能体）或 external（用户自己的 AI 工具） */
  source: 'agent' | 'external'
  /** 当前权限档位（原生可据此二次校验） */
  permission?: string
}

/** 执行失败（携带错误码，便于上层区分「未配置」与「网络错误」） */
export class ExecutorError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = 'executor-failed'
  ) {
    super(message)
    this.name = 'ExecutorError'
  }
}

/**
 * 协议动作名（**唯一命名来源**）：边车 → 原生的统一动作集合。
 * 每个动作都能被两类调用方使用：
 * - AI 智能体工具（`tool.ts` 里的 `name`）；
 * - 外部自动化 API（`POST /automation/<action>`）。
 *
 * 命名沿用 ARCHITECTURE.md §3.1 的 `tib.*` 方法名风格，原生侧按这些名字分发。
 */
export const PROTOCOL_ACTIONS = [
  // 导航
  'navigate',
  'newTab',
  'closeTab',
  'activateTab',
  'goBack',
  'goForward',
  'reload',
  'stop',
  'goHome',
  // 读取
  'getTabs',
  'getPageText',
  'getPageInfo',
  'getSelectedText',
  'getDom',
  'extractLinks',
  'extractImages',
  // 交互
  'click',
  'fill',
  'scroll',
  'screenshot',
  'evaluate',
  'findInPage',
  // 界面
  'setOverlay',
  'toggleSidebar',
  'setSidebarWidth',
  'setZoom',
  'setProtectionLevel',
  'setEnergyMode',
  // 状态
  'getState',
  'getSettings',
  'getSecurityReport',
  'getDownloads',
  'getHistory',
  'getBookmarks',
  // 抓包与维护
  'startCapture',
  'stopCapture',
  'getCaptured',
  'clearBrowsingData',
  'closeAllTabs'
] as const

export type ProtocolAction = (typeof PROTOCOL_ACTIONS)[number]

/**
 * 协议动作名 → 边车内部的「工具名」（智能体使用）。
 * 只有在两者不同名时才需要列出；同名动作两者一致。
 *
 * 之所以保留两套名字：工具名是给**大模型**看的（下划线风格、语义直白），
 * 动作名是给**原生代码**看的（驼峰风格、与 `tib.*` 一致）。
 * 这是唯一的转换表，`tools.ts` 与 `automation/actions.ts` 都从这里取映射。
 */
export const ACTION_TO_TOOL: Record<string, string> = {
  newTab: 'open_tab',
  closeTab: 'close_current_tab',
  activateTab: 'switch_tab',
  goBack: 'go_back',
  goForward: 'go_forward',
  reload: 'reload_page',
  stop: 'stop_loading',
  goHome: 'go_home',
  getPageText: 'get_page_text',
  getPageInfo: 'get_page_info',
  getSelectedText: 'get_selected_text',
  getTabs: 'get_tabs',
  getDom: 'get_page_source',
  extractLinks: 'extract_links',
  extractImages: 'extract_images',
  screenshot: 'screenshot',
  evaluate: 'execute_js',
  findInPage: 'find_in_page',
  setOverlay: 'open_settings_page',
  toggleSidebar: 'toggle_sidebar',
  setSidebarWidth: 'set_sidebar_width',
  setZoom: 'set_zoom',
  setProtectionLevel: 'set_protection_level',
  setEnergyMode: 'set_energy_mode',
  getState: 'get_browser_state',
  getSettings: 'get_settings',
  getSecurityReport: 'get_security_report',
  getDownloads: 'get_downloads',
  getHistory: 'get_history',
  getBookmarks: 'get_bookmarks',
  startCapture: 'start_capture',
  stopCapture: 'stop_capture',
  getCaptured: 'get_captured',
  clearBrowsingData: 'clear_browsing_data',
  closeAllTabs: 'close_all_tabs'
}

/** 工具名 → 协议动作名（由 ACTION_TO_TOOL 反向推导 + 同名动作补齐） */
export const TOOL_TO_ACTION: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const action of PROTOCOL_ACTIONS) {
    const tool = ACTION_TO_TOOL[action] ?? action
    map[tool] = action
  }
  return map
})()

/** 取工具对应的协议动作名（无映射返回 null） */
export function mapToolToAction(toolName: string): string | null {
  return TOOL_TO_ACTION[toolName] ?? null
}

/** 取协议动作对应的工具名 */
export function mapActionToTool(actionName: string): string | null {
  if (!(PROTOCOL_ACTIONS as readonly string[]).includes(actionName)) return null
  return ACTION_TO_TOOL[actionName] ?? actionName
}

/** 是否是需要原生执行的协议动作 */
export function isProtocolAction(name: string): name is ProtocolAction {
  return (PROTOCOL_ACTIONS as readonly string[]).includes(name)
}

export interface HttpExecutorOptions {
  /** 浏览器自动化端点基址，例如 http://127.0.0.1:45123 */
  baseUrl: string
  /** 原生自动化端点的 Bearer token */
  token?: string
  /** 单次调用超时（毫秒） */
  timeoutMs?: number
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch
  /** 调用来源标记 */
  source?: 'agent' | 'external'
  log?: (message: string) => void
}

/**
 * 通过 HTTP 回调原生浏览器的自动化接口。
 * 端点契约：`POST <baseUrl>/automation/<action>`，body `{action, params, source}`，
 * 响应 `{ok:true, result}` 或 `{ok:false, error:{code,message}}`；
 * 也兼容直接返回结果对象（无信封）。
 */
export class HttpToolExecutor implements ToolExecutor {
  constructor(private readonly options: HttpExecutorOptions) {}

  /** 当前是否已配置端点 */
  get available(): boolean {
    return Boolean(this.options.baseUrl?.trim())
  }

  setBaseUrl(baseUrl: string, token?: string): void {
    this.options.baseUrl = baseUrl
    if (token !== undefined) this.options.token = token
  }

  /** 智能体工具调用 */
  async run(name: string, args: unknown): Promise<unknown> {
    const action = mapToolToAction(name)
    if (!action) {
      throw new ExecutorError(`工具「${name}」没有对应的浏览器自动化动作。`, 0, 'no-mapping')
    }
    return this.action(action, args, this.options.source ?? 'agent')
  }

  /** 自动化动作调用 */
  async action(
    name: string,
    params: unknown,
    source: 'agent' | 'external' = 'external'
  ): Promise<unknown> {
    const base = this.options.baseUrl?.trim().replace(/\/+$/, '')
    if (!base) {
      throw new ExecutorError(
        '尚未连接到浏览器自动化端点，无法执行需要在浏览器中完成的操作。请确认原生浏览器已启动并写入了桥接配置（native-bridge.json）。',
        0,
        'no-endpoint'
      )
    }
    if (!isProtocolAction(name)) {
      throw new ExecutorError(`「${name}」不是合法的浏览器协议动作。`, 0, 'unknown-action')
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000)
    const fetchImpl = this.options.fetchImpl ?? fetch
    try {
      const res = await fetchImpl(`${base}/automation/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {})
        },
        body: JSON.stringify({
          action: name,
          params: normalizeArgs(params),
          source
        } satisfies AutomationActionRequest),
        signal: controller.signal
      })
      const text = await res.text()
      let json: Record<string, unknown> | null = null
      try {
        const parsed: unknown = text ? JSON.parse(text) : null
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>
        }
      } catch {
        json = null
      }
      const errObj = json?.['error'] as { code?: string; message?: string } | undefined
      if (!res.ok) {
        const detail = errObj?.message ?? text.slice(0, 200)
        throw new ExecutorError(
          `浏览器执行动作「${name}」失败（HTTP ${res.status}）${detail ? '：' + detail : ''}`,
          res.status,
          errObj?.code ?? 'http-error'
        )
      }
      if (json && json['ok'] === false) {
        throw new ExecutorError(
          errObj?.message ?? `浏览器执行动作「${name}」失败。`,
          res.status,
          errObj?.code ?? 'browser-error'
        )
      }
      return json && 'result' in json ? json['result'] : json
    } catch (e) {
      if (e instanceof ExecutorError) throw e
      const msg = (e as Error)?.name === 'AbortError' ? '浏览器响应超时' : (e as Error)?.message
      throw new ExecutorError(`调用浏览器自动化接口失败：${msg || '未知错误'}`, 0, 'network-error')
    } finally {
      clearTimeout(timeout)
    }
  }
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>
  return { value: args }
}

export interface MockExecutorCall {
  /** 调用方式：工具名 or 动作名 */
  kind: 'tool' | 'action'
  name: string
  args: unknown
  /** 仅 action 调用有值 */
  source?: 'agent' | 'external'
}

/** 测试用执行器：记录每次调用，并按名字返回预设结果 */
export class MockToolExecutor implements ToolExecutor {
  readonly calls: MockExecutorCall[] = []
  /** 默认返回值（未命中 responses 时使用） */
  defaultResult: unknown = { ok: true, mocked: true }

  constructor(private readonly responses: Record<string, unknown | ((args: unknown) => unknown)> = {}) {}

  async run(name: string, args: unknown): Promise<unknown> {
    this.calls.push({ kind: 'tool', name, args })
    return this.resolve(name, args)
  }

  async action(name: string, params: unknown, source: 'agent' | 'external' = 'external'): Promise<unknown> {
    this.calls.push({ kind: 'action', name, args: params, source })
    return this.resolve(name, params)
  }

  private resolve(name: string, args: unknown): unknown {
    const entry = this.responses[name]
    if (typeof entry === 'function') return (entry as (a: unknown) => unknown)(args)
    if (entry !== undefined) return entry
    return this.defaultResult
  }

  /** 某个名字被调用的次数（工具名或动作名） */
  countOf(name: string): number {
    return this.calls.filter((c) => c.name === name).length
  }

  lastCall(name?: string): MockExecutorCall | undefined {
    const list = name ? this.calls.filter((c) => c.name === name) : this.calls
    return list[list.length - 1]
  }

  reset(): void {
    this.calls.length = 0
  }
}

/** 组合执行器：按名字分流（浏览器工具 → 原生；本地工具 → 边车） */
export class CompositeToolExecutor implements ToolExecutor {
  private readonly routes: Array<{ match: (name: string) => boolean; executor: ToolExecutor }> = []

  constructor(private readonly fallback?: ToolExecutor) {}

  route(match: (name: string) => boolean, executor: ToolExecutor): this {
    this.routes.push({ match, executor })
    return this
  }

  async run(name: string, args: unknown): Promise<unknown> {
    for (const r of this.routes) {
      if (r.match(name)) return r.executor.run(name, args)
    }
    if (this.fallback) return this.fallback.run(name, args)
    throw new ExecutorError(`没有可用的执行器来处理工具「${name}」。`, 0, 'no-executor')
  }

  async action(name: string, params: unknown, source: 'agent' | 'external' = 'external'): Promise<unknown> {
    for (const r of this.routes) {
      if (r.match(name)) return r.executor.action(name, params, source)
    }
    if (this.fallback) return this.fallback.action(name, params, source)
    throw new ExecutorError(`没有可用的执行器来处理动作「${name}」。`, 0, 'no-executor')
  }
}

/** 构造一个「总是失败」的执行器（未配置原生端点时的显式降级） */
export function unavailableExecutor(message: string): ToolExecutor {
  const fail = (): Promise<unknown> => Promise.reject(new ExecutorError(message, 0, 'unavailable'))
  return { run: fail, action: fail }
}

/**
 * 权限闸门（边车的第二道校验）：即使模型绕过工具白名单，
 * 也不会把超出档位的高危动作发出去。
 */
export function assertLevelAllows(
  level: 'off' | 'daily' | 'developer' | 'full',
  toolMinLevel: 'daily' | 'developer' | 'full'
): void {
  const rank: Record<string, number> = { off: 0, daily: 1, developer: 2, full: 3 }
  if (rank[level] < rank[toolMinLevel]) {
    throw new ExecutorError('当前权限档位不足，已拒绝执行该操作。', 403, 'permission-denied')
  }
}

/** 诊断：当前保护档位下是否允许 evaluate 类动作 */
export function allowsEvaluate(level: ProtectionLevel): boolean {
  return level !== 'none'
}
