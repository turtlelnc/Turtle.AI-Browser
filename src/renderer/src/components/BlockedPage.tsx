import type { TabState } from '@shared/types'
import { ShieldWarn } from './icons'

export function BlockedPage({ tab }: { tab: TabState }): JSX.Element {
  return (
    <div className="blocked">
      <div className="card">
        <div className="big-icon">
          <ShieldWarn size={36} />
        </div>
        <h1>TIbrowser 已拦截此网站</h1>
        <p>{tab.blocked?.reason || '该网站可能不安全，已为你阻止访问。'}</p>
        <div className="url">{tab.url}</div>
        <div className="actions">
          <button className="btn" onClick={() => window.tibrowser.goBack()}>
            返回上一页
          </button>
          <button className="btn danger" onClick={() => window.tibrowser.proceed()}>
            继续访问（不推荐）
          </button>
        </div>
      </div>
    </div>
  )
}
