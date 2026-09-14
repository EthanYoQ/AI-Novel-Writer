// Replay the app's outline heading parser (TM/SM/CM) against candidate formats
// to see which ones the validator can actually see.
const fs = require('fs')

const src = fs.readFileSync('tmp/idx_installed.mjs', 'utf8')

// Pull the real parser out of the bundle: slice from "var vM=class extends Error{}"
// through the end of function TM, then evaluate it.
const start = src.indexOf('var vM=class extends Error{}')
const end = src.indexOf('function EM(', start)
if (start < 0 || end < 0) throw new Error('parser region not found')
const code = src.slice(start, end)

const sandbox = `
${code}
return { TM, wM };
`
const { TM } = new Function(sandbox)()

const SAMPLES = {
  'plain: 第1章：标题': '第1章：废土上的齿轮少年',
  'h2: ## 第1章：标题': '## 第1章：废土上的齿轮少年',
  'bold: **第1章：标题**': '**第1章：废土上的齿轮少年**',
  'bold-nospace-after: **第1章 标题**': '**第1章 废土上的齿轮少年**',
  'list: - 第1章：标题': '- 第1章：废土上的齿轮少年',
  'h2-bold: ## **第1章：标题**': '## **第1章：废土上的齿轮少年**',
  'en dash range: 第1–5章：标题': '第1–5章：中期过渡',
  'chapter en: Chapter 1: Title': 'Chapter 1: The Waste',
  'stage hdr: ## 第一阶段（第1–25章）': '## 第一阶段：觉醒与追杀（第1–25章）',
  'paren: 交汇节点（第25章）：三方合力': '交汇节点（第25章）：三方合力',
}

console.log('format'.padEnd(36), 'headings found')
console.log('-'.repeat(60))
let ok = 0
for (const [label, text] of Object.entries(SAMPLES)) {
  const body = 'intro line\n\n' + text + '\n正文内容示例，非空。\n'
  const r = TM(body)
  const desc = r.length ? r.map((x) => `${x.from}-${x.to}`).join(',') : 'NONE'
  if (r.length) ok++
  console.log(label.padEnd(36), desc)
}
console.log('-'.repeat(60))
console.log(`${ok}/${Object.keys(SAMPLES).length} formats recognized`)
