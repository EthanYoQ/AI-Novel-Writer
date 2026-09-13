import type Database from 'better-sqlite3'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { CharacterProposalItem, CharacterProposalSource } from '../../src/shared/character-proposal'
import type { GenerationAuthorInput } from '../../src/shared/generation-owner-contract'
import { characterProposalMaterialChunks, parseArchitectureCharacterProposal, parsePlanningMaterialCharacterProposal } from '../../src/shared/character-proposal-parser'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'
import type { BlueprintData } from '../repositories/blueprint-repository'
import type { CharacterProposalProof } from './character-proposal-service'
import type { ImportGlobalFactsReceipt } from '../../src/shared/import-global-facts'
import { proveFinalizedCharacterGeneration } from './finalized-character-generation-proof'

export function proveCharacterProposal(db: Database.Database, runs: GenerationRunRepository, projectId: string,
  source: CharacterProposalSource, forWrite: boolean, assertSources: (handle: MainGenerationRunHandle, committedBlueprintChapters?: number[]) => void): CharacterProposalProof {
  if (!source || typeof source !== 'object') throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
  if (source.kind === 'finalized-generation') {
    if (Object.keys(source).some(key => !['kind', 'handle', 'artifact'].includes(key))) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
    if (forWrite) assertSources(source.handle)
    const proof = proveFinalizedCharacterGeneration(db, runs, projectId, source.handle, source.artifact)
    const items = proof.response.unresolved.filter(item => item.displayName.trim()).map(item => ({
      selectionKey: item.selectionKey, sourceId: `${proof.context.source.finalizationId}:${source.artifact.artifactId}:${item.selectionKey}`,
      fields: { name: item.displayName }, relationships: [], rawValue: structuredClone(item),
    }))
    const sourceHash = textHash(JSON.stringify([source, items]))
    return { items, sourceHash, provenance: { kind: 'derived', modelRevision: proof.model.modelRevision,
      source: { projectId, epoch: source.handle.epoch, sourceId: proof.context.source.finalizationId,
        revision: proof.context.sourceOrder.authoritativeFinalizationRevision, contentHash: proof.context.source.contentHash } } }
  }
  if (source.kind === 'import') {
    if (Object.keys(source).some(key => !['kind', 'operationId'].includes(key))) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
    const row = db.prepare('SELECT payload_hash,receipt_json FROM import_global_fact_operations WHERE operation_id=?').get(source.operationId) as { payload_hash: string; receipt_json: string } | undefined
    if (!row) throw new Error('CHARACTER_PROPOSAL_SOURCE_MISSING')
    const receipt = JSON.parse(row.receipt_json) as ImportGlobalFactsReceipt
    if (!receipt.proposalSource || receipt.payloadHash !== row.payload_hash || receipt.operationId !== source.operationId
      || textHash(JSON.stringify(receipt.proposalSource)) !== row.payload_hash) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
    const items = receipt.proposalSource.characterEntries.map((entry, index) => {
      const { relationships, currentState, legacyRelationshipNotes, ...fields } = entry
      void currentState; void legacyRelationshipNotes
      return { selectionKey: `import:${index}`, sourceId: `${source.operationId}:${index}`, fields,
        relationships: relationships.map(relation => ({ targetName: relation.target, relation: relation.relation, raw: structuredClone(relation) })), rawValue: structuredClone(entry) }
    })
    return { items, sourceHash: textHash(JSON.stringify([row.payload_hash, receipt.proposalSource.characterEntries])), provenance: null }
  }
  if (source.kind === 'directory') {
    if (Object.keys(source).some(key => !['kind', 'operationId'].includes(key)) || typeof source.operationId !== 'string') throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
    const operation = db.prepare(`SELECT c.operation_id,c.payload_hash,c.character_sync_input,s.blueprint_commit_payload_hash,s.character_sync_input AS sync_input
      FROM blueprint_character_sync_operations s JOIN blueprint_commit_operations c ON c.operation_id=s.blueprint_commit_operation_id WHERE s.operation_id=?`).get(source.operationId) as {
      operation_id: string; payload_hash: string; character_sync_input: string; blueprint_commit_payload_hash: string; sync_input: string
    } | undefined
    if (!operation) throw new Error('CHARACTER_PROPOSAL_SOURCE_MISSING')
    if (operation.blueprint_commit_payload_hash !== operation.payload_hash || operation.sync_input !== operation.character_sync_input) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
    const blueprints = JSON.parse(operation.character_sync_input) as BlueprintData[]
    if (!Array.isArray(blueprints)) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
    if (forWrite) for (const blueprint of blueprints) {
      const current = db.prepare('SELECT title,role,purpose,key_events,characters,suspense_hook,user_guidance FROM blueprints WHERE chapter_number=?').get(blueprint.chapterNumber) as Record<string, string> | undefined
      if (!current || JSON.stringify([current.title, current.role, current.purpose, current.key_events, JSON.parse(current.characters), current.suspense_hook, current.user_guidance])
        !== JSON.stringify([blueprint.title, blueprint.role, blueprint.purpose, blueprint.keyEvents, blueprint.characters, blueprint.suspenseHook, blueprint.userGuidance])) throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    }
    const items: Omit<CharacterProposalItem, 'resolution'>[] = blueprints.flatMap(blueprint => (blueprint.newCharacterCandidates ?? []).map((candidate, index) => {
      if (!candidate || !candidate.name?.trim() || !['protagonist', 'antagonist', 'supporting', 'minor'].includes(candidate.role)
        || !blueprint.characters.includes(candidate.name)) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
      const relationships = Array.isArray(blueprint.relationshipHints) ? blueprint.relationshipHints.filter((relation: unknown) => relation && typeof relation === 'object'
        && 'from' in relation && relation.from === candidate.name).map((relation: { to?: unknown; relation?: unknown }) => ({
          ...(typeof relation.to === 'string' ? { targetName: relation.to } : {}), relation: typeof relation.relation === 'string' ? relation.relation : '', raw: structuredClone(relation) })) : []
      return { selectionKey: `${blueprint.chapterNumber}:${index}`, sourceId: `${operation.operation_id}:${blueprint.chapterNumber}:${index}`,
        fields: { name: candidate.name, role: candidate.role }, relationships, rawValue: { candidate: structuredClone(candidate), characters: [...blueprint.characters], relationshipHints: blueprint.relationshipHints } }
    }))
    const progress = runs.listDirectoryProgress().find(item => item.operationId === operation.operation_id)
    if (progress && progress.sourceHandle.projectId !== projectId) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
    if (forWrite && progress) assertSources(progress.sourceHandle, blueprints.map(blueprint => blueprint.chapterNumber))
    const model = progress ? runs.get(progress.sourceHandle.runId).binding.sourceManifest.modelReceipt as { modelRevision: string } : undefined
    const sourceHash = textHash(JSON.stringify([operation.payload_hash, operation.character_sync_input]))
    return { items, sourceHash, provenance: progress && model ? { kind: 'generated', modelRevision: model.modelRevision,
      source: { projectId, epoch: progress.sourceHandle.epoch, sourceId: operation.operation_id, revision: 0, contentHash: sourceHash } } : null }
  }
  if (source.kind !== 'generation' || !['architecture', 'planning-material'].includes(source.inputKind)
    || Object.keys(source).some(key => !['kind', 'inputKind', 'handle', 'artifacts', 'manifestArtifactId'].includes(key))
    || !Array.isArray(source.artifacts) || !source.artifacts.length || source.artifacts.length > 64
    || new Set(source.artifacts.map(item => item.artifactId)).size !== source.artifacts.length) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
  const run = runs.get(source.handle.runId)
  if (run.binding.projectId !== projectId || source.handle.projectId !== projectId || run.rootActionId !== source.handle.rootActionId)
    throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
  if (forWrite) assertSources(source.handle)
  const artifacts = source.artifacts.map(reference => {
    const row = db.prepare('SELECT run_id,attempt_id,status FROM generation_artifacts WHERE artifact_id=?').get(reference.artifactId) as { run_id: string; attempt_id: string; status: string } | undefined
    if (!row || row.run_id !== run.runId || row.status === 'discarded' || Object.keys(reference).some(key => !['artifactId', 'revision', 'textHash'].includes(key))) throw new Error('CHARACTER_PROPOSAL_ARTIFACT_INVALID')
    const receipt = runs.receipt(row.attempt_id), artifact = receipt.artifact
    if (!artifact || reference.revision !== artifact.revision || reference.textHash !== artifact.textHash
      || !['settled', 'unknown'].includes(receipt.attempt.status) || receipt.result?.finishReason !== 'stop') throw new Error('CHARACTER_PROPOSAL_ARTIFACT_INVALID')
    return { artifactId: artifact.artifactId, text: artifact.text }
  })
  let items: Omit<CharacterProposalItem, 'resolution'>[]
  if (source.inputKind === 'architecture') {
    const manifest = artifacts.find(item => item.artifactId === source.manifestArtifactId)
    if (!manifest || run.binding.sourceManifest.operation !== 'character-architecture') throw new Error('CHARACTER_PROPOSAL_MANIFEST_INVALID')
    items = parseArchitectureCharacterProposal({ manifest, details: artifacts.filter(item => item !== manifest) })
  } else {
    if (source.manifestArtifactId || run.binding.sourceManifest.operation !== 'planning-material-character-extraction') throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
    const inputs = run.binding.sourceManifest.authorInputs as GenerationAuthorInput[]
    const materials = inputs.map((input, index) => {
      if (input.id !== `planning-material:${index}`) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
      const material = JSON.parse(input.text) as { fileName: string; text: string }
      if (typeof material.fileName !== 'string' || typeof material.text !== 'string') throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
      return material
    })
    items = parsePlanningMaterialCharacterProposal({ artifacts, expectedSourceIds: characterProposalMaterialChunks(materials).map(item => item.sourceId) })
  }
  const model = run.binding.sourceManifest.modelReceipt as { modelRevision: string }
  const sourceHash = textHash(JSON.stringify([source, items]))
  return { items, sourceHash, provenance: { kind: 'generated', modelRevision: model.modelRevision,
    source: { projectId, epoch: source.handle.epoch, sourceId: run.runId, revision: 0, contentHash: sourceHash } } }
}
