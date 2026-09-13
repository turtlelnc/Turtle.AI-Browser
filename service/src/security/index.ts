/**
 * 安全模块汇总导出。
 */

export {
  BUILTIN_BLOCKLIST,
  blocklistStats,
  categoryForHost,
  hostInCategory,
  loadRuntimeBlocklists,
  type BlockCategory
} from './blocklist.js'

export {
  SUSPICIOUS_KEYWORDS,
  categoryOf,
  checkUrl,
  isBareIp,
  isInternalHost,
  isTrustedContent,
  scanUrl,
  type ScanResult
} from './url-scanner.js'

export {
  TRUSTED_EXACT_HOSTS,
  TRUSTED_GITHUB_ORGS,
  TRUSTED_PUBLISHERS,
  TRUSTED_ROOT_DOMAINS,
  isTrustedHost,
  isTrustedSignedPublisher,
  isTrustedUrl,
  type TrustedMatch
} from './trusted.js'

export {
  PROTECTION_PROFILES,
  availableCapabilities,
  isCapabilityEnabled,
  isProtectionLevel,
  shouldBlock,
  unavailableCapabilities,
  type Capability,
  type CapabilityAvailability,
  type ProtectionProfile
} from './protection.js'

export {
  analyzeBuffer,
  analyzeFile,
  detectFileType,
  gateDownload,
  gateDownloadForLevel,
  shannonEntropy,
  type DownloadAction,
  type DownloadVerdict,
  type FileAnalysis,
  type InspectInput,
  type ThreatLevel
} from './download-gate.js'

export {
  checkReputation,
  reputationHashes,
  type ReputationResult,
  type ReputationVerdict
} from './remote-reputation.js'

export { reviewExtension, type ExtensionReview, type ExtensionRiskLevel } from './extension-review.js'

import { existsSync } from 'node:fs'
import { loadRuntimeBlocklists } from './blocklist.js'
import { resolveBlocklistDir } from '../paths.js'

/**
 * 初始化安全模块：合并运行时黑名单。
 * @param blocklistDir `resources/blocklists` 目录；为空时依次尝试环境变量
 *        `TIB_BLOCKLIST_DIR` 与 `<工作目录>/resources/blocklists`，都不存在则静默跳过
 *        （内置样例列表仍然生效）。
 */
export function initSecurity(blocklistDir?: string): ReturnType<typeof loadRuntimeBlocklists> {
  const dir = resolveBlocklistDir(blocklistDir)
  if (!dir || !existsSync(dir)) {
    return { dir: dir || '(未找到黑名单目录)', files: 0, domains: 0 }
  }
  return loadRuntimeBlocklists(dir)
}
