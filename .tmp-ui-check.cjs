// 临时渲染验证脚本（用工作区已有的 electron 依赖，不新增任何 runtime 依赖）。
// 逐个组合验证 data-skin × data-theme，并可点击「菜单」按钮打开设置覆盖层后截图。
// 注意：隐藏窗口的 capturePage 会返回旧帧，因此这里把窗口移到屏幕外并 invalidate 后再截图。
// 用法: electron .tmp-ui-check.cjs <skin> <theme> [overlay] [outPng]
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')

const skin = process.argv[2] || 'tibrowser'
const theme = process.argv[3] || 'light'
const overlay = process.argv[4] || ''
const out = process.argv[5] || path.join(__dirname, `.tmp-shot-${skin}-${theme}${overlay ? '-' + overlay : ''}.png`)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    x: -2400,
    y: 0,
    show: true,
    frame: false,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })

  const logs = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (!/Electron Security Warning/.test(message)) logs.push(`[${level}] ${message.slice(0, 160)}`)
  })
  win.webContents.on('render-process-gone', (_e, d) => logs.push(`RENDER_GONE ${JSON.stringify(d)}`))

  await win.loadFile(path.join(__dirname, 'dist/ui/index.html'))
  await wait(1200)

  /** 轮询等待某个条件成立（最多 waitMs） */
  async function until(expr, waitMs = 6000) {
    const deadline = Date.now() + waitMs
    let last = null
    while (Date.now() < deadline) {
      last = await win.webContents.executeJavaScript(`(() => { try { return ${expr} } catch (e) { return 'ERR:' + e.message } })()`)
      if (last === true) return true
      await wait(200)
    }
    return last
  }

  const loaded = await until("document.querySelectorAll('.tab').length > 0")

  // 1) 用 UI 自身的按钮打开设置覆盖层（不直接调桥）
  let clickResult = 'skipped'
  if (overlay === 'settings') {
    const ready = await until("document.querySelectorAll('.toolbar .nav-btn').length > 0")
    clickResult = `toolbarReady=${ready} ` + (await win.webContents.executeJavaScript(`
      (() => {
        const btns = document.querySelectorAll('.toolbar .nav-btn')
        if (!btns.length) return 'no-toolbar-button'
        btns[btns.length - 1].click()
        return 'clicked:' + btns.length
      })()
    `))
    const shown = await until("!!document.querySelector('.overlay .settings-nav')")
    clickResult += ` overlayShown=${shown}`
    await wait(500)
  }

  // 2) 切到目标皮肤 / 主题，并强制重绘
  await win.webContents.executeJavaScript(`
    (() => {
      document.documentElement.dataset.skin = ${JSON.stringify(skin)}
      document.documentElement.dataset.theme = ${JSON.stringify(theme)}
      document.body.offsetHeight
      return true
    })()
  `)
  await wait(700)
  win.webContents.invalidate()
  await wait(900)

  const probe = await win.webContents.executeJavaScript(`
    (() => {
      const cs = getComputedStyle(document.documentElement)
      const tabs = document.querySelectorAll('.tab')
      const active = document.querySelector('.tab.active')
      const nav = document.querySelectorAll('.settings-nav-item')
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }
      const overflow = []
      document.querySelectorAll('.overlay, .settings-layout, .card-options, .dialog, .ov-body, .fp-grid').forEach((el) => {
        if (el.scrollWidth - el.clientWidth > 2) overflow.push(el.className + ':' + (el.scrollWidth - el.clientWidth))
      })
      const ovBody = document.querySelector('.ov-body')
      return {
        skin: document.documentElement.dataset.skin,
        theme: document.documentElement.dataset.theme,
        accent: cs.getPropertyValue('--tb-accent').trim(),
        surface2: cs.getPropertyValue('--tb-surface-2').trim(),
        chromeSolid: cs.getPropertyValue('--tb-chrome-bg-solid').trim(),
        bodyTextColor: getComputedStyle(document.body).color,
        activeTabRadius: active ? getComputedStyle(active).borderTopLeftRadius : null,
        tabBox: rect(tabs[0] || null),
        settingsNavItems: nav.length,
        optCards: document.querySelectorAll('.opt-card').length,
        switchCount: document.querySelectorAll('.switch').length,
        overlay: !!document.querySelector('.overlay'),
        overlayTitle: document.querySelector('.ov-header span')?.textContent ?? null,
        ovBodyScrollTop: ovBody ? Math.round(ovBody.scrollTop) : null,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        innerOverflow: overflow,
        textSample: (document.querySelector('.ov-body')?.innerText || document.body.innerText || '').slice(0, 160).replace(/\\n+/g, ' | ')
      }
    })()
  `).catch((e) => ({ probeError: String(e) }))

  const img = await win.webContents.capturePage()
  const buf = img.toPNG()
  if (!buf || buf.length === 0) {
    console.log('CAPTURE_EMPTY retrying once')
    await wait(1200)
    win.webContents.invalidate()
    await wait(1200)
    const img2 = await win.webContents.capturePage()
    fs.writeFileSync(out, img2.toPNG())
    console.log('CAPTURE_RETRY_BYTES ' + img2.toPNG().length)
  } else {
    fs.writeFileSync(out, buf)
  }
  console.log('CLICK ' + clickResult)
  console.log('PROBE ' + JSON.stringify(probe))
  if (logs.length) console.log('CONSOLE ' + JSON.stringify(logs.slice(0, 12)))
  app.exit(0)
}).catch((e) => {
  console.error('FATAL', e)
  app.exit(3)
})
