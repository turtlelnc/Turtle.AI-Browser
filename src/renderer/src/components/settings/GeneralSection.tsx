/**
 * 设置 · 常规：搜索引擎、主页、会话恢复、边车启动。
 */
import type { TibSettings } from '@shared/bridge'
import { SEARCH_ENGINES } from '@shared/constants'
import { Callout, Field, Switch } from '../ui'
import { Info } from '../icons'

interface Props {
  form: TibSettings
  patch: (p: Partial<TibSettings>) => void
}

export function GeneralSection({ form, patch }: Props): JSX.Element {
  return (
    <section className="ov-section">
      <h2>常规</h2>
      <p className="sec-desc">
        搜索引擎与主页决定地址栏输入与「主页按钮」的行为；会话恢复与边车开关会影响启动速度与内存占用。
      </p>

      <Field label="默认搜索引擎" desc="在地址栏输入非网址内容时使用的搜索方式">
        <select
          value={form.searchEngine}
          onChange={(e) => patch({ searchEngine: e.target.value })}
        >
          {Object.entries(SEARCH_ENGINES).map(([id, s]) => (
            <option key={id} value={id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="主页" desc="点击工具栏主页按钮时打开的网址">
        <input
          type="text"
          value={form.homepage}
          spellCheck={false}
          placeholder="https://"
          onChange={(e) => patch({ homepage: e.target.value })}
        />
      </Field>

      <Field label="启动时恢复上次会话" desc="重新打开上次关闭时的全部标签页">
        <Switch on={form.restoreSession} onToggle={() => patch({ restoreSession: !form.restoreSession })} />
      </Field>

      <Field
        label="随浏览器启动本地 AI 服务"
        desc="AI 对话、MCP、同步与自动化接口都由本地边车（tib-service）提供；关闭后可用「能效 → 即开即用」模式，AI 能力会降级并明确提示。"
      >
        <Switch
          on={form.serviceAutoStart}
          onToggle={() => patch({ serviceAutoStart: !form.serviceAutoStart })}
        />
      </Field>

      <div style={{ marginTop: 12 }}>
        <Callout icon={<Info size={16} />}>
          当前默认搜索引擎：<strong>{SEARCH_ENGINES[form.searchEngine as keyof typeof SEARCH_ENGINES]?.name ?? form.searchEngine}</strong>
          ，主页：<span className="code-inline">{form.homepage || '（未设置）'}</span>
        </Callout>
      </div>
    </section>
  )
}
