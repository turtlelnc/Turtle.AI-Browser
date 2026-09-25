/**
 * 设置 · 扩展程序
 *
 * v0.1.0 缺失的能力在这里补齐：每个扩展有**启用 / 禁用开关**、开发者模式、
 * 加载 .crx 与加载已解压目录。Chrome 应用商店在本版本不可用。
 *
 * 诚实说明（必须保留）：当前内核 CEF 150 已移除扩展运行 API，本页做的是
 * 扩展清单的导入 / 解包 / 校验 / 登记 / 开关，**不会真正运行扩展脚本**。
 * 原因不写死在界面里，而是从原生侧 `extensions.runtime` 取回来展示（见下方的 runtime）。
 */
import { useEffect, useState } from 'react'
import type { ExtensionInfo, ExtensionRuntimeInfo } from '@shared/bridge'
import { tib } from '../../bridge'
import { Badge, Callout, ErrorView, Field, Loading, Switch } from '../ui'
import { Folder, Info, Puzzle, Trash, Warning } from '../icons'

export function ExtensionsSection(): JSX.Element {
  const [list, setList] = useState<ExtensionInfo[] | null>(null)
  const [runtime, setRuntime] = useState<ExtensionRuntimeInfo | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [devMode, setDevMode] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  async function load(): Promise<void> {
    setError('')
    try {
      setList(await tib.getExtensions())
    } catch (err) {
      setError(`读取扩展列表失败：${String(err)}`)
    }
    try {
      setRuntime(await tib.getExtensionRuntime())
    } catch {
      // 取不到能力说明不影响本页其余功能，界面上仍有静态说明兜底
      setRuntime(null)
    }
  }

  useEffect(() => {
    void load()
    return tib.on('extensionsChanged', setList)
  }, [])

  async function toggle(ext: ExtensionInfo, on: boolean): Promise<void> {
    setBusy(ext.id)
    // 乐观更新：开关必须跟手，失败时再回滚
    setList((prev) => (prev ? prev.map((e) => (e.id === ext.id ? { ...e, enabled: on } : e)) : prev))
    try {
      await tib.setExtensionEnabled(ext.id, on)
      setNotice(`已${on ? '启用' : '禁用'}「${ext.name}」，${on ? '相关功能立即恢复' : '其内容脚本已从已打开的页面移除'}。`)
    } catch (err) {
      setList((prev) => (prev ? prev.map((e) => (e.id === ext.id ? { ...e, enabled: !on } : e)) : prev))
      setError(`切换扩展状态失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function remove(ext: ExtensionInfo): Promise<void> {
    setBusy(ext.id)
    try {
      await tib.removeExtension(ext.id)
      setList((prev) => (prev ? prev.filter((e) => e.id !== ext.id) : prev))
      setNotice(`已移除「${ext.name}」。`)
    } catch (err) {
      setError(`移除扩展失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  async function loadFrom(kind: 'crx' | 'unpacked'): Promise<void> {
    setBusy(kind)
    setError('')
    try {
      const ext = kind === 'crx' ? await tib.loadCrx() : await tib.loadUnpackedExtension()
      if (!ext) {
        setNotice('已取消选择。')
        return
      }
      setList((prev) => (prev ? [...prev.filter((e) => e.id !== ext.id), ext] : [ext]))
      setNotice(`已加载「${ext.name}」（v${ext.version}），默认处于启用状态。`)
    } catch (err) {
      setError(`加载扩展失败：${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  if (error && !list) return <ErrorView message={error} onRetry={() => void load()} />
  if (!list) return <Loading text="正在读取扩展程序…" />

  const enabledCount = list.filter((e) => e.enabled).length

  return (
    <section className="ov-section">
      <h2>扩展程序</h2>
      <p className="sec-desc">
        共 {list.length} 个扩展，其中 {enabledCount} 个已启用。启用 / 禁用与移除都是本地登记状态，
        会写进扩展清单并在下次启动时做一次一致性校验；但**内核不会真正运行扩展**（原因见下方说明）。
      </p>

      <Callout tone="warn">
        {runtime && !runtime.supported
          ? runtime.reason
          : '本浏览器使用的 CEF 150 已移除扩展运行 API（内核头文件里既没有 LoadExtension，' +
            '也没有 CefExtensionHandler）。因此这里提供的是扩展的导入、解包、清单校验、登记与开关，' +
            '扩展的内容脚本与后台脚本不会被执行。'}
        {runtime && !runtime.supported ? ' 我们不把「已启用」显示成「正在运行」。' : ''}
      </Callout>

      <Field label="开发者模式" desc="开启后才能从本地加载 .crx 或已解压的扩展目录">
        <Switch on={devMode} onToggle={() => setDevMode((v) => !v)} />
      </Field>

      {devMode ? (
        <div style={{ display: 'flex', gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
          <button className="btn" type="button" onClick={() => void loadFrom('crx')} disabled={busy !== null}>
            <Puzzle size={15} />
            {busy === 'crx' ? '正在解包…' : '加载 .crx 扩展'}
          </button>
          <button className="btn" type="button" onClick={() => void loadFrom('unpacked')} disabled={busy !== null}>
            <Folder size={15} />
            {busy === 'unpacked' ? '正在加载…' : '加载已解压目录'}
          </button>
        </div>
      ) : null}

      {notice ? <Callout tone="accent">{notice}</Callout> : null}
      {error ? <ErrorView message={error} /> : null}

      {list.length === 0 ? (
        <div className="empty">
          尚未安装任何扩展程序
          <div style={{ fontSize: 12, marginTop: 4 }}>本版本不提供 Chrome 应用商店，请开启开发者模式后从本地加载。</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {list.map((ext) => (
            <div key={ext.id} className={`ext-item ${ext.enabled ? '' : 'disabled'}`}>
              <span className="ext-icon">
                <Puzzle size={18} />
              </span>
              <div className="ext-main">
                <span className="ext-name">
                  {ext.name}
                  <Badge>v{ext.version}</Badge>
                  {ext.fromCrx ? <Badge>来自 .crx</Badge> : <Badge>已解压目录</Badge>}
                  {ext.enabled ? <Badge tone="ok">已启用</Badge> : <Badge>已禁用</Badge>}
                </span>
                <span className="ext-sub" title={ext.path}>
                  {ext.description ? `${ext.description} · ` : ''}
                  {ext.permissions && ext.permissions.length > 0 ? `权限：${ext.permissions.join('、')} · ` : ''}
                  {ext.path}
                </span>
              </div>
              <Switch
                on={ext.enabled}
                disabled={busy === ext.id}
                onToggle={() => void toggle(ext, !ext.enabled)}
                title={ext.enabled ? '点击禁用' : '点击启用'}
              />
              <span className="li-action always" title="移除扩展" onClick={() => void remove(ext)}>
                <Trash size={15} />
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Callout tone="warn" icon={<Warning size={16} />}>
          请只加载你信任来源的扩展：加载时会把 .crx 解包到数据目录并读取其清单（名称 / 版本 /
          权限声明），这些信息会展示在上面的列表里。移除来自 .crx 的扩展时，会一并清理它解压出来的目录。
        </Callout>
      </div>
      <div style={{ marginTop: 12 }}>
        <Callout icon={<Info size={16} />}>
          扩展清单会在下次启动时做一次一致性校验；因为内核不执行扩展脚本，
          装了扩展也不会改变页面行为 —— 这也是当前版本与 Chrome / Edge 在扩展能力上的主要差距。
        </Callout>
      </div>
    </section>
  )
}
