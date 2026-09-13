/**
 * 三档安全浏览（ARCHITECTURE.md §5）—— **诚实的能力矩阵**。
 *
 * 本地边车只能做「不需要 Google/微软云服务」的那部分。凡是必须联网比对
 * 云端威胁数据的特性，这里一律标注为 `available: false` 并给出中文原因，
 * 绝不假装已启用（假安全比没有更危险）。
 *
 * 三档：
 * - `enhanced` 增强型：本地全部能力 + 可选自建信誉端点 + 深度下载检查 + 扩展审查；
 * - `standard` 标准：本地黑名单 + 启发式 + 广告/追踪拦截；
 * - `none` 不防护：不拦截，仅保留「下载放行」提示（不阻断）。
 */

import type { ProtectionLevel } from '../shared/types.js'

/** 能力可用性 */
export type CapabilityAvailability =
  /** 本地可完整实现 */
  | 'local'
  /** 需要用户自行配置外部端点才能启用 */
  | 'requires-config'
  /** 必须依赖 Google/微软等云服务，本地不可用 */
  | 'cloud-only'

export interface Capability {
  id: string
  /** 中文名称 */
  name: string
  availability: CapabilityAvailability
  /** 中文说明：这一档下具体做什么 */
  description: string
  /** 不可用/需配置时，明确写出原因 */
  limitation?: string
}

export interface ProtectionProfile {
  level: ProtectionLevel
  /** 中文档位名 */
  label: string
  /** 一句话中文说明 */
  summary: string
  capabilities: Capability[]
}

/** 各档位共有的本地能力说明片段 */
const LOCAL_HEURISTICS: Capability = {
  id: 'local-heuristics',
  name: '本地黑名单 + 启发式扫描',
  availability: 'local',
  description:
    '内置/运行时域名黑名单、同形异义仿冒、公网裸 IP、强钓鱼关键词、URL 内嵌凭据、可疑端口检测。'
}

const TURTLE_EXCEPTION: Capability = {
  id: 'turtlelnc-exception',
  name: 'turtlelnc 白名单豁免',
  availability: 'local',
  description:
    'github.com/turtlelnc/*、*.turtlelnc.*、turtleweb.cc.cd 与已验签发布物在任何档位都不拦截、不警告、不计入统计。'
}

const AD_TRACKER: Capability = {
  id: 'ad-tracker-block',
  name: '广告 / 追踪器拦截',
  availability: 'local',
  description: '按本地黑名单拦截子资源请求（ads / tracking 分类），不影响主文档加载。'
}

const HTTPS_UPGRADE: Capability = {
  id: 'https-upgrade',
  name: 'HTTP 自动升级 HTTPS',
  availability: 'local',
  description: '非本机/内网地址的 http:// 请求自动改写为 https://。'
}

const CLOUD_REALTIME: Capability = {
  id: 'cloud-realtime-db',
  name: '实时云端威胁库比对',
  availability: 'cloud-only',
  description: '（Chrome 增强型防护的核心能力）',
  limitation:
    '必须使用 Google Safe Browsing / 微软 SmartScreen 的云端接口，需要官方 API Key 与网络回传。' +
    'TiBrowser 边车不内置任何第三方云服务的密钥，因此本地**无法**提供此能力。'
}

const CLOUD_CONTENT_SAMPLES: Capability = {
  id: 'cloud-content-samples',
  name: '混淆 URL 片段 / 页面内容 / 下载样本上报',
  availability: 'cloud-only',
  description: '（Chrome 增强型防护的上报链路）',
  limitation:
    '上报涉及用户隐私数据出境，且需要云服务账号。本地不可用；如企业自建了接收端，' +
    '可通过 `reputationEndpoint` 配置项接入自有的最小化上报。'
}

const CLOUD_CROSS_SERVICE: Capability = {
  id: 'cloud-cross-service',
  name: '登录后跨服务保护（账号级威胁关联）',
  availability: 'cloud-only',
  description: '（Chrome 的账号级保护）',
  limitation: '依赖 Google/微软账号体系与云端风控，本地无法实现。'
}

const REMOTE_REPUTATION: Capability = {
  id: 'remote-reputation',
  name: '自建 URL 信誉端点查询',
  availability: 'requires-config',
  description:
    '对本地未命中的可疑 URL，向用户自行配置的 `reputationEndpoint` 发起一次最小化查询（仅发送域名与路径哈希，不发送完整 URL、不发送页面内容）。',
  limitation:
    '需要用户在设置中填写 `reputationEndpoint` 并自行承担该服务的可信度；未配置时此能力不生效。'
}

const DEEP_DOWNLOAD: Capability = {
  id: 'deep-download-scan',
  name: '深度下载检查（文件签名 + 熵扫描）',
  availability: 'local',
  description:
    '识别 PE/ELF/Mach-O/脚本/压缩包/宏文档等真实文件类型（不信任扩展名），计算 Shannon 熵与可疑指令密度，' +
    '检测双扩展名、不可打印长串、嵌入 URL 等特征；结论为「放行 / 警告 / 阻断」，安装包默认**警告且允许保留**。'
}

const EXTENSION_REVIEW: Capability = {
  id: 'extension-review',
  name: '扩展程序安全审查',
  availability: 'local',
  description:
    '读取扩展 manifest.json，检查权限组合（<all_urls> + 内容脚本注入 + webRequest）、' +
    '远程代码执行特征（eval / new Function / 远程 script）、可疑域名，输出中文风险清单。'
}

const DOWNLOAD_RELEASE_LIST: Capability = {
  id: 'download-allow-prompt',
  name: '下载放行提示',
  availability: 'local',
  description: '不防护档位下仍然提示可疑下载并记录来源，但不阻断（用户可保留文件）。'
}

/** 三档完整能力矩阵 */
export const PROTECTION_PROFILES: Record<ProtectionLevel, ProtectionProfile> = {
  enhanced: {
    level: 'enhanced',
    label: '增强型防护',
    summary:
      '本地全部能力 + 可选自建信誉端点 + 深度下载检查 + 扩展审查。云端实时威胁库、内容上报、跨服务保护在本地不可用，已在下方明确标注。',
    capabilities: [
      LOCAL_HEURISTICS,
      AD_TRACKER,
      HTTPS_UPGRADE,
      REMOTE_REPUTATION,
      DEEP_DOWNLOAD,
      EXTENSION_REVIEW,
      TURTLE_EXCEPTION,
      CLOUD_REALTIME,
      CLOUD_CONTENT_SAMPLES,
      CLOUD_CROSS_SERVICE
    ]
  },
  standard: {
    level: 'standard',
    label: '标准防护',
    summary: '本地黑名单 + 启发式 + 广告/追踪拦截；不发起任何深度下载分析或扩展审查。',
    capabilities: [
      LOCAL_HEURISTICS,
      AD_TRACKER,
      HTTPS_UPGRADE,
      TURTLE_EXCEPTION,
      {
        ...REMOTE_REPUTATION,
        limitation: '标准档位不启用信誉端点查询（仅增强型启用）。'
      },
      CLOUD_REALTIME
    ]
  },
  none: {
    level: 'none',
    label: '不防护',
    summary: '不拦截任何网址；仅保留可疑下载的放行提示（不阻断），并继续豁免 turtlelnc 官方内容。',
    capabilities: [
      DOWNLOAD_RELEASE_LIST,
      TURTLE_EXCEPTION,
      {
        ...LOCAL_HEURISTICS,
        availability: 'requires-config',
        description: '规则仍然可用，但结果只作为提示，不产生拦截。',
        limitation: '本档位不产生任何拦截动作。'
      }
    ]
  }
}

/** 当前档位是否启用某项能力 */
export function isCapabilityEnabled(level: ProtectionLevel, capabilityId: string): boolean {
  const cap = PROTECTION_PROFILES[level]?.capabilities.find((c) => c.id === capabilityId)
  return cap?.availability === 'local'
}

/** 某档位下真正可用的能力（本地可实现的） */
export function availableCapabilities(level: ProtectionLevel): Capability[] {
  return (PROTECTION_PROFILES[level]?.capabilities ?? []).filter((c) => c.availability === 'local')
}

/** 某档位下**不可用**的能力及原因（用于 UI 诚实提示） */
export function unavailableCapabilities(level: ProtectionLevel): Capability[] {
  return (PROTECTION_PROFILES[level]?.capabilities ?? []).filter((c) => c.availability !== 'local')
}

/** 校验档位字符串 */
export function isProtectionLevel(v: unknown): v is ProtectionLevel {
  return v === 'enhanced' || v === 'standard' || v === 'none'
}

/**
 * 按档位决定是否应该拦截一个扫描结果。
 * `none` 档位永远不拦；`enhanced/standard` 都按本地规则拦截
 * （真正区别在下载深度检查与信誉查询，见 capability 矩阵）。
 */
export function shouldBlock(level: ProtectionLevel, blocked: boolean): boolean {
  if (level === 'none') return false
  return blocked
}
