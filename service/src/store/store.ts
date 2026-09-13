/**
 * 设置与密钥存储（无 Electron 版本）。
 *
 * 对应 v0.1.0 的 `src/main/store/store.ts`，但：
 * - 用本模块的 `secrets`（DPAPI）替代 Electron `safeStorage`；
 * - 增加三档安全浏览的 `protectionLevel`（ARCHITECTURE.md §5）；
 * - 增加边车专属的 `automation`（本地自动化 API）与 `reputationEndpoint`（可选信誉服务）。
 *
 * 规则：
 * - `<userData>/settings.json` 只存**非敏感**配置，不写入 API Key；
 * - API Key 只以密文形式存在于 `<userData>/secrets.json`；
 * - `getSettings()` 返回的 API Key 一律是掩码 `••••••••`。
 */

import { DEFAULT_SETTINGS } from '../shared/constants.js'
import type {
  AppearanceConfig,
  AiProviderConfig,
  ProtectionLevel,
  SearchEngineId,
  SecurityConfig,
  ServiceSettings
} from '../shared/types.js'
import { userDataFile } from '../paths.js'
import { readJson, writeJsonAtomic } from './json-store.js'
import { secrets, type SecretBackendStatus } from './secrets.js'

/** 发送给调用方的 API key 掩码 */
export const API_KEY_MASK = '••••••••'

/** 密钥在 secrets.json 中的条目名 */
const API_KEY_SECRET = 'apiKey'

/** 设置文件的持久化结构（含边车扩展项） */
export interface PersistedSettings extends ServiceSettings {
  /** 结构版本，便于后续迁移 */
  version: number
}

/** 默认的边车扩展设置 */
export const DEFAULT_SERVICE_EXTENSIONS = {
  protectionLevel: 'standard' as ProtectionLevel,
  automation: { enabled: false },
  workspace: {
    /** 本地开发模式的工作区根目录（必须由用户显式授权） */
    root: '',
    /** 允许执行的命令前缀白名单（如 npm、node、git、npx、python） */
    allowCommands: ['node', 'npm', 'npx', 'git', 'tsc'],
    /** 只读演练：为 true 时不真正写文件/执行命令 */
    dryRun: true
  },
  reputationEndpoint: ''
}

function defaults(): PersistedSettings {
  return {
    version: 1,
    ...(structuredClone(DEFAULT_SETTINGS) as ServiceSettings),
    ...structuredClone(DEFAULT_SERVICE_EXTENSIONS)
  }
}

/**
 * 应用设置存储。
 *
 * 生命周期：`init()` → `getSettings()` / `setSettings()` / `setApiKey()`。
 */
class AppStore {
  private settings: PersistedSettings = defaults()
  private apiKeyPlain = ''
  private ready = false

  /** 加载磁盘设置（幂等）。返回是否发现了残留的 apiKey 字段（异常情况，会记录） */
  init(): { loaded: boolean; legacyApiKeyIgnored: boolean } {
    if (this.ready) return { loaded: true, legacyApiKeyIgnored: false }
    const loaded = readJson<Partial<PersistedSettings>>(userDataFile('settings.json'), {})
    // 合并时忽略任何可能残留的 apiKey 字段（明文绝不落盘）
    const { ai: _ai, ...rest } = loaded
    void _ai
    const base = defaults()
    const legacyApiKeyIgnored = Boolean((loaded.ai as AiProviderConfig | undefined)?.apiKey)
    this.settings = {
      ...base,
      ...rest,
      ai: { ...base.ai, ...(loaded.ai ?? {}), apiKey: '' },
      security: { ...base.security, ...(loaded.security ?? {}) },
      appearance: { ...base.appearance, ...(loaded.appearance ?? {}) },
      automation: { ...base.automation, ...(loaded.automation ?? {}) },
      workspace: { ...base.workspace, ...(loaded.workspace ?? {}) }
    }
    this.ready = true
    // 密钥解密是异步的（可能调用 PowerShell），这里同步返回，由 initSecret() 补齐
    return { loaded: true, legacyApiKeyIgnored }
  }

  /** 异步加载密钥（必须由启动流程 await，之后 getApiKey() 才准确） */
  async initSecret(): Promise<SecretBackendStatus> {
    this.init()
    this.apiKeyPlain = await secrets.get(API_KEY_SECRET)
    // 启动时真实探测一次加密后端（Windows 上会试跑一次 PowerShell 验证 DPAPI 可用），
    // 否则「是否不安全」的状态在第一次写入密钥前都是未知的，会误导用户。
    return secrets.probe()
  }

  /** 返回给调用方的设置（API key 只暴露掩码） */
  getSettings(): PersistedSettings {
    const copy = structuredClone(this.settings)
    copy.ai.apiKey = this.apiKeyPlain ? API_KEY_MASK : ''
    return copy
  }

  /** 更新非敏感设置；忽略传入的 apiKey，防止掩码覆盖真实密钥 */
  setSettings(patch: Partial<ServiceSettings>): PersistedSettings {
    this.init()
    const merged: PersistedSettings = {
      ...this.settings,
      ...patch,
      version: this.settings.version,
      ai: { ...this.settings.ai, ...(patch.ai ?? {}), apiKey: '' },
      security: { ...this.settings.security, ...(patch.security ?? {}) },
      appearance: { ...this.settings.appearance, ...(patch.appearance ?? {}) },
      automation: { ...this.settings.automation, ...(patch.automation ?? {}) },
      workspace: { ...this.settings.workspace, ...(patch.workspace ?? {}) }
    }
    this.settings = merged
    this.persist()
    return this.getSettings()
  }

  private persist(): void {
    const payload: PersistedSettings = { ...this.settings, ai: { ...this.settings.ai, apiKey: '' } }
    writeJsonAtomic(userDataFile('settings.json'), payload)
  }

  hasApiKey(): boolean {
    return this.apiKeyPlain.length > 0
  }

  /** 内存中的明文密钥（仅供发起模型请求使用，绝不落盘、绝不经 RPC 返回） */
  getApiKey(): string {
    return this.apiKeyPlain
  }

  /** 保存或清除 API Key（加密后写入 secrets.json），返回后端状态用于提示是否不安全 */
  async setApiKey(key: string): Promise<SecretBackendStatus> {
    const trimmed = (key ?? '').trim()
    // 掩码或空串代表「保持原有密钥不变」；显式传空串即清除
    if (trimmed === API_KEY_MASK) return secrets.status()
    this.apiKeyPlain = trimmed
    const entry = await secrets.set(API_KEY_SECRET, trimmed)
    return {
      mode: entry.mode,
      insecure: entry.insecure,
      note: entry.insecure
        ? '密钥已保存，但当前使用 base64 弱混淆存储（不安全），建议在 Windows 上运行以启用 DPAPI。'
        : '密钥已使用 Windows DPAPI 加密保存。'
    }
  }

  // ---- 只读快捷访问（避免在请求热路径上做深拷贝） ----

  getSecurity(): SecurityConfig {
    return this.settings.security
  }

  getAi(): AiProviderConfig {
    return { ...this.settings.ai, apiKey: this.apiKeyPlain }
  }

  getSearchEngine(): SearchEngineId {
    return this.settings.searchEngine
  }

  getAppearance(): AppearanceConfig {
    return this.settings.appearance
  }

  getHomepage(): string {
    return this.settings.homepage
  }

  getProtectionLevel(): ProtectionLevel {
    return this.settings.protectionLevel
  }

  setProtectionLevel(level: ProtectionLevel): PersistedSettings {
    return this.setSettings({ protectionLevel: level })
  }

  getAutomation(): { enabled: boolean } {
    return this.settings.automation
  }

  getWorkspace(): PersistedSettings['workspace'] {
    return this.settings.workspace
  }

  getReputationEndpoint(): string {
    return this.settings.reputationEndpoint
  }

  /** 用户数据目录切换 / 导入配置后重置内存状态 */
  invalidate(): void {
    this.ready = false
    this.apiKeyPlain = ''
    this.settings = defaults()
    secrets.invalidate()
  }
}

export const store = new AppStore()
