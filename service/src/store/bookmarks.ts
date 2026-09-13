/**
 * 书签存储（无 Electron 版本，移植自 `src/main/store/bookmarks.ts`）。
 * 数据文件：`<userData>/bookmarks.json`，原子写。
 */

import { randomUUID } from 'node:crypto'
import type { BookmarkNode } from '../shared/types.js'
import { userDataFile } from '../paths.js'
import { JsonCollection } from './json-store.js'

const collection = new JsonCollection<BookmarkNode>(() => userDataFile('bookmarks.json'))

/** 默认文件夹名（与 UI 中文一致） */
export const DEFAULT_BOOKMARK_FOLDER = '书签栏'

export const bookmarks = {
  list(): BookmarkNode[] {
    return collection
      .all()
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
  },

  isBookmarked(url: string): boolean {
    return collection.all().some((b) => b.url === url)
  },

  add(title: string, url: string, folder = DEFAULT_BOOKMARK_FOLDER): BookmarkNode {
    if (!url.trim()) throw new Error('网址不能为空')
    const node: BookmarkNode = {
      id: randomUUID(),
      title: title?.trim() || url,
      url: url.trim(),
      folder: folder || DEFAULT_BOOKMARK_FOLDER,
      createdAt: Date.now()
    }
    collection.mutate((items) => [node, ...items])
    return node
  },

  /** 删除；返回是否真的删除了条目 */
  remove(id: string): boolean {
    let removed = false
    collection.mutate((items) =>
      items.filter((b) => {
        if (b.id === id) {
          removed = true
          return false
        }
        return true
      })
    )
    return removed
  },

  /** 切换书签状态，返回切换后是否已收藏 */
  toggle(title: string, url: string): boolean {
    const existing = collection.all().find((b) => b.url === url)
    if (existing) {
      this.remove(existing.id)
      return false
    }
    this.add(title, url)
    return true
  },

  invalidate(): void {
    collection.invalidate()
  }
}
