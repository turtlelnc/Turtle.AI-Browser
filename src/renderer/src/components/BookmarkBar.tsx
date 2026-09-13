/**
 * 书签栏：常驻显示的书签快捷入口。
 * 空状态给出「如何添加书签」的提示，而不是留一条空白。
 */
import type { BookmarkNode } from '@shared/bridge'
import { tib } from '../bridge'
import { Bookmark, Star } from './icons'

export function BookmarkBar({ bookmarks }: { bookmarks: BookmarkNode[] }): JSX.Element {
  return (
    <div className="bookmark-bar chrome">
      {bookmarks.length === 0 ? (
        <span className="bookmark-empty">
          <Star size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          将常用网站添加为书签（点击地址栏星标），就会出现在这里
        </span>
      ) : null}
      {bookmarks.map((b) => (
        <span
          key={b.id}
          className="bookmark-item"
          title={b.url}
          onClick={() => void tib.navigate(b.url)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              void tib.newTab(b.url)
            }
          }}
        >
          <Bookmark size={14} />
          {b.title}
        </span>
      ))}
    </div>
  )
}
