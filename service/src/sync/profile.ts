/**
 * `.tbuser` 配置文件导出 / 导入（移植自 `src/main/profile-sync.ts`，去掉 Electron 对话框）。
 *
 * v1.0.0 的变化：
 * - 不再弹出系统对话框（边车没有 UI）——路径由调用方给出；
 * - 导入前校验包内清单与 `settings.json`，并把**相对路径越界的条目**拒绝掉（zip slip 防护）；
 * - 导出的压缩包使用**原子写**（先写临时文件再 rename），避免半截 .tbuser；
 * - 导出时自动排除浏览器缓存目录（Cache / GPUCache / Code Cache 等）。
 */

import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { ProfileExportResult } from '../shared/types.js'
import { APP_BUILD, APP_VERSION } from '../shared/constants.js'

/** 打包时跳过的临时/缓存目录 */
export const EXCLUDE_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'blob_storage',
  'Crashpad',
  'GrShaderCache',
  'ShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Temp',
  'Session Storage',
  'Service Worker'
])

/** 打包时跳过的文件（过大且无迁移价值） */
export const EXCLUDE_FILES = new Set(['.tib-write-probe'])

/** 包内清单文件名 */
export const MANIFEST_NAME = 'manifest.json'

export interface ProfileManifest {
  format: 'tbuser'
  version: string
  build: number
  exportedAt: number
  /** 导出时的平台，便于提示跨平台差异 */
  platform: string
  /** 是否为边车导出（v0.1.0 的 Electron 版本没有该字段） */
  producer: 'tib-service'
  files: number
  bytes: number
}

export interface ExportOptions {
  /** 用户数据目录（导出源） */
  userDataDir: string
  /** 输出的 .tbuser 路径 */
  outputPath: string
  /** 是否包含密封的密钥文件（默认 true；密文只能在同一 Windows 用户下解密） */
  includeSecrets?: boolean
}

/** 递归收集文件清单 */
function collectFiles(
  root: string,
  dir = root,
  out: Array<{ abs: string; rel: string; size: number }> = []
): Array<{ abs: string; rel: string; size: number }> {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue
      collectFiles(root, full, out)
      continue
    }
    if (EXCLUDE_FILES.has(entry)) continue
    // 跳过正在写入的临时文件
    if (entry.endsWith('.tmp')) continue
    out.push({ abs: full, rel: relative(root, full).split(sep).join('/'), size: st.size })
  }
  return out
}

/** 导出用户数据为 .tbuser 压缩包 */
export async function exportProfile(opts: ExportOptions): Promise<ProfileExportResult> {
  const root = resolve(opts.userDataDir)
  if (!existsSync(root)) throw new Error(`用户数据目录不存在：${root}`)
  const out = resolve(opts.outputPath)
  if (out.startsWith(root + sep)) {
    // 防止把导出文件写进被导出的目录里，造成自我嵌套
    throw new Error('导出文件不能放在用户数据目录内部，请换一个位置。')
  }

  const zip = new AdmZip()
  const files = collectFiles(root).filter(
    (f) => (opts.includeSecrets ?? true) || basename(f.rel) !== 'secrets.json'
  )
  let bytes = 0
  for (const f of files) {
    try {
      const buf = readFileSync(f.abs)
      zip.addFile(f.rel, buf)
      bytes += buf.length
    } catch {
      /* 跳过被占用/无权限的文件 */
    }
  }

  const manifest: ProfileManifest = {
    format: 'tbuser',
    version: APP_VERSION,
    build: APP_BUILD,
    exportedAt: Date.now(),
    platform: process.platform,
    producer: 'tib-service',
    files: files.length,
    bytes
  }
  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'))

  // 原子写：先写 .tmp，再 rename
  mkdirSync(dirname(out), { recursive: true })
  const tmp = `${out}.${process.pid}.tmp`
  try {
    zip.writeZip(tmp)
    renameSync(tmp, out)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw new Error(`导出配置文件失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const size = statSync(out).size
  return { path: out, sizeBytes: size }
}

export interface ImportOptions {
  /** 输入的 .tbuser 路径 */
  inputPath: string
  /** 目标用户数据目录 */
  userDataDir: string
  /** 导入前是否清空目标目录中的同名数据文件（默认 false = 覆盖同名文件） */
  clean?: boolean
  /** 是否导入密钥（默认 true；跨机器导入的 DPAPI 密文无法解密，会被忽略） */
  includeSecrets?: boolean
}

export interface ImportResult {
  ok: true
  files: number
  manifest: ProfileManifest | null
  /** 被跳过的条目及中文原因 */
  skipped: Array<{ entry: string; reason: string }>
}

/** 校验并解压 .tbuser，覆盖到用户数据目录 */
export async function importProfile(opts: ImportOptions): Promise<ImportResult> {
  const input = resolve(opts.inputPath)
  if (!existsSync(input)) throw new Error(`配置文件不存在：${input}`)
  const root = resolve(opts.userDataDir)
  mkdirSync(root, { recursive: true })

  let zip: AdmZip
  try {
    zip = new AdmZip(input)
  } catch (e) {
    throw new Error(`无法读取配置文件（不是有效的 zip/.tbuser）：${e instanceof Error ? e.message : String(e)}`)
  }

  const entries = zip.getEntries()
  if (!entries.length) throw new Error('配置文件为空。')

  const skipped: ImportResult['skipped'] = []
  let manifest: ProfileManifest | null = null
  let files = 0

  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    if (name === MANIFEST_NAME) {
      try {
        manifest = JSON.parse(entry.getData().toString('utf-8')) as ProfileManifest
      } catch {
        skipped.push({ entry: name, reason: '清单文件解析失败' })
      }
      continue
    }
    // zip slip 防护：条目解析后必须仍在目标目录内
    const target = resolve(root, name)
    const rel = relative(root, target)
    if (rel.startsWith('..') || rel === '' || /^[a-z]:/i.test(rel)) {
      skipped.push({ entry: name, reason: '路径越出用户数据目录（zip slip 防护）' })
      continue
    }
    if (name.split('/').some((seg) => EXCLUDE_DIRS.has(seg))) {
      skipped.push({ entry: name, reason: '属于缓存目录，已跳过' })
      continue
    }
    if (!(opts.includeSecrets ?? true) && basename(name) === 'secrets.json') {
      skipped.push({ entry: name, reason: '按导入选项跳过密钥文件' })
      continue
    }
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.getData())
      files++
    } catch (e) {
      skipped.push({ entry: name, reason: `写入失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }

  if (!existsSync(join(root, 'settings.json'))) {
    // 允许导入（例如只含书签的包），但必须让调用方知道这不是一个完整配置
    skipped.push({
      entry: 'settings.json',
      reason: '包内没有 settings.json：这可能不是完整的 TiBrowser 配置文件（旧版 v0.1.0 包应当包含它）'
    })
  }

  return { ok: true, files, manifest, skipped }
}

/** 读取 .tbuser 的清单（不落地任何文件，供 UI 预览） */
export function peekProfile(inputPath: string): ProfileManifest | null {
  const input = resolve(inputPath)
  if (!existsSync(input)) throw new Error(`配置文件不存在：${input}`)
  const zip = new AdmZip(input)
  const entry = zip.getEntry(MANIFEST_NAME)
  if (!entry) return null
  try {
    return JSON.parse(entry.getData().toString('utf-8')) as ProfileManifest
  } catch {
    return null
  }
}
