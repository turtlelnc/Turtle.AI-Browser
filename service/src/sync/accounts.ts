/**
 * 账户与同步的**本地半边**（特性 3）。
 *
 * 实现范围（诚实声明）：
 * - ✅ 账户记录：哪个服务商、显示名、登录时间、令牌是否存在（**不存令牌明文**，令牌在 secrets.json）；
 * - ✅ 同步清单：每个逻辑文件的本地/远端哈希与时间戳、上次同步时间、脏标记；
 * - ✅ 冲突检测：本地与远端都改过 → 标记冲突，交由用户决定保留哪一侧；
 * - ✅ 可插拔 `SyncBackend`（见 `./backend.ts`，含本地/网盘文件夹实现）；
 * - ❌ 真正的 Microsoft / Google 云端同步：必须由用户自备 OAuth client_id 并完成授权，
 *   未配置时 `syncNow()` 返回明确的中文错误，**不会假装同步成功**。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ServiceSettings } from '../shared/types.js'
import { userDataFile } from '../paths.js'
import { readJson, writeJsonAtomic } from '../store/json-store.js'
import { secrets } from '../store/secrets.js'
import { loadTokens, tokenSecretName } from '../ai/oauth.js'
import {
  LocalFolderBackend,
  UnconfiguredBackend,
  cloudBackendPlaceholder,
  collectLocalFiles,
  deviceName,
  emptyManifest,
  hashContent,
  localEntries,
  type SyncBackend,
  type SyncConflict,
  type SyncEntry,
  type SyncManifest
} from './backend.js'
import { invalidateStoreCaches } from '../store/index.js'

/** 支持的账户服务商 */
export type AccountProvider = 'microsoft' | 'google' | 'local-folder' | 'custom'

export interface AccountRecord {
  id: string
  provider: AccountProvider
  /** 服务商显示名（中文） */
  providerName: string
  /** 显示名（邮箱或用户自定义；未授权前为空） */
  displayName: string
  /** 是否已登录（为 true 时 secrets.json 中应有令牌） */
  signedIn: boolean
  /** 上次登录时间 */
  signedInAt: number
  /** 中文备注（例如「需用户自备 client_id」） */
  note: string
}

export interface SyncState {
  /** 账户列表 */
  accounts: AccountRecord[]
  /** 当前后端信息 */
  backend: { id: string; name: string; configured: boolean; description: string }
  /** 上次同步时间（0 表示从未同步） */
  lastSyncedAt: number
  /** 自上次同步后本地是否有改动 */
  dirty: boolean
  /** 有差异的文件数 */
  pending: number
  /** 冲突列表 */
  conflicts: SyncConflict[]
  /** 本机设备名 */
  device: string
  /** 中文状态说明 */
  message: string
}

export interface SyncNowResult {
  ok: boolean
  /** 同步方向 */
  direction: 'push' | 'pull' | 'both' | 'none'
  files: number
  bytes: number
  conflicts: SyncConflict[]
  message: string
}

const ACCOUNTS_FILE = 'accounts.json'
const MANIFEST_FILE = 'sync-manifest.json'

interface AccountsFile {
  version: number
  accounts: AccountRecord[]
}

/** 账户与同步服务 */
export class AccountService {
  private backend: SyncBackend
  private manifest: SyncManifest | null = null

  constructor(
    private readonly deps: {
      /** 读取当前设置（决定同步目录） */
      getSettings: () => ServiceSettings
      /** 用户数据目录 */
      userDataDir: () => string
      /** 令牌是否存在的检查（默认查 secrets.json） */
      hasToken?: (provider: string) => Promise<boolean>
      /** 事件广播（accountsChanged） */
      emit?: (event: 'accountsChanged', payload: unknown) => void
    }
  ) {
    this.backend = this.createBackend()
  }

  /** 依据设置构造后端 */
  private createBackend(): SyncBackend {
    // 同步目录复用 workspace.root 之外的一个独立配置：settings.syncFolder（可选）
    const folder = (this.deps.getSettings() as ServiceSettings & { syncFolder?: string }).syncFolder?.trim()
    if (folder) return new LocalFolderBackend(folder)
    return new UnconfiguredBackend(
      '尚未选择同步目录（settings.syncFolder）。可选择 OneDrive / 坚果云 / Dropbox 的**本地同步文件夹**作为同步目录，' +
        '由这些客户端负责上云；或为 Microsoft / Google 配置你自己的 OAuth client_id 后使用云端后端。'
    )
  }

  /** 重新读取设置并切换后端（设置变更后调用） */
  reloadBackend(): void {
    this.backend = this.createBackend()
  }

  /** 当前后端（供测试注入替身） */
  setBackend(backend: SyncBackend): void {
    this.backend = backend
  }

  getBackend(): SyncBackend {
    return this.backend
  }

  // ---------- 账户读写 ----------

  listAccounts(): AccountRecord[] {
    this.ensureDefaults()
    return readJson<AccountsFile>(userDataFile(ACCOUNTS_FILE), { version: 1, accounts: [] }).accounts
  }

  private saveAccounts(accounts: AccountRecord[]): void {
    writeJsonAtomic(userDataFile(ACCOUNTS_FILE), { version: 1, accounts } satisfies AccountsFile)
  }

  /** 首次运行时写入两个占位账户记录（未登录） */
  private ensureDefaults(): void {
    if (existsSync(userDataFile(ACCOUNTS_FILE))) return
    const now = Date.now()
    const accounts: AccountRecord[] = [
      {
        id: randomUUID(),
        provider: 'microsoft',
        providerName: 'Microsoft 账户',
        displayName: '',
        signedIn: false,
        signedInAt: 0,
        note: '需用户自备 OAuth client_id（TiBrowser 不内置第三方 client_id）。授权通过 ai.oauth.* 流程完成。'
      },
      {
        id: randomUUID(),
        provider: 'google',
        providerName: 'Google 账户',
        displayName: '',
        signedIn: false,
        signedInAt: 0,
        note: '需用户自备 OAuth client_id。授权通过 ai.oauth.* 流程完成。'
      },
      {
        id: randomUUID(),
        provider: 'local-folder',
        providerName: '本地 / 网盘文件夹',
        displayName: '',
        signedIn: false,
        signedInAt: 0,
        note: '无需登录：在设置里指定一个同步目录即可（例如 OneDrive 的本地同步文件夹）。'
      }
    ]
    void now
    this.saveAccounts(accounts)
  }

  /**
   * 记录一次登录。
   * **注意**：本方法只负责账户记录的落盘；令牌写入由 `ai/oauth.ts` 完成。
   * 若此时 secrets.json 中没有对应令牌，会把 signedIn 置为 false 并说明原因，避免谎称已登录。
   */
  async signIn(provider: AccountProvider, displayName = ''): Promise<AccountRecord> {
    this.ensureDefaults()
    const accounts = this.listAccounts()
    const idx = accounts.findIndex((a) => a.provider === provider)
    const hasToken =
      provider === 'local-folder'
        ? Boolean((this.deps.getSettings() as ServiceSettings & { syncFolder?: string }).syncFolder?.trim())
        : await this.tokenExists(provider)

    const record: AccountRecord = {
      id: idx >= 0 ? (accounts[idx]?.id ?? randomUUID()) : randomUUID(),
      provider,
      providerName: providerName(provider),
      displayName: displayName || (idx >= 0 ? (accounts[idx]?.displayName ?? '') : ''),
      signedIn: hasToken,
      signedInAt: hasToken ? Date.now() : 0,
      note: hasToken
        ? '已登录。'
        : provider === 'local-folder'
          ? '尚未选择同步目录，因此未视为已登录。'
          : `尚未取得该服务商的令牌（${tokenSecretName(provider)} 不在 secrets.json 中）。请先完成 ai.oauth.start 授权流程；未授权前不会被标记为已登录。`
    }
    if (idx >= 0) accounts[idx] = record
    else accounts.push(record)
    this.saveAccounts(accounts)
    this.deps.emit?.('accountsChanged', { accounts, syncState: await this.getSyncState() })
    return record
  }

  /** 登出：删除令牌、清空登录标记（不删除本地数据） */
  async signOut(provider: AccountProvider): Promise<{ ok: boolean; message: string }> {
    this.ensureDefaults()
    secrets.delete(tokenSecretName(provider))
    const accounts = this.listAccounts()
    const idx = accounts.findIndex((a) => a.provider === provider)
    if (idx >= 0) {
      accounts[idx] = {
        ...(accounts[idx] as AccountRecord),
        signedIn: false,
        signedInAt: 0,
        note: '已登出；本地数据未被删除。'
      }
      this.saveAccounts(accounts)
    }
    this.deps.emit?.('accountsChanged', { accounts, syncState: await this.getSyncState() })
    return { ok: true, message: `已登出 ${providerName(provider)}，本地数据未被删除。` }
  }

  private async tokenExists(provider: string): Promise<boolean> {
    if (this.deps.hasToken) return this.deps.hasToken(provider)
    try {
      const tokens = await loadTokens(provider)
      return Boolean(tokens?.accessToken)
    } catch {
      return false
    }
  }

  // ---------- 同步清单 ----------

  loadManifest(): SyncManifest {
    if (this.manifest) return this.manifest
    const raw = readJson<SyncManifest | null>(userDataFile(MANIFEST_FILE), null)
    this.manifest = raw && raw.version === 1 ? raw : emptyManifest()
    return this.manifest
  }

  private saveManifest(): void {
    writeJsonAtomic(userDataFile(MANIFEST_FILE), this.loadManifest())
  }

  /** 计算当前差异与冲突（不传输任何数据） */
  async diff(): Promise<{ entries: SyncEntry[]; conflicts: SyncConflict[]; pending: number }> {
    const locals = localEntries(this.deps.userDataDir())
    const manifest = this.loadManifest()
    const conflicts: SyncConflict[] = []
    let pending = 0

    let remoteNames: string[] = []
    try {
      remoteNames = await this.backend.list()
    } catch {
      remoteNames = []
    }

    for (const local of locals) {
      const remote = await this.backend.read(local.name).catch(() => null)
      const remoteHash = remote ? hashContent(remote) : null
      const tracked = manifest.entries[local.name]

      if (!remoteHash) {
        if (!tracked?.remote || tracked.remote.hash !== local.hash) pending++
        continue
      }
      if (remoteHash === local.hash) continue

      // 双改判定：本地与远端都与上次同步点不同 → 冲突
      const localChangedSinceSync = !tracked?.local || tracked.local.hash !== local.hash
      const remoteChangedSinceSync = !tracked?.remote || tracked.remote.hash !== remoteHash
      if (localChangedSinceSync && remoteChangedSinceSync && tracked?.syncedAt) {
        conflicts.push({
          name: local.name,
          localMtime: local.mtime,
          remoteMtime: 0,
          message: `文件「${local.name}」在本机与同步目录都被修改过，需要选择保留哪一侧。`
        })
      } else {
        pending++
      }
    }

    // 远端有、本地没有的文件也算待处理
    for (const name of remoteNames) {
      if (locals.some((l) => l.name === name)) continue
      if (!existsSync(join(resolve(this.deps.userDataDir()), name))) pending++
    }

    return { entries: locals, conflicts, pending }
  }

  /** 同步状态（供 UI 与 RPC） */
  async getSyncState(): Promise<SyncState> {
    this.ensureDefaults()
    const manifest = this.loadManifest()
    const info = this.backend.info()
    let conflicts: SyncConflict[] = []
    let pending = 0
    let message = ''
    try {
      const d = await this.diff()
      conflicts = d.conflicts
      pending = d.pending
      message =
        conflicts.length > 0
          ? `检测到 ${conflicts.length} 个冲突，请选择保留本地或远端。`
          : pending > 0
            ? `有 ${pending} 个文件待同步。`
            : '本地与同步目录一致。'
    } catch (e) {
      message = `无法读取同步目录：${e instanceof Error ? e.message : String(e)}`
    }
    return {
      accounts: this.listAccounts(),
      backend: info,
      lastSyncedAt: manifest.lastSyncedAt,
      dirty: manifest.dirty || pending > 0 || conflicts.length > 0,
      pending,
      conflicts,
      device: manifest.device || deviceName(),
      message
    }
  }

  /**
   * 立即同步。
   * @param direction push = 只上传；pull = 只下载；both = 先拉后推（默认）
   * @param resolveConflict 冲突处理策略：keep-local 用本地覆盖远端；use-remote 用远端覆盖本地；skip 跳过
   */
  async syncNow(
    direction: 'push' | 'pull' | 'both' = 'both',
    resolveConflict: 'keep-local' | 'use-remote' | 'skip' = 'skip'
  ): Promise<SyncNowResult> {
    const info = this.backend.info()
    if (!info.configured) {
      return {
        ok: false,
        direction: 'none',
        files: 0,
        bytes: 0,
        conflicts: [],
        message: info.description
      }
    }

    const manifest = this.loadManifest()
    const { conflicts } = await this.diff()
    if (conflicts.length && resolveConflict === 'skip') {
      return {
        ok: false,
        direction: 'none',
        files: 0,
        bytes: 0,
        conflicts,
        message: `检测到 ${conflicts.length} 个冲突，已暂停同步。请指定 resolveConflict（keep-local 或 use-remote）后重试。`
      }
    }

    let files = 0
    let bytes = 0
    const startDir = resolve(this.deps.userDataDir())

    // 拉取
    if (direction === 'pull' || direction === 'both') {
      let remoteNames: string[] = []
      try {
        remoteNames = await this.backend.list()
      } catch (e) {
        return {
          ok: false,
          direction: 'pull',
          files,
          bytes,
          conflicts,
          message: `读取同步目录失败：${e instanceof Error ? e.message : String(e)}`
        }
      }
      for (const name of remoteNames) {
        const conflict = conflicts.find((c) => c.name === name)
        if (conflict && resolveConflict === 'keep-local') continue
        const data = await this.backend.read(name).catch(() => null)
        if (!data) continue
        try {
          writeFileSync(join(startDir, name), data)
          files++
          bytes += data.length
        } catch {
          /* 跳过写入失败的文件 */
        }
      }
    }

    // 推送
    if (direction === 'push' || direction === 'both') {
      const locals = collectLocalFiles(startDir)
      for (const [name, buf] of locals) {
        const conflict = conflicts.find((c) => c.name === name)
        if (conflict && resolveConflict === 'use-remote') continue
        const remote = await this.backend.read(name).catch(() => null)
        if (remote && hashContent(remote) === hashContent(buf)) continue
        try {
          await this.backend.write(name, buf)
          files++
          bytes += buf.length
        } catch (e) {
          return {
            ok: false,
            direction: 'push',
            files,
            bytes,
            conflicts,
            message: `写入同步目录失败：${e instanceof Error ? e.message : String(e)}`
          }
        }
      }
    }

    // 更新清单
    const now = Date.now()
    for (const local of localEntries(startDir)) {
      const remote = await this.backend.read(local.name).catch(() => null)
      manifest.entries[local.name] = {
        local,
        remote: remote
          ? { name: local.name, hash: hashContent(remote), size: remote.length, mtime: now }
          : null,
        syncedAt: now
      }
    }
    manifest.lastSyncedAt = now
    manifest.dirty = false
    manifest.device = manifest.device || deviceName()
    this.saveManifest()

    // 拉取过的数据要让内存缓存失效，否则设置/书签还是旧的
    if (direction === 'pull' || direction === 'both') invalidateStoreCaches()

    const result: SyncNowResult = {
      ok: true,
      direction,
      files,
      bytes,
      conflicts: [],
      message: `同步完成：传输 ${files} 个文件（${bytes} 字节），目标为「${info.name}」。注意：这是**文件级**同步，不做逐条合并；同一文件两侧都改过时以上述冲突策略为准。`
    }
    this.deps.emit?.('accountsChanged', { accounts: this.listAccounts(), syncState: await this.getSyncState() })
    return result
  }

  invalidate(): void {
    this.manifest = null
  }
}

function providerName(provider: AccountProvider): string {
  return (
    {
      microsoft: 'Microsoft 账户',
      google: 'Google 账户',
      'local-folder': '本地 / 网盘文件夹',
      custom: '自定义服务商'
    }[provider] ?? String(provider)
  )
}

export { cloudBackendPlaceholder, LocalFolderBackend }
