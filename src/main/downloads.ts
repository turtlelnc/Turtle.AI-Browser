import { app, BrowserWindow, dialog, shell, type Session } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/constants'
import type { DownloadItem, DownloadState } from '@shared/types'
import { store } from './store'

const items = new Map<string, DownloadItem>()

/** 可疑可执行文件扩展名 */
const DANGEROUS_EXT = /\.(exe|msi|bat|cmd|scr|ps1|vbs|js|jar|com|pif|reg|hta|dll)$/i

function toState(s: string): DownloadState {
  return (['progressing', 'completed', 'cancelled', 'interrupted'] as const).includes(
    s as DownloadState
  )
    ? (s as DownloadState)
    : 'interrupted'
}

function broadcast(item: DownloadItem): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.downloadProgress, item)
  }
}

export function listDownloads(): DownloadItem[] {
  return [...items.values()].sort((a, b) => b.id.localeCompare(a.id))
}

/** 注册下载事件到浏览会话 */
export function registerDownloads(session: Session): void {
  session.on('will-download', (event, item, webContents) => {
    const filename = item.getFilename()
    const url = item.getURL()

    // 可疑下载拦截
    if (store.getSettings().security.blockSuspiciousDownloads && DANGEROUS_EXT.test(filename)) {
      event.preventDefault()
      const win = BrowserWindow.fromWebContents(webContents)
      const opts = {
        type: 'warning' as const,
        title: '已拦截可疑下载',
        message: `已拦截可疑下载：${filename}`,
        detail: '该文件类型可能包含恶意代码。TIbrowser 已为你阻止此下载。',
        buttons: ['知道了']
      }
      if (win) void dialog.showMessageBox(win, opts).catch(() => {})
      else void dialog.showMessageBox(opts).catch(() => {})
      return
    }

    const id = randomUUID()
    const entry: DownloadItem = {
      id,
      filename,
      url,
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      state: 'progressing',
      savePath: '',
      mimeType: item.getMimeType()
    }
    item.setSavePath(join(app.getPath('downloads'), filename))
    items.set(id, entry)
    broadcast(entry)

    item.on('updated', (_e, state) => {
      entry.receivedBytes = item.getReceivedBytes()
      entry.totalBytes = item.getTotalBytes()
      entry.state = toState(state)
      broadcast(entry)
    })

    item.once('done', (_e, state) => {
      entry.receivedBytes = item.getReceivedBytes()
      entry.state = toState(state)
      entry.savePath = item.getSavePath()
      broadcast(entry)
    })
  })
}

export async function openDownload(id: string): Promise<string> {
  const item = items.get(id)
  if (!item?.savePath) return '文件不存在'
  const err = await shell.openPath(item.savePath)
  return err
}

export function revealDownload(id: string): void {
  const item = items.get(id)
  if (item?.savePath) shell.showItemInFolder(item.savePath)
}
