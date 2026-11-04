import fs from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  LIVE_ROW_EXEMPT_TABLES, LIVE_ROW_TABLES, RAW_ROW_READERS, rewriteSource, scanLiveRowReads, scanSource,
} from '../../scripts/live-row-reads.mjs'
import { initializeLegacyBaselineSchema } from '../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../migrations/desktop-registry'
import { LIVE_ROW_VIEWS } from '../migrations/m07-chapter-recycle'
import { migrateSchema } from '../migrations/runner'
import { SqliteSchemaAdapter } from '../migrations/sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

// generation-source-binding.ts 在 codemod 前的两处原文：draft-target 不按状态过滤，续写目录的 newer 子查询读原表。
const DRAFT_TARGET = "deps.db.prepare('SELECT d.id,d.version,d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC,d.id DESC LIMIT 1')"
const CATALOG = 'deps.db.prepare(`SELECT d.id FROM drafts d LEFT JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.chapter_number < ? AND (d.status=\'finalized\' OR NOT EXISTS (SELECT 1 FROM drafts newer WHERE newer.chapter_number=d.chapter_number AND newer.status IN (${CURRENT}) AND newer.version>d.version)) ORDER BY d.id`)'

describe('live-row-reads：读取路径只读 live_ 视图', () => {
  it('白名单外没有读原表的地方', () => {
    expect(scanLiveRowReads().map(read => `${read.file}:${read.line} ${read.table}`)).toEqual([])
  })

  it('故意违规样本会被抓到，注释、删除目标与 live_ 视图不算；写语句里的读子查询照抓', () => {
    const sample = [
      `const target = ${DRAFT_TARGET}`,
      `const catalog = ${CATALOG}`,
      "const summaries = db.prepare('SELECT * FROM summary_snapshots WHERE chapter_number < ?')",
      "const guard = db.prepare('SELECT drafts.id FROM drafts JOIN contents ON contents.id = drafts.content_id')",
      '// SELECT * FROM drafts 只是注释',
      "db.prepare('DELETE FROM drafts WHERE id = ?')",
      "db.prepare(`UPDATE drafts SET status = 'superseded' WHERE id IN (SELECT id FROM drafts)`)",
      "db.prepare('SELECT * FROM live_drafts d JOIN live_finalization_outbox o ON o.draft_id = d.id')",
      "const label = 'drafts'",
      "db.prepare('INSERT INTO reviews (base_draft_id) SELECT id FROM summary_snapshots')",
      "db.prepare('WITH doomed AS (SELECT id FROM drafts) DELETE FROM drafts WHERE id IN doomed')",
      "db.exec('SELECT 1; DELETE FROM finalization_outbox')",
      "db.exec('CREATE TEMP TABLE picked(id); INSERT INTO picked SELECT id FROM drafts')",
      "db.exec('CREATE TEMP VIEW recent AS SELECT * FROM drafts; SELECT 1')",
      "db.prepare('DELETE /* cleanup */ FROM drafts WHERE id = ?')",
    ].join('\n')
    expect(scanSource(sample).map(read => `${read.line}:${read.table}`))
      .toEqual(['1:drafts', '2:drafts', '2:finalization_outbox', '2:drafts', '3:summary_snapshots', '4:drafts',
        '7:drafts', '10:summary_snapshots', '11:drafts', '13:drafts'])

    const rewritten = rewriteSource(sample)
    expect(rewritten).toContain('FROM live_drafts d JOIN contents')
    expect(rewritten).toContain('FROM live_drafts newer WHERE')
    expect(rewritten).toContain('LEFT JOIN live_finalization_outbox o ON')
    expect(rewritten).toContain('FROM live_summary_snapshots WHERE')
    expect(rewritten).toContain('FROM live_drafts AS drafts JOIN contents')
    expect(rewritten).toContain("'DELETE FROM drafts WHERE id = ?'")
    expect(rewritten).toContain('WHERE id IN (SELECT id FROM live_drafts)')
    expect(rewritten).toContain("'WITH doomed AS (SELECT id FROM live_drafts) DELETE FROM drafts WHERE id IN doomed'")
    expect(rewritten).toContain("'SELECT 1; DELETE FROM finalization_outbox'")
    expect(rewritten).toContain('INSERT INTO picked SELECT id FROM live_drafts')
    expect(rewritten).toContain("'DELETE /* cleanup */ FROM drafts WHERE id = ?'")
    expect(scanSource(rewritten)).toEqual([])
    expect(rewriteSource(rewritten)).toBe(rewritten)
  })

  it('白名单每条都有理由，而且文件里确实还读原表', () => {
    for (const [file, reason] of Object.entries(RAW_ROW_READERS)) {
      expect(reason.trim(), file).not.toBe('')
      expect(scanSource(fs.readFileSync(file, 'utf8'), file).length, file).toBeGreaterThan(0)
    }
  })

  it('外键挂在 drafts 或 contents 上的表，要么有 live_ 视图，要么写明豁免理由（G6）', () => {
    const db = new Database(':memory:')
    try {
      db.transaction(() => initializeLegacyBaselineSchema(db))()
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all() as string[]
      const parents = new Map(tables.map(table => [table, (db.prepare('SELECT "table" FROM pragma_foreign_key_list(?)')
        .pluck().all(table) as string[])]))
      const managed = new Set(['drafts', 'contents'])
      for (let grew = true; grew;) {
        grew = false
        for (const [table, refs] of parents) {
          if (!managed.has(table) && refs.some(ref => managed.has(ref))) { managed.add(table); grew = true }
        }
      }
      expect(LIVE_ROW_VIEWS.map(item => item.table)).toEqual([...LIVE_ROW_TABLES])
      expect([...managed].sort()).toEqual([...LIVE_ROW_TABLES, ...Object.keys(LIVE_ROW_EXEMPT_TABLES)].sort())
      for (const [table, reason] of Object.entries(LIVE_ROW_EXEMPT_TABLES)) expect(reason.trim(), table).not.toBe('')
    } finally { db.close() }
  })
})
