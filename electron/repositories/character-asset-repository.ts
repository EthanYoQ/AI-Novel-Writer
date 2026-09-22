import type Database from 'better-sqlite3'
import type { CharacterAvatarAssetMime, CharacterAvatarView, PortableCharacterAvatarRow } from '../../src/shared/character-avatar'

export interface CharacterAssetRecord {
  characterId: string
  assetRevision: number
  relativePath: string
  contentHash: string
  mime: CharacterAvatarView['mime']
  byteSize: number
  sourceReference: string
}

type AssetRow = {
  character_id: string
  asset_revision: number
  relative_path: string
  content_hash: string
  mime: CharacterAvatarView['mime']
  byte_size: number
  source_reference: string
}

type UnresolvedAssetRow = {
  record_id: string
  disposition: string
  source_reference: string
  source_relative_path: string
  preserved_relative_path: string | null
  content_hash: string | null
  mime: CharacterAvatarAssetMime | null
  byte_size: number | null
  candidate_character_ids_json: string
}

const assetMimes: CharacterAvatarAssetMime[] = ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']
const safeRelativePath = (value: string | null): value is string => typeof value === 'string'
  && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
const invalidPortableRow = (): never => { throw new Error('CHARACTER_ASSET_PORTABLE_ROW_INVALID') }
const candidateCharacterIds = (value: string): string[] => {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return invalidPortableRow() }
  if (!Array.isArray(parsed) || parsed.some(id => typeof id !== 'string') || new Set(parsed).size !== parsed.length) return invalidPortableRow()
  return parsed
}
const validMime = (value: CharacterAvatarAssetMime | null): value is CharacterAvatarAssetMime => value !== null && assetMimes.includes(value)
const validHash = (value: string | null): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const validByteSize = (value: number | null): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const fromRow = (row: AssetRow): CharacterAssetRecord => ({
  characterId: row.character_id,
  assetRevision: row.asset_revision,
  relativePath: row.relative_path,
  contentHash: row.content_hash,
  mime: row.mime,
  byteSize: row.byte_size,
  sourceReference: row.source_reference,
})

export class CharacterAssetRepository {
  constructor(private readonly db: Database.Database) {}

  characterExists(characterId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM characters WHERE character_id=? AND retired=0').get(characterId))
  }

  read(characterId: string): CharacterAssetRecord | null {
    const row = this.db.prepare('SELECT * FROM character_avatar_assets WHERE character_id=?').get(characterId) as AssetRow | undefined
    return row ? fromRow(row) : null
  }

  readMany(characterIds: readonly string[]): CharacterAssetRecord[] {
    if (!characterIds.length) return []
    const parameters = characterIds.map(() => '?').join(',')
    return (this.db.prepare(`SELECT * FROM character_avatar_assets WHERE character_id IN (${parameters}) ORDER BY character_id`).all(...characterIds) as AssetRow[]).map(fromRow)
  }

  nextRevision(characterId: string): number {
    return (this.read(characterId)?.assetRevision ?? 0) + 1
  }

  replace(record: CharacterAssetRecord): CharacterAssetRecord | null {
    return this.db.transaction(() => {
      if (!this.characterExists(record.characterId)) throw new Error('CHARACTER_NOT_FOUND')
      const previous = this.read(record.characterId)
      if (record.assetRevision !== (previous?.assetRevision ?? 0) + 1) throw new Error('AVATAR_REVISION_CONFLICT')
      this.db.prepare(`INSERT INTO character_avatar_assets(
        character_id,asset_revision,relative_path,content_hash,mime,byte_size,source_reference
      ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET
        asset_revision=excluded.asset_revision,relative_path=excluded.relative_path,
        content_hash=excluded.content_hash,mime=excluded.mime,byte_size=excluded.byte_size,
        source_reference=excluded.source_reference`).run(record.characterId, record.assetRevision,
        record.relativePath, record.contentHash, record.mime, record.byteSize, record.sourceReference)
      return previous
    })()
  }

  remove(characterId: string): CharacterAssetRecord | null {
    return this.db.transaction(() => {
      if (!this.characterExists(characterId)) throw new Error('CHARACTER_NOT_FOUND')
      const previous = this.read(characterId)
      this.db.prepare('DELETE FROM character_avatar_assets WHERE character_id=?').run(characterId)
      return previous
    })()
  }

  referencedPaths(): Set<string> {
    const assets = this.db.prepare('SELECT relative_path FROM character_avatar_assets').all() as { relative_path: string }[]
    const unresolved = this.db.prepare('SELECT preserved_relative_path AS relative_path FROM character_avatar_unresolved WHERE preserved_relative_path IS NOT NULL').all() as { relative_path: string }[]
    return new Set([...assets, ...unresolved].map(row => row.relative_path))
  }
}

export function readPortableCharacterAvatarRows(db: Database.Database): PortableCharacterAvatarRow[] {
  const bound = (db.prepare('SELECT * FROM character_avatar_assets ORDER BY character_id').all() as AssetRow[]).map(row => ({
    kind: 'bound' as const,
    characterId: row.character_id,
    assetRevision: row.asset_revision,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    mime: row.mime,
    byteSize: row.byte_size,
  }))
  const unresolved = db.prepare('SELECT * FROM character_avatar_unresolved ORDER BY record_id').all() as UnresolvedAssetRow[]
  return [...bound, ...unresolved.map(row => {
    const candidateIds = candidateCharacterIds(row.candidate_character_ids_json)
    if (row.disposition === 'reference-only') {
      if (row.preserved_relative_path !== null || row.content_hash !== null || row.mime !== null || row.byte_size !== null) return invalidPortableRow()
      return { kind: 'unresolved-reference' as const, recordId: row.record_id, disposition: 'reference-only' as const,
        sourceReference: row.source_reference, sourceRelativePath: row.source_relative_path, candidateCharacterIds: candidateIds }
    }
    if (!['orphan', 'ambiguous', 'unknown-fork'].includes(row.disposition)
      || !safeRelativePath(row.preserved_relative_path) || !validHash(row.content_hash) || !validMime(row.mime)
      || !validByteSize(row.byte_size)) return invalidPortableRow()
    return { kind: 'unresolved' as const, recordId: row.record_id,
      disposition: row.disposition as 'orphan' | 'ambiguous' | 'unknown-fork',
      sourceReference: row.source_reference, sourceRelativePath: row.source_relative_path,
      relativePath: row.preserved_relative_path, contentHash: row.content_hash, mime: row.mime, byteSize: row.byte_size,
      candidateCharacterIds: candidateIds }
  })]
}
