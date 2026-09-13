/**
 * 开发用假数据（仅在 `window.tib` 不存在时使用）。
 *
 * ⚠️ 这里的一切都是**编造的示例数据**，只为让外壳 UI 在普通浏览器标签页里
 * 可点、可看、可走查（`npm run ui:dev` 或直接打开 dist/ui/index.html）。
 * 真实运行环境下这份模块的代码路径永远不会被执行。
 */
import type {
  AccountInfo,
  AiConnectionState,
  AiModeInfo,
  AutomationInfo,
  BrowserState,
  DownloadItem,
  ExtensionInfo,
  FingerprintProfile,
  HistoryItem,
  McpServer,
  SecurityReport,
  ServiceStatus,
  SyncState,
  TibSettings,
  WebApp
} from '@shared/bridge'

const now = Date.now()

/** 深拷贝（结构化克隆缺失时的兜底） */
export function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

export const MOCK_SETTINGS: TibSettings = {
  searchEngine: 'bing',
  homepage: 'https://www.bing.com',
  theme: 'system',
  skin: 'tibrowser',
  perf: 'high',
  bookmarkBarVisible: true,
  showHomeButton: true,
  restoreSession: true,
  cliPermission: 'daily',
  aiEnabled: true,
  serviceAutoStart: true
}

export const MOCK_STATE: BrowserState = {
  windowId: 1,
  activeTabId: 'tab-1',
  tabs: [
    {
      id: 'tab-1',
      url: '',
      input: '',
      title: '新标签页',
      favicon: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isSecure: true,
      isNewTab: true,
      zoomLevel: 0
    },
    {
      id: 'tab-2',
      url: 'https://turtleweb.cc.cd/',
      input: 'https://turtleweb.cc.cd/',
      title: 'TiBrowser 官网 — turtleweb.cc.cd',
      favicon: '',
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      isSecure: true,
      isNewTab: false,
      zoomLevel: 0
    },
    {
      id: 'tab-3',
      url: 'https://github.com/turtlelnc',
      input: 'https://github.com/turtlelnc',
      title: 'turtlelnc · GitHub（无痕示例）',
      favicon: '',
      isLoading: true,
      canGoBack: true,
      canGoForward: false,
      isSecure: true,
      isNewTab: false,
      // 第三个标签演示「无痕窗口」在标签栏上的可见标记（feature 4）
      incognito: true,
      zoomLevel: 0
    }
  ],
  sidebarOpen: false,
  sidebarWidth: 360,
  overlay: null,
  isMaximized: false,
  isFullscreen: false,
  isIncognito: false,
  incognito: {
    active: false,
    tabCount: 0,
    trackersBlocked: 0,
    fingerprintEnabled: false
  },
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  settings: MOCK_SETTINGS,
  aiMode: 'browse'
}

export const MOCK_SECURITY: SecurityReport = {
  level: 'standard',
  blockedToday: 12,
  blockedTotal: 1284,
  blockedSession: 3,
  databaseVersion: '2026.09.13.1',
  updatedAt: now - 1000 * 60 * 42,
  trustedExceptionEnabled: true,
  recent: [
    {
      id: 'sec-1',
      url: 'http://free-robux-generator.example/claim',
      category: '钓鱼网站',
      action: '已拦截',
      at: now - 1000 * 60 * 12
    },
    {
      id: 'sec-2',
      url: 'https://cdn.tracking-hub.example/px.gif',
      category: '追踪器',
      action: '已拦截',
      at: now - 1000 * 60 * 37
    },
    {
      id: 'sec-3',
      url: 'http://download-crack-setup.example/app.exe',
      category: '可疑下载',
      action: '已警告',
      at: now - 1000 * 60 * 96
    },
    {
      id: 'sec-4',
      url: 'https://github.com/turtlelnc/tibrowser',
      category: 'turtlelnc 信任例外',
      action: '已放行',
      at: now - 1000 * 60 * 140,
      trusted: true
    }
  ]
}

export const MOCK_FINGERPRINT: FingerprintProfile = {
  userAgent: 'system',
  platform: 'system',
  timezone: 'system',
  language: 'system',
  screen: 'system',
  canvasNoise: true,
  webglNoise: true,
  hardwareConcurrency: 'system',
  doNotTrack: true,
  disableWebRtc: true,
  blockThirdPartyCookies: true,
  randomizedAt: 0
}

export const MOCK_ENERGY = {
  mode: 'standard' as const,
  applied: true,
  fastSupported: null as boolean | null,
  processCount: 6,
  memoryMb: 412,
  backgroundThrottle: true
}

export const MOCK_ACCOUNTS: AccountInfo[] = [
  { provider: 'microsoft', displayName: 'Microsoft', signedIn: false },
  { provider: 'google', displayName: 'Google', signedIn: false }
]

export const MOCK_SYNC: SyncState = {
  enabled: false,
  syncing: false,
  lastSyncAt: 0,
  toggles: {
    bookmarks: true,
    history: true,
    settings: true,
    extensions: false,
    passwords: false
  }
}

export const MOCK_APPS: WebApp[] = [
  {
    id: 'app-1',
    name: 'TiBrowser 官网',
    url: 'https://turtleweb.cc.cd/',
    createdAt: now - 1000 * 60 * 60 * 24 * 3,
    windowed: true
  },
  {
    id: 'app-2',
    name: 'GitHub',
    url: 'https://github.com/',
    createdAt: now - 1000 * 60 * 60 * 24 * 9,
    windowed: true
  }
]

export const MOCK_EXTENSIONS: ExtensionInfo[] = [
  {
    id: 'ext-1',
    name: 'TiBrowser 截图助手（示例）',
    version: '2.1.0',
    description: '示例扩展，用于演示启用 / 禁用开关。',
    path: 'C:\\Users\\Public\\TibExtensions\\screenshot',
    fromCrx: false,
    enabled: true,
    permissions: ['当前标签页', '下载']
  },
  {
    id: 'ext-2',
    name: '护眼模式（示例）',
    version: '1.0.4',
    description: '示例扩展，当前处于禁用状态。',
    path: 'C:\\Users\\Public\\TibExtensions\\eyecare',
    fromCrx: true,
    enabled: false,
    permissions: ['所有网站']
  }
]

export const MOCK_MCP: McpServer[] = [
  {
    id: 'mcp-1',
    name: '本地文件系统',
    transport: 'stdio',
    target: 'npx -y @modelcontextprotocol/server-filesystem D:\\work',
    enabled: true,
    status: 'connected',
    statusText: '已连接，读取 3 个工具',
    toolCount: 3
  },
  {
    id: 'mcp-2',
    name: '团队知识库',
    transport: 'http',
    target: 'http://127.0.0.1:7801/mcp',
    enabled: false,
    status: 'disconnected',
    statusText: '未启用',
    toolCount: 0
  }
]

export const MOCK_AI_CONNECTION: AiConnectionState = {
  method: 'apiKey',
  providerName: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyMask: '',
  model: 'deepseek-chat',
  mcpServers: MOCK_MCP,
  oauth: { provider: null, signedIn: false }
}

export const MOCK_AI_MODE: AiModeInfo = {
  mode: 'browse',
  workdir: null,
  allowlist: [],
  documentDirs: [],
  tools: ['读取当前页面', '总结 / 翻译', '填表草稿']
}

export const MOCK_AUTOMATION: AutomationInfo = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:49811',
  token: 'tib_2f8c41d0a7b94e6f9c1d3a5e7b0f2c48',
  docs: 'https://turtleweb.cc.cd/docs/automation',
  endpoints: [
    { method: 'GET', path: '/v1/status', desc: '查询浏览器与边车状态' },
    { method: 'POST', path: '/v1/tabs', desc: '新建标签页' },
    { method: 'POST', path: '/v1/navigate', desc: '导航到指定地址' },
    { method: 'POST', path: '/v1/ai/chat', desc: '发起一次 AI 对话（SSE 流式返回）' }
  ]
}

export const MOCK_SERVICE: ServiceStatus = {
  running: true,
  mode: '本地边车（Node 20）',
  port: 49810,
  version: '1.0.0-rc1',
  capabilities: ['ai', 'store', 'sync', 'automation']
}

export const MOCK_HISTORY: HistoryItem[] = [
  { id: 'h1', title: 'TiBrowser 官网 — turtleweb.cc.cd', url: 'https://turtleweb.cc.cd/', visitedAt: now - 1000 * 60 * 8 },
  { id: 'h2', title: 'turtlelnc · GitHub', url: 'https://github.com/turtlelnc', visitedAt: now - 1000 * 60 * 26 },
  { id: 'h3', title: 'CEF — Chromium Embedded Framework', url: 'https://bitbucket.org/chromiumembedded/cef', visitedAt: now - 1000 * 60 * 74 },
  { id: 'h4', title: 'MDN Web Docs', url: 'https://developer.mozilla.org/zh-CN/', visitedAt: now - 1000 * 60 * 180 }
]

export const MOCK_DOWNLOADS: DownloadItem[] = [
  {
    id: 'd1',
    filename: 'tibrowser-setup-1.0.0-rc1.exe',
    url: 'https://turtleweb.cc.cd/download/tibrowser-setup-1.0.0-rc1.exe',
    receivedBytes: 48_200_000,
    totalBytes: 48_200_000,
    state: 'completed',
    savePath: 'C:\\Users\\Public\\Downloads\\tibrowser-setup-1.0.0-rc1.exe',
    mimeType: 'application/octet-stream'
  },
  {
    id: 'd2',
    filename: 'driver-pack.zip',
    url: 'http://download-crack-setup.example/driver-pack.zip',
    receivedBytes: 1_240_000,
    totalBytes: 8_600_000,
    state: 'progressing',
    savePath: 'C:\\Users\\Public\\Downloads\\driver-pack.zip',
    mimeType: 'application/zip',
    suspicious: true,
    suspiciousReason: '来源域名未经验证，且包含可执行文件'
  }
]

/** 假的「当前页面上下文」，供 AI 快捷功能在开发预览里可用 */
export const MOCK_PAGE_CONTEXT = {
  title: '示例页面（mock 桥）',
  url: 'https://example.com/mock',
  text: '这是 mock 桥返回的示例正文，用来说明在普通浏览器里也能点通 AI 侧边栏的快捷功能。',
  selectedText: ''
}
