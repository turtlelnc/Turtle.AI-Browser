/**
 * 「下载不安全安装包」警告对话框（feature 6）
 *
 * 由原生侧通过 `downloadWarning` 事件发起：网页试图下载可执行文件 / 安装包，
 * 且安全浏览判定为可疑。用户必须明确选择「保留」或「丢弃」，
 * 结果通过 `tib.resolveDownloadPrompt(id, keep)` 回传原生侧。
 *
 * 注意：即使用户选择保留，也只是解除本次拦截，不会关闭安全浏览的其它防护。
 */
import { useState } from 'react'
import type { DownloadPrompt } from '@shared/bridge'
import { tib } from '../bridge'
import { formatBytes } from '../format'
import { Info, Warning } from './icons'

export function DownloadWarningDialog({
  prompt,
  onResolved
}: {
  prompt: DownloadPrompt
  onResolved: () => void
}): JSX.Element {
  const [busy, setBusy] = useState<'keep' | 'discard' | null>(null)
  const [error, setError] = useState('')

  async function decide(keep: boolean): Promise<void> {
    setBusy(keep ? 'keep' : 'discard')
    setError('')
    try {
      await tib.resolveDownloadPrompt(prompt.id, keep)
      onResolved()
    } catch (err) {
      setError(`操作失败：${String(err)}`)
      setBusy(null)
    }
  }

  const tone = prompt.risk === 'high' ? 'danger' : 'warn'

  return (
    <div className="dialog-layer" role="dialog" aria-modal="true" aria-label="下载安全警告">
      <div className="dialog">
        <div className="dlg-head">
          <span className={`dlg-icon ${tone}`}>
            <Warning size={22} />
          </span>
          <div>
            <h2>这个文件可能不安全</h2>
            <div className="dlg-body" style={{ marginTop: 2 }}>
              TiBrowser 已暂时阻止这次下载，请确认来源可信后再决定是否保留。
            </div>
          </div>
        </div>

        <div className="dlg-meta">
          <div className="row">
            <span className="k">文件名</span>
            <span className="v">{prompt.filename}</span>
          </div>
          <div className="row">
            <span className="k">来源</span>
            <span className="v">{prompt.url}</span>
          </div>
          {prompt.totalBytes ? (
            <div className="row">
              <span className="k">大小</span>
              <span className="v">{formatBytes(prompt.totalBytes)}</span>
            </div>
          ) : null}
          <div className="row">
            <span className="k">原因</span>
            <span className="v">{prompt.reason}</span>
          </div>
        </div>

        <div className="dlg-body">
          <Info size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
          如果你并不认识这个网站、也没有主动点击下载，建议选择「丢弃」。
          保留后请只用系统自带的杀毒软件扫描一次再安装；安装包里的「附赠软件」通常无法通过浏览器拦截。
        </div>

        {error ? <div className="dlg-body" style={{ color: 'var(--tb-danger)' }}>{error}</div> : null}

        <div className="dlg-actions">
          <button className="btn ghost" type="button" disabled={busy !== null} onClick={() => void decide(false)}>
            {busy === 'discard' ? '正在丢弃…' : '丢弃'}
          </button>
          <button className="btn danger" type="button" disabled={busy !== null} onClick={() => void decide(true)}>
            {busy === 'keep' ? '正在保留…' : '保留'}
          </button>
        </div>
      </div>
    </div>
  )
}
