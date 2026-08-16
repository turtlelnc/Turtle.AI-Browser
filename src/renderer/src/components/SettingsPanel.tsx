import { useEffect, useState } from 'react'
import { CLI_PERMISSION_LEVELS, DEFAULT_SETTINGS, SEARCH_ENGINES } from '@shared/constants'
import type { CliPermissionLevel, ExtensionInfo, SearchEngineId, Settings, ThemeMode } from '@shared/types'
import { Close } from './icons'

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }): JSX.Element {
  return <span className={`switch ${on ? 'on' : ''}`} onClick={onToggle} />
}

function ExtensionsSection(): JSX.Element {
  const [list, setList] = useState<ExtensionInfo[]>([])
  const [devMode, setDevMode] = useState(false)

  useEffect(() => {
    window.tibrowser.extensions.list().then(setList)
    return window.tibrowser.extensions.onChange(setList)
  }, [])

  return (
    <div className="ov-section">
      <h2>扩展程序</h2>
      <div className="field">
        <div className="f-label">
          开发者模式
          <span className="f-desc">开启后可从本地加载 .crx 或已解压的扩展程序</span>
        </div>
        <Switch on={devMode} onToggle={() => setDevMode((v) => !v)} />
      </div>
      {devMode && (
        <div className="field">
          <div className="f-label">
            加载扩展
            <span className="f-desc">Chrome 应用商店不可用，请手动加载本地扩展</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => window.tibrowser.extensions.loadCrx()}>
              加载 .crx 扩展
            </button>
            <button className="btn" onClick={() => window.tibrowser.extensions.loadUnpacked()}>
              加载已解压的扩展
            </button>
          </div>
        </div>
      )}
      {list.length === 0 && <div className="empty">未安装任何扩展程序</div>}
      <div className="list">
        {list.map((ext) => (
          <div key={ext.id} className="list-item">
            <span style={{ fontSize: 18 }}>🧩</span>
            <div className="li-main">
              <div className="li-title">{ext.name}</div>
              <div className="li-sub">{ext.version ? `版本 ${ext.version}` : ext.id}</div>
            </div>
            <span
              className="li-action"
              title="移除"
              onClick={() => window.tibrowser.extensions.remove(ext.id)}
            >
              <Close size={14} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProfileSyncSection(): JSX.Element {
  return (
    <div className="ov-section">
      <h2>配置文件同步</h2>
      <div className="field">
        <div className="f-label">
          导出 / 导入
          <span className="f-desc">把设置、书签、历史、扩展等打包为 .tbuser 文件，迁移到其它电脑</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => window.tibrowser.profile.export()}>
            导出配置文件
          </button>
          <button className="btn" onClick={() => window.tibrowser.profile.import()}>
            导入配置文件
          </button>
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-faint)', lineHeight: 1.6 }}>
        说明：导出内容包含设置、书签、历史、扩展程序等用户数据（不含浏览器缓存）。因 API Key
        采用本机加密，跨电脑导入后需重新填写。
      </p>
    </div>
  )
}

export function SettingsPanel(): JSX.Element {
  const [form, setForm] = useState<Settings>(structuredClone(DEFAULT_SETTINGS))
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.tibrowser.settings.get().then((s) => {
      setForm(s)
      setHasKey(s.ai.apiKey.length > 0)
    })
  }, [])

  function patch(fn: (f: Settings) => Settings): void {
    setForm((f) => fn(structuredClone(f)))
  }

  async function save(): Promise<void> {
    await window.tibrowser.settings.set(form)
    if (apiKeyInput.trim()) {
      await window.tibrowser.settings.setApiKey(apiKeyInput.trim())
      setHasKey(true)
    }
    setApiKeyInput('')
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  async function clearKey(): Promise<void> {
    await window.tibrowser.settings.setApiKey('')
    setHasKey(false)
    setApiKeyInput('')
  }

  return (
    <div>
      <div className="ov-section">
        <h2>搜索引擎与主页</h2>
        <div className="field">
          <div className="f-label">
            默认搜索引擎
            <span className="f-desc">地址栏输入非网址内容时的搜索方式</span>
          </div>
          <select
            value={form.searchEngine}
            onChange={(e) => patch((f) => ({ ...f, searchEngine: e.target.value as SearchEngineId }))}
          >
            {Object.entries(SEARCH_ENGINES).map(([id, s]) => (
              <option key={id} value={id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <div className="f-label">
            主页
            <span className="f-desc">点击主页按钮时打开的网址</span>
          </div>
          <input
            type="text"
            value={form.homepage}
            onChange={(e) => patch((f) => ({ ...f, homepage: e.target.value }))}
          />
        </div>
      </div>

      <div className="ov-section">
        <h2>AI 助手</h2>
        <div className="field">
          <div className="f-label">
            启用 AI 助手
            <span className="f-desc">关闭后侧边栏 AI 不再响应</span>
          </div>
          <Switch
            on={form.ai.enabled}
            onToggle={() => patch((f) => ({ ...f, ai: { ...f.ai, enabled: !f.ai.enabled } }))}
          />
        </div>
        <div className="field">
          <div className="f-label">服务商名称</div>
          <input
            type="text"
            value={form.ai.providerName}
            onChange={(e) => patch((f) => ({ ...f, ai: { ...f.ai, providerName: e.target.value } }))}
          />
        </div>
        <div className="field">
          <div className="f-label">
            API 地址
            <span className="f-desc">OpenAI 兼容协议根地址，如 https://api.deepseek.com/v1</span>
          </div>
          <input
            type="text"
            value={form.ai.baseUrl}
            onChange={(e) => patch((f) => ({ ...f, ai: { ...f.ai, baseUrl: e.target.value } }))}
          />
        </div>
        <div className="field">
          <div className="f-label">
            API Key
            <span className="f-desc">
              {hasKey ? '已设置（加密存储于本机）' : '由你自己在服务商后台获取'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="password"
              value={apiKeyInput}
              placeholder={hasKey ? '输入以覆盖' : 'sk-...'}
              style={{ width: 220 }}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            {hasKey && (
              <button className="btn ghost" onClick={clearKey}>
                清除
              </button>
            )}
          </div>
        </div>
        <div className="field">
          <div className="f-label">
            模型
            <span className="f-desc">如 deepseek-chat / gpt-4o-mini</span>
          </div>
          <input
            type="text"
            value={form.ai.model}
            onChange={(e) => patch((f) => ({ ...f, ai: { ...f.ai, model: e.target.value } }))}
          />
        </div>
        <div className="field">
          <div className="f-label">
            智能体控制权限
            <span className="f-desc">AI 控制浏览器时的权限档位（也可在侧边栏调节）</span>
          </div>
          <select
            value={form.ai.cliPermission}
            onChange={(e) =>
              patch((f) => ({
                ...f,
                ai: { ...f.ai, cliPermission: e.target.value as CliPermissionLevel }
              }))
            }
          >
            {CLI_PERMISSION_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="ov-section">
        <h2>本地安全服务</h2>
        <div className="field">
          <div className="f-label">
            钓鱼 / 恶意网址拦截
            <span className="f-desc">访问已知恶意域名时阻止加载</span>
          </div>
          <Switch
            on={form.security.safeBrowsing}
            onToggle={() =>
              patch((f) => ({ ...f, security: { ...f.security, safeBrowsing: !f.security.safeBrowsing } }))
            }
          />
        </div>
        <div className="field">
          <div className="f-label">
            HTTPS 自动升级
            <span className="f-desc">优先使用加密连接访问网站</span>
          </div>
          <Switch
            on={form.security.httpsUpgrade}
            onToggle={() =>
              patch((f) => ({ ...f, security: { ...f.security, httpsUpgrade: !f.security.httpsUpgrade } }))
            }
          />
        </div>
        <div className="field">
          <div className="f-label">
            广告拦截
            <span className="f-desc">拦截常见广告域名</span>
          </div>
          <Switch
            on={form.security.adBlock}
            onToggle={() =>
              patch((f) => ({ ...f, security: { ...f.security, adBlock: !f.security.adBlock } }))
            }
          />
        </div>
        <div className="field">
          <div className="f-label">
            追踪器拦截
            <span className="f-desc">拦截统计与分析类追踪脚本</span>
          </div>
          <Switch
            on={form.security.trackerBlock}
            onToggle={() =>
              patch((f) => ({ ...f, security: { ...f.security, trackerBlock: !f.security.trackerBlock } }))
            }
          />
        </div>
        <div className="field">
          <div className="f-label">
            拦截可疑下载
            <span className="f-desc">阻止 .exe/.msi 等可执行文件的意外下载</span>
          </div>
          <Switch
            on={form.security.blockSuspiciousDownloads}
            onToggle={() =>
              patch((f) => ({
                ...f,
                security: { ...f.security, blockSuspiciousDownloads: !f.security.blockSuspiciousDownloads }
              }))
            }
          />
        </div>
      </div>

      <div className="ov-section">
        <h2>外观</h2>
        <div className="field">
          <div className="f-label">
            毛玻璃效果
            <span className="f-desc">低性能设备建议关闭以提升流畅度</span>
          </div>
          <Switch
            on={form.appearance.frostedGlass}
            onToggle={() =>
              patch((f) => ({
                ...f,
                appearance: { ...f.appearance, frostedGlass: !f.appearance.frostedGlass }
              }))
            }
          />
        </div>
        <div className="field">
          <div className="f-label">主题</div>
          <select
            value={form.appearance.theme}
            onChange={(e) =>
              patch((f) => ({ ...f, appearance: { ...f.appearance, theme: e.target.value as ThemeMode } }))
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
        <div className="field">
          <div className="f-label">显示书签栏</div>
          <Switch
            on={form.appearance.bookmarkBarVisible}
            onToggle={() =>
              patch((f) => ({
                ...f,
                appearance: { ...f.appearance, bookmarkBarVisible: !f.appearance.bookmarkBarVisible }
              }))
            }
          />
        </div>
        <div className="field">
          <div className="f-label">显示主页按钮</div>
          <Switch
            on={form.appearance.showHomeButton}
            onToggle={() =>
              patch((f) => ({
                ...f,
                appearance: { ...f.appearance, showHomeButton: !f.appearance.showHomeButton }
              }))
            }
          />
        </div>
      </div>

      <ExtensionsSection />
      <ProfileSyncSection />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <button className="btn primary" onClick={save}>
          保存设置
        </button>
        {saved && <span style={{ color: 'var(--success)' }}>已保存 ✓</span>}
      </div>
    </div>
  )
}
