import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'
import type {
  FinalizedCharacterStateCandidate,
  FinalizedCharacterStateDecisionReceipt,
  FinalizedCharacterStateDecisionRequest,
  FinalizedCharacterContext,
  PendingFinalizedCharacterStateCandidate,
  PendingFinalizedCharacterStateCandidateSummary,
  FinalizedCharacterReference,
  FinalizedCharacterStateResponse,
  FinalizedCharacterStateCommitReceipt,
  FinalizedContinuityFact,
  FinalizedContinuityProjection,
  FinalizedSourceIdentity,
  FinalizedSourceReadResult,
  FinalizedSourceSnapshot,
  SaveFinalizedCharacterStateCandidatesRequest,
  SaveFinalizedContinuityRequest,
} from '../../src/shared/finalized-continuity'
import {
  CHARACTER_STATE_TEXT_FIELDS,
  characterRosterIdentityKey,
  type CharacterStateTextField,
  type CharacterStateFieldProvenance,
} from '../../src/shared/character-roster'
import { decideDerivedPatch, type CharacterFieldSnapshot, type DerivedSourceOrder } from '../../src/shared/character-identity'
import { parseFinalizedCharacterStateResponse } from '../../src/shared/finalized-continuity'
import { hasCharacterIdentitySchema } from './character-repository'
import { refreshCharacterStateProjection } from './character-roster-repository'
import type { ProjectEpoch } from '../../src/shared/source-ref'

const FACT_CATEGORIES = new Set(['character-state', 'timeline', 'open-thread', 'plot'])
const CHARACTER_STATE_FIELDS = new Set<string>(CHARACTER_STATE_TEXT_FIELDS)
const STATE_COLUMNS: Record<CharacterStateTextField, string> = {
  location: 'cs_location', powerLevel: 'cs_power_level', physicalState: 'cs_physical_state',
  mentalState: 'cs_mental_state', keyItems: 'cs_key_items', recentEvents: 'cs_recent_events',
}
const FINALIZED_CHARACTER_SNAPSHOT_KIND = 'finalized-character-snapshot:v1'
interface FinalizedCharacterSnapshot {
  kind: typeof FINALIZED_CHARACTER_SNAPSHOT_KIND
  source: FinalizedSourceIdentity
  identityRevision: number
  characters: Array<FinalizedCharacterReference & { aliases: string[] }>
}
/** A read-only identity receipt, atomically indexed alongside the immutable outbox. */
export function freezeFinalizedCharacterSnapshot(db: BetterSqlite3.Database, source: FinalizedSourceIdentity): void {
  if (!db.inTransaction) throw new Error('FINALIZED_CHARACTER_TRANSACTION_REQUIRED')
  if (!hasCharacterIdentitySchema(db)) return
  const identityRevision = db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").pluck().get() as number
  const characters = (db.prepare('SELECT character_id,name FROM characters WHERE retired=0 ORDER BY character_id').all() as { character_id: string; name: string }[])
    .map(row => ({ characterId: row.character_id, displayNameSnapshot: row.name,
      aliases: (db.prepare('SELECT DISTINCT name FROM character_aliases WHERE character_id=? AND valid_from<=? AND (valid_through IS NULL OR valid_through>=?) ORDER BY name')
        .all(row.character_id, identityRevision, identityRevision) as { name: string }[]).map(alias => alias.name) }))
  const snapshot: FinalizedCharacterSnapshot = { kind: FINALIZED_CHARACTER_SNAPSHOT_KIND, source: structuredClone(source), identityRevision, characters }
  const raw = JSON.stringify(snapshot)
  db.prepare('INSERT INTO character_identity_proposals(proposal_id,source_key,source_hash,raw_value,candidate_ids_json) VALUES(?,?,?,?,?)')
    .run(`fcs:${source.finalizationId}`, FINALIZED_CHARACTER_SNAPSHOT_KIND, sha256(raw), raw, '[]')
}
function readFrozenCharacterSnapshot(db: BetterSqlite3.Database, source: FinalizedSourceIdentity): FinalizedCharacterSnapshot | null {
  if (!hasCharacterIdentitySchema(db)) return null
  const row = db.prepare('SELECT source_key,source_hash,raw_value FROM character_identity_proposals WHERE proposal_id=?').get(`fcs:${source.finalizationId}`) as {
    source_key: string; source_hash: string; raw_value: string
  } | undefined
  if (!row) return null
  const snapshot = JSON.parse(row.raw_value) as FinalizedCharacterSnapshot
  if (row.source_key !== FINALIZED_CHARACTER_SNAPSHOT_KIND || sha256(row.raw_value) !== row.source_hash
    || snapshot.kind !== FINALIZED_CHARACTER_SNAPSHOT_KIND || !sameSource(snapshot.source, source)
    || !Number.isSafeInteger(snapshot.identityRevision) || snapshot.identityRevision < 0 || !Array.isArray(snapshot.characters)
    || new Set(snapshot.characters.map(item => item.characterId)).size !== snapshot.characters.length
    || snapshot.characters.some(item => !item.characterId || typeof item.displayNameSnapshot !== 'string' || !Array.isArray(item.aliases)
      || item.aliases.some(alias => typeof alias !== 'string'))) throw new Error('FINALIZED_CHARACTER_SNAPSHOT_INVALID')
  return snapshot
}
function stateSnapshot(row: Record<string, unknown>, field: CharacterStateTextField, scope: ProjectEpoch): CharacterFieldSnapshot {
  const provenance = JSON.parse(String(row.cs_provenance || '{}')) as Record<string, CharacterStateFieldProvenance & { revision?: number; sourceOrder?: DerivedSourceOrder }>
  const stored = provenance[field]
  const fieldProvenance: CharacterStateFieldProvenance = stored?.kind === 'derived' ? { kind: 'derived', source: structuredClone(stored.source) }
    : stored?.kind === 'author' ? { kind: 'author', chapterNumber: stored.chapterNumber } : { kind: 'legacy' }
  const revision = stored?.revision ?? 0
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('FINALIZED_CHARACTER_FIELD_REVISION_INVALID')
  const value = String(row[STATE_COLUMNS[field]] ?? '')
  return { projectId: scope.projectId, epoch: scope.epoch, characterId: row.character_id as string, field, revision, value, valueHash: sha256(value), provenance: fieldProvenance,
    ...(stored?.sourceOrder ? { sourceOrder: structuredClone(stored.sourceOrder) } : {}) }
}

function normalizedFacts(value: unknown, chapterNumber: number): FinalizedContinuityFact[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('连续性事实参数无效')
  return value.map((input) => {
    if (!input || typeof input !== 'object') throw new Error('连续性事实参数无效')
    const fact = input as Record<string, unknown>
    const entities = Array.isArray(fact.entities)
      ? fact.entities.map(entity => typeof entity === 'string' ? entity.trim() : '')
      : []
    const statement = typeof fact.statement === 'string' ? fact.statement.trim() : ''
    const evidence = typeof fact.evidence === 'string' ? fact.evidence.trim() : ''
    if (
      !FACT_CATEGORIES.has(String(fact.category))
      || fact.sourceChapter !== chapterNumber
      || entities.length > 8
      || entities.some(entity => !entity || entity.length > 80)
      || !statement
      || statement.length > 280
      || !evidence
      || evidence.length > 240
    ) throw new Error('连续性事实参数无效')
    return {
      category: fact.category as FinalizedContinuityFact['category'],
      entities: [...new Set(entities)],
      statement,
      sourceChapter: chapterNumber,
      evidence,
      ...(Array.isArray(fact.characterRefs) ? { characterRefs: fact.characterRefs.map(value => {
        const ref = value as FinalizedCharacterReference
        if (!ref || typeof ref.characterId !== 'string' || !ref.characterId.trim() || typeof ref.displayNameSnapshot !== 'string'
          || !entities.includes(ref.displayNameSnapshot)) throw new Error('连续性角色身份参数无效')
        return { characterId: ref.characterId, displayNameSnapshot: ref.displayNameSnapshot }
      }) } : {}),
    }
  })
}

function parseFacts(value: string, chapterNumber: number): FinalizedContinuityFact[] {
  try {
    return normalizedFacts(JSON.parse(value) as unknown, chapterNumber)
  } catch {
    return []
  }
}

function parseCharacterStateCandidates(value: string): FinalizedCharacterStateCandidate[] {
  try {
    const parsed = JSON.parse(value) as unknown
    const pending = Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).version === 2
        && Array.isArray((parsed as Record<string, unknown>).pending)
        ? (parsed as { pending: unknown[] }).pending : []
    return pending.flatMap((input) => {
      if (!input || typeof input !== 'object') return []
      const candidate = input as Record<string, unknown>
      const boundKeys = ['candidateKey', 'source', 'expectedFieldRevision', 'expectedFieldValueHash']
      const hasBoundMetadata = boundKeys.some(key => Object.prototype.hasOwnProperty.call(candidate, key))
      const hasValidBoundMetadata = typeof candidate.candidateKey === 'string' && Boolean(candidate.candidateKey)
        && isFinalizedSource(candidate.source)
        && Number.isSafeInteger(candidate.expectedFieldRevision) && (candidate.expectedFieldRevision as number) >= 0
        && typeof candidate.expectedFieldValueHash === 'string' && /^[a-f0-9]{64}$/u.test(candidate.expectedFieldValueHash)
      if (hasBoundMetadata && !hasValidBoundMetadata) return []
      return typeof candidate.characterName === 'string'
        && Boolean(candidate.characterName.trim())
        && CHARACTER_STATE_FIELDS.has(String(candidate.field))
        && typeof candidate.value === 'string'
        ? [{
            ...(typeof candidate.characterId === 'string' && candidate.characterId ? { characterId: candidate.characterId } : {}),
            characterName: candidate.characterName.trim(),
            field: candidate.field as CharacterStateTextField,
            value: isFinalizedSource(candidate.source) ? candidate.value : candidate.value.trim(),
            ...(candidate.evidence ? { evidence: candidate.evidence as FinalizedCharacterStateCandidate['evidence'] } : {}),
            ...(typeof candidate.selectionKey === 'string' ? { selectionKey: candidate.selectionKey } : {}),
            ...(typeof candidate.displayName === 'string' ? { displayName: candidate.displayName } : {}),
            ...(candidate.rawValue !== undefined ? { rawValue: structuredClone(candidate.rawValue) } : {}),
            ...(candidate.reason === 'author-protected' || candidate.reason === 'legacy-protected' ? { reason: candidate.reason } : {}),
            ...(typeof candidate.candidateKey === 'string' ? { candidateKey: candidate.candidateKey } : {}),
            ...(isFinalizedSource(candidate.source) ? { source: structuredClone(candidate.source) } : {}),
            ...(Number.isSafeInteger(candidate.expectedFieldRevision) && (candidate.expectedFieldRevision as number) >= 0
              ? { expectedFieldRevision: candidate.expectedFieldRevision as number } : {}),
            ...(typeof candidate.expectedFieldValueHash === 'string' ? { expectedFieldValueHash: candidate.expectedFieldValueHash } : {}),
          }]
        : []
    })
  } catch {
    return []
  }
}

type StoredCharacterStateDecision = Omit<FinalizedCharacterStateDecisionReceipt, 'idempotent'>
interface CharacterStateCandidateStore { version: 2; pending: FinalizedCharacterStateCandidate[]; receipts: StoredCharacterStateDecision[] }

function parseCharacterStateCandidateStore(value: string): CharacterStateCandidateStore {
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return { version: 2, pending: parseCharacterStateCandidates(value), receipts: [] }
    if (!parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>).version !== 2
      || !Array.isArray((parsed as Record<string, unknown>).pending)
      || !Array.isArray((parsed as Record<string, unknown>).receipts)) return { version: 2, pending: [], receipts: [] }
    const pending = parseCharacterStateCandidates(value)
    const receipts = (parsed as { receipts: unknown[] }).receipts.flatMap(input => {
      if (!input || typeof input !== 'object') return []
      const receipt = input as Record<string, unknown>
      return typeof receipt.candidateKey === 'string' && receipt.candidateKey
        && typeof receipt.operationId === 'string' && receipt.operationId
        && typeof receipt.payloadHash === 'string' && /^[a-f0-9]{64}$/u.test(receipt.payloadHash)
        && (receipt.decision === 'accept' || receipt.decision === 'decline')
        && isFinalizedSource(receipt.source)
        ? [{ candidateKey: receipt.candidateKey, operationId: receipt.operationId, payloadHash: receipt.payloadHash,
            decision: receipt.decision as StoredCharacterStateDecision['decision'], source: structuredClone(receipt.source) }]
        : []
    })
    return { version: 2, pending, receipts }
  } catch {
    return { version: 2, pending: [], receipts: [] }
  }
}

function isFinalizedSource(value: unknown): value is FinalizedSourceIdentity {
  if (!value || typeof value !== 'object') return false
  const source = value as Record<string, unknown>
  return Number.isSafeInteger(source.draftId) && (source.draftId as number) > 0
    && Number.isSafeInteger(source.chapterNumber) && (source.chapterNumber as number) > 0
    && typeof source.finalizationId === 'string' && Boolean(source.finalizationId)
    && typeof source.contentHash === 'string' && /^[a-f0-9]{64}$/u.test(source.contentHash)
}

function normalizeCharacterStateCandidates(
  db: BetterSqlite3.Database,
  value: unknown,
  source?: FinalizedSourceIdentity,
): FinalizedCharacterStateCandidate[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error('角色状态候选参数无效')
  if (hasCharacterIdentitySchema(db)) {
    const frozen = source && readFrozenCharacterSnapshot(db, source)
    if (!frozen) throw new Error('FINALIZED_CHARACTER_SNAPSHOT_REQUIRED')
    return value.map((candidate: FinalizedCharacterStateCandidate) => {
      const character = frozen.characters.find(item => item.characterId === candidate.characterId)
      if (!character || candidate.characterName !== character.displayNameSnapshot || !CHARACTER_STATE_FIELDS.has(candidate.field)
        || typeof candidate.value !== 'string'
        || frozen.characters.filter(item => item.displayNameSnapshot === character.displayNameSnapshot).length !== 1) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
      const evidence = candidate.evidence
      const snapshot = readFinalizedSourceFromDb(db, source!.draftId)
      if (!evidence || !snapshot || !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end)
        || evidence.start < 0 || evidence.end <= evidence.start || evidence.end > snapshot.content.length
        || snapshot.content.slice(evidence.start, evidence.end) !== evidence.text) throw new Error('FINALIZED_CHARACTER_EVIDENCE_INVALID')
      if (!db.prepare('SELECT 1 FROM characters WHERE character_id=? AND retired=0').get(character.characterId)) throw new Error('FINALIZED_CHARACTER_ID_RETIRED')
      return structuredClone(candidate)
    })
  }
  const byIdentity = new Map<string, string>()
  for (const { name } of db.prepare('SELECT name FROM characters').all() as Array<{ name: string }>) {
    const identity = characterRosterIdentityKey(name)
    if (!identity || byIdentity.has(identity)) throw new Error('角色名单存在同名冲突')
    byIdentity.set(identity, name)
  }
  const normalized = new Map<string, FinalizedCharacterStateCandidate>()
  for (const input of value as FinalizedCharacterStateCandidate[]) {
    if (!input || typeof input !== 'object') throw new Error('角色状态候选参数无效')
    const characterName = typeof input.characterName === 'string' ? input.characterName.trim() : ''
    const storedName = byIdentity.get(characterRosterIdentityKey(characterName))
    if (!storedName || !CHARACTER_STATE_FIELDS.has(String(input.field)) || typeof input.value !== 'string') {
      throw new Error('角色状态候选参数无效')
    }
    const candidate = {
      characterName: storedName,
      field: input.field as CharacterStateTextField,
      value: input.value.trim(),
    }
    normalized.set(`${characterRosterIdentityKey(candidate.characterName)}\u0000${candidate.field}`, candidate)
  }
  return [...normalized.values()]
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sameSource(left: FinalizedSourceIdentity, right: FinalizedSourceIdentity): boolean {
  return left.draftId === right.draftId
    && left.finalizationId === right.finalizationId
    && left.chapterNumber === right.chapterNumber
    && left.contentHash === right.contentHash
}

function characterStateCandidateKey(source: FinalizedSourceIdentity, characterId: string, field: CharacterStateTextField, value: string): string {
  return `fcs-state:${sha256(JSON.stringify([source.draftId, source.finalizationId, source.contentHash, characterId, field, sha256(value)]))}`
}

function readFinalizedSourceFromDb(
  db: BetterSqlite3.Database,
  draftId: number,
): FinalizedSourceSnapshot | null {
  const row = db.prepare(`
    SELECT drafts.id AS draftId, drafts.chapter_number AS chapterNumber, drafts.status,
           contents.body AS content, finalization_outbox.finalization_id AS finalizationId,
           finalization_outbox.chapter_title AS chapterTitle,
           finalization_outbox.content_hash AS contentHash,
           finalization_outbox.content_snapshot AS contentSnapshot,
           continuity_projection_meta.generation AS projectionGeneration
    FROM drafts
    JOIN contents ON contents.id = drafts.content_id
    JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
    JOIN continuity_projection_meta ON continuity_projection_meta.id = 'main'
    WHERE drafts.id = ?
  `).get(draftId) as {
    draftId: number
    chapterNumber: number
    status: string
    content: string
    finalizationId: string
    chapterTitle: string
    contentHash: string
    contentSnapshot: string
    projectionGeneration: number
  } | undefined
  if (
    !row
    || row.status !== 'finalized'
    || !row.finalizationId.trim()
    || !/^[a-f0-9]{64}$/u.test(row.contentHash)
    || row.content !== row.contentSnapshot
    || sha256(row.contentSnapshot) !== row.contentHash
  ) return null
  return {
    source: {
      draftId: row.draftId,
      finalizationId: row.finalizationId,
      chapterNumber: row.chapterNumber,
      contentHash: row.contentHash,
    },
    chapterTitle: row.chapterTitle,
    content: row.contentSnapshot,
    projectionGeneration: row.projectionGeneration,
  }
}

interface CharacterStateCandidateRow {
  id: number
  draftId: number
  chapterNumber: number
  candidates: string
  finalizationId: string
  contentHash: string
  projectionGeneration: number
}

function readCurrentCharacterStateCandidateRow(db: BetterSqlite3.Database, draftId: number): CharacterStateCandidateRow {
  const row = db.prepare(`SELECT id,draft_id AS draftId,chapter_number AS chapterNumber,
    character_state_candidates AS candidates,source_finalization_id AS finalizationId,
    source_content_hash AS contentHash,projection_generation AS projectionGeneration
    FROM summary_snapshots WHERE draft_id=?`).get(draftId) as CharacterStateCandidateRow | undefined
  const snapshot = readFinalizedSourceFromDb(db, draftId)
  const source = row && { draftId: row.draftId, finalizationId: row.finalizationId,
    chapterNumber: row.chapterNumber, contentHash: row.contentHash }
  const latest = snapshot && db.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status='finalized' ORDER BY version DESC,id DESC LIMIT 1")
    .pluck().get(snapshot.source.chapterNumber) as number | undefined
  if (!row || !snapshot || !source || !sameSource(source, snapshot.source)
    || row.projectionGeneration !== snapshot.projectionGeneration || latest !== draftId) {
    throw new Error('FINALIZED_CHARACTER_STATE_SOURCE_CHANGED')
  }
  return row
}

function pendingCharacterStateCandidate(db: BetterSqlite3.Database, row: CharacterStateCandidateRow,
  candidate: FinalizedCharacterStateCandidate): PendingFinalizedCharacterStateCandidate | null {
  const source = { draftId: row.draftId, finalizationId: row.finalizationId,
    chapterNumber: row.chapterNumber, contentHash: row.contentHash }
  if (!candidate.characterId) return null
  const expectedKey = characterStateCandidateKey(source, candidate.characterId, candidate.field, candidate.value)
  const hasBoundMetadata = candidate.candidateKey !== undefined || candidate.source !== undefined
    || candidate.expectedFieldRevision !== undefined || candidate.expectedFieldValueHash !== undefined
  if (hasBoundMetadata && (!candidate.candidateKey || !candidate.source || !sameSource(candidate.source, source)
    || !Number.isSafeInteger(candidate.expectedFieldRevision) || candidate.expectedFieldRevision! < 0
    || !candidate.expectedFieldValueHash || !/^[a-f0-9]{64}$/u.test(candidate.expectedFieldValueHash)
    || candidate.candidateKey !== expectedKey)) return null
  const frozen = readFrozenCharacterSnapshot(db, source)
  if (!frozen || !frozen.characters.some(character => character.characterId === candidate.characterId
    && character.displayNameSnapshot === candidate.characterName)) return null
  if (hasBoundMetadata) return structuredClone(candidate) as PendingFinalizedCharacterStateCandidate
  const character = db.prepare('SELECT * FROM characters WHERE character_id=? AND retired=0').get(candidate.characterId) as Record<string, unknown> | undefined
  if (!character) return null
  const current = stateSnapshot(character, candidate.field, { projectId: 'candidate-upgrade', epoch: 'candidate-upgrade' })
  return { ...structuredClone(candidate), candidateKey: expectedKey, source, expectedFieldRevision: current.revision,
    expectedFieldValueHash: current.valueHash } as PendingFinalizedCharacterStateCandidate
}

function stateDecisionPayloadHash(request: FinalizedCharacterStateDecisionRequest): string {
  return sha256(JSON.stringify([request.draftId, request.candidateKey, request.characterId, request.field,
    request.expectedFieldRevision, request.expectedFieldValueHash, request.operationId, request.decision]))
}

export function invalidateContinuityProjectionFrom(
  db: BetterSqlite3.Database,
  chapterNumber: number,
): void {
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error('连续性投影失效章节无效')
  }
  db.prepare(`
    UPDATE continuity_projection_meta
    SET generation = generation + 1,
        stale_from_chapter = CASE
          WHEN stale_from_chapter IS NULL OR stale_from_chapter > ? THEN ?
          ELSE stale_from_chapter
        END
    WHERE id = 'main'
  `).run(chapterNumber, chapterNumber)
}

export class SummaryRepository {
  static readFinalizedCharacterContext(draftId: number, scope: ProjectEpoch, database = getProjectDb()): FinalizedCharacterContext {
    if (!database || !scope.projectId?.trim() || !scope.epoch?.trim()) throw new Error('FINALIZED_CHARACTER_SCOPE_REQUIRED')
    const db = database
    return db.transaction(() => {
      const source = readFinalizedSourceFromDb(db, draftId)
      if (!source) throw new Error('FINALIZED_CHARACTER_SOURCE_CHANGED')
      const latest = db.prepare("SELECT id,version FROM drafts WHERE chapter_number=? AND status='finalized' ORDER BY version DESC,id DESC LIMIT 1")
        .get(source.source.chapterNumber) as { id: number; version: number } | undefined
      if (!latest || latest.id !== draftId) throw new Error('FINALIZED_CHARACTER_SOURCE_CHANGED')
      const frozen = readFrozenCharacterSnapshot(db, source.source)
      const characters = (frozen?.characters ?? []).map(character => {
        const row = db.prepare('SELECT * FROM characters WHERE character_id=? AND retired=0').get(character.characterId) as Record<string, unknown> | undefined
        if (!row) throw new Error('FINALIZED_CHARACTER_ID_RETIRED')
        return { ...structuredClone(character), fields: CHARACTER_STATE_TEXT_FIELDS.map(field => stateSnapshot(row, field, scope)) }
      })
      return { projectId: scope.projectId, epoch: scope.epoch, source: source.source, content: source.content, projectionGeneration: source.projectionGeneration,
        identityRevision: frozen?.identityRevision ?? 0, identityStatus: frozen ? 'bound' as const : 'legacy' as const,
        sourceOrder: { continuityEpoch: `${scope.projectId}:${source.projectionGeneration}`, chapterNumber: source.source.chapterNumber,
          authoritativeFinalizationRevision: latest.version }, characters }
    })()
  }

  static commitFinalizedCharacterStates(context: FinalizedCharacterContext, response: FinalizedCharacterStateResponse, database = getProjectDb()): FinalizedCharacterStateCommitReceipt {
    if (!database) throw new Error('项目数据库未打开')
    const db = database
    return db.transaction(() => {
      const current = SummaryRepository.readFinalizedCharacterContext(context.source.draftId, context, db)
      const identity = (value: FinalizedCharacterContext) => ({ source: value.source, content: value.content, projectionGeneration: value.projectionGeneration,
        identityRevision: value.identityRevision, identityStatus: value.identityStatus, sourceOrder: value.sourceOrder,
        characters: value.characters.map(({ fields: _fields, ...character }) => { void _fields; return character }) })
      if (!isDeepStrictEqual(identity(current), identity(context)) || context.characters.some(character => character.fields.some(field =>
        field.characterId !== character.characterId || field.projectId !== context.projectId || field.epoch !== context.epoch))) throw new Error('FINALIZED_CHARACTER_CONTEXT_CHANGED')
      const verified = parseFinalizedCharacterStateResponse(JSON.stringify({ updates: response.updates }), context)
      if (verified.unresolved.length) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
      const receipt: FinalizedCharacterStateCommitReceipt = { applied: 0, unchanged: 0, candidates: [] }
      for (const update of verified.updates) {
        const captured = context.characters.find(item => item.characterId === update.characterId)!
        const currentCharacter = current.characters.find(item => item.characterId === update.characterId)!
        const row = db.prepare('SELECT cs_provenance FROM characters WHERE character_id=? AND retired=0').get(update.characterId) as { cs_provenance: string }
        const provenance = JSON.parse(row.cs_provenance || '{}') as Record<string, unknown>
        let changed = false
        for (const field of CHARACTER_STATE_TEXT_FIELDS) {
          if (!Object.hasOwn(update.currentState, field)) continue
          const base = captured.fields.find(item => item.field === field), actual = currentCharacter.fields.find(item => item.field === field)!
          if (!base || base.valueHash !== sha256(base.value)) throw new Error('FINALIZED_CHARACTER_CONTEXT_CHANGED')
          const value = update.currentState[field]!
          const decision = decideDerivedPatch(actual, { projectId: context.projectId, epoch: context.epoch, characterId: update.characterId, field, value, valueHash: sha256(value),
            baseFieldRevision: base.revision, baseValueHash: base.valueHash, baseProvenance: base.provenance,
            source: context.source, sourceOrder: context.sourceOrder }, { source: current.source, order: current.sourceOrder })
          if (decision === 'source-conflict' || decision === 'field-conflict') throw new Error(`FINALIZED_CHARACTER_${decision === 'source-conflict' ? 'SOURCE' : 'FIELD'}_CONFLICT`)
          if (decision === 'already-applied') { receipt.unchanged++; continue }
          if (decision === 'proposal-required') {
            if (value === actual.value) { receipt.unchanged++; continue }
            receipt.candidates.push({ candidateKey: characterStateCandidateKey(context.source, update.characterId, field, value), source: structuredClone(context.source),
              expectedFieldRevision: actual.revision, expectedFieldValueHash: actual.valueHash,
              characterId: update.characterId, characterName: captured.displayNameSnapshot, displayName: captured.displayNameSnapshot,
              selectionKey: `state:${update.characterId}:${field}`, field, value, evidence: update.evidence, rawValue: structuredClone(update),
              reason: actual.provenance.kind === 'author' ? 'author-protected' : 'legacy-protected' })
            continue
          }
          db.prepare(`UPDATE characters SET ${STATE_COLUMNS[field]}=? WHERE character_id=? AND retired=0`).run(value, update.characterId)
          provenance[field] = { kind: 'derived', source: structuredClone(context.source), revision: actual.revision + 1, sourceOrder: structuredClone(context.sourceOrder) }
          receipt.applied++; changed = true
        }
        if (changed) db.prepare("UPDATE characters SET cs_provenance=?,cs_updated_at_chapter=MAX(COALESCE(cs_updated_at_chapter,0),?),updated_at=datetime('now') WHERE character_id=?")
          .run(JSON.stringify(provenance), context.source.chapterNumber, update.characterId)
      }
      if (receipt.candidates.length) SummaryRepository.saveFinalizedCharacterStateCandidates({ draftId: context.source.draftId, chapterNumber: context.source.chapterNumber,
        projectionGeneration: context.projectionGeneration, source: context.source, candidates: receipt.candidates }, db)
      if (receipt.applied) refreshCharacterStateProjection(db)
      return receipt
    }).immediate()
  }

  static listPendingFinalizedCharacterStateCandidates(database = getProjectDb()): PendingFinalizedCharacterStateCandidateSummary[] {
    if (!database) return []
    const rows = database.prepare("SELECT draft_id AS draftId FROM summary_snapshots WHERE character_state_candidates<>'[]'")
      .all() as Array<{ draftId: number }>
    return rows.flatMap(({ draftId }) => {
      try {
        const row = readCurrentCharacterStateCandidateRow(database, draftId)
        return parseCharacterStateCandidateStore(row.candidates).pending.flatMap(candidate => {
          const pending = pendingCharacterStateCandidate(database, row, candidate)
          return pending ? [{ draftId, candidateKey: pending.candidateKey, finalizationId: pending.source.finalizationId,
            characterId: pending.characterId, characterName: pending.characterName, field: pending.field }] : []
        })
      } catch {
        return []
      }
    }).sort((left, right) => left.draftId - right.draftId || left.candidateKey.localeCompare(right.candidateKey))
  }

  static readPendingFinalizedCharacterStateCandidate(draftId: number, candidateKey: string,
    database = getProjectDb()): PendingFinalizedCharacterStateCandidate {
    if (!database || !Number.isSafeInteger(draftId) || draftId < 1 || !candidateKey?.trim()) {
      throw new Error('FINALIZED_CHARACTER_STATE_CANDIDATE_INVALID')
    }
    return database.transaction(() => {
      const row = readCurrentCharacterStateCandidateRow(database, draftId)
      const store = parseCharacterStateCandidateStore(row.candidates)
      const index = store.pending.findIndex(item => pendingCharacterStateCandidate(database, row, item)?.candidateKey === candidateKey)
      if (index < 0) throw new Error('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
      const candidate = pendingCharacterStateCandidate(database, row, store.pending[index])!
      if (!store.pending[index].candidateKey) {
        store.pending[index] = candidate
        database.prepare('UPDATE summary_snapshots SET character_state_candidates=?,created_at=datetime(\'now\') WHERE id=?')
          .run(JSON.stringify(store), row.id)
      }
      return candidate
    }).immediate()
  }

  static decideFinalizedCharacterStateCandidate(request: FinalizedCharacterStateDecisionRequest,
    database = getProjectDb()): FinalizedCharacterStateDecisionReceipt {
    if (!database || !request || !Number.isSafeInteger(request.draftId) || request.draftId < 1
      || !request.candidateKey?.trim() || !request.characterId?.trim() || !CHARACTER_STATE_FIELDS.has(request.field)
      || !Number.isSafeInteger(request.expectedFieldRevision) || request.expectedFieldRevision < 0
      || !/^[a-f0-9]{64}$/u.test(request.expectedFieldValueHash) || !request.operationId?.trim()
      || request.decision !== 'accept' && request.decision !== 'decline') {
      throw new Error('FINALIZED_CHARACTER_STATE_DECISION_INVALID')
    }
    const db = database
    return db.transaction(() => {
      const payloadHash = stateDecisionPayloadHash(request)
      const receiptRows = db.prepare("SELECT character_state_candidates AS candidates FROM summary_snapshots WHERE character_state_candidates<>'[]'")
        .all() as Array<{ candidates: string }>
      const replay = receiptRows.flatMap(item => parseCharacterStateCandidateStore(item.candidates).receipts)
        .find(receipt => receipt.operationId === request.operationId)
      if (replay) {
        if (replay.payloadHash !== payloadHash) throw new Error('FINALIZED_CHARACTER_STATE_OPERATION_CONFLICT')
        return { ...structuredClone(replay), idempotent: true }
      }
      const row = readCurrentCharacterStateCandidateRow(db, request.draftId)
      const store = parseCharacterStateCandidateStore(row.candidates)
      const candidate = store.pending.map(item => pendingCharacterStateCandidate(db, row, item))
        .find((item): item is PendingFinalizedCharacterStateCandidate => item?.candidateKey === request.candidateKey)
      if (!candidate || candidate.characterId !== request.characterId || candidate.field !== request.field
        || candidate.expectedFieldRevision !== request.expectedFieldRevision
        || candidate.expectedFieldValueHash !== request.expectedFieldValueHash) {
        throw new Error('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
      }
      if (request.decision === 'accept') {
        const character = db.prepare('SELECT * FROM characters WHERE character_id=? AND retired=0').get(candidate.characterId) as Record<string, unknown> | undefined
        if (!character) throw new Error('FINALIZED_CHARACTER_STATE_CANDIDATE_NOT_FOUND')
        const current = stateSnapshot(character, candidate.field, { projectId: 'candidate-decision', epoch: 'candidate-decision' })
        if (current.revision !== request.expectedFieldRevision || current.valueHash !== request.expectedFieldValueHash) {
          throw new Error('FINALIZED_CHARACTER_STATE_FIELD_CONFLICT')
        }
        const provenance = JSON.parse(String(character.cs_provenance || '{}')) as Record<string, unknown>
        provenance[candidate.field] = { kind: 'author', chapterNumber: candidate.source.chapterNumber, revision: current.revision + 1 }
        const updated = db.prepare(`UPDATE characters SET ${STATE_COLUMNS[candidate.field]}=?,cs_provenance=?,
          cs_updated_at_chapter=MAX(COALESCE(cs_updated_at_chapter,0),?),updated_at=datetime('now')
          WHERE character_id=? AND retired=0`).run(candidate.value, JSON.stringify(provenance), candidate.source.chapterNumber, candidate.characterId)
        if (updated.changes !== 1) throw new Error('FINALIZED_CHARACTER_STATE_FIELD_CONFLICT')
        refreshCharacterStateProjection(db)
      }
      const receipt: StoredCharacterStateDecision = { candidateKey: candidate.candidateKey,
        operationId: request.operationId, payloadHash, decision: request.decision, source: structuredClone(candidate.source) }
      store.pending = store.pending.filter(item => item.candidateKey !== candidate.candidateKey)
      store.receipts.push(receipt)
      db.prepare('UPDATE summary_snapshots SET character_state_candidates=?,created_at=datetime(\'now\') WHERE id=?')
        .run(JSON.stringify(store), row.id)
      return { ...structuredClone(receipt), idempotent: false }
    }).immediate()
  }

  static saveFinalizedContinuity(input: SaveFinalizedContinuityRequest, db = getProjectDb()): void {
    if (!db) throw new Error('项目数据库未打开')
    const chapterNotes = input.chapterNotes.trim()
    const normalized = normalizedFacts(input.facts ?? [], input.chapterNumber)
    const facts = JSON.stringify(normalized)
    if (
      !Number.isSafeInteger(input.draftId)
      || input.draftId < 1
      || !Number.isSafeInteger(input.chapterNumber)
      || input.chapterNumber < 1
      || !Number.isSafeInteger(input.projectionGeneration)
      || input.projectionGeneration < 0
      || !chapterNotes
    ) throw new Error('连续性投影参数无效')

    db.transaction(() => {
      const snapshot = readFinalizedSourceFromDb(db, input.draftId)
      if (!snapshot || !sameSource(snapshot.source, input.source) || input.chapterNumber !== snapshot.source.chapterNumber) {
        throw new Error('连续性投影来源已失效，已拒绝过期结果')
      }
      if (normalized.some(fact => !snapshot.content.includes(fact.evidence))) {
        throw new Error('连续性事实引文无法在绑定定稿正文中精确定位')
      }
      if (hasCharacterIdentitySchema(db)) {
        const identities = readFrozenCharacterSnapshot(db, snapshot.source)
        for (const fact of normalized) {
          // Entities also include objects and places. A readable tag is not a
          // character association; only a source-bound characterRef is one.
          if (fact.characterRefs?.some(ref => !identities?.characters.some(character => character.characterId === ref.characterId
            && character.displayNameSnapshot === ref.displayNameSnapshot))) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
          if (fact.entities.some(entity => {
            if (!identities?.characters.some(character => character.displayNameSnapshot === entity)) return false
            const refs = fact.characterRefs?.filter(ref => ref.displayNameSnapshot === entity) ?? []
            return refs.length !== 1 || !identities?.characters.some(character => character.characterId === refs[0].characterId
              && character.displayNameSnapshot === entity)
              || identities.characters.filter(character => character.displayNameSnapshot === entity).length !== 1
          })) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
        }
      }
      const generation = (db.prepare(`
        SELECT generation FROM continuity_projection_meta WHERE id = 'main'
      `).get() as { generation: number }).generation
      if (input.projectionGeneration !== generation) {
        throw new Error('连续性投影失效水位已推进，已拒绝过期结果')
      }
      const updated = db.prepare(`
        UPDATE summary_snapshots
        SET chapter_number = ?, chapter_notes = ?, continuity_facts = ?,
            source_finalization_id = ?, source_content_hash = ?, projection_generation = ?,
            created_at = datetime('now')
        WHERE draft_id = ?
      `).run(
        input.chapterNumber,
        chapterNotes,
        facts,
        input.source.finalizationId,
        input.source.contentHash,
        input.projectionGeneration,
        input.draftId,
      )
      if (updated.changes === 0) {
        db.prepare(`
          INSERT INTO summary_snapshots (
            draft_id, chapter_number, chapter_notes, continuity_facts,
            source_finalization_id, source_content_hash, projection_generation
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.draftId,
          input.chapterNumber,
          chapterNotes,
          facts,
          input.source.finalizationId,
          input.source.contentHash,
          input.projectionGeneration,
        )
      }
    })()
  }

  static saveFinalizedCharacterStateCandidates(input: SaveFinalizedCharacterStateCandidatesRequest, db = getProjectDb()): void {
    if (!db) throw new Error('项目数据库未打开')
    if (
      !Number.isSafeInteger(input.draftId)
      || input.draftId < 1
      || !Number.isSafeInteger(input.chapterNumber)
      || input.chapterNumber < 1
      || !Number.isSafeInteger(input.projectionGeneration)
      || input.projectionGeneration < 0
    ) throw new Error('角色状态候选参数无效')

    db.transaction(() => {
      const snapshot = readFinalizedSourceFromDb(db, input.draftId)
      if (!snapshot || !sameSource(snapshot.source, input.source) || input.chapterNumber !== snapshot.source.chapterNumber) {
        throw new Error('角色状态候选来源已失效，已拒绝过期结果')
      }
      if (input.projectionGeneration !== snapshot.projectionGeneration) {
        throw new Error('连续性投影失效水位已推进，已拒绝过期结果')
      }
      const row = db.prepare(`
        SELECT character_state_candidates AS candidates,
               source_finalization_id AS finalizationId,
               source_content_hash AS contentHash,
               projection_generation AS projectionGeneration
        FROM summary_snapshots
        WHERE draft_id = ?
      `).get(input.draftId) as {
        candidates: string
        finalizationId: string
        contentHash: string
        projectionGeneration: number
      } | undefined
      if (
        !row
        || row.finalizationId !== input.source.finalizationId
        || row.contentHash !== input.source.contentHash
        || row.projectionGeneration !== input.projectionGeneration
      ) throw new Error('角色状态候选缺少同代定稿连续性投影')

      const store = parseCharacterStateCandidateStore(row.candidates)
      const merged = new Map<string, FinalizedCharacterStateCandidate>()
      for (const candidate of [
        ...store.pending,
        ...normalizeCharacterStateCandidates(db, input.candidates, input.source),
      ]) {
        if (candidate.candidateKey && store.receipts.some(receipt => receipt.candidateKey === candidate.candidateKey)) continue
        merged.set(`${candidate.characterId ?? `legacy:${characterRosterIdentityKey(candidate.characterName)}`}\u0000${candidate.field}`, candidate)
      }
      store.pending = [...merged.values()]
      db.prepare(`
        UPDATE summary_snapshots
        SET character_state_candidates = ?, created_at = datetime('now')
        WHERE draft_id = ?
      `).run(JSON.stringify(store), input.draftId)
    })()
  }

  static listFinalizedContinuityBefore(chapterNumber: number, db = getProjectDb()): FinalizedContinuityProjection[] {
    if (!db) return []
    if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
      throw new Error('连续性投影目标章节无效')
    }
    const rows = db.prepare(`
      SELECT summary_snapshots.draft_id AS draftId,
             summary_snapshots.chapter_number AS chapterNumber,
             COALESCE(current_outbox.chapter_title, '') AS chapterTitle,
             summary_snapshots.chapter_notes AS chapterNotes,
             summary_snapshots.continuity_facts AS continuityFacts,
             summary_snapshots.character_state_candidates AS characterStateCandidates,
             summary_snapshots.source_finalization_id AS sourceFinalizationId,
             summary_snapshots.source_content_hash AS sourceContentHash,
             summary_snapshots.projection_generation AS projectionGeneration,
             current_drafts.id AS currentDraftId,
             current_drafts.status AS currentDraftStatus,
             current_outbox.finalization_id AS currentFinalizationId,
             current_outbox.content_hash AS currentContentHash,
             current_outbox.content_snapshot AS contentSnapshot,
             current_contents.body AS currentContent,
             continuity_projection_meta.generation AS currentGeneration,
             continuity_projection_meta.stale_from_chapter AS staleFromChapter
      FROM summary_snapshots
      JOIN drafts ON drafts.id = summary_snapshots.draft_id
      JOIN contents ON contents.id = drafts.content_id
      LEFT JOIN drafts current_drafts ON current_drafts.chapter_number = drafts.chapter_number
        AND current_drafts.status = 'finalized'
        AND NOT EXISTS (
          SELECT 1 FROM drafts newer
          WHERE newer.chapter_number = current_drafts.chapter_number
            AND newer.status = 'finalized'
            AND (newer.version > current_drafts.version OR (newer.version = current_drafts.version AND newer.id > current_drafts.id))
        )
      LEFT JOIN contents current_contents ON current_contents.id = current_drafts.content_id
      LEFT JOIN finalization_outbox current_outbox ON current_outbox.draft_id = current_drafts.id
      JOIN continuity_projection_meta ON continuity_projection_meta.id = 'main'
      WHERE summary_snapshots.draft_id IS NOT NULL
        AND summary_snapshots.chapter_number < ?
        AND summary_snapshots.chapter_notes <> ''
        AND drafts.status = 'finalized'
        AND NOT EXISTS (
          SELECT 1 FROM summary_snapshots newer_summary
          WHERE newer_summary.chapter_number = summary_snapshots.chapter_number
            AND newer_summary.chapter_notes <> '' AND newer_summary.id > summary_snapshots.id
        )
      ORDER BY summary_snapshots.chapter_number ASC, summary_snapshots.draft_id ASC
    `).all(chapterNumber) as Array<Omit<FinalizedContinuityProjection, 'facts' | 'characterStateCandidates' | 'source' | 'sourceStatus'> & {
      continuityFacts: string
      characterStateCandidates: string
      sourceFinalizationId: string
      sourceContentHash: string
      projectionGeneration: number
      currentDraftId: number | null
      currentDraftStatus: string | null
      currentFinalizationId: string | null
      currentContentHash: string | null
      contentSnapshot: string | null
      currentContent: string
      currentGeneration: number
      staleFromChapter: number | null
    }>
    return rows.map((row) => {
      const hasBoundSource = Boolean(row.sourceFinalizationId && row.sourceContentHash)
      const sourceCurrent = hasBoundSource
        && row.currentFinalizationId === row.sourceFinalizationId
        && row.currentContentHash === row.sourceContentHash
        && row.contentSnapshot === row.currentContent
        && sha256(row.currentContent) === row.currentContentHash
      const fallbackCurrent = Number.isSafeInteger(row.currentDraftId) && row.currentDraftId! > 0
        && row.currentDraftStatus === 'finalized' && typeof row.currentContent === 'string'
        && typeof row.contentSnapshot === 'string' && row.contentSnapshot === row.currentContent
        && typeof row.currentContentHash === 'string' && sha256(row.currentContent) === row.currentContentHash
      const invalidated = row.staleFromChapter !== null
        && row.chapterNumber >= row.staleFromChapter
        && row.projectionGeneration < row.currentGeneration
      const facts = parseFacts(row.continuityFacts, row.chapterNumber)
      const candidates = parseCharacterStateCandidates(row.characterStateCandidates)
      const source = { draftId: row.draftId, finalizationId: row.sourceFinalizationId,
        chapterNumber: row.chapterNumber, contentHash: row.sourceContentHash }
      let identityStatus: 'current' | 'legacy' | 'stale' = 'current'
      if (hasCharacterIdentitySchema(db) && sourceCurrent) {
        try {
          const frozen = readFrozenCharacterSnapshot(db, source)
          if (!frozen || facts.some(fact => fact.entities.some(entity => frozen.characters.some(character => character.displayNameSnapshot === entity)
            && !fact.characterRefs?.some(ref => ref.displayNameSnapshot === entity)))
            || candidates.some(candidate => !candidate.characterId)) identityStatus = 'legacy'
          else {
            const bound = (characterId: string, displayName: string) => frozen.characters.some(character => character.characterId === characterId
              && character.displayNameSnapshot === displayName)
              && frozen.characters.filter(character => character.displayNameSnapshot === displayName).length === 1
            if (facts.some(fact => fact.characterRefs?.some(ref => !bound(ref.characterId, ref.displayNameSnapshot)) || fact.entities.some(entity => {
              if (!frozen.characters.some(character => character.displayNameSnapshot === entity)) return false
              const refs = fact.characterRefs?.filter(ref => ref.displayNameSnapshot === entity) ?? []
              return refs.length !== 1 || !bound(refs[0].characterId, entity)
            })) || candidates.some(candidate => !bound(candidate.characterId!, candidate.characterName))) identityStatus = 'stale'
          }
        } catch { identityStatus = 'stale' }
      }
      return {
        draftId: row.draftId,
        ...(!sourceCurrent && fallbackCurrent ? { currentFinalizedDraftId: row.currentDraftId! } : {}),
        chapterNumber: row.chapterNumber,
        chapterTitle: row.chapterTitle,
        chapterNotes: row.chapterNotes,
        facts,
        ...(candidates.length > 0 ? { characterStateCandidates: candidates } : {}),
        ...(hasBoundSource ? {
          source: {
            draftId: row.draftId,
            finalizationId: row.sourceFinalizationId,
            chapterNumber: row.chapterNumber,
            contentHash: row.sourceContentHash,
          },
        } : {}),
        sourceStatus: !hasBoundSource ? 'legacy' : sourceCurrent && !invalidated ? identityStatus : 'stale',
      }
    })
  }

  /** Raw immutable prose is the deterministic fallback when a derived projection is stale. */
  static readFinalizedSource(draftId: number): FinalizedSourceReadResult {
    const db = getProjectDb()
    if (!db) return { status: 'invalid' }
    if (!Number.isSafeInteger(draftId) || draftId < 1) throw new Error('定稿来源身份无效')
    const row = db.prepare(`
      SELECT drafts.id AS draftId, drafts.chapter_number AS chapterNumber, drafts.status,
             contents.body AS content,
             COALESCE(finalization_outbox.chapter_title, blueprints.title, '') AS chapterTitle,
             finalization_outbox.draft_id AS receiptDraftId,
             finalization_outbox.finalization_id AS finalizationId
      FROM drafts
      JOIN contents ON contents.id = drafts.content_id
      LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      LEFT JOIN blueprints ON blueprints.chapter_number = drafts.chapter_number
      WHERE drafts.id = ?
    `).get(draftId) as {
      draftId: number
      chapterNumber: number
      status: string
      content: string
      chapterTitle: string
      receiptDraftId: number | null
      finalizationId: string | null
    } | undefined
    if (!row || row.status !== 'finalized') return { status: 'invalid' }
    if (row.receiptDraftId === null) {
      return {
        status: 'legacy',
        draftId: row.draftId,
        chapterNumber: row.chapterNumber,
        chapterTitle: row.chapterTitle,
        content: row.content,
      }
    }
    const snapshot = readFinalizedSourceFromDb(db, draftId)
    return snapshot ? { status: 'valid', snapshot } : { status: 'invalid' }
  }

  /** 保存角色状态快照 */
  static saveSnapshot(chapterNumber: number, characterStates: string): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(`
      INSERT INTO summary_snapshots (chapter_number, character_states)
      VALUES (?, ?)
    `).run(chapterNumber, characterStates)
  }

  /** 获取最新角色状态快照 */
  static getLatestSnapshot(): { characterStates: string; chapterNumber: number } | null {
    const db = getProjectDb()
    if (!db) return null
    const row = db.prepare(
      `SELECT character_states AS characterStates, chapter_number AS chapterNumber
       FROM summary_snapshots
       WHERE draft_id IS NULL
       ORDER BY id DESC LIMIT 1`,
    ).get() as { characterStates: string; chapterNumber: number } | undefined
    return row ?? null
  }
}
