import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** 读取 JSON 文件，失败或不存在时返回回退值 */
export function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/** 写入 JSON 文件（自动创建父目录） */
export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

/** 用户数据目录下的文件路径 */
export function userDataFile(...segments: string[]): string {
  return join(app.getPath('userData'), ...segments)
}
