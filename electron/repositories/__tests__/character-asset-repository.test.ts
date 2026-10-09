import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { applyM05CharacterAssets } from '../../migrations/m05-character-assets'
import { readPortableCharacterAvatarRows } from '../character-asset-repository'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const hash = 'a'.repeat(64)
const fields = {
  preserved_relative_path: 'avatars/character/1-file.png', content_hash: hash,
  mime: 'image/png', byte_size: 1,
}
type FixtureRow = {
  preserved_relative_path?: string | null
  content_hash?: string | null
  mime?: string | null
  byte_size?: number | null
  disposition?: string
  candidate_character_ids_json?: string
}

function database(row: FixtureRow = {}) {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE characters(character_id TEXT PRIMARY KEY, retired INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE character_identity_origins(character_id TEXT PRIMARY KEY REFERENCES characters(character_id),source_key TEXT NOT NULL UNIQUE,original_row_json TEXT NOT NULL,original_hash TEXT NOT NULL);`)
  db.transaction(() => applyM05CharacterAssets(db))()
  db.pragma('ignore_check_constraints = ON')
  db.prepare(`INSERT INTO character_avatar_unresolved(
    record_id,disposition,source_reference,source_relative_path,preserved_relative_path,
    content_hash,mime,byte_size,candidate_character_ids_json
  ) VALUES(?,?,?,?,?,?,?,?,?)`).run('record', row.disposition ?? 'orphan', 'legacy.png', 'legacy.png',
    row.preserved_relative_path === undefined ? fields.preserved_relative_path : row.preserved_relative_path,
    row.content_hash === undefined ? fields.content_hash : row.content_hash,
    row.mime === undefined ? fields.mime : row.mime,
    row.byte_size === undefined ? fields.byte_size : row.byte_size, row.candidate_character_ids_json ?? '[]')
  db.pragma('ignore_check_constraints = OFF')
  return db
}

describe('portable character avatar rows', () => {
  it.each([
    ['path', { preserved_relative_path: null }], ['hash', { content_hash: null }],
    ['mime', { mime: null }], ['size', { byte_size: null }],
    ['all fields', { preserved_relative_path: null, content_hash: null, mime: null, byte_size: null }],
  ])('rejects a non-reference row with a null %s', (_label, row) => {
    const db = database(row)
    expect(() => readPortableCharacterAvatarRows(db)).toThrow('CHARACTER_ASSET_PORTABLE_ROW_INVALID')
    db.close()
  })

  it.each([
    ['path', { preserved_relative_path: fields.preserved_relative_path }], ['hash', { content_hash: hash }],
    ['mime', { mime: fields.mime }], ['size', { byte_size: fields.byte_size }],
  ])('rejects a reference-only row with a non-null %s', (_label, field) => {
    const db = database({ disposition: 'reference-only', preserved_relative_path: null, content_hash: null, mime: null, byte_size: null, ...field })
    expect(() => readPortableCharacterAvatarRows(db)).toThrow('CHARACTER_ASSET_PORTABLE_ROW_INVALID')
    db.close()
  })

  it.each(['["stable","stable"]', '[1]', '{}', 'not-json'])('rejects malformed candidate ids: %s', candidate_character_ids_json => {
    const db = database({ candidate_character_ids_json })
    expect(() => readPortableCharacterAvatarRows(db)).toThrow('CHARACTER_ASSET_PORTABLE_ROW_INVALID')
    db.close()
  })

  it('exports a legal reference-only row without inventing a file', () => {
    const db = database({ disposition: 'reference-only', preserved_relative_path: null, content_hash: null, mime: null, byte_size: null,
      candidate_character_ids_json: '["stable"]' })
    expect(readPortableCharacterAvatarRows(db)).toEqual([{
      kind: 'unresolved-reference', recordId: 'record', disposition: 'reference-only',
      sourceReference: 'legacy.png', sourceRelativePath: 'legacy.png', candidateCharacterIds: ['stable'],
    }])
    db.close()
  })
})
