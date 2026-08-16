import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { APP_NAME, IPC } from '@shared/constants'
import { BrowserSession } from './browser-session'
import { store } from './store'
import { registerDownloads } from './downloads'
import { attachWebGuard } from './security'
import { attachCapture } from './network-capture'

interface WinInstance {
  win: BrowserWindow
  session: BrowserSession
}

const instances = new Map<number, WinInstance>()

/** 创建浏览器窗口（可选无痕模式） */
export function createWindow(incognito = false): BrowserWindow {
  const settings = store.getSettings()
  const frosted = settings.appearance.frostedGlass && process.platform === 'win32'

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    frame: false, // 自定义标题栏，实现 Chrome 风格
    thickFrame: true, // 保留 Windows 原生缩放 / 吸附 / 阴影
    show: false,
    title: APP_NAME,
    backgroundMaterial: frosted ? 'acrylic' : 'none',
    backgroundColor: frosted ? '#00000000' : '#1b1b1f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  const session = new BrowserSession(win, incognito)
  attachWebGuard(session.session)
  registerDownloads(session.session)
  if (!incognito) attachCapture(session.session)
  instances.set(win.id, { win, session })

  win.on('resize', () => session.sync())
  win.on('maximize', () => win.webContents.send(IPC.windowStateChanged, { isMaximized: true }))
  win.on('unmaximize', () => win.webContents.send(IPC.windowStateChanged, { isMaximized: false }))
  win.on('closed', () => instances.delete(win.id))

  // UI 里的外链一律交给系统默认浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())
  return win
}

export function getSessionByWindowId(id: number): BrowserSession | undefined {
  return instances.get(id)?.session
}

export function getActiveSession(): BrowserSession | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) return instances.get(focused.id)?.session
  return instances.values().next().value?.session
}

export function getActiveWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && instances.has(focused.id)) return focused
  return instances.values().next().value?.win
}

export function allSessions(): BrowserSession[] {
  return [...instances.values()].map((i) => i.session)
}

export function broadcastToAll(channel: string, payload: unknown): void {
  for (const { win } of instances.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function closeAllWindows(): void {
  for (const { win } of instances.values()) win.destroy()
  instances.clear()
}
