/**
 * 作用域纠正：v2 只保留「字号」，其余属性一律收回 v3
 *
 * 先生定调（2026-09-15）：
 *   「你要记住，你变大的是**字体大小**，但不能是**字体粗细**和**字体样式**。」
 *
 * 所以白名单只有 font-size 一项，其余全部收回 v3：
 *   font-weight（粗细）· font-family（字族）· font-style（斜体）
 *   letter-spacing（字距）· line-height（行高）· text-transform
 *   以及全部视觉与尺寸属性（color / background / border / border-radius /
 *   box-shadow / height / padding / margin / gap / transform / transition…）
 *
 * 背景：早先为了让墨纸书斋也享有可读字号，曾把排版层作用域整体扩大到
 * html[data-ui='v2']，结果边框、背景、圆角、按钮高度、字重、字族全被带了过去。
 * 先生两次指出：第一次「怎么把我 V2 的边框样式、按钮样式都改了」，
 * 第二次「首页要还原成 V2 那种细细的效果 —— 变大的是字体大小，
 * 但不能是字体粗细和字体样式」。本工具就是这条铁律的执行者。
 *
 * 判定规则：
 *   只含 font-size     -> 保持 html[data-ui='v2']                （v2 与 v3 共用）
 *   完全不含 font-size -> 整条收回 html[data-ui='v2'][data-mag]  （仅 v3）
 *   两者混在一条       -> 拆成两条，各归其位
 *
 * 用法: node scripts/normalize-magazine-scope.mjs src/styles/magazine
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('用法: node scripts/normalize-magazine-scope.mjs <magazine 目录>')

const FILES = ['mag-type.css', 'mag-shell.css', 'mag-controls.css', 'mag-surfaces.css', 'mag-pages.css']

/** 唯一允许作用于 v2 的属性：字号。 */
const TYPE_PROPS = new Set(['font-size'])

const V2 = "html[data-ui='v2']"
const V3 = "html[data-ui='v2'][data-mag]"

function splitBody(body) {
  const types = []
  const others = []
  const notes = []
  let inComment = false
  for (const raw of body.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    if (inComment) {
      notes.push(raw)
      if (t.includes('*/')) inComment = false
      continue
    }
    if (t.startsWith('/*')) {
      notes.push(raw)
      if (!t.includes('*/')) inComment = true
      continue
    }
    const prop = t.split(':')[0].trim().toLowerCase()
    if (TYPE_PROPS.has(prop)) types.push(raw)
    else others.push(raw)
  }
  return { types, others, notes }
}

const COMMENT_ANY = /\/\*\u0001(\d+)\u0001\*\//g

/**
 * 处理前把注释换成占位符，处理后再还原 —— 这一步是必须的。
 *
 * 【坑】本项目的文档注释里会**引用选择器本身**，例如
 *   「特异性：这些规则原本写作 html[data-ui='v2'] 前缀（0,2,1 起…）」
 * 若不剥离注释，正则会把注释里的那个 html[data-ui='v2'] 当成一条规则的选择器，
 * 于是生成 `html[data-ui='v2'][data-mag] 前缀（0,2,1 起…{…}` 这种畸形规则 ——
 * postcss 能过，lightningcss 压缩时却报 "Invalid empty selector"，整次构建挂掉。
 * 占位符写成 /*N*\/ 的形状，因此仍会被 splitBody 识别为注释、原样保留。
 */
function placeholderize(css) {
  const comments = []
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    comments.push(m)
    return `/*\u0001${comments.length - 1}\u0001*/`
  })
  return { stripped, comments }
}

function restore(css, comments) {
  return css.replace(COMMENT_ANY, (_, i) => comments[Number(i)])
}

let totalKeep = 0
let totalRevert = 0
let totalSplit = 0

for (const f of FILES) {
  const p = path.join(dir, f)
  const { stripped: css, comments } = placeholderize(fs.readFileSync(p, 'utf8'))
  const re = /(html\[data-ui='v2'\](?!\[data-mag\])[^{}]*?)\{([^{}]*)\}/g
  let out = ''
  let last = 0
  let m
  const stat = { keep: 0, revert: 0, split: 0 }
  while ((m = re.exec(css))) {
    out += css.slice(last, m.index)
    const sel = m[1]
    const body = m[2]
    const { types, others, notes } = splitBody(body)
    const v3sel = sel.split(V2).join(V3)
    if (others.length === 0) {
      stat.keep++
      out += `${sel}{${body}}`
    } else if (types.length === 0) {
      stat.revert++
      out += `${v3sel}{${body}}`
    } else {
      stat.split++
      const head = notes.length ? notes.join('\n') + '\n' : ''
      out += `${sel}{\n${head}${types.join('\n')}\n}\n\n${v3sel}{\n${others.join('\n')}\n}`
    }
    last = re.lastIndex
  }
  out += css.slice(last)
  fs.writeFileSync(p, restore(out, comments), 'utf8')
  totalKeep += stat.keep
  totalRevert += stat.revert
  totalSplit += stat.split
  console.log(`${f.padEnd(20)} 字号保留 ${String(stat.keep).padStart(3)} 条 / 整体收回 ${String(stat.revert).padStart(3)} 条 / 拆分 ${String(stat.split).padStart(3)} 条`)
}
console.log(`\n合计：保留 ${totalKeep} / 收回 ${totalRevert} / 拆分 ${totalSplit}`)
