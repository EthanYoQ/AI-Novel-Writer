import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { getProjectDatabasePath, openCanonicalProjectData } from '../project-data-locator'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const BODY = '灯塔守夜人的手稿'.repeat(200)

function fixture(version: 6 | 'current' = 'current') {
  const base = path.resolve('.runtime/.cache/perf-536/open')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'project-')); roots.push(root)
  const data = path.join(root, '.ai-novel'); fs.mkdirSync(data)
  fs.writeFileSync(path.join(data, 'project.json'), JSON.stringify(createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: new Date().toISOString() })))
  const file = path.join(data, 'project.db')
  if (version === 'current') createProjectDatabase(root)
  else {
    const db = new Database(file)
    try { initializeLegacyBaselineSchema(db); migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), version) } finally { db.close() }
  }
  const db = new Database(file)
  try {
    const insert = db.prepare('INSERT INTO contents(body) VALUES (?)')
    for (let index = 0; index < 120; index++) insert.run(`${index}:${BODY}`)
    db.exec(`INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count,status,execution_owner,execution_epoch,lease_expires_at)
      VALUES('fixture','fixture','fixture','source','manifest','zh-CN',1,1,'running','old-owner',5,12345)`)
  } finally { db.close() }
  return { root, file }
}

function countOpenWork(file: string) {
  const counts = { integrityCheck: 0, databaseCopies: 0, fullContentReads: 0 }
  const pragma = Database.prototype.pragma
  vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: import('better-sqlite3').Database, source, options) {
    if (/^integrity_check/i.test(source.trim())) counts.integrityCheck++
    return pragma.call(this, source, options)
  })
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: import('better-sqlite3').Database, source: string) {
    if (/^SELECT .+ FROM "contents"$/.test(source.trim())) counts.fullContentReads++
    return prepare.call(this, source)
  } as typeof prepare)
  const copyFileSync = fs.copyFileSync
  vi.spyOn(fs, 'copyFileSync').mockImplementation((source, target, mode) => {
    if (path.resolve(String(source)) === path.resolve(file)) counts.databaseCopies++
    return copyFileSync(source, target, mode)
  })
  return counts
}

function damageContentPage(file: string, table = 'contents') {
  const db = new Database(file, { readonly: true })
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const rootPage = db.prepare('SELECT rootpage FROM sqlite_master WHERE name=?').pluck().get(table) as number
  db.close()
  const fd = fs.openSync(file, 'r+')
  try { fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, (rootPage - 1) * pageSize) } finally { fs.closeSync(fd) }
}

/** Leaves committed rows only in -wal, as a crash before checkpoint would. */
function commitToWalOnly(file: string, rows: number, sql = '') {
  const crashed = `${file}.crashed`
  const db = new Database(file)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    const insert = db.prepare('INSERT INTO contents(body) VALUES (?)')
    for (let index = 0; index < rows; index++) insert.run(`wal-${index}:${BODY}`)
    if (sql) db.exec(sql)
    for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(file + suffix, crashed + suffix)
  } finally { db.close() }
  for (const suffix of ['', '-wal', '-shm']) fs.renameSync(crashed + suffix, file + suffix)
}

/** Runs the change once the read-only verification handle closes, before the writable handle opens. */
function afterVerification(file: string, change: () => void): () => boolean {
  const close = Database.prototype.close
  let ran = false
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: import('better-sqlite3').Database) {
    const result = close.call(this)
    if (!ran && this.readonly && path.resolve(this.name) === path.resolve(file)) { ran = true; change() }
    return result
  })
  return () => ran
}

afterEach(() => {
  vi.restoreAllMocks(); closeProjectDatabase()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('project open verification', () => {
  it('checks integrity once, copies the database once and skips content fingerprints when the schema is current', () => {
    const f = fixture()
    const counts = countOpenWork(f.file)
    initProjectDatabase(f.root)
    vi.restoreAllMocks()
    expect(counts).toEqual({ integrityCheck: 1, databaseCopies: 1, fullContentReads: 0 })
    expect(getProjectDb()!.prepare('SELECT execution_owner,execution_epoch FROM import_runs').get()).toEqual({ execution_owner: '', execution_epoch: 6 })
  })

  it('still fingerprints author content when the open migrates an older schema', () => {
    const f = fixture(6)
    const counts = countOpenWork(f.file)
    initProjectDatabase(f.root)
    vi.restoreAllMocks()
    expect(counts.fullContentReads).toBeGreaterThan(0)
    expect(getProjectDb()!.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM contents WHERE body LIKE ?').pluck().get(`%${BODY}`)).toBe(120)
  })

  it('refuses a page damaged after the migration commits and before the writable handle opens', () => {
    const f = fixture(6)
    const close = Database.prototype.close
    let damaged = false
    vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: import('better-sqlite3').Database) {
      const result = close.call(this)
      if (!damaged && !this.readonly && path.resolve(this.name) === path.resolve(f.file)) { damaged = true; damageContentPage(f.file) }
      return result
    })
    expect(() => initProjectDatabase(f.root)).toThrow('CORRUPT_SCHEMA')
    expect(damaged).toBe(true)
    expect(getProjectDb()).toBeNull()
    vi.restoreAllMocks()
    const db = new Database(f.file, { readonly: true })
    try { expect(db.prepare('SELECT execution_epoch FROM import_runs').pluck().get()).toBe(5) } finally { db.close() }
  })

  it('refuses the writable handle when the schema changes after verification passed', () => {
    const f = fixture()
    const changed = afterVerification(f.file, () => {
      const db = new Database(f.file)
      try { db.exec('ALTER TABLE contents ADD COLUMN changed_after_probe TEXT') } finally { db.close() }
    })
    expect(() => initProjectDatabase(f.root)).toThrow('SOURCE_CHANGED_SINCE_PROBE')
    expect(changed()).toBe(true)
    expect(getProjectDb()).toBeNull()
  })

  it.each([['current'], [6]] as const)('opens a %s-schema project whose committed rows are still only in the WAL', version => {
    const f = fixture(version)
    commitToWalOnly(f.file, 30)
    expect(fs.statSync(`${f.file}-wal`).size).toBeGreaterThan(0)
    initProjectDatabase(f.root)
    expect(getProjectDb()!.prepare('SELECT count(*) FROM contents WHERE body LIKE ?').pluck().get(`%${BODY}`)).toBe(150)
    expect(getProjectDb()!.prepare("SELECT count(*) FROM contents WHERE body LIKE 'wal-%'").pluck().get()).toBe(30)
  })

  it('refuses the writable handle when only the WAL changes after verification passed', () => {
    const f = fixture()
    commitToWalOnly(f.file, 5)
    const mainBytes = fs.readFileSync(f.file)
    const changed = afterVerification(f.file, () => commitToWalOnly(f.file, 1))
    expect(() => initProjectDatabase(f.root)).toThrow('SOURCE_CHANGED_SINCE_PROBE')
    expect(changed()).toBe(true)
    expect(getProjectDb()).toBeNull()
    expect(fs.readFileSync(f.file)).toEqual(mainBytes)
  })

  it('refuses a damaged WAL frame that another open connection still indexes', () => {
    const f = fixture()
    const holder = new Database(f.file)
    try {
      holder.pragma('journal_mode = WAL')
      holder.pragma('wal_autocheckpoint = 0')
      const insert = holder.prepare('INSERT INTO contents(body) VALUES (?)')
      for (let index = 0; index < 30; index++) insert.run(`wal-${index}:${BODY}`)
      const pageSize = holder.pragma('page_size', { simple: true }) as number
      const wal = fs.readFileSync(`${f.file}-wal`)
      const frames = (wal.length - 32) / (24 + pageSize)
      let frame = frames - 1
      while (wal.readUInt32BE(32 + frame * (24 + pageSize)) === 1) frame--
      const fd = fs.openSync(`${f.file}-wal`, 'r+')
      try { fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, 32 + frame * (24 + pageSize) + 24) } finally { fs.closeSync(fd) }
      let thrown: unknown
      try { initProjectDatabase(f.root) } catch (error) { thrown = error }
      expect(getProjectDb()).toBeNull()
      expect({ name: (thrown as Error).name, code: (thrown as { code?: string }).code, message: (thrown as Error).message })
        .toEqual({ name: 'SchemaMigrationError', code: 'CORRUPT_SCHEMA', message: 'CORRUPT_SCHEMA' })
    } finally { holder.close() }
  })

  it('refuses the writable handle when a page is damaged after verification passed', () => {
    const f = fixture()
    const damaged = afterVerification(f.file, () => damageContentPage(f.file))
    expect(() => initProjectDatabase(f.root)).toThrow('SOURCE_CHANGED_SINCE_PROBE')
    expect(damaged()).toBe(true)
    expect(getProjectDb()).toBeNull()
    const db = new Database(f.file, { readonly: true })
    try { expect(db.prepare('SELECT execution_epoch FROM import_runs').pluck().get()).toBe(5) } finally { db.close() }
  })

  const corruptions: [string, (file: string) => void, { name: string; code: string; message: string }][] = [
    ['a truncated file', file => fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2)),
      { name: 'SqliteError', code: 'SQLITE_CORRUPT', message: 'database disk image is malformed' }],
    ['a damaged content page', damageContentPage, { name: 'SchemaMigrationError', code: 'CORRUPT_SCHEMA', message: 'CORRUPT_SCHEMA' }],
    ['a damaged header', file => {
      const fd = fs.openSync(file, 'r+')
      try { fs.writeSync(fd, Buffer.alloc(100, 0x41), 0, 100, 0) } finally { fs.closeSync(fd) }
    }, { name: 'SqliteError', code: 'SQLITE_NOTADB', message: 'file is not a database' }],
  ]
  it('does not admit a project locator whose current schema fails verification', () => {
    const f = fixture()
    damageContentPage(f.file)
    expect(() => openCanonicalProjectData(f.root)).toThrow('CORRUPT_SCHEMA')
    expect(() => getProjectDatabasePath(f.root)).toThrow('PROJECT_DATA_NOT_READY')
  })

  const walFailures: [string, (file: string) => void, string][] = [
    ['a damaged page', file => { commitToWalOnly(file, 5); damageContentPage(file, 'import_runs') }, 'CORRUPT_SCHEMA'],
    ['an unknown table', file => commitToWalOnly(file, 5, 'CREATE TABLE stray(x)'), 'UNRECOGNIZED_SCHEMA'],
  ]
  it.each(walFailures)('keeps the database and WAL bytes when a project with an uncheckpointed WAL and %s is refused', (_name, corrupt, code) => {
    const f = fixture()
    corrupt(f.file)
    const main = fs.readFileSync(f.file), wal = fs.readFileSync(`${f.file}-wal`)
    expect(wal.length).toBeGreaterThan(0)
    expect(() => initProjectDatabase(f.root)).toThrow(code)
    expect(getProjectDb()).toBeNull()
    expect(fs.readFileSync(f.file)).toEqual(main)
    expect(fs.readFileSync(`${f.file}-wal`)).toEqual(wal)
  })

  it.each(corruptions)('refuses %s before a writable connection opens', (_name, corrupt, expected) => {
    const f = fixture()
    corrupt(f.file)
    const bytes = fs.readFileSync(f.file)
    let thrown: unknown
    try { initProjectDatabase(f.root) } catch (error) { thrown = error }
    expect({ name: (thrown as Error).name, code: (thrown as { code?: string }).code, message: (thrown as Error).message }).toEqual(expected)
    expect(getProjectDb()).toBeNull()
    expect(fs.readFileSync(f.file)).toEqual(bytes)
  })
})
