/**
 * 扩展程序安全审查（增强型防护的本地可实现部分）。
 *
 * 只做**静态检查**：读取 manifest.json / 源码文本，按风险模式给出中文清单。
 * 不做沙箱动态分析，也不联网比对扩展黑名单（那是云端能力，见 protection.ts）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

export type ExtensionRiskLevel = 'none' | 'low' | 'medium' | 'high'

export interface ExtensionFinding {
  level: Exclude<ExtensionRiskLevel, 'none'>
  /** 中文风险描述 */
  message: string
  /** 命中的规则 ID */
  rule: string
}

export interface ExtensionReview {
  path: string
  name: string
  version: string
  /** manifest_version（2 / 3） */
  manifestVersion: number
  /** 声明的权限 */
  permissions: string[]
  hostPermissions: string[]
  /** 风险清单（中文） */
  findings: ExtensionFinding[]
  riskLevel: ExtensionRiskLevel
  /** 一句话中文结论 */
  summary: string
}

/** 高风险权限及其中文说明 */
const RISKY_PERMISSIONS: Record<string, string> = {
  '<all_urls>': '可读写用户访问的**全部**网站内容',
  webRequest: '可观察/修改所有网络请求',
  webRequestBlocking: '可拦截并改写网络请求',
  debugger: '可附加调试器，读取页面全部数据',
  nativeMessaging: '可与本机原生程序通信',
  management: '可管理/卸载其他扩展',
  proxy: '可修改代理设置，劫持全部流量',
  cookies: '可读取所有站点的 Cookie',
  clipboardRead: '可读取剪贴板',
  downloads: '可读写下载内容',
  history: '可读取浏览历史',
  'declarativeNetRequestWithHostAccess': '可基于主机权限拦截请求'
}

/** 需要扫描的源码扩展名 */
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.html', '.htm'])

const MAX_FILES = 400
const MAX_FILE_BYTES = 512 * 1024

/** 审查一个已解包的扩展目录 */
export function reviewExtension(dir: string): ExtensionReview {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`不是有效的扩展目录（缺少 manifest.json）：${dir}`)
  }
  let manifest: {
    name?: string
    version?: string
    manifest_version?: number
    permissions?: unknown[]
    host_permissions?: unknown[]
    optional_permissions?: unknown[]
    content_scripts?: Array<{ matches?: unknown[]; js?: unknown[] }>
  }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    throw new Error(`manifest.json 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }

  const permissions = asStringArray(manifest.permissions)
  const hostPermissions = [
    ...asStringArray(manifest.host_permissions),
    ...asStringArray(manifest.optional_permissions)
  ]
  const findings: ExtensionFinding[] = []

  // 1) 危险权限
  for (const p of [...permissions, ...hostPermissions]) {
    const note = RISKY_PERMISSIONS[p]
    if (!note) continue
    const isAllUrls = p === '<all_urls>' || p === '*://*/*'
    findings.push({
      level: isAllUrls ? 'high' : 'medium',
      rule: `permission:${p}`,
      message: `声明了权限「${p}」：${note}`
    })
  }

  // 2) 内容脚本注入 + 全站权限组合
  const scripts = manifest.content_scripts ?? []
  const injectsAllSites = scripts.some((s) =>
    asStringArray(s.matches).some((m) => m === '<all_urls>' || m === '*://*/*')
  )
  if (injectsAllSites && (permissions.includes('<all_urls>') || hostPermissions.includes('<all_urls>'))) {
    findings.push({
      level: 'high',
      rule: 'combo:all-urls-injection',
      message: '同时拥有全站主机权限与内容脚本注入能力，可读取并改写任意网站（包括网银页面）的内容。'
    })
  }

  // 3) 源码扫描
  const { scanned, hits } = scanSources(dir)
  for (const h of hits) findings.push(h)
  if (scanned === 0) {
    findings.push({
      level: 'low',
      rule: 'scan:none',
      message: '未找到可读的脚本文件，无法进行源码级检查（可能全部代码为远程加载，或文件被占用）。'
    })
  }

  const riskLevel = worst(findings)
  return {
    path: dir,
    name: manifest.name?.trim() || '(未命名扩展)',
    version: manifest.version?.trim() || '0',
    manifestVersion: Number(manifest.manifest_version) || 0,
    permissions,
    hostPermissions,
    findings,
    riskLevel,
    summary:
      findings.length === 0
        ? `未发现本地可见风险（已扫描 ${scanned} 个脚本文件）。注意：这不代表扩展绝对安全，本地审查不做云端比对与动态分析。`
        : `发现 ${findings.length} 项风险，最高等级：${riskLabel(riskLevel)}（已扫描 ${scanned} 个脚本文件）。`
  }
}

const SOURCE_RULES: { re: RegExp; level: Exclude<ExtensionRiskLevel, 'none'>; rule: string; message: string }[] = [
  {
    re: /\beval\s*\(/,
    level: 'high',
    rule: 'source:eval',
    message: '源码中使用 eval() 动态执行字符串代码，是远程代码执行的典型手法。'
  },
  {
    re: /new\s+Function\s*\(/,
    level: 'high',
    rule: 'source:new-function',
    message: '源码中使用 new Function() 动态构造代码，可绕过审查执行远程代码（MV3 明令禁止）。'
  },
  {
    re: /document\.createElement\(\s*['"]script['"]\s*\)[\s\S]{0,200}?\.src\s*=/,
    level: 'high',
    rule: 'source:remote-script',
    message: '动态插入外部 <script> 标签加载远程脚本，属于远程代码加载。'
  },
  {
    re: /(fetch|XMLHttpRequest)\s*\(?[\s\S]{0,120}?https?:\/\/(?!localhost|127\.0\.0\.1)/,
    level: 'low',
    rule: 'source:remote-fetch',
    message: '存在对外网络请求（可能用于回传浏览数据或加载配置），请核对目标域名。'
  },
  {
    re: /chrome\.cookies\.(getAll|get)\s*\(/,
    level: 'medium',
    rule: 'source:cookie-read',
    message: '代码读取浏览器 Cookie（会话劫持风险）。'
  },
  {
    re: /atob\s*\(\s*['"][A-Za-z0-9+/=]{80,}/,
    level: 'medium',
    rule: 'source:base64-blob',
    message: '源码中内嵌大段 base64 字符串并解码，常用于隐藏真实逻辑。'
  },
  {
    re: /\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i,
    level: 'medium',
    rule: 'source:hex-obfuscation',
    message: '源码包含十六进制转义混淆，可能刻意规避人工审阅。'
  },
  {
    re: /(keydown|keypress)[\s\S]{0,200}?(password|credit|card|cvv|身份证|银行卡)/i,
    level: 'high',
    rule: 'source:credential-capture',
    message: '监听键盘事件并关联密码/银行卡等敏感词，疑似凭据窃取。'
  },
  {
    re: /navigator\.(clipboard|credentials)|document\.cookie\s*=/,
    level: 'low',
    rule: 'source:credential-access',
    message: '访问剪贴板 / 凭据 API 或直接写 Cookie，请确认用途。'
  }
]

function scanSources(root: string): { scanned: number; hits: ExtensionFinding[] } {
  const hits = new Map<string, ExtensionFinding>()
  let scanned = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || scanned >= MAX_FILES) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (scanned >= MAX_FILES) return
      const full = join(dir, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue
        walk(full, depth + 1)
        continue
      }
      if (!CODE_EXT.has(extname(entry).toLowerCase())) continue
      if (st.size > MAX_FILE_BYTES) continue
      scanned++
      let text = ''
      try {
        text = readFileSync(full, 'utf-8')
      } catch {
        continue
      }
      for (const rule of SOURCE_RULES) {
        if (rule.re.test(text) && !hits.has(rule.rule)) {
          hits.set(rule.rule, {
            level: rule.level,
            rule: rule.rule,
            message: `${rule.message}（命中文件：${entry}）`
          })
        }
      }
    }
  }
  walk(root, 0)
  return { scanned, hits: [...hits.values()] }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

function worst(findings: ExtensionFinding[]): ExtensionRiskLevel {
  const rank: Record<ExtensionRiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 }
  let level: ExtensionRiskLevel = 'none'
  for (const f of findings) if (rank[f.level] > rank[level]) level = f.level
  return level
}

function riskLabel(level: ExtensionRiskLevel): string {
  return { none: '无风险', low: '低', medium: '中', high: '高' }[level]
}
