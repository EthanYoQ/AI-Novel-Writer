import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { FinalizedCharacterArtifact } from '../../src/shared/finalized-character-generation'
import type { FinalizationGenerationContext } from '../../src/shared/finalization-generation'
import type { CharacterProposalSource } from '../../src/shared/character-proposal'
import { parseFinalizedCharacterStateResponse, type FinalizedCharacterContext } from '../../src/shared/finalized-continuity'
import type { GenerationAuthorInput } from '../../src/shared/generation-owner-contract'
import type { SafeGenerationModelReceipt } from './generation-source-binding'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'

/** All generated values are read from the immutable artifact; the request carries references only. */
export function proveFinalizedCharacterGeneration(db: Database.Database, runs: GenerationRunRepository,
  projectId: string, handle: MainGenerationRunHandle, reference: FinalizedCharacterArtifact) {
  if (!handle || Object.keys(handle).some(key => !['projectId', 'epoch', 'rootActionId', 'runId'].includes(key)))
    throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
  const run = runs.get(handle.runId)
  const currentHandle = { projectId: run.binding.projectId, epoch: run.binding.epoch, rootActionId: run.rootActionId, runId: run.runId }
  const manifest = run.binding.sourceManifest
  const dedicated = ['finalizationGenerationContext', 'finalizationGenerationContextHash', 'finalizationGenerationOriginEpoch']
    .some(key => Object.hasOwn(manifest, key))
  if (handle.projectId !== projectId || handle.projectId !== currentHandle.projectId || handle.rootActionId !== currentHandle.rootActionId
    || manifest.operation !== 'finalized-character-state' || !dedicated && !isDeepStrictEqual(handle, currentHandle))
    throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
  const inputs = run.binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined
  const serialized = inputs?.find(input => input.id === 'finalized-character-context')?.text
  if (!serialized || run.binding.sourceManifest.finalizedCharacterContextHash !== textHash(serialized))
    throw new Error('CHARACTER_PROPOSAL_CONTEXT_UNPROVEN')
  const context = JSON.parse(serialized) as FinalizedCharacterContext
  if (dedicated) {
    const finalization = manifest.finalizationGenerationContext as FinalizationGenerationContext | undefined
    const originEpoch = manifest.finalizationGenerationOriginEpoch
    if (!finalization || typeof originEpoch !== 'string' || !originEpoch.trim()
      || manifest.finalizationGenerationContextHash !== textHash(JSON.stringify(finalization))
      || originEpoch !== context.epoch || !isDeepStrictEqual(finalization.identity, context)
      || finalization.slot?.stepKey !== 'character_cards' || !isDeepStrictEqual(finalization.slot.source, context.source)
      || context.characters.some(character => character.fields.some(field => field.projectId !== context.projectId
        || field.epoch !== context.epoch || field.characterId !== character.characterId)))
      throw new Error('CHARACTER_PROPOSAL_CONTEXT_UNPROVEN')
    if (handle.epoch !== currentHandle.epoch && handle.epoch !== originEpoch) throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
  }
  if (context.projectId !== projectId || !dedicated && context.epoch !== handle.epoch || textHash(context.content) !== context.source.contentHash
    || !isDeepStrictEqual(run.binding.sourceManifest.selectedFinalizedDraftIds, [context.source.draftId])
    || !run.binding.sourceRefs.some(ref => ref.sourceId === `finalized:${context.source.draftId}:${context.source.finalizationId}`
      && ref.contentHash === context.source.contentHash))
    throw new Error('CHARACTER_PROPOSAL_CONTEXT_UNPROVEN')
  if (!reference || Object.keys(reference).some(key => !['artifactId', 'revision', 'textHash'].includes(key)))
    throw new Error('CHARACTER_PROPOSAL_ARTIFACT_INVALID')
  const row = db.prepare('SELECT run_id,attempt_id,status FROM generation_artifacts WHERE artifact_id=?').get(reference.artifactId) as {
    run_id: string; attempt_id: string; status: string
  } | undefined
  if (!row || row.run_id !== run.runId || row.status === 'discarded') throw new Error('CHARACTER_PROPOSAL_ARTIFACT_INVALID')
  const receipt = runs.receipt(row.attempt_id), artifact = receipt.artifact
  if (!artifact || artifact.revision !== reference.revision || artifact.textHash !== reference.textHash
    || textHash(artifact.text) !== reference.textHash || receipt.failureCode
    || !['settled', 'unknown'].includes(receipt.attempt.status) || receipt.result?.finishReason !== 'stop')
    throw new Error('CHARACTER_PROPOSAL_ARTIFACT_INVALID')
  const response = parseFinalizedCharacterStateResponse(artifact.text, context)
  const model = run.binding.sourceManifest.modelReceipt as SafeGenerationModelReceipt
  if (!model || !/^[a-f0-9]{64}$/u.test(model.modelRevision)) throw new Error('CHARACTER_PROPOSAL_PROVENANCE_REQUIRED')
  const sourceHandle = dedicated ? { ...currentHandle, epoch: context.epoch } : currentHandle
  return { context, response, model, run, artifact, currentHandle, sourceHandle, stableFinalizationSource: dedicated }
}

/** Stable evidence identity is not live write authority; callers must separately check currentHandle. */
export function normalizeFinalizedCharacterProposalSource(db: Database.Database, runs: GenerationRunRepository, projectId: string,
  source: Extract<CharacterProposalSource, { kind: 'finalized-generation' }>) {
  if (!source || source.kind !== 'finalized-generation' || Object.keys(source).some(key => !['kind', 'handle', 'artifact'].includes(key)))
    throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
  const proof = proveFinalizedCharacterGeneration(db, runs, projectId, source.handle, source.artifact)
  const normalized: typeof source = proof.stableFinalizationSource ? {
    kind: 'finalized-generation', handle: proof.sourceHandle,
    artifact: { artifactId: source.artifact.artifactId, revision: source.artifact.revision, textHash: source.artifact.textHash },
  } : structuredClone(source)
  return { source: normalized, currentHandle: proof.currentHandle, stableFinalizationSource: proof.stableFinalizationSource }
}
