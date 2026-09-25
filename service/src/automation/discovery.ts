/**
 * 自动化接口的发现文件（特性 15）。
 *
 * 用户自己的 AI 工具 / CLI / harness 无需知道边车随机分配的端口，
 * 只要读取 `<userData>/automation.json` 即可拿到地址与 token：
 * ```json
 * { "enabled": true, "baseUrl": "http://127.0.0.1:51234/automation", "wsUrl": "ws://127.0.0.1:51234/automation-ws",
 *   "token": "...", "version": "1.0.1-rc2", "build": 260918 }
 * ```
 * **默认关闭**（`automation.enabled=false`）：关闭时也会写文件，但 `enabled:false`
 * 且**不写入 token**，避免 token 在用户不知情时外泄给本机其它程序。
 */

import { APP_BUILD, APP_VERSION } from '../shared/constants.js'
import { userDataFile } from '../paths.js'
import { writeJsonAtomic } from '../store/json-store.js'

export const AUTOMATION_DISCOVERY_FILE = 'automation.json'

export interface AutomationInfo {
  enabled: boolean
  /** 形如 http://127.0.0.1:<port>/automation */
  baseUrl: string
  /** 形如 ws://127.0.0.1:<port>/automation-ws */
  wsUrl: string
  /** 仅 enabled=true 时写入 */
  token?: string
  version: string
  build: number
  /** 中文使用说明（给人类看的） */
  docs: string
  /** 写入时间 */
  updatedAt: number
}

export interface DiscoveryInput {
  enabled: boolean
  port: number
  token: string
  /** 文档相对路径，默认 docs/AUTOMATION.md */
  docsPath?: string
}

/** 生成发现信息（不落盘，便于自检断言） */
export function buildAutomationInfo(input: DiscoveryInput): AutomationInfo {
  const base = `http://127.0.0.1:${input.port}`
  const info: AutomationInfo = {
    enabled: input.enabled,
    baseUrl: `${base}/automation`,
    wsUrl: `ws://127.0.0.1:${input.port}/automation-ws`,
    version: APP_VERSION,
    build: APP_BUILD,
    docs: input.docsPath ?? 'docs/AUTOMATION.md',
    updatedAt: Date.now()
  }
  if (input.enabled) info.token = input.token
  return info
}

/** 写入 `<userData>/automation.json` */
export function writeAutomationInfo(input: DiscoveryInput): AutomationInfo {
  const info = buildAutomationInfo(input)
  writeJsonAtomic(userDataFile(AUTOMATION_DISCOVERY_FILE), info)
  return info
}

/** 删除发现文件（用户关闭自动化并希望彻底不暴露时使用） */
export function removeAutomationInfo(): string {
  const path = userDataFile(AUTOMATION_DISCOVERY_FILE)
  writeJsonAtomic(path, {
    enabled: false,
    version: APP_VERSION,
    build: APP_BUILD,
    docs: 'docs/AUTOMATION.md',
    removedAt: Date.now()
  } satisfies Partial<AutomationInfo> & { removedAt: number })
  return path
}
