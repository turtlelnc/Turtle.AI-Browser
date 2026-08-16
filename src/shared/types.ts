/**
 * 跨进程共享类型定义
 * 主进程 / 预加载 / 渲染进程三方共用，保证 IPC 契约类型安全。
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
