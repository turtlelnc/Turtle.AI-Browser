/**
 * 本地自动化模块汇总导出。
 */

export {
  ACTION_MAP,
  AUTOMATION_ACTIONS,
  actionsByGroup,
  type ActionDef,
  type ActionGroup
} from './actions.js'

export {
  handleAutomationRequest,
  nativeBridge,
  runAction,
  type AutomationDeps,
  type AutomationResponse,
  type NativeBridgeConfig
} from './http-api.js'

export { AutomationWsApi, BROADCAST_EVENTS, isLoopback } from './ws-api.js'

export {
  AUTOMATION_DISCOVERY_FILE,
  buildAutomationInfo,
  removeAutomationInfo,
  writeAutomationInfo,
  type AutomationInfo,
  type DiscoveryInput
} from './discovery.js'

export { renderAutomationDoc, writeAutomationDoc, type DocGenOptions } from './docs.js'
