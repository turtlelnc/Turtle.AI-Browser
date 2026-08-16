import { dialog, session as electronSession, type BrowserWindow } from 'electron'
import AdmZip from 'adm-zip'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BROWSER_PARTITION } from '@shared/constants'
import type { ExtensionInfo } from '@shared/types'
import { readJson, writeJson, userDataFile } from './store/fs-util'

let extensions: ExtensionInfo[] = []

const extensionsFile = (): string => userDataFile('extensions.json')

function persist(): void {
  writeJson(extensionsFile(), extensions)
}

/** 从 manifest.json 读取扩展名与版本 */
function readManifest(dir: string): { name: string; version: string } {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
    return { name: m.name || basename(dir), version: m.version || '' }
  } catch {
    return { name: basename(dir), version: '' }
  }
}

/** 应用启动时加载所有已持久化的扩展 */
export function loadPersistedExtensions(): void {
  extensions = readJson<ExtensionInfo[]>(extensionsFile(), []).filter((e) => existsSync(e.path))
  const ses = electronSession.fromPartition(BROWSER_PARTITION)
  for (const info of extensions) {
    void ses.loadExtension(info.path).catch(() => {})
  }
}

export function listExtensions(): ExtensionInfo[] {
  return extensions
}

/** 加载已解压的扩展目录 */
export async function loadUnpackedExtension(win: BrowserWindow): Promise<ExtensionInfo> {
  const r = await dialog.showOpenDialog(win, {
    title: '选择已解压的扩展程序目录（含 manifest.json）',
    properties: ['openDirectory']
  })
  if (r.canceled || !r.filePaths[0]) throw new Error('已取消')
  return loadDir(r.filePaths[0], false)
}

/** 加载 .crx 扩展：解包到用户数据目录后加载 */
export async function loadCrxExtension(win: BrowserWindow): Promise<ExtensionInfo> {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 .crx 扩展程序',
    properties: ['openFile'],
    filters: [{ name: 'Chrome 扩展', extensions: ['crx'] }]
  })
  if (r.canceled || !r.filePaths[0]) throw new Error('已取消')

  const unpackedDir = userDataFile('extensions', randomUUID())
  mkdirSync(unpackedDir, { recursive: true })
  try {
    unpackCrx(r.filePaths[0], unpackedDir)
  } catch (e) {
    rmSync(unpackedDir, { recursive: true, force: true })
    throw e
  }
  return loadDir(unpackedDir, true)
}

async function loadDir(dir: string, fromCrx: boolean): Promise<ExtensionInfo> {
  const ext = await electronSession.fromPartition(BROWSER_PARTITION).loadExtension(dir)
  const { name, version } = readManifest(dir)
  const info: ExtensionInfo = { id: ext.id, name, version, path: dir, fromCrx }
  extensions = extensions.filter((e) => e.id !== info.id)
  extensions.push(info)
  persist()
  return info
}

export async function removeExtension(id: string): Promise<void> {
  const info = extensions.find((e) => e.id === id)
  if (!info) return
  try {
    electronSession.fromPartition(BROWSER_PARTITION).removeExtension(id)
  } catch {
    /* 忽略 */
  }
  extensions = extensions.filter((e) => e.id !== id)
  if (info.fromCrx) rmSync(info.path, { recursive: true, force: true })
  persist()
}

/** 解析 .crx（兼容 CRX2 与 CRX3）并解包为目录 */
function unpackCrx(crxPath: string, outDir: string): void {
  const buf = readFileSync(crxPath)
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'Cr24') {
    throw new Error('不是有效的 .crx 文件')
  }
  const version = buf.readUInt32LE(4)
  let zipOffset = 0
  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8)
    const sigLen = buf.readUInt32LE(12)
    zipOffset = 16 + pubKeyLen + sigLen
  } else if (version === 3) {
    zipOffset = buf.readUInt32LE(8)
  } else {
    throw new Error(`不支持的 .crx 版本：${version}`)
  }
  if (zipOffset <= 0 || zipOffset >= buf.length) throw new Error('.crx 文件已损坏')
  const zip = new AdmZip(buf.subarray(zipOffset))
  zip.extractAllTo(outDir, true)
}
