/**
 * `window.tib` 桥接契约（UI ↔ 原生）
 *
 * 本文件是 `docs/ARCHITECTURE.md` §3.1（命令）/ §3.2（事件）的 **唯一类型化实现**，
 * 由 renderer（外壳 UI）、原生宿主（C++ / CefMessageRouter）与边车（Node service）
 * 共同引用，任何一方都不得另行复制粘贴一份同义类型。
 *
 * 约定：
 * 1. 所有命令返回 Promise（底层是 CefMessageRouter 的 query）。
 * 2. 事件通过 `tib.on(evt, cb)` 订阅，返回取消订阅函数。
 * 3. 新增字段一律**可选**，实现侧给默认值，保证皮肤/档位/内核降级不崩 UI
 *    （见 ARCHITECTURE.md §6）。
 */

// ---------------------------------------------------------------------------
// 版本常量（展示格式：v1.0.0-rc1 (build 260913)）
// ---------------------------------------------------------------------------

/**
 * 应用版本号。
 * 注意：`src/shared/constants.ts` 中仍是 v0.1.0 遗留的 `APP_VERSION = '1.0.0-beta'`；
 * 该文件的归属者不在本次改动范围内，故 v1.0.0-rc1 的权威版本号从本文件导出，
 * 待 constants.ts 对齐后可直接改为一处转发。
 */
export const TIB_VERSION = '1.0.0-rc1'
/** 构建号 */
export const TIB_BUILD = 260913
/** 版本展示串：`v1.0.0-rc1 (build 260913)` */
export const TIB_VERSION_LABEL = `v${TIB_VERSION} (build ${TIB_BUILD})`
/** 官网 */
export const TIB_WEBSITE = 'https://turtleweb.cc.cd'
/** 开源许可证 */
export const TIB_LICENSE = 'GPL-3.0'
/**
 * 内核（Chromium / CEF）版本。
 * 由构建期 `define` 注入（vite.config.ts 的 `__CEF_VERSION__`），
 * 未注入（例如裸跑 tsc）时回落到占位串，UI 会显示「未知」而不是崩掉。
 */
export const TIB_CEF_VERSION: string =
  typeof __CEF_VERSION__ === 'string' && __CEF_VERSION__ ? __CEF_VERSION__ : '未知'

// ---------------------------------------------------------------------------
// 安全浏览（feature 5，对齐 ARCHITECTURE.md §5）
// ---------------------------------------------------------------------------

/** 三档安全浏览 */
export type ProtectionLevel = 'enhanced' | 'standard' | 'none'

/** 拦截统计中的单条记录 */
export interface SecurityEvent {
  id: string
  url: string
  /** 危险类别的中文名，例如「钓鱼网站」 */
  category: string
  /** 处置动作的中文名，例如「已拦截」「已警告」 */
  action: string
  /** 命中时间（毫秒时间戳） */
  at: number
  /** 是否来自 turtlelnc 信任例外（true 表示放行，不计入威胁） */
  trusted?: boolean
}

/** 安全浏览当前档位与拦截统计 */
export interface SecurityReport {
  level: ProtectionLevel
  /** 今日拦截次数 */
  blockedToday: number
  /** 累计拦截次数 */
  blockedTotal: number
  /** 本次会话拦截次数 */
  blockedSession?: number
  /** 最近拦截明细（可为空数组） */
  recent: SecurityEvent[]
  /** 防护数据库版本，例如 2026.09.13.1 */
  databaseVersion?: string
  /** 上次更新时间（毫秒时间戳） */
  updatedAt?: number
  /** turtlelnc 信任例外是否生效（UI 需要明确告知用户） */
  trustedExceptionEnabled?: boolean
}

// ---------------------------------------------------------------------------
// 无痕模式 2.0（feature 4）
// ---------------------------------------------------------------------------

/** 屏幕分辨率（宽 × 高，CSS 像素） */
export interface ScreenSize {
  width: number
  height: number
}

/** 单个指纹字段在 UI 上的取值：具体值 或 跟随系统 */
export type FpValue<T> = T | 'system'

/** 无痕模式 2.0 的指纹改写配置 */
export interface FingerprintProfile {
  userAgent: FpValue<string>
  platform: FpValue<string>
  timezone: FpValue<string>
  language: FpValue<string>
  screen: FpValue<ScreenSize>
  /** Canvas 指纹噪声 */
  canvasNoise: boolean
  /** WebGL 指纹噪声 */
  webglNoise: boolean
  hardwareConcurrency: FpValue<number>
  /** 发送 Do-Not-Track 请求头 */
  doNotTrack: boolean
  /** 禁用 WebRTC，防止真实内网 IP 泄露 */
  disableWebRtc?: boolean
  /** 阻止第三方 Cookie */
  blockThirdPartyCookies?: boolean
  /** 上次随机化时间（毫秒时间戳），从未随机化时为 0 */
  randomizedAt?: number
}

/** 无痕会话概况（用于标签栏上的无痕指示器） */
export interface IncognitoInfo {
  active: boolean
  /** 当前无痕窗口内标签数量 */
  tabCount: number
  /** 已拦截的追踪器数量 */
  trackersBlocked: number
  /** 指纹改写是否已启用 */
  fingerprintEnabled: boolean
}

// ---------------------------------------------------------------------------
// 能效模式（feature 13）
// ---------------------------------------------------------------------------

/** 能效四档 */
export type EnergyMode = 'standard' | 'fast' | 'eco' | 'instant'

/** 能效状态与内存/进程读数 */
export interface EnergyState {
  mode: EnergyMode
  /** 内核是否真的应用成功（未成功时 UI 需降级提示） */
  applied: boolean
  /** 本机是否支持快速（预加载）模式，null 表示尚未检测 */
  fastSupported: boolean | null
  /** 快速模式不可用原因（中文） */
  fastUnsupportedReason?: string
  /** 当前进程数 */
  processCount?: number
  /** 当前内存占用（MB） */
  memoryMb?: number
  /** 隐藏标签页节流是否生效 */
  backgroundThrottle?: boolean
}

// ---------------------------------------------------------------------------
// 皮肤（feature 8）
// ---------------------------------------------------------------------------

/** 浏览器皮肤：TiBrowser 原生 / 类 Edge 布局 / 类 Chrome 布局 */
export type BrowserSkin = 'tibrowser' | 'edge' | 'chrome'

/** 主题：浅色 / 深色 / 跟随系统 */
export type ThemeMode2 = 'light' | 'dark' | 'system'

/** 性能档：low 时关闭全部模糊、阴影与大过渡，供低端设备使用 */
export type PerfMode = 'high' | 'low'

// ---------------------------------------------------------------------------
// 账户与同步（feature 3）
// ---------------------------------------------------------------------------

export type AccountProvider = 'microsoft' | 'google'

export interface AccountInfo {
  provider: AccountProvider
  /** 服务商显示名 */
  displayName: string
  signedIn: boolean
  /** 已登录账号（脱敏后的邮箱） */
  email?: string
  /** 头像地址（可为 data: URL） */
  avatar?: string
  /** 上次登录时间（毫秒时间戳） */
  lastSignInAt?: number
}

/** 可同步的数据类别 */
export interface SyncToggles {
  bookmarks: boolean
  history: boolean
  settings: boolean
  extensions: boolean
  passwords: boolean
}

export interface SyncState {
  /** 用户是否打开了总开关 */
  enabled: boolean
  /** 正在同步中 */
  syncing: boolean
  /** 上次同步完成时间（毫秒时间戳），0 表示从未同步 */
  lastSyncAt: number
  /** 上次同步结果说明（中文），例如「成功同步 128 项」 */
  lastResult?: string
  toggles: SyncToggles
}

/** `.tbuser` 迁移包导出结果 */
export interface ProfileTransferResult {
  path: string
  sizeBytes: number
  /** 包含的数据类别（中文） */
  includes: string[]
}

// ---------------------------------------------------------------------------
// 网页应用（feature 7）
// ---------------------------------------------------------------------------

export interface WebApp {
  id: string
  name: string
  url: string
  /** 图标（data: URL 或 https: URL） */
  icon?: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 是否有独立窗口 */
  windowed?: boolean
}

// ---------------------------------------------------------------------------
// 扩展程序
// ---------------------------------------------------------------------------

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description?: string
  /** 解压后的目录绝对路径 */
  path: string
  /** 是否来自 .crx 解包（删除时需要清理目录） */
  fromCrx: boolean
  /** 启用状态（v0.1.0 缺失的开关） */
  enabled: boolean
  /** 权限摘要（中文，用于展示） */
  permissions?: string[]
}

// ---------------------------------------------------------------------------
// AI 模型连接（feature 9）/ AI 模式（feature 12）
// ---------------------------------------------------------------------------

/** 三种接入方式 */
export type AiConnectionMethod = 'apiKey' | 'mcp' | 'oauth'

/** 连接测试结果 */
export interface AiTestResult {
  ok: boolean
  /** 耗时（毫秒） */
  latencyMs: number
  /** 面向用户的中文结论，例如「连接成功，模型 deepseek-chat 可用」 */
  message: string
  /** 失败时的原始错误摘要 */
  detail?: string
}

export interface McpServer {
  id: string
  name: string
  /** 传输方式：stdio 本地进程 / http 远程 */
  transport: 'stdio' | 'http'
  /** stdio 时是可执行命令，http 时是 URL */
  target: string
  enabled: boolean
  /** 连接状态 */
  status: 'connected' | 'disconnected' | 'error' | 'unknown'
  /** 状态说明（中文） */
  statusText?: string
  /** 该服务器暴露的工具数量 */
  toolCount?: number
}

export interface AiConnectionState {
  method: AiConnectionMethod
  providerName: string
  baseUrl: string
  /** 掩码后的 Key，例如 sk-****abcd；空串表示未配置 */
  apiKeyMask: string
  model: string
  mcpServers: McpServer[]
  oauth: {
    provider: AccountProvider | null
    signedIn: boolean
    account?: string
    /** 第三方 SDK 授权地址（点击后由原生打开外部浏览器） */
    authorizeUrl?: string
  }
}

/** AI 模式：浏览 / 本地办公 / 本地开发 */
export type AiMode = 'browse' | 'office' | 'dev'

export interface AiModeInfo {
  mode: AiMode
  /** 本地开发模式的沙箱工作目录，null 表示未选择 */
  workdir: string | null
  /** 本地开发模式的目录白名单 */
  allowlist: string[]
  /** 本地办公模式可访问的文档目录 */
  documentDirs?: string[]
  /** 当前模式允许使用的工具名（中文展示用） */
  tools: string[]
}

export interface AiChatPayload {
  requestId: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  mode?: AiMode
}

export interface AiAgentPayload {
  requestId: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /** 控制权限档位，对应 `src/shared/types.ts` 的 CliPermissionLevel */
  permission?: 'off' | 'daily' | 'developer' | 'full'
}

export interface AiToolEvent {
  requestId: string
  name: string
  detail: string
  phase: 'start' | 'ok' | 'error'
}

export interface AiContext {
  title: string
  url: string
  text: string
  selectedText: string
}

// ---------------------------------------------------------------------------
// 自动化 API（feature 15）
// ---------------------------------------------------------------------------

export interface AutomationInfo {
  enabled: boolean
  /** 本地自动化接口根地址，例如 http://127.0.0.1:49811 */
  baseUrl: string
  /** Bearer token（敏感信息，UI 默认打码，可复制） */
  token: string
  /** 文档地址（tib:// 或 https://） */
  docs?: string
  /** 端点列表，用于在 UI 中列出自定义能力 */
  endpoints?: Array<{ method: string; path: string; desc: string }>
}

/** 边车（tib-service）状态 */
export interface ServiceStatus {
  running: boolean
  /** 当前模式说明（中文） */
  mode: string
  port: number | null
  version: string
  /** 能力列表，例如 ['ai', 'sync', 'automation'] */
  capabilities?: string[]
}

// ---------------------------------------------------------------------------
// 标签页 / 浏览器状态（v1.0.0-rc1 版）
// ---------------------------------------------------------------------------

export type OverlayName =
  | 'settings'
  | 'history'
  | 'bookmarks'
  | 'downloads'
  | 'about'
  | 'apps'
  | 'extensions'
  | 'aiConsole'
  | null

export interface TabState {
  id: string
  /** 空串表示新标签页 */
  url: string
  /** 用户在地址栏输入的原始文本 */
  input: string
  title: string
  favicon: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** HTTPS 或本地页面 */
  isSecure: boolean
  isNewTab: boolean
  /** 当前标签是否属于无痕窗口 */
  incognito?: boolean
  /** 当前页面是否被拦截 */
  blocked?: { blocked: boolean; category: string | null; reason: string } | null
  /** 缩放级别（Chromium zoom level） */
  zoomLevel: number
}

/** 搜索结果类型（下拉联想） */
export interface OmniboxSuggestion {
  text: string
  type: 'history' | 'search' | 'url'
  url: string
  title?: string
}

export interface BookmarkNode {
  id: string
  title: string
  url: string
  folder: string
  createdAt: number
}

export interface HistoryItem {
  id: string
  title: string
  url: string
  visitedAt: number
}

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadItem {
  id: string
  filename: string
  url: string
  receivedBytes: number
  totalBytes: number
  state: DownloadState
  savePath: string
  mimeType?: string
  /** 是否被安全浏览标记为可疑（feature 6） */
  suspicious?: boolean
  /** 可疑原因（中文） */
  suspiciousReason?: string
}

export interface FindResult {
  matches: number
  activeMatchOrdinal: number
  finalUpdate: boolean
}

/** 设置项（v1.0.0-rc1：皮肤 / 性能档 / 能效等纳入设置快照） */
export interface TibSettings {
  /** 默认搜索引擎 id，取值见 constants.ts 的 SEARCH_ENGINES */
  searchEngine: string
  homepage: string
  theme: ThemeMode2
  skin: BrowserSkin
  /** low 时关闭全部视觉效果，供低端设备使用 */
  perf: PerfMode
  /** 是否确认过低端设备提示 */
  bookmarkBarVisible: boolean
  showHomeButton: boolean
  /** 启动时恢复上次会话 */
  restoreSession: boolean
  /** 智能体控制权限档位 */
  cliPermission: 'off' | 'daily' | 'developer' | 'full'
  /** AI 总开关 */
  aiEnabled: boolean
  /** 边车（AI 服务）是否随浏览器启动 */
  serviceAutoStart: boolean
}

/** 全量浏览器状态，UI 首次加载时拉取（ARCHITECTURE.md §3.1） */
export interface BrowserState {
  windowId: number
  tabs: TabState[]
  activeTabId: string
  sidebarOpen: boolean
  sidebarWidth: number
  overlay: OverlayName
  isMaximized: boolean
  isFullscreen?: boolean
  isIncognito: boolean
  incognito?: IncognitoInfo
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  settings: TibSettings
  /** AI 模式（浏览 / 本地办公 / 本地开发） */
  aiMode?: AiMode
}

/** 地址栏导航结果 */
export interface NavigateResult {
  ok: boolean
  blocked?: boolean
  verdict?: { blocked: boolean; category: string | null; reason: string } | null
}

/** 通用 {ok} 返回 */
export interface OkResult {
  ok: boolean
}

// ---------------------------------------------------------------------------
// 事件（ARCHITECTURE.md §3.2）
// ---------------------------------------------------------------------------

/** 下载不安全安装包的警告请求（feature 6），由原生发起、UI 回答 */
export interface DownloadPrompt {
  id: string
  filename: string
  url: string
  /** 可疑原因（中文），例如「可执行文件且来源未经验证」 */
  reason: string
  /** 危险等级，用于决定配色 */
  risk?: 'low' | 'medium' | 'high'
  totalBytes?: number
}

export interface WindowStateEvent {
  isMaximized: boolean
  isFullscreen?: boolean
}

export interface SecurityEventPayload {
  url: string
  verdict: { blocked: boolean; category: string | null; reason: string }
  action: string
}

/** 事件名 → 载荷 的映射表 */
export interface TibEventMap {
  /** 任何状态变化（原生侧节流 16ms） */
  state: BrowserState
  /** 页内查找结果 */
  findResult: FindResult
  /** 窗口状态 */
  windowState: WindowStateEvent
  /** 下载进度 */
  download: DownloadItem
  /** AI 流式增量 */
  aiChunk: { requestId: string; delta: string }
  /** AI 完成 */
  aiDone: { requestId: string; content: string }
  /** AI 失败 */
  aiError: { requestId: string; message: string }
  /** AI 工具调用状态 */
  aiTool: AiToolEvent
  /** 安全拦截 */
  securityEvent: SecurityEventPayload
  /** 登录态变化 */
  accountsChanged: { accounts: AccountInfo[]; syncState: SyncState }
  /** 网页应用变化 */
  appsChanged: WebApp[]
  /** 扩展变化 */
  extensionsChanged: ExtensionInfo[]
  /** 请求用户就不安全安装包做出决定（保留 / 丢弃） */
  downloadWarning: DownloadPrompt
  /** 设置被外部修改（例如键盘快捷键或菜单） */
  settingsChanged: TibSettings
}

export type TibEventName = keyof TibEventMap

/** 取消订阅函数 */
export type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// 桥接接口
// ---------------------------------------------------------------------------

/**
 * 原生注入到外壳 UI 的 `window.tib` 桥。
 * 所有方法都必须返回 Promise；任何方法都不得同步抛出（失败也要 reject）。
 */
export interface TibBridge {
  /** 事件订阅，返回取消订阅函数 */
  on<K extends TibEventName>(event: K, cb: (payload: TibEventMap[K]) => void): Unsubscribe
  /** 取消订阅（与 on 配对，便于统一清理） */
  off<K extends TibEventName>(event: K, cb: (payload: TibEventMap[K]) => void): void

  // ---- 状态 ----
  getState(): Promise<BrowserState>

  // ---- 标签页 ----
  newTab(input?: string, opts?: { incognito?: boolean; appId?: string }): Promise<{ tabId: string }>
  closeTab(tabId: string): Promise<OkResult>
  activateTab(tabId: string): Promise<OkResult>
  moveTab(tabId: string, index: number): Promise<OkResult>

  // ---- 导航 ----
  navigate(input: string): Promise<NavigateResult>
  goBack(): Promise<OkResult>
  goForward(): Promise<OkResult>
  reload(): Promise<OkResult>
  stop(): Promise<OkResult>
  goHome(): Promise<OkResult>
  setZoom(level: number): Promise<OkResult>
  zoomIn(): Promise<OkResult>
  zoomOut(): Promise<OkResult>
  zoomReset(): Promise<OkResult>
  /** 忽略安全警告继续访问 */
  proceed(): Promise<OkResult>

  // ---- 页内查找 ----
  findInPage(text: string): Promise<OkResult>
  findStop(): Promise<OkResult>
  setFindOpen(open: boolean): Promise<OkResult>

  // ---- 窗口 / 外壳布局 ----
  setOverlay(name: OverlayName): Promise<OkResult>
  toggleSidebar(open?: boolean): Promise<OkResult>
  setSidebarWidth(width: number): Promise<OkResult>
  toggleBookmarkBar(): Promise<OkResult>
  windowAction(action: 'minimize' | 'maximize' | 'restore' | 'close'): Promise<OkResult>
  /** 弹出原生菜单 */
  popupMenu(): Promise<OkResult>

  // ---- 设置 ----
  getSettings(): Promise<TibSettings>
  setSettings(patch: Partial<TibSettings>): Promise<TibSettings>
  /** 保存 API Key（原生侧 DPAPI 加密，不回传明文） */
  setApiKey(key: string): Promise<OkResult>

  // ---- 书签 / 历史 / 下载 ----
  getBookmarks(): Promise<BookmarkNode[]>
  addBookmark(title: string, url: string, folder?: string): Promise<BookmarkNode>
  removeBookmark(id: string): Promise<OkResult>
  toggleBookmark(title?: string, url?: string): Promise<{ bookmarked: boolean }>
  getHistory(q?: string, limit?: number): Promise<HistoryItem[]>
  clearHistory(): Promise<OkResult>
  removeHistory(id: string): Promise<OkResult>
  getDownloads(): Promise<DownloadItem[]>
  openDownload(id: string): Promise<OkResult>
  openDownloadFolder(): Promise<OkResult>
  /** 就不安全安装包作出决定（feature 6） */
  resolveDownloadPrompt(id: string, keep: boolean): Promise<OkResult>

  // ---- 地址栏 ----
  omniboxSuggest(q: string): Promise<OmniboxSuggestion[]>

  // ---- 安全浏览（feature 5） ----
  getSecurityReport(): Promise<SecurityReport>
  setProtectionLevel(level: ProtectionLevel): Promise<OkResult>

  // ---- 无痕模式 2.0（feature 4） ----
  getFingerprintProfile(): Promise<FingerprintProfile>
  setFingerprintProfile(patch: Partial<FingerprintProfile>): Promise<FingerprintProfile>
  randomizeFingerprint(): Promise<FingerprintProfile>

  // ---- 能效模式（feature 13） ----
  getEnergyMode(): Promise<EnergyState>
  setEnergyMode(mode: EnergyMode): Promise<EnergyState>

  // ---- 皮肤（feature 8） ----
  getSkin(): Promise<BrowserSkin>
  setSkin(skin: BrowserSkin): Promise<OkResult>

  // ---- 网页应用（feature 7） ----
  getInstalledApps(): Promise<WebApp[]>
  installWebApp(url: string, name: string, icon?: string): Promise<WebApp>
  uninstallWebApp(id: string): Promise<OkResult>
  launchWebApp(id: string): Promise<OkResult>

  // ---- 账户与同步（feature 3） ----
  getAccounts(): Promise<AccountInfo[]>
  signIn(provider: AccountProvider): Promise<AccountInfo>
  signOut(provider: AccountProvider): Promise<OkResult>
  getSyncState(): Promise<SyncState>
  setSyncToggles(patch: Partial<SyncToggles>): Promise<SyncState>
  syncNow(): Promise<SyncState>
  profileExport(): Promise<ProfileTransferResult>
  profileImport(): Promise<ProfileTransferResult | null>

  // ---- 扩展程序 ----
  getExtensions(): Promise<ExtensionInfo[]>
  loadUnpackedExtension(path?: string): Promise<ExtensionInfo | null>
  loadCrx(path?: string): Promise<ExtensionInfo | null>
  removeExtension(id: string): Promise<OkResult>
  setExtensionEnabled(id: string, on: boolean): Promise<OkResult>

  // ---- AI 模型连接（feature 9） ----
  getAiConnection(): Promise<AiConnectionState>
  setAiConnection(patch: Partial<AiConnectionState>): Promise<AiConnectionState>
  testAiConnection(): Promise<AiTestResult>
  addMcpServer(server: { name: string; transport: 'stdio' | 'http'; target: string }): Promise<McpServer>
  removeMcpServer(id: string): Promise<OkResult>
  /** 单个 MCP 服务器连通性检查 */
  checkMcpServer(id: string): Promise<McpServer>

  // ---- AI 模式（feature 12） ----
  getAiMode(): Promise<AiModeInfo>
  setAiMode(mode: AiMode): Promise<AiModeInfo>
  /** 选择沙箱工作目录（原生弹目录选择框） */
  pickWorkdir(): Promise<{ path: string | null }>
  setWorkdirAllowlist(list: string[]): Promise<AiModeInfo>

  // ---- AI 对话 ----
  aiChat(payload: AiChatPayload): Promise<{ requestId: string }>
  aiAgent(payload: AiAgentPayload): Promise<{ requestId: string }>
  aiAbort(requestId: string): Promise<OkResult>
  /** 读取当前页面上下文（标题 / 正文 / 选中文字） */
  aiContext(): Promise<AiContext | null>

  // ---- 边车与自动化（feature 15） ----
  serviceStatus(): Promise<ServiceStatus>
  automationInfo(): Promise<AutomationInfo>
  setAutomationEnabled(enabled: boolean): Promise<AutomationInfo>
  /** 写入剪贴板（浏览器外壳自身无剪贴板权限，交给原生） */
  copyToClipboard(text: string): Promise<OkResult>
}

/** 构建期注入的全局常量声明（见 vite.config.ts 的 define） */
declare global {
  // eslint-disable-next-line no-var
  var __CEF_VERSION__: string | undefined
  // eslint-disable-next-line no-var
  var __TIB_BUILD__: string | undefined
  interface Window {
    /**
     * CEF 宿主注入的桥。
     * 声明为可选：在普通浏览器标签页中直接打开 UI（走 mock 桥）时它并不存在，
     * 消费方必须通过 `src/renderer/src/bridge.ts` 导出的 `tib` 访问。
     */
    tib?: TibBridge
  }
}
