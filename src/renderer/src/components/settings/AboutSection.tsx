/**
 * 设置 · 关于
 *
 * 版本号固定展示为 `v1.0.0-rc1 (build 260913)`（APP_VERSION / APP_BUILD 的展示格式），
 * 内核版本由构建期 `{cefVersion}` 占位符注入（见根目录 vite.config.ts 的 define）。
 */
import { useEffect, useState } from 'react'
import type { ServiceStatus } from '@shared/bridge'
import { TIB_CEF_VERSION, TIB_LICENSE, TIB_VERSION_LABEL, TIB_WEBSITE } from '@shared/bridge'
import { tib } from '../../bridge'
import { Badge, Callout, CopyButton, Field } from '../ui'
import { External, Info, License, TurtleMark } from '../icons'

export function AboutSection(): JSX.Element {
  const [service, setService] = useState<ServiceStatus | null>(null)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    tib
      .serviceStatus()
      .then(setService)
      .catch(() => setService(null))
  }, [])

  return (
    <section className="ov-section">
      <div className="settings-hero">
        <span className="hero-icon">
          <TurtleMark size={22} />
        </span>
        <div className="hero-text">
          <h1>TiBrowser</h1>
          <p>基于 Chromium 内核的 AI 安全浏览器。拥有 Chrome 的主要功能，内置 AI 助手与本地安全服务。</p>
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <Field label="版本" desc="当前安装的 TiBrowser 版本与构建号">
          <span className="code-inline">{TIB_VERSION_LABEL}</span>
          <CopyButton text={TIB_VERSION_LABEL} onCopy={async (t) => { await tib.copyToClipboard(t); setCopied(t) }} />
        </Field>

        <Field
          label="Chromium / CEF 内核版本"
          desc="由构建脚本在打包时注入（{cefVersion} 占位符），与真正链接的内核完全一致"
        >
          <span className="code-inline">{TIB_CEF_VERSION}</span>
        </Field>

        <Field label="开源许可证" desc="本项目以 GPL-3.0 发布，欢迎在遵守许可证的前提下自由使用与修改">
          <Badge tone="accent">
            <License size={12} />
            {TIB_LICENSE}
          </Badge>
        </Field>

        <Field label="官方网站" desc="下载、更新日志与文档都在这里">
          <span className="code-inline">{TIB_WEBSITE}</span>
          <button
            className="btn small"
            type="button"
            onClick={() => void tib.navigate(TIB_WEBSITE)}
            title="在浏览器中打开官网"
          >
            <External size={14} />
            打开
          </button>
        </Field>

        <Field label="本地 AI 服务" desc="AI / 同步 / 自动化能力都由这个独立的边车进程提供">
          <Badge tone={service?.running ? 'ok' : undefined}>
            {service ? (service.running ? `运行中 · 端口 ${service.port ?? '—'}` : '未运行') : '状态未知'}
          </Badge>
          {service ? <Badge>{service.version}</Badge> : null}
        </Field>
      </div>

      {copied ? <Callout tone="accent">版本号已复制到剪贴板。</Callout> : null}

      <div style={{ marginTop: 20 }}>
        <Callout icon={<Info size={16} />}>
          皮肤说明：TiBrowser 的三种皮肤（TiBrowser / Edge 风格 / Chrome 风格）均为本项目自行绘制的界面效果，
          布局致敬但<strong>不含</strong>任何第三方的专有图标、商标或资源。
        </Callout>
      </div>
    </section>
  )
}
