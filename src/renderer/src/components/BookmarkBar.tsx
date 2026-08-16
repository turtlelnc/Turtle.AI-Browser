import type { BookmarkNode } from '@shared/types'
import { Bookmark } from './icons'

export function BookmarkBar({ bookmarks }: { bookmarks: BookmarkNode[] }): JSX.Element {
  return (
    <div className="bookmark-bar chrome">
      {bookmarks.length === 0 && (
        <span className="bookmark-empty">将常用网站添加为书签（点击地址栏星标），方便快速访问</span>
      )}
      {bookmarks.map((b) => (
        <span
          key={b.id}
          className="bookmark-item"
          title={b.url}
          onClick={() => window.tibrowser.navigate(b.url)}
        >
          <Bookmark size={14} />
          {b.title}
        </span>
      ))}
    </div>
  )
}
