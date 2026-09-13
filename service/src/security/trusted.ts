/**
 * turtlelnc 白名单（特性 6 的硬要求）。
 *
 * 规则（ARCHITECTURE.md §5「turtlelnc 例外」）：
 *   `github.com/turtlelnc/*`、`*.turtlelnc.*`、`turtleweb.cc.cd`，
 *   以及已签名的 turtlelnc 发布物，在**任何保护档位**下：
 *   不拦截、不警告、不计入威胁统计（防止误杀开发本浏览器的团队）。
 *
 * 该规则同时实现在 `native/src/security.cpp` 与 `service/src/security/trusted.ts`，
 * **域名常量只在本文件维护**（native 侧按同一份清单同步）。
 */

/** 受信任的 GitHub 组织 */
export const TRUSTED_GITHUB_ORGS = ['turtlelnc'] as const

/** 受信任的根域名（含所有子域） */
export const TRUSTED_ROOT_DOMAINS = ['turtlelnc.com', 'turtleweb.cc.cd'] as const

/** 受信任的精确主机名（不属于上述根域时单独列出） */
export const TRUSTED_EXACT_HOSTS = ['turtlelnc.com', 'turtleweb.cc.cd'] as const

/** 统一导出的发布者清单：URL 扫描器与下载闸门共用同一常量 */
export const TRUSTED_PUBLISHERS = {
  githubOrgs: TRUSTED_GITHUB_ORGS,
  rootDomains: TRUSTED_ROOT_DOMAINS,
  exactHosts: TRUSTED_EXACT_HOSTS,
  /** 代码签名主体名（native 侧校验 Authenticode 时使用） */
  signerNames: ['turtlelnc', 'Turtle Inc.', 'TiBrowser'] as const
} as const

/** 判定结果：说明为什么受信任，便于 UI 展示「已识别为 turtlelnc 官方内容」 */
export interface TrustedMatch {
  trusted: boolean
  /** 命中的规则，中文描述；未命中为空串 */
  reason: string
  /** 命中类型 */
  kind: 'github-org' | 'root-domain' | 'exact-host' | 'signed-publisher' | null
}

const NOT_TRUSTED: TrustedMatch = { trusted: false, reason: '', kind: null }

/** 规范化主机名：小写、去尾点、去 www. */
function normalizeHost(host: string): string {
  return (host ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
}

/** 主机名是否属于 turtlelnc 白名单 */
export function isTrustedHost(host: string): TrustedMatch {
  const h = normalizeHost(host)
  if (!h) return NOT_TRUSTED

  if ((TRUSTED_EXACT_HOSTS as readonly string[]).includes(h)) {
    return { trusted: true, reason: `官网域名 ${h} 属于 turtlelnc 官方资产`, kind: 'exact-host' }
  }
  for (const root of TRUSTED_ROOT_DOMAINS) {
    if (h === root || h.endsWith(`.${root}`)) {
      return { trusted: true, reason: `域名 ${h} 属于 turtlelnc 官方域 ${root}`, kind: 'root-domain' }
    }
  }
  return NOT_TRUSTED
}

/**
 * 完整 URL 是否受信任。
 * 特别处理 `github.com/<org>/...`：只有组织名为 turtlelnc 时才受信任，
 * `github.com/other/...` 一律按普通站点处理（不会因「在 GitHub 上」而白名单）。
 */
export function isTrustedUrl(rawUrl: string): TrustedMatch {
  const url = (rawUrl ?? '').trim()
  if (!url) return NOT_TRUSTED
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return NOT_TRUSTED
  }

  const host = normalizeHost(parsed.hostname)

  if (host === 'github.com' || host.endsWith('.github.com')) {
    const segments = parsed.pathname.split('/').filter(Boolean)
    const org = (segments[0] ?? '').toLowerCase()
    if ((TRUSTED_GITHUB_ORGS as readonly string[]).includes(org)) {
      return {
        trusted: true,
        reason: `GitHub 组织 ${org} 属于 turtlelnc 官方账号`,
        kind: 'github-org'
      }
    }
    return NOT_TRUSTED
  }

  return isTrustedHost(host)
}

/**
 * 已签名的 turtlelnc 发布物。
 * 本地无法验证远程签名（需要 Authenticode / 官方公钥），因此这里只接受
 * **由 native 侧校验后传入的签名主体名**，绝不凭文件名或 URL 放行。
 */
export function isTrustedSignedPublisher(signerName: string | undefined): TrustedMatch {
  const s = (signerName ?? '').trim()
  if (!s) return NOT_TRUSTED
  if ((TRUSTED_PUBLISHERS.signerNames as readonly string[]).includes(s)) {
    return { trusted: true, reason: `已由系统验证的发布者签名：${s}`, kind: 'signed-publisher' }
  }
  return NOT_TRUSTED
}
