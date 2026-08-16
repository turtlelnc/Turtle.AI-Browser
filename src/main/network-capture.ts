import type { Session } from 'electron'

export interface CapturedRequest {
  id: string
  timestamp: number
  method: string
  url: string
  resourceType: string
  statusCode: number
}

const captured: CapturedRequest[] = []
const MAX = 500
let enabled = false
let attached = false
let seq = 0

/** 挂载网络请求监听（只记录抓包开启期间的数据，未开启时零成本） */
export function attachCapture(session: Session): void {
  if (attached) return
  attached = true
  session.webRequest.onCompleted((details) => {
    if (!enabled) return
    captured.push({
      id: String(seq++),
      timestamp: Date.now(),
      method: details.method,
      url: details.url,
      resourceType: details.resourceType,
      statusCode: details.statusCode
    })
    if (captured.length > MAX) captured.shift()
  })
}

export function startCapture(): void {
  captured.length = 0
  enabled = true
}

export function stopCapture(): void {
  enabled = false
}

export function getCaptured(): CapturedRequest[] {
  return captured.slice()
}
