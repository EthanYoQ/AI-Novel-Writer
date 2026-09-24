import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { ApproveCharacterProposalRequest, CancelCharacterProposalRequest, CharacterIdentitySnapshot, CharacterProposalBatch, CharacterProposalItem, CharacterProposalSource, CharacterStaticFields, PendingFinalizedCharacterProposalSummary } from '../../src/shared/character-proposal'
import { resolveScopedCharacterIdentity, type CharacterStaticProvenance } from '../../src/shared/character-identity'
import { CHARACTER_ROLES } from '../../src/shared/character-role'
import { commitCharacterIdentities, refreshCharacterIdentityProjection, type CharacterIdentityCommitRequest } from '../repositories/character-roster-repository'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'
import { SummaryRepository } from '../repositories/summary-repository'
import { normalizeFinalizedCharacterProposalSource } from './finalized-character-generation-proof'
import { readLegacyRosterGenerationProof } from './legacy-roster-generation-proof'

export interface CharacterProposalProof {
  items: Omit<CharacterProposalItem, 'resolution'>[]
  sourceHash: string
  /** An unproven legacy/import candidate remains readable; it cannot be silently adopted. */
  provenance: CharacterStaticProvenance | null
}
interface Envelope {
  version: 1
  projectId: string
  proof: CharacterProposalProof
  batch: CharacterProposalBatch
  decision?: ApproveCharacterProposalRequest
  created?: { selectionKey: string; characterId: string }[]
  approvalProof?: { payloadHash: string; receiptHash: string }
  authorEditProof?: { payloadHash: string; receiptHash: string }
}
const fields = ['name', 'role', 'gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'notes'] as const
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
export class CharacterProposalService {
  constructor(private readonly db: Database.Database, private readonly projectId: string,
    private readonly prove: (source: CharacterProposalSource, forWrite: boolean) => CharacterProposalProof) {}
  private sourceProof(source: CharacterProposalSource, forWrite: boolean): CharacterProposalProof {
    // The source and durable envelope share one JSON representation, including omitted optional fields.
    return JSON.parse(JSON.stringify(this.prove(source, forWrite))) as CharacterProposalProof
  }
  private revision(): number { return (this.db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").get() as { revision: number }).revision }
  private write(envelope: Envelope): void {
    const encoded = JSON.stringify(envelope)
    this.db.prepare('UPDATE character_identity_proposals SET source_hash=?,raw_value=? WHERE proposal_id=?').run(textHash(encoded), encoded, envelope.batch.proposalBatchId)
  }
  private assertFinalizedSourceCurrent(envelope: Envelope): void {
    if (envelope.batch.source.kind !== 'finalized-generation') return
    const provenance = envelope.proof.provenance
    const source = provenance && 'source' in provenance ? provenance.source : undefined
    const row = source && this.db.prepare('SELECT draft_id FROM finalization_outbox WHERE finalization_id=?').get(source.sourceId) as { draft_id: number } | undefined
    if (!row) throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    try {
      const current = SummaryRepository.readFinalizedCharacterContext(row.draft_id,
        { projectId: this.projectId, epoch: envelope.batch.source.handle.epoch }, this.db)
      if (current.source.finalizationId !== source.sourceId || current.source.contentHash !== source.contentHash
        || current.sourceOrder.authoritativeFinalizationRevision !== source.revision) throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    } catch {
      throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    }
  }
  private readEnvelope(proposalBatchId: string): Envelope {
    const row = this.db.prepare('SELECT source_key,source_hash,raw_value FROM character_identity_proposals WHERE proposal_id=?').get(proposalBatchId) as { source_key: string; source_hash: string; raw_value: string } | undefined
    if (!row || row.source_key !== `character-proposal-v1:${this.projectId}` || textHash(row.raw_value) !== row.source_hash) throw new Error('CHARACTER_PROPOSAL_RECEIPT_INVALID')
    let envelope: Envelope
    try { envelope = JSON.parse(row.raw_value) as Envelope } catch { throw new Error('CHARACTER_PROPOSAL_RECEIPT_INVALID') }
    if (!envelope || envelope.version !== 1 || envelope.projectId !== this.projectId || !envelope.batch
      || envelope.batch.proposalBatchId !== proposalBatchId) throw new Error('CHARACTER_PROPOSAL_RECEIPT_INVALID')
    let currentProof: CharacterProposalProof
    try { currentProof = this.sourceProof(envelope.batch.source, false) } catch (error) {
      if (envelope.batch?.source?.kind === 'finalized-generation' && (error as Error).message !== 'CHARACTER_PROPOSAL_SOURCE_INVALID')
        throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
      throw error
    }
    if (!isDeepStrictEqual(envelope.proof, currentProof)) throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    this.assertFinalizedSourceCurrent(envelope)
    if (envelope.batch.status === 'approved') {
      const receipt = this.db.prepare('SELECT receipt_json FROM character_identity_approvals WHERE operation_id=?').get(envelope.batch.approvalOperationId) as { receipt_json: string } | undefined
      const adoptionRevision = receipt && JSON.parse(receipt.receipt_json).revision as number | undefined
      if (!receipt || !envelope.decision) throw new Error('CHARACTER_PROPOSAL_APPROVAL_INVALID')
      if (envelope.authorEditProof) {
        const authorReceipt = this.db.prepare('SELECT payload_hash,receipt_json FROM character_identity_approvals WHERE operation_id=?')
          .get(`character-proposal-edit:${envelope.decision.operationId}`) as { payload_hash: string; receipt_json: string } | undefined
        if (!authorReceipt || authorReceipt.payload_hash !== envelope.authorEditProof.payloadHash
          || textHash(authorReceipt.receipt_json) !== envelope.authorEditProof.receiptHash
          || JSON.parse(authorReceipt.receipt_json).revision !== envelope.batch.revision
          || adoptionRevision !== envelope.batch.revision - 1) throw new Error('CHARACTER_PROPOSAL_APPROVAL_INVALID')
      } else if (adoptionRevision !== envelope.batch.revision) throw new Error('CHARACTER_PROPOSAL_APPROVAL_INVALID')
      if (envelope.batch.source.kind === 'legacy-roster-generation') {
        const row = this.db.prepare('SELECT payload_hash,receipt_json FROM character_identity_approvals WHERE operation_id=?').get(envelope.batch.approvalOperationId) as { payload_hash: string; receipt_json: string }
        const saved = JSON.parse(row.receipt_json)
        if (!envelope.approvalProof || row.payload_hash !== envelope.approvalProof.payloadHash || textHash(row.receipt_json) !== envelope.approvalProof.receiptHash
          || saved.approval?.operationId !== envelope.decision.operationId || envelope.batch.approvalOperationId !== envelope.decision.operationId
          || !isDeepStrictEqual(saved.created, envelope.created)) throw new Error('CHARACTER_PROPOSAL_APPROVAL_INVALID')
      }
    }
    return envelope
  }
  read(proposalBatchId: string): CharacterProposalBatch { return structuredClone(this.readEnvelope(proposalBatchId).batch) }
  listPendingFinalized(): PendingFinalizedCharacterProposalSummary[] {
    const rows = this.db.prepare('SELECT proposal_id FROM character_identity_proposals WHERE source_key=? ORDER BY proposal_id')
      .all(`character-proposal-v1:${this.projectId}`) as { proposal_id: string }[]
    return rows.flatMap(({ proposal_id }) => {
      try {
        const envelope = this.readEnvelope(proposal_id), provenance = envelope.proof.provenance
        const source = provenance && 'source' in provenance ? provenance.source : undefined
        return envelope.batch.status === 'pending-approval' && envelope.batch.source.kind === 'finalized-generation' && source
          ? [{ proposalBatchId: proposal_id, revision: envelope.batch.revision, finalizationId: source.sourceId }]
          : []
      } catch { return [] }
    })
  }
  readPendingFinalized(proposalBatchId: string): CharacterProposalBatch {
    const envelope = this.readEnvelope(proposalBatchId)
    if (envelope.batch.status !== 'pending-approval' || envelope.batch.source.kind !== 'finalized-generation')
      throw new Error('CHARACTER_PROPOSAL_NOT_PENDING_FINALIZED')
    return structuredClone(envelope.batch)
  }
  evidence(proposalBatchId: string) {
    const envelope = this.readEnvelope(proposalBatchId)
    return { proposalBatchId, sourceHash: envelope.proof.sourceHash }
  }
  stage(source: CharacterProposalSource): CharacterProposalBatch {
    return this.db.transaction(() => {
      if (source?.kind === 'legacy-roster-generation') {
        source = readLegacyRosterGenerationProof(this.db, new GenerationRunRepository(() => this.db), this.projectId, source).source
        const proposalBatchId = `cpb:${textHash(JSON.stringify([this.projectId, source]))}`
        if (this.db.prepare('SELECT 1 FROM character_identity_proposals WHERE proposal_id=?').get(proposalBatchId)) return this.read(proposalBatchId)
      }
      if (source?.kind === 'finalized-generation') {
        const normalized = normalizeFinalizedCharacterProposalSource(this.db, new GenerationRunRepository(() => this.db), this.projectId, source)
        source = normalized.source
        // Only the dedicated main context supports historical ACKs. Legacy kinds keep their write gate.
        if (normalized.stableFinalizationSource) {
          const proposalBatchId = `cpb:${textHash(JSON.stringify([this.projectId, source]))}`
          if (this.db.prepare('SELECT 1 FROM character_identity_proposals WHERE proposal_id=?').get(proposalBatchId)) return this.read(proposalBatchId)
        }
      }
      const proof = this.sourceProof(source, true)
      const proposalBatchId = `cpb:${textHash(JSON.stringify([this.projectId, source]))}`
      const existing = this.db.prepare('SELECT 1 FROM character_identity_proposals WHERE proposal_id=?').get(proposalBatchId)
      if (existing) return this.read(proposalBatchId)
      const revision = this.revision(), snapshot = this.identitySnapshot()
      const items = proof.items.map(item => ({ ...structuredClone(item), resolution: resolveScopedCharacterIdentity(
        snapshot.aliases.map(alias => ({ ...alias, projectId: this.projectId })),
        { name: item.fields.name, projectId: this.projectId, sourceKey: item.sourceId, revision }) }))
      // Source-scoped resolution may find no alias; expose exact name candidates for explicit selection only.
      for (const item of items) if (source.kind !== 'finalized-generation' && item.resolution.status === 'unresolved') item.resolution = resolveScopedCharacterIdentity(
        snapshot.aliases.map(alias => ({ ...alias, projectId: this.projectId })), { name: item.fields.name, projectId: this.projectId, revision })
      const batch: CharacterProposalBatch = { proposalBatchId, revision, status: 'pending-approval', source: structuredClone(source), items }
      const envelope: Envelope = { version: 1, projectId: this.projectId, proof: structuredClone(proof), batch }
      const encoded = JSON.stringify(envelope)
      this.db.prepare('INSERT INTO character_identity_proposals(proposal_id,owner_character_id,source_key,source_hash,raw_value,candidate_ids_json) VALUES(?,NULL,?,?,?,?)')
        .run(proposalBatchId, `character-proposal-v1:${this.projectId}`, textHash(encoded), encoded, '[]')
      return structuredClone(batch)
    }).immediate()
  }
  cancel(request: CancelCharacterProposalRequest): CharacterProposalBatch {
    if (!request || !nonempty(request.proposalBatchId)
      || !Number.isSafeInteger(request.expectedRevision)
      || Object.keys(request).some(key => !['proposalBatchId', 'expectedRevision'].includes(key))) throw new Error('CHARACTER_APPROVAL_INVALID')
    return this.db.transaction(() => {
      const envelope = this.readEnvelope(request.proposalBatchId)
      if (request.expectedRevision !== envelope.batch.revision) throw new Error('CHARACTER_ID_REVISION_CONFLICT')
      if (envelope.batch.status === 'approved') throw new Error('CHARACTER_PROPOSAL_ALREADY_APPROVED')
      if (envelope.batch.status === 'cancelled') return structuredClone(envelope.batch)
      envelope.batch.status = 'cancelled'; this.write(envelope)
      return structuredClone(envelope.batch)
    }).immediate()
  }
  approve(request: ApproveCharacterProposalRequest): { batch: CharacterProposalBatch; created: { selectionKey: string; characterId: string }[] } {
    if (!request || !nonempty(request.operationId) || request.operationId.length > 256 || !Array.isArray(request.selections)
      || Object.keys(request).some(key => !['proposalBatchId', 'expectedRevision', 'operationId', 'selections', 'relationships', 'edits'].includes(key))) throw new Error('CHARACTER_APPROVAL_INVALID')
    return this.db.transaction(() => {
      const envelope = this.readEnvelope(request.proposalBatchId), batch = envelope.batch
      const byKey = new Map(batch.items.map(item => [item.selectionKey, item]))
      if (request.edits !== undefined && (batch.source.kind !== 'generation' || batch.source.inputKind !== 'planning-material'
        || !Array.isArray(request.edits) || request.edits.length > batch.items.length)) throw new Error('CHARACTER_PROPOSAL_EDIT_INVALID')
      const editKeys = new Set<string>()
      const edits = request.edits?.map(edit => {
        if (!edit || typeof edit.selectionKey !== 'string' || editKeys.has(edit.selectionKey)
          || !byKey.has(edit.selectionKey) || !edit.fields || typeof edit.fields !== 'object' || Array.isArray(edit.fields))
          throw new Error('CHARACTER_PROPOSAL_EDIT_INVALID')
        editKeys.add(edit.selectionKey)
        const values = Object.entries(edit.fields)
        if (!values.length || values.some(([key, value]) => !fields.includes(key as typeof fields[number])
          || typeof value !== 'string' || key === 'name' && !value.trim()
          || key === 'role' && !CHARACTER_ROLES.includes(value as typeof CHARACTER_ROLES[number])))
          throw new Error('CHARACTER_PROPOSAL_EDIT_INVALID')
        return { selectionKey: edit.selectionKey, fields: Object.fromEntries(fields.filter(key => key in edit.fields)
          .map(key => [key, edit.fields[key]])) as Partial<CharacterStaticFields> }
      }).sort((a, b) => a.selectionKey.localeCompare(b.selectionKey, 'en-US'))
      const decision = edits ? { ...request, edits } : request
      if (batch.status === 'approved') {
        if (!isDeepStrictEqual(envelope.decision, decision)) throw new Error('CHARACTER_APPROVAL_NONCE_CONFLICT')
        return { batch: structuredClone(batch), created: structuredClone(envelope.created ?? []) }
      }
      if (batch.status !== 'pending-approval') throw new Error('CHARACTER_PROPOSAL_CANCELLED')
      if (request.expectedRevision !== batch.revision || this.revision() !== batch.revision) throw new Error('CHARACTER_ID_REVISION_CONFLICT')
      const proof = this.sourceProof(batch.source, true)
      if (!proof.provenance || !['generated', 'derived'].includes(proof.provenance.kind)) throw new Error('CHARACTER_PROPOSAL_PROVENANCE_REQUIRED')
      if (request.selections.length !== byKey.size || new Set(request.selections.map(item => item.selectionKey)).size !== byKey.size) throw new Error('CHARACTER_APPROVAL_SELECTION_INVALID')
      if (edits?.some(edit => !request.selections.some(selection => selection.selectionKey === edit.selectionKey && selection.action !== 'keep-unresolved')))
        throw new Error('CHARACTER_PROPOSAL_EDIT_INVALID')
      if (batch.source.kind === 'legacy-roster-generation' && !request.selections.some(item => item.action === 'create' || item.action === 'map'))
        throw new Error('CHARACTER_APPROVAL_SELECTION_REQUIRED')
      const identityRequest: CharacterIdentityCommitRequest = { approval: { operationId: request.operationId, expectedRevision: request.expectedRevision,
        source: proof.provenance, action: batch.source.kind === 'legacy-roster-generation' || batch.source.kind === 'generation' && batch.source.inputKind === 'architecture' ? 'adopt-generated' : 'adopt-import' },
        changes: [], creations: [], retireIds: [], relationships: [], resolutions: [] }
      const existingCharacters = this.identitySnapshot().characters
      for (const selection of request.selections) {
        const item = byKey.get(selection.selectionKey)
        if (!item || !['create', 'map', 'keep-unresolved'].includes(selection.action)
          || Object.keys(selection).some(key => !['selectionKey', 'action', ...(selection.action === 'map' ? ['characterId'] : [])].includes(key))) throw new Error('CHARACTER_APPROVAL_SELECTION_INVALID')
        if (selection.action === 'create') identityRequest.creations.push({ selectionKey: item.selectionKey, fields: item.fields })
        // A finalized occurrence carries a historical display label, not permission to rename an existing identity.
        if (selection.action === 'map' && batch.source.kind !== 'finalized-generation') {
          const existing = existingCharacters.find(character => character.characterId === selection.characterId && !character.retired)
          if (!existing) throw new Error('CHARACTER_ID_UNKNOWN')
          const provenance = existing.provenance as { kind?: string; fields?: Record<string, { kind?: string }> }
          const adopted = Object.fromEntries(Object.entries(item.fields).filter(([key, value]) => {
            const current = existing.fields[key as keyof CharacterStaticFields] ?? ''
            const origin = provenance.fields?.[key]?.kind ?? provenance.kind
            return current !== value && (!current.trim() || origin !== 'author' && origin !== 'legacy')
          }))
          if (Object.keys(adopted).length) identityRequest.changes.push({ characterId: selection.characterId, fields: adopted })
        }
        if (selection.action === 'map' && batch.source.kind === 'finalized-generation'
          && !this.identitySnapshot().characters.some(character => character.characterId === selection.characterId && !character.retired))
          throw new Error('CHARACTER_ID_UNKNOWN')
      }
      for (const relation of request.relationships ?? []) {
        const from = request.selections.find(item => item.selectionKey === relation.sourceSelectionKey)
        const to = request.selections.find(item => item.selectionKey === relation.targetSelectionKey)
        if (!from || from.action === 'keep-unresolved' || to?.action === 'keep-unresolved'
          || Boolean(to) === Boolean(relation.targetCharacterId)
          || !byKey.get(from.selectionKey)!.relationships.some(item => item.relation === relation.relation
            && (item.targetSelectionKey ? item.targetSelectionKey === relation.targetSelectionKey : Boolean(item.targetName)))) throw new Error('CHARACTER_RELATIONSHIP_PROPOSAL_INVALID')
        identityRequest.relationships.push({ ...(from.action === 'create' ? { sourceSelectionKey: from.selectionKey } : { sourceCharacterId: from.characterId }),
          ...(to ? to.action === 'create' ? { targetSelectionKey: to.selectionKey } : { targetCharacterId: to.characterId } : { targetCharacterId: relation.targetCharacterId }), relation: relation.relation })
      }
      const frozenRequest = JSON.stringify(identityRequest)
      const receipt = commitCharacterIdentities(this.db, identityRequest, candidate => JSON.stringify(candidate) === frozenRequest)
      let finalRevision = receipt.revision
      const authorChanges = (edits ?? []).flatMap(edit => {
        const item = byKey.get(edit.selectionKey)!
        const changed = Object.fromEntries(Object.entries(edit.fields).filter(([key, value]) => item.fields[key as keyof CharacterStaticFields] !== value))
        if (!Object.keys(changed).length) return []
        const selection = request.selections.find(value => value.selectionKey === edit.selectionKey)!
        const characterId = selection.action === 'map' ? selection.characterId
          : receipt.created.find(value => value.selectionKey === edit.selectionKey)?.characterId
        if (!characterId) throw new Error('CHARACTER_PROPOSAL_EDIT_INVALID')
        return [{ characterId, fields: changed }]
      })
      if (authorChanges.length) {
        const source = batch.source
        if (source.kind !== 'generation' || source.inputKind !== 'planning-material') throw new Error('CHARACTER_PROPOSAL_EDIT_INVALID')
        const authorRequest: CharacterIdentityCommitRequest = {
          approval: { operationId: `character-proposal-edit:${request.operationId}`, expectedRevision: receipt.revision,
            action: 'author-edit', source: { kind: 'author', source: { projectId: this.projectId, epoch: source.handle.epoch,
              sourceId: `character-proposal-edit:${batch.proposalBatchId}`, revision: receipt.revision,
              contentHash: textHash(JSON.stringify(edits)) } } },
          changes: authorChanges, creations: [], retireIds: [], relationships: [], resolutions: [],
        }
        const frozenAuthorRequest = JSON.stringify(authorRequest)
        finalRevision = commitCharacterIdentities(this.db, authorRequest, candidate => JSON.stringify(candidate) === frozenAuthorRequest).revision
        const authorReceipt = this.db.prepare('SELECT payload_hash,receipt_json FROM character_identity_approvals WHERE operation_id=?')
          .get(authorRequest.approval.operationId) as { payload_hash: string; receipt_json: string }
        envelope.authorEditProof = { payloadHash: authorReceipt.payload_hash, receiptHash: textHash(authorReceipt.receipt_json) }
      }
      refreshCharacterIdentityProjection(this.db)
      envelope.batch = { ...batch, status: 'approved', revision: finalRevision, approvalOperationId: request.operationId }
      envelope.decision = structuredClone(decision); envelope.created = receipt.created
      if (batch.source.kind === 'legacy-roster-generation') {
        const row = this.db.prepare('SELECT payload_hash,receipt_json FROM character_identity_approvals WHERE operation_id=?').get(request.operationId) as { payload_hash: string; receipt_json: string } | undefined
        if (!row) throw new Error('CHARACTER_PROPOSAL_APPROVAL_INVALID')
        envelope.approvalProof = { payloadHash: row.payload_hash, receiptHash: textHash(row.receipt_json) }
      }
      this.write(envelope)
      return { batch: structuredClone(envelope.batch), created: structuredClone(receipt.created) }
    }).immediate()
  }
  identitySnapshot(): CharacterIdentitySnapshot {
    return this.db.transaction(() => ({ revision: this.revision(),
      characters: (this.db.prepare('SELECT * FROM characters ORDER BY character_id').all() as Record<string, unknown>[]).map(row => ({
        characterId: row.character_id as string, fields: Object.fromEntries(fields.map(key => [key, String(row[key] ?? '')])) as unknown as CharacterStaticFields,
        retired: row.retired === 1, revision: row.identity_revision as number, provenance: JSON.parse(row.static_provenance as string) as CharacterStaticProvenance })),
      aliases: (this.db.prepare('SELECT * FROM character_aliases ORDER BY character_id,name,valid_from').all() as Record<string, unknown>[]).map(row => ({
        characterId: row.character_id as string, name: row.name as string, sourceKey: row.source_key as string, validFrom: row.valid_from as number, validThrough: row.valid_through as number | null })),
      relationships: (this.db.prepare('SELECT * FROM character_relationships ORDER BY relationship_id').all() as Record<string, unknown>[]).map(row => ({
        relationshipId: row.relationship_id as string, sourceCharacterId: row.source_character_id as string, targetCharacterId: row.target_character_id as string, relation: row.relation as string })),
    }))()
  }
}

/** Find an exact durable source, never a latest-name or latest-proposal fallback. */
export function findCharacterProposalEvidence(db: Database.Database, source: CharacterProposalSource,
  prove: (projectId: string, source: CharacterProposalSource) => CharacterProposalProof) {
  if (source.kind === 'finalized-generation') source = normalizeFinalizedCharacterProposalSource(
    db, new GenerationRunRepository(() => db), source.handle.projectId, source).source
  const rows = db.prepare("SELECT raw_value FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'").all() as { raw_value: string }[]
  const matches = rows.map(row => JSON.parse(row.raw_value) as Envelope).filter(envelope => isDeepStrictEqual(envelope.batch?.source, source))
  if (matches.length !== 1) throw new Error('CHARACTER_PROPOSAL_EVIDENCE_REQUIRED')
  const envelope = matches[0]!
  return new CharacterProposalService(db, envelope.projectId, candidate => prove(envelope.projectId, candidate)).evidence(envelope.batch.proposalBatchId)
}
