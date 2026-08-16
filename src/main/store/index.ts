import { store } from './store'
import { bookmarks } from './bookmarks'
import { history } from './history'

/** 初始化所有本地存储 */
export function initStores(): void {
  store.init()
}

export { store, bookmarks, history }
