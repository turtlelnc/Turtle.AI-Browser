import { SEARCH_ENGINES } from './constants'
import type { SearchEngineId } from './types'

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** 判断输入更像 URL 还是搜索词 */
export function isUrlLike(input: string): boolean {
  const t = input.trim()
  if (!t) return false
  if (SCHEME_RE.test(t)) return true
  if (/^localhost(:\d+)?([/?#]|$)/i.test(t)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(t)) return true
  // example.com / example.com/path / 子域.域名.后缀
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(t)) return true
  return false
}

/** 将地址栏输入解析为可导航的 URL；非 URL 则走搜索引擎 */
export function resolveNavigationInput(input: string, engine: SearchEngineId): string {
  const t = input.trim()
  if (!t) return ''
  if (isUrlLike(t)) {
    return SCHEME_RE.test(t) ? t : `https://${t}`
  }
  return SEARCH_ENGINES[engine].template + encodeURIComponent(t)
}

/** 从完整 URL 提取主机名 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 简洁展示 URL（去掉协议与尾部斜杠） */
export function prettyUrl(url: string): string {
  try {
    const u = new URL(url)
    return (u.hostname + u.pathname + u.search).replace(/\/$/, '')
  } catch {
    return url
  }
}
