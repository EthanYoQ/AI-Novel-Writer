import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { CHARACTER_ROSTER_SCHEMA_VERSION, CHARACTER_STATE_TEXT_FIELDS,
  type CharacterRosterCommitRequest, type CharacterRosterCommitReceipt, type CharacterRosterEntry,
  type CharacterRosterCharacterState } from '../../src/shared/character-roster'
import { CharacterRosterRepository, commitCharacterIdentities, normalizeAuthorRosterEntry,
  refreshCharacterIdentityProjection, type CharacterIdentityCommitRequest } from '../repositories/character-roster-repository'
import { hasCharacterIdentitySchema } from '../repositories/character-repository'

const fields = ['name', 'role', 'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes'] as const
const columns = { location: 'cs_location', powerLevel: 'cs_power_level', physicalState: 'cs_physical_state',
  mentalState: 'cs_mental_state', keyItems: 'cs_key_items', recentEvents: 'cs_recent_events' } as const
const draftId = /^draft:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
type AuthorEntry = CharacterRosterEntry & { characterId: string }
interface AuthorRequest { operationId: string; expectedRevision: number; expectedIdentityRevision: number; entries: AuthorEntry[] }
interface Envelope { version: 1; kind: 'author-roster'; requestHash: string; receipt: CharacterRosterCommitReceipt;
  receiptHash: string; approvalId: string; approvalPayloadHash: string; approvalReceiptHash: string }

function normalize(candidate: CharacterRosterCommitRequest): AuthorRequest {
  if (!candidate || candidate.intent !== 'manual_edit' || candidate.schemaVersion !== CHARACTER_ROSTER_SCHEMA_VERSION
    || !nonempty(candidate.operationId) || candidate.operationId.length > 200 || !revision(candidate.expectedRevision)
    || !revision(candidate.expectedIdentityRevision) || !Array.isArray(candidate.entries)
    || candidate.generationRunHandle || candidate.source || candidate.expectedLegacyMarkdown !== undefined) throw new Error('CHARACTER_AUTHOR_REQUEST_INVALID')
  const entries = candidate.entries.map(raw => {
    if (!raw || !nonempty(raw.characterId) || !Array.isArray(raw.relationships)) throw new Error('CHARACTER_ID_WRITE_REQUIRED')
    const entry = normalizeAuthorRosterEntry(raw) as AuthorEntry
    entry.characterId = raw.characterId
    // Validation must not trim unchanged author fields or rewrite preserved legacy text.
    for (const field of fields) if (typeof raw[field] === 'string') Object.assign(entry, { [field]: raw[field] })
    if (raw.legacyRelationshipNotes !== undefined) {
      if (typeof raw.legacyRelationshipNotes !== 'string') throw new Error('CHARACTER_AUTHOR_ENTRY_INVALID')
      entry.legacyRelationshipNotes = raw.legacyRelationshipNotes
    }
    if (entry.currentState && raw.currentState) for (const field of CHARACTER_STATE_TEXT_FIELDS) entry.currentState[field] = raw.currentState[field]
    entry.relationships = raw.relationships.map(relation => {
      if (!relation || !nonempty(relation.targetCharacterId) || !nonempty(relation.relation)) throw new Error('CHARACTER_RELATIONSHIP_ID_REQUIRED')
      return { targetCharacterId: relation.targetCharacterId, target: '', relation: relation.relation }
    }).sort((a, b) => JSON.stringify([a.targetCharacterId, a.relation]).localeCompare(JSON.stringify([b.targetCharacterId, b.relation])))
    return entry
  }).sort((a, b) => a.characterId.localeCompare(b.characterId))
  const byId = new Map(entries.map(entry => [entry.characterId, entry]))
  if (byId.size !== entries.length) throw new Error('CHARACTER_ID_DUPLICATE')
  for (const entry of entries) {
    const seen = new Set<string>()
    for (const relation of entry.relationships) {
      const target = byId.get(relation.targetCharacterId!)
      const key = JSON.stringify([relation.targetCharacterId, relation.relation])
      if (!target || target.characterId === entry.characterId || seen.has(key)) throw new Error('CHARACTER_RELATIONSHIP_INVALID')
      relation.target = target.name; seen.add(key)
    }
  }
  if (candidate.renames !== undefined && (!Array.isArray(candidate.renames) || candidate.renames.some(rename =>
    !rename || !nonempty(rename.characterId) || !byId.has(rename.characterId) || byId.get(rename.characterId)!.name !== rename.newName))) throw new Error('CHARACTER_ID_WRITE_REQUIRED')
  return { operationId: candidate.operationId, expectedRevision: candidate.expectedRevision,
    expectedIdentityRevision: candidate.expectedIdentityRevision, entries }
}

/** Called only by the captured main project-session author IPC. No generation or name-only admission. */
export function commitAuthorCharacterRoster(db: Database.Database, candidate: CharacterRosterCommitRequest,
  scope: { projectId: string; epoch: string }, assertCurrent: () => void): CharacterRosterCommitReceipt {
  if (!hasCharacterIdentitySchema(db) || !nonempty(scope.projectId) || !nonempty(scope.epoch)) throw new Error('CHARACTER_AUTHOR_SCOPE_REQUIRED')
  const request = normalize(candidate), requestHash = hash(JSON.stringify({ projectId: scope.projectId, request }))
  const operationKey = `author-roster-request:${request.operationId}`, approvalId = `author-roster-effect:${request.operationId}`
  return db.transaction(() => {
    assertCurrent()
    const prior = db.prepare('SELECT payload_hash,receipt_json FROM character_identity_approvals WHERE operation_id=?').get(operationKey) as { payload_hash: string; receipt_json: string } | undefined
    if (prior) {
      if (prior.payload_hash !== requestHash) throw new Error('CHARACTER_APPROVAL_NONCE_CONFLICT')
      const saved = JSON.parse(prior.receipt_json) as Envelope
      const approval = db.prepare('SELECT payload_hash,receipt_json FROM character_identity_approvals WHERE operation_id=?').get(approvalId) as { payload_hash: string; receipt_json: string } | undefined
      if (saved.version !== 1 || saved.kind !== 'author-roster' || saved.requestHash !== requestHash
        || saved.receiptHash !== hash(JSON.stringify(saved.receipt)) || saved.approvalId !== approvalId
        || saved.receipt.operationId !== request.operationId || saved.receipt.payloadHash !== requestHash
        || !approval || saved.approvalPayloadHash !== approval.payload_hash || saved.approvalReceiptHash !== hash(approval.receipt_json)) throw new Error('CHARACTER_AUTHOR_RECEIPT_INVALID')
      return { ...saved.receipt, idempotent: true }
    }
    const current = CharacterRosterRepository.read(db)
    if (current.revision !== request.expectedRevision || current.identityRevision !== request.expectedIdentityRevision) throw new Error('CHARACTER_ID_REVISION_CONFLICT')
    if (!['ready', 'empty'].includes(current.status)) throw new Error('CHARACTER_AUTHOR_ROSTER_NOT_READY')
    const original = new Map(current.entries.map(entry => [entry.characterId!, entry]))
    const kept = new Set(request.entries.filter(entry => !draftId.test(entry.characterId)).map(entry => entry.characterId))
    for (const entry of request.entries) if (!original.has(entry.characterId) && !draftId.test(entry.characterId)) throw new Error('CHARACTER_ID_UNKNOWN')
    const identity: CharacterIdentityCommitRequest = {
      approval: { operationId: approvalId, expectedRevision: current.identityRevision!, action: 'author-edit',
        source: { kind: 'author', source: { projectId: scope.projectId, epoch: scope.epoch, sourceId: operationKey,
          revision: current.identityRevision!, contentHash: requestHash } } },
      changes: [], creations: [], retireIds: [...original.keys()].filter(id => !kept.has(id)), relationships: [], resolutions: [],
    }
    for (const entry of request.entries) {
      const before = original.get(entry.characterId)
      const changed = Object.fromEntries(fields.filter(field => !before || before[field] !== entry[field]).map(field => [field, entry[field]]))
      if (!before) identity.creations.push({ selectionKey: entry.characterId, fields: { ...changed, name: entry.name } })
      else if (Object.keys(changed).length) identity.changes.push({ characterId: entry.characterId, fields: changed })
    }
    const existingRelations = db.prepare(`SELECT r.relationship_id,r.source_character_id,r.target_character_id,r.relation FROM character_relationships r
      JOIN characters a ON a.character_id=r.source_character_id JOIN characters b ON b.character_id=r.target_character_id WHERE a.retired=0 AND b.retired=0`).all() as {
        relationship_id: string; source_character_id: string; target_character_id: string; relation: string }[]
    const relationKey = (from: string, to: string, text: string) => JSON.stringify([from, to, text])
    const desired = new Set(request.entries.flatMap(entry => entry.relationships.map(relation => relationKey(entry.characterId, relation.targetCharacterId!, relation.relation))))
    const previousKeys = new Set(existingRelations.map(relation => relationKey(relation.source_character_id, relation.target_character_id, relation.relation)))
    for (const relation of existingRelations) if (kept.has(relation.source_character_id) && kept.has(relation.target_character_id)
      && !desired.has(relationKey(relation.source_character_id, relation.target_character_id, relation.relation))) db.prepare('DELETE FROM character_relationships WHERE relationship_id=?').run(relation.relationship_id)
    for (const entry of request.entries) for (const relation of entry.relationships) {
      if (previousKeys.has(relationKey(entry.characterId, relation.targetCharacterId!, relation.relation))) continue
      identity.relationships.push({ ...(draftId.test(entry.characterId) ? { sourceSelectionKey: entry.characterId } : { sourceCharacterId: entry.characterId }),
        ...(draftId.test(relation.targetCharacterId!) ? { targetSelectionKey: relation.targetCharacterId } : { targetCharacterId: relation.targetCharacterId }), relation: relation.relation })
    }
    const committed = commitCharacterIdentities(db, identity, () => { assertCurrent(); return true })
    const created = new Map(committed.created.map(item => [item.selectionKey, item.characterId]))
    for (const entry of request.entries) {
      const id = created.get(entry.characterId) ?? entry.characterId, before = original.get(entry.characterId)
      if (entry.legacyRelationshipNotes !== undefined && entry.legacyRelationshipNotes !== before?.legacyRelationshipNotes)
        db.prepare('UPDATE characters SET relationships=? WHERE character_id=?').run(entry.legacyRelationshipNotes, id)
      if (entry.currentState) {
        const state = entry.currentState, oldState = before?.currentState
        const changed = CHARACTER_STATE_TEXT_FIELDS.filter(field => !oldState || oldState[field] !== state[field])
        if (changed.length || state.updatedAtChapter !== oldState?.updatedAtChapter) {
          const provenance = { ...oldState?.provenance }
          for (const field of changed) provenance[field] = { kind: 'author', chapterNumber: state.updatedAtChapter }
          db.prepare(`UPDATE characters SET ${CHARACTER_STATE_TEXT_FIELDS.map(field => `${columns[field]}=?`).join(',')},cs_updated_at_chapter=?,cs_provenance=? WHERE character_id=?`)
            .run(...CHARACTER_STATE_TEXT_FIELDS.map(field => state[field]), state.updatedAtChapter, JSON.stringify(provenance), id)
        }
      }
    }
    refreshCharacterIdentityProjection(db)
    const snapshot = CharacterRosterRepository.read(db)
    if (snapshot.identityRevision !== committed.revision || snapshot.revision !== current.revision + 1
      || !['ready', 'empty'].includes(snapshot.status) || snapshot.entries.length !== request.entries.length) throw new Error('CHARACTER_AUTHOR_READBACK_FAILED')
    for (const entry of request.entries) {
      const observed = snapshot.entries.find(item => item.characterId === (created.get(entry.characterId) ?? entry.characterId))
      const expectedRelations = entry.relationships.map(relation => ({ ...relation, targetCharacterId: created.get(relation.targetCharacterId!) ?? relation.targetCharacterId }))
      if (!observed || fields.some(field => observed[field] !== entry[field])
        || !isDeepStrictEqual(new Set(observed.relationships.map(relation => relationKey(observed.characterId!, relation.targetCharacterId!, relation.relation))),
          new Set(expectedRelations.map(relation => relationKey(observed.characterId!, relation.targetCharacterId!, relation.relation))))) throw new Error('CHARACTER_AUTHOR_READBACK_FAILED')
      const expectedState: CharacterRosterCharacterState | undefined = entry.currentState ?? original.get(entry.characterId)?.currentState
      if (expectedState && (!observed.currentState || CHARACTER_STATE_TEXT_FIELDS.some(field => observed.currentState![field] !== expectedState[field]))) throw new Error('CHARACTER_AUTHOR_READBACK_FAILED')
    }
    const receipt: CharacterRosterCommitReceipt = JSON.parse(JSON.stringify({ operationId: request.operationId, payloadHash: requestHash,
      revision: snapshot.revision, idempotent: false, snapshot, created: committed.created }))
    const approval = db.prepare('SELECT payload_hash,receipt_json FROM character_identity_approvals WHERE operation_id=?').get(approvalId) as { payload_hash: string; receipt_json: string }
    const saved: Envelope = { version: 1, kind: 'author-roster', requestHash, receipt, receiptHash: hash(JSON.stringify(receipt)),
      approvalId, approvalPayloadHash: approval.payload_hash, approvalReceiptHash: hash(approval.receipt_json) }
    db.prepare('INSERT INTO character_identity_approvals VALUES(?,?,?)').run(operationKey, requestHash, JSON.stringify(saved))
    return receipt
  }).immediate()
}
