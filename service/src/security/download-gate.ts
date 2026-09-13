/**
 * 危险下载闸门（特性 6 新行为）。
 *
 * v0.1.0 的下载处理是「可疑即硬拦」。v1.0.0 的要求是：
 * **不安全安装包只警告，用户可以选择保留**，只有本地高置信度的恶意特征才阻断。
 *
 * 因此闸门返回三态结论：`{action:'allow'|'warn'|'block', reason}`，
 * 其中：
 * - `allow`：正常文件，turtlelnc 官方内容恒为 allow；
 * - `warn`  ：可疑（安装包、未知可执行、高熵打包、宏文档、URL 可疑等）→ 提示但**可以保留**；
 * - `block` ：本地可确认的恶意（黑名单域名下发、EICAR 测试特征、伪装系统文件等）→ 阻断。
 *
 * 本地能力边界（见 `./protection.ts`）：不做云端样本比对，只做文件签名 + 熵 + 结构启发式。
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { scanUrl, type ScanResult } from './url-scanner.js'
import { isTrustedUrl, isTrustedSignedPublisher } from './trusted.js'

/** 闸门结论 */
export type DownloadAction = 'allow' | 'warn' | 'block'

/** 危险等级 */
export type ThreatLevel = 'none' | 'low' | 'medium' | 'high' | 'critical'

export interface DownloadVerdict {
  action: DownloadAction
  /** 中文原因（直接可展示） */
  reason: string
  /** 危险等级 */
  threatLevel: ThreatLevel
  /** 命中的文件类型（中文名） */
  fileType: string
  /** 是否为安装包（安装包默认「警告但可保留」） */
  installer: boolean
  /** 是否被 turtlelnc 白名单豁免 */
  trusted: boolean
  /** 命中的具体规则 ID 列表 */
  rules: string[]
  /** 文件 SHA-256（前 16 位十六进制，便于用户自查） */
  sha256Prefix: string
  /** 文件大小（字节） */
  size: number
}

export interface InspectInput {
  /** 下载 URL */
  url?: string
  /** 保存路径（可选；提供后可做真实文件分析） */
  filePath?: string
  /** 内存中的文件内容（可选；与 filePath 二选一） */
  buffer?: Buffer
  /** 文件名（可从 URL 或 filePath 推导） */
  filename?: string
  /** 声明的 MIME（不可信，只作参考） */
  mimeType?: string
  /** native 侧已验签的发布者主体名 */
  signerName?: string
}

/** 文件类型判定结果 */
export interface FileTypeInfo {
  /** 内部类型 ID */
  id:
    | 'pe'
    | 'elf'
    | 'macho'
    | 'msi'
    | 'zip'
    | 'rar'
    | '7z'
    | 'cab'
    | 'pdf'
    | 'office-ooxml'
    | 'office-cfb'
    | 'script'
    | 'text'
    | 'unknown'
  /** 中文名称 */
  label: string
  /** 是否为可执行/安装包 */
  executable: boolean
}

/** 分析摘要 */
export interface FileAnalysis {
  fileType: FileTypeInfo
  /** Shannon 熵（0-8），仅对可读前 1MiB 计算 */
  entropy: number
  /** 样本长度 */
  sampleSize: number
  size: number
  sha256: string
  /** 命中的启发式规则（中文描述） */
  findings: string[]
  /** 是否为安装包 */
  installer: boolean
  /** 危险等级 */
  threatLevel: ThreatLevel
}

/** 高危：确认为恶意内容时直接阻断 */
const MALICIOUS_MARKERS: { marker: string; rule: string; label: string }[] = [
  {
    marker: 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR',
    rule: 'eicar-test-signature',
    label: 'EICAR 反病毒测试文件特征'
  }
]

/** 安装包扩展名（这类文件默认「警告但可保留」） */
const INSTALLER_EXT = new Set([
  '.exe',
  '.msi',
  '.msix',
  '.appx',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.apk',
  '.appimage',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.jse',
  '.wsf',
  '.scr',
  '.pif',
  '.hta',
  '.jar',
  '.lnk',
  '.reg'
])

/** 伪装用双扩展名（真实可执行 + 诱导性后缀） */
const DECOY_EXT = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.mp4',
  '.mp3',
  '.txt',
  '.csv',
  '.zip'
])

/** 宏文档 / 老式 Office 二进制格式 */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

const SCRIPT_SHEBANG = /^#!\s*\/(usr\/bin\/env\s+)?(ba|z|k|da)?sh|^#!.*(python|perl|ruby|node)/i

/** 单次最多读取的字节数（1 MiB），避免大文件把边车内存吃满 */
const MAX_SAMPLE = 1024 * 1024

/** 计算 Shannon 熵（比特/字节） */
export function shannonEntropy(buf: Buffer): number {
  if (buf.length === 0) return 0
  const counts = new Array<number>(256).fill(0)
  for (const b of buf) counts[b]++
  let h = 0
  for (const c of counts) {
    if (!c) continue
    const p = c / buf.length
    h -= p * Math.log2(p)
  }
  return h
}

/** 按文件头魔数判定真实类型（**不信任扩展名**） */
export function detectFileType(buf: Buffer, filename = ''): FileTypeInfo {
  const ext = extname(filename).toLowerCase()
  const b = buf
  const at = (i: number): number => (b.length > i ? b[i] : -1)

  // PE：MZ ... PE\0\0（偏移 0x3C 处指向 PE 头）
  if (at(0) === 0x4d && at(1) === 0x5a) {
    return { id: 'pe', label: 'Windows 可执行文件（PE）', executable: true }
  }
  if (at(0) === 0x7f && at(1) === 0x45 && at(2) === 0x4c && at(3) === 0x46) {
    return { id: 'elf', label: 'Linux 可执行文件（ELF）', executable: true }
  }
  const magic = b.subarray(0, 4).toString('hex')
  if (['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(magic)) {
    return { id: 'macho', label: 'macOS 可执行文件（Mach-O）', executable: true }
  }
  if (CFB_MAGIC.equals(b.subarray(0, 8))) {
    return { id: 'office-cfb', label: 'OLE 复合文档（可能是含宏的 Office 文档）', executable: false }
  }
  if (at(0) === 0x50 && at(1) === 0x4b) {
    // ZIP 家族：OOXML / jar / apk / 普通 zip
    if (ext === '.jar') return { id: 'zip', label: 'Java 归档（JAR）', executable: true }
    if (ext === '.apk') return { id: 'zip', label: 'Android 安装包（APK）', executable: true }
    if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
      return { id: 'office-ooxml', label: 'Office 文档（OOXML）', executable: false }
    }
    return { id: 'zip', label: 'ZIP 压缩包', executable: false }
  }
  if (b.subarray(0, 4).toString('latin1') === 'Rar!') {
    return { id: 'rar', label: 'RAR 压缩包', executable: false }
  }
  if (b.subarray(0, 6).toString('hex') === '377abcaf271c') {
    return { id: '7z', label: '7-Zip 压缩包', executable: false }
  }
  if (b.subarray(0, 4).toString('latin1') === 'MSCF') {
    return { id: 'cab', label: 'Windows 安装包（CAB/MSI 容器）', executable: true }
  }
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { id: 'pdf', label: 'PDF 文档', executable: false }
  }
  const head = b.subarray(0, 256).toString('utf-8')
  if (SCRIPT_SHEBANG.test(head) || /^(rem\s|@echo\s|set\s+\w+=)/i.test(head)) {
    return { id: 'script', label: '脚本文件', executable: true }
  }
  if (b.length > 0 && b.subarray(0, 512).every((c) => c === 0 || c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128)) {
    return { id: 'text', label: '文本文件', executable: false }
  }
  return { id: 'unknown', label: '未知二进制文件', executable: false }
}

/** 扫描单个文件内容（内存） */
export function analyzeBuffer(buf: Buffer, filename = ''): FileAnalysis {
  const sample = buf.length > MAX_SAMPLE ? buf.subarray(0, MAX_SAMPLE) : buf
  const fileType = detectFileType(buf, filename)
  const entropy = shannonEntropy(sample)
  const findings: string[] = []
  let level: ThreatLevel = 'none'

  const ext = extname(filename).toLowerCase()
  const lowerName = filename.toLowerCase()
  const asLatin = sample.subarray(0, Math.min(sample.length, 512 * 1024)).toString('latin1')

  // 1) 确认恶意特征
  for (const m of MALICIOUS_MARKERS) {
    if (asLatin.includes(m.marker)) {
      findings.push(m.label)
      level = 'critical'
    }
  }

  // 2) 双扩展名伪装：winword.exe.pdf / photo.jpg.exe
  const parts = lowerName.split('.').filter(Boolean)
  if (parts.length >= 3) {
    const last = `.${parts[parts.length - 1]}`
    const prev = `.${parts[parts.length - 2]}`
    if (DECOY_EXT.has(prev) && INSTALLER_EXT.has(last)) {
      findings.push(`文件名使用双扩展名伪装（${prev}${last}）`)
      level = maxLevel(level, 'high')
    }
  }

  // 3) 扩展名与实际类型不符
  if (INSTALLER_EXT.has(ext) && !fileType.executable) {
    findings.push(`扩展名 ${ext} 声称是可执行/脚本，但真实类型为「${fileType.label}」，可能是刻意伪装`)
    level = maxLevel(level, 'high')
  }
  if (DECOY_EXT.has(ext) && fileType.executable) {
    findings.push(`扩展名 ${ext} 声称是普通文件，真实类型却是「${fileType.label}」`)
    level = maxLevel(level, 'high')
  }

  // 4) 高熵 + 可执行 = 很可能被加壳/加密（免杀常见手法）
  if (fileType.executable && entropy > 7.2) {
    findings.push(`可执行文件熵值高达 ${entropy.toFixed(2)}，很可能经过加壳或加密（免杀特征）`)
    level = maxLevel(level, 'medium')
  }

  // 5) 宏文档
  if (fileType.id === 'office-cfb') {
    findings.push('老式 Office 二进制文档，可能包含 VBA 宏')
    level = maxLevel(level, 'medium')
  }

  // 6) 脚本中的危险指令
  if (fileType.id === 'script' || /\.(ps1|bat|cmd|vbs|js|jse|wsf|hta)$/i.test(lowerName)) {
    const dangerous =
      /(-enc(odedcommand)?\s|Invoke-Expression|IEX\s*\(|DownloadString|DownloadFile|FromBase64String|bitsadmin|certutil\s+-urlcache|powershell\s+-w\s+hidden|mshta\s+http|regsvr32\s+\/s)/i
    if (dangerous.test(asLatin.slice(0, 64 * 1024))) {
      findings.push('脚本中包含下载执行 / 隐藏窗口 / 编码命令等常见恶意指令')
      level = maxLevel(level, 'high')
    }
  }

  // 7) 内嵌 URL（提示可能有二次下载）
  const urlMatch = asLatin.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>]{0,80}/i)
  if (urlMatch && fileType.executable && !findings.some((f) => f.includes('恶意指令'))) {
    findings.push('文件中内嵌了外部下载地址，运行后可能联网获取更多代码')
    level = maxLevel(level, 'low')
  }

  // 8) 安装包：默认警告但可保留（特性 6）
  const installer =
    INSTALLER_EXT.has(ext) || fileType.executable || ['msi', 'cab', 'macho', 'pe'].includes(fileType.id)

  return {
    fileType,
    entropy,
    sampleSize: sample.length,
    size: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    findings,
    installer,
    threatLevel: level
  }
}

/** 扫描磁盘上的文件（只读取前 1 MiB 用于启发式，SHA-256 仍按全量计算） */
export function analyzeFile(filePath: string): FileAnalysis & { partial: boolean } {
  const st = statSync(filePath)
  const full = readFileSync(filePath)
  const a = analyzeBuffer(full, basename(filePath))
  return { ...a, size: st.size, partial: false }
}

/** 综合闸门判定 */
export function gateDownload(input: InspectInput): DownloadVerdict {
  const rules: string[] = []
  const url = input.url ?? ''
  const filename = input.filename || (url ? basename(safePathname(url)) : '') || '未命名文件'
  let level: ThreatLevel = 'none'

  const verdict = (
    action: DownloadAction,
    reason: string,
    extra: Partial<DownloadVerdict> = {}
  ): DownloadVerdict => {
    return {
      action,
      reason,
      threatLevel: level,
      fileType: '',
      installer: false,
      trusted: false,
      rules: rules.slice(),
      sha256Prefix: '',
      size: 0,
      ...extra
    }
  }

  // 0) turtlelnc 例外：任何档位都放行，且不计数
  const trustedUrl = isTrustedUrl(url)
  const trustedSigner = isTrustedSignedPublisher(input.signerName)
  if (trustedUrl.trusted || trustedSigner.trusted) {
    const why = trustedUrl.trusted ? trustedUrl.reason : trustedSigner.reason
    return verdict('allow', `turtlelnc 官方内容（${why}），已豁免全部下载拦截。`, {
      trusted: true,
      threatLevel: 'none',
      rules: ['trusted-publisher']
    })
  }

  // 1) 来源 URL 本身
  let urlScan: ScanResult | null = null
  if (url) {
    urlScan = scanUrl(url)
    if (urlScan.rule === 'malware-list' || urlScan.rule === 'phishing-list') {
      rules.push(`url:${urlScan.rule}`)
      level = 'critical'
    } else if (urlScan.blocked) {
      rules.push(`url:${urlScan.rule}`)
      level = maxLevel(level, 'medium')
    }
  }

  // 2) 文件内容分析（有内容就做，没内容只能凭 URL 与扩展名判断）
  let analysis: FileAnalysis | null = null
  if (input.buffer) {
    analysis = analyzeBuffer(input.buffer, filename)
  } else if (input.filePath) {
    try {
      analysis = analyzeFile(input.filePath)
    } catch {
      analysis = null
    }
  }

  if (analysis) {
    for (const f of analysis.findings) rules.push(`file:${f}`)
    level = maxLevel(level, analysis.threatLevel)
  }

  const ext = extname(filename).toLowerCase()
  const installerByExt = INSTALLER_EXT.has(ext)
  const installer = Boolean(analysis?.installer) || installerByExt
  if (installerByExt) rules.push(`ext:${ext}`)

  const fileTypeLabel = analysis?.fileType.label ?? (installerByExt ? '安装包（按扩展名判定）' : '未分析')
  const size = analysis?.size ?? 0
  const sha256Prefix = analysis ? analysis.sha256.slice(0, 16) : ''

  // 3) 结论
  if (level === 'critical') {
    return verdict('block', `已阻断下载：命中本地高置信度恶意特征（${firstRuleText(analysis, urlScan)}）。`, {
      threatLevel: 'critical',
      fileType: fileTypeLabel,
      installer,
      size,
      sha256Prefix
    })
  }

  if (level === 'high') {
    // 高危但未确认恶意：仍然放行由用户决定（特性 6：警告而后可保留）
    return verdict(
      'warn',
      `该文件存在高危特征：${firstRuleText(analysis, urlScan)}。已警告但不会自动删除，请确认来源后自行决定是否保留。`,
      { threatLevel: 'high', fileType: fileTypeLabel, installer, size, sha256Prefix }
    )
  }

  if (level === 'medium' || level === 'low') {
    return verdict(
      'warn',
      `该文件存在可疑特征：${firstRuleText(analysis, urlScan)}。已警告但不会阻断，可自行保留。`,
      { threatLevel: level, fileType: fileTypeLabel, installer, size, sha256Prefix }
    )
  }

  if (installer) {
    // 安装包在「无其他风险」时依然提示一次（特性 6：警告且可保留）
    return verdict(
      'warn',
      `这是一个${fileTypeLabel}，可能修改系统设置。请确认来源可信后再运行；不会自动阻断。`,
      { threatLevel: 'low', fileType: fileTypeLabel, installer: true, size, sha256Prefix }
    )
  }

  return verdict('allow', '未发现本地可见风险。', {
    threatLevel: 'none',
    fileType: fileTypeLabel,
    installer: false,
    size,
    sha256Prefix
  })
}

/** 按保护档位收敛结论：`none` 档位只提示不阻断 */
export function gateDownloadForLevel(
  level: 'enhanced' | 'standard' | 'none',
  input: InspectInput
): DownloadVerdict {
  const base = gateDownload(input)
  if (level === 'none' && base.action === 'block') {
    return {
      ...base,
      action: 'warn',
      reason: `处于「不防护」档位，仅提示不阻断：${base.reason}`,
      rules: [...base.rules, 'level:none-downgrade']
    }
  }
  return base
}

function maxLevel(a: ThreatLevel, b: ThreatLevel): ThreatLevel {
  const rank: Record<ThreatLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 }
  return rank[a] >= rank[b] ? a : b
}

function firstRuleText(analysis: FileAnalysis | null, urlScan: ScanResult | null): string {
  if (analysis && analysis.findings.length) return analysis.findings[0] ?? ''
  if (urlScan && urlScan.reason) return urlScan.reason
  return '来源或内容特征异常'
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
