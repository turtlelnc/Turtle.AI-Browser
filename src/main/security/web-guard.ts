import type { Session } from 'electron'
import { hostOf } from '@shared/utils'
import { store } from '../store'
import { categoryForHost } from './blocklist'

/** 是否为本机/局域网地址，避免误升级内网服务 */
function isLocalHost(host: string): boolean {
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.local') || host === '127.0.0.1') return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  return false
}

/**
 * 在浏览会话上挂载安全拦截：
 * 1) HTTP -> HTTPS 自动升级
 * 2) 广告 / 追踪器域名拦截（仅子资源，不影响主页面加载）
 */
export function attachWebGuard(session: Session): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    const sec = store.getSecurity()

    // 1) HTTPS 升级
    if (sec.httpsUpgrade && details.url.startsWith('http://')) {
      const host = hostOf(details.url)
      if (!isLocalHost(host)) {
        callback({ redirectURL: details.url.replace(/^http:/, 'https:') })
        return
      }
    }

    // 2) 广告 / 追踪器拦截（只拦子资源，main_frame 交给 url-scanner）
    if ((sec.adBlock || sec.trackerBlock) && details.resourceType !== 'mainFrame') {
      const cat = categoryForHost(hostOf(details.url))
      if ((cat === 'ads' && sec.adBlock) || (cat === 'tracking' && sec.trackerBlock)) {
        callback({ cancel: true })
        return
      }
    }

    callback({})
  })
}
