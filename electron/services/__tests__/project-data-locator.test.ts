import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { getProjectDataRoot } from '../project-data-locator'
import { probeProjectSqlite } from '../sqlite-project-migration'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
function fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s04-locator')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'project-')); roots.push(root)
  const data = path.join(root, '.ai-novel'); fs.mkdirSync(data)
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: new Date().toISOString() })
  fs.writeFileSync(path.join(data, 'project.json'), JSON.stringify(manifest))
  return { root, data, file: path.join(data, 'project.db'), manifest }
}
afterEach(() => { closeProjectDatabase(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
describe('canonical project activation', () => {
  it('requires explicit new-project creation and revokes the locator on close', () => {
    const f = fixture()
    expect(() => initProjectDatabase(f.root)).toThrow()
    expect(fs.existsSync(f.file)).toBe(false)
    expect(() => getProjectDataRoot(f.root)).toThrow('PROJECT_DATA_NOT_READY')
    createProjectDatabase(f.root); initProjectDatabase(f.root)
    expect(getProjectDataRoot(f.root)).toBe(f.data)
    closeProjectDatabase()
    expect(() => getProjectDataRoot(f.root)).toThrow('PROJECT_DATA_NOT_READY')
    expect(fs.existsSync(path.join(f.root, '.vela'))).toBe(false)
  })
  it('does not rerun data backfill on same-schema reopen and fences only after verification', () => {
    const f = fixture(); createProjectDatabase(f.root); initProjectDatabase(f.root)
    const db = getProjectDb()!
    db.prepare('INSERT INTO contents(body) VALUES (?)').run('合成正文')
    db.exec(`INSERT INTO drafts(chapter_number,version,content_id,word_count) VALUES(1,1,1,777);
      INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count,status,execution_owner,execution_epoch,lease_expires_at)
      VALUES('fixture','fixture','fixture','source','manifest','zh-CN',1,1,'running','old-owner',5,12345)`)
    closeProjectDatabase()
    const before = probeProjectSqlite({ databasePath: f.file })
    expect(before.schemaVersion).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    initProjectDatabase(f.root)
    expect(getProjectDb()!.prepare('SELECT word_count FROM drafts').pluck().get()).toBe(777)
    expect(getProjectDb()!.prepare('SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs').get()).toEqual({ execution_owner: '', execution_epoch: 6, lease_expires_at: 0 })
    closeProjectDatabase(); initProjectDatabase(f.root)
    expect(getProjectDb()!.prepare('SELECT execution_epoch FROM import_runs').pluck().get()).toBe(6)
  })
  it('rejects an unknown schema before a writable connection can fence source sessions', () => {
    const f = fixture(); createProjectDatabase(f.root)
    const db = new Database(f.file); db.exec('ALTER TABLE contents ADD COLUMN unknown_fork TEXT'); db.close()
    const before = fs.readFileSync(f.file)
    expect(() => initProjectDatabase(f.root)).toThrow('UNRECOGNIZED_SCHEMA')
    expect(fs.readFileSync(f.file)).toEqual(before)
    expect(getProjectDb()).toBeNull()
  })
  it('rejects dual roots and revoked manifest identity without writing the legacy source', () => {
    const f = fixture(); createProjectDatabase(f.root); initProjectDatabase(f.root)
    fs.writeFileSync(path.join(f.data, 'project.json'), JSON.stringify({ ...f.manifest, projectId: randomUUID() }))
    expect(() => getProjectDataRoot(f.root)).toThrow('PROJECT_MANIFEST_CHANGED')
    fs.mkdirSync(path.join(f.root, '.vela'))
    expect(() => initProjectDatabase(f.root)).toThrow('PROJECT_MIGRATION_REQUIRED')
    expect(fs.readdirSync(path.join(f.root, '.vela'))).toEqual([])
  })
})
