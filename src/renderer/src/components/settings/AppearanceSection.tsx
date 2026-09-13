/**
 * 设置 · 外观（feature 8 皮肤系统 + feature 14 Apple 风格 + 低端设备性能档）
 *
 * 皮肤通过 `<html data-skin>` 生效，同时持久化到 `tib.setSkin()`；
 * 主题与性能档写入设置（`tib.setSettings`）。
 */
import { useEffect, useState } from 'react'
import type { BrowserSkin, PerfMode, ThemeMode2, TibSettings } from '@shared/bridge'
import { tib } from '../../bridge'
import { SKINS, SKIN_HONESTY_NOTE, skinName } from '../../skins'
import { Callout, Field, OptCard, Segmented, Switch } from '../ui'
import { Bolt, Info, Leaf, Palette, TurtleMark } from '../icons'

interface Props {
  form: TibSettings
  patch: (p: Partial<TibSettings>) => void
}

export function AppearanceSection({ form, patch }: Props): JSX.Element {
  const [savedSkin, setSavedSkin] = useState<BrowserSkin>(form.skin)
  const [skinError, setSkinError] = useState('')

  useEffect(() => {
    let alive = true
    tib
      .getSkin()
      .then((s) => alive && setSavedSkin(s))
      .catch((err: unknown) => alive && setSkinError(String(err)))
    return () => {
      alive = false
    }
  }, [])

  /** 皮肤是即时生效的（切换无需重启），因此立刻落盘并作用到 <html> */
  async function chooseSkin(skin: BrowserSkin): Promise<void> {
    patch({ skin })
    document.documentElement.dataset.skin = skin
    try {
      await tib.setSkin(skin)
      setSavedSkin(skin)
      setSkinError('')
    } catch (err) {
      setSkinError(`皮肤已在本窗口生效，但写入设置失败：${String(err)}`)
    }
  }

  return (
    <section className="ov-section">
      <h2>外观</h2>
      <p className="sec-desc">
        皮肤决定标签形状、圆角、密度与强调色；主题决定明暗；性能档决定是否保留毛玻璃与动画。
        三者可以任意组合，互不冲突。
      </p>

      <div className="card-options cols-3" style={{ marginBottom: 16 }}>
        {SKINS.map((s) => (
          <OptCard
            key={s.id}
            name="tb-skin"
            value={s.id}
            selected={form.skin === s.id}
            onSelect={(v) => void chooseSkin(v as BrowserSkin)}
            icon={s.id === 'tibrowser' ? TurtleMark : s.id === 'edge' ? Palette : Bolt}
            title={s.name}
            tag={form.skin === s.id ? '使用中' : undefined}
            desc={s.description}
            foot={`信息密度：${s.density}`}
          />
        ))}
      </div>
      {skinError ? (
        <Callout tone="warn">{skinError}</Callout>
      ) : null}
      <div style={{ marginBottom: 16 }}>
        <Callout icon={<Info size={16} />}>{SKIN_HONESTY_NOTE}</Callout>
      </div>

      <Field
        label="主题"
        desc="跟随系统时会随 Windows 的浅色 / 深色设置实时切换"
      >
        <Segmented<ThemeMode2>
          value={form.theme}
          onChange={(v) => patch({ theme: v })}
          options={[
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
            { value: 'system', label: '跟随系统' }
          ]}
        />
      </Field>

      <Field
        label="性能档"
        desc="低占用会关闭毛玻璃、阴影与过渡动画，供低端设备 / 远程桌面使用；系统开启「减少动态效果」时同样会降级。"
      >
        <Segmented<PerfMode>
          value={form.perf}
          onChange={(v) => patch({ perf: v })}
          options={[
            { value: 'high', label: '标准效果' },
            { value: 'low', label: '低占用' }
          ]}
        />
      </Field>

      <Field label="显示书签栏" desc="在工具栏下方常驻显示书签">
        <Switch
          on={form.bookmarkBarVisible}
          onToggle={() => patch({ bookmarkBarVisible: !form.bookmarkBarVisible })}
        />
      </Field>

      <Field label="显示主页按钮" desc="在工具栏显示回到主页的按钮">
        <Switch
          on={form.showHomeButton}
          onToggle={() => patch({ showHomeButton: !form.showHomeButton })}
        />
      </Field>

      <div style={{ marginTop: 12 }}>
        <Callout icon={<Leaf size={16} />}>
          当前外观：皮肤 <strong>{skinName(form.skin)}</strong>（已保存：{skinName(savedSkin)}） ·
          主题 <strong>{form.theme === 'system' ? '跟随系统' : form.theme === 'dark' ? '深色' : '浅色'}</strong> ·
          性能档 <strong>{form.perf === 'low' ? '低占用' : '标准效果'}</strong>。
        </Callout>
      </div>
    </section>
  )
}
