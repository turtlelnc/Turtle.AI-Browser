/**
 * 浏览历史存储（无 Electron 版本，移植自 `src/main/store/history.ts`）。
 * 数据文件：`<userData>/history.json`，上限 2000 条，去重保留最新。
 */

import { randomUUID } from 'node:crypto'
import type { HistoryItem } from '../shared/types.js'
import { userDataFile } from '../paths.js'
import { JsonCollection } from './json-store.js'

/** 历史记录上限，超出后裁剪最旧条目 */
export const MAX_HISTORY_ENTRIES = 2000

const collection = new JsonCollection<HistoryItem>(
  () => userDataFile('history.json'),
  MAX_HISTORY_ENTRIES
)

export const history = {
  list(limit = 500): HistoryItem[] {
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500
    return collection
      .all()
      .slice()
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, n)
  },

  /** 记录一次访问；内部地址（tibrowser:// 等）不入库 */
  add(title: string, url: string, visitedAt = Date.now()): HistoryItem | null {
    if (!url || url.startsWith('tibrowser://') || url.startsWith('about:')) return null
    const item: HistoryItem = {
      id: randomUUID(),
      title: title?.trim() || url,
      url,
      visitedAt
    }
    collection.mutate((items) => {
      // 去重：同一 URL 只保留最新一条
      const filtered = items.filter((h) => h.url !== url)
      filtered.push(item)
      return filtered
    })
    return item
  },

  /** 删除；返回是否真的删除了条目 */
  remove(id: string): boolean {
    let removed = false
    collection.mutate((items) =>
      items.filter((h) => {
        if (h.id === id) {
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

  /** 供地址栏联想使用：按关键词匹配历史 */
  search(keyword: string, limit = 8): HistoryItem[] {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return this.list(limit)
    return collection
      .all()
      .filter((h) => h.title.toLowerCase().includes(kw) || h.url.toLowerCase().includes(kw))
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, limit)
  },

  count(): number {
    return collection.all().length
  },

  invalidate(): void {
    collection.invalidate()
  }
}
