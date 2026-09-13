/**
 * 下载记录存储。
 *
 * v0.1.0 属于 Electron `session.on('will-download')`，v1.0.0 由原生侧下载，
 * 边车只负责**记录与查询**（native 通过 RPC `downloads.record` 回写进度）。
 */

import { randomUUID } from 'node:crypto'
import type { DownloadItem, DownloadState } from '../shared/types.js'
import { userDataFile } from '../paths.js'
import { JsonCollection } from './json-store.js'

/** 最多保留的下载记录条数 */
export const MAX_DOWNLOAD_ENTRIES = 500

const collection = new JsonCollection<DownloadItem>(
  () => userDataFile('downloads.json'),
  MAX_DOWNLOAD_ENTRIES
)

const VALID_STATES: DownloadState[] = ['progressing', 'completed', 'cancelled', 'interrupted']

export interface DownloadRecordInput {
  id?: string
  filename: string
  url: string
  savePath?: string
  receivedBytes?: number
  totalBytes?: number
  state?: DownloadState
  mimeType?: string
}

export const downloads = {
  /** 按开始时间倒序（同 id 的记录取最新一次写入） */
  list(limit = 200): DownloadItem[] {
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200
    const seen = new Set<string>()
    const out: DownloadItem[] = []
    // 后写入的覆盖先写入的（同 id 视为同一次下载的进度更新）
    for (const item of collection.all().slice().reverse()) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
    return out.slice(0, n)
  },

  /** 记录或更新一条下载；返回写入后的条目 */
  record(input: DownloadRecordInput): DownloadItem {
    const state: DownloadState = VALID_STATES.includes(input.state as DownloadState)
      ? (input.state as DownloadState)
      : 'completed'
    const item: DownloadItem = {
      id: input.id?.trim() || randomUUID(),
      filename: input.filename || '未命名文件',
      url: input.url ?? '',
      receivedBytes: Number.isFinite(input.receivedBytes) ? Number(input.receivedBytes) : 0,
      totalBytes: Number.isFinite(input.totalBytes) ? Number(input.totalBytes) : 0,
      state,
      savePath: input.savePath ?? '',
      ...(input.mimeType ? { mimeType: input.mimeType } : {})
    }
    collection.mutate((items) => [...items.filter((d) => d.id !== item.id), item])
    return item
  },

  /** 删除记录；返回是否删除成功 */
  remove(id: string): boolean {
    let removed = false
    collection.mutate((items) =>
      items.filter((d) => {
        if (d.id === id) {
          removed = true
          return false
        }
        return true
      })
    )
    return removed
  },

  clear(): void {
    collection.replace([])
  },

  invalidate(): void {
    collection.invalidate()
  }
}
