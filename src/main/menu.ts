import { app, dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { APP_NAME, APP_VERSION, IPC } from '@shared/constants'
import { bookmarks } from './store'
import { broadcastToAll, createWindow, getActiveSession, getActiveWindow } from './windows'

/** 向活动窗口的渲染进程发送 UI 命令 */
function sendUi(command: string): void {
  const win = getActiveWindow()
  if (win) win.webContents.send(IPC.uiCommand, command)
}

function showAbout(): void {
  const win = getActiveWindow()
  const opts = {
    type: 'info' as const,
    title: `关于 ${APP_NAME}`,
    message: APP_NAME,
    detail: `版本 ${APP_VERSION}\n基于 Chromium 内核的 AI 安全浏览器。\nAI 由用户自备的 OpenAI 兼容 API 驱动；本地安全服务实时拦截钓鱼、恶意与追踪。`,
    buttons: ['确定']
  }
  if (win) void dialog.showMessageBox(win, opts).catch(() => {})
  else void dialog.showMessageBox(opts).catch(() => {})
}

function buildTemplate(): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'
  return [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建标签页', accelerator: 'CmdOrCtrl+T', click: () => getActiveSession()?.createTab() },
        { label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: () => createWindow(false) },
        { label: '新建无痕窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow(true) },
        { type: 'separator' },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => getActiveSession()?.closeActiveTab() },
        { label: '关闭窗口', accelerator: 'CmdOrCtrl+Shift+W', click: () => getActiveWindow()?.close() },
        { type: 'separator' },
        { label: '下载内容', accelerator: 'CmdOrCtrl+J', click: () => getActiveSession()?.openOverlay('downloads') },
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => getActiveSession()?.openOverlay('settings') },
        { type: 'separator' },
        isMac ? { role: 'quit', label: '退出' } : { label: '退出', click: () => app.quit() }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => getActiveSession()?.reload() },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => getActiveSession()?.zoomIn() },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => getActiveSession()?.zoomOut() },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => getActiveSession()?.zoomReset() },
        { type: 'separator' },
        { label: '页内查找', accelerator: 'CmdOrCtrl+F', click: () => sendUi('open-find') },
        { label: '聚焦地址栏', accelerator: 'CmdOrCtrl+L', click: () => sendUi('focus-omnibox') },
        { label: '切换 AI 侧边栏', accelerator: 'CmdOrCtrl+Shift+A', click: () => getActiveSession()?.toggleSidebar() },
        { label: '切换书签栏', accelerator: 'CmdOrCtrl+Shift+B', click: () => getActiveSession()?.toggleBookmarkBar() },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '历史记录',
      submenu: [
        { label: '后退', accelerator: 'Alt+Left', click: () => getActiveSession()?.goBack() },
        { label: '前进', accelerator: 'Alt+Right', click: () => getActiveSession()?.goForward() },
        { label: '主页', accelerator: 'Alt+Home', click: () => getActiveSession()?.goHome() },
        { type: 'separator' },
        { label: '显示历史记录', accelerator: 'CmdOrCtrl+H', click: () => getActiveSession()?.openOverlay('history') }
      ]
    },
    {
      label: '书签',
      submenu: [
        {
          label: '为此页添加书签',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            const s = getActiveSession()
            if (s) {
              s.toggleActiveBookmark()
              broadcastToAll(IPC.bookmarksChanged, bookmarks.list())
            }
          }
        },
        { type: 'separator' },
        { label: '书签管理器', accelerator: 'CmdOrCtrl+Shift+O', click: () => getActiveSession()?.openOverlay('bookmarks') }
      ]
    },
    {
      label: '帮助',
      submenu: [{ label: `关于 ${APP_NAME}`, click: () => showAbout() }]
    }
  ]
}

/** 设置应用菜单（快捷键通过菜单 accelerator 全局生效） */
export function buildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate()))
}

/** 供工具栏「⋮」按钮弹出同一份菜单 */
export function popupAppMenu(win: BrowserWindow): void {
  Menu.buildFromTemplate(buildTemplate()).popup({ window: win })
}
