/**
 * 存储层汇总导出。
 */

export { bookmarks, DEFAULT_BOOKMARK_FOLDER } from './bookmarks.js'
export { history, MAX_HISTORY_ENTRIES } from './history.js'
export { downloads, MAX_DOWNLOAD_ENTRIES } from './downloads.js'
export { store, API_KEY_MASK } from './store.js'
export { secrets } from './secrets.js'
export { readJson, tryReadJson, writeJsonAtomic, writeTextAtomic, JsonCollection } from './json-store.js'

import { bookmarks } from './bookmarks.js'
import { history } from './history.js'
import { downloads } from './downloads.js'
import { store } from './store.js'

/** 用户数据目录切换 / 导入配置后，清空所有内存缓存 */
export function invalidateStoreCaches(): void {
  bookmarks.invalidate()
  history.invalidate()
  downloads.invalidate()
  store.invalidate()
}
