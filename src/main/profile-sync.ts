import { app, dialog, type BrowserWindow } from 'electron'
import AdmZip from 'adm-zip'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { ProfileExportResult } from '@shared/types'

/** 打包时跳过的临时/缓存目录 */
const EXCLUDE_DIRS = new Set([
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
  'Temp'
])

/** 递归添加目录到 zip（跳过被占用文件与缓存目录） */
function addDir(zip: AdmZip, dir: string, prefix: string): void {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const rel = prefix ? `${prefix}/${entry}` : entry
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue
      addDir(zip, full, rel)
    } else {
      try {
        zip.addFile(rel, readFileSync(full))
      } catch {
        /* 跳过被占用的文件 */
      }
    }
  }
}

/** 导出用户数据为 .tbuser 文件 */
export async function exportProfile(win: BrowserWindow): Promise<ProfileExportResult> {
  const stamp = new Date().toISOString().slice(0, 10)
  const r = await dialog.showSaveDialog(win, {
    title: '导出配置文件',
    defaultPath: `TIbrowser-${stamp}.tbuser`,
    filters: [{ name: 'TIbrowser 配置文件', extensions: ['tbuser'] }]
  })
  if (r.canceled || !r.filePath) throw new Error('已取消')

  const zip = new AdmZip()
  addDir(zip, app.getPath('userData'), '')
  zip.writeZip(r.filePath)
  return { path: r.filePath, sizeBytes: statSync(r.filePath).size }
}

/** 递归复制目录（跳过被占用文件与缓存目录） */
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  let entries: string[] = []
  try {
    entries = readdirSync(src)
  } catch {
    return
  }
  for (const entry of entries) {
    const s = join(src, entry)
    const d = join(dest, entry)
    let st
    try {
      st = statSync(s)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue
      copyDir(s, d)
    } else {
      try {
        writeFileSync(d, readFileSync(s))
      } catch {
        /* 跳过被占用文件 */
      }
    }
  }
}

/** 导入 .tbuser 文件，覆盖到用户数据目录 */
export async function importProfile(win: BrowserWindow): Promise<boolean> {
  const r = await dialog.showOpenDialog(win, {
    title: '导入配置文件',
    properties: ['openFile'],
    filters: [{ name: 'TIbrowser 配置文件', extensions: ['tbuser'] }]
  })
  if (r.canceled || !r.filePaths[0]) throw new Error('已取消')

  const tmpDir = join(app.getPath('temp'), `tibrowser-import-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  try {
    const zip = new AdmZip(r.filePaths[0])
    zip.extractAllTo(tmpDir, true)
    if (!existsSync(join(tmpDir, 'settings.json'))) {
      throw new Error('不是有效的 TIbrowser 配置文件（缺少 settings.json）')
    }
    copyDir(tmpDir, app.getPath('userData'))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  return true
}
