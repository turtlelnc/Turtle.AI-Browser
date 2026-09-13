/**
 * 资源导入的类型声明（renderer 专用）。
 *
 * `styles/global.css` 由 main.tsx 以副作用方式引入，皮肤则用 `?inline`
 * 取回 CSS 文本（用于运行时按需注入 / 预览），都需要显式声明模块类型。
 * 注意：`?inline` 的声明必须排在 `*.css` 通配之前，否则会被通配吞掉。
 */
declare module '*.css?inline' {
  const css: string
  export default css
}

declare module '*.css' {
  const css: string
  export default css
}
