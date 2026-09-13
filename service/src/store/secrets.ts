/**
 * 密钥加密存储（Windows DPAPI / 非 Windows 弱混淆回退）。
 *
 * 设计目标：**API Key 与 OAuth token 绝不落盘明文**。
 *
 * - Windows：通过 `powershell -NoProfile -Command` 调用 DPAPI
 *   （`ConvertTo-SecureString` / `ConvertFrom-SecureString`），密文与当前用户账户绑定，
 *   换用户或换机器都无法解密——这是 Chrome/Edge 在 Windows 上的同款方案。
 * - 非 Windows 或 PowerShell 不可用：退化为 `weak:` + base64 弱混淆，并在
 *   文件里显式写入 `insecure:true`，同时在日志与 RPC 响应中明确告知用户。
 *   这是**降级**而非等价方案，绝不能宣传为「已加密」。
 *
 * secrets.json 结构（v2）：
 * ```json
 * { "version": 2, "entries": { "apiKey": { "mode":"dpapi", "value":"01000000d08c...", "insecure":false } } }
 * ```
 * 兼容读取 v1（`{ "apiKeyEncrypted": "..." }`）。
 */

import { spawn } from 'node:child_process'
import { readJson, writeJsonAtomic } from './json-store.js'
import { userDataFile } from '../paths.js'

/** 加密模式 */
export type SecretMode = 'dpapi' | 'weak'

/** 单个密钥条目 */
export interface SecretEntry {
  /** dpapi = Windows DPAPI 密文；weak = 仅 base64 混淆（不安全） */
  mode: SecretMode
  /** 密文（dpapi 为 hex，weak 为 base64） */
  value: string
  /** 是否为不安全回退（weak 恒为 true） */
  insecure: boolean
}

interface SecretsFile {
  version: number
  entries: Record<string, SecretEntry>
}

/** PowerShell 加密脚本：stdin 收明文，stdout 输出 DPAPI hex 密文 */
const PS_ENCRYPT = [
  '$ErrorActionPreference="Stop"',
  '$p=[Console]::In.ReadToEnd()',
  '$s=ConvertTo-SecureString -String $p -AsPlainText -Force',
  '[Console]::Out.Write((ConvertFrom-SecureString -SecureString $s))'
].join('; ')

/** PowerShell 解密脚本：stdin 收 DPAPI hex 密文，stdout 输出明文 */
const PS_DECRYPT = [
  '$ErrorActionPreference="Stop"',
  '$c=[Console]::In.ReadToEnd()',
  '$s=ConvertTo-SecureString -String $c.Trim()',
  '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)',
  'try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}'
].join('; ')

const PS_TIMEOUT_MS = 15_000

/** PS 脚本被 `-Command` 直接执行，参数已固定无注入面；仍走 stdin 传数据以免命令行泄露密钥 */
function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('调用 PowerShell 超时（15 秒）'))
    }, PS_TIMEOUT_MS)
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.trim() || `PowerShell 退出码 ${code}`))
    })
    child.stdin.on('error', () => {
      /* 子进程提前退出时忽略 EPIPE */
    })
    child.stdin.end(input, 'utf-8')
  })
}

/** 密钥存储后端状态（可通过 RPC `store.getSettings` 之外的 `store.secretBackend` 查询） */
export interface SecretBackendStatus {
  mode: SecretMode
  /** 是否为不安全回退（weak） */
  insecure: boolean
  /** 中文说明，可直接展示给用户 */
  note: string
}

let cachedStatus: SecretBackendStatus | null = null

/** 探测当前平台可用的加密后端（惰性、带缓存） */
export async function resolveSecretBackend(force = false): Promise<SecretBackendStatus> {
  if (cachedStatus && !force) return cachedStatus
  const forced = process.env['TIB_SECRET_BACKEND']?.trim().toLowerCase()
  if (forced === 'weak') {
    cachedStatus = {
      mode: 'weak',
      insecure: true,
      note: '出于环境变量 TIB_SECRET_BACKEND=weak 的强制要求，密钥使用 base64 弱混淆存储（不安全）。'
    }
    return cachedStatus
  }
  if (process.platform !== 'win32') {
    cachedStatus = {
      mode: 'weak',
      insecure: true,
      note: `当前平台（${process.platform}）没有可用的系统密钥加密（DPAPI 仅 Windows 提供），密钥使用 base64 弱混淆存储（不安全）。`
    }
    return cachedStatus
  }
  // 真实试运行一次 DPAPI：探测通过后同一进程内不再重复探测
  try {
    const probe = await runPowerShell(PS_ENCRYPT, 'tib-probe')
    if (!probe.trim()) throw new Error('PowerShell 未返回密文')
    cachedStatus = {
      mode: 'dpapi',
      insecure: false,
      note: '密钥使用 Windows DPAPI 加密存储，密文与当前 Windows 用户账户绑定。'
    }
  } catch (e) {
    cachedStatus = {
      mode: 'weak',
      insecure: true,
      note: `Windows DPAPI 不可用（${e instanceof Error ? e.message : String(e)}），密钥已退化为 base64 弱混淆存储（不安全）。`
    }
  }
  return cachedStatus
}

/** 同步返回最近一次探测结果（未探测时视为 weak，宁可低估安全等级） */
export function currentSecretBackend(): SecretBackendStatus {
  return (
    cachedStatus ?? {
      mode: 'weak',
      insecure: true,
      note: '尚未探测系统加密后端，暂按不安全方式处理；请先调用 store.secretBackend。'
    }
  )
}

/** 加密明文为密钥条目 */
export async function encryptSecret(plain: string): Promise<SecretEntry> {
  if (!plain) return { mode: 'weak', value: '', insecure: true }
  const backend = await resolveSecretBackend()
  if (backend.mode === 'dpapi') {
    try {
      const hex = (await runPowerShell(PS_ENCRYPT, plain)).trim()
      if (hex) return { mode: 'dpapi', value: hex, insecure: false }
    } catch {
      // 运行期失败时退化为 weak（已写入 insecure 标记，不会谎称为加密）
    }
  }
  return { mode: 'weak', value: Buffer.from(plain, 'utf-8').toString('base64'), insecure: true }
}

/** 解密密钥条目；失败返回空串（绝不抛出，避免边车因密钥损坏无法启动） */
export async function decryptSecret(entry: SecretEntry | undefined | null): Promise<string> {
  if (!entry || !entry.value) return ''
  if (entry.mode === 'dpapi') {
    try {
      return await runPowerShell(PS_DECRYPT, entry.value)
    } catch {
      return ''
    }
  }
  try {
    return Buffer.from(entry.value, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

/**
 * 密钥文件管理器：集中读写 `<userData>/secrets.json`。
 * 所有写操作均走原子写（见 json-store.ts），避免断电/被杀导致密钥文件损坏。
 */
export class SecretStore {
  private entries: Record<string, SecretEntry> | null = null

  constructor(private readonly filePath: () => string = () => userDataFile('secrets.json')) {}

  private load(): Record<string, SecretEntry> {
    if (this.entries) return this.entries
    const raw = readJson<Partial<SecretsFile> & { apiKeyEncrypted?: string }>(this.filePath(), {})
    const entries: Record<string, SecretEntry> = {}
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw.entries ?? {})) {
        if (v && typeof v === 'object' && typeof (v as SecretEntry).value === 'string') {
          entries[k] = v as SecretEntry
        }
      }
      // 兼容 v1：{ apiKeyEncrypted: '<base64 dpapi blob>' } 或 'weak:<base64>'
      if (typeof raw.apiKeyEncrypted === 'string' && raw.apiKeyEncrypted) {
        const legacy = raw.apiKeyEncrypted
        entries['apiKey'] = legacy.startsWith('weak:')
          ? { mode: 'weak', value: legacy.slice(5), insecure: true }
          : { mode: 'dpapi', value: legacy, insecure: false }
      }
    }
    this.entries = entries
    return this.entries
  }

  private persist(): void {
    const payload: SecretsFile = { version: 2, entries: this.load() }
    writeJsonAtomic(this.filePath(), payload)
  }

  has(name: string): boolean {
    return Boolean(this.load()[name]?.value)
  }

  /** 写入密钥（空字符串表示删除）；返回条目元信息，便于上层提示是否不安全 */
  async set(name: string, plain: string): Promise<SecretEntry> {
    const value = plain ?? ''
    if (!value) {
      const entries = this.load()
      delete entries[name]
      this.persist()
      return { mode: 'weak', value: '', insecure: true }
    }
    const entry = await encryptSecret(value)
    this.load()[name] = entry
    this.persist()
    return entry
  }

  async get(name: string): Promise<string> {
    return decryptSecret(this.load()[name])
  }

  delete(name: string): void {
    const entries = this.load()
    if (!(name in entries)) return
    delete entries[name]
    this.persist()
  }

  /** 列出已保存的密钥名（不返回值） */
  names(): string[] {
    return Object.keys(this.load()).filter((k) => Boolean(this.load()[k]?.value))
  }

  /** 导出原始负载，供 .tbuser 备份（密文可原样迁移，但只能在同一 Windows 用户下解密） */
  exportPayload(): SecretsFile {
    return { version: 2, entries: { ...this.load() } }
  }

  invalidate(): void {
    this.entries = null
  }

  /** 当前加密后端状态（供 RPC/自检报告是否不安全） */
  status(): SecretBackendStatus {
    return currentSecretBackend()
  }
}

/** 全局单例（路径在首次访问时解析，便于自检切换临时 userData） */
export const secrets = new SecretStore()
