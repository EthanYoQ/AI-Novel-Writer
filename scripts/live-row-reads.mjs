#!/usr/bin/env node
// 回收站（#564）读取路径的扫描器与 codemod。
// 只读：node scripts/live-row-reads.mjs
// 改写：node scripts/live-row-reads.mjs --write
// 结构测试 electron/__tests__/live-row-reads.test.ts 复用同一扫描器。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

/** 有 live_ 视图的原表。读路径必须改读 `live_<表名>`。 */
export const LIVE_ROW_TABLES = Object.freeze(['drafts', 'finalization_outbox', 'summary_snapshots', 'narrative_thread_confirmations'])

/** 职责上必须看见被删行、可以直接读原表的文件。键是仓库相对路径，值是理由。 */
export const RAW_ROW_READERS = Object.freeze({
  'electron/repositories/chapter-deletion-repository.ts': '回收站的唯一写入者：删除、恢复、彻底删除都要读被删行',
  'electron/repositories/draft-version.ts': '版本号要算上被删行，否则 idx_drafts_chapter_version 会撞',
  'electron/services/legacy-project-copy-import.ts': '读旧版作品副本的库，那时还没有 live_ 视图',
  'electron/services/portable-transfer-authority.ts': '核对转移历史时，被删行仍是带收据的历史',
  'electron/services/transferred-character-continuity.ts': '证明派生字段的来源在本库存在过，被删行也算',
})

/**
 * 经外键挂在 drafts 或 contents 上、却没有 live_ 视图的表（G6）。结构测试从 PRAGMA foreign_key_list 推导受管表，
 * 每张受管表要么有视图，要么在这里写明理由。
 */
export const LIVE_ROW_EXEMPT_TABLES = Object.freeze({
  contents: '只按 id 读，id 取自 drafts、reviews、revisions 的行；本身没有章号与状态',
  reviews: '按 id 或 base_draft_id 读；PR2 没有 deleted 行。db:review-get-full、review-get-latest、review-list 直接用渲染端给的 id，PR3 产生 deleted 行前必须按父稿是否在 live_drafts 拦住',
  revisions: '按 id 或 base_draft_id 读；PR2 没有 deleted 行。db:revision-get-full、revision-list、revision-get-pending 直接用渲染端给的 id，PR3 产生 deleted 行前必须按父稿是否在 live_drafts 拦住',
  review_cycles: '按 cycle、review、revision 的 id 读，挂在 reviews 与 revisions 之下；db:review-cycle-get 用渲染端给的 review id，随 reviews 一并在 PR3 拦住',
  review_findings: '只按 cycle_id 读，挂在 review_cycles 之下',
  review_cycle_merges: '只按 cycle_id 读，挂在 review_cycles 之下',
})

const CLAUSE_KEYWORDS = new Set(['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'NATURAL', 'ON', 'USING',
  'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'INDEXED', 'NOT'])
const READ_PATTERN = new RegExp(`\\b(FROM|JOIN)(\\s+)(${LIVE_ROW_TABLES.join('|')})\\b`, 'gi')
// 删除目标只能写原表（视图不能写），不算读。只在预处理后的文本上匹配，注释已是空格。
const DELETE_TARGET = /\bDELETE\s+FROM\s+(\w+)/gi

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 每个字符串或模板字面量是一组源码片段（模板按 ${} 切开）。 */
function literalSegments(sourceFile) {
  const literals = []
  const visit = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push([node])
    else if (ts.isTemplateExpression(node)) literals.push([node.head, ...node.templateSpans.map(span => span.literal)])
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return literals
}

/**
 * SQL 词法预处理，一次线性扫过：注释换成等长空格，单引号字符串的内容换成等长空格，引号、分号与其余字符原样。
 * 输入是一个字面量的各段源码原文（含定界符），输出逐段等长，偏移量不变。状态跨 ${} 延续。
 */
export function maskSqlSegments(raws) {
  let state = 'normal'
  return raws.map(raw => {
    const end = raw.endsWith('${') ? raw.length - 2 : raw.length - 1
    let out = ' '
    for (let index = 1; index < end; index++) {
      const char = raw[index], next = raw[index + 1]
      if (state === 'normal') {
        const opener = char === '-' && next === '-' ? 'line' : char === '/' && next === '*' ? 'block' : ''
        if (opener) { state = opener; out += '  '; index++; continue }
        if (char === "'") state = 'string'
        out += char
      } else if (state === 'string') {
        if (char === "'") state = 'normal'
        out += state === 'normal' ? char : ' '
      } else if (state === 'line') {
        // 源码里的 \n 转义同样结束行注释。
        if (char === '\n' || (char === '\\' && next === 'n')) state = 'normal'
        out += char === '\n' ? char : ' '
      } else if (char === '*' && next === '/') {
        state = 'normal'; out += '  '; index++
      } else out += ' '
    }
    return out + ' '.repeat(raw.length - end)
  })
}

// 原句用「表名.列」限定时，视图要以原表名作别名，否则限定会失效。只看同一条语句。
function rewriteFor(table, after, statement) {
  const next = /^\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(after)
  const aliased = next && !CLAUSE_KEYWORDS.has(next[1].toUpperCase())
  const qualified = new RegExp(`\\b${table}\\.`).test(statement)
  return aliased || !qualified ? `live_${table}` : `live_${table} AS ${table}`
}

/**
 * 列出一个源文件里读原表的位置。每个字面量先做词法预处理，再只在正常状态的分号处切成语句，
 * 每条语句（含 CREATE … AS SELECT、INSERT … SELECT）都扫 FROM/JOIN；DELETE FROM 的目标不算读。
 */
export function scanSource(text, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const reads = []
  for (const segments of literalSegments(sourceFile)) {
    const starts = segments.map(segment => segment.getStart(sourceFile))
    const masked = maskSqlSegments(segments.map((segment, index) => text.slice(starts[index], segment.end)))
    const joined = masked.join('')
    let total = 0
    const bases = masked.map(part => (total += part.length) - part.length)
    const sourceOffset = position => {
      const index = bases.findLastIndex(base => base <= position)
      return starts[index] + position - bases[index]
    }
    const deleteTargets = new Set([...joined.matchAll(DELETE_TARGET)].map(match => match.index + match[0].length - match[1].length))
    let statementStart = 0
    for (const statement of joined.split(';')) {
      for (const match of statement.matchAll(READ_PATTERN)) {
        const position = statementStart + match.index + match[1].length + match[2].length
        if (deleteTargets.has(position)) continue
        const offset = sourceOffset(position)
        reads.push({
          line: sourceFile.getLineAndCharacterOfPosition(offset).line + 1,
          table: match[3],
          offset,
          replacement: rewriteFor(match[3], statement.slice(match.index + match[0].length), statement),
        })
      }
      statementStart += statement.length + 1
    }
  }
  return reads
}

export function rewriteSource(text, fileName) {
  let result = text
  for (const read of scanSource(text, fileName).sort((left, right) => right.offset - left.offset)) {
    result = result.slice(0, read.offset) + read.replacement + result.slice(read.offset + read.table.length)
  }
  return result
}

/** electron 下的主进程源码，不含测试与迁移（迁移本身定义视图，必须读原表）。 */
export function listSourceFiles(root = repoRoot) {
  const files = []
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'migrations' && entry.name !== 'node_modules') walk(full)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full)
    }
  }
  walk(path.join(root, 'electron'))
  return files.map(file => path.relative(root, file).split(path.sep).join('/')).sort()
}

/** 白名单外所有读原表的位置。结构测试要求它为空。 */
export function scanLiveRowReads(root = repoRoot) {
  return listSourceFiles(root).filter(file => !(file in RAW_ROW_READERS)).flatMap(file =>
    scanSource(fs.readFileSync(path.join(root, file), 'utf8'), file).map(read => ({ file, line: read.line, table: read.table })))
}

function main() {
  const write = process.argv.includes('--write')
  const reads = scanLiveRowReads()
  for (const read of reads) console.log(`${read.file}:${read.line}\t${read.table}`)
  const files = [...new Set(reads.map(read => read.file))]
  console.log(`${reads.length} 处读原表，${files.length} 个文件${write ? '，已改写' : '（只列不改，加 --write 改写）'}`)
  if (!write) return
  for (const file of files) {
    const full = path.join(repoRoot, file)
    fs.writeFileSync(full, rewriteSource(fs.readFileSync(full, 'utf8'), file))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
