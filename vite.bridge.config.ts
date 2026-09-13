/**
 * 宿主注入脚本（`window.tib`）构建配置。
 *
 * 为什么单独一份配置：这份脚本不是 UI 的一部分，而是原生宿主注入到 UI 页面里的垫片，
 * 必须构建成**单文件 IIFE**（无 import/export、可内联进 <script>），
 * 因此不能用 UI 那份带 code-splitting 的配置。
 *
 * 产物：dist/ui/tib-host.js —— 由 native/src/scheme.cpp 在提供 tib://ui/index.html 时内联注入。
 * 注意：本配置 `emptyOutDir: false`，必须在 `npm run ui:build` 之后执行，否则会清掉 UI 产物。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const rootDir = __dirname

export default defineConfig({
  build: {
    outDir: resolve(rootDir, 'dist/ui'),
    emptyOutDir: false, // UI 产物必须先落地，这里只追加文件
    target: 'chrome120',
    sourcemap: false,
    minify: false, // 注入脚本需要可读：出问题时能在 DevTools 里直接看懂
    lib: {
      entry: resolve(rootDir, 'src/bootstrap/index.ts'),
      name: '__TiBrowserHostBridge',
      formats: ['iife'],
      fileName: () => 'tib-host.js'
    }
  }
})
