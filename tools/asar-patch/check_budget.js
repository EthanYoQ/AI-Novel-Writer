// Cross-check every runtime budget in the renderer bundle against the app-level
// policy ceiling enforced by generation-harness (var G).
// Prevents regressions like "生成会话预算超过应用安全上限。"
//   CLI: node check_budget.js [harnessFile] [rendererFile]
//   API: require('./check_budget.js').runCheck(harnessSrc, rendererSrc) -> {ok, ceiling, rows}
const fs = require('fs')

const CEIL_RE = /var G=Object\.freeze\(\{maxAttempts:(\d+),maxRequestedOutputTokens:(\d+),maxRequestedOutputTokensPerAttempt:(\d+),deadlineMs:([0-9e.]+)\}\)/
const ENTRY_RE = /"?([A-Za-z-]+)"?:Object\.freeze\(\{maxAttempts:(\d+),maxRequestedOutputTokens:(\d+),maxRequestedOutputTokensPerAttempt:(\d+),deadlineMs:([0-9e.]+)\}\)/g

function sliceBalanced(src, anchor) {
  const start = src.indexOf(anchor)
  if (start < 0) throw new Error('anchor not found: ' + anchor)
  let i = src.indexOf('{', start)
  let depth = 0, inStr = null, esc = false
  for (; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced at ' + anchor)
}

function runCheck(harnessSrc, rendererSrc) {
  const cm = harnessSrc.match(CEIL_RE)
  if (!cm) throw new Error('policy ceiling (var G) not found in harness')
  const ceiling = {
    maxAttempts: Number(cm[1]),
    maxRequestedOutputTokens: Number(cm[2]),
    maxRequestedOutputTokensPerAttempt: Number(cm[3]),
    deadlineMs: Number(cm[4]),
  }
  const body = sliceBalanced(rendererSrc, 'Uk=Object.freeze(')
  const rows = []
  let m
  ENTRY_RE.lastIndex = 0
  while ((m = ENTRY_RE.exec(body))) {
    const [, name, a, tok, per, dl] = m
    const v = {
      maxAttempts: Number(a),
      maxRequestedOutputTokens: Number(tok),
      maxRequestedOutputTokensPerAttempt: Number(per),
      deadlineMs: Number(dl),
    }
    v.over = Object.keys(ceiling).filter((k) => v[k] > ceiling[k])
    v.name = name
    rows.push(v)
  }
  if (rows.length === 0) throw new Error('no budget entries found — bundle layout changed')
  return { ok: rows.every((r) => r.over.length === 0), ceiling, rows }
}

module.exports = { runCheck }

if (require.main === module) {
  const harness = fs.readFileSync(process.argv[2] || 'tmp/harness.mjs', 'utf8')
  const renderer = fs.readFileSync(process.argv[3] || 'tmp/idx_installed.mjs', 'utf8')
  const { ok, ceiling, rows } = runCheck(harness, renderer)
  console.log('ceiling G =', ceiling)
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(24)} attempts=${String(r.maxAttempts).padEnd(3)} tokens=${String(r.maxRequestedOutputTokens).padEnd(7)} per=${String(r.maxRequestedOutputTokensPerAttempt).padEnd(6)} deadline=${(r.deadlineMs / 60000).toFixed(0)}min`,
      r.over.length ? `  <<< OVER CEILING: ${r.over.join(',')}` : '  ok'
    )
  }
  console.log(ok ? '\nCHECK PASS: all budgets within app ceiling' : '\nCHECK FAIL: budget(s) exceed ceiling')
  process.exit(ok ? 0 : 1)
}
