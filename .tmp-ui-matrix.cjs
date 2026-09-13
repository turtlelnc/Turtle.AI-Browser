// 临时全量验证脚本：3 皮肤 × 2 主题 × 12 个设置分区，检查渲染、溢出与控制台报错。
// 用法: electron .tmp-ui-matrix.cjs
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')

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

  const problems = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (/Electron Security Warning/.test(message)) return
    if (level >= 2) problems.push(`console[${level}] ${message.slice(0, 220)}`)
  })
  win.webContents.on('render-process-gone', (_e, d) => problems.push(`RENDER_GONE ${JSON.stringify(d)}`))

  await win.loadFile(path.join(__dirname, 'dist/ui/index.html'))
  await wait(1500)

  const sections = await win.webContents.executeJavaScript(`
    (() => {
      const btns = document.querySelectorAll('.toolbar .nav-btn')
      btns[btns.length - 1].click()
      return true
    })()
  `)
  await wait(1200)

  const navCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-nav-item').length`)
  console.log('SECTIONS ' + navCount + ' (click=' + sections + ')')

  const results = []
  for (const skin of ['tibrowser', 'edge', 'chrome']) {
    for (const theme of ['light', 'dark']) {
      for (const perf of ['high', 'low']) {
        // 逐个分区切换并测量
        for (let i = 0; i < navCount; i++) {
          const probe = await win.webContents.executeJavaScript(`
            (async () => {
              document.documentElement.dataset.skin = ${JSON.stringify(skin)}
              document.documentElement.dataset.theme = ${JSON.stringify(theme)}
              document.documentElement.dataset.perf = ${JSON.stringify(perf)}
              const nav = document.querySelectorAll('.settings-nav-item')
              nav[${i}].click()
              await new Promise(r => setTimeout(r, 260))
              const body = document.querySelector('.ov-body')
              const overflowing = []
              document.querySelectorAll('.ov-body, .settings-layout, .card-options, .fp-grid, .app-grid, .stat-grid, .dialog').forEach(el => {
                if (el.scrollWidth - el.clientWidth > 2) overflowing.push((el.className || '?') + '+' + (el.scrollWidth - el.clientWidth))
              })
              const cs = getComputedStyle(document.documentElement)
              return {
                label: nav[${i}].textContent.replace(/\\s+/g, ' ').trim(),
                heading: document.querySelector('.settings-content h1')?.textContent ?? null,
                subHeading: document.querySelector('.settings-content h2')?.textContent ?? null,
                nodes: document.querySelectorAll('.settings-content *').length,
                bodyScrollWidth: body.scrollWidth,
                bodyClientWidth: body.clientWidth,
                overflowing,
                docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                accent: cs.getPropertyValue('--tb-accent').trim(),
                blur: cs.getPropertyValue('--tb-chrome-blur').trim(),
                elev4: cs.getPropertyValue('--tb-elev-4').trim(),
                motion: cs.getPropertyValue('--tb-motion-slow').trim(),
                emptyStates: document.querySelectorAll('.empty, .loading, .callout').length,
                buttons: document.querySelectorAll('button, .btn').length,
                firstText: (document.querySelector('.settings-content')?.innerText || '').slice(0, 90).replace(/\\n+/g, ' | ')
              }
            })()
          `)
          results.push({ skin, theme, perf, section: i, ...probe })
        }
      }
    }
  }

  // 汇总
  const bad = results.filter((r) => r.docOverflowX > 0 || (r.overflowing && r.overflowing.length) || r.nodes < 8)
  console.log('MEASURED ' + results.length)
  console.log('BAD ' + JSON.stringify(bad.slice(0, 12), null, 1))
  const perfDiff = {
    high: results.find((r) => r.perf === 'high' && r.skin === 'tibrowser' && r.theme === 'light'),
    low: results.find((r) => r.perf === 'low' && r.skin === 'tibrowser' && r.theme === 'light')
  }
  console.log('PERF_HIGH ' + JSON.stringify({ blur: perfDiff.high?.blur, elev4: perfDiff.high?.elev4, motion: perfDiff.high?.motion }))
  console.log('PERF_LOW  ' + JSON.stringify({ blur: perfDiff.low?.blur, elev4: perfDiff.low?.elev4, motion: perfDiff.low?.motion }))
  const accents = {}
  for (const r of results) accents[`${r.skin}/${r.theme}`] = r.accent
  console.log('ACCENTS ' + JSON.stringify(accents))

  // 无痕指示器 + 下载警告对话框（mock 桥在 8s 后自动派发 downloadWarning）
  await win.webContents.executeJavaScript(`
    (() => { document.querySelector('.ov-header .nav-btn')?.click(); return true })()
  `)
  await wait(400)
  const incognitoProbe = await win.webContents.executeJavaScript(`
    (() => ({
      badge: document.querySelector('.tabs .badge')?.textContent?.trim() ?? null,
      incognitoTabChip: !!document.querySelector('.tab.incognito'),
      tabCount: document.querySelectorAll('.tab').length
    }))()
  `)
  console.log('INCOGNITO ' + JSON.stringify(incognitoProbe))

  const dialogSeen = await (async () => {
    for (let i = 0; i < 40; i++) {
      const ok = await win.webContents.executeJavaScript(`!!document.querySelector('.dialog-layer .dialog')`)
      if (ok) return true
      await wait(400)
    }
    return false
  })()
  const dialogProbe = dialogSeen
    ? await win.webContents.executeJavaScript(`
        (() => {
          const d = document.querySelector('.dialog')
          return {
            title: d.querySelector('h2')?.textContent ?? null,
            rows: [...d.querySelectorAll('.dlg-meta .row')].map(r => r.textContent.trim()),
            buttons: [...d.querySelectorAll('.dlg-actions .btn')].map(b => b.textContent.trim()),
            overflow: d.scrollWidth - d.clientWidth
          }
        })()
      `)
    : { missing: true }
  console.log('DOWNLOAD_DIALOG ' + JSON.stringify(dialogProbe))
  if (dialogSeen) {
    await win.webContents.executeJavaScript(`document.querySelectorAll('.dialog-layer')[0].style.setProperty('--x','0'); true`)
    const shot = await win.webContents.capturePage()
    if (shot.toPNG().length) require('node:fs').writeFileSync(path.join(__dirname, '.tmp-shot-dialog.png'), shot.toPNG())
  }

  // 每个分区在每个皮肤/主题组合下的标题，用于人工核对分区内容确实切换了
  const headings = results.filter((r) => r.theme === 'light' && r.perf === 'high').map((r) => `${r.skin}#${r.section} ${r.heading} / ${r.subHeading}`)
  console.log('HEADINGS\n  ' + headings.join('\n  '))
  console.log('CONSOLE_PROBLEMS ' + JSON.stringify(problems.slice(0, 15), null, 1))
  app.exit(0)
}).catch((e) => {
  console.error('FATAL', e)
  app.exit(3)
})
