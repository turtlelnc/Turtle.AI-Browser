/**
 * 外壳 UI 入口。
 * 注意：CEF 宿主会注入 `window.tib`；若不存在（普通浏览器预览），
 * `./bridge` 会自动降级为 mock 桥并打印一条中文提示。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { applyAppearance } from './theme'
import './styles/global.css'

// 首屏前先应用一次默认外观；真正的用户设置会在 App 拉取 getSettings() 后覆盖。
applyAppearance({})

const container = document.getElementById('root')
if (!container) {
  throw new Error('未找到 #root 节点，外壳 UI 无法挂载')
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
