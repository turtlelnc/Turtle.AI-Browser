import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/constants'
import type { TibrowserApi } from '@shared/api'

/** 生成一个事件订阅函数，返回取消订阅函数 */
function subscribe<T>(channel: string): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api: TibrowserApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: subscribe(IPC.stateUpdated),

  newTab: (url) => ipcRenderer.invoke(IPC.newTab, url),
  closeTab: (id) => ipcRenderer.invoke(IPC.closeTab, id),
  activateTab: (id) => ipcRenderer.invoke(IPC.activateTab, id),
  moveTab: (fromId, toIndex) => ipcRenderer.invoke(IPC.moveTab, fromId, toIndex),

  navigate: (input) => ipcRenderer.invoke(IPC.navigate, input),
  goBack: () => ipcRenderer.invoke(IPC.goBack),
  goForward: () => ipcRenderer.invoke(IPC.goForward),
  reload: () => ipcRenderer.invoke(IPC.reload),
  stop: () => ipcRenderer.invoke(IPC.stop),
  goHome: () => ipcRenderer.invoke(IPC.goHome),
  setZoom: (level) => ipcRenderer.invoke(IPC.setZoom, level),
  proceed: () => ipcRenderer.invoke(IPC.proceed),

  minimize: () => ipcRenderer.invoke(IPC.minimize),
  maximize: () => ipcRenderer.invoke(IPC.maximize),
  closeWindow: () => ipcRenderer.invoke(IPC.closeWindow),
  onWindowState: subscribe(IPC.windowStateChanged),

  toggleSidebar: () => ipcRenderer.invoke(IPC.toggleSidebar),
  setSidebarWidth: (w) => ipcRenderer.invoke(IPC.setSidebarWidth, w),
  toggleBookmarkBar: () => ipcRenderer.invoke(IPC.toggleBookmarkBar),
  openOverlay: (name) => ipcRenderer.invoke(IPC.openOverlay, name),
  onUiCommand: subscribe(IPC.uiCommand),
  popupMenu: () => ipcRenderer.invoke(IPC.menuPopup),

  omniboxQuery: (q) => ipcRenderer.invoke(IPC.omniboxQuery, q),

  bookmarks: {
    list: () => ipcRenderer.invoke(IPC.bookmarksList),
    add: (title, url, folder) => ipcRenderer.invoke(IPC.bookmarkAdd, title, url, folder),
    remove: (id) => ipcRenderer.invoke(IPC.bookmarkRemove, id),
    toggle: (title, url) => ipcRenderer.invoke(IPC.bookmarkToggle, title, url),
    onChange: subscribe(IPC.bookmarksChanged)
  },

  history: {
    list: () => ipcRenderer.invoke(IPC.historyList),
    clear: () => ipcRenderer.invoke(IPC.historyClear),
    remove: (id) => ipcRenderer.invoke(IPC.historyRemove, id)
  },

  downloads: {
    list: () => ipcRenderer.invoke(IPC.downloadsList),
    openFolder: (id) => ipcRenderer.invoke(IPC.downloadsOpenFolder, id),
    open: (id) => ipcRenderer.invoke(IPC.downloadsOpen, id),
    onProgress: subscribe(IPC.downloadProgress)
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    setApiKey: (key) => ipcRenderer.invoke(IPC.setApiKey, key)
  },

  ai: {
    chat: (req) => ipcRenderer.invoke(IPC.aiChat, req),
    agent: (req) => ipcRenderer.invoke(IPC.aiAgent, req),
    abort: (requestId) => ipcRenderer.invoke(IPC.aiAbort, requestId),
    summarize: (requestId) => ipcRenderer.invoke(IPC.aiSummarize, requestId),
    context: () => ipcRenderer.invoke(IPC.aiContext),
    onChunk: subscribe(IPC.aiChunk),
    onDone: subscribe(IPC.aiDone),
    onError: subscribe(IPC.aiError),
    onTool: subscribe(IPC.aiTool)
  },

  find: {
    inPage: (text) => ipcRenderer.invoke(IPC.findInPage, text),
    stop: () => ipcRenderer.invoke(IPC.findStop),
    setOpen: (open) => ipcRenderer.invoke(IPC.setFindOpen, open),
    onResult: subscribe(IPC.findResult)
  },

  checkUrl: (url) => ipcRenderer.invoke(IPC.checkUrl, url),

  extensions: {
    list: () => ipcRenderer.invoke(IPC.extensionsList),
    loadUnpacked: () => ipcRenderer.invoke(IPC.extensionLoadUnpacked),
    loadCrx: () => ipcRenderer.invoke(IPC.extensionLoadCrx),
    remove: (id) => ipcRenderer.invoke(IPC.extensionRemove, id),
    onChange: subscribe(IPC.extensionsChanged)
  },

  profile: {
    export: () => ipcRenderer.invoke(IPC.profileExport),
    import: () => ipcRenderer.invoke(IPC.profileImport)
  }
}

contextBridge.exposeInMainWorld('tibrowser', api)
