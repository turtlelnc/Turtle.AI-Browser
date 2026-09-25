/**
 * 原生宿主注入脚本（由 tib:// 资源处理器内联进外壳 UI 页面）
 *
 * 为什么不用 CEF 的 CefMessageRouter：本机实测在 TiBrowser 里创建
 * CefMessageRouterBrowserSide 会在启动期触发 CEF 内部断言
 * （cef_ref_counted.h:240 Check failed: !needs_adopt_ref_）导致进程直接退出。
 * 这里改用「渲染进程 console 消息」作为上行通道（原生侧在 OnConsoleMessage 里接收），
 * 下行回执用 ExecuteJavaScript —— 双向都只有一个入口，职责清晰且不依赖内部包装类。
 *
 * 本文件不引用任何 npm 依赖，构建为单文件 IIFE，可直接内联进 HTML。
 */

type Listener = (payload: unknown) => void

declare global {
  interface Window {
    tib?: unknown
    __TIB_BOOT__?: { skin?: string; theme?: string; perf?: string }
    __tibDeliverReply?: (id: number, ok: boolean, data?: string | null, error?: string) => void
    __tibDeliverEvent?: (name: string, payload: string) => void
  }
}

/** 上行消息前缀：必须与 native/src/window.cpp 的 kHostCallPrefix 保持一致 */
const CALL_PREFIX = '__TIB_CALL__'

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const listeners = new Map<string, Set<Listener>>()

function makeError(message: string): Error {
  return new Error(message || '原生调用失败')
}

/** 发送一次原生调用，等待原生通过 __tibDeliverReply 回执 */
function hostCall(method: string, params?: unknown): Promise<unknown> {
  const id = nextId++
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      // 上行：console.log 一个带前缀的单行 JSON；原生在 OnConsoleMessage 里解析
      console.log(CALL_PREFIX + JSON.stringify({ id, method, params: params ?? {} }))
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : makeError(String(err)))
    }
  })
}

/** 原生回执入口 */
window.__tibDeliverReply = (id, ok, data, error) => {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  if (!ok) {
    entry.reject(makeError(error || '原生调用失败'))
    return
  }
  if (data === undefined || data === null || data === '') {
    entry.resolve(undefined)
    return
  }
  try {
    entry.resolve(JSON.parse(data))
  } catch {
    entry.resolve(data)
  }
}

/** 原生事件投递入口 */
window.__tibDeliverEvent = (name, payload) => {
  let parsed: unknown
  if (payload) {
    try {
      parsed = JSON.parse(payload)
    } catch {
      parsed = payload
    }
  }
  const set = listeners.get(name)
  if (!set) return
  for (const cb of Array.from(set)) {
    try {
      cb(parsed)
    } catch (err) {
      // 单个订阅者报错不应影响其他订阅者
      console.error('[TiBrowser] 事件处理出错：', name, err)
    }
  }
}

/** UI 调用名 → 原生方法名（两套命名各有用途，这里显式列出避免猜错） */
const METHOD_ALIASES: Record<string, string> = {
  getState: 'state.get',
  newTab: 'tabs.new',
  closeTab: 'tabs.close',
  activateTab: 'tabs.activate',
  moveTab: 'tabs.move',
  navigate: 'nav.go',
  goBack: 'nav.back',
  goForward: 'nav.forward',
  reload: 'nav.reload',
  stop: 'nav.stop',
  goHome: 'nav.home',
  setZoom: 'view.zoom',
  zoomIn: 'view.zoomIn',
  zoomOut: 'view.zoomOut',
  zoomReset: 'view.zoomReset',
  findInPage: 'view.find',
  findStop: 'view.findStop',
  setFindOpen: 'view.setFindOpen',
  setOverlay: 'view.setOverlay',
  toggleSidebar: 'view.toggleSidebar',
  setSidebarWidth: 'view.setSidebarWidth',
  toggleBookmarkBar: 'view.toggleBookmarkBar',
  windowAction: 'window.action',
  popupMenu: 'window.popupMenu',
  getSettings: 'settings.get',
  setSettings: 'settings.set',
  setApiKey: 'settings.setApiKey',
  getSecurityReport: 'security.report',
  /** 安全档位的当前值由 security.report 一并返回（原生侧无需单独方法） */
  getProtectionLevel: 'security.report',
  setProtectionLevel: 'settings.setProtectionLevel',
  getFingerprintProfile: 'fingerprint.get',
  setFingerprintProfile: 'fingerprint.set',
  randomizeFingerprint: 'fingerprint.randomize',
  getEnergyMode: 'energy.get',
  setEnergyMode: 'settings.setEnergyMode',
  getSkin: 'skin.get',
  setSkin: 'settings.setSkin',
  serviceStatus: 'service.status',
  automationInfo: 'automation.info',
  setAutomationEnabled: 'automation.setEnabled',
  copyToClipboard: 'copy.clipboard',
  proceed: 'nav.proceed',
  getBookmarks: 'bookmarks.list',
  addBookmark: 'bookmarks.add',
  removeBookmark: 'bookmarks.remove',
  toggleBookmark: 'bookmarks.toggle',
  getHistory: 'history.list',
  clearHistory: 'history.clear',
  removeHistory: 'history.remove',
  getDownloads: 'downloads.list',
  openDownload: 'downloads.open',
  openDownloadFolder: 'downloads.openFolder',
  resolveDownloadPrompt: 'downloads.resolvePrompt',
  omniboxSuggest: 'omnibox.suggest',
  getInstalledApps: 'apps.list',
  installWebApp: 'apps.install',
  uninstallWebApp: 'apps.uninstall',
  launchWebApp: 'apps.launch',
  getAccounts: 'accounts.list',
  signIn: 'accounts.signIn',
  signOut: 'accounts.signOut',
  getSyncState: 'sync.state',
  setSyncToggles: 'sync.setToggles',
  setSyncEnabled: 'sync.setEnabled',
  syncNow: 'sync.now',
  profileExport: 'profile.export',
  profileImport: 'profile.import',
  getExtensions: 'extensions.list',
  getExtensionRuntime: 'extensions.runtime',
  loadUnpackedExtension: 'extensions.loadUnpacked',
  loadCrx: 'extensions.loadCrx',
  removeExtension: 'extensions.remove',
  setExtensionEnabled: 'extensions.setEnabled',
  getAiConnection: 'ai.connection',
  setAiConnection: 'ai.setConnection',
  testAiConnection: 'ai.test',
  addMcpServer: 'ai.mcp.addServer',
  removeMcpServer: 'ai.mcp.removeServer',
  /** 边车只提供 ai.mcp.listServers，连通性检查在列表里一并返回 */
  checkMcpServer: 'ai.mcp.listServers',
  getAiMode: 'ai.modes.list',
  setAiMode: 'ai.modes.set',
  pickWorkdir: 'ai.modes.devStatus',
  setWorkdirAllowlist: 'ai.modes.devStatus',
  aiChat: 'ai.chat',
  aiAgent: 'ai.agent',
  aiAbort: 'ai.abort',
  aiContext: 'ai.context'
}

/** 单标量参数按方法名推断字段名 */
function normalizeParams(uiName: string, arg: unknown): unknown {
  if (arg === undefined || arg === null) return {}
  if (typeof arg === 'object') return arg
  const scalarFields: Record<string, string> = {
    navigate: 'input',
    newTab: 'input',
    closeTab: 'tabId',
    activateTab: 'tabId',
    findInPage: 'text',
    setZoom: 'level',
    windowAction: 'action',
    setProtectionLevel: 'level',
    setSkin: 'skin',
    setEnergyMode: 'mode',
    setOverlay: 'name',
    omniboxSuggest: 'query',
    aiAbort: 'requestId',
    removeBookmark: 'id',
    removeHistory: 'id',
    removeExtension: 'id',
    removeMcpServer: 'id',
    openDownload: 'id',
    resolveDownloadPrompt: 'id'
  }
  const field = scalarFields[uiName]
  return field ? { [field]: arg } : { value: arg }
}

function makeBridge() {
  const bridge: Record<string, unknown> = {}

  bridge.on = (event: string, cb: Listener) => {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
    }
  }
  bridge.off = (event: string, cb: Listener) => {
    listeners.get(event)?.delete(cb)
  }
  bridge.appInfo = () => hostCall('app.info')

  for (const [uiName, hostMethod] of Object.entries(METHOD_ALIASES)) {
    bridge[uiName] = (arg?: unknown) => hostCall(hostMethod, normalizeParams(uiName, arg))
  }

  // 未登记的调用名：按 "动词.其余小驼峰" 兜底转换，新增方法不必改本文件
  return new Proxy(bridge, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target]
      if (typeof prop !== 'string' || prop.startsWith('__')) return undefined
      const m = /^(get|set|add|remove|toggle|open|close|install|uninstall|launch|list|check|test|pick|copy|resolve|clear|randomize|sign)([A-Z].*)$/.exec(
        prop
      )
      const hostMethod = m
        ? `${m[1]}.${m[2].charAt(0).toLowerCase()}${m[2].slice(1)}`
        : prop
      return (arg?: unknown) => hostCall(hostMethod, normalizeParams(prop, arg))
    }
  })
}

window.tib = makeBridge()

export {}
