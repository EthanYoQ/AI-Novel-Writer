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
  reviews: '只按 id 或 base_draft_id 定位，draft id 取自 live_drafts 的读取',
  revisions: '只按 id 或 base_draft_id 定位，draft id 取自 live_drafts 的读取',
  review_cycles: '只按 cycle、review、revision 的 id 定位，挂在 reviews 与 revisions 之下',
  review_findings: '只按 cycle_id 定位，挂在 review_cycles 之下',
  review_cycle_merges: '只按 cycle_id 定位，挂在 review_cycles 之下',
})

const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'PRAGMA'])
const CLAUSE_KEYWORDS = new Set(['WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'NATURAL', 'ON', 'USING',
  'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'INDEXED', 'NOT'])
const READ_PATTERN = new RegExp(`\\b(FROM|JOIN)(\\s+)(${LIVE_ROW_TABLES.join('|')})\\b`, 'gi')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function literalSegments(sourceFile) {
  const statements = []
  const visit = node => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      statements.push({ text: node.text, segments: [node] })
    } else if (ts.isTemplateExpression(node)) {
      const segments = [node.head, ...node.templateSpans.map(span => span.literal)]
      statements.push({ text: segments.map(segment => segment.text).join(' '), segments })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return statements
}

function rewriteFor(table, after) {
  const next = /^\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(after)
  const aliased = next && !CLAUSE_KEYWORDS.has(next[1].toUpperCase())
  return aliased ? `live_${table}` : `live_${table} AS ${table}`
}

/** 列出一个源文件里读原表的位置。写语句（INSERT/UPDATE/DELETE 等）整句跳过，它们只能写原表。 */
export function scanSource(text, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const reads = []
  for (const statement of literalSegments(sourceFile)) {
    const keyword = /^[\s(]*([A-Za-z]+)/.exec(statement.text)?.[1]?.toUpperCase()
    if (keyword && WRITE_KEYWORDS.has(keyword)) continue
    for (const segment of statement.segments) {
      const start = segment.getStart(sourceFile), raw = text.slice(start, segment.end)
      for (const match of raw.matchAll(READ_PATTERN)) {
        const tableOffset = start + match.index + match[1].length + match[2].length
        const table = match[3]
        reads.push({
          line: sourceFile.getLineAndCharacterOfPosition(tableOffset).line + 1,
          table,
          offset: tableOffset,
          replacement: rewriteFor(table, raw.slice(match.index + match[0].length)),
        })
      }
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
