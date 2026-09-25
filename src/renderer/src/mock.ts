/**
 * 开发用 mock 桥（**仅在 `window.tib` 不存在时启用**）。
 *
 * 用途：在没有 CEF 宿主、也没有 Electron 的环境（普通浏览器标签页）里
 * 让整套外壳 UI 依然可点、可看、可验证布局与皮肤，而不是一片白屏。
 *
 * 行为约定：
 * - 所有方法都返回 Promise，且都经过 ~40ms 的模拟延迟，便于 UI 走查 loading 态。
 * - 状态类方法（标签页 / 设置 / 皮肤 / 档位 …）会写入内存状态并派发 `state` 事件，
 *   因此在浏览器里点「新建标签页」「切皮肤」是**真的**会生效的。
 * - AI 对话会流式吐出一段固定的中文说明，用来验证侧边栏的流式渲染与中止逻辑。
 * - 破坏性操作（清空历史 / 卸载扩展 / 退出登录）只改内存，不动任何真实数据。
 */
import type {
  AccountInfo,
  AccountProvider,
  AiChatPayload,
  AiConnectionState,
  AiMode,
  AiModeInfo,
  AiTestResult,
  AutomationInfo,
  BookmarkNode,
  BrowserSkin,
  BrowserState,
  DownloadItem,
  DownloadPrompt,
  EnergyMode,
  EnergyState,
  ExtensionInfo,
  FingerprintProfile,
  HistoryItem,
  McpServer,
  NavigateResult,
  OmniboxSuggestion,
  OverlayName,
  ProfileTransferResult,
  ProtectionLevel,
  SecurityReport,
  ServiceStatus,
  SyncState,
  SyncToggles,
  TabState,
  TibBridge,
  TibEventMap,
  TibEventName,
  TibSettings,
  Unsubscribe,
  WebApp
} from '@shared/bridge'
import {
  clone,
  MOCK_ACCOUNTS,
  MOCK_AI_CONNECTION,
  MOCK_AI_MODE,
  MOCK_APPS,
  MOCK_AUTOMATION,
  MOCK_DOWNLOADS,
  MOCK_ENERGY,
  MOCK_EXTENSIONS,
  MOCK_FINGERPRINT,
  MOCK_HISTORY,
  MOCK_PAGE_CONTEXT,
  MOCK_SECURITY,
  MOCK_SERVICE,
  MOCK_SETTINGS,
  MOCK_STATE,
  MOCK_SYNC
} from './mock-data'

/** mock 桥里的内存状态（每次启动重置） */
interface MockStore {
  state: BrowserState
  security: SecurityReport
  fingerprint: FingerprintProfile
  energy: EnergyState
  accounts: AccountInfo[]
  sync: SyncState
  apps: WebApp[]
  extensions: ExtensionInfo[]
  ai: AiConnectionState
  aiMode: AiModeInfo
  automation: AutomationInfo
  service: ServiceStatus
  bookmarks: BookmarkNode[]
  history: HistoryItem[]
  downloads: DownloadItem[]
  seq: number
}

function seedStore(): MockStore {
  return {
    state: clone(MOCK_STATE),
    security: clone(MOCK_SECURITY),
    fingerprint: clone(MOCK_FINGERPRINT),
    energy: clone(MOCK_ENERGY),
    accounts: clone(MOCK_ACCOUNTS),
    sync: clone(MOCK_SYNC),
    apps: clone(MOCK_APPS),
    extensions: clone(MOCK_EXTENSIONS),
    ai: clone(MOCK_AI_CONNECTION),
    aiMode: clone(MOCK_AI_MODE),
    automation: clone(MOCK_AUTOMATION),
    service: clone(MOCK_SERVICE),
    bookmarks: [
      { id: 'b1', title: 'TiBrowser 官网', url: 'https://turtleweb.cc.cd/', folder: '书签栏', createdAt: Date.now() - 86400000 },
      { id: 'b2', title: 'GitHub · turtlelnc', url: 'https://github.com/turtlelnc', folder: '书签栏', createdAt: Date.now() - 43200000 },
      { id: 'b3', title: 'CEF 项目主页', url: 'https://bitbucket.org/chromiumembedded/cef', folder: '开发', createdAt: Date.now() - 3600000 }
    ],
    history: clone(MOCK_HISTORY),
    downloads: clone(MOCK_DOWNLOADS),
    seq: 100
  }
}

/** 极简事件总线 */
type Listener<K extends TibEventName> = (payload: TibEventMap[K]) => void

class Emitter {
  private map = new Map<TibEventName, Set<(payload: never) => void>>()

  on<K extends TibEventName>(event: K, cb: Listener<K>): Unsubscribe {
    let set = this.map.get(event)
    if (!set) {
      set = new Set()
      this.map.set(event, set)
    }
    set.add(cb as (payload: never) => void)
    return () => this.off(event, cb)
  }

  off<K extends TibEventName>(event: K, cb: Listener<K>): void {
    this.map.get(event)?.delete(cb as (payload: never) => void)
  }

  emit<K extends TibEventName>(event: K, payload: TibEventMap[K]): void {
    const set = this.map.get(event)
    if (!set) return
    for (const cb of [...set]) {
      try {
        ;(cb as Listener<K>)(payload)
      } catch (err) {
        // 单个订阅者报错不应影响其它订阅者
        console.warn('[tib-mock] 事件回调抛出异常：', event, err)
      }
    }
  }
}

const delay = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms))
const uid = (prefix: string, n: number): string => `${prefix}-${n}`

/** 把用户输入变成可用的 URL（与地址栏一致的粗略规则） */
function toUrl(input: string): string {
  const text = input.trim()
  if (!text) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(tib|about|data|file):/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(text)) {
    return `http://${text}`
  }
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(text)) return `https://${text}`
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 40)
  }
}

/** 模拟 AI 回复：先吐一小段，再分片吐完 */
const MOCK_AI_REPLY = `当前处于 **开发预览（mock 桥）** 模式：没有检测到 \`window.tib\`，因此所有数据都是本地假数据。

这次回复用来验证三件事：
1. 侧边栏的流式渲染（分片到达、逐字追加）是否正确；
2. 「停止生成」按钮能否中止一个进行中的请求；
3. 深色 / 浅色主题与三种皮肤下的气泡、代码块与滚动条样式。

接入真实的 CEF 宿主后，这段文字会被替换为你的模型输出。`

export function createMockBridge(): TibBridge {
  const store = seedStore()
  const emitter = new Emitter()

  // 预览环境专用：启动 8 秒后自动弹一次「下载不安全安装包」警告，
  // 这样人工走查 dist/ui 时也能看到对话框（真实环境由原生侧发 downloadWarning 事件）。
  if (typeof window !== 'undefined') {
    setTimeout(() => emitter.emit('downloadWarning', mockDownloadPrompt()), 8000)
  }

  function pushState(patch: Partial<BrowserState> = {}): BrowserState {
    store.state = { ...store.state, ...patch }
    const active = store.state.tabs.find((t) => t.id === store.state.activeTabId)
    store.state = {
      ...store.state,
      canGoBack: patch.canGoBack ?? active?.canGoBack ?? false,
      canGoForward: patch.canGoForward ?? active?.canGoForward ?? false,
      isLoading: patch.isLoading ?? active?.isLoading ?? false
    }
    const snapshot = clone(store.state)
    emitter.emit('state', snapshot)
    return snapshot
  }

  function patchTab(tabId: string, patch: Partial<TabState>): void {
    store.state = {
      ...store.state,
      tabs: store.state.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
    }
    pushState()
  }

  async function openOverlay(name: OverlayName): Promise<{ ok: boolean }> {
    pushState({ overlay: name })
    return { ok: true }
  }

  /** 模拟一次导航（会立刻"加载完成"，并写入历史） */
  async function navigate(input: string): Promise<NavigateResult> {
    const url = toUrl(input)
    const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId)
    if (!tab || !url) return { ok: true }
    patchTab(tab.id, {
      url,
      input,
      title: hostOf(url),
      isNewTab: false,
      isLoading: true,
      canGoBack: true,
      isSecure: url.startsWith('https://') || url.startsWith('tib://')
    })
    store.history = [
      { id: uid('h', ++store.seq), title: hostOf(url), url, visitedAt: Date.now() },
      ...store.history
    ]
    setTimeout(() => patchTab(tab.id, { isLoading: false }), 260)
    return { ok: true, blocked: false, verdict: null }
  }

  /** 模拟流式对话 */
  function streamReply(requestId: string, question: string): void {
    if (/失败|fail/i.test(question)) {
      setTimeout(() => {
        emitter.emit('aiError', {
          requestId,
          message: '（mock）模拟失败：后端返回 401，请在「设置 → AI 模型连接」中检查 API Key。'
        })
      }, 500)
      return
    }
    const text = MOCK_AI_REPLY
    const step = 14
    let i = 0
    emitter.emit('aiTool', {
      requestId,
      name: 'mock.read_page',
      detail: '读取当前标签页上下文（假数据）',
      phase: 'start'
    })
    const timer = setInterval(() => {
      i += step
      emitter.emit('aiChunk', { requestId, delta: text.slice(i - step, i) })
      if (i >= text.length) {
        clearInterval(timer)
        emitter.emit('aiTool', {
          requestId,
          name: 'mock.read_page',
          detail: '已读取 1 个页面',
          phase: 'ok'
        })
        emitter.emit('aiDone', { requestId, content: text })
      }
    }, 26)
  }

  return {
    on: (event, cb) => emitter.on(event, cb),
    off: (event, cb) => emitter.off(event, cb),

    // ---- 状态 ----
    getState: async () => {
      await delay(20)
      return clone(store.state)
    },

    // ---- 标签页 ----
    newTab: async (input, opts) => {
      await delay()
      const id = uid('tab', ++store.seq)
      const url = input ? toUrl(input) : ''
      const tab: TabState = {
        id,
        url,
        input: input ?? '',
        title: url ? hostOf(url) : '新标签页',
        favicon: '',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        isSecure: !url || url.startsWith('https://'),
        isNewTab: !url,
        incognito: opts?.incognito ?? false,
        zoomLevel: 0
      }
      store.state = { ...store.state, tabs: [...store.state.tabs, tab], activeTabId: id }
      if (opts?.incognito) {
        store.state = {
          ...store.state,
          isIncognito: true,
          incognito: {
            active: true,
            tabCount: (store.state.incognito?.tabCount ?? 0) + 1,
            trackersBlocked: store.state.incognito?.trackersBlocked ?? 0,
            fingerprintEnabled: true
          }
        }
      }
      pushState()
      return { tabId: id }
    },

    closeTab: async (tabId) => {
      await delay(20)
      let tabs = store.state.tabs.filter((t) => t.id !== tabId)
      if (!tabs.length) {
        // 浏览器不允许出现「零标签」窗口，关掉最后一个标签时要补一个新标签页
        tabs = [
          {
            id: uid('tab', ++store.seq),
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
          }
        ]
      }
      const next = tabs
      const activeTabId =
        store.state.activeTabId === tabId ? (next[next.length - 1]?.id ?? '') : store.state.activeTabId
      store.state = { ...store.state, tabs: next, activeTabId }
      pushState()
      return { ok: true }
    },

    activateTab: async (tabId) => {
      await delay(20)
      pushState({ activeTabId: tabId })
      return { ok: true }
    },

    moveTab: async (tabId, index) => {
      await delay(20)
      const tabs = [...store.state.tabs]
      const from = tabs.findIndex((t) => t.id === tabId)
      if (from < 0) return { ok: false }
      const [tab] = tabs.splice(from, 1)
      tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab)
      store.state = { ...store.state, tabs }
      pushState()
      return { ok: true }
    },

    // ---- 导航 ----
    navigate,
    goBack: async () => ({ ok: true }),
    goForward: async () => ({ ok: true }),
    reload: async () => {
      const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId)
      if (tab) {
        patchTab(tab.id, { isLoading: true })
        setTimeout(() => patchTab(tab.id, { isLoading: false }), 300)
      }
      return { ok: true }
    },
    stop: async () => {
      const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId)
      if (tab) patchTab(tab.id, { isLoading: false })
      return { ok: true }
    },
    goHome: async () => {
      await navigate(store.state.settings.homepage)
      return { ok: true }
    },
    setZoom: async (level) => {
      const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId)
      if (tab) patchTab(tab.id, { zoomLevel: level })
      return { ok: true }
    },
    toggleReaderMode: async () => {
      // mock 桥：状态立刻翻转，方便在浏览器里走查阅读按钮的两种外观
      const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId)
      if (tab) {
        const on = !tab.readerActive
        patchTab(tab.id, { readerActive: on, readerChars: on ? 1200 : 0 })
      }
      return { ok: true }
    },
    zoomIn: async () => {
      const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId)
      if (tab) patchTab(tab.id, { zoomLevel: Math.min(5, tab.zoomLevel + 0.5) })
      return { ok: true }
    },
    zoomOut: async () => {
      const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId)
      if (tab) patchTab(tab.id, { zoomLevel: Math.max(-5, tab.zoomLevel - 0.5) })
      return { ok: true }
    },
    zoomReset: async () => {
      const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId)
      if (tab) patchTab(tab.id, { zoomLevel: 0 })
      return { ok: true }
    },
    proceed: async () => {
      const tab = store.state.tabs.find((t) => t.id === store.state.activeTabId)
      if (tab) patchTab(tab.id, { blocked: null })
      return { ok: true }
    },

    // ---- 页内查找 ----
    findInPage: async (text) => {
      const matches = text.trim() ? Math.max(1, (text.trim().length * 3) % 17) : 0
      emitter.emit('findResult', { matches, activeMatchOrdinal: matches ? 1 : 0, finalUpdate: true })
      return { ok: true }
    },
    findStop: async () => {
      emitter.emit('findResult', { matches: 0, activeMatchOrdinal: 0, finalUpdate: true })
      return { ok: true }
    },
    setFindOpen: async () => ({ ok: true }),

    // ---- 外壳 ----
    setOverlay: (name) => openOverlay(name),
    toggleSidebar: async (open) => {
      pushState({ sidebarOpen: open ?? !store.state.sidebarOpen })
      return { ok: true }
    },
    setSidebarWidth: async (width) => {
      pushState({ sidebarWidth: width })
      return { ok: true }
    },
    toggleBookmarkBar: async () => {
      const settings: TibSettings = {
        ...store.state.settings,
        bookmarkBarVisible: !store.state.settings.bookmarkBarVisible
      }
      pushState({ settings })
      return { ok: true }
    },
    windowAction: async (action) => {
      if (action === 'maximize') pushState({ isMaximized: true })
      else if (action === 'restore') pushState({ isMaximized: false })
      else if (action === 'minimize') pushState({ isMaximized: false })
      emitter.emit('windowState', {
        isMaximized: action === 'maximize' ? true : action === 'restore' ? false : store.state.isMaximized,
        isFullscreen: false
      })
      if (action === 'close') console.info('[tib-mock] 收到关闭窗口请求（预览环境不真正关闭）')
      return { ok: true }
    },
    popupMenu: async () => {
      console.info('[tib-mock] 原生菜单在预览环境中不可用，已改为直接打开设置面板')
      return openOverlay('settings')
    },

    // ---- 设置 ----
    getSettings: async () => {
      await delay(20)
      return clone(store.state.settings)
    },
    setSettings: async (patch) => {
      await delay(20)
      const settings: TibSettings = { ...store.state.settings, ...patch }
      const snapshot = pushState({ settings })
      emitter.emit('settingsChanged', snapshot.settings)
      return clone(settings)
    },
    setApiKey: async (key) => {
      await delay(60)
      store.ai = {
        ...store.ai,
        apiKeyMask: key ? `${key.slice(0, 3)}****${key.slice(-4)}` : ''
      }
      return { ok: true }
    },

    // ---- 书签 / 历史 / 下载 ----
    getBookmarks: async () => {
      await delay(20)
      return clone(store.bookmarks)
    },
    addBookmark: async (title, url, folder) => {
      await delay(20)
      const node: BookmarkNode = {
        id: uid('b', ++store.seq),
        title: title || hostOf(url),
        url,
        folder: folder ?? '书签栏',
        createdAt: Date.now()
      }
      store.bookmarks = [...store.bookmarks, node]
      return clone(node)
    },
    removeBookmark: async (id) => {
      await delay(20)
      store.bookmarks = store.bookmarks.filter((b) => b.id !== id)
      return { ok: true }
    },
    toggleBookmark: async (title, url) => {
      await delay(20)
      const target = url ?? store.state.tabs.find((t) => t.id === store.state.activeTabId)?.url ?? ''
      const exist = store.bookmarks.find((b) => b.url === target)
      if (exist) {
        store.bookmarks = store.bookmarks.filter((b) => b.id !== exist.id)
        return { bookmarked: false }
      }
      store.bookmarks = [
        ...store.bookmarks,
        {
          id: uid('b', ++store.seq),
          title: title || hostOf(target),
          url: target,
          folder: '书签栏',
          createdAt: Date.now()
        }
      ]
      return { bookmarked: true }
    },
    getHistory: async (q, limit) => {
      await delay(20)
      const kw = (q ?? '').trim().toLowerCase()
      const list = kw
        ? store.history.filter((h) => h.url.toLowerCase().includes(kw) || h.title.toLowerCase().includes(kw))
        : store.history
      return clone(limit ? list.slice(0, limit) : list)
    },
    clearHistory: async () => {
      await delay(30)
      store.history = []
      return { ok: true }
    },
    removeHistory: async (id) => {
      await delay(20)
      store.history = store.history.filter((h) => h.id !== id)
      return { ok: true }
    },
    getDownloads: async () => {
      await delay(20)
      return clone(store.downloads)
    },
    openDownload: async () => ({ ok: true }),
    openDownloadFolder: async () => ({ ok: true }),
    resolveDownloadPrompt: async (id, keep) => {
      await delay(30)
      store.downloads = store.downloads.filter((d) => d.id !== id || keep)
      console.info(`[tib-mock] 下载警告 #${id} → ${keep ? '保留' : '丢弃'}`)
      return { ok: true }
    },

    // ---- 地址栏 ----
    omniboxSuggest: async (q) => {
      await delay(60)
      const text = q.trim()
      if (!text) return []
      const out: OmniboxSuggestion[] = []
      for (const h of store.history) {
        if (out.length >= 3) break
        if (h.url.toLowerCase().includes(text.toLowerCase()) || h.title.includes(text)) {
          out.push({ text: h.title, type: 'history', url: h.url, title: h.title })
        }
      }
      for (const b of store.bookmarks) {
        if (out.length >= 5) break
        if (b.title.includes(text) || b.url.toLowerCase().includes(text.toLowerCase())) {
          out.push({ text: b.title, type: 'history', url: b.url, title: b.title })
        }
      }
      out.push({
        text: `${text} — 使用 Bing 搜索`,
        type: 'search',
        url: `https://www.bing.com/search?q=${encodeURIComponent(text)}`
      })
      out.push({ text: toUrl(text), type: 'url', url: toUrl(text) })
      return out
    },

    // ---- 安全浏览 ----
    getSecurityReport: async () => {
      await delay(60)
      return clone(store.security)
    },
    setProtectionLevel: async (level: ProtectionLevel) => {
      await delay(40)
      store.security = { ...store.security, level }
      return { ok: true }
    },

    // ---- 无痕 2.0 ----
    getFingerprintProfile: async () => {
      await delay(40)
      return clone(store.fingerprint)
    },
    setFingerprintProfile: async (patch) => {
      await delay(40)
      store.fingerprint = { ...store.fingerprint, ...patch }
      return clone(store.fingerprint)
    },
    randomizeFingerprint: async () => {
      await delay(260)
      const versions = ['126.0.0.0', '127.0.0.0', '128.0.0.0', '129.0.0.0']
      const platforms = ['Win32', 'MacIntel', 'Linux x86_64']
      const zones = ['Asia/Shanghai', 'Asia/Tokyo', 'Europe/Berlin', 'America/New_York']
      const langs = ['zh-CN,zh;q=0.9', 'en-US,en;q=0.9', 'ja-JP,ja;q=0.9']
      const screens = [
        { width: 1920, height: 1080 },
        { width: 2560, height: 1440 },
        { width: 1440, height: 900 },
        { width: 1366, height: 768 }
      ]
      const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
      store.fingerprint = {
        ...store.fingerprint,
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${pick(versions)} Safari/537.36`,
        platform: pick(platforms),
        timezone: pick(zones),
        language: pick(langs),
        screen: pick(screens),
        hardwareConcurrency: pick([4, 8, 12, 16]),
        canvasNoise: true,
        webglNoise: true,
        randomizedAt: Date.now()
      }
      return clone(store.fingerprint)
    },

    // ---- 能效 ----
    getEnergyMode: async () => {
      await delay(40)
      return clone(store.energy)
    },
    setEnergyMode: async (mode: EnergyMode) => {
      await delay(80)
      store.energy = {
        ...store.energy,
        mode,
        applied: true,
        memoryMb:
          mode === 'eco' ? 236 : mode === 'fast' ? 588 : mode === 'instant' ? 180 : 412,
        processCount: mode === 'eco' ? 4 : mode === 'fast' ? 9 : mode === 'instant' ? 3 : 6,
        backgroundThrottle: mode === 'eco' || mode === 'instant'
      }
      return clone(store.energy)
    },

    // ---- 皮肤 ----
    getSkin: async () => {
      await delay(20)
      return store.state.settings.skin
    },
    setSkin: async (skin: BrowserSkin) => {
      await delay(20)
      pushState({ settings: { ...store.state.settings, skin } })
      return { ok: true }
    },

    // ---- 网页应用 ----
    getInstalledApps: async () => {
      await delay(30)
      return clone(store.apps)
    },
    installWebApp: async (url, name, icon) => {
      await delay(200)
      const app: WebApp = {
        id: uid('app', ++store.seq),
        name: name || hostOf(url),
        url: toUrl(url),
        icon,
        createdAt: Date.now(),
        windowed: true
      }
      store.apps = [...store.apps, app]
      emitter.emit('appsChanged', clone(store.apps))
      return clone(app)
    },
    uninstallWebApp: async (id) => {
      await delay(120)
      store.apps = store.apps.filter((a) => a.id !== id)
      emitter.emit('appsChanged', clone(store.apps))
      return { ok: true }
    },
    launchWebApp: async (id) => {
      await delay(60)
      const app = store.apps.find((a) => a.id === id)
      if (app) await navigate(app.url)
      return { ok: Boolean(app) }
    },

    // ---- 账户与同步 ----
    getAccounts: async () => {
      await delay(40)
      return clone(store.accounts)
    },
    signIn: async (provider: AccountProvider) => {
      await delay(700)
      const displayName = provider === 'microsoft' ? 'Microsoft' : 'Google'
      const account: AccountInfo = {
        provider,
        displayName,
        signedIn: true,
        email: provider === 'microsoft' ? 'turtle***@outlook.com' : 'turtle***@gmail.com',
        lastSignInAt: Date.now()
      }
      store.accounts = store.accounts.map((a) => (a.provider === provider ? account : a))
      store.sync = { ...store.sync, enabled: true, lastSyncAt: Date.now(), lastResult: '首次同步完成，共 42 项' }
      emitter.emit('accountsChanged', { accounts: clone(store.accounts), syncState: clone(store.sync) })
      return clone(account)
    },
    signOut: async (provider) => {
      await delay(200)
      store.accounts = store.accounts.map((a) =>
        a.provider === provider ? { provider: a.provider, displayName: a.displayName, signedIn: false } : a
      )
      emitter.emit('accountsChanged', { accounts: clone(store.accounts), syncState: clone(store.sync) })
      return { ok: true }
    },
    getSyncState: async () => {
      await delay(30)
      return clone(store.sync)
    },
    setSyncToggles: async (patch: Partial<SyncToggles>) => {
      await delay(40)
      store.sync = { ...store.sync, toggles: { ...store.sync.toggles, ...patch } }
      return clone(store.sync)
    },
    setSyncEnabled: async (enabled) => {
      await delay(40)
      if (enabled && !store.accounts.some((a) => a.signedIn)) {
        // 与原生侧约定一致：未登录时不开总开关，由 UI 提示用户先登录
        return clone(store.sync)
      }
      store.sync = { ...store.sync, enabled }
      return clone(store.sync)
    },
    syncNow: async () => {
      await delay(900)
      store.sync = { ...store.sync, syncing: false, lastSyncAt: Date.now(), lastResult: '同步成功，共 137 项' }
      return clone(store.sync)
    },
    profileExport: async (): Promise<ProfileTransferResult> => {
      await delay(600)
      return {
        path: 'D:\\TiBrowser\\tibrowser-2026-09-13.tbuser',
        sizeBytes: 2_486_272,
        includes: ['书签', '历史', '设置', '扩展程序清单', '网页应用']
      }
    },
    profileImport: async () => {
      await delay(600)
      return {
        path: 'D:\\TiBrowser\\tibrowser-2026-09-13.tbuser',
        sizeBytes: 2_486_272,
        includes: ['书签', '历史', '设置']
      }
    },

    // ---- 扩展 ----
    getExtensions: async () => {
      await delay(40)
      return clone(store.extensions)
    },
    getExtensionRuntime: async () => {
      await delay(10)
      // mock 桥与原生保持同一份事实：能登记，不能运行
      return {
        supported: false,
        reason:
          '当前内核（CEF 150）已移除扩展运行 API：可以导入、解包并登记扩展清单，' +
          '但扩展的内容脚本与后台任务不会被内核执行',
        listManaged: true
      }
    },
    loadUnpackedExtension: async (path) => {
      await delay(300)
      const ext: ExtensionInfo = {
        id: uid('ext', ++store.seq),
        name: '新加载的已解压扩展（示例）',
        version: '0.1.0',
        description: '（mock）由本地目录加载',
        path: path ?? 'D:\\extensions\\my-extension',
        fromCrx: false,
        enabled: true,
        permissions: ['当前标签页']
      }
      store.extensions = [...store.extensions, ext]
      emitter.emit('extensionsChanged', clone(store.extensions))
      return clone(ext)
    },
    loadCrx: async (path) => {
      await delay(300)
      const ext: ExtensionInfo = {
        id: uid('ext', ++store.seq),
        name: '新加载的 .crx 扩展（示例）',
        version: '0.1.0',
        description: '（mock）由 .crx 解包加载',
        path: path ?? 'D:\\crx\\example.crx',
        fromCrx: true,
        enabled: true,
        permissions: ['所有网站']
      }
      store.extensions = [...store.extensions, ext]
      emitter.emit('extensionsChanged', clone(store.extensions))
      return clone(ext)
    },
    removeExtension: async (id) => {
      await delay(120)
      store.extensions = store.extensions.filter((e) => e.id !== id)
      emitter.emit('extensionsChanged', clone(store.extensions))
      return { ok: true }
    },
    setExtensionEnabled: async (id, on) => {
      await delay(80)
      store.extensions = store.extensions.map((e) => (e.id === id ? { ...e, enabled: on } : e))
      emitter.emit('extensionsChanged', clone(store.extensions))
      return { ok: true }
    },

    // ---- AI 模型连接 ----
    getAiConnection: async () => {
      await delay(40)
      return clone(store.ai)
    },
    setAiConnection: async (patch) => {
      await delay(40)
      store.ai = { ...store.ai, ...patch, mcpServers: patch.mcpServers ?? store.ai.mcpServers }
      return clone(store.ai)
    },
    testAiConnection: async (): Promise<AiTestResult> => {
      const t0 = performance.now()
      await delay(820)
      if (store.ai.method === 'apiKey' && !store.ai.apiKeyMask) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - t0),
          message: '连接失败：尚未填写 API Key。',
          detail: 'HTTP 401 Unauthorized（mock）'
        }
      }
      if (store.ai.method === 'mcp') {
        const online = store.ai.mcpServers.filter((s) => s.enabled && s.status === 'connected').length
        if (!online) {
          return {
            ok: false,
            latencyMs: Math.round(performance.now() - t0),
            message: '连接失败：没有处于「已连接」状态的 MCP 服务器。',
            detail: 'mock：请先在下方列表中添加并启用服务器'
          }
        }
      }
      if (store.ai.method === 'oauth' && !store.ai.oauth.signedIn) {
        return {
          ok: false,
          latencyMs: Math.round(performance.now() - t0),
          message: '连接失败：尚未完成第三方授权登录。',
          detail: 'mock：点击「使用 SDK 登录」后重试'
        }
      }
      return {
        ok: true,
        latencyMs: Math.round(performance.now() - t0),
        message:
          store.ai.method === 'apiKey'
            ? `连接成功，模型 ${store.ai.model} 可用（mock，0 计费）`
            : store.ai.method === 'mcp'
              ? '连接成功：MCP 服务器均可用（mock）'
              : '连接成功：第三方 SDK 授权有效（mock）'
      }
    },
    addMcpServer: async ({ name, transport, target }) => {
      await delay(300)
      const server: McpServer = {
        id: uid('mcp', ++store.seq),
        name,
        transport,
        target,
        enabled: true,
        status: 'connected',
        statusText: '已连接（mock）',
        toolCount: 2
      }
      store.ai = { ...store.ai, mcpServers: [...store.ai.mcpServers, server] }
      return clone(server)
    },
    removeMcpServer: async (id) => {
      await delay(120)
      store.ai = { ...store.ai, mcpServers: store.ai.mcpServers.filter((s) => s.id !== id) }
      return { ok: true }
    },
    checkMcpServer: async (id) => {
      await delay(650)
      let updated: McpServer | undefined
      store.ai = {
        ...store.ai,
        mcpServers: store.ai.mcpServers.map((s) => {
          if (s.id !== id) return s
          updated = {
            ...s,
            status: s.enabled ? 'connected' : 'disconnected',
            statusText: s.enabled ? `已连接（mock，${s.toolCount ?? 0} 个工具）` : '未启用'
          }
          return updated
        })
      }
      return clone(
        updated ?? {
          id,
          name: '未知服务器',
          transport: 'http',
          target: '',
          enabled: false,
          status: 'error',
          statusText: '服务器不存在'
        }
      )
    },

    // ---- AI 模式 ----
    getAiMode: async () => {
      await delay(40)
      return clone(store.aiMode)
    },
    setAiMode: async (mode: AiMode) => {
      await delay(120)
      const tools: Record<AiMode, string[]> = {
        browse: ['读取当前页面', '总结 / 翻译', '填表草稿', '书签与历史检索'],
        office: ['读写本机文档目录', '生成表格 / 幻灯片草稿', '整理会议纪要', '批量文件重命名'],
        dev: ['读取沙箱工作目录', '执行命令（需确认）', '抓包与网络分析', '运行代码检查']
      }
      store.aiMode = { ...store.aiMode, mode, tools: tools[mode] }
      pushState({ aiMode: mode })
      return clone(store.aiMode)
    },
    pickWorkdir: async () => {
      await delay(400)
      const path = 'D:\\work\\tibrowser-demo'
      store.aiMode = { ...store.aiMode, workdir: path }
      return { path }
    },
    setWorkdirAllowlist: async (list) => {
      await delay(60)
      store.aiMode = { ...store.aiMode, allowlist: list }
      return clone(store.aiMode)
    },

    // ---- AI 对话 ----
    aiChat: async (payload: AiChatPayload) => {
      await delay(30)
      const question = payload.messages.filter((m) => m.role === 'user').pop()?.content ?? ''
      streamReply(payload.requestId, question)
      return { requestId: payload.requestId }
    },
    aiAgent: async (payload) => {
      await delay(30)
      const question = payload.messages.filter((m) => m.role === 'user').pop()?.content ?? ''
      streamReply(payload.requestId, question)
      return { requestId: payload.requestId }
    },
    aiAbort: async (requestId) => {
      emitter.emit('aiDone', { requestId, content: '（已由用户中止）' })
      return { ok: true }
    },
    aiContext: async () => {
      await delay(60)
      return clone(MOCK_PAGE_CONTEXT)
    },

    // ---- 边车与自动化 ----
    serviceStatus: async () => {
      await delay(40)
      return clone(store.service)
    },
    automationInfo: async () => {
      await delay(40)
      return clone(store.automation)
    },
    setAutomationEnabled: async (enabled) => {
      await delay(160)
      store.automation = { ...store.automation, enabled }
      return clone(store.automation)
    },
    copyToClipboard: async (text) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        console.info('[tib-mock] 剪贴板不可用，已改为打印：', text)
      }
      return { ok: true }
    }
  }
}

/** 供调试面板使用的示例下载警告（`tib.__mockPrompt()`） */
export function mockDownloadPrompt(): DownloadPrompt {
  return {
    id: uid('dl', 1),
    filename: 'driver-booster-setup.exe',
    url: 'http://download-crack-setup.example/driver-booster-setup.exe',
    reason: '可执行文件，且来源域名未经验证',
    risk: 'high',
    totalBytes: 18_400_000
  }
}
