import type Database from 'better-sqlite3'
import type { CharacterProposalSource, CharacterProposalItem } from '../../src/shared/character-proposal'
import type { CharacterProposalProof } from './character-proposal-service'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import { parseLegacyRosterJson } from '../../src/shared/legacy-roster-generation-pure'
import { characterRosterIdentityKey } from '../../src/shared/character-roster'
import { validateLegacyRosterCandidate } from '../repositories/character-roster-repository'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'
import { readLegacyRosterGenerationContext } from './legacy-roster-generation-context'

export function readLegacyRosterGenerationProof(db: Database.Database, runs: GenerationRunRepository, projectId: string,
  source: Extract<CharacterProposalSource, { kind: 'legacy-roster-generation' }>) {
  if (!source || source.kind !== 'legacy-roster-generation' || Object.keys(source).some(key => !['kind','handle','artifact'].includes(key))) throw new Error('GENERATION_LEGACY_PROOF_INVALID')
  const handle = source.handle
  if (!handle || Object.keys(handle).some(key => !['projectId','epoch','rootActionId','runId'].includes(key))) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
  const run = runs.get(handle.runId), context = readLegacyRosterGenerationContext(run)
  if (handle.projectId !== projectId || run.binding.projectId !== projectId || handle.rootActionId !== run.rootActionId
    || handle.epoch !== context.originEpoch && handle.epoch !== run.binding.epoch) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
  const reference = source.artifact
  if (!reference || Object.keys(reference).some(key => !['artifactId','revision','textHash'].includes(key))) throw new Error('GENERATION_LEGACY_ARTIFACT_INVALID')
  const row = db.prepare('SELECT run_id,attempt_id,status FROM generation_artifacts WHERE artifact_id=?').get(reference.artifactId) as { run_id:string; attempt_id:string; status:string } | undefined
  if (!row || row.run_id !== run.runId || row.status === 'discarded') throw new Error('GENERATION_LEGACY_ARTIFACT_INVALID')
  const receipt = runs.receipt(row.attempt_id), artifact = receipt.artifact
  if (!artifact || artifact.revision !== reference.revision || artifact.textHash !== reference.textHash || textHash(artifact.text) !== reference.textHash
    || receipt.failureCode || !['settled','unknown'].includes(receipt.attempt.status) || receipt.result?.finishReason !== 'stop') throw new Error('GENERATION_LEGACY_ARTIFACT_INVALID')
  let candidate: { entries: unknown[] }, entries: ReturnType<typeof validateLegacyRosterCandidate>
  try { candidate = parseLegacyRosterJson(artifact.text) as typeof candidate; entries = validateLegacyRosterCandidate(candidate) }
  catch { throw new Error('GENERATION_LEGACY_CANDIDATE_INVALID') }
  const key = (index: number) => `${artifact.artifactId}:entry:${index}`
  const items: Omit<CharacterProposalItem,'resolution'>[] = entries.map((entry,index) => {
    const { currentState, relationships, legacyRelationshipNotes, ...fields } = entry
    void currentState; void legacyRelationshipNotes
    return { selectionKey:key(index), sourceId:`legacy:${context.source.legacyHash}:${index}`, fields,
      relationships:relationships.map(relation => ({ targetSelectionKey:key(entries.findIndex(target => characterRosterIdentityKey(target.name) === characterRosterIdentityKey(relation.target))),
        targetName:relation.target, relation:relation.relation, raw:structuredClone(relation) })), rawValue:structuredClone(candidate.entries[index]) }
  })
  const currentHandle:MainGenerationRunHandle={projectId,epoch:run.binding.epoch,rootActionId:run.rootActionId,runId:run.runId}
  const sourceHandle={...currentHandle,epoch:context.originEpoch}, canonicalSource={kind:source.kind,handle:sourceHandle,artifact:structuredClone(reference)}
  const sourceHash=textHash(JSON.stringify([canonicalSource,run.binding.sourceManifest.legacyRosterContextHash,items]))
  const model=run.binding.sourceManifest.modelReceipt as {modelRevision:string}
  if (!model?.modelRevision) throw new Error('GENERATION_LEGACY_PROOF_INVALID')
  const proof:CharacterProposalProof={items,sourceHash,provenance:{kind:'generated',modelRevision:model.modelRevision,
    source:{projectId,epoch:context.originEpoch,sourceId:run.runId,revision:0,contentHash:sourceHash}}}
  return {run,context,attemptId:row.attempt_id,artifact,currentHandle,sourceHandle,source:canonicalSource,proof}
}
