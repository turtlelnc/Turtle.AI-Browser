import { app, BrowserWindow, nativeTheme } from 'electron'
import { initStores, store } from './store'
import { initSecurity } from './security'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { createWindow } from './windows'
import { loadPersistedExtensions } from './extensions'

// 单实例锁：重复启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0] ?? createWindow(false)
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.tibrowser.app')
    initStores()
    nativeTheme.themeSource = store.getSettings().appearance.theme
    initSecurity()
    registerIpc()
    buildMenu()
    loadPersistedExtensions()
    createWindow(false)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(false)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
