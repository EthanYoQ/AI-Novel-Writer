// Validate the outline-validator patches BEFORE touching app.asar:
//   1. the real saved output must now pass
//   2. genuinely broken output must STILL fail (missing / empty / duplicate / out-of-order)
const fs = require('fs')
const { PATCHES } = (() => {
  // reuse the exact patch definitions from asar_patch.js
  const src = fs.readFileSync('./asar_patch.js', 'utf8')
  const start = src.indexOf('const PATCHES = [')
  let i = src.indexOf('[', start)
  let depth = 0, inStr = null, esc = false
  for (; i < src.length; i++) {
    const c = src[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) break }
  }
  return new Function(`${src.slice(start, i + 1)}; return {PATCHES};`)()
})()

const base = fs.readFileSync('tmp/idx_installed.mjs', 'utf8')
const arch = JSON.parse(fs.readFileSync('./sample-partial_arch.json', 'utf8'))  // user-provided sample; not committed
const realBody = arch.synopsis_result
const N = 1, R = 20

let patched = base
const wanted = ['outline-heading-bold', 'outline-ignore-later-headings']
for (const p of PATCHES) {
  if (!wanted.includes(p.name)) continue
  if (p.arc !== 'dist/assets/index-CxbeuPBs.js') continue
  const hits = patched.split(p.from).length - 1
  if (patched.includes(p.mark)) { console.log('already present:', p.name); continue }
  if (hits !== 1) throw new Error(`${p.name}: anchor matched ${hits} times`)
  patched = patched.replace(p.from, p.to)
  console.log('applied locally:', p.name)
}
console.log()

function loadValidator(src) {
  const start = src.indexOf('function pM(')
  const emStart = src.indexOf('function EM(', start)
  const code = src.slice(start, emStart)
  let i = src.indexOf('{', emStart)
  let depth = 0, inStr = null, esc = false
  for (; i < src.length; i++) {
    const c = src[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) break }
  }
  const emCode = src.slice(emStart, i + 1)
  return new Function(`${code}\n${emCode}\nreturn {EM, TM};`)()
}

function run(src, body, seed = '', label) {
  const { EM } = loadValidator(src)
  try {
    EM(body, seed, N, R, (zh) => zh, false)
    return { pass: true, label }
  } catch (e) {
    if (e && e.code === undefined && String(e.message).includes('未按顺序')) {
      return { pass: false, label, msg: String(e.message).slice(0, 120) }
    }
    throw e
  }
}

const CLEAN = Array.from({ length: 20 }, (_, i) => `第${i + 1}章：标题${i + 1}\n这是第${i + 1}章的正文内容，非空。\n`).join('\n')

const CASES = [
  { label: 'REAL saved output (01:06)', body: realBody, seed: '', expect: 'pass' },
  { label: 'well-formed 20 chapters', body: CLEAN, seed: '', expect: 'pass' },
  { label: 'bold **第N章** 20 chapters', body: CLEAN.replace(/^(第\d+章：.*)$/gm, '**$1**'), seed: '', expect: 'pass' },
  { label: 'clean + later overview block', body: CLEAN + '\n第21–30章：后续概览\n后续内容略。\n', seed: '', expect: 'pass' },
  { label: 'MISSING chapter 7', body: CLEAN.replace(/第7章：标题7\n.*\n/, ''), seed: '', expect: 'fail' },
  { label: 'EMPTY body for chapter 3', body: CLEAN.replace('这是第3章的正文内容，非空。', ''), seed: '', expect: 'fail' },
  { label: 'DUPLICATE chapter 5', body: CLEAN + '\n第5章：重复\n又写了一遍。\n', seed: '', expect: 'fail' },
  { label: 'OUT OF ORDER (3 before 2)', body: '第1章：A\n正文一。\n第3章：C\n正文三。\n第2章：B\n正文二。\n', seed: '', expect: 'fail' },
  { label: 'below range (第0章)', body: '第0章：零\n内容。\n' + CLEAN, seed: '', expect: 'fail' },
]

let bad = 0
for (const c of CASES) {
  const r = run(patched, c.body, c.seed, c.label)
  const ok = (r.pass ? 'pass' : 'fail') === c.expect
  if (!ok) bad++
  console.log(
    `${ok ? 'OK  ' : 'BAD '} ${c.label.padEnd(32)} -> ${r.pass ? 'PASS' : 'FAIL'}${r.msg ? ' :: ' + r.msg : ''}`
  )
}
console.log()
console.log(bad === 0 ? 'ALL CASES BEHAVE AS EXPECTED' : `${bad} CASE(S) BEHAVE WRONGLY — DO NOT SHIP`)
process.exit(bad === 0 ? 0 : 1)
