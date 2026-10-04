import { randomUUID, createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

export const M02_ADDED_CHARACTER_COLUMNS = ['character_id', 'legacy_key', 'static_provenance', 'identity_revision', 'retired'] as const
export const M02_AUXILIARY_TABLES = ['character_identity_origins', 'character_aliases', 'character_identity_proposals', 'character_identity_approvals', 'character_relationships', 'character_identity_meta'] as const

export const M02_CHARACTER_AUXILIARY_SQL = `
CREATE TABLE character_identity_origins (
 character_id TEXT PRIMARY KEY REFERENCES characters(character_id), source_key TEXT NOT NULL UNIQUE,
 original_row_json TEXT NOT NULL, original_hash TEXT NOT NULL
);
CREATE TABLE character_aliases (
 character_id TEXT NOT NULL REFERENCES characters(character_id), name TEXT NOT NULL,
 source_key TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_through INTEGER,
 PRIMARY KEY(character_id,name,source_key,valid_from)
);
CREATE TABLE character_identity_proposals (
 proposal_id TEXT PRIMARY KEY, owner_character_id TEXT REFERENCES characters(character_id),
 source_key TEXT NOT NULL, source_hash TEXT NOT NULL, raw_value TEXT NOT NULL, candidate_ids_json TEXT NOT NULL,
 resolved_character_id TEXT REFERENCES characters(character_id), approval_id TEXT REFERENCES character_identity_approvals(operation_id)
);
CREATE TABLE character_identity_approvals (
 operation_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL
);
CREATE TABLE character_relationships (
 relationship_id TEXT PRIMARY KEY,
 source_character_id TEXT NOT NULL REFERENCES characters(character_id),
 target_character_id TEXT NOT NULL REFERENCES characters(character_id),
 relation TEXT NOT NULL, source_display_snapshot TEXT NOT NULL, target_display_snapshot TEXT NOT NULL,
 provenance_json TEXT NOT NULL, approval_id TEXT NOT NULL REFERENCES character_identity_approvals(operation_id)
);
CREATE TABLE character_identity_meta (
 id TEXT PRIMARY KEY CHECK(id='main'), revision INTEGER NOT NULL, legacy_count INTEGER NOT NULL
);
INSERT INTO character_identity_meta VALUES('main',0,0);
`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** The central runner owns the transaction and user_version; this function never opens a DB. */
export function applyM02CharacterIdentity(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('CHARACTER_MIGRATION_TRANSACTION_REQUIRED')
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='characters'").get() as { sql: string }).sql
  if (!/name TEXT PRIMARY KEY/u.test(ddl)) throw new Error('CHARACTER_MIGRATION_SCHEMA_UNRECOGNIZED')
  const rows = db.prepare('SELECT * FROM characters ORDER BY rowid').safeIntegers().all() as Record<string, unknown>[]
  const rebuilt = ddl.replace(/CREATE TABLE(?: IF NOT EXISTS)? characters/u, 'CREATE TABLE characters_m02')
    .replace('name TEXT PRIMARY KEY', "character_id TEXT PRIMARY KEY, legacy_key TEXT, static_provenance TEXT NOT NULL DEFAULT '{}', identity_revision INTEGER NOT NULL DEFAULT 0, retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)), name TEXT")
  db.exec(rebuilt)
  const columns = (db.prepare('PRAGMA table_info(characters)').all() as { name: string }[]).map(row => row.name)
  const insert = db.prepare(`INSERT INTO characters_m02(character_id,legacy_key,static_provenance,${columns.map(name => `"${name}"`).join(',')}) VALUES(${Array(columns.length + 3).fill('?').join(',')})`)
  const assigned = rows.map((row, index) => ({ row, id: randomUUID(), sourceKey: `legacy:characters:${index}` }))
  for (const { row, id, sourceKey } of assigned) insert.run(id, row.name, JSON.stringify({ kind: 'legacy', sourceKey }), ...columns.map(name => row[name]))
  db.exec('DROP TABLE characters; ALTER TABLE characters_m02 RENAME TO characters;')
  db.exec(M02_CHARACTER_AUXILIARY_SQL)
  db.prepare("UPDATE character_identity_meta SET legacy_count=? WHERE id='main'").run(rows.length)
  for (const { row, id, sourceKey } of assigned) {
    const original = JSON.stringify(row, (_key, value: unknown) => typeof value === 'bigint' ? { integer: value.toString() } : value)
    db.prepare('INSERT INTO character_identity_origins VALUES(?,?,?,?)').run(id, sourceKey, original, hash(original))
    if (typeof row.name === 'string' && row.name.trim()) db.prepare('INSERT INTO character_aliases VALUES(?,?,?,0,NULL)').run(id, row.name, sourceKey)
    if (typeof row.relationships === 'string' && row.relationships.length) {
      let values: unknown[]
      try { const parsed = JSON.parse(row.relationships); values = Array.isArray(parsed) ? parsed : [row.relationships] } catch { values = [row.relationships] }
      for (const [index, value] of values.entries()) {
        const target = value && typeof value === 'object' && 'target' in value ? (value as { target: unknown }).target : null
        const ids = assigned.filter(other => typeof target === 'string' && other.row.name === target).map(other => other.id)
        // The old string has no source-bound target authority, even if a name is unique.
        db.prepare('INSERT INTO character_identity_proposals VALUES(?,?,?,?,?,?,NULL,NULL)').run(randomUUID(), id, `${sourceKey}:relationships:${index}`, hash(row.relationships), typeof value === 'string' ? value : JSON.stringify(value), JSON.stringify(ids))
      }
    }
  }
  const blueprints = db.prepare('SELECT chapter_number,characters FROM blueprints').all() as { chapter_number: number; characters: string }[]
  for (const blueprint of blueprints) {
    if (!blueprint.characters) continue
    let names: unknown[]
    try { const value = JSON.parse(blueprint.characters); names = Array.isArray(value) ? value : [blueprint.characters] } catch { names = [blueprint.characters] }
    for (const [index, name] of names.entries()) {
      const ids = assigned.filter(person => typeof name === 'string' && person.row.name === name).map(person => person.id)
      db.prepare('INSERT INTO character_identity_proposals VALUES(?,NULL,?,?,?,?,NULL,NULL)').run(randomUUID(), `legacy:blueprints:${blueprint.chapter_number}:characters:${index}`, hash(blueprint.characters), typeof name === 'string' ? name : JSON.stringify(name), JSON.stringify(ids))
    }
  }
  // Check every old field while the migration still owns the transaction. Later
  // verification must allow legitimate author edits, so immutable originals persist separately.
  for (const { row, id } of assigned) {
    const migrated = db.prepare('SELECT * FROM characters WHERE character_id=?').safeIntegers().get(id) as Record<string, unknown>
    if (columns.some(column => migrated[column] !== row[column])) throw new Error('CHARACTER_MIGRATION_VALUE_LOSS')
  }
}
export function verifyM02CharacterIdentity(db: Database.Database): boolean {
  try {
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || (db.pragma('foreign_key_check') as unknown[]).length) return false
    const origins = db.prepare('SELECT o.*,c.legacy_key FROM character_identity_origins o JOIN characters c ON c.character_id=o.character_id').all() as { original_row_json: string; original_hash: string; legacy_key: unknown }[]
    const meta = db.prepare("SELECT revision,legacy_count FROM character_identity_meta WHERE id='main'").get() as { revision: number; legacy_count: number } | undefined
    if (!meta || !Number.isSafeInteger(meta.revision) || meta.revision < 0 || !Number.isSafeInteger(meta.legacy_count) || meta.legacy_count < 0 || origins.length !== meta.legacy_count) return false
    if (!origins.every(origin => hash(origin.original_row_json) === origin.original_hash && JSON.parse(origin.original_row_json).name === origin.legacy_key)) return false
    const characters = db.prepare('SELECT character_id,identity_revision FROM characters').all() as { character_id: string; identity_revision: number }[]
    const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
    const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
    if (characters.some(row => !nonempty(row.character_id) || !revision(row.identity_revision) || row.identity_revision > meta.revision)) return false
    const ids = new Set(characters.map(row => row.character_id))
    const proposals = db.prepare('SELECT candidate_ids_json,resolved_character_id,approval_id FROM character_identity_proposals').all() as { candidate_ids_json: string; resolved_character_id: string | null; approval_id: string | null }[]
    if (!proposals.every(proposal => {
      const candidates = JSON.parse(proposal.candidate_ids_json) as unknown
      return Array.isArray(candidates) && new Set(candidates).size === candidates.length && candidates.every(id => typeof id === 'string' && ids.has(id))
        && Boolean(proposal.resolved_character_id) === Boolean(proposal.approval_id)
    })) return false
    const aliases = db.prepare('SELECT * FROM character_aliases').all() as { character_id: string; name: string; source_key: string; valid_from: number; valid_through: number | null }[]
    return aliases.every(alias => nonempty(alias.character_id) && ids.has(alias.character_id) && nonempty(alias.name) && nonempty(alias.source_key)
      && revision(alias.valid_from) && alias.valid_from <= meta.revision
      && (alias.valid_through === null || revision(alias.valid_through) && alias.valid_through >= alias.valid_from && alias.valid_through <= meta.revision))
  } catch { return false }
}
export function createM02Migration(deps: { database: (reader: SchemaReader) => Database.Database; verifyKnownSchema: (reader: SchemaReader) => boolean }): MigrationImplementation {
  return { id: 'M02', from: 2, to: 3, owner: 'S08', migrate: reader => applyM02CharacterIdentity(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM02CharacterIdentity(deps.database(reader)) }
}
