import { randomUUID } from 'node:crypto'
import type { HistoryItem } from '@shared/types'
import { readJson, writeJson, userDataFile } from './fs-util'

/** 历史记录上限，超出后裁剪最旧条目 */
const MAX_ENTRIES = 2000

let cache: HistoryItem[] | null = null

function load(): HistoryItem[] {
  if (cache) return cache
  cache = readJson<HistoryItem[]>(userDataFile('history.json'), [])
  return cache
}

function persist(): void {
  writeJson(userDataFile('history.json'), load())
}

export const history = {
  list(limit = 500): HistoryItem[] {
    return load()
      .slice()
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, limit)
  },

  add(title: string, url: string): void {
    if (!url || url.startsWith('tibrowser://')) return
    const all = load()
    // 去重：同一 URL 只保留最新一条
    const filtered = all.filter((h) => h.url !== url)
    filtered.push({
      id: randomUUID(),
      title: title || url,
      url,
      visitedAt: Date.now()
    })
    cache = filtered.slice(-MAX_ENTRIES)
    persist()
  },

  remove(id: string): void {
    cache = load().filter((h) => h.id !== id)
    persist()
  },

  clear(): void {
    cache = []
    persist()
  },

  /** 供地址栏联想使用：按关键词匹配历史 */
  search(keyword: string, limit = 8): HistoryItem[] {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return this.list(limit)
    return load()
      .filter((h) => h.title.toLowerCase().includes(kw) || h.url.toLowerCase().includes(kw))
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, limit)
  }
}
