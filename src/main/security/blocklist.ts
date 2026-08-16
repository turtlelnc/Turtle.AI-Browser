import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import bundled from './blocklists/blocklist.json'

export type BlockCategory = 'malware' | 'phishing' | 'ads' | 'tracking'

const sets: Record<BlockCategory, Set<string>> = {
  malware: new Set(bundled.malware),
  phishing: new Set(bundled.phishing),
  ads: new Set(bundled.ads),
  tracking: new Set(bundled.tracking)
}

/**
 * 合并运行时黑名单：resources/blocklists/ 下的
 * malware.txt / phishing.txt / ads.txt / tracking.txt（每行一个域名，支持 0.0.0.0 / 127.0.0.1 前缀）。
 */
export function loadRuntimeBlocklists(dir: string): void {
  if (!existsSync(dir)) return
  try {
    for (const file of readdirSync(dir)) {
      const m = file.match(/^(malware|phishing|ads|tracking)\.txt$/i)
      if (!m) continue
      const cat = m[1].toLowerCase() as BlockCategory
      const content = readFileSync(join(dir, file), 'utf-8')
      for (let line of content.split(/\r?\n/)) {
        line = line.trim().toLowerCase()
        if (!line || line.startsWith('#')) continue
        line = line.replace(/^(0\.0\.0\.0|127\.0\.0\.1)\s+/, '')
        if (line) sets[cat].add(line)
      }
    }
  } catch {
    /* 忽略读取错误 */
  }
}

function matchIn(set: Set<string>, host: string): boolean {
  if (set.has(host)) return true
  const parts = host.split('.')
  for (let i = 1; i < parts.length; i++) {
    if (set.has(parts.slice(i).join('.'))) return true
  }
  return false
}

/** 返回域名命中的黑名单类别，未命中返回 null */
export function categoryForHost(host: string): BlockCategory | null {
  const h = host.toLowerCase().replace(/^www\./, '')
  if (matchIn(sets.malware, h)) return 'malware'
  if (matchIn(sets.phishing, h)) return 'phishing'
  if (matchIn(sets.ads, h)) return 'ads'
  if (matchIn(sets.tracking, h)) return 'tracking'
  return null
}
