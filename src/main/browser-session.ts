import { BrowserWindow, WebContentsView, session as electronSession, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { BROWSER_PARTITION, INCOGNITO_PARTITION, IPC, UI } from '@shared/constants'
import type { BrowserState, OverlayName, SecurityVerdict, TabState } from '@shared/types'
import { resolveNavigationInput } from '@shared/utils'
import { bookmarks, history, store } from './store'
import { scanUrl } from './security'

interface InternalTab {
  id: string
  view: WebContentsView
  state: TabState
}

/**
 * 一个浏览器窗口的会话：持有该窗口的所有标签页（WebContentsView）与 UI 状态，
 * 是「主进程为模型、渲染进程为视图」模式中的模型层。
 */
export class BrowserSession {
  readonly incognito: boolean
  private win: BrowserWindow
  private ses: Session
  private tabs: InternalTab[] = []
  private activeId = ''
  private sidebarOpen = false
  private sidebarWidth: number = UI.sidebarWidth
  private overlay: OverlayName = null
  private zoomLevel = 0
  private findOpen = false

  constructor(win: BrowserWindow, incognito: boolean) {
    this.win = win
    this.incognito = incognito
    this.ses = electronSession.fromPartition(incognito ? INCOGNITO_PARTITION : BROWSER_PARTITION)
    this.createTab('', true)
  }

  get windowId(): number {
    return this.win.id
  }

  get session(): Session {
    return this.ses
  }

  private activeTab(): InternalTab | undefined {
    return this.tabs.find((t) => t.id === this.activeId) ?? this.tabs[0]
  }

  // ---------- 标签页 ----------

  createTab(input = '', activate = true): string {
    const id = randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        partition: this.incognito ? INCOGNITO_PARTITION : BROWSER_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: true
      }
    })
    const state: TabState = {
      id,
      url: '',
      input: '',
      title: '新标签页',
      favicon: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isSecure: true,
      isNewTab: true,
      blocked: null,
      zoomLevel: this.zoomLevel
    }
    const tab: InternalTab = { id, view, state }
    this.tabs.push(tab)
    this.win.contentView.addChildView(view)
    view.setVisible(false)
    this.attachEvents(tab)

    if (input.trim()) {
      this.loadTab(tab, input)
    }
    if (activate) this.activateTab(id)
    return id
  }

  activateTab(id: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    this.activeId = id
    if (!tab.state.isNewTab && !tab.state.blocked) {
      tab.view.webContents.focus()
    }
    this.layout()
    this.sync()
  }

  closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const [tab] = this.tabs.splice(idx, 1)
    this.win.contentView.removeChildView(tab.view)
    try {
      tab.view.webContents.close()
    } catch {
      /* 已关闭则忽略 */
    }
    if (this.tabs.length === 0) {
      this.win.close()
      return
    }
    if (this.activeId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)]
      this.activateTab(next.id)
    } else {
      this.sync()
    }
  }

  moveTab(fromId: string, toIndex: number): void {
    const from = this.tabs.findIndex((t) => t.id === fromId)
    if (from < 0) return
    const [tab] = this.tabs.splice(from, 1)
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab)
    this.sync()
  }

  closeActiveTab(): void {
    const t = this.activeTab()
    if (t) this.closeTab(t.id)
  }

  getActiveTabId(): string {
    return this.activeId
  }

  /** 切换当前页书签状态，返回是否已收藏（供菜单快捷键使用） */
  toggleActiveBookmark(): boolean {
    const t = this.activeTab()
    if (!t || t.state.isNewTab) return false
    return bookmarks.toggle(t.state.title, t.state.url)
  }

  // ---------- 导航 ----------

  navigate(input: string): void {
    const tab = this.activeTab()
    if (!tab || !input.trim()) return
    this.loadTab(tab, input)
  }

  private loadTab(tab: InternalTab, input: string): void {
    const url = resolveNavigationInput(input, store.getSearchEngine())
    const verdict = scanUrl(url)
    tab.state.input = input
    tab.state.isNewTab = false
    if (verdict.blocked) {
      tab.state.blocked = verdict
      tab.state.url = url
      tab.state.title = '已拦截'
      tab.state.isLoading = false
      tab.state.isSecure = false
      this.layout()
      this.sync()
      return
    }
    tab.state.blocked = null
    tab.view.webContents.loadURL(url)
  }

  /** 用户主动继续访问被拦截的页面（loadURL 不触发 will-navigate，可绕过扫描） */
  proceed(): void {
    const tab = this.activeTab()
    if (!tab?.state.blocked) return
    const url = tab.state.url
    tab.state.blocked = null
    tab.view.webContents.loadURL(url)
    this.layout()
    this.sync()
  }

  goBack(): void {
    const wc = this.activeTab()?.view.webContents
    if (wc?.canGoBack()) wc.goBack()
  }

  goForward(): void {
    const wc = this.activeTab()?.view.webContents
    if (wc?.canGoForward()) wc.goForward()
  }

  reload(): void {
    this.activeTab()?.view.webContents.reload()
  }

  stop(): void {
    this.activeTab()?.view.webContents.stop()
  }

  goHome(): void {
    this.navigate(store.getHomepage())
  }

  setZoom(level: number): void {
    this.zoomLevel = Math.max(-5, Math.min(5, level))
    for (const t of this.tabs) {
      t.state.zoomLevel = this.zoomLevel
      t.view.webContents.setZoomLevel(this.zoomLevel)
    }
    this.sync()
  }

  zoomIn(): void {
    this.setZoom(this.zoomLevel + 0.5)
  }

  zoomOut(): void {
    this.setZoom(this.zoomLevel - 0.5)
  }

  zoomReset(): void {
    this.setZoom(0)
  }

  // ---------- UI 状态 ----------

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen
    this.layout()
    this.sync()
  }

  toggleBookmarkBar(): void {
    const a = store.getAppearance()
    store.setSettings({ appearance: { ...a, bookmarkBarVisible: !a.bookmarkBarVisible } })
    this.layout()
    this.sync()
  }

  setSidebarWidth(w: number): void {
    this.sidebarWidth = Math.max(UI.sidebarMinWidth, Math.min(UI.sidebarMaxWidth, w))
    this.layout()
    this.sync()
  }

  openOverlay(name: OverlayName): void {
    this.overlay = name
    this.sync()
  }

  setFindOpen(open: boolean): void {
    if (this.findOpen === open) return
    this.findOpen = open
    this.layout()
    this.sync()
  }

  // ---------- 页内查找 ----------

  findInPage(text: string): void {
    const wc = this.activeTab()?.view.webContents
    if (!wc) return
    if (text) wc.findInPage(text)
    else wc.stopFindInPage('clearSelection')
  }

  stopFind(): void {
    this.activeTab()?.view.webContents.stopFindInPage('clearSelection')
  }

  // ---------- 布局与状态 ----------

  private chromeHeight(): number {
    const bookmarkBarVisible = store.getAppearance().bookmarkBarVisible
    return (
      UI.tabStripHeight + UI.toolbarHeight + (bookmarkBarVisible ? UI.bookmarkBarHeight : 0)
    )
  }

  private layout(): void {
    const [width, height] = this.win.getContentSize()
    const top = this.chromeHeight() + (this.findOpen ? UI.findBarHeight : 0)
    const sideWidth = this.sidebarOpen ? this.sidebarWidth : 0
    const active = this.activeTab()
    const overlayOpen = this.overlay !== null
    for (const tab of this.tabs) {
      // 覆盖层（设置/历史等）打开时隐藏页面；查找栏打开时页面下移
      const showable =
        !overlayOpen && tab === active && !tab.state.isNewTab && !tab.state.blocked
      if (showable) {
        tab.view.setVisible(true)
        tab.view.setBounds({ x: 0, y: top, width: width - sideWidth, height: height - top })
      } else {
        tab.view.setVisible(false)
      }
    }
  }

  getState(): BrowserState {
    const active = this.activeTab()
    return {
      windowId: this.windowId,
      tabs: this.tabs.map((t) => ({ ...t.state })),
      activeTabId: this.activeId,
      sidebarOpen: this.sidebarOpen,
      sidebarWidth: this.sidebarWidth,
      overlay: this.overlay,
      isMaximized: this.win.isMaximized(),
      isIncognito: this.incognito,
      canGoBack: active?.state.canGoBack ?? false,
      canGoForward: active?.state.canGoForward ?? false,
      isLoading: active?.state.isLoading ?? false,
      settings: store.getSettings()
    }
  }

  /** 重新计算布局并推送状态给渲染进程 */
  sync(): void {
    if (this.win.isDestroyed()) return
    this.layout()
    this.win.webContents.send(IPC.stateUpdated, this.getState())
  }

  /** 提取当前页面正文，供 AI 总结使用 */
  async extractPageText(maxLen = 8000): Promise<string> {
    const wc = this.activeTab()?.view.webContents
    if (!wc) return ''
    try {
      const text: string = await wc.executeJavaScript(
        `(document.body ? document.body.innerText : '')`
      )
      return (text || '').slice(0, maxLen)
    } catch {
      return ''
    }
  }

  /** 在当前活动页面执行 JS，返回结果（供智能体控制网页用） */
  async runInPage(code: string): Promise<unknown> {
    const wc = this.activeTab()?.view.webContents
    if (!wc) return { error: '没有活动标签页' }
    try {
      return await wc.executeJavaScript(code, true)
    } catch (e) {
      return { error: String(e) }
    }
  }

  getActiveTabUrl(): string {
    return this.activeTab()?.state.url ?? ''
  }

  getActiveTabTitle(): string {
    return this.activeTab()?.state.title ?? ''
  }

  async getSelectedText(): Promise<string> {
    const wc = this.activeTab()?.view.webContents
    if (!wc) return ''
    try {
      const text: string = await wc.executeJavaScript(`(window.getSelection() || '').toString()`)
      return text || ''
    } catch {
      return ''
    }
  }

  // ---------- 事件 ----------

  private attachEvents(tab: InternalTab): void {
    const wc = tab.view.webContents

    wc.on('did-start-loading', () => {
      tab.state.isLoading = true
      if (tab.id === this.activeId) this.sync()
    })
    wc.on('did-stop-loading', () => {
      tab.state.isLoading = false
      if (tab.id === this.activeId) this.sync()
    })
    wc.on('did-navigate', (_e, url) => this.recordNavigation(tab, url))
    wc.on('did-navigate-in-page', (_e, url) => {
      tab.state.url = url
      if (tab.id === this.activeId) this.sync()
    })
    wc.on('page-title-updated', (_e, title) => {
      tab.state.title = title
      if (tab.id === this.activeId) this.sync()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.state.favicon = favicons[0] ?? ''
      if (tab.id === this.activeId) this.sync()
    })
    wc.on('did-fail-load', (_e, code, desc, url) => {
      if (code === -3) return // ERR_ABORTED，正常中断
      tab.state.isLoading = false
      tab.state.title = '无法访问此网站'
      tab.state.url = url
      if (tab.id === this.activeId) this.sync()
    })
    wc.on('found-in-page', (_e, result) => {
      if (tab.id === this.activeId) {
        this.win.webContents.send(IPC.findResult, result)
      }
    })

    // 页面主动导航 / 重定向时做安全扫描
    wc.on('will-navigate', (event, url) => {
      const verdict = scanUrl(url)
      if (verdict.blocked) {
        event.preventDefault()
        this.showBlocked(tab, url, verdict)
      }
    })
    wc.on('will-redirect', (event, url) => {
      const verdict = scanUrl(url)
      if (verdict.blocked) {
        event.preventDefault()
        this.showBlocked(tab, url, verdict)
      }
    })

    // 新窗口 / target=_blank 一律转入新标签页
    wc.setWindowOpenHandler(({ url }) => {
      this.createTab(url, true)
      return { action: 'deny' }
    })
  }

  private recordNavigation(tab: InternalTab, url: string): void {
    if (url.startsWith('data:') || url === 'about:blank') {
      if (tab.id === this.activeId) this.sync()
      return
    }
    tab.state.url = url
    tab.state.input = url
    tab.state.title = tab.state.title || url
    tab.state.isSecure = url.startsWith('https://') || url.startsWith('tibrowser://')
    tab.state.canGoBack = tab.view.webContents.canGoBack()
    tab.state.canGoForward = tab.view.webContents.canGoForward()
    if (!this.incognito) history.add(tab.state.title, url)
    if (tab.id === this.activeId) this.sync()
  }

  private showBlocked(tab: InternalTab, url: string, verdict: SecurityVerdict): void {
    tab.state.blocked = verdict
    tab.state.url = url
    tab.state.input = url
    tab.state.title = '已拦截'
    tab.state.isLoading = false
    tab.state.isSecure = false
    this.layout()
    this.sync()
  }
}
