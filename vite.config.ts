/**
 * TiBrowser 外壳 UI（renderer）独立构建配置。
 *
 * v1.0.0-rc1 起，浏览器外壳不再由 Electron / electron-vite 打包，
 * 而是由本配置单独构建为静态资源，交给原生 CEF 宿主通过 `tib://ui/` 协议提供：
 *
 *   ┌ 目录结构 ─────────────────────────────────────────────┐
 *   │ src/renderer/index.html   ← 外壳入口（Rollup input）    │
 *   │ src/renderer/src/**       ← React 源码（@renderer 别名） │
 *   │ src/shared/**             ← 三方共享契约（@shared 别名）  │
 *   │ dist/ui/**               ← 构建产物（native/src/scheme.cpp 映射）│
 *   └───────────────────────────────────────────────────────┘
 *
 * 两个脚本（由根 package.json 的使用者添加，本任务不修改 package.json）：
 *   "ui:dev":   "vite --config vite.config.ts"
 *   "ui:build": "vite build --config vite.config.ts"
 *
 * 注意：`base: './'` 是硬性要求——产物既可能由 `tib://ui/index.html` 提供，
 * 也可能被人工用 file:// 直接打开做 UI 走查，绝对路径的资源引用在两种场景下都会 404。
 */
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rootDir = __dirname
const rendererRoot = resolve(rootDir, 'src/renderer')

/**
 * Chromium / CEF 版本号：构建时注入。
 * 由原生构建脚本通过环境变量 `TIB_CEF_VERSION` 传入（例如 150.0.20），
 * 未注入时回落到架构文档 §1 记录的内核版本，保证单独构建 UI 也能通过。
 */
const CEF_VERSION = process.env.TIB_CEF_VERSION ?? '150.0.20'

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
    __TIB_BUILD__: JSON.stringify(process.env.TIB_BUILD ?? '260913')
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
