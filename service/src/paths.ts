/**
 * 用户数据目录解析。
 *
 * Windows 上使用 `%LOCALAPPDATA%/TiBrowser`，**不是** `%APPDATA%`。
 * 原因：本机 `%APPDATA%` 被 OneDrive 同步，Chromium 的 profile 与缓存目录放在同步盘上
 * 会出现文件占用冲突（实测 cef.log 反复刷 "Failed to open persistent cache files ...
 * 另一个程序正在使用此文件"），并伴随网络服务子进程崩溃。
 * 原生外壳因此改用 `%LOCALAPPDATA%`，边车必须与之一致，否则握手文件互相看不见
 * （表现为"边车已启动"但"握手超时，AI 能力不可用"）。
 *
 * 可通过 `--user-data` 参数或环境变量 `TIB_USER_DATA` 覆盖。
 * macOS = `~/Library/Application Support/TiBrowser`，Linux = `$XDG_CONFIG_HOME/TiBrowser`。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 产品名即用户数据目录名，与 native 侧保持一致 */
export const USER_DATA_DIR_NAME = 'TiBrowser'

let currentUserDataDir: string | null = null

/** 记忆化的默认用户数据目录 */
function defaultUserDataDir(): string {
  const env = process.env['TIB_USER_DATA']?.trim()
  if (env) return env

  if (process.platform === 'win32') {
    // 与 native/src/main.cpp 的 ResolveUserDataDir() 保持一致：LOCALAPPDATA 优先
    const localAppData = process.env['LOCALAPPDATA']?.trim()
    if (localAppData) return join(localAppData, USER_DATA_DIR_NAME)
    const appData = process.env['APPDATA']?.trim()
    if (appData) return join(appData, USER_DATA_DIR_NAME)
    return join(homedir(), 'AppData', 'Local', USER_DATA_DIR_NAME)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', USER_DATA_DIR_NAME)
  }
  const xdg = process.env['XDG_CONFIG_HOME']?.trim()
  return join(xdg || join(homedir(), '.config'), USER_DATA_DIR_NAME)
}

/**
 * 初始化用户数据目录（幂等）。
 * 目录不可写时回退到系统临时目录下的同名目录，保证边车仍能启动（能力降级并打日志）。
 */
export function initUserDataDir(dir?: string): { dir: string; writable: boolean } {
  const wanted = dir?.trim() || defaultUserDataDir()
  const candidates = [wanted, join(tmpdir(), USER_DATA_DIR_NAME + '-fallback')]
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true })
      // 真实写一次探针文件，避免「目录存在但不可写」的假成功
      const probe = join(candidate, '.tib-write-probe')
      writeFileSync(probe, String(Date.now()), 'utf-8')
      rmSync(probe, { force: true })
      currentUserDataDir = candidate
      return { dir: candidate, writable: candidate === wanted }
    } catch {
      /* 尝试下一个候选目录 */
    }
  }
  // 理论上不会到这里，兜底返回期望目录
  currentUserDataDir = wanted
  return { dir: wanted, writable: false }
}

/** 当前用户数据目录（未初始化时按默认推导） */
export function userDataDir(): string {
  return currentUserDataDir ?? defaultUserDataDir()
}

/** 用户数据目录下的文件路径 */
export function userDataFile(...segments: string[]): string {
  return join(userDataDir(), ...segments)
}

/** 确保用户数据目录存在 */
export function ensureUserDataDir(): void {
  mkdirSync(userDataDir(), { recursive: true })
}

/** 目录是否存在（便捷封装） */
export function dirExists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

/**
 * 运行时黑名单目录解析。
 * 顺序：显式参数 → 环境变量 `TIB_BLOCKLIST_DIR` → 从工作目录与模块目录**逐级向上**查找
 * `resources/blocklists`（这样无论从仓库根还是从 `service/` 启动都能找到）。
 */
export function resolveBlocklistDir(explicit?: string): string {
  const direct = explicit?.trim() || process.env['TIB_BLOCKLIST_DIR']?.trim() || ''
  if (direct) return existsSync(direct) ? direct : ''

  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))]
  for (const start of starts) {
    let dir = start
    for (let i = 0; i < 4; i++) {
      const candidate = join(dir, 'resources', 'blocklists')
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return ''
}
