/**
 * 服务端共享类型副本（只读镜像）。
 *
 * ⚠️ 同步约定：本文件是 `src/shared/types.ts` 的**只读镜像**。
 * 边车服务不在仓库根的 tsconfig 工程内，无法直接 import 仓库根的 `src/shared/`，
 * 因此这里保留一份副本。契约的唯一事实来源仍然是 `src/shared/types.ts` /
 * `docs/ARCHITECTURE.md` §6；任何一方修改后必须同步本文件。
 * 若发现二者不一致，以仓库根的 `src/shared/types.ts` 为准。
 */

// ---------- 设置 ----------

export type SearchEngineId = 'bing' | 'baidu' | 'google' | 'duckduckgo'

export type ThemeMode = 'system' | 'light' | 'dark'

/** AI 智能体（CLI）权限档位 */
export type CliPermissionLevel = 'off' | 'daily' | 'developer' | 'full'

export interface AiProviderConfig {
  /** 是否启用 AI 助手 */
  enabled: boolean
  /** 服务商显示名，例如 DeepSeek */
  providerName: string
  /** API 根地址，例如 https://api.deepseek.com/v1 */
  baseUrl: string
  /** API Key（仅解密后驻留内存，绝不落盘明文） */
  apiKey: string
  /** 模型名，例如 deepseek-chat */
  model: string
  /** 系统提示词 */
  systemPrompt: string
  /** 智能体控制权限档位 */
  cliPermission: CliPermissionLevel
}

export interface SecurityConfig {
  /** 钓鱼 / 恶意网址拦截 */
  safeBrowsing: boolean
  /** HTTP 自动升级 HTTPS */
  httpsUpgrade: boolean
  /** 广告拦截 */
  adBlock: boolean
  /** 追踪器拦截 */
  trackerBlock: boolean
  /** 拦截可疑下载 */
  blockSuspiciousDownloads: boolean
}

export interface AppearanceConfig {
  /** 毛玻璃效果（低性能设备可关闭） */
  frostedGlass: boolean
  theme: ThemeMode
  /** 是否显示书签栏 */
  bookmarkBarVisible: boolean
  /** 是否显示主页按钮 */
  showHomeButton: boolean
}

export interface Settings {
  searchEngine: SearchEngineId
  homepage: string
  ai: AiProviderConfig
  security: SecurityConfig
  appearance: AppearanceConfig
}

// ---------- 标签页与浏览器状态 ----------

export interface TabState {
  id: string
  /** 空字符串表示新标签页 */
  url: string
  /** 用户在地址栏输入的原始文本 */
  input: string
  title: string
  favicon: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 是否为 HTTPS 或本地页面 */
  isSecure: boolean
  /** 是否为新标签页（显示 speed dial） */
  isNewTab: boolean
  /** 当前页面是否被安全服务拦截 */
  blocked?: SecurityVerdict | null
  /** 缩放级别（Chromium zoom level） */
  zoomLevel: number
}

export type OverlayName = 'settings' | 'history' | 'bookmarks' | 'downloads' | 'about' | null

export interface BrowserState {
  windowId: number
  tabs: TabState[]
  activeTabId: string
  sidebarOpen: boolean
  sidebarWidth: number
  overlay: OverlayName
  isMaximized: boolean
  isIncognito: boolean
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  settings: Settings
}

// ---------- AI ----------

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiChatRequest {
  requestId: string
  messages: AiMessage[]
}

export interface AiChunk {
  requestId: string
  delta: string
}

export interface AiDone {
  requestId: string
  content: string
}

export interface AiError {
  requestId: string
  message: string
}

/** 智能体工具执行状态（用于 UI 展示） */
export interface AiToolStatus {
  requestId: string
  name: string
  detail: string
}

/** 智能体循环中使用的消息（含 tool 角色与 tool_calls） */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface PageContext {
  title: string
  url: string
  text: string
  selectedText: string
}

// ---------- 安全 ----------

export type ThreatCategory = 'phishing' | 'malware' | 'ad' | 'tracking' | 'suspicious' | 'unsafe'

export interface SecurityVerdict {
  blocked: boolean
  category: ThreatCategory | null
  reason: string
}

// ---------- 书签 / 历史 / 下载 ----------

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
}

// ---------- 地址栏建议 ----------

export interface OmniboxSuggestion {
  text: string
  type: 'history' | 'search' | 'url'
  url: string
  title?: string
}

// ---------- 扩展程序 ----------

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  /** 扩展解压后的目录绝对路径 */
  path: string
  /** 是否来自 .crx 解包（用于删除时清理目录） */
  fromCrx: boolean
}

// ---------- 配置文件同步 ----------

export interface ProfileExportResult {
  path: string
  sizeBytes: number
}

// ---------- 三档安全浏览（ARCHITECTURE.md §5） ----------

/** 保护档位：增强型 / 标准 / 不防护 */
export type ProtectionLevel = 'enhanced' | 'standard' | 'none'

// ---------- 边车扩展设置（非 v0.1.0 契约，属 service 自己的持久化字段） ----------

/** 本地开发模式的工作区授权配置 */
export interface WorkspaceConfig {
  /** 工作区根目录绝对路径；为空表示用户尚未授权任何目录 */
  root: string
  /** 可执行命令白名单（按可执行文件名匹配，例如 node / npm / git） */
  allowCommands: string[]
  /** 演练模式：为 true 时只规划不执行（不写文件、不跑命令） */
  dryRun: boolean
}

/** 本地自动化 API 配置（默认关闭，见 AUTOMATION.md） */
export interface AutomationConfig {
  enabled: boolean
}

/** service 持久化的完整设置 = 共享 Settings + 边车扩展项 */
export interface ServiceSettings extends Settings {
  protectionLevel: ProtectionLevel
  automation: AutomationConfig
  workspace: WorkspaceConfig
  /** 可选的自建 URL 信誉查询端点（增强型防护使用，留空表示未配置） */
  reputationEndpoint: string
}
