import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { ApproveCharacterProposalRequest, CharacterIdentitySnapshot, CharacterProposalBatch, CharacterProposalItem, CharacterProposalSource, CharacterStaticFields } from '../../src/shared/character-proposal'
import { resolveScopedCharacterIdentity, type CharacterStaticProvenance } from '../../src/shared/character-identity'
import { commitCharacterIdentities, refreshCharacterIdentityProjection, type CharacterIdentityCommitRequest } from '../repositories/character-roster-repository'
import { textHash } from '../repositories/generation-run-repository'

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
  private readEnvelope(proposalBatchId: string): Envelope {
    const row = this.db.prepare('SELECT source_key,source_hash,raw_value FROM character_identity_proposals WHERE proposal_id=?').get(proposalBatchId) as { source_key: string; source_hash: string; raw_value: string } | undefined
    if (!row || row.source_key !== `character-proposal-v1:${this.projectId}` || textHash(row.raw_value) !== row.source_hash) throw new Error('CHARACTER_PROPOSAL_RECEIPT_INVALID')
    const envelope = JSON.parse(row.raw_value) as Envelope
    if (envelope.version !== 1 || envelope.projectId !== this.projectId || envelope.batch.proposalBatchId !== proposalBatchId
      || !isDeepStrictEqual(envelope.proof, this.sourceProof(envelope.batch.source, false))) throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    if (envelope.batch.status === 'approved') {
      const receipt = this.db.prepare('SELECT receipt_json FROM character_identity_approvals WHERE operation_id=?').get(envelope.batch.approvalOperationId) as { receipt_json: string } | undefined
      if (!receipt || !envelope.decision || JSON.parse(receipt.receipt_json).revision !== envelope.batch.revision) throw new Error('CHARACTER_PROPOSAL_APPROVAL_INVALID')
    }
    return envelope
  }
  read(proposalBatchId: string): CharacterProposalBatch { return structuredClone(this.readEnvelope(proposalBatchId).batch) }
  evidence(proposalBatchId: string) {
    const envelope = this.readEnvelope(proposalBatchId)
    return { proposalBatchId, sourceHash: envelope.proof.sourceHash }
  }
  stage(source: CharacterProposalSource): CharacterProposalBatch {
    return this.db.transaction(() => {
      const proof = this.sourceProof(source, true)
      const proposalBatchId = `cpb:${textHash(JSON.stringify([this.projectId, source]))}`
      const existing = this.db.prepare('SELECT 1 FROM character_identity_proposals WHERE proposal_id=?').get(proposalBatchId)
      if (existing) return this.read(proposalBatchId)
      const revision = this.revision(), snapshot = this.identitySnapshot()
      const items = proof.items.map(item => ({ ...structuredClone(item), resolution: resolveScopedCharacterIdentity(
        snapshot.aliases.map(alias => ({ ...alias, projectId: this.projectId })),
        { name: item.fields.name, projectId: this.projectId, sourceKey: item.sourceId, revision }) }))
      // Source-scoped resolution may find no alias; expose exact name candidates for explicit selection only.
      for (const item of items) if (item.resolution.status === 'unresolved') item.resolution = resolveScopedCharacterIdentity(
        snapshot.aliases.map(alias => ({ ...alias, projectId: this.projectId })), { name: item.fields.name, projectId: this.projectId, revision })
      const batch: CharacterProposalBatch = { proposalBatchId, revision, status: 'pending-approval', source: structuredClone(source), items }
      const envelope: Envelope = { version: 1, projectId: this.projectId, proof: structuredClone(proof), batch }
      const encoded = JSON.stringify(envelope)
      this.db.prepare('INSERT INTO character_identity_proposals(proposal_id,owner_character_id,source_key,source_hash,raw_value,candidate_ids_json) VALUES(?,NULL,?,?,?,?)')
        .run(proposalBatchId, `character-proposal-v1:${this.projectId}`, textHash(encoded), encoded, '[]')
      return structuredClone(batch)
    }).immediate()
  }
  cancel(proposalBatchId: string): CharacterProposalBatch {
    return this.db.transaction(() => {
      const envelope = this.readEnvelope(proposalBatchId)
      if (envelope.batch.status === 'approved') throw new Error('CHARACTER_PROPOSAL_ALREADY_APPROVED')
      envelope.batch.status = 'cancelled'; this.write(envelope)
      return structuredClone(envelope.batch)
    }).immediate()
  }
  approve(request: ApproveCharacterProposalRequest): { batch: CharacterProposalBatch; created: { selectionKey: string; characterId: string }[] } {
    if (!request || !nonempty(request.operationId) || request.operationId.length > 256 || !Array.isArray(request.selections)
      || Object.keys(request).some(key => !['proposalBatchId', 'expectedRevision', 'operationId', 'selections', 'relationships'].includes(key))) throw new Error('CHARACTER_APPROVAL_INVALID')
    return this.db.transaction(() => {
      const envelope = this.readEnvelope(request.proposalBatchId), batch = envelope.batch
      if (batch.status === 'approved') {
        if (!isDeepStrictEqual(envelope.decision, request)) throw new Error('CHARACTER_APPROVAL_NONCE_CONFLICT')
        return { batch: structuredClone(batch), created: structuredClone(envelope.created ?? []) }
      }
      if (batch.status !== 'pending-approval') throw new Error('CHARACTER_PROPOSAL_CANCELLED')
      if (request.expectedRevision !== batch.revision || this.revision() !== batch.revision) throw new Error('CHARACTER_ID_REVISION_CONFLICT')
      const proof = this.sourceProof(batch.source, true)
      if (!proof.provenance || !['generated', 'derived'].includes(proof.provenance.kind)) throw new Error('CHARACTER_PROPOSAL_PROVENANCE_REQUIRED')
      const byKey = new Map(batch.items.map(item => [item.selectionKey, item]))
      if (request.selections.length !== byKey.size || new Set(request.selections.map(item => item.selectionKey)).size !== byKey.size) throw new Error('CHARACTER_APPROVAL_SELECTION_INVALID')
      const identityRequest: CharacterIdentityCommitRequest = { approval: { operationId: request.operationId, expectedRevision: request.expectedRevision,
        source: proof.provenance, action: batch.source.kind === 'generation' && batch.source.inputKind === 'architecture' ? 'adopt-generated' : 'adopt-import' },
        changes: [], creations: [], retireIds: [], relationships: [], resolutions: [] }
      for (const selection of request.selections) {
        const item = byKey.get(selection.selectionKey)
        if (!item || !['create', 'map', 'keep-unresolved'].includes(selection.action)
          || Object.keys(selection).some(key => !['selectionKey', 'action', ...(selection.action === 'map' ? ['characterId'] : [])].includes(key))) throw new Error('CHARACTER_APPROVAL_SELECTION_INVALID')
        if (selection.action === 'create') identityRequest.creations.push({ selectionKey: item.selectionKey, fields: item.fields })
        // A finalized occurrence carries a historical display label, not permission to rename an existing identity.
        if (selection.action === 'map' && batch.source.kind !== 'finalized-generation') identityRequest.changes.push({ characterId: selection.characterId, fields: item.fields })
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
      refreshCharacterIdentityProjection(this.db)
      envelope.batch = { ...batch, status: 'approved', revision: receipt.revision, approvalOperationId: request.operationId }
      envelope.decision = structuredClone(request); envelope.created = receipt.created
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
  const rows = db.prepare("SELECT raw_value FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'").all() as { raw_value: string }[]
  const matches = rows.map(row => JSON.parse(row.raw_value) as Envelope).filter(envelope => isDeepStrictEqual(envelope.batch?.source, source))
  if (matches.length !== 1) throw new Error('CHARACTER_PROPOSAL_EVIDENCE_REQUIRED')
  const envelope = matches[0]!
  return new CharacterProposalService(db, envelope.projectId, candidate => prove(envelope.projectId, candidate)).evidence(envelope.batch.proposalBatchId)
}
