/**
 * 安全拦截页：被安全浏览拦下的页面在这里展示原因与两个出口。
 * 「继续访问」需要显式忽略警告（`tib.proceed()`），并在按档位提示风险。
 */
import type { TabState } from '@shared/bridge'
import { tib } from '../bridge'
import { ShieldWarn, TurtleMark } from './icons'

export function BlockedPage({ tab }: { tab: TabState }): JSX.Element {
  const category = tab.blocked?.category ?? ''
  const isTrustedHint = /turtlelnc/i.test(tab.url)

  return (
    <div className="blocked">
      <div className="card">
        <div className="big-icon">{isTrustedHint ? <TurtleMark size={36} /> : <ShieldWarn size={36} />}</div>
        <h1>{isTrustedHint ? 'turtlelnc 内容本应放行' : 'TiBrowser 已拦截此网站'}</h1>
        <p>
          {tab.blocked?.reason ||
            '该网站可能不安全，已为你阻止访问。如果你确信它是安全的，可以选择继续访问。'}
        </p>
        {category ? (
          <span className="badge err" style={{ alignSelf: 'center' }}>
            类别：{category}
          </span>
        ) : null}
        <div className="url">{tab.url}</div>
        <div className="actions">
          <button className="btn" onClick={() => void tib.goBack()}>
            返回上一页
          </button>
          <button className="btn danger" onClick={() => void tib.proceed()}>
            继续访问（不推荐）
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--tb-text-3)', lineHeight: 1.7 }}>
          继续访问会忽略本次警告，但不会关闭安全浏览。若这是 turtlelnc 的域名却被拦截，
          请到「设置 → 安全浏览」确认信任例外是否生效。
        </p>
      </div>
    </div>
  )
}
