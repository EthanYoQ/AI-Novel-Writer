/**
 * 作用域收拢：给 shell.css 的无作用域规则加 [data-ui="v2"] 前缀。
 *
 * 背景：shell.css 头部注释声称「已完成作用域收拢」，但实际只有 base 规则
 * （43–53 行）加了 [data-ui="v2"]，54 行之后的组件规则（.app / .titlebar /
 * .badge / .btn / .card / .modal / .tree-row / .toast …）都是无作用域的全局
 * 类选择器。这些类名与产品（V1）的通用类名（.badge / .btn / .card / .modal /
 * .toast / .tree-row …）冲突，导致 V1 经典界面被 V2 样式污染。
 *
 * 本脚本只处理 shell.css：
 *   1. :root{ → [data-ui="v2"]{（两个全局变量块，收进 v2 作用域）
 *   2. 行首 .xxx / #xxx 选择器 → 加 [data-ui="v2"] 前缀
 *   3. @layer / @font-face / @keyframes / @media 行跳过（@keyframes 内容不该
 *      加；@media 仅 1 条、内容极少，见 shell.css 180 行，影响可忽略）
 *
 * 用法: node scripts/normalize-v2-shell-scope.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const p = path.resolve(import.meta.dirname, '../src/styles/redesign/shell.css')
let css = fs.readFileSync(p, 'utf8')

// 1. 剥离注释（占位符，避免误改注释里引用的选择器）
const comments = []
css = css.replace(/\/\*[\s\S]*?\*\//g, (m) => {
  comments.push(m)
  return `/*__C${comments.length - 1}__*/`
})

// 2. :root → [data-ui="v2"]
css = css.replace(/:root\s*\{/g, '[data-ui="v2"]{')

// 3. 行首类/ID 选择器加 [data-ui="v2"] 前缀
let count = 0
css = css.replace(/^(\s*)([.#][^{}@\n]*)\{/gm, (_m, ind, sel) => {
  count += 1
  return `${ind}[data-ui="v2"] ${sel}{`
})

// 4. 还原注释
css = css.replace(/\/\*__C(\d+)__\*\//g, (_m, i) => comments[Number(i)])

fs.writeFileSync(p, css, 'utf8')
console.log(`done: ${count} 条规则加了 [data-ui="v2"] 作用域`)
