/**
 * 可插拔的同步后端接口 + 本地目录实现。
 *
 * **诚实边界**：TiBrowser 边车**不提供**任何开箱即用的云端同步。
 * 微软 OneDrive / Google Drive 的同步必须由用户：
 * 1. 自行申请 OAuth 应用（拿到 client_id），
 * 2. 通过 `service/src/ai/oauth.ts` 完成授权，
 * 3. 再实现一个 `SyncBackend`（或使用本文件里「指向 OneDrive 同步文件夹」的本地实现）。
 * 我们不伪造「云端同步成功」。
 *
 * 目前提供的实现：
 * - `LocalFolderBackend`：把同步数据写进用户**自己选择的一个目录**
 *   （典型用法是选 OneDrive / 坚果云 / Dropbox 的本地同步文件夹，由这些客户端负责上云）；
 * - `UnconfiguredBackend`：未配置时的显式失败实现，返回中文错误说明为什么不可用。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { writeJsonAtomic } from '../store/json-store.js'

/** 参与同步的文件条目 */
export interface SyncEntry {
  /** 逻辑名（例如 settings.json / bookmarks.json） */
  name: string
  /** 内容哈希（sha256 前 32 位十六进制） */
  hash: string
  size: number
  /** 本地最后修改时间 */
  mtime: number
}

/** 同步清单：记录每个文件在「本地」与「远端」两个侧的状态 */
export interface SyncManifest {
  version: number
  /** 逻辑设备名 */
  device: string
  /** 上次成功同步时间 */
  lastSyncedAt: number
  /** 上次同步后本地是否有改动 */
  dirty: boolean
  /** 条目：name → 状态 */
  entries: Record<string, { local: SyncEntry | null; remote: SyncEntry | null; syncedAt: number }>
}

export function emptyManifest(device = deviceName()): SyncManifest {
  return { version: 1, device, lastSyncedAt: 0, dirty: false, entries: {} }
}

/** 本机设备名（用于区分多设备的同步目录） */
export function deviceName(): string {
  const h = hostname().replace(/[^\w.-]/g, '-')
  return h || 'device'
}

/** 后端能力描述（供 UI 诚实展示） */
export interface SyncBackendInfo {
  id: string
  /** 中文名 */
  name: string
  /** 是否需要用户额外配置 */
  configured: boolean
  /** 中文说明（含限制） */
  description: string
}

/** 推送/拉取的结果 */
export interface SyncTransferResult {
  ok: boolean
  /** 传输的文件数 */
  files: number
  /** 传输的字节数 */
  bytes: number
  /** 中文消息 */
  message: string
}

/** 冲突信息 */
export interface SyncConflict {
  name: string
  localMtime: number
  remoteMtime: number
  /** 中文说明 */
  message: string
}

/**
 * 同步后端接口。
 * 实现方只需关心「文件级读写」，冲突检测与清单由 `syncService` 负责。
 */
export interface SyncBackend {
  info(): SyncBackendInfo
  /** 远端是否已有设备目录（首次同步返回 false） */
  exists(): Promise<boolean>
  /** 列出远端已存在的逻辑文件名 */
  list(): Promise<string[]>
  /** 读取远端某个文件（不存在返回 null） */
  read(name: string): Promise<Buffer | null>
  /** 写入远端某个文件 */
  write(name: string, data: Buffer): Promise<void>
  /** 删除远端某个文件 */
  remove(name: string): Promise<void>
}

/** 需要同步的逻辑文件白名单（同时决定导出顺序） */
export const SYNCABLE_FILES = [
  'settings.json',
  'bookmarks.json',
  'history.json',
  'downloads.json',
  'mcp.json',
  'accounts.json'
] as const

/** 永不参与云同步的本地文件 */
export const NEVER_SYNC = new Set(['secrets.json', 'automation.json', 'native-bridge.json'])

/** 计算内容哈希 */
export function hashContent(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 32)
}

/**
 * 本地文件夹后端：一个用户指定的目录。
 *
 * 目录结构：
 * ```
 * <root>/devices/<device>/settings.json …
 * <root>/manifest.json         （供人工排查，不参与合并）
 * ```
 * 之所以按设备分目录，是为了避免两台机器直接互相覆盖；合并策略由上层决定。
 */
export class LocalFolderBackend implements SyncBackend {
  constructor(
    private readonly root: string,
    private readonly device: string = deviceName()
  ) {}

  info(): SyncBackendInfo {
    return {
      id: 'local-folder',
      name: '本地/网盘文件夹',
      configured: Boolean(this.root?.trim()),
      description: this.root?.trim()
        ? `同步到目录：${this.root}（在该目录内按设备名分子目录保存；如指向 OneDrive / 坚果云 / Dropbox 的本地同步文件夹，则由这些客户端负责上云，TiBrowser 不直接访问任何云 API）。`
        : '尚未选择同步目录。'
    }
  }

  private deviceDir(): string {
    return join(resolve(this.root), 'devices', this.device)
  }

  async exists(): Promise<boolean> {
    return existsSync(this.deviceDir())
  }

  async list(): Promise<string[]> {
    const dir = this.deviceDir()
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir).filter((f) => !f.endsWith('.tmp'))
    } catch {
      return []
    }
  }

  async read(name: string): Promise<Buffer | null> {
    const target = this.safePath(name)
    if (!existsSync(target)) return null
    try {
      return readFileSync(target)
    } catch {
      return null
    }
  }

  async write(name: string, data: Buffer): Promise<void> {
    const target = this.safePath(name)
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, target)
  }

  async remove(name: string): Promise<void> {
    const target = this.safePath(name)
    rmSync(target, { force: true })
  }

  /** 写入 manifest 快照，便于用户人工排查（不参与合并） */
  async snapshot(manifest: SyncManifest): Promise<void> {
    writeJsonAtomic(join(resolve(this.root), 'manifest.json'), manifest)
  }

  private safePath(name: string): string {
    if (!this.root?.trim()) throw new Error('尚未选择同步目录。')
    // 只允许白名单逻辑名，彻底避免路径穿越
    const clean = basename(name)
    if (clean !== name || clean.includes('..')) {
      throw new Error(`非法的同步文件名：${name}`)
    }
    const dir = this.deviceDir()
    const target = resolve(dir, clean)
    const rel = relative(resolve(dir), target)
    if (rel.startsWith('..') || rel.includes(sep + '..')) {
      throw new Error(`同步路径越界：${name}`)
    }
    return target
  }
}

/**
 * 未配置后端：所有操作显式失败，并说明为什么不可用。
 * 用于「用户选了云同步但没走完 OAuth」的场景，避免出现假成功。
 */
export class UnconfiguredBackend implements SyncBackend {
  constructor(private readonly reason: string) {}

  info(): SyncBackendInfo {
    return { id: 'unconfigured', name: '未配置', configured: false, description: this.reason }
  }

  async exists(): Promise<boolean> {
    return false
  }

  async list(): Promise<string[]> {
    return []
  }

  async read(): Promise<Buffer | null> {
    throw new Error(this.reason)
  }

  async write(): Promise<void> {
    throw new Error(this.reason)
  }

  async remove(): Promise<void> {
    throw new Error(this.reason)
  }
}

/** 为 Microsoft / Google 云同步生成的「未配置」后端，文案明确指出需要用户自备 client_id */
export function cloudBackendPlaceholder(provider: 'microsoft' | 'google'): UnconfiguredBackend {
  const name = provider === 'microsoft' ? 'Microsoft 账户' : 'Google 账户'
  return new UnconfiguredBackend(
    `${name}云同步需要用户自行申请 OAuth 应用并提供 client_id（TiBrowser 不内置任何第三方 client_id，也不伪造云同步成功）。` +
      `请先在「账户」设置中填写 client_id 并完成授权登录；授权成功后边车会通过 OAuth 助手拿到令牌，再由对应后端上传/下载同步数据。` +
      `如果你只想用网盘自带的同步客户端，也可以把同步目录指向 OneDrive / Google Drive 的本地文件夹（本地文件夹后端）。`
  )
}

/** 收集本地待同步文件（只读，不修改任何文件） */
export function collectLocalFiles(userDataDir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const root = resolve(userDataDir)
  for (const name of SYNCABLE_FILES) {
    if (NEVER_SYNC.has(name)) continue
    const p = join(root, name)
    if (!existsSync(p)) continue
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      out.set(name, readFileSync(p))
    } catch {
      /* 跳过读不到的文件 */
    }
  }
  return out
}

/** 由文件内容生成条目 */
export function toEntry(name: string, buf: Buffer, mtime: number): SyncEntry {
  return { name, hash: hashContent(buf), size: buf.length, mtime }
}

/** 列出本地文件条目（含 mtime） */
export function localEntries(userDataDir: string): SyncEntry[] {
  const root = resolve(userDataDir)
  const out: SyncEntry[] = []
  for (const name of SYNCABLE_FILES) {
    const p = join(root, name)
    if (!existsSync(p)) continue
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      const buf = readFileSync(p)
      out.push(toEntry(name, buf, st.mtimeMs))
    } catch {
      /* 跳过 */
    }
  }
  return out
}
