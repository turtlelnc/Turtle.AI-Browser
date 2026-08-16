import { randomUUID } from 'node:crypto'
import type { BookmarkNode } from '@shared/types'
import { readJson, writeJson, userDataFile } from './fs-util'

let cache: BookmarkNode[] | null = null

function load(): BookmarkNode[] {
  if (cache) return cache
  cache = readJson<BookmarkNode[]>(userDataFile('bookmarks.json'), [])
  return cache
}

function persist(): void {
  writeJson(userDataFile('bookmarks.json'), load())
}

export const bookmarks = {
  list(): BookmarkNode[] {
    return load()
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
  },

  isBookmarked(url: string): boolean {
    return load().some((b) => b.url === url)
  },

  add(title: string, url: string, folder = '书签栏'): BookmarkNode {
    const node: BookmarkNode = {
      id: randomUUID(),
      title: title || url,
      url,
      folder,
      createdAt: Date.now()
    }
    cache = [node, ...load()]
    persist()
    return node
  },

  remove(id: string): void {
    cache = load().filter((b) => b.id !== id)
    persist()
  },

  /** 切换书签状态，返回是否已收藏 */
  toggle(title: string, url: string): boolean {
    const existing = load().find((b) => b.url === url)
    if (existing) {
      this.remove(existing.id)
      return false
    }
    this.add(title, url)
    return true
  }
}
