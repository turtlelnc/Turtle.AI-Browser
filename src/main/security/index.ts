import { app } from 'electron'
import { join } from 'node:path'
import { loadRuntimeBlocklists } from './blocklist'
import { scanUrl } from './url-scanner'
import { attachWebGuard } from './web-guard'

export { scanUrl } from './url-scanner'
export { attachWebGuard } from './web-guard'
export { categoryForHost } from './blocklist'

/** 初始化本地安全服务：加载运行时黑名单 */
export function initSecurity(): void {
  // 打包后 resources 目录路径；开发环境下回退到项目根目录
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'blocklists')
    : join(app.getAppPath(), 'resources', 'blocklists')
  loadRuntimeBlocklists(dir)
}
