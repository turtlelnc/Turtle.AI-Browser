/**
 * JSON 持久化工具。
 *
 * ⚠️ 历史回归：v0.1.0 直接 `writeFileSync` 覆盖目标文件，
 * 进程在写入中途被杀（或磁盘写满）会留下**半截 JSON**，导致设置/书签全部丢失。
 * 本模块一律使用「临时文件 + fsync + rename」的原子写：
 *   - 同目录内写 `xxx.json.<pid>.<rand>.tmp`；
 *   - `fsync` 刷盘后再 `rename` 覆盖目标（NTFS/POSIX 上 rename 覆盖是原子的）；
 *   - 失败时清理临时文件并抛出中文错误。
 * 读取侧对损坏文件始终返回回退值，绝不让边车因数据文件损坏而崩溃。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/** 读取 JSON；文件不存在 / 解析失败 / 无权限时返回回退值 */
export function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback
    const raw = readFileSync(filePath, 'utf-8').trim()
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    // 损坏文件不抛出：边车必须以默认值继续工作（并保留坏文件供人工排查）
    return fallback
  }
}

/** 读取 JSON 并报告是否成功（用于「数据文件损坏」提示） */
export function tryReadJson<T>(filePath: string, fallback: T): { value: T; ok: boolean; error?: string } {
  try {
    if (!existsSync(filePath)) return { value: fallback, ok: false, error: '文件不存在' }
    const raw = readFileSync(filePath, 'utf-8').trim()
    if (!raw) return { value: fallback, ok: false, error: '文件为空' }
    return { value: JSON.parse(raw) as T, ok: true }
  } catch (e) {
    return { value: fallback, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 原子写入 JSON 文件（自动创建父目录）。写入失败抛出中文错误。 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const text = JSON.stringify(data, null, 2)
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tmp, 'w', 0o600)
    const buf = Buffer.from(text, 'utf-8')
    let offset = 0
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset)
    }
    fsyncSync(fd)
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
      fd = null
    }
    rmSync(tmp, { force: true })
    throw new Error(`写入文件失败：${filePath}（${e instanceof Error ? e.message : String(e)}）`)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
  }
  try {
    renameSync(tmp, filePath)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw new Error(`替换文件失败：${filePath}（${e instanceof Error ? e.message : String(e)}）`)
  }
}

/**
 * 带内存缓存的 JSON 集合。
 * 适合书签/历史/下载这类「小数组、频繁读写」的数据。
 */
export class JsonCollection<T> {
  private cache: T[] | null = null

  constructor(
    private readonly filePath: () => string,
    private readonly limit = Number.POSITIVE_INFINITY
  ) {}

  /** 读取（返回内部数组的浅拷贝引用，调用方不得直接改动元素顺序以外的结构） */
  all(): T[] {
    if (this.cache) return this.cache
    const loaded = readJson<unknown>(this.filePath(), [])
    this.cache = Array.isArray(loaded) ? (loaded as T[]) : []
    return this.cache
  }

  /** 覆盖写入并落盘 */
  replace(items: T[]): void {
    this.cache = this.limit === Number.POSITIVE_INFINITY ? items : items.slice(-this.limit)
    writeJsonAtomic(this.filePath(), this.cache)
  }

  /** 读取 → 变换 → 原子落盘 */
  mutate(fn: (items: T[]) => T[]): T[] {
    const next = fn(this.all().slice())
    this.replace(next)
    return this.cache ?? []
  }

  /** 丢弃内存缓存（用户数据目录切换 / 导入配置后调用） */
  invalidate(): void {
    this.cache = null
  }
}
