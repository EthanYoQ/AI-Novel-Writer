import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { applyM02CharacterIdentity, verifyM02CharacterIdentity } from '../m02-character-identity'
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
function fixture() { const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.transaction(() => initializeLegacyBaselineSchema(db))(); return db }
describe('M02 stable identity migration', () => {
  it('preserves every old column including provenance, timestamps and raw relationship strings', () => {
    const db = fixture()
    try {
      db.prepare('INSERT INTO characters(name,relationships,cs_provenance,notes) VALUES(?,?,?,?)').run('林', '[{"target":"周","relation":"旧同伴"}]', '{"location":{"kind":"legacy"}}', '原文\r\n')
      db.prepare('INSERT INTO characters(name,relationships) VALUES(?,?)').run('周', '队长可能是林，也可能另有其人。')
      const old = db.prepare('SELECT * FROM characters ORDER BY rowid').all() as Record<string, unknown>[]
      db.transaction(() => applyM02CharacterIdentity(db))()
      expect(verifyM02CharacterIdentity(db)).toBe(true)
      const rows = db.prepare('SELECT * FROM characters ORDER BY rowid').all() as Record<string, unknown>[]
      expect(rows).toHaveLength(old.length)
      rows.forEach((row, i) => { for (const [key, value] of Object.entries(old[i])) expect(row[key]).toEqual(value) })
      expect(new Set(rows.map(row => row.character_id)).size).toBe(2)
      expect(db.prepare('SELECT resolved_character_id FROM character_identity_proposals').all()).toEqual([{ resolved_character_id: null }, { resolved_character_id: null }])
      db.prepare('UPDATE characters SET name=?').run('同名')
      expect(db.prepare('SELECT COUNT(*) AS n FROM characters WHERE name=?').get('同名')).toEqual({ n: 2 })
      expect(verifyM02CharacterIdentity(db)).toBe(true)
    } finally { db.close() }
  })
  it('rolls back both identity assignment and DDL on interruption and refuses rerun', () => {
    const db = fixture()
    try {
      db.exec("INSERT INTO characters(name) VALUES('甲')")
      expect(() => db.transaction(() => { applyM02CharacterIdentity(db); throw new Error('interrupted') })()).toThrow('interrupted')
      expect(db.prepare('SELECT name FROM characters').all()).toEqual([{ name: '甲' }])
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='character_identity_origins'").get()).toBeUndefined()
      db.transaction(() => applyM02CharacterIdentity(db))()
      const id = db.prepare('SELECT character_id FROM characters').pluck().get()
      expect(() => db.transaction(() => applyM02CharacterIdentity(db))()).toThrow('CHARACTER_MIGRATION_SCHEMA_UNRECOGNIZED')
      expect(db.prepare('SELECT character_id FROM characters').pluck().get()).toBe(id)
    } finally { db.close() }
  })
  it('requires the central transaction and detects damaged immutable origin evidence', () => {
    const db = fixture()
    try {
      expect(() => applyM02CharacterIdentity(db)).toThrow('CHARACTER_MIGRATION_TRANSACTION_REQUIRED')
      db.exec("INSERT INTO characters(name) VALUES('甲')")
      db.transaction(() => applyM02CharacterIdentity(db))()
      db.exec("UPDATE character_identity_origins SET original_row_json='{}'")
      expect(verifyM02CharacterIdentity(db)).toBe(false)
    } finally { db.close() }
  })
})

it('preserves blueprint name-only references as proposals without rewriting authored JSON or merging case variants', () => {
  const db = fixture()
  try {
    db.exec("INSERT INTO characters(name) VALUES('Lin'),('lin')")
    const raw = '[ "Lin", "陌生人", "队长" ]'
    db.prepare('INSERT INTO blueprints(chapter_number,characters) VALUES(1,?)').run(raw)
    db.transaction(() => applyM02CharacterIdentity(db))()
    expect(db.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(2)
    expect(db.prepare('SELECT characters FROM blueprints').pluck().get()).toBe(raw)
    const proposals = db.prepare('SELECT * FROM character_identity_proposals').all() as { resolved_character_id: string | null; source_hash: string; raw_value: string }[]
    expect(proposals).toHaveLength(3)
    expect(proposals.every(proposal => proposal.resolved_character_id === null && /^[a-f0-9]{64}$/u.test(proposal.source_hash))).toBe(true)
    expect(proposals.map(proposal => proposal.raw_value)).toEqual(['Lin', '陌生人', '队长'])
    expect(verifyM02CharacterIdentity(db)).toBe(true)
    db.exec('DELETE FROM character_identity_origins')
    expect(verifyM02CharacterIdentity(db)).toBe(false)
  } finally { db.close() }
})


it('keeps assigned IDs and immutable source evidence across a real file reopen', () => {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s08-migration')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'fixture-')), file = path.join(root, 'project.db')
  let db = new Database(file)
  try {
    db.pragma('foreign_keys=ON')
    db.transaction(() => { initializeLegacyBaselineSchema(db); db.exec("INSERT INTO characters(name,notes) VALUES('作者角色','原字节\r\n')"); applyM02CharacterIdentity(db); db.pragma('user_version=3') })()
    const original = db.prepare('SELECT character_id,notes FROM characters').get()
    db.close(); db = new Database(file); db.pragma('foreign_keys=ON')
    expect(verifyM02CharacterIdentity(db)).toBe(true)
    expect(db.prepare('SELECT character_id,notes FROM characters').get()).toEqual(original)
    expect(db.pragma('user_version', { simple: true })).toBe(3)
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

it.each([
  "UPDATE character_aliases SET name=''", "UPDATE character_aliases SET source_key=' '",
  'UPDATE character_aliases SET valid_from=0.5', 'UPDATE character_aliases SET valid_from=1e999',
  'UPDATE character_aliases SET valid_through=0.5', 'UPDATE characters SET identity_revision=-1',
  'UPDATE characters SET identity_revision=0.5',
])('rejects malformed persisted identity evidence: %s', sql => {
  const db = fixture(); try {
    db.exec("INSERT INTO characters(name) VALUES('甲')")
    db.transaction(() => applyM02CharacterIdentity(db))()
    expect(verifyM02CharacterIdentity(db)).toBe(true)
    db.exec(sql)
    expect(verifyM02CharacterIdentity(db)).toBe(false)
  } finally { db.close() }
})

it('preserves SQLite 64-bit legacy integers without rounding through JavaScript numbers', () => {
  const db = fixture(); try {
    const value = 9007199254740993n
    db.prepare('INSERT INTO characters(name,cs_updated_at_chapter) VALUES(?,?)').run('旧值', value)
    db.transaction(() => applyM02CharacterIdentity(db))()
    expect(db.prepare('SELECT cs_updated_at_chapter FROM characters').safeIntegers().pluck().get()).toBe(value)
    expect(verifyM02CharacterIdentity(db)).toBe(true)
  } finally { db.close() }
})
