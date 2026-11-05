import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { LIVE_ROW_VIEWS } from '../m07-chapter-recycle'
import { createMigrationRegistry, type MigrationImplementation } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
type Db = import('better-sqlite3').Database

function finalize(db: Db, chapter: number, body: string): number {
  const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid)
  const draftId = Number(db.prepare("INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(?,1,'finalized',?)")
    .run(chapter, contentId).lastInsertRowid)
  db.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,content_hash,content_revision,content_snapshot,target_file_name)
    VALUES(?,?,?,?,1,?,?)`).run(`final-${chapter}`, draftId, chapter, 'h'.repeat(64), body, `第${chapter}章.txt`)
  db.prepare('INSERT INTO summary_snapshots(draft_id,chapter_number,chapter_notes) VALUES(?,?,?)').run(draftId, chapter, `第${chapter}章要点`)
  return draftId
}

/** v7 作品：第 1、3 章已定稿，第 2 章已被旧版硬删（只剩删除收据）。 */
function v7WithHardDeletedMiddleChapter(): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7)
  finalize(db, 1, '第一章正文')
  const deleted = finalize(db, 2, '第二章正文')
  finalize(db, 3, '第三章正文')
  db.prepare(`INSERT INTO chapter_deletion_operations(operation_id,draft_id,chapter_number,finalization_id,status)
    VALUES('delete-2',?,2,'final-2','completed')`).run(deleted)
  db.prepare('DELETE FROM drafts WHERE id=?').run(deleted)
  return db
}

const rows = (db: Db, sql: string) => db.prepare(sql).all()
const objectType = (db: Db, name: string) => db.prepare('SELECT type FROM sqlite_master WHERE name=?').pluck().get(name)
const managedTables = new Set<string>(LIVE_ROW_VIEWS.map(item => item.table))
const managedViews = new Set<string>(LIVE_ROW_VIEWS.map(item => item.view))

/** 每张表的外键目标与每个触发器挂的表；表名、视图、外键、触发器四者合起来就是 M07 改名后的形态。 */
function managedShape(db: Db) {
  const objects = rows(db, "SELECT type,name,tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
  const foreignKeys = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck().all() as string[]).flatMap(table => (db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ table: string; from: string }>)
    .map(key => `${table}.${key.from}->${key.table}`)).sort()
  return { objects, foreignKeys }
}

describe('installed M07 lane', () => {
  it('migrates a v7 project with a hard-deleted middle chapter to the recognized v8 schema without changing data', () => {
    const db = v7WithHardDeletedMiddleChapter()
    try {
      const before = {
        drafts: rows(db, 'SELECT id,chapter_number,version,status,content_id FROM drafts ORDER BY id'),
        outbox: rows(db, 'SELECT * FROM finalization_outbox ORDER BY finalization_id'),
        receipts: rows(db, 'SELECT * FROM chapter_deletion_operations'),
      }
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(8)
      expect(result.completedSteps).toEqual(['M07'])
      const v8 = getDesktopMigrationRegistry().recognizedSchemas.filter(schema => schema.version === 8).map(schema => schema.fingerprint)
      expect(v8).toContain(sqliteSchemaFingerprint(db))
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).version).toBe(8)
      expect(rows(db, 'SELECT id,chapter_number,version,status,content_id FROM drafts ORDER BY id')).toEqual(before.drafts)
      expect(rows(db, 'SELECT * FROM finalization_outbox ORDER BY finalization_id')).toEqual(before.outbox)
      expect(rows(db, 'SELECT * FROM chapter_deletion_operations')).toEqual(before.receipts)
      expect(rows(db, "SELECT 1 FROM drafts_all WHERE deletion_id<>'' OR deleted_from_status<>'' OR deleted_at<>''")).toEqual([])
      for (const { table, view } of LIVE_ROW_VIEWS) {
        expect(objectType(db, table), table).toBe('table')
        expect(objectType(db, view), view).toBe('view')
        expect(rows(db, `SELECT * FROM ${view} ORDER BY 1`), view).toEqual(rows(db, `SELECT * FROM ${table} ORDER BY 1`))
      }
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8).completedSteps).toEqual([])
    } finally { db.close() }
  })

  const sabotages: Array<[string, (step: MigrationImplementation) => MigrationImplementation, string]> = [
    ['verification fails', step => ({ ...step, verify: () => false }), 'MIGRATION_VERIFICATION_FAILED'],
    ['migration throws after its DDL ran', step => ({ ...step,
      migrate: db => { step.migrate(db); throw new Error('M07_INJECTED_FAILURE') } }), 'M07_INJECTED_FAILURE'],
  ]
  it.each(sabotages)('rolls back v7 schema and data when %s', (_label, sabotage, error) => {
    const db = v7WithHardDeletedMiddleChapter()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const broken = createMigrationRegistry(registry.implementations.map(step => step.id === 'M07' ? sabotage(step) : step),
        registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), broken, 8)).toThrow(error)
      expect(db.pragma('user_version', { simple: true })).toBe(7)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
      for (const { table, view } of LIVE_ROW_VIEWS) {
        expect(objectType(db, view), view).toBe('table')
        expect(objectType(db, table), table).toBeUndefined()
      }
      expect(rows(db, 'SELECT chapter_number FROM drafts ORDER BY chapter_number')).toEqual([{ chapter_number: 1 }, { chapter_number: 3 }])
    } finally { db.close() }
  })
})

describe('M07 deletion columns and live views', () => {
  function v8(): Db {
    const db = v7WithHardDeletedMiddleChapter()
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
    return db
  }

  it('points every foreign key, trigger and index that named a managed table at its renamed _all table', () => {
    const db = v8()
    try {
      const { objects, foreignKeys } = managedShape(db)
      const references = foreignKeys.filter(key => managedTables.has(key.split('->')[1]!))
      expect(references.length).toBeGreaterThan(0)
      expect(foreignKeys.filter(key => managedViews.has(key.split('->')[1]!))).toEqual([])
      expect(foreignKeys).toContain('finalization_outbox_all.draft_id->drafts_all')
      expect(foreignKeys).toContain('summary_snapshots_all.draft_id->drafts_all')
      expect(foreignKeys).toContain('narrative_thread_confirmations_all.draft_id->drafts_all')
      const attached = (objects as Array<{ type: string; name: string; tbl_name: string }>)
        .filter(item => item.type === 'trigger' || item.type === 'index')
      expect(attached.filter(item => managedViews.has(item.tbl_name))).toEqual([])
      expect(attached.filter(item => item.tbl_name === 'drafts_all').map(item => item.name)).toEqual(expect.arrayContaining([
        'drafts_deletion_shape_insert', 'drafts_deletion_shape_update', 'idx_drafts_deletion', 'idx_drafts_chapter']))
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','trigger') AND sql IS NOT NULL").pluck().all() as string[]
      expect(ddl.filter(sql => /REFERENCES\s+"?(drafts|finalization_outbox|summary_snapshots|narrative_thread_confirmations)"?\s*\(/i.test(sql))).toEqual([])
      expect(db.prepare("SELECT name FROM sqlite_sequence WHERE name='drafts_all'").pluck().get()).toBe('drafts_all')
    } finally { db.close() }
  })

  it('gives a new project the same tables, views, foreign keys and triggers as an upgraded v7 project', () => {
    const upgraded = v8(), created = new Database(':memory:')
    try {
      created.pragma('foreign_keys=ON')
      created.transaction(() => initializeLegacyBaselineSchema(created))()
      migrateSchema(new SqliteSchemaAdapter(created), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(managedShape(created)).toEqual(managedShape(upgraded))
      expect(sqliteSchemaFingerprint(created)).toBe(sqliteSchemaFingerprint(upgraded))
    } finally { upgraded.close(); created.close() }
  })

  it('rejects writes through a live view', () => {
    const db = v8()
    try {
      for (const { view } of LIVE_ROW_VIEWS) {
        expect(() => db.prepare(`DELETE FROM ${view}`).run(), view).toThrow(/cannot modify .* because it is a view/)
      }
    } finally { db.close() }
  })

  it('rejects a deleted row without its deletion facts and live rows carrying them', () => {
    const db = v8()
    try {
      const id = db.prepare('SELECT id FROM drafts WHERE chapter_number=1').pluck().get()
      for (const patch of [
        "status='deleted'",
        "status='deleted', deletion_id='op', deleted_from_status='draft', deleted_at='2026-11-05'",
        "status='deleted', deletion_id='op', deleted_from_status='finalized', deleted_at=''",
        "deletion_id='op'",
      ]) expect(() => db.prepare(`UPDATE drafts_all SET ${patch} WHERE id=?`).run(id), patch).toThrow('DRAFT_DELETION_SHAPE_INVALID')
      expect(() => db.prepare("INSERT INTO drafts_all(chapter_number,version,status,content_id) VALUES(9,1,'deleted',1)").run())
        .toThrow('DRAFT_DELETION_SHAPE_INVALID')
      db.prepare(`UPDATE drafts_all SET status='deleted', deletion_id='op', deleted_from_status='finalized', deleted_at='2026-11-05'
        WHERE id=?`).run(id)
      expect(db.prepare('SELECT status FROM drafts_all WHERE id=?').pluck().get(id)).toBe('deleted')
    } finally { db.close() }
  })

  it('hides only deleted rows and keeps rows with a null status or a missing draft', () => {
    const db = v8()
    try {
      db.pragma('foreign_keys=OFF')
      const nullStatus = Number(db.prepare('INSERT INTO drafts_all(chapter_number,version,status,content_id) VALUES(4,1,NULL,1)').run().lastInsertRowid)
      db.prepare('INSERT INTO summary_snapshots_all(draft_id,chapter_number) VALUES(9999,9)').run()
      db.prepare('INSERT INTO summary_snapshots_all(draft_id,chapter_number) VALUES(NULL,8)').run()
      const deleted = db.prepare('SELECT id FROM drafts WHERE chapter_number=3').pluck().get()
      db.prepare(`UPDATE drafts_all SET status='deleted', deletion_id='op', deleted_from_status='finalized', deleted_at='2026-11-05'
        WHERE id=?`).run(deleted)
      expect(db.prepare('SELECT id FROM drafts ORDER BY id').pluck().all())
        .toEqual(db.prepare('SELECT id FROM drafts_all WHERE id<>? ORDER BY id').pluck().all(deleted))
      expect(db.prepare('SELECT 1 FROM drafts WHERE id=?').get(nullStatus)).toBeTruthy()
      expect(db.prepare('SELECT chapter_number FROM finalization_outbox ORDER BY chapter_number').pluck().all()).toEqual([1])
      expect(db.prepare('SELECT chapter_number FROM summary_snapshots ORDER BY chapter_number').pluck().all()).toEqual([1, 8, 9])
    } finally { db.close() }
  })

  it('keeps SELECT * views working after a later migration adds a drafts column', () => {
    const db = v8()
    try {
      db.exec("ALTER TABLE drafts_all ADD COLUMN future_column TEXT NOT NULL DEFAULT 'later'")
      expect(db.prepare('SELECT future_column FROM drafts WHERE chapter_number=1').pluck().get()).toBe('later')
      db.exec("ALTER TABLE finalization_outbox_all ADD COLUMN future_outbox TEXT NOT NULL DEFAULT 'x'")
      expect(db.prepare('SELECT future_outbox FROM finalization_outbox WHERE chapter_number=1').pluck().get()).toBe('x')
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally { db.close() }
  })
})

// G6：经外键挂在草稿上的表，要么本身改名为 _all 并在原名上有 live 视图，要么写明为什么暂不需要。
const LIVE_VIEW_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  contents: '只按 id 读，id 取自 drafts、reviews、revisions 的行；本身没有章号与状态',
  reviews: '按 id 或 base_draft_id 读；ReviewRepository 的读取都带 LIVE_PARENT（父稿在 drafts 视图里），回收站章节的审稿读不出。用例见 chapter-trash-parent-alive.test.ts',
  revisions: '按 id 或 base_draft_id 读；RevisionRepository 的读取和改状态都带 LIVE_PARENT，回收站章节的修稿读不出、改不了。用例见 chapter-trash-parent-alive.test.ts',
  review_cycles: '按 cycle、review、revision 的 id 读，挂在 reviews 与 revisions 之下；getByReviewId 只认父稿还在的审稿',
  review_findings: '只按 cycle_id 读，挂在 review_cycles 之下',
  review_cycle_merges: '只按 cycle_id 读，挂在 review_cycles 之下',
}

/** 从 drafts_all 与 contents 沿外键反向闭包出的表里，既没有 live 视图也没有豁免理由的。 */
function uncoveredDraftDependents(db: Db): string[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[]
  const parents = new Map(tables.map(table => [table, db.prepare('SELECT "table" FROM pragma_foreign_key_list(?)').pluck().all(table) as string[]]))
  const attached = new Set(['drafts_all', 'contents'])
  for (let grew = true; grew;) {
    grew = false
    for (const [table, refs] of parents) {
      if (!attached.has(table) && refs.some(ref => attached.has(ref))) { attached.add(table); grew = true }
    }
  }
  const views = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='view'").pluck().all() as string[])
  const hasLiveView = (table: string) => LIVE_ROW_VIEWS.some(item => item.table === table && views.has(item.view))
  return [...attached].filter(table => !hasLiveView(table) && !LIVE_VIEW_EXEMPT_TABLES[table]?.trim()).sort()
}

describe('tables that hang off drafts (G6)', () => {
  function current(): Db {
    const db = new Database(':memory:')
    db.transaction(() => initializeLegacyBaselineSchema(db))()
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
    return db
  }

  it('gives every table reached by foreign keys from drafts_all or contents a live view or a written exemption', () => {
    const db = current()
    try {
      expect(uncoveredDraftDependents(db)).toEqual([])
      const exempt = Object.keys(LIVE_VIEW_EXEMPT_TABLES)
      expect(exempt.filter(table => objectType(db, table) !== 'table')).toEqual([])
    } finally { db.close() }
  })

  it('flags a new table that references drafts_all without a view or an exemption', () => {
    const db = current()
    try {
      db.exec('CREATE TABLE chapter_annotations (id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts_all(id))')
      db.exec('CREATE TABLE annotation_replies (id INTEGER PRIMARY KEY, annotation_id INTEGER REFERENCES chapter_annotations(id))')
      expect(uncoveredDraftDependents(db)).toEqual(['annotation_replies', 'chapter_annotations'])
    } finally { db.close() }
  })
})
