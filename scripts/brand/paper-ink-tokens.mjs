// 从 src/styles/paper-ink/tokens.css 生成 docs/brand/README.md 里的令牌表，并检查该文档的相对链接。
// 用法：
//   node scripts/brand/paper-ink-tokens.mjs           打印令牌表
//   node scripts/brand/paper-ink-tokens.mjs --write   把令牌表写进文档的标记之间
//   node scripts/brand/paper-ink-tokens.mjs --check   令牌表与源码不一致或链接指向不存在的文件时以退出码 1 结束
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TOKEN_FILE = 'src/styles/paper-ink/tokens.css'
const DOC_FILE = 'docs/brand/README.md'
const DARK_SELECTOR = '.paper-ink[data-theme="dark"]'
const START = '<!-- paper-ink-tokens:start -->'
const END = '<!-- paper-ink-tokens:end -->'

// 分类与用途取自 docs/design/2026-10-11-frontend-redesign/design-system.md「令牌」表和 tokens.css 的注释。
// 每个令牌必须恰好落进一类；新增令牌没有归类时脚本报错，提醒补上用途。
const CATEGORIES = [
  { title: '表面', tokens: { frame: '应用底（外框）', sunken: '凹陷输入', surface: '悬浮面板', 'surface-2': '悬停与选中', paper: '正文纸面' } },
  { title: '墨色', tokens: { ink: '正文与标题', 'ink-2': '次要文字', 'ink-3': '说明文字', 'ink-4': '禁用与占位，只用于占位符、分隔与装饰' } },
  { title: '线', tokens: { rule: '分隔线', 'rule-strong': '控件边框', track: '进度轨道' } },
  { title: '强调（黛蓝）', purpose: '主操作、当前位置、键盘焦点', match: /^accent(-(hover|ink|soft|line|track))?$/ },
  { title: '语义', purpose: '完成、提醒、危险，与强调色色相不同', match: /^(ok|warn|danger)(-(soft|ink|line))?$/ },
  { title: '焦点环、阴影与遮罩', purpose: '焦点环、按钮与面板投影、模态遮罩', match: /^(focus-ring|shadow-(button|panel|pop|seg)|scrim)$/ },
  { title: '浮层', purpose: '菜单、弹层、通知、对话框共用的浮笺', match: /^(layer|shadow-dialog)$/ },
  {
    title: '材质',
    purpose: '按钮与输入框的受光、边线、投影、内凹与薄雾，从基础令牌用 color-mix 派生',
    match: /^(accent-(edge|press|base|top|hover-top)|hi|paper-(hi|top|foot|edge|press)|edge(-strong)?|lift(-soft|-accent)?|sink|wash(-strong)?|danger-(edge|hover|press))$/,
  },
  { title: '字体', tokens: { 'font-ui': '界面无衬线', 'font-display': '标题衬线', 'font-prose': '正文衬线', 'font-num': '章节号与统计数字', 'font-mono': '诊断等宽' } },
  { title: '字号', purpose: '9 级字号阶梯；正文字号、行高与行宽', match: /^(fs-\d+|prose-(size|lh|measure))$/ },
  { title: '间距', purpose: '4px 的倍数', match: /^s-\d+$/ },
  { title: '圆角', purpose: '控件、面板与胶囊的圆角', match: /^radius(-(sm|control|lg|panel|pill))?$/ },
  { title: '布局', purpose: '侧页宽度与内容区最小宽度', match: /^(sheet-w(-wide)?|content-min-w)$/ },
  { title: '动效', purpose: '只用于状态变化', match: /^(ease|dur(-fast)?)$/ },
  { title: '层级', purpose: '侧页、弹层、遮罩、对话框、命令式弹窗、提示栈的叠放顺序', match: /^z-[a-z]+$/ },
]

function declarations(css) {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const result = new Map()
  for (const [, name, value] of body.matchAll(/(?:^|[;{\s])--([\w-]+)\s*:\s*([^;]+);/g)) result.set(name, value.trim().replace(/\s+/g, ' '))
  return result
}

function readTokens() {
  const css = fs.readFileSync(path.join(root, TOKEN_FILE), 'utf8')
  const split = css.indexOf(DARK_SELECTOR)
  if (split < 0) throw new Error(`${TOKEN_FILE} 里找不到深色选择器 ${DARK_SELECTOR}`)
  const light = declarations(css.slice(0, split))
  const dark = declarations(css.slice(split))
  const orphans = [...dark.keys()].filter(name => !light.has(name))
  if (orphans.length) throw new Error(`只在深色里声明的令牌：${orphans.join(', ')}`)
  return { light, dark }
}

function categorize(name) {
  const hits = CATEGORIES.filter(category => (category.tokens ? name in category.tokens : category.match.test(name)))
  if (hits.length !== 1) throw new Error(`--${name} 落进 ${hits.length} 个分类，要恰好 1 个：在 CATEGORIES 里补上或改正`)
  return hits[0]
}

const cell = value => '`' + value.replace(/\|/g, '\\|') + '`'

function renderTable({ light, dark }) {
  const rows = new Map(CATEGORIES.map(category => [category, []]))
  for (const [name, value] of light) {
    const category = categorize(name)
    const purpose = category.tokens ? ` ${category.tokens[name]} |` : ''
    rows.get(category).push(`| ${cell(`--${name}`)} | ${cell(value)} | ${dark.has(name) ? cell(dark.get(name)) : '同浅色'} |${purpose}`)
  }
  const lines = [
    `共 ${light.size} 个令牌，其中 ${dark.size} 个在深色主题里改了值。「同浅色」表示深色沿用左列的写法；写法里引用的令牌按深色的值计算。`,
    '',
  ]
  for (const [category, categoryRows] of rows) {
    if (!categoryRows.length) continue
    const header = category.tokens ? ['| 令牌 | 浅色 | 深色 | 用途 |', '| --- | --- | --- | --- |'] : [`用途：${category.purpose}。`, '', '| 令牌 | 浅色 | 深色 |', '| --- | --- | --- |']
    lines.push(`#### ${category.title}`, '', ...header, ...categoryRows, '')
  }
  return lines.join('\n').trimEnd()
}

function block(table) {
  return `${START}\n\n${table}\n\n${END}`
}

function brokenLinks(doc) {
  const docDir = path.dirname(path.join(root, DOC_FILE))
  const targets = [...doc.matchAll(/\]\(([^)\s]+)\)|\ssrc="([^"]+)"/g)].map(match => match[1] ?? match[2])
  return targets
    .filter(target => !/^(https?:|mailto:|#)/.test(target))
    .filter(target => !fs.existsSync(path.resolve(docDir, target.split('#')[0])))
}

function main(mode) {
  const table = renderTable(readTokens())
  if (!mode) {
    console.log(table)
    return 0
  }
  const docPath = path.join(root, DOC_FILE)
  const doc = fs.readFileSync(docPath, 'utf8')
  const start = doc.indexOf(START)
  const end = doc.indexOf(END)
  if (start < 0 || end < start) throw new Error(`${DOC_FILE} 里缺少标记 ${START} 与 ${END}`)
  const next = doc.slice(0, start) + block(table) + doc.slice(end + END.length)
  if (mode === '--write') {
    fs.writeFileSync(docPath, next)
    console.log(`已写入 ${DOC_FILE}`)
    return 0
  }
  if (mode !== '--check') throw new Error(`不认识的参数 ${mode}`)
  const problems = []
  if (next !== doc) problems.push(`${DOC_FILE} 的令牌表与 ${TOKEN_FILE} 不一致，运行 --write 重新生成`)
  for (const target of brokenLinks(doc)) problems.push(`${DOC_FILE} 链接到不存在的文件：${target}`)
  for (const problem of problems) console.error(problem)
  if (!problems.length) console.log(`${DOC_FILE} 的令牌表与源码一致，相对链接都能解析`)
  return problems.length ? 1 : 0
}

try {
  process.exitCode = main(process.argv[2])
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
