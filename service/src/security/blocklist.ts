/**
 * 域名黑名单（移植自 `src/main/security/blocklist.ts`，去掉编译期 JSON import）。
 *
 * 数据来源：
 * 1. 内置样例列表（本文件 `BUILTIN_BLOCKLIST`，与 v0.1.0 的 blocklist.json 内容一致）；
 * 2. 运行时列表：`resources/blocklists/{malware,phishing,ads,tracking}.txt`，
 *    每行一个域名，支持 `#` 注释与 hosts 前缀（`0.0.0.0` / `127.0.0.1`）。
 *
 * 目录通过 `loadRuntimeBlocklists(dir)` 显式传入（原生宿主/启动参数决定实际位置），
 * 避免边车硬编码 `resources/` 路径。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type BlockCategory = 'malware' | 'phishing' | 'ads' | 'tracking'

/** 内置样例黑名单（与 v0.1.0 `src/main/security/blocklists/blocklist.json` 保持一致） */
export const BUILTIN_BLOCKLIST: Record<BlockCategory, string[]> = {
  malware: ['example-malware-host.com', 'malware-c2-demo.net'],
  phishing: ['example-phishing-page.com', 'fake-bank-verify-demo.org'],
  ads: [
    'doubleclick.net',
    'googleadservices.com',
    'googlesyndication.com',
    'adservice.google.com',
    'adnxs.com',
    'adsrvr.org',
    'taboola.com',
    'outbrain.com',
    'criteo.com',
    'adroll.com'
  ],
  tracking: [
    'google-analytics.com',
    'googletagmanager.com',
    'scorecardresearch.com',
    'hotjar.com',
    'mixpanel.com',
    'segment.io',
    'facebook.net',
    'clarity.ms',
    'newrelic.com',
    'amplitude.com'
  ]
}

const sets: Record<BlockCategory, Set<string>> = {
  malware: new Set(BUILTIN_BLOCKLIST.malware),
  phishing: new Set(BUILTIN_BLOCKLIST.phishing),
  ads: new Set(BUILTIN_BLOCKLIST.ads),
  tracking: new Set(BUILTIN_BLOCKLIST.tracking)
}

/** 已合并的运行时黑名单目录（便于自检与诊断） */
const loadedDirs: string[] = []

/**
 * 合并运行时黑名单：`<dir>/{malware,phishing,ads,tracking}.txt`。
 * 幂等：同一目录重复调用不会重复计入（Set 天然去重，这里只记录目录名）。
 */
export function loadRuntimeBlocklists(dir: string): { dir: string; files: number; domains: number } {
  if (!dir || !existsSync(dir)) return { dir, files: 0, domains: 0 }
  let files = 0
  let domains = 0
  try {
    for (const file of readdirSync(dir)) {
      const m = file.match(/^(malware|phishing|ads|tracking)\.txt$/i)
      if (!m) continue
      const cat = m[1].toLowerCase() as BlockCategory
      let content = ''
      try {
        content = readFileSync(join(dir, file), 'utf-8')
      } catch {
        continue
      }
      files++
      for (let line of content.split(/\r?\n/)) {
        line = line.trim().toLowerCase()
        if (!line || line.startsWith('#')) continue
        line = line.replace(/^(0\.0\.0\.0|127\.0\.0\.1)\s+/, '').trim()
        if (!line) continue
        // 兼容 hosts 文件的「域名 别名」写法，只取第一段
        const host = line.split(/\s+/)[0] ?? ''
        if (host && !sets[cat].has(host)) {
          sets[cat].add(host)
          domains++
        }
      }
    }
    if (!loadedDirs.includes(dir)) loadedDirs.push(dir)
  } catch {
    /* 忽略读取错误：黑名单缺失不应影响边车启动 */
  }
  return { dir, files, domains }
}

/** 统计各分类条目数（自检/诊断用） */
export function blocklistStats(): Record<BlockCategory, number> & { dirs: string[] } {
  return {
    malware: sets.malware.size,
    phishing: sets.phishing.size,
    ads: sets.ads.size,
    tracking: sets.tracking.size,
    dirs: loadedDirs.slice()
  }
}

function matchIn(set: Set<string>, host: string): boolean {
  if (set.has(host)) return true
  // 父域匹配：a.b.example.com 命中 example.com
  const parts = host.split('.')
  for (let i = 1; i < parts.length; i++) {
    if (set.has(parts.slice(i).join('.'))) return true
  }
  return false
}

/** 返回域名命中的黑名单类别，未命中返回 null */
export function categoryForHost(host: string): BlockCategory | null {
  const h = (host ?? '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  if (!h) return null
  if (matchIn(sets.malware, h)) return 'malware'
  if (matchIn(sets.phishing, h)) return 'phishing'
  if (matchIn(sets.ads, h)) return 'ads'
  if (matchIn(sets.tracking, h)) return 'tracking'
  return null
}

/** 是否命中指定的某类黑名单（供广告/追踪拦截精确查询） */
export function hostInCategory(host: string, category: BlockCategory): boolean {
  const h = (host ?? '').toLowerCase().replace(/^www\./, '')
  return Boolean(h) && matchIn(sets[category], h)
}
