/**
 * TiBrowser 外壳 UI（renderer）独立构建配置。
 *
 * v1.0.0-rc1 起，浏览器外壳不再由 Electron / electron-vite 打包，
 * 而是由本配置单独构建为静态资源，交给原生 CEF 宿主通过本地回环 HTTP 提供
 * （`http://127.0.0.1:<port>/<token>/ui/index.html`，见 native/src/local_server.cpp）：
 *
 *   ┌ 目录结构 ─────────────────────────────────────────────┐
 *   │ src/renderer/index.html   ← 外壳入口（Rollup input）    │
 *   │ src/renderer/src/**       ← React 源码（@renderer 别名） │
 *   │ src/shared/**             ← 三方共享契约（@shared 别名）  │
 *   │ dist/ui/**               ← 构建产物（native 启动时复制到输出目录 ui/）│
 *   └───────────────────────────────────────────────────────┘
 *
 * 两个脚本（由根 package.json 的使用者添加，本任务不修改 package.json）：
 *   "ui:dev":   "vite --config vite.config.ts"
 *   "ui:build": "vite build --config vite.config.ts"
 *
 * 注意：`base: './'` 是硬性要求——产物要能被相对路径引用加载，
 * 绝对路径的资源引用在回环 HTTP 与人工 file:// 走查两种场景下都会 404。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rootDir = __dirname
const rendererRoot = resolve(rootDir, 'src/renderer')

/**
 * 构建号兜底值：直接读 src/shared/constants.ts。
 * 这里以前写死过一个旧的构建号，构建号升级后没人记得改它，
 * 单独跑 ui:build（不经 scripts/build-dist.mjs 注入 TIB_BUILD）就会把旧构建号打进产物 ——
 * 现在改为从唯一版本来源读取，check-release.mjs 也会检查这个兜底写法没被改回硬编码。
 */
function buildFromConstants(): string {
  try {
    const text = readFileSync(resolve(rootDir, 'src/shared/constants.ts'), 'utf8')
    return /APP_BUILD\s*=\s*'(\d+)'/.exec(text)?.[1] ?? '0'
  } catch {
    return '0'
  }
}

/**
 * Chromium / CEF 版本号：构建时注入。
 * 优先用环境变量 `TIB_CEF_VERSION`；否则直接从 third_party/cef 的头文件推导，
 * 这样「关于」页展示的内核版本永远与真正链接进去的内核一致。
 */
function cefVersionFromHeader(): string {
  try {
    const text = readFileSync(
      resolve(rootDir, 'third_party/cef/include/cef_version.h'),
      'utf8'
    )
    const pick = (name: string) =>
      new RegExp(`#define\\s+${name}\\s+(\\d+)`).exec(text)?.[1] ?? ''
    const major = pick('CEF_VERSION_MAJOR')
    const minor = pick('CEF_VERSION_MINOR')
    const patch = pick('CEF_VERSION_PATCH')
    return major && minor && patch ? `${major}.${minor}.${patch}` : ''
  } catch {
    return ''
  }
}

const CEF_VERSION = process.env.TIB_CEF_VERSION || cefVersionFromHeader() || '150.0.20'

export default defineConfig({
  root: rendererRoot,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(rootDir, 'src/shared'),
      '@renderer': resolve(rootDir, 'src/renderer/src')
    }
  },
  // `{cefVersion}` 占位符：index.html 与源码中的 __CEF_VERSION__ 都在构建时被替换，
  // 这样「关于」页面展示的内核版本永远与真正链接的 CEF 一致。
  define: {
    __CEF_VERSION__: JSON.stringify(CEF_VERSION),
    __TIB_BUILD__: JSON.stringify(process.env.TIB_BUILD ?? buildFromConstants())
  },
  server: {
    port: 5273,
    strictPort: false,
    open: true,
    host: '127.0.0.1'
  },
  preview: {
    port: 5274,
    strictPort: false
  },
  build: {
    outDir: resolve(rootDir, 'dist/ui'),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
    // 产物是给 CEF 的 tib://ui/index.html 用的，构建日志里显示绝对路径会很吵
    assetsDir: 'assets',
    rollupOptions: {
      input: resolve(rendererRoot, 'index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
})
