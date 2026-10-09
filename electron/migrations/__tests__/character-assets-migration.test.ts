import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import {
  M05_CHARACTER_ASSET_SQL,
  applyM05CharacterAssets,
  migrateM05CharacterAssets,
  verifyM05CharacterAssetMigration,
  verifyM05CharacterAssets,
  type M05AssetSourceSnapshot,
} from '../m05-character-assets'
import { readPortableCharacterAvatarRows } from '../../repositories/character-asset-repository'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const png = (byte: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, byte)])

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'f03-m05-'))
  roots.push(value)
  return value
}

function database(file: string, withOrigins = true) {
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE characters(character_id TEXT PRIMARY KEY, retired INTEGER NOT NULL DEFAULT 0);${withOrigins
    ? 'CREATE TABLE character_identity_origins(character_id TEXT PRIMARY KEY REFERENCES characters(character_id),source_key TEXT NOT NULL UNIQUE,original_row_json TEXT NOT NULL,original_hash TEXT NOT NULL);'
    : ''}`)
  return db
}

function snapshot(files: Record<string, Buffer>): M05AssetSourceSnapshot {
  const entries = Object.entries(files).sort().map(([relativePath, bytes]) => ({ relativePath, size: bytes.length, sha256: sha(bytes) }))
  return { fingerprint: sha(Buffer.from(JSON.stringify(entries))), entries,
    read(relativePath) { const bytes = files[relativePath]; if (!bytes) throw new Error('missing'); return Buffer.from(bytes) } }
}

afterEach(() => { for (const item of roots.splice(0)) fs.rmSync(item, { recursive: true, force: true }) })

describe('M05 character asset migration', () => {
  it('installs and verifies the schema only inside the runner transaction', () => {
    const db = database(':memory:')
    expect(() => applyM05CharacterAssets(db)).toThrow('CHARACTER_ASSET_MIGRATION_TRANSACTION_REQUIRED')
    db.transaction(() => applyM05CharacterAssets(db))()
    expect(verifyM05CharacterAssets(db)).toBe(true)
    db.close()
  })

  it('rejects malformed non-reference unresolved rows even if a database bypasses checks', () => {
    const db = database(':memory:')
    db.transaction(() => applyM05CharacterAssets(db))()
    const insert = () => db.prepare(`INSERT INTO character_avatar_unresolved(
      record_id,disposition,source_reference,source_relative_path,preserved_relative_path,
      content_hash,mime,byte_size,candidate_character_ids_json
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run('bad', 'orphan', 'old.png', 'old.png', null, null, null, null, '[]')
    expect(insert).toThrow()
    db.pragma('ignore_check_constraints = ON')
    insert()
    db.pragma('ignore_check_constraints = OFF')
    expect(verifyM05CharacterAssets(db)).toBe(false)
    db.close()
  })

  it('binds only exact original_row_json.avatar references and preserves ambiguity and orphans', async () => {
    const staging = root(), dbPath = path.join(staging, 'project.db'), db = database(dbPath)
    for (const [id, avatar] of [['stable-a', 'alice.png'], ['stable-b', 'collision.png'], ['stable-c', 'collision.png']]) {
      db.prepare('INSERT INTO characters VALUES(?,0)').run(id)
      db.prepare('INSERT INTO character_identity_origins VALUES(?,?,?,?)').run(id, `legacy:${id}`, JSON.stringify({ name: id, avatar }), 'origin')
    }
    db.transaction(() => applyM05CharacterAssets(db))(); db.pragma('user_version = 6'); db.close()
    const source = snapshot({ 'alice.png': png(1), 'collision.png': png(2), 'orphan.png': png(3) })
    const checkpoints: string[] = []
    const receipt = await migrateM05CharacterAssets({ sourceSnapshot: source, stagingTargetRoot: staging,
      stagingDatabasePath: dbPath, checkpoint: phase => checkpoints.push(phase) })

    expect(receipt.files.map(file => [file.sourceRelativePath, file.disposition])).toEqual([
      ['alice.png', 'bound'], ['collision.png', 'ambiguous'], ['orphan.png', 'orphan'],
    ])
    expect(receipt.files[0]?.canonicalRelativePath).toMatch(/^avatars\/[a-f0-9]{64}\/1-[a-f0-9]{64}\.png$/)
    expect(checkpoints.filter(value => value.startsWith('m05:file-before:'))).toHaveLength(3)
    expect(checkpoints.filter(value => value.startsWith('m05:file-after:'))).toHaveLength(3)
    expect(checkpoints.slice(-2)).toEqual(['m05:db-before', 'm05:db-after'])
    expect(await verifyM05CharacterAssetMigration({ sourceSnapshot: source, stagingTargetRoot: staging,
      stagingDatabasePath: dbPath, receipt })).toBe(true)

    const verify = new Database(dbPath, { readonly: true })
    expect(verify.prepare('SELECT character_id,source_reference FROM character_avatar_assets').all()).toEqual([
      { character_id: 'stable-a', source_reference: 'alice.png' },
    ])
    expect(verify.prepare('SELECT disposition,candidate_character_ids_json FROM character_avatar_unresolved ORDER BY disposition').all()).toEqual([
      { disposition: 'ambiguous', candidate_character_ids_json: '["stable-b","stable-c"]' },
      { disposition: 'orphan', candidate_character_ids_json: '[]' },
    ])
    verify.close()
  })

  it('preserves every unknown-fork file without binding by name or hash', async () => {
    const staging = root(), dbPath = path.join(staging, 'project.db'), db = database(dbPath, false)
    db.prepare('INSERT INTO characters VALUES(?,0)').run('stable-a')
    db.exec(M05_CHARACTER_ASSET_SQL); db.close()
    const source = snapshot({ 'looks-like-a-name-hash.png': png(7) })
    const receipt = await migrateM05CharacterAssets({ sourceSnapshot: source, stagingTargetRoot: staging,
      stagingDatabasePath: dbPath, checkpoint: () => undefined })
    expect(receipt.files[0]).toMatchObject({ disposition: 'unknown-fork', candidateCharacterIds: [] })
    const verify = new Database(dbPath, { readonly: true })
    expect(verify.prepare('SELECT COUNT(*) AS count FROM character_avatar_assets').get()).toEqual({ count: 0 })
    expect(verify.prepare('SELECT disposition FROM character_avatar_unresolved').get()).toEqual({ disposition: 'unknown-fork' })
    verify.close()
  })

  it('records a safe donor avatar reference whose frozen source has no file', async () => {
    const staging = root(), dbPath = path.join(staging, 'project.db'), db = database(dbPath)
    db.prepare('INSERT INTO characters VALUES(?,0)').run('stable-missing')
    db.prepare('INSERT INTO character_identity_origins VALUES(?,?,?,?)').run(
      'stable-missing', 'legacy:missing', JSON.stringify({ avatar: 'missing.png' }), 'origin')
    db.transaction(() => applyM05CharacterAssets(db))(); db.close()

    const source = snapshot({})
    const receipt = await migrateM05CharacterAssets({ sourceSnapshot: source, stagingTargetRoot: staging,
      stagingDatabasePath: dbPath, checkpoint: () => undefined })
    expect(receipt.files).toEqual([{
      sourceRelativePath: 'missing.png', canonicalRelativePath: null, contentHash: null, byteSize: null,
      disposition: 'reference-only', candidateCharacterIds: ['stable-missing'],
    }])
    expect(await verifyM05CharacterAssetMigration({ sourceSnapshot: source, stagingTargetRoot: staging,
      stagingDatabasePath: dbPath, receipt })).toBe(true)

    const verify = new Database(dbPath, { readonly: true })
    expect(verify.prepare(`SELECT preserved_relative_path,content_hash,mime,byte_size FROM character_avatar_unresolved`).get())
      .toEqual({ preserved_relative_path: null, content_hash: null, mime: null, byte_size: null })
    expect(readPortableCharacterAvatarRows(verify)).toEqual([{
      kind: 'unresolved-reference', recordId: expect.any(String), disposition: 'reference-only',
      sourceReference: 'missing.png', sourceRelativePath: 'missing.png', candidateCharacterIds: ['stable-missing'],
    }])
    verify.close()
  })

  it('rejects a linked canonical parent before reading the target file', async () => {
    const staging = root(), dbPath = path.join(staging, 'project.db'), db = database(dbPath)
    db.prepare('INSERT INTO characters VALUES(?,0)').run('stable-a')
    db.prepare('INSERT INTO character_identity_origins VALUES(?,?,?,?)').run('stable-a', 'legacy:a', JSON.stringify({ avatar: 'alice.png' }), 'origin')
    db.transaction(() => applyM05CharacterAssets(db))(); db.close()
    const source = snapshot({ 'alice.png': png(1) })
    const receipt = await migrateM05CharacterAssets({ sourceSnapshot: source, stagingTargetRoot: staging,
      stagingDatabasePath: dbPath, checkpoint: () => undefined })
    const file = receipt.files[0]!
    if (file.disposition !== 'bound') throw new Error('expected bound fixture')
    const target = path.resolve(staging, ...file.canonicalRelativePath.split('/'))
    const parent = path.dirname(target), outside = root()
    fs.copyFileSync(target, path.join(outside, path.basename(target)))
    fs.rmSync(parent, { recursive: true, force: true })
    fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')

    expect(await verifyM05CharacterAssetMigration({ sourceSnapshot: source, stagingTargetRoot: staging,
      stagingDatabasePath: dbPath, receipt })).toBe(false)
  })

  it('retains a deleted character asset as explicit orphan evidence', () => {
    const db = database(':memory:')
    db.prepare('INSERT INTO characters VALUES(?,0)').run('stable-a')
    db.prepare('INSERT INTO character_identity_origins VALUES(?,?,?,?)').run('stable-a', 'legacy:a', '{}', 'x')
    db.transaction(() => applyM05CharacterAssets(db))()
    db.prepare('INSERT INTO character_avatar_assets VALUES(?,?,?,?,?,?,?)').run('stable-a', 1,
      'avatars/a/1-file.png', 'a'.repeat(64), 'image/png', 32, 'old.png')
    db.prepare('DELETE FROM character_identity_origins WHERE character_id=?').run('stable-a')
    db.prepare('DELETE FROM characters WHERE character_id=?').run('stable-a')
    expect(db.prepare('SELECT disposition,preserved_relative_path FROM character_avatar_unresolved').get()).toEqual({
      disposition: 'orphan', preserved_relative_path: 'avatars/a/1-file.png',
    })
    db.close()
  })
})
