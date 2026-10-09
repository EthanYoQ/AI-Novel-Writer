import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { CharacterRosterSnapshot } from '../../src/shared/character-roster'
import { resolveWritingLanguage, type WritingLanguage } from '../../src/shared/writing-language'
import { CharacterRosterRepository, refreshCharacterIdentityProjection } from '../repositories/character-roster-repository'
import { hasCharacterIdentitySchema } from '../repositories/character-repository'
import { textHash } from '../repositories/generation-run-repository'

export interface LegacyRosterSource {
  snapshot: CharacterRosterSnapshot
  rawLegacy: string
  legacyHash: string
  identityRevision: number
  activeIds: string[]
  /** Actual rows, including retired identities and author state, not stored meta.fact_hash. */
  factsHash: string
  genre: string
  writingLanguage: WritingLanguage
}
export interface AdoptLegacyCardsRequest {
  operationId: string
  expectedRevision: number
  expectedLegacyHash: string
  expectedIdentityRevision: number
  expectedFactsHash: string
}
export interface AdoptLegacyCardsReceipt {
  success: true
  operationId: string
  snapshot: CharacterRosterSnapshot
  activeIds: string[]
}
interface AdoptionEnvelope {
  version: 1
  kind: 'legacy-cards-adoption'
  request: AdoptLegacyCardsRequest
  requestHash: string
  receipt: AdoptLegacyCardsReceipt
  receiptHash: string
}
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const prefix = 'legacy-cards-adoption:'

export function readLegacyRosterSource(db: Database.Database): LegacyRosterSource {
  return db.transaction(() => readSource(db))()
}
function readSource(db: Database.Database): LegacyRosterSource {
  if (!hasCharacterIdentitySchema(db)) throw new Error('LEGACY_ROSTER_ID_SCHEMA_REQUIRED')
  const core = db.prepare("SELECT genre,writing_language FROM project_core WHERE id='main'").get() as { genre: string; writing_language: string } | undefined
  const identityRevision = db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").pluck().get()
  const rawLegacy = db.prepare("SELECT legacy_markdown FROM character_roster_meta WHERE id='main'").pluck().get()
  if (!core || !revision(identityRevision) || typeof rawLegacy !== 'string') throw new Error('LEGACY_ROSTER_SOURCE_INVALID')
  const characters = db.prepare('SELECT * FROM characters ORDER BY character_id').all() as { character_id: string; retired: number }[]
  if (characters.some(row => typeof row.character_id !== 'string' || !row.character_id.trim())) throw new Error('LEGACY_ROSTER_ID_INVALID')
  const facts = { characters,
    aliases: db.prepare('SELECT * FROM character_aliases ORDER BY character_id,name,source_key,valid_from').all(),
    relationships: db.prepare('SELECT * FROM character_relationships ORDER BY relationship_id').all() }
  return { snapshot: CharacterRosterRepository.read(db), rawLegacy, legacyHash: textHash(rawLegacy), identityRevision,
    activeIds: characters.filter(row => row.retired === 0).map(row => row.character_id), factsHash: textHash(JSON.stringify(facts)),
    genre: core.genre, writingLanguage: resolveWritingLanguage(core.writing_language) }
}

export function captureLegacyRosterContext(db: Database.Database): LegacyRosterSource {
  const source = readLegacyRosterSource(db)
  if (source.snapshot.migrationState !== 'legacy_markdown_pending' || source.snapshot.status !== 'legacy_repair_required'
    || source.activeIds.length !== 0 || source.snapshot.entries.length !== 0 || !source.rawLegacy.trim()) throw new Error('LEGACY_ROSTER_MODEL_SOURCE_REQUIRED')
  return source
}

export function adoptLegacyCards(db: Database.Database, request: AdoptLegacyCardsRequest): AdoptLegacyCardsReceipt {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['operationId','expectedRevision','expectedLegacyHash','expectedIdentityRevision','expectedFactsHash'].includes(key))
    || typeof request.operationId !== 'string' || !request.operationId.trim() || request.operationId.length > 200
    || !revision(request.expectedRevision) || !revision(request.expectedIdentityRevision) || !hash(request.expectedLegacyHash) || !hash(request.expectedFactsHash)) throw new Error('LEGACY_ROSTER_ADOPTION_INVALID')
  if (!hasCharacterIdentitySchema(db)) throw new Error('LEGACY_ROSTER_ID_SCHEMA_REQUIRED')
  const original: AdoptLegacyCardsRequest = { operationId:request.operationId, expectedRevision:request.expectedRevision,
    expectedLegacyHash:request.expectedLegacyHash, expectedIdentityRevision:request.expectedIdentityRevision, expectedFactsHash:request.expectedFactsHash }
  const requestHash = textHash(JSON.stringify(original)), operationId = prefix + request.operationId
  return db.transaction(() => {
    const previous = db.prepare('SELECT payload_hash,receipt_json FROM character_identity_approvals WHERE operation_id=?').get(operationId) as { payload_hash: string; receipt_json: string } | undefined
    if (previous) {
      const saved = JSON.parse(previous.receipt_json) as AdoptionEnvelope
      if (saved.version !== 1 || saved.kind !== 'legacy-cards-adoption' || saved.requestHash !== previous.payload_hash
        || textHash(JSON.stringify(saved.request)) !== saved.requestHash || saved.receiptHash !== textHash(JSON.stringify(saved.receipt))
        || saved.receipt?.success !== true || saved.receipt.operationId !== request.operationId || !Array.isArray(saved.receipt.activeIds)
        || saved.receipt.snapshot?.migrationState !== 'ready' || saved.receipt.snapshot.status !== 'ready') throw new Error('LEGACY_ROSTER_ADOPTION_RECEIPT_INVALID')
      if (requestHash !== saved.requestHash || !isDeepStrictEqual(original, saved.request)) throw new Error('LEGACY_ROSTER_ADOPTION_NONCE_CONFLICT')
      return structuredClone(saved.receipt)
    }
    const source = readLegacyRosterSource(db)
    if (source.snapshot.migrationState !== 'legacy_cards_preserved' || source.snapshot.status !== 'inconsistent' || source.activeIds.length === 0) throw new Error('LEGACY_ROSTER_CARDS_REQUIRED')
    if (source.snapshot.revision !== request.expectedRevision || source.identityRevision !== request.expectedIdentityRevision
      || source.legacyHash !== request.expectedLegacyHash || source.factsHash !== request.expectedFactsHash) throw new Error('LEGACY_ROSTER_ADOPTION_SOURCE_CHANGED')
    refreshCharacterIdentityProjection(db)
    const snapshot = CharacterRosterRepository.read(db)
    if (snapshot.status !== 'ready' || snapshot.migrationState !== 'ready' || snapshot.legacyMarkdown !== (source.rawLegacy || undefined)) throw new Error('LEGACY_ROSTER_ADOPTION_READBACK_INVALID')
    // Return the same JSON representation on the first ACK and every persisted replay.
    const receipt = JSON.parse(JSON.stringify({ success:true, operationId:request.operationId, snapshot, activeIds:source.activeIds })) as AdoptLegacyCardsReceipt
    const envelope: AdoptionEnvelope = { version:1, kind:'legacy-cards-adoption', request:original, requestHash, receipt, receiptHash:textHash(JSON.stringify(receipt)) }
    db.prepare('INSERT INTO character_identity_approvals(operation_id,payload_hash,receipt_json) VALUES(?,?,?)').run(operationId,requestHash,JSON.stringify(envelope))
    return structuredClone(receipt)
  }).immediate()
}
