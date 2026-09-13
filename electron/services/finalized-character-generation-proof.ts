import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle } from '../../src/services/generation/generation-runtime'
import type { FinalizedCharacterArtifact } from '../../src/shared/finalized-character-generation'
import { parseFinalizedCharacterStateResponse, type FinalizedCharacterContext } from '../../src/shared/finalized-continuity'
import type { GenerationAuthorInput } from '../../src/shared/generation-owner-contract'
import type { SafeGenerationModelReceipt } from './generation-source-binding'
import { GenerationRunRepository, textHash } from '../repositories/generation-run-repository'

/** All generated values are read from the immutable artifact; the request carries references only. */
export function proveFinalizedCharacterGeneration(db: Database.Database, runs: GenerationRunRepository,
  projectId: string, handle: MainGenerationRunHandle, reference: FinalizedCharacterArtifact) {
  const run = runs.get(handle.runId)
  if (Object.keys(handle).some(key => !['projectId', 'epoch', 'rootActionId', 'runId'].includes(key))
    || !isDeepStrictEqual(handle, { projectId: run.binding.projectId, epoch: run.binding.epoch, rootActionId: run.rootActionId, runId: run.runId })
    || handle.projectId !== projectId || run.binding.sourceManifest.operation !== 'finalized-character-state')
    throw new Error('CHARACTER_PROPOSAL_SOURCE_INVALID')
  const inputs = run.binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined
  const serialized = inputs?.find(input => input.id === 'finalized-character-context')?.text
  if (!serialized || run.binding.sourceManifest.finalizedCharacterContextHash !== textHash(serialized))
    throw new Error('CHARACTER_PROPOSAL_CONTEXT_UNPROVEN')
  const context = JSON.parse(serialized) as FinalizedCharacterContext
  if (context.projectId !== projectId || context.epoch !== handle.epoch || textHash(context.content) !== context.source.contentHash
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
  return { context, response, model, run, artifact }
}
