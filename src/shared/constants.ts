import type { CliPermissionLevel, Settings, SearchEngineId } from './types'

/** 产品信息 */
export const APP_NAME = 'TIbrowser'
export const APP_VERSION = '0.1.0'

/** 内部伪协议 / 页面标识 */
export const NEW_TAB_URL = 'tibrowser://newtab'

/** 搜索引擎模板 */
export const SEARCH_ENGINES: Record<SearchEngineId, { name: string; template: string }> = {
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=' },
  baidu: { name: '百度', template: 'https://www.baidu.com/s?wd=' },
  google: { name: 'Google', template: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=' }
}

/** UI 布局尺寸（主进程定位 WebContentsView 与渲染进程 CSS 共用，保证对齐） */
export const UI = {
  tabStripHeight: 38,
  toolbarHeight: 44,
  bookmarkBarHeight: 30,
  findBarHeight: 40,
  sidebarWidth: 360,
  sidebarMinWidth: 260,
  sidebarMaxWidth: 560
} as const

/** 会话分区：普通浏览持久化，无痕浏览不落盘 */
export const BROWSER_PARTITION = 'persist:tibrowser'
export const INCOGNITO_PARTITION = 'tibrowser-incognito'

/** 默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'bing',
  homepage: 'https://www.bing.com',
  ai: {
    enabled: true,
    providerName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    systemPrompt: '你是 TIbrowser 内置的 AI 助手，请用简洁、准确的中文回答用户的问题。',
    cliPermission: 'daily'
  },
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
  }
}

/** IPC 通道名（字符串常量，避免手写拼写错误） */
export const IPC = {
  // 状态
  getState: 'tib:getState',
  stateUpdated: 'tib:stateUpdated',

  // 标签页
  newTab: 'tib:newTab',
  closeTab: 'tib:closeTab',
  activateTab: 'tib:activateTab',
  moveTab: 'tib:moveTab',

  // 导航
  navigate: 'tib:navigate',
  goBack: 'tib:goBack',
  goForward: 'tib:goForward',
  reload: 'tib:reload',
  stop: 'tib:stop',
  goHome: 'tib:goHome',
  setZoom: 'tib:setZoom',
  proceed: 'tib:proceed',

  // 页内查找
  findInPage: 'tib:findInPage',
  findResult: 'tib:findResult',
  findStop: 'tib:findStop',
  setFindOpen: 'tib:setFindOpen',

  // 窗口
  minimize: 'tib:minimize',
  maximize: 'tib:maximize',
  closeWindow: 'tib:closeWindow',
  windowStateChanged: 'tib:windowStateChanged',

  // UI
  toggleSidebar: 'tib:toggleSidebar',
  setSidebarWidth: 'tib:setSidebarWidth',
  toggleBookmarkBar: 'tib:toggleBookmarkBar',
  openOverlay: 'tib:openOverlay',
  uiCommand: 'tib:uiCommand',
  menuPopup: 'tib:menuPopup',

  // 地址栏建议
  omniboxQuery: 'tib:omniboxQuery',

  // 书签
  bookmarksList: 'tib:bookmarksList',
  bookmarksChanged: 'tib:bookmarksChanged',
  bookmarkAdd: 'tib:bookmarkAdd',
  bookmarkRemove: 'tib:bookmarkRemove',
  bookmarkToggle: 'tib:bookmarkToggle',

  // 历史
  historyList: 'tib:historyList',
  historyClear: 'tib:historyClear',
  historyRemove: 'tib:historyRemove',

  // 下载
  downloadsList: 'tib:downloadsList',
  downloadsOpenFolder: 'tib:downloadsOpenFolder',
  downloadsOpen: 'tib:downloadsOpen',
  downloadProgress: 'tib:downloadProgress',

  // 设置
  settingsGet: 'tib:settingsGet',
  settingsSet: 'tib:settingsSet',
  setApiKey: 'tib:setApiKey',

  // AI
  aiChat: 'tib:aiChat',
  aiAbort: 'tib:aiAbort',
  aiChunk: 'tib:aiChunk',
  aiDone: 'tib:aiDone',
  aiError: 'tib:aiError',
  aiSummarize: 'tib:aiSummarize',
  aiContext: 'tib:aiContext',
  aiAgent: 'tib:aiAgent',
  aiAgentAbort: 'tib:aiAgentAbort',
  aiTool: 'tib:aiTool',

  // 安全
  checkUrl: 'tib:checkUrl',

  // 扩展程序
  extensionsList: 'tib:extensionsList',
  extensionsChanged: 'tib:extensionsChanged',
  extensionLoadUnpacked: 'tib:extensionLoadUnpacked',
  extensionLoadCrx: 'tib:extensionLoadCrx',
  extensionRemove: 'tib:extensionRemove',

  // 配置文件同步
  profileExport: 'tib:profileExport',
  profileImport: 'tib:profileImport'
} as const

/** AI 智能体权限档位（UI 展示用） */
export const CLI_PERMISSION_LEVELS: { value: CliPermissionLevel; label: string; hint: string }[] = [
  { value: 'off', label: '关闭', hint: '仅基础对话，AI 不能控制浏览器' },
  { value: 'daily', label: '日常', hint: '可控制网页、帮你设置等安全操作' },
  { value: 'developer', label: '开发', hint: '额外增加抓包、执行 JS、读源码等开发功能' },
  { value: 'full', label: '全部', hint: '完全控制浏览器，含清空数据等危险操作，请谨慎开启' }
]
