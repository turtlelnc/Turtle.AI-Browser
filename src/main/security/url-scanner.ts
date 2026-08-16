import type { SecurityVerdict } from '@shared/types'
import { categoryForHost } from './blocklist'

/** 可疑关键词（域名中出现这些组合通常意味着钓鱼/欺诈） */
const SUSPICIOUS_KEYWORDS = [
  'login-verify',
  'account-verify',
  'secure-login',
  'bank-verify',
  'verify-account',
  'update-account',
  'account-update',
  'unlock-account',
  'confirm-identity',
  'password-reset',
  'recovery-account',
  'free-gift',
  'gift-card',
  'win-now',
  'claim-prize'
]

/** 与拉丁字母形似的外文字符（同形异义攻击常用） */
const CONFUSABLE_CHARS = new Set(
  ('аеорсхуіѕԁјқոԱԽ').split('')
)

/**
 * 纯启发式的 URL 安全扫描（同步、无网络请求，保证零延迟）。
 * 只做高置信度拦截：已知恶意/钓鱼域名、裸 IP、同形异义、强钓鱼关键词。
 */
export function scanUrl(rawUrl: string): SecurityVerdict {
  const url = rawUrl.trim()
  if (!url || url.startsWith('tibrowser://') || url.startsWith('about:blank')) {
    return { blocked: false, category: null, reason: '' }
  }

  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return { blocked: true, category: 'suspicious', reason: '无法解析的网址' }
  }
  if (!host) return { blocked: true, category: 'suspicious', reason: '无效网址' }

  const h = host.toLowerCase()

  // 已知恶意 / 钓鱼域名
  const cat = categoryForHost(h)
  if (cat === 'malware') {
    return { blocked: true, category: 'malware', reason: '该域名已被标记为恶意软件分发源' }
  }
  if (cat === 'phishing') {
    return { blocked: true, category: 'phishing', reason: '该域名已被标记为钓鱼网站' }
  }

  // 裸 IP 直连（强钓鱼信号）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return { blocked: true, category: 'suspicious', reason: '使用 IP 地址直连的网址存在较高风险' }
  }

  // 同形异义（仿冒域名）
  if (hasHomographRisk(host)) {
    return { blocked: true, category: 'phishing', reason: '网址包含形似字母的异体字符，可能是仿冒域名' }
  }

  // 强钓鱼关键词
  for (const kw of SUSPICIOUS_KEYWORDS) {
    if (h.includes(kw)) {
      return { blocked: true, category: 'suspicious', reason: '网址包含可疑关键词，请谨慎访问' }
    }
  }

  return { blocked: false, category: null, reason: '' }
}

/** 混用拉丁字母与形似异体字符时才判定为同形异义，避免误伤纯西里尔等正常域名 */
function hasHomographRisk(host: string): boolean {
  let hasLatin = false
  let hasConfusable = false
  for (const ch of host) {
    if (/[a-z0-9-]/.test(ch)) hasLatin = true
    else if (CONFUSABLE_CHARS.has(ch)) hasConfusable = true
  }
  return hasLatin && hasConfusable
}
