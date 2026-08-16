import type {
  AgentMessage,
  AiChatRequest,
  AiChunk,
  AiDone,
  AiError,
  AiToolStatus,
  BookmarkNode,
  BrowserState,
  DownloadItem,
  ExtensionInfo,
  HistoryItem,
  OmniboxSuggestion,
  OverlayName,
  PageContext,
  ProfileExportResult,
  SecurityVerdict,
  Settings
} from './types'

export interface FindResult {
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

/** 渲染进程通过 window.tibrowser 暴露的桥接 API（preload 实现） */
export interface TibrowserApi {
  // 状态
  getState(): Promise<BrowserState>
  onState(cb: (state: BrowserState) => void): () => void

  // 标签页
  newTab(url?: string): Promise<string>
  closeTab(id: string): Promise<void>
  activateTab(id: string): Promise<void>
  moveTab(fromId: string, toIndex: number): Promise<void>

  // 导航
  navigate(input: string): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  reload(): Promise<void>
  stop(): Promise<void>
  goHome(): Promise<void>
  setZoom(level: number): Promise<void>
  proceed(): Promise<void>

  // 窗口
  minimize(): Promise<void>
  maximize(): Promise<void>
  closeWindow(): Promise<void>
  onWindowState(cb: (s: { isMaximized: boolean }) => void): () => void

  // UI
  toggleSidebar(): Promise<void>
  setSidebarWidth(w: number): Promise<void>
  toggleBookmarkBar(): Promise<void>
  openOverlay(name: OverlayName): Promise<void>
  onUiCommand(cb: (cmd: string) => void): () => void
  popupMenu(): Promise<void>

  // 地址栏
  omniboxQuery(q: string): Promise<OmniboxSuggestion[]>

  // 书签
  bookmarks: {
    list(): Promise<BookmarkNode[]>
    add(title: string, url: string, folder?: string): Promise<BookmarkNode>
    remove(id: string): Promise<void>
    toggle(title: string, url: string): Promise<boolean>
    onChange(cb: (list: BookmarkNode[]) => void): () => void
  }

  // 历史
  history: {
    list(): Promise<HistoryItem[]>
    clear(): Promise<void>
    remove(id: string): Promise<void>
  }

  // 下载
  downloads: {
    list(): Promise<DownloadItem[]>
    openFolder(id: string): Promise<void>
    open(id: string): Promise<string>
    onProgress(cb: (item: DownloadItem) => void): () => void
  }

  // 设置
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    setApiKey(key: string): Promise<Settings>
  }

  // AI
  ai: {
    chat(req: AiChatRequest): Promise<void>
    agent(req: { requestId: string; messages: AgentMessage[] }): Promise<void>
    abort(requestId: string): Promise<void>
    summarize(requestId?: string): Promise<void>
    context(): Promise<PageContext | null>
    onChunk(cb: (c: AiChunk) => void): () => void
    onDone(cb: (d: AiDone) => void): () => void
    onError(cb: (e: AiError) => void): () => void
    onTool(cb: (t: AiToolStatus) => void): () => void
  }

  // 页内查找
  find: {
    inPage(text: string): Promise<void>
    stop(): Promise<void>
    setOpen(open: boolean): Promise<void>
    onResult(cb: (r: FindResult) => void): () => void
  }

  // 安全
  checkUrl(url: string): Promise<SecurityVerdict>

  // 扩展程序
  extensions: {
    list(): Promise<ExtensionInfo[]>
    loadUnpacked(): Promise<ExtensionInfo | null>
    loadCrx(): Promise<ExtensionInfo | null>
    remove(id: string): Promise<void>
    onChange(cb: (list: ExtensionInfo[]) => void): () => void
  }

  // 配置文件同步
  profile: {
    export(): Promise<ProfileExportResult | null>
    import(): Promise<boolean>
  }
}
