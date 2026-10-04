import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import type { CharacterAvatarAssetMime } from '../../src/shared/character-avatar'
import type { MigrationImplementation, SchemaReader } from './registry'
import { avatarMime, detectAvatarExtension } from '../services/avatar-image'

const require = createRequire(import.meta.url)
const Sqlite = require('better-sqlite3') as typeof import('better-sqlite3')
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')

export const M05_CHARACTER_ASSET_SQL = `
CREATE TABLE character_avatar_assets (
 character_id TEXT PRIMARY KEY REFERENCES characters(character_id) ON DELETE CASCADE,
 asset_revision INTEGER NOT NULL CHECK(asset_revision > 0),
 relative_path TEXT NOT NULL UNIQUE,
 content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
 mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
 byte_size INTEGER NOT NULL CHECK(byte_size > 0),
 source_reference TEXT NOT NULL DEFAULT ''
);
CREATE TABLE character_avatar_unresolved (
 record_id TEXT PRIMARY KEY,
 disposition TEXT NOT NULL CHECK(disposition IN ('orphan','ambiguous','unknown-fork','reference-only')),
 source_reference TEXT NOT NULL,
 source_relative_path TEXT NOT NULL,
 preserved_relative_path TEXT UNIQUE CHECK(CASE WHEN disposition = 'reference-only' THEN preserved_relative_path IS NULL ELSE preserved_relative_path IS NOT NULL END),
 content_hash TEXT CHECK(CASE WHEN disposition = 'reference-only' THEN content_hash IS NULL ELSE content_hash IS NOT NULL AND length(content_hash) = 64 END),
 mime TEXT CHECK(CASE WHEN disposition = 'reference-only' THEN mime IS NULL ELSE mime IS NOT NULL AND mime IN ('image/png','image/jpeg','image/webp','application/octet-stream') END),
 byte_size INTEGER CHECK(CASE WHEN disposition = 'reference-only' THEN byte_size IS NULL ELSE byte_size IS NOT NULL AND byte_size > 0 END),
 candidate_character_ids_json TEXT NOT NULL
);
CREATE INDEX idx_character_avatar_revision ON character_avatar_assets(asset_revision);
CREATE TRIGGER retain_character_avatar_on_delete BEFORE DELETE ON characters
WHEN EXISTS(SELECT 1 FROM character_avatar_assets WHERE character_id=OLD.character_id)
BEGIN
 INSERT OR IGNORE INTO character_avatar_unresolved(
  record_id,disposition,source_reference,source_relative_path,preserved_relative_path,
  content_hash,mime,byte_size,candidate_character_ids_json
 ) SELECT 'character-delete:' || OLD.character_id || ':' || asset_revision,
  'orphan','character-delete:' || OLD.character_id,relative_path,relative_path,
  content_hash,mime,byte_size,json_array(OLD.character_id)
 FROM character_avatar_assets WHERE character_id=OLD.character_id;
END;
`

export interface M05AssetSourceEntry {
  readonly relativePath: string
  readonly size: number
  readonly sha256: string
}

export interface M05AssetSourceSnapshot {
  readonly fingerprint: string
  readonly entries: readonly M05AssetSourceEntry[]
  read(relativePath: string): Buffer
}

export type M05CharacterAssetReceiptFile = {
  sourceRelativePath: string
  canonicalRelativePath: string
  contentHash: string
  byteSize: number
  disposition: 'bound' | 'orphan' | 'ambiguous' | 'unknown-fork'
  characterId?: string
  candidateCharacterIds: string[]
} | {
  sourceRelativePath: string
  canonicalRelativePath: null
  contentHash: null
  byteSize: null
  disposition: 'reference-only'
  candidateCharacterIds: string[]
}

export interface M05CharacterAssetReceipt {
  version: 1
  sourceFingerprint: string
  files: M05CharacterAssetReceiptFile[]
}

export interface M05CharacterAssetMigrationInput {
  sourceSnapshot: M05AssetSourceSnapshot
  stagingTargetRoot: string
  stagingDatabasePath: string
  checkpoint(phase: string): void
}

export interface M05CharacterAssetVerificationInput extends Omit<M05CharacterAssetMigrationInput, 'checkpoint'> {
  receipt: M05CharacterAssetReceipt
}

/** The central schema runner owns this transaction and PRAGMA user_version. */
export function applyM05CharacterAssets(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('CHARACTER_ASSET_MIGRATION_TRANSACTION_REQUIRED')
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='character_identity_origins'").get()) {
    throw new Error('CHARACTER_ASSET_MIGRATION_SCHEMA_UNRECOGNIZED')
  }
  db.exec(M05_CHARACTER_ASSET_SQL)
}

export function verifyM05CharacterAssets(db: Database.Database): boolean {
  try {
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || (db.pragma('foreign_key_check') as unknown[]).length) return false
    const tables = ['character_avatar_assets', 'character_avatar_unresolved']
    if (tables.some(name => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))) return false
    const unresolved = db.prepare(`SELECT disposition,preserved_relative_path,content_hash,mime,byte_size,candidate_character_ids_json
      FROM character_avatar_unresolved`).all() as Array<{
        disposition: string; preserved_relative_path: string | null; content_hash: string | null
        mime: string | null; byte_size: number | null; candidate_character_ids_json: string
      }>
    return unresolved.every(row => {
      const ids = JSON.parse(row.candidate_character_ids_json) as unknown
      const referenceOnly = row.disposition === 'reference-only'
      const shape = referenceOnly
        ? row.preserved_relative_path === null && row.content_hash === null && row.mime === null && row.byte_size === null
        : typeof row.preserved_relative_path === 'string' && /^[a-f0-9]{64}$/u.test(row.content_hash ?? '')
          && ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'].includes(row.mime ?? '')
          && typeof row.byte_size === 'number' && Number.isSafeInteger(row.byte_size) && row.byte_size > 0
      return shape && Array.isArray(ids) && ids.every(id => typeof id === 'string') && new Set(ids).size === ids.length
    })
  } catch { return false }
}

export function createM05Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M05', from: 5, to: 6, owner: 'F03',
    migrate: reader => applyM05CharacterAssets(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) && verifyM05CharacterAssets(deps.database(reader)) }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertSafeDirectory(directory: string): void {
  const absolute = path.resolve(directory)
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    try {
      const info = fs.lstatSync(cursor)
      if (!info.isDirectory() || info.isSymbolicLink() || isWindowsReparseDirectory(cursor)) throw new Error('CHARACTER_ASSET_UNSAFE_PATH')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** Windows exposes junctions as reparse points; realpath differs even when lstat is not a symlink. */
function isWindowsReparseDirectory(directory: string): boolean {
  if (process.platform !== 'win32') return false
  const normalize = (value: string) => path.normalize(value).replace(/^\\\\\\?\\/, '').toLowerCase()
  return normalize(fs.realpathSync.native(directory)) !== normalize(directory)
}

function safeSourceReference(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/') || path.posix.isAbsolute(value)) return false
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function install(root: string, relativePath: string, bytes: Buffer): boolean {
  const target = path.resolve(root, ...relativePath.split('/'))
  if (!contained(path.resolve(root), target)) throw new Error('CHARACTER_ASSET_UNSAFE_PATH')
  assertSafeDirectory(path.dirname(target))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  assertSafeDirectory(path.dirname(target))
  if (fs.existsSync(target)) {
    const info = fs.lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink() || hash(fs.readFileSync(target)) !== hash(bytes)) throw new Error('CHARACTER_ASSET_TARGET_CONFLICT')
    return false
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try {
    fs.linkSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return true
}

function sourceAssociations(db: Database.Database): Map<string, string[]> | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='character_identity_origins'").get()) return null
  const rows = db.prepare('SELECT character_id,original_row_json FROM character_identity_origins ORDER BY character_id').all() as Array<{ character_id: string; original_row_json: string }>
  const result = new Map<string, string[]>()
  for (const row of rows) {
    let original: unknown
    try { original = JSON.parse(row.original_row_json) } catch { continue }
    if (!original || typeof original !== 'object' || Array.isArray(original)) continue
    const reference = (original as Record<string, unknown>).avatar
    if (typeof reference !== 'string' || !safeSourceReference(reference)) continue
    result.set(reference, [...(result.get(reference) ?? []), row.character_id])
  }
  return result
}

function canonicalPath(entry: M05AssetSourceEntry, bytes: Buffer, candidates: string[] | null): {
  relativePath: string; mime: CharacterAvatarAssetMime; disposition: Exclude<M05CharacterAssetReceiptFile['disposition'], 'reference-only'>; characterId?: string
} {
  const extension = detectAvatarExtension(bytes)
  const suffix = extension === 'jpeg' ? 'jpg' : extension ?? 'bin'
  const mime = extension ? avatarMime(extension) : 'application/octet-stream'
  if (candidates?.length === 1 && extension) {
    return { relativePath: `avatars/${hash(candidates[0]!)}/1-${entry.sha256}.${suffix}`,
      mime, disposition: 'bound', characterId: candidates[0] }
  }
  const disposition = candidates === null ? 'unknown-fork' : candidates.length > 1 ? 'ambiguous' : 'orphan'
  const recordId = hash(JSON.stringify([entry.relativePath, entry.sha256, disposition, candidates ?? []]))
  return { relativePath: `avatars/unresolved/${recordId}.${suffix}`, mime, disposition }
}

function referenceOnlyReceipt(sourceRelativePath: string, candidateCharacterIds: string[]): M05CharacterAssetReceiptFile {
  return { sourceRelativePath, canonicalRelativePath: null, contentHash: null, byteSize: null,
    disposition: 'reference-only', candidateCharacterIds }
}

/**
 * S04-only file capability. It reads exclusively through sourceSnapshot and writes
 * exclusively under stagingTargetRoot; no runtime locator or live DB is reachable.
 */
export async function migrateM05CharacterAssets(input: M05CharacterAssetMigrationInput): Promise<M05CharacterAssetReceipt> {
  const root = path.resolve(input.stagingTargetRoot)
  const databasePath = path.resolve(input.stagingDatabasePath)
  if (!contained(root, databasePath)) throw new Error('CHARACTER_ASSET_STAGING_SCOPE_REQUIRED')
  assertSafeDirectory(root)
  const db = new Sqlite(databasePath, { fileMustExist: true })
  const installed: string[] = []
  try {
    db.pragma('foreign_keys = ON')
    if (!verifyM05CharacterAssets(db)) throw new Error('CHARACTER_ASSET_SCHEMA_REQUIRED')
    const associations = sourceAssociations(db)
    const files: M05CharacterAssetReceiptFile[] = []
    const sourceEntries = new Set(input.sourceSnapshot.entries.map(entry => entry.relativePath))
    for (const entry of input.sourceSnapshot.entries) {
      if (!safeSourceReference(entry.relativePath) || !Number.isSafeInteger(entry.size) || entry.size <= 0
        || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error('CHARACTER_ASSET_SOURCE_INVALID')
      const bytes = input.sourceSnapshot.read(entry.relativePath)
      if (bytes.byteLength !== entry.size || hash(bytes) !== entry.sha256) throw new Error('CHARACTER_ASSET_SOURCE_CHANGED')
      const candidates = associations?.get(entry.relativePath) ?? (associations ? [] : null)
      const target = canonicalPath(entry, bytes, candidates)
      input.checkpoint(`m05:file-before:${entry.sha256}`)
      if (install(root, target.relativePath, bytes)) installed.push(target.relativePath)
      input.checkpoint(`m05:file-after:${entry.sha256}`)
      files.push({ sourceRelativePath: entry.relativePath, canonicalRelativePath: target.relativePath,
        contentHash: entry.sha256, byteSize: entry.size, disposition: target.disposition,
        ...(target.characterId ? { characterId: target.characterId } : {}), candidateCharacterIds: candidates ?? [] })
    }
    for (const [sourceRelativePath, candidateCharacterIds] of associations ?? []) {
      if (!sourceEntries.has(sourceRelativePath)) files.push(referenceOnlyReceipt(sourceRelativePath, candidateCharacterIds))
    }
    input.checkpoint('m05:db-before')
    db.transaction(() => {
      for (const file of files) {
        if (file.disposition === 'reference-only') {
          const recordId = hash(JSON.stringify([file.sourceRelativePath, file.disposition, file.candidateCharacterIds]))
          db.prepare(`INSERT OR IGNORE INTO character_avatar_unresolved(
            record_id,disposition,source_reference,source_relative_path,preserved_relative_path,
            content_hash,mime,byte_size,candidate_character_ids_json
          ) VALUES(?,?,?,?,?,?,?,?,?)`).run(recordId, file.disposition, file.sourceRelativePath,
            file.sourceRelativePath, null, null, null, null, JSON.stringify(file.candidateCharacterIds))
          continue
        }
        const bytes = input.sourceSnapshot.read(file.sourceRelativePath)
        const extension = detectAvatarExtension(bytes)
        const mime = extension ? avatarMime(extension) : 'application/octet-stream'
        if (file.disposition === 'bound') {
          const existing = db.prepare('SELECT relative_path,content_hash FROM character_avatar_assets WHERE character_id=?').get(file.characterId) as { relative_path: string; content_hash: string } | undefined
          if (existing && (existing.relative_path !== file.canonicalRelativePath || existing.content_hash !== file.contentHash)) throw new Error('CHARACTER_ASSET_TARGET_CONFLICT')
          db.prepare(`INSERT OR IGNORE INTO character_avatar_assets(
            character_id,asset_revision,relative_path,content_hash,mime,byte_size,source_reference
          ) VALUES(?,1,?,?,?,?,?)`).run(file.characterId, file.canonicalRelativePath, file.contentHash, mime, file.byteSize, file.sourceRelativePath)
        } else {
          const recordId = path.basename(file.canonicalRelativePath).split('.')[0]!
          db.prepare(`INSERT OR IGNORE INTO character_avatar_unresolved(
            record_id,disposition,source_reference,source_relative_path,preserved_relative_path,
            content_hash,mime,byte_size,candidate_character_ids_json
          ) VALUES(?,?,?,?,?,?,?,?,?)`).run(recordId, file.disposition, file.sourceRelativePath,
            file.sourceRelativePath, file.canonicalRelativePath, file.contentHash, mime, file.byteSize,
            JSON.stringify(file.candidateCharacterIds))
        }
      }
    })()
    input.checkpoint('m05:db-after')
    return { version: 1, sourceFingerprint: input.sourceSnapshot.fingerprint, files }
  } catch (error) {
    for (const relativePath of installed) fs.rmSync(path.resolve(root, ...relativePath.split('/')), { force: true })
    throw error
  } finally { db.close() }
}

export async function verifyM05CharacterAssetMigration(input: M05CharacterAssetVerificationInput): Promise<boolean> {
  if (input.receipt.version !== 1 || input.receipt.sourceFingerprint !== input.sourceSnapshot.fingerprint) return false
  const root = path.resolve(input.stagingTargetRoot), databasePath = path.resolve(input.stagingDatabasePath)
  if (!contained(root, databasePath)) return false
  const db = new Sqlite(databasePath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('foreign_keys = ON')
    if (!verifyM05CharacterAssets(db)) return false
    const associations = sourceAssociations(db)
    const sourceEntries = new Map(input.sourceSnapshot.entries.map(entry => [entry.relativePath, entry]))
    const expectedSources = new Set(sourceEntries.keys())
    for (const sourceRelativePath of associations?.keys() ?? []) expectedSources.add(sourceRelativePath)
    if (input.receipt.files.length !== expectedSources.size
      || new Set(input.receipt.files.map(file => file.sourceRelativePath)).size !== input.receipt.files.length
      || input.receipt.files.some(file => !expectedSources.has(file.sourceRelativePath))) return false
    for (const file of input.receipt.files) {
      const candidates = associations?.get(file.sourceRelativePath)
      if (file.disposition === 'reference-only') {
        if (!candidates || sourceEntries.has(file.sourceRelativePath)
          || file.canonicalRelativePath !== null || file.contentHash !== null || file.byteSize !== null
          || JSON.stringify(file.candidateCharacterIds) !== JSON.stringify(candidates)) return false
        const row = db.prepare(`SELECT disposition,preserved_relative_path,content_hash,mime,byte_size,candidate_character_ids_json
          FROM character_avatar_unresolved WHERE source_relative_path=?`).get(file.sourceRelativePath) as {
            disposition: string; preserved_relative_path: string | null; content_hash: string | null; mime: string | null
            byte_size: number | null; candidate_character_ids_json: string
          } | undefined
        if (!row || row.disposition !== 'reference-only' || row.preserved_relative_path !== null
          || row.content_hash !== null || row.mime !== null || row.byte_size !== null
          || row.candidate_character_ids_json !== JSON.stringify(candidates)) return false
        continue
      }
      const entry = sourceEntries.get(file.sourceRelativePath)
      if (!entry || file.contentHash !== entry.sha256 || file.byteSize !== entry.size) return false
      const target = path.resolve(root, ...file.canonicalRelativePath.split('/'))
      if (!contained(root, target)) return false
      assertSafeDirectory(path.dirname(target))
      const info = fs.lstatSync(target)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.byteSize
        || hash(fs.readFileSync(target)) !== file.contentHash) return false
      if (file.disposition === 'bound') {
        const row = db.prepare('SELECT relative_path,content_hash,byte_size FROM character_avatar_assets WHERE character_id=?').get(file.characterId) as { relative_path: string; content_hash: string; byte_size: number } | undefined
        if (!row || row.relative_path !== file.canonicalRelativePath || row.content_hash !== file.contentHash || row.byte_size !== file.byteSize) return false
      } else {
        const row = db.prepare('SELECT disposition,preserved_relative_path,content_hash,byte_size FROM character_avatar_unresolved WHERE source_relative_path=?').get(file.sourceRelativePath) as { disposition: string; preserved_relative_path: string; content_hash: string; byte_size: number } | undefined
        if (!row || row.disposition !== file.disposition || row.preserved_relative_path !== file.canonicalRelativePath
          || row.content_hash !== file.contentHash || row.byte_size !== file.byteSize) return false
      }
    }
    return true
  } catch { return false } finally { db.close() }
}

export const m05CharacterAssetMigrationAdapter = Object.freeze({
  migrate: migrateM05CharacterAssets,
  verify: verifyM05CharacterAssetMigration,
})
