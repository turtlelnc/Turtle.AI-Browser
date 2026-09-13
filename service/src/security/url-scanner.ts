/**
 * URL 安全扫描（移植并强化自 `src/main/security/url-scanner.ts`）。
 *
 * 纯启发式、无网络请求、同步返回 —— 保证地址栏零延迟。
 * 只做**高置信度**判定：已知恶意/钓鱼域名、同形异义仿冒、强钓鱼关键词、
 * 公网裸 IP、可疑端口/凭据等。
 *
 * 与 v0.1.0 的两处有意差异（避免误杀，均有自检用例覆盖）：
 * 1. **本机/内网地址豁免**：`127.0.0.1`、`localhost`、`10.x`、`192.168.x`、
 *    `172.16-31.x`、`::1` 不再因为「裸 IP」被拦截 —— 否则会直接拦掉边车自己的
 *    本地自动化 API 与前端开发服务器。
 * 2. **turtlelnc 例外**：见 `./trusted.ts`，任何档位都不拦截、不警告。
 */

import type { SecurityVerdict, ThreatCategory } from '../shared/types.js'
import { categoryForHost } from './blocklist.js'
import { isTrustedUrl } from './trusted.js'

/** 可疑关键词（域名中出现这些组合通常意味着钓鱼/欺诈） */
export const SUSPICIOUS_KEYWORDS = [
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
  'claim-prize',
  // 中文站点常用钓鱼话术（仅在域名中出现时才判定，正常中文域名不含这些词）
  'zhongjiang',
  'yanzheng-mima',
  'wangyin-jihuo'
] as const

/** 与拉丁字母形似的外文字符（同形异义攻击常用） */
const CONFUSABLE_CHARS = new Set('аеорсхуіѕԁјқոԱԽ'.split(''))

/** 判定为「可疑端口」的端口（常见远控/开发后门端口） */
const SUSPICIOUS_PORTS = new Set([1337, 31337, 4444, 5555, 6666, 8888, 9001, 12345])

/** 扫描结果：在 SecurityVerdict 之上补充「为什么」与「属于哪个档位才拦」 */
export interface ScanResult extends SecurityVerdict {
  /** 命中的规则 ID，便于测试与统计 */
  rule:
    | 'trusted'
    | 'internal'
    | 'malware-list'
    | 'phishing-list'
    | 'bare-ip'
    | 'homograph'
    | 'keyword'
    | 'port'
    | 'credentials'
    | 'unparsable'
    | 'none'
  /** 命中的主机名（便于 UI 展示与统计） */
  host: string
  /** 命中的具体证据（关键词/端口等），无则为空串 */
  evidence: string
  /** 是否被 turtlelnc 白名单豁免 */
  trusted: boolean
  /** 人类可读的中文结论（含豁免说明） */
  summary: string
}

const SAFE: Omit<ScanResult, 'host' | 'trusted' | 'summary'> = {
  blocked: false,
  category: null,
  reason: '',
  rule: 'none',
  evidence: ''
}

function verdict(
  base: Omit<ScanResult, 'host' | 'trusted' | 'summary'>,
  host: string,
  summary: string
): ScanResult {
  return { ...base, host, trusted: false, summary }
}

/** 是否为内部/本机地址（豁免裸 IP 规则） */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.test')) {
    return true
  }
  if (h === '::1' || h === '0.0.0.0') return true
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true
  return false
}

/** 是否为裸 IP（IPv4 或 IPv6 字面量） */
export function isBareIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return h.split('.').every((n) => Number(n) >= 0 && Number(n) <= 255)
  }
  return h.includes(':') && /^[0-9a-f:]+$/i.test(h)
}

/**
 * 扫描一个 URL。
 * @param rawUrl 待检查的地址；非 http(s) 的内部协议（tibrowser://）直接放行
 * @param opts.trustedBySignature 由 native 传入的已验签发布者主体名（可选）
 */
export function scanUrl(
  rawUrl: string,
  opts: { trustedBySignature?: string } = {}
): ScanResult {
  const url = (rawUrl ?? '').trim()
  if (!url || url.startsWith('tibrowser://') || url.startsWith('about:blank')) {
    return { ...SAFE, host: '', trusted: false, summary: '内部页面，无需检查' }
  }

  // turtlelnc 例外：任何档位、任何规则之前先判白
  const trusted = isTrustedUrl(url)
  if (trusted.trusted) {
    return {
      ...SAFE,
      rule: 'trusted',
      host: safeHost(url),
      trusted: true,
      summary: `turtlelnc 官方内容（${trusted.reason}），已豁免全部拦截与统计`
    }
  }
  void opts.trustedBySignature // 签名豁免由下载闸门使用（URL 扫描不做文件验签）

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return verdict(
      { blocked: true, category: 'suspicious', reason: '无法解析的网址', rule: 'unparsable', evidence: '' },
      '',
      '无法解析的网址'
    )
  }
  const host = parsed.hostname
  if (!host) {
    return verdict(
      { blocked: true, category: 'suspicious', reason: '无效网址', rule: 'unparsable', evidence: '' },
      '',
      '无效网址'
    )
  }
  const h = host.toLowerCase()

  // 本机 / 内网：豁免裸 IP 规则（不拦截），但仍会继续做同形异义检查
  const internal = isInternalHost(h)
  if (internal) {
    return {
      ...SAFE,
      rule: 'internal',
      host,
      trusted: false,
      summary: '本机或内网地址，按可信处理（不做裸 IP 拦截）'
    }
  }

  // 1) 已知恶意 / 钓鱼域名
  const cat = categoryForHost(h)
  if (cat === 'malware') {
    return verdict(
      { blocked: true, category: 'malware', reason: '该域名已被标记为恶意软件分发源', rule: 'malware-list', evidence: h },
      host,
      '已知恶意域名（本地黑名单命中）'
    )
  }
  if (cat === 'phishing') {
    return verdict(
      { blocked: true, category: 'phishing', reason: '该域名已被标记为钓鱼网站', rule: 'phishing-list', evidence: h },
      host,
      '已知钓鱼域名（本地黑名单命中）'
    )
  }

  // 2) 公网裸 IP 直连（强钓鱼信号）
  if (isBareIp(h)) {
    return verdict(
      {
        blocked: true,
        category: 'suspicious',
        reason: '使用公网 IP 地址直连的网址存在较高风险',
        rule: 'bare-ip',
        evidence: h
      },
      host,
      '公网裸 IP 直连'
    )
  }

  // 3) 同形异义（仿冒域名）
  if (hasHomographRisk(host)) {
    return verdict(
      {
        blocked: true,
        category: 'phishing',
        reason: '网址包含形似字母的异体字符，可能是仿冒域名',
        rule: 'homograph',
        evidence: host
      },
      host,
      '同形异义仿冒域名'
    )
  }

  // 4) 强钓鱼关键词
  for (const kw of SUSPICIOUS_KEYWORDS) {
    if (h.includes(kw)) {
      return verdict(
        {
          blocked: true,
          category: 'suspicious',
          reason: '网址包含可疑关键词，请谨慎访问',
          rule: 'keyword',
          evidence: kw
        },
        host,
        `域名包含可疑关键词「${kw}」`
      )
    }
  }

  // 5) 可疑端口
  if (parsed.port && SUSPICIOUS_PORTS.has(Number(parsed.port))) {
    return verdict(
      {
        blocked: false,
        category: 'suspicious',
        reason: `网址使用了可疑端口 ${parsed.port}，请确认来源可信`,
        rule: 'port',
        evidence: parsed.port
      },
      host,
      `可疑端口 ${parsed.port}（仅警告）`
    )
  }

  // 6) URL 内嵌凭据（钓鱼常用 http://user:pass@evil）
  if (parsed.username || parsed.password) {
    return verdict(
      {
        blocked: true,
        category: 'phishing',
        reason: '网址中内嵌了账号密码字段，这是典型的钓鱼手法',
        rule: 'credentials',
        evidence: parsed.username ? 'username' : 'password'
      },
      host,
      'URL 内嵌凭据'
    )
  }

  return { ...SAFE, host, trusted: false, summary: '未命中任何本地风险规则' }
}

/** 便捷封装：只取阻止结论（供 native 快速调用） */
export function checkUrl(rawUrl: string): SecurityVerdict {
  const r = scanUrl(rawUrl)
  return { blocked: r.blocked, category: r.category, reason: r.reason }
}

/** 主机名是否被 turtlelnc 白名单豁免（供下载闸门与统计排除） */
export function isTrustedContent(rawUrl: string): boolean {
  return isTrustedUrl(rawUrl).trusted
}

/** 分类映射（供统计使用） */
export function categoryOf(rawUrl: string): ThreatCategory | null {
  return scanUrl(rawUrl).category
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
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
