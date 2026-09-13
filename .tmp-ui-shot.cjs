// 临时截图脚本：打开设置并切到指定分区后截图（用已有 electron 依赖）。
// 用法: electron .tmp-ui-shot.cjs <skin> <theme> <sectionIndex> <outPng>
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const [skin = 'tibrowser', theme = 'light', section = '3', out = '.tmp-shot.png'] = process.argv.slice(2)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440, height: 940, x: -2400, y: 0, show: true, frame: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  await win.loadFile(path.join(__dirname, 'dist/ui/index.html'))
  await wait(1500)
  await win.webContents.executeJavaScript(`
    (() => { const b = document.querySelectorAll('.toolbar .nav-btn'); b[b.length-1].click(); return true })()
  `)
  await wait(1200)
  await win.webContents.executeJavaScript(`
    (async () => {
      document.documentElement.dataset.skin = ${JSON.stringify(skin)}
      document.documentElement.dataset.theme = ${JSON.stringify(theme)}
      const nav = document.querySelectorAll('.settings-nav-item')
      nav[${section}]?.click()
      await new Promise(r => setTimeout(r, 600))
      document.querySelector('.ov-body').scrollTop = 0
      return true
    })()
  `)
  await wait(800)
  win.webContents.invalidate()
  await wait(1500)
  let png = (await win.webContents.capturePage()).toPNG()
  for (let i = 0; i < 4 && !png.length; i++) {
    await wait(1500)
    win.webContents.invalidate()
    png = (await win.webContents.capturePage()).toPNG()
  }
  if (!png.length) { console.log('EMPTY'); app.exit(2); return }
  fs.writeFileSync(path.join(__dirname, path.basename(out)), png)
  console.log('OK ' + path.basename(out) + ' ' + png.length)
  app.exit(0)
}).catch((e) => { console.error('FATAL', e); app.exit(3) })
