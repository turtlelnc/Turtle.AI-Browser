/**
 * 设置 · 账户与同步（feature 3）
 *
 * Microsoft / Google 登录、同步项开关、上次同步时间，以及 `.tbuser` 本机迁移包。
 * 注意：API Key 与本机加密数据不会进入迁移包，导入后需要重新填写（界面上明确告知）。
 */
import { useEffect, useState } from 'react'
import type { AccountInfo, AccountProvider, ProfileTransferResult, SyncState, SyncToggles } from '@shared/bridge'
import { tib } from '../../bridge'
import { formatBytes, formatTime } from '../../format'
import { Badge, Callout, ErrorView, Field, Loading, Switch } from '../ui'
import { Cloud, Doc, Download, Globe, Info, Key, Puzzle, Star, Upload, User } from '../icons'

/** 同步项（键名与 SyncToggles 一致） */
const SYNC_ITEMS: { key: keyof SyncToggles; label: string; desc: string; icon: typeof Star }[] = [
  { key: 'bookmarks', label: '书签', desc: '书签与文件夹结构', icon: Star },
  { key: 'history', label: '历史记录', desc: '访问记录（不含无痕会话）', icon: Globe },
  { key: 'settings', label: '设置', desc: '外观、安全档位、能效模式等', icon: Doc },
  { key: 'extensions', label: '扩展程序', desc: '仅同步扩展清单，需在本机重新加载文件', icon: Puzzle },
  { key: 'passwords', label: '密码', desc: '站点密码（端到端加密，本机需要重新解锁）', icon: Key }
]

function providerName(p: AccountProvider): string {
  return p === 'microsoft' ? 'Microsoft' : 'Google'
}

export function AccountsSection(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null)
  const [sync, setSync] = useState<SyncState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<AccountProvider | 'sync' | 'export' | 'import' | null>(null)
  const [transfer, setTransfer] = useState<ProfileTransferResult | null>(null)

  async function load(): Promise<void> {
    setError('')
    try {
      const [a, s] = await Promise.all([tib.getAccounts(), tib.getSyncState()])
      setAccounts(a)
      setSync(s)
    } catch (err) {
      setError(`读取账户状态失败：${String(err)}`)
    }
  }

  useEffect(() => {
    void load()
    return tib.on('accountsChanged', ({ accounts: a, syncState: s }) => {
      setAccounts(a)
      setSync(s)
    })
  }, [])

  async function signIn(provider: AccountProvider): Promise<void> {
    setBusy(provider)
    setNotice('')
    try {
      await tib.signIn(provider)
      const [a, s] = await Promise.all([tib.getAccounts(), tib.getSyncState()])
      setAccounts(a)
      setSync(s)
      setNotice(`已登录 ${providerName(provider)}，同步总开关已自动打开。`)
    } catch (err) {
      setError(`登录失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function signOut(provider: AccountProvider): Promise<void> {
    setBusy(provider)
    try {
      await tib.signOut(provider)
      setAccounts(await tib.getAccounts())
      setNotice(`已退出 ${providerName(provider)}，本机数据保留但不再上传。`)
    } catch (err) {
      setError(`退出失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function toggleSync(key: keyof SyncToggles, value: boolean): Promise<void> {
    if (!sync) return
    const optimistic = { ...sync, toggles: { ...sync.toggles, [key]: value } }
    setSync(optimistic)
    try {
      setSync(await tib.setSyncToggles({ [key]: value } as Partial<SyncToggles>))
    } catch (err) {
      setError(`保存同步项失败：${String(err)}`)
    }
  }

  async function syncNow(): Promise<void> {
    setBusy('sync')
    setNotice('')
    try {
      const next = await tib.syncNow()
      setSync(next)
      setNotice(next.lastResult ?? '同步完成。')
    } catch (err) {
      setError(`同步失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function doExport(): Promise<void> {
    setBusy('export')
    setNotice('')
    try {
      setTransfer(await tib.profileExport())
    } catch (err) {
      setError(`导出失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function doImport(): Promise<void> {
    setBusy('import')
    setNotice('')
    try {
      const result = await tib.profileImport()
      if (!result) {
        setNotice('已取消导入。')
        return
      }
      setTransfer(result)
      setNotice('导入完成：书签、历史与设置已合并到本机。')
    } catch (err) {
      setError(`导入失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  if (error && !accounts) return <ErrorView message={error} onRetry={() => void load()} />
  if (!accounts || !sync) return <Loading text="正在读取账户与同步状态…" />

  const signed = accounts.find((a) => a.signedIn)

  return (
    <section className="ov-section">
      <h2>账户与同步</h2>
      <p className="sec-desc">
        登录后可以把书签、历史、设置等在本机上云端备份，并在多台设备之间保持一致。
        所有同步内容在离开本机前都会加密。
      </p>

      <div className="card-options cols-2" style={{ marginBottom: 16 }}>
        {accounts.map((a) => (
          <div key={a.provider} className="account-card">
            <span className="acc-icon">
              {a.avatar ? <img className="acc-avatar" src={a.avatar} alt="" /> : <User size={20} />}
            </span>
            <div className="acc-main">
              <span className="acc-name">
                {a.displayName}
                {a.signedIn ? <Badge tone="ok">已登录</Badge> : null}
              </span>
              <span className="acc-sub">
                {a.signedIn
                  ? `${a.email ?? '已授权'} · 上次登录 ${formatTime(a.lastSignInAt)}`
                  : '未登录：点击右侧按钮在本机浏览器中完成授权'}
              </span>
            </div>
            {a.signedIn ? (
              <button className="btn small" type="button" disabled={busy === a.provider} onClick={() => void signOut(a.provider)}>
                {busy === a.provider ? '处理中…' : '退出登录'}
              </button>
            ) : (
              <button className="btn small primary" type="button" disabled={busy === a.provider} onClick={() => void signIn(a.provider)}>
                {busy === a.provider ? '等待授权…' : '登录'}
              </button>
            )}
          </div>
        ))}
      </div>

      {notice ? <Callout tone="accent">{notice}</Callout> : null}
      {error ? <ErrorView message={error} /> : null}

      <h2 style={{ marginTop: 24 }}>同步内容</h2>
      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <div className="stat">
          <div className="stat-value" style={{ fontSize: 16 }}>
            {sync.syncing ? '同步中…' : sync.enabled ? '已开启' : '未开启'}
          </div>
          <div className="stat-label">同步状态</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ fontSize: 16 }}>
            {formatTime(sync.lastSyncAt)}
          </div>
          <div className="stat-label">上次同步</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{ fontSize: 16 }}>
            {signed ? providerName(signed.provider) : '未登录'}
          </div>
          <div className="stat-label">当前账户</div>
        </div>
      </div>
      {sync.lastResult ? (
        <p className="sec-desc" style={{ marginBottom: 12 }}>
          上次结果：{sync.lastResult}
        </p>
      ) : null}

      {SYNC_ITEMS.map((item) => (
        <Field key={item.key} label={item.label} desc={item.desc}>
          <Switch
            on={sync.toggles[item.key]}
            disabled={!sync.enabled}
            onToggle={() => void toggleSync(item.key, !sync.toggles[item.key])}
            title={sync.enabled ? undefined : '请先登录并开启同步'}
          />
        </Field>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <button className="btn primary" type="button" onClick={() => void syncNow()} disabled={busy === 'sync' || !sync.enabled}>
          <Cloud size={15} />
          {busy === 'sync' ? '正在同步…' : '立即同步'}
        </button>
        <Switch
          on={sync.enabled}
          onToggle={async () => {
            // 总开关与「已登录」强相关：未登录时先引导登录（原生侧同样会拒绝开启）
            if (!sync.enabled && !signed) {
              setNotice('请先登录 Microsoft 或 Google 账户，再打开同步总开关。')
              return
            }
            try {
              setSync(await tib.setSyncEnabled(!sync.enabled))
            } catch (err) {
              setError(`保存同步总开关失败：${String(err)}`)
            }
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--tb-text-3)' }}>同步总开关</span>
      </div>

      <h2 style={{ marginTop: 32 }}>本机迁移（.tbuser）</h2>
      <p className="sec-desc">
        导出一个 `.tbuser` 文件，把设置、书签、历史、扩展清单与网页应用迁移到另一台电脑。
        不包含浏览器缓存；API Key 采用本机加密（DPAPI），跨电脑导入后需重新填写。
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={() => void doExport()} disabled={busy === 'export'}>
          <Download size={15} />
          {busy === 'export' ? '正在导出…' : '导出 .tbuser'}
        </button>
        <button className="btn" type="button" onClick={() => void doImport()} disabled={busy === 'import'}>
          <Upload size={15} />
          {busy === 'import' ? '正在导入…' : '导入 .tbuser'}
        </button>
      </div>
      {transfer ? (
        <div className="code-block" style={{ marginTop: 12 }}>
          <pre>{`文件：${transfer.path}
大小：${formatBytes(transfer.sizeBytes)}
包含：${transfer.includes.join('、')}`}</pre>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Callout icon={<Info size={16} />}>
          迁移包是**明文可读**的压缩包，请勿通过公开链接分发；其中的密码条目仍受本机密钥保护，换机后需要重新解锁。
        </Callout>
      </div>
    </section>
  )
}
