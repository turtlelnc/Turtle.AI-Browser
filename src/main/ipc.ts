import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/constants'
import type { AgentMessage, AiChatRequest, Settings } from '@shared/types'
import { isUrlLike, resolveNavigationInput } from '@shared/utils'
import { bookmarks, history, store } from './store'
import { allSessions, broadcastToAll, getSessionByWindowId } from './windows'
import { popupAppMenu } from './menu'
import { chatStream, validateAiConfig } from './ai/client'
import { runAgent } from './ai/agent'
import { scanUrl } from './security'
import { listDownloads, openDownload, revealDownload } from './downloads'
import {
  listExtensions,
  loadCrxExtension,
  loadUnpackedExtension,
  removeExtension
} from './extensions'
import { exportProfile, importProfile } from './profile-sync'
import type { BrowserSession } from './browser-session'

function sessionOf(event: Electron.IpcMainInvokeEvent): BrowserSession | undefined {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win ? getSessionByWindowId(win.id) : undefined
}

/** 活跃的 AI 流式请求，用于中断 */
const activeChats = new Map<string, AbortController>()

export function registerIpc(): void {
  // ---- 状态与标签页 ----
  ipcMain.handle(IPC.getState, (e) => sessionOf(e)?.getState())
  ipcMain.handle(IPC.newTab, (e, url?: string) => sessionOf(e)?.createTab(url ?? ''))
  ipcMain.handle(IPC.closeTab, (e, id: string) => sessionOf(e)?.closeTab(id))
  ipcMain.handle(IPC.activateTab, (e, id: string) => sessionOf(e)?.activateTab(id))
  ipcMain.handle(IPC.moveTab, (e, fromId: string, toIndex: number) =>
    sessionOf(e)?.moveTab(fromId, toIndex)
  )

  // ---- 导航 ----
  ipcMain.handle(IPC.navigate, (e, input: string) => sessionOf(e)?.navigate(input))
  ipcMain.handle(IPC.goBack, (e) => sessionOf(e)?.goBack())
  ipcMain.handle(IPC.goForward, (e) => sessionOf(e)?.goForward())
  ipcMain.handle(IPC.reload, (e) => sessionOf(e)?.reload())
  ipcMain.handle(IPC.stop, (e) => sessionOf(e)?.stop())
  ipcMain.handle(IPC.goHome, (e) => sessionOf(e)?.goHome())
  ipcMain.handle(IPC.setZoom, (e, level: number) => sessionOf(e)?.setZoom(level))
  ipcMain.handle(IPC.proceed, (e) => sessionOf(e)?.proceed())

  // ---- 窗口 ----
  ipcMain.handle(IPC.minimize, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle(IPC.maximize, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle(IPC.closeWindow, (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  // ---- UI ----
  ipcMain.handle(IPC.toggleSidebar, (e) => sessionOf(e)?.toggleSidebar())
  ipcMain.handle(IPC.setSidebarWidth, (e, w: number) => sessionOf(e)?.setSidebarWidth(w))
  ipcMain.handle(IPC.toggleBookmarkBar, (e) => sessionOf(e)?.toggleBookmarkBar())
  ipcMain.handle(IPC.openOverlay, (e, name) => sessionOf(e)?.openOverlay(name))
  ipcMain.handle(IPC.menuPopup, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) popupAppMenu(w)
  })

  // ---- 页内查找 ----
  ipcMain.handle(IPC.findInPage, (e, text: string) => sessionOf(e)?.findInPage(text))
  ipcMain.handle(IPC.findStop, (e) => sessionOf(e)?.stopFind())
  ipcMain.handle(IPC.setFindOpen, (e, open: boolean) => sessionOf(e)?.setFindOpen(open))

  // ---- 地址栏联想 ----
  ipcMain.handle(IPC.omniboxQuery, (_e, q: string) => {
    const engine = store.getSettings().searchEngine
    const result: { text: string; type: 'history' | 'search' | 'url'; url: string; title?: string }[] = []
    if (q.trim() && !isUrlLike(q)) {
      result.push({
        text: q,
        type: 'search',
        url: resolveNavigationInput(q, engine),
        title: `使用 ${engine} 搜索`
      })
    }
    for (const h of history.search(q, 6)) {
      result.push({ text: h.url, type: 'history', url: h.url, title: h.title })
    }
    return result
  })

  // ---- 书签 ----
  ipcMain.handle(IPC.bookmarksList, () => bookmarks.list())
  ipcMain.handle(IPC.bookmarkAdd, (_e, title: string, url: string, folder?: string) => {
    const node = bookmarks.add(title, url, folder)
    broadcastToAll(IPC.bookmarksChanged, bookmarks.list())
    return node
  })
  ipcMain.handle(IPC.bookmarkRemove, (_e, id: string) => {
    bookmarks.remove(id)
    broadcastToAll(IPC.bookmarksChanged, bookmarks.list())
  })
  ipcMain.handle(IPC.bookmarkToggle, (_e, title: string, url: string) => {
    const added = bookmarks.toggle(title, url)
    broadcastToAll(IPC.bookmarksChanged, bookmarks.list())
    return added
  })

  // ---- 历史 ----
  ipcMain.handle(IPC.historyList, () => history.list())
  ipcMain.handle(IPC.historyClear, () => history.clear())
  ipcMain.handle(IPC.historyRemove, (_e, id: string) => history.remove(id))

  // ---- 下载 ----
  ipcMain.handle(IPC.downloadsList, () => listDownloads())
  ipcMain.handle(IPC.downloadsOpenFolder, (_e, id: string) => revealDownload(id))
  ipcMain.handle(IPC.downloadsOpen, (_e, id: string) => openDownload(id))

  // ---- 设置 ----
  ipcMain.handle(IPC.settingsGet, () => store.getSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => {
    const s = store.setSettings(patch)
    nativeTheme.themeSource = s.appearance.theme
    for (const session of allSessions()) session.sync()
    return s
  })
  ipcMain.handle(IPC.setApiKey, (_e, key: string) => {
    store.setApiKey(key)
    return store.getSettings()
  })

  // ---- AI ----
  ipcMain.handle(IPC.aiChat, (e, req: AiChatRequest) => {
    const sender = e.sender
    const cfg = { ...store.getSettings().ai, apiKey: store.getApiKey() }
    const err = validateAiConfig(cfg)
    if (err) {
      sender.send(IPC.aiError, { requestId: req.requestId, message: err })
      return
    }
    const controller = chatStream(
      cfg,
      [{ role: 'system', content: cfg.systemPrompt }, ...req.messages],
      {
        onChunk: (delta) => sender.send(IPC.aiChunk, { requestId: req.requestId, delta }),
        onDone: (content) => {
          activeChats.delete(req.requestId)
          sender.send(IPC.aiDone, { requestId: req.requestId, content })
        },
        onError: (message) => {
          activeChats.delete(req.requestId)
          sender.send(IPC.aiError, { requestId: req.requestId, message })
        }
      }
    )
    activeChats.set(req.requestId, controller)
  })

  ipcMain.handle(IPC.aiAbort, (_e, requestId: string) => {
    activeChats.get(requestId)?.abort()
    activeChats.delete(requestId)
  })

  ipcMain.handle(IPC.aiContext, async (e) => {
    const session = sessionOf(e)
    if (!session) return null
    const st = session.getState()
    const active = st.tabs.find((t) => t.id === st.activeTabId)
    return {
      title: active?.title ?? '',
      url: active?.url ?? '',
      text: await session.extractPageText(),
      selectedText: await session.getSelectedText()
    }
  })

  ipcMain.handle(IPC.aiAgent, async (e, req: { requestId: string; messages: AgentMessage[] }) => {
    const sender = e.sender
    const session = sessionOf(e)
    if (!session) return
    const cfg = { ...store.getSettings().ai, apiKey: store.getApiKey() }
    const err = validateAiConfig(cfg)
    if (err) {
      sender.send(IPC.aiError, { requestId: req.requestId, message: err })
      return
    }
    const history = req.messages.slice(0, -1)
    const last = req.messages[req.messages.length - 1]
    const userMessage = last?.content ?? ''
    const controller = new AbortController()
    activeChats.set(req.requestId, controller)
    try {
      await runAgent(
        cfg,
        cfg.cliPermission,
        history,
        userMessage,
        { session },
        {
          onContent: (text) => sender.send(IPC.aiChunk, { requestId: req.requestId, delta: text }),
          onTool: (name, detail) =>
            sender.send(IPC.aiTool, { requestId: req.requestId, name, detail })
        },
        controller.signal
      )
      sender.send(IPC.aiDone, { requestId: req.requestId, content: '' })
    } catch (e) {
      sender.send(IPC.aiError, { requestId: req.requestId, message: String((e as Error).message || e) })
    } finally {
      activeChats.delete(req.requestId)
    }
  })

  ipcMain.handle(IPC.aiSummarize, async (e, requestId?: string) => {
    const sender = e.sender
    const session = sessionOf(e)
    if (!session) return
    const cfg = { ...store.getSettings().ai, apiKey: store.getApiKey() }
    const reqId = requestId || randomUUID()
    const err = validateAiConfig(cfg)
    if (err) {
      sender.send(IPC.aiError, { requestId: reqId, message: err })
      return
    }
    const st = session.getState()
    const active = st.tabs.find((t) => t.id === st.activeTabId)
    const text = await session.extractPageText()
    const prompt = [
      '请用中文对以下网页内容进行要点总结，简洁清晰，使用项目符号。',
      '',
      `【标题】${active?.title ?? ''}`,
      `【网址】${active?.url ?? ''}`,
      '',
      '【正文】',
      text || '（未能提取到正文内容）'
    ].join('\n')

    const controller = chatStream(cfg, [{ role: 'user', content: prompt }], {
      onChunk: (delta) => sender.send(IPC.aiChunk, { requestId: reqId, delta }),
      onDone: (content) => {
        activeChats.delete(reqId)
        sender.send(IPC.aiDone, { requestId: reqId, content })
      },
      onError: (message) => {
        activeChats.delete(reqId)
        sender.send(IPC.aiError, { requestId: reqId, message })
      }
    })
    activeChats.set(reqId, controller)
  })

  // ---- 安全 ----
  ipcMain.handle(IPC.checkUrl, (_e, url: string) => scanUrl(url))

  // ---- 扩展程序 ----
  ipcMain.handle(IPC.extensionsList, () => listExtensions())
  ipcMain.handle(IPC.extensionLoadUnpacked, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    try {
      const info = await loadUnpackedExtension(win)
      broadcastToAll(IPC.extensionsChanged, listExtensions())
      return info
    } catch (err) {
      if ((err as Error).message !== '已取消') {
        await dialog.showMessageBox(win, {
          type: 'error',
          title: '加载失败',
          message: String((err as Error).message),
          buttons: ['确定']
        })
      }
      return null
    }
  })
  ipcMain.handle(IPC.extensionLoadCrx, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    try {
      const info = await loadCrxExtension(win)
      broadcastToAll(IPC.extensionsChanged, listExtensions())
      return info
    } catch (err) {
      if ((err as Error).message !== '已取消') {
        await dialog.showMessageBox(win, {
          type: 'error',
          title: '加载失败',
          message: String((err as Error).message),
          buttons: ['确定']
        })
      }
      return null
    }
  })
  ipcMain.handle(IPC.extensionRemove, async (_e, id: string) => {
    await removeExtension(id)
    broadcastToAll(IPC.extensionsChanged, listExtensions())
  })

  // ---- 配置文件同步 ----
  ipcMain.handle(IPC.profileExport, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    try {
      const result = await exportProfile(win)
      await dialog.showMessageBox(win, {
        type: 'info',
        title: '导出成功',
        message: `配置文件已导出`,
        detail: `位置：${result.path}\n大小：${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB\n在另一台电脑上用「导入配置文件」即可恢复。`,
        buttons: ['确定']
      })
      return result
    } catch (err) {
      if ((err as Error).message !== '已取消') {
        await dialog.showMessageBox(win, {
          type: 'error',
          title: '导出失败',
          message: String((err as Error).message),
          buttons: ['确定']
        })
      }
      return null
    }
  })
  ipcMain.handle(IPC.profileImport, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    try {
      const ok = await importProfile(win)
      if (ok) {
        await dialog.showMessageBox(win, {
          type: 'info',
          title: '导入成功',
          message: '配置文件已导入，应用即将重启以生效。',
          detail: '注意：API Key 因本机加密机制无法跨电脑解密，重启后需重新填写。',
          buttons: ['确定']
        })
        app.relaunch()
        app.exit(0)
      }
      return true
    } catch (err) {
      if ((err as Error).message !== '已取消') {
        await dialog.showMessageBox(win, {
          type: 'error',
          title: '导入失败',
          message: String((err as Error).message),
          buttons: ['确定']
        })
      }
      return false
    }
  })
}
