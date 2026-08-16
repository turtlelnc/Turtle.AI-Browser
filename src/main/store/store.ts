import { app, safeStorage } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppearanceConfig, SearchEngineId, SecurityConfig, Settings } from '@shared/types'
import { readJson, writeJson, userDataFile } from './fs-util'

/** 发送给渲染进程的 API key 掩码 */
const API_KEY_MASK = '••••••••'

/**
 * 设置与密钥存储。
 * - 非敏感设置写入 settings.json（可分享、可备份）。
 * - API key 使用系统安全存储（safeStorage）加密后写入 secrets.json，绝不落盘明文。
 */
class AppStore {
  private settings: Settings = structuredClone(DEFAULT_SETTINGS)
  private apiKeyPlain = ''
  private ready = false

  init(): void {
    if (this.ready) return
    const loaded = readJson<Partial<Settings>>(userDataFile('settings.json'), {})
    // 合并时忽略任何可能残留的 apiKey 字段
    const { ai: _ai, ...rest } = loaded
    void _ai
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...rest,
      ai: { ...structuredClone(DEFAULT_SETTINGS.ai), ...(loaded.ai ?? {}), apiKey: '' }
    }

    const secrets = readJson<{ apiKeyEncrypted?: string }>(userDataFile('secrets.json'), {})
    if (secrets.apiKeyEncrypted) {
      this.apiKeyPlain = this.decrypt(secrets.apiKeyEncrypted)
    }
    this.ready = true
  }

  /** 返回给渲染进程的设置（API key 只暴露掩码） */
  getSettings(): Settings {
    const copy = structuredClone(this.settings)
    copy.ai.apiKey = this.apiKeyPlain ? API_KEY_MASK : ''
    return copy
  }

  /** 更新非敏感设置；忽略渲染进程传来的 apiKey，防止掩码覆盖真实密钥 */
  setSettings(patch: Partial<Settings>): Settings {
    this.settings = {
      ...this.settings,
      ...patch,
      ai: { ...this.settings.ai, ...(patch.ai ?? {}), apiKey: '' }
    }
    writeJson(userDataFile('settings.json'), this.settings)
    return this.getSettings()
  }

  getApiKey(): string {
    return this.apiKeyPlain
  }

  hasApiKey(): boolean {
    return this.apiKeyPlain.length > 0
  }

  // ---- 只读快捷访问（避免在请求热路径上做深拷贝） ----

  getSecurity(): SecurityConfig {
    return this.settings.security
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

  setApiKey(key: string): void {
    this.apiKeyPlain = key.trim()
    writeJson(userDataFile('secrets.json'), { apiKeyEncrypted: this.encrypt(this.apiKeyPlain) })
  }

  private encrypt(plain: string): string {
    if (!plain) return ''
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString('base64')
    }
    // 无系统密钥链时退化为 base64 弱混淆，并显式标记为不安全
    return 'weak:' + Buffer.from(plain, 'utf-8').toString('base64')
  }

  private decrypt(payload: string): string {
    if (payload.startsWith('weak:')) {
      return Buffer.from(payload.slice(5), 'base64').toString('utf-8')
    }
    try {
      return safeStorage.decryptString(Buffer.from(payload, 'base64'))
    } catch {
      return ''
    }
  }
}

export const store = new AppStore()
