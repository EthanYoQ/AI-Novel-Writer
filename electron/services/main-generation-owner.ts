import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { BeginGenerationRequest, ExecuteGenerationRequest, BeginGenerationBatchRequest, GenerationDraftCommitRequest, GenerationRecoveryContext, VisibleCompositionAlgorithm } from '../../src/shared/generation-owner-contract'
import { generationOutputContract, type GenerationAuthorInput } from '../../src/shared/generation-owner-contract'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunView, MainGenerationSnapshot } from '../../src/services/generation/generation-runtime'
import type { ModelProfile, ModelExecutionLeaseReceipt, LLMFinishReason } from '../../src/shared/ipc-channels'
import { tokenLiability } from '../../src/shared/generation-contract'
import { GenerationRunRepository, textHash, type DurableGenerationRun, type RunBinding, type GenerationExecutionReceipt } from '../repositories/generation-run-repository'
import { ModelExecutionLeaseRegistry, createModelExecutionLeaseReceipt } from './model-execution-lease'
import { createGenerationRunService, type GenerationRunServiceDependencies } from './generation-run-service'
import { assertSemanticGenerationTask, buildMainGenerationPlan, MAIN_GENERATION_POLICY, type MainGenerationPlan } from './main-generation-plan'
import { LLMFactory } from '../llm/llm-factory'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import type { ProviderUsageEvidence } from '../llm/provider.interface'
import type { BlueprintRangeCommitReceipt } from '../repositories/blueprint-repository'
import { GenerationDraftEffects, assertGenerationBatchIntent } from './generation-draft-effects'
import { CharacterProposalService } from './character-proposal-service'
import { proveCharacterProposal } from './generation-character-proposal-proof'
import { compareGenerationSourceBindings } from './generation-source-binding'
import type { GenerationKnowledgeSnapshot } from '../../src/shared/generation-knowledge'
import type { PrepareDraftContextRequest, PreparedDraftContext } from '../../src/shared/generation-owner-contract'
import { FinalizedCharacterGeneration } from './finalized-character-generation'
import type { FinalizedCharacterGenerationCommit } from '../../src/shared/finalized-character-generation'

export type SafeGenerationModelReceipt = Omit<ModelExecutionLeaseReceipt, 'leaseId' | 'createdAt' | 'expiresAt'>
export function safeGenerationModelReceipt(receipt: ModelExecutionLeaseReceipt): SafeGenerationModelReceipt {
  return { modelId: receipt.modelId, provider: receipt.provider, protocol: receipt.protocol, modelName: receipt.modelName,
    modelRevision: receipt.modelRevision, endpointFingerprint: receipt.endpointFingerprint, capabilityEvidence: structuredClone(receipt.capabilityEvidence) }
}
export interface MainGenerationOwnerDependencies {
  database: Database.Database
  projectId: string
  epoch: string
  assertCurrent: () => void
  leases: ModelExecutionLeaseRegistry
  loadModel: (id: string) => ModelProfile | null
  buildBinding: (selection: BeginGenerationRequest & { knowledgeSnapshot?: GenerationKnowledgeSnapshot; finalizedCharacterContextHash?: string }, model: SafeGenerationModelReceipt) => RunBinding
  rebuildBinding: (previous: RunBinding, model: SafeGenerationModelReceipt) => RunBinding
  beforeDispatch?: () => void
  onSnapshot?: (snapshot: MainGenerationSnapshot) => void
  dispatch?: GenerationRunServiceDependencies['dispatch']
}

interface ProviderRequest { model: ModelProfile; task: GenerationTask; plan: MainGenerationPlan }
async function dispatchProvider(value: unknown, options: Parameters<GenerationRunServiceDependencies['dispatch']>[1]) {
  const { model, task, plan } = value as ProviderRequest
  let evidence: ProviderUsageEvidence | null = null
  let finishReason: LLMFinishReason | null = null
  let failed = false
  await LLMFactory.getProvider(model).generateStream(model, task.messages.map(message => ({ ...message })), {
    ...plan.options, signal: options.signal, visibleOnly: true,
    onChunk: text => options.onVisible({ kind: 'delta', text }),
    onUsageEvidence: value => { evidence = value },
    onDone: (text, _usage, reason) => { options.onVisible({ kind: 'cumulative', text }); finishReason = reason },
    onError: () => { failed = true },
  })
  if (failed || finishReason === null) throw new Error('GENERATION_PROVIDER_FAILED')
  const usageEvidence = evidence as ProviderUsageEvidence | null
  return { finishReason, usage: usageEvidence ? { ...usageEvidence.usage, reasoningTokens: usageEvidence.reasoningTokens,
    accounting: usageEvidence.accounting, totalIncludesReasoning: usageEvidence.totalIncludesReasoning,
    trusted: plan.trustedUsage && usageEvidence.protocol === model.protocol } : null }
}

/** One owner per captured database/session. No renderer budget, lease or hash is authoritative. */
export function createMainGenerationOwner(deps: MainGenerationOwnerDependencies) {
  const repository = new GenerationRunRepository(() => deps.database)
  const draftEffects = new GenerationDraftEffects(deps.database, repository)
  const runLeases = new Map<string, string>()
  const volatileReceipts = new Map<string, GenerationExecutionReceipt>()
  const pending = new Map<string, { hash: string; promise: Promise<MainGenerationExecuteReceipt> }>()
  const preparations = new Map<string, { binding: RunBinding; knowledgeSnapshot: GenerationKnowledgeSnapshot }>()
  let closed = false
  const assertCurrent = () => {
    if (closed || !deps.database.open) throw new Error('GENERATION_OWNER_CLOSED')
    deps.assertCurrent()
  }
  const modelReceipt = (binding: RunBinding): SafeGenerationModelReceipt => {
    const value = binding.sourceManifest.modelReceipt as SafeGenerationModelReceipt | undefined
    if (!value || typeof value.modelId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.modelRevision)) throw new Error('GENERATION_MODEL_BINDING_INVALID')
    return value
  }
  const finalizedCharacters = new FinalizedCharacterGeneration(deps.database, repository, { projectId: deps.projectId, epoch: deps.epoch }, assertCurrent)
  const handleOf = (run: DurableGenerationRun): MainGenerationRunHandle => ({ projectId: run.binding.projectId,
    epoch: run.binding.epoch, rootActionId: run.rootActionId, runId: run.runId })
  const requireRun = (handle: MainGenerationRunHandle, execution = false) => {
    assertCurrent()
    const run = repository.get(handle.runId)
    if (run.binding.projectId !== deps.projectId || !isDeepStrictEqual(handleOf(run), handle)) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    if (execution && run.binding.epoch !== deps.epoch) throw new Error('GENERATION_EPOCH_STALE')
    return run
  }
  const snapshotOf = (receipt: GenerationExecutionReceipt): MainGenerationSnapshot | null => {
    const artifact = receipt.artifact
    if (!artifact) return null
    const terminal = ['settled', 'unknown', 'cancelled-before-dispatch'].includes(receipt.attempt.status)
    const status = !terminal ? 'running' : receipt.failureCode ? 'failed' : receipt.result?.finishReason === 'stop' ? 'completed'
      : receipt.attempt.status === 'cancelled-before-dispatch' || receipt.budget.root.status === 'cancelled' ? 'cancelled'
        : receipt.result?.finishReason ? 'failed' : 'unknown'
    // Unknown usage liability can coexist with a persisted, trusted stop/length result.
    const compositionEligible = ['settled', 'unknown'].includes(receipt.attempt.status) && !receipt.failureCode
      && receipt.budget.root.status !== 'cancelled' && ['stop', 'length'].includes(receipt.result?.finishReason ?? '')
      && Boolean(artifact.text.trim()) && deps.database.prepare("SELECT 1 FROM generation_artifacts WHERE artifact_id=? AND status<>'discarded'").pluck().get(artifact.artifactId) === 1
    return { ...handleOf(receipt.run), epoch: artifact.epoch, artifactId: artifact.artifactId, attemptId: artifact.attemptId,
      revision: artifact.revision, durableRevision: artifact.revision, text: artifact.text, textHash: artifact.textHash, status, compositionEligible }
  }
  const service = createGenerationRunService({ repository, dispatch: deps.dispatch ?? dispatchProvider,
    validateRecovery: async (previous, next) => {
      assertCurrent()
      const current = deps.rebuildBinding(previous, currentModelReceipt(previous))
      return isDeepStrictEqual(current, next)
    },
    onSnapshot: event => {
      if (closed || event.storageFailed) return
      const snapshot = snapshotOf(repository.receipt(event.attemptId))
      if (snapshot) deps.onSnapshot?.(snapshot)
    },
  })
  service.recoverInterrupted()
  function currentModelReceipt(binding: RunBinding): SafeGenerationModelReceipt {
    const model = deps.loadModel(modelReceipt(binding).modelId)
    if (!model) throw new Error('GENERATION_MODEL_MISSING')
    return safeGenerationModelReceipt(createModelExecutionLeaseReceipt(model, { leaseId: 'read-only-evidence', createdAt: 0, expiresAt: 0 }))
  }
  const viewOf = (run: DurableGenerationRun): MainGenerationRunView => {
    const budget = repository.budget(run.rootActionId)
    const visibleIds = new Set(repository.listCandidates().map(artifact => artifact.artifactId))
    const candidates = budget.attempts.map(attempt => volatileReceipts.get(attempt.attemptId) ?? repository.receipt(attempt.attemptId))
      .filter(receipt => receipt.run.runId === run.runId && receipt.artifact && visibleIds.has(receipt.artifact.artifactId))
      .map(receipt => ({ ...snapshotOf(receipt)!, fingerprint: receipt.artifact!.fingerprint, nonReplayable: true as const }))
    const artifacts = candidates.filter(artifact => artifact.epoch === run.binding.epoch)
    return { handle: handleOf(run), status: run.status as MainGenerationRunView['status'],
      nonReplayable: run.binding.epoch !== deps.epoch || run.status !== 'running' || !!budget.blockedCode,
      budget: { maxAttempts: budget.policy.maxPhysicalRequests, maxRequestedOutputTokens: budget.policy.maxTokenLiability,
        maxRequestedOutputTokensPerAttempt: budget.policy.maxOutputPerRequest,
        deadlineAt: Date.now() + Math.max(0, budget.policy.maxActiveElapsedMs - budget.activeElapsedMs) },
      ledger: { policy: budget.policy, tokenLiability: budget.attempts.reduce((sum, attempt) => sum + tokenLiability(attempt), 0),
        physicalRequests: budget.attempts.filter(attempt => attempt.status !== 'cancelled-before-dispatch').length,
        activeElapsedMs: budget.activeElapsedMs, blockedCode: budget.blockedCode }, artifacts, candidates,
      unsavedTails: service.readUnsavedTails().filter(tail => budget.attempts.some(attempt => attempt.attemptId === tail.attemptId)) }
  }
  const list = () => {
    assertCurrent()
    const rows = deps.database.prepare('SELECT run_id FROM generation_runs ORDER BY created_at_ms DESC, rowid DESC').all() as { run_id: string }[]
    return rows.map(row => repository.get(row.run_id)).filter(run => run.binding.projectId === deps.projectId).map(viewOf)
  }
  const preparationProjection = (binding: RunBinding, excludeKnowledge = false) => ({
    manifest: Object.fromEntries(Object.entries(binding.sourceManifest).filter(([key]) => !['selectedDraftIds', 'selectedFinalizedDraftIds', ...(excludeKnowledge ? ['knowledgeSnapshot'] : [])].includes(key))),
    fingerprint: Object.fromEntries(Object.entries(binding.fingerprint).filter(([key]) => !['contextSnapshotHash', 'dependencyHash'].includes(key))),
    sources: binding.sourceRefs.filter(ref => !/^(draft|finalized):/.test(ref.sourceId) && (!excludeKnowledge || !/^(kb:|knowledge-selection$)/.test(ref.sourceId))),
  })
  const preparationMatches = (previous: RunBinding, current: RunBinding, excludeKnowledge = false) =>
    isDeepStrictEqual(preparationProjection(previous, excludeKnowledge), preparationProjection(current, excludeKnowledge))
    && previous.sourceRefs.filter(ref => /^(draft|finalized):/.test(ref.sourceId))
      .every(ref => isDeepStrictEqual(ref, current.sourceRefs.find(candidate => candidate.sourceId === ref.sourceId)))
  const preparedKnowledge = (preparationId: string): GenerationKnowledgeSnapshot => {
    assertCurrent()
    const prepared = preparations.get(preparationId)
    if (!prepared) throw new Error('GENERATION_DRAFT_PREPARATION_REQUIRED')
    return structuredClone(prepared.knowledgeSnapshot)
  }
  const draftPreparationBinding = (request: PrepareDraftContextRequest, knowledgeSnapshot?: GenerationKnowledgeSnapshot): RunBinding => {
    assertCurrent()
    if (!request || typeof request.query !== 'string' || knowledgeSnapshot && request.query !== knowledgeSnapshot.query
      || Object.keys(request).some(key => !['chapterNumber', 'modelId', 'promptKeys', 'skillStages', 'authorInputs', 'query', 'selectedDraftIds', 'batchId'].includes(key))) throw new Error('GENERATION_DRAFT_PREPARATION_INVALID')
    const model = deps.loadModel(request.modelId)
    if (!model) throw new Error('GENERATION_MODEL_MISSING')
    const receipt = safeGenerationModelReceipt(createModelExecutionLeaseReceipt(model, { leaseId: 'read-only-evidence', createdAt: 0, expiresAt: 0 }))
    const selection = { operation: 'chapter-draft', uiActionNonce: 'prepare-only', modelId: request.modelId, chapterNumber: request.chapterNumber,
      selectedDraftIds: request.selectedDraftIds, selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: Array.from({ length: 6 }, (_, index) => request.chapterNumber + index),
      promptKeys: request.promptKeys, skillStages: request.skillStages, authorInputs: request.authorInputs, output: 'visible-text' as const,
      ...(request.batchId ? { batchId: request.batchId } : {}), ...(knowledgeSnapshot ? { knowledgeSnapshot: structuredClone(knowledgeSnapshot) } : {}) }
    return deps.buildBinding(selection, receipt)
  }
  const prepareDraftContext = (request: PrepareDraftContextRequest, knowledgeSnapshot: GenerationKnowledgeSnapshot, beforeKnowledgeRead?: RunBinding): PreparedDraftContext => {
    const { binding, selectedDrafts } = deps.database.transaction(() => {
      const binding = draftPreparationBinding(request, knowledgeSnapshot)
      if (beforeKnowledgeRead && !preparationMatches(beforeKnowledgeRead, binding, true)) throw new Error('GENERATION_DRAFT_PREPARATION_CHANGED')
      const selectedDrafts = request.selectedDraftIds.map(draftId => {
        const row = deps.database.prepare('SELECT d.chapter_number,d.version,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(draftId) as { chapter_number: number; version: number; body: string }
        return { draftId, chapterNumber: row.chapter_number, version: row.version, contentHash: textHash(row.body), content: row.body }
      })
      return { binding, selectedDrafts }
    })()
    const preparationId = randomUUID()
    if (preparations.size >= 64) preparations.delete(preparations.keys().next().value!)
    preparations.set(preparationId, { binding, knowledgeSnapshot: structuredClone(knowledgeSnapshot) })
    return { preparationId, knowledgeSnapshot: structuredClone(knowledgeSnapshot), selectedDrafts }
  }
  const begin = (selection: BeginGenerationRequest, batchInitialization = false): MainGenerationRunView => {
    assertCurrent()
    if (!selection || typeof selection.operation !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(selection.operation)
      || !Array.isArray(selection.promptKeys) || selection.promptKeys.length === 0
      || Object.hasOwn(selection, 'parentRootActionId') && (typeof selection.parentRootActionId !== 'string' || !selection.parentRootActionId.trim())
      || typeof selection.uiActionNonce !== 'string' || !selection.uiActionNonce.trim() || selection.uiActionNonce.length > 256
      || Object.keys(selection).some(key => !['operation', 'uiActionNonce', 'modelId', 'chapterNumber', 'selectedDraftIds', 'selectedFinalizedDraftIds', 'selectedBlueprintChapterNumbers', 'promptKeys', 'skillStages', 'authorInputs', 'output', 'outputOverrides', 'parentRootActionId', 'continueDirectoryOperationId', 'batchId', 'batchIntent', 'preparationId', 'finalizedCharacterContextId'].includes(key))) throw new Error('GENERATION_BEGIN_INVALID')
    generationOutputContract(selection)
    const finalizedCharacterContextHash = finalizedCharacters.admit(selection)
    if (selection.batchIntent && !batchInitialization) throw new Error('GENERATION_BATCH_INTENT_MAIN_ONLY')
    const batch = selection.batchId ? draftEffects.readBatch(selection.batchId, deps.projectId) : undefined
    if (batch) {
      if (selection.parentRootActionId !== batch.rootHandle.rootActionId || selection.operation !== 'chapter-draft'
        || selection.chapterNumber !== batch.nextChapterNumber || selection.batchIntent || selection.continueDirectoryOperationId
        || batch.completedChapters.some(item => item.chapterNumber === selection.chapterNumber)) throw new Error('GENERATION_BATCH_PROGRESS_CONFLICT')
      const predecessor = batch.completedChapters.find(item => item.chapterNumber === selection.chapterNumber! - 1)
      if (selection.selectedDraftIds.some(id => id !== predecessor?.draftId || batch.mode !== 'draft_review')) throw new Error('GENERATION_BATCH_LINEAGE_INVALID')
      if (predecessor && batch.mode === 'draft_review' && !selection.selectedDraftIds.includes(predecessor.draftId)) throw new Error('GENERATION_BATCH_LINEAGE_INVALID')
      if (predecessor && batch.mode === 'auto_finalize' && !selection.selectedFinalizedDraftIds.includes(predecessor.draftId)) throw new Error('GENERATION_BATCH_LINEAGE_INVALID')
      for (const input of batch.authorInputs) {
        if (!isDeepStrictEqual(input, selection.authorInputs?.find(item => item.id === input.id))) throw new Error('GENERATION_BATCH_AUTHOR_INPUT_CHANGED')
      }
    }
    const continuation = selection.continueDirectoryOperationId === undefined ? undefined
      : repository.listDirectoryProgress().find(item => item.operationId === selection.continueDirectoryOperationId)
    if (selection.continueDirectoryOperationId !== undefined && (!continuation?.remainingRange || selection.parentRootActionId
      || selection.output !== 'structured-data'
      // Selected rows also include preceding chapters consumed as source dependencies.
      // The formal target is separately authorized by the durable remainingRange.
      || Array.from({ length: continuation.remainingRange.endChapter - continuation.remainingRange.startChapter + 1 }, (_, index) => continuation.remainingRange!.startChapter + index)
        .some(chapter => !selection.selectedBlueprintChapterNumbers?.includes(chapter)))) throw new Error('GENERATION_DIRECTORY_CONTINUATION_INVALID')
    if (continuation) {
      const originalInputs = repository.get(continuation.sourceHandle.runId).binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined
      for (const id of ['directory:author-config', 'directory:pacing-guidance']) {
        const original = originalInputs?.find(input => input.id === id)
        if (!original || !isDeepStrictEqual(original, selection.authorInputs?.find(input => input.id === id)))
          throw new Error('GENERATION_DIRECTORY_AUTHOR_INPUT_CHANGED')
      }
    }
    const lease = deps.leases.begin(selection.modelId)
    try {
      const prepared = selection.preparationId ? preparations.get(selection.preparationId) : undefined
      if (selection.preparationId && (!prepared || selection.operation !== 'chapter-draft')) throw new Error('GENERATION_DRAFT_PREPARATION_REQUIRED')
      const binding = deps.buildBinding({ ...selection, ...(prepared ? { knowledgeSnapshot: prepared.knowledgeSnapshot } : {}),
        ...(finalizedCharacterContextHash ? { finalizedCharacterContextHash } : {}) }, safeGenerationModelReceipt(lease))
      if (prepared && !preparationMatches(prepared.binding, binding)) throw new Error('GENERATION_DRAFT_PREPARATION_CHANGED')
      if (binding.projectId !== deps.projectId || binding.epoch !== deps.epoch) throw new Error('GENERATION_BINDING_INVALID')
      const run = deps.database.transaction(() => {
      if (batch) repository.activateRootForCommittedStage(batch.rootHandle.rootActionId, binding)
      if (continuation && !continuation.continuationHandle) repository.activateRootForCommittedStage(continuation.sourceHandle.rootActionId, binding)
      const next = service.open({ ...binding, operation: selection.operation, uiActionNonce: selection.uiActionNonce,
        frozenInputHash: textHash(JSON.stringify([binding.fingerprint, binding.contextSnapshotId, selection.output])),
        budget: MAIN_GENERATION_POLICY.budget, parentRootActionId: continuation?.sourceHandle.rootActionId ?? selection.parentRootActionId })
      if (continuation?.continuationHandle && continuation.continuationHandle.runId !== next.runId) throw new Error('GENERATION_DIRECTORY_CONTINUATION_EXISTS')
      if (batch?.currentChapterRunHandle && batch.currentChapterRunHandle.runId !== next.runId) throw new Error('GENERATION_BATCH_RECOVERY_REQUIRED')
      if (continuation && !continuation.continuationHandle) repository.bindDirectoryContinuation(continuation.operationId, handleOf(next))
      return next
      }).immediate()
      if (run.binding.epoch === deps.epoch && !runLeases.has(run.runId)) runLeases.set(run.runId, lease.leaseId)
      else deps.leases.close(lease.leaseId)
      return viewOf(run)
    } catch (error) { deps.leases.close(lease.leaseId); throw error }
  }
  const outcomeOf = (receipt: GenerationExecutionReceipt, task: GenerationTask): MainGenerationExecuteReceipt => {
    const frozenModel = modelReceipt(receipt.run.binding), budget = receipt.budget
    const stored = receipt.result?.finishReason
    const finishReason: LLMFinishReason = receipt.failureCode ? 'error'
      : ['stop', 'length', 'content_filter', 'error', 'unknown'].includes(stored ?? '') ? stored as LLMFinishReason : 'unknown'
    const evidence = frozenModel.capabilityEvidence
    const details = { purpose: task.purpose,
      ...(receipt.artifact ? { visibleArtifact: { artifactId: receipt.artifact.artifactId, attemptId: receipt.attempt.attemptId,
        revision: receipt.artifact.revision, textHash: receipt.artifact.textHash } } : {}),
      model: { id: frozenModel.modelId, configurationRevision: frozenModel.modelRevision, endpointFingerprint: frozenModel.endpointFingerprint },
      capabilities: { contextWindowTokens: evidence.contextWindowTokens, maxOutputTokens: evidence.maxOutputTokens,
        reasoning: evidence.reasoning, structuredOutput: evidence.structuredOutput, usage: evidence.usage, source: evidence.source },
      budget: { attempt: budget.attempts.findIndex(attempt => attempt.attemptId === receipt.attempt.attemptId) + 1,
        maxAttempts: budget.policy.maxPhysicalRequests, requestedOutputTokens: receipt.attempt.requestedOutputTokens,
        cumulativeRequestedOutputTokens: budget.attempts.reduce((sum, attempt) => sum + (attempt.status === 'cancelled-before-dispatch' ? 0 : attempt.requestedOutputTokens), 0),
        maxRequestedOutputTokens: budget.policy.maxTokenLiability, maxRequestedOutputTokensPerAttempt: budget.policy.maxOutputPerRequest,
        deadlineAt: Date.now() + Math.max(0, budget.policy.maxActiveElapsedMs - budget.activeElapsedMs) }, finishReason }
    const content = receipt.artifact?.text ?? ''
    return { outcome: finishReason === 'stop' ? { status: 'completed', content, finishReason, receipt: details }
      : { status: 'incomplete', content, finishReason, receipt: details }, run: viewOf(repository.get(receipt.run.runId)) }
  }
  const execute = async (request: ExecuteGenerationRequest): Promise<MainGenerationExecuteReceipt> => {
    const run = requireRun(request.handle, true)
    assertSemanticGenerationTask(request.task)
    const task = structuredClone(request.task)
    const contract = run.binding.sourceManifest.outputContract
    const composite = contract as { primary?: string; overrides?: { purpose: string; output: string }[] }
    const expectedOutput = typeof contract === 'string' ? contract : composite.overrides?.find(item => item.purpose === task.purpose)?.output ?? composite.primary
    if (task.output !== expectedOutput) throw new Error('GENERATION_OUTPUT_CONTRACT_CHANGED')
    const requestHash = textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
    const key = JSON.stringify([run.runId, request.invocationNonce])
    const inFlight = pending.get(key)
    if (inFlight) {
      if (inFlight.hash !== requestHash) throw new Error('GENERATION_INVOCATION_CONFLICT')
      return inFlight.promise
    }
    const existing = repository.findInvocation(run.runId, request.invocationNonce, requestHash)
    if (existing && existing.attempt.status !== 'dispatch-marked' && existing.attempt.status !== 'reserved') return outcomeOf(volatileReceipts.get(existing.attempt.attemptId) ?? existing, task)
    const operation = (async () => {
    const current = deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))
    if (!isDeepStrictEqual(current, run.binding)) throw new Error('GENERATION_SOURCE_CHANGED')
    const leaseId = runLeases.get(run.runId)
    if (!leaseId) throw new Error('GENERATION_RESUME_REQUIRED')
    const model = deps.leases.resolve(leaseId)
    const plan = buildMainGenerationPlan(model, modelReceipt(run.binding), task, repository.budget(run.rootActionId))
    deps.beforeDispatch?.()
    assertCurrent()
    const receipt = await service.execute({ runId: run.runId, invocationNonce: request.invocationNonce, requestHash,
      providerRequest: { model, task, plan } satisfies ProviderRequest, reservedTokens: plan.reservedTokens,
      requestedOutputTokens: plan.requestedOutputTokens, inputUpperBoundTokens: plan.inputUpperBoundTokens,
      reasoningUpperBoundTokens: plan.reasoningUpperBoundTokens, usagePolicy: plan.usagePolicy, purpose: task.purpose })
    if (receipt.failureCode || receipt.unsavedTail) volatileReceipts.set(receipt.attempt.attemptId, receipt)
    assertCurrent()
    const snapshot = snapshotOf(receipt)
    if (snapshot) deps.onSnapshot?.(snapshot)
    return outcomeOf(receipt, task)
    })()
    pending.set(key, { hash: requestHash, promise: operation })
    try { return await operation } finally { pending.delete(key) }
  }
  const resume = async (handle: MainGenerationRunHandle) => {
    const run = requireRun(handle)
    const receipt = currentModelReceipt(run.binding)
    const next = deps.rebuildBinding(run.binding, receipt)
    const lease = deps.leases.begin(receipt.modelId)
    try {
      if (!isDeepStrictEqual(safeGenerationModelReceipt(lease), receipt)) throw new Error('GENERATION_MODEL_CHANGED')
      const resumed = await service.resume(run.runId, next)
      assertCurrent()
      const previous = runLeases.get(run.runId)
      if (previous) deps.leases.close(previous)
      runLeases.set(run.runId, lease.leaseId)
      return viewOf(resumed)
    } catch (error) { deps.leases.close(lease.leaseId); throw error }
  }
  const assertSourcesCurrent = (handle: MainGenerationRunHandle, blueprintRange?: { startChapter: number; endChapter: number }) => {
      const run = requireRun(handle, true)
      if (repository.budget(run.rootActionId).root.status === 'cancelled') throw new Error('GENERATION_ACTION_CANCELLED')
      if (blueprintRange) {
        const continued = repository.listDirectoryProgress().find(item => item.continuationHandle?.runId === run.runId)
        if (continued && !isDeepStrictEqual(continued.remainingRange, blueprintRange)) throw new Error('GENERATION_DIRECTORY_CONTINUATION_RANGE_CHANGED')
        const selected = run.binding.sourceManifest.selectedBlueprintChapterNumbers as number[] | undefined
        if (!selected || !Number.isSafeInteger(blueprintRange.startChapter) || !Number.isSafeInteger(blueprintRange.endChapter)
          || blueprintRange.startChapter < 1 || blueprintRange.endChapter < blueprintRange.startChapter
          || blueprintRange.endChapter - blueprintRange.startChapter >= 10000
          || Array.from({ length: blueprintRange.endChapter - blueprintRange.startChapter + 1 }, (_, index) => blueprintRange.startChapter + index).some(chapter => !selected.includes(chapter)))
          throw new Error('GENERATION_FORMAL_RANGE_NOT_SELECTED')
      }
      const current = deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))
      if (!isDeepStrictEqual(current, run.binding)) throw new Error('GENERATION_SOURCE_CHANGED')
    }
  const readContext = (handle: MainGenerationRunHandle): GenerationRecoveryContext => {
    const run = requireRun(handle), manifest = run.binding.sourceManifest, composition = repository.readVisibleComposition(run.runId)
    const saved = draftEffects.readCommit(run.runId)
    const selectedDrafts = (manifest.selectedDraftIds as number[] ?? []).map(draftId => {
      const row = deps.database.prepare('SELECT d.chapter_number,d.version,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(draftId) as { chapter_number: number; version: number; body: string } | undefined
      const ref = run.binding.sourceRefs.find(source => source.sourceId === `draft:${draftId}`)
      return row && ref && row.version === ref.revision && textHash(row.body) === ref.contentHash
        ? { draftId, chapterNumber: row.chapter_number, version: row.version, contentHash: ref.contentHash, content: row.body } : null
    })
    const rows = deps.database.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(run.runId) as { attempt_id: string; usage_receipt_json: string }[]
    const last = composition ? deps.database.prepare('SELECT attempt_id FROM generation_artifacts WHERE artifact_id=?').pluck().get(composition.artifactIds.at(-1)) as string : undefined
    return { modelId: modelReceipt(run.binding).modelId, handle: handleOf(run), operation: manifest.operation as string, chapterNumber: manifest.chapterNumber as number | undefined,
      authorInputs: structuredClone(manifest.authorInputs as GenerationAuthorInput[] ?? []),
      selectedDraftIds: structuredClone(manifest.selectedDraftIds as number[] ?? []), selectedFinalizedDraftIds: structuredClone(manifest.selectedFinalizedDraftIds as number[] ?? []),
      selectedBlueprintChapterNumbers: structuredClone(manifest.selectedBlueprintChapterNumbers as number[] ?? []), composition,
      lastCompositionFinishReason: last ? repository.receipt(last).result?.finishReason ?? null : null,
      attemptedPurposes: rows.map(row => JSON.parse(row.usage_receipt_json).purpose ?? 'unknown'),
      ...(saved ? { savedDraft: { success: true as const, id: saved.id, version: saved.version, content: saved.content, contentHash: saved.contentHash } } : {}),
      ...(manifest.knowledgeSnapshot ? { knowledgeSnapshot: structuredClone(manifest.knowledgeSnapshot) as GenerationKnowledgeSnapshot } : {}),
      ...(selectedDrafts.every(item => item !== null) ? { selectedDrafts } : {}),
      ...(manifest.batchId ? { batchId: manifest.batchId as string } : {}) }
  }
  const readBatch = (batchId: string) => { assertCurrent(); return draftEffects.readBatch(batchId, deps.projectId) }
  const characters = new CharacterProposalService(deps.database, deps.projectId, (source, forWrite) => {
    assertCurrent(); return proveCharacterProposal(deps.database, repository, deps.projectId, source, forWrite, (handle, committedBlueprintChapters) => {
      const run = requireRun(handle)
      const current = deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))
      const projection = (binding: RunBinding) => ({ sourceManifest: binding.sourceManifest,
        fingerprint: Object.fromEntries(Object.entries(binding.fingerprint).filter(([key]) => !['contextSnapshotHash', 'chapterBriefHash'].includes(key))),
        sources: binding.sourceRefs.filter(ref => !committedBlueprintChapters?.some(chapter => ref.sourceId === `blueprint:${chapter}`))
          .map(({ epoch: _epoch, ...ref }) => { void _epoch; return ref }) })
      const matches = committedBlueprintChapters ? isDeepStrictEqual(projection(run.binding), projection(current)) : compareGenerationSourceBindings(run.binding, current)
      if (repository.budget(run.rootActionId).root.status === 'cancelled' || !matches) throw new Error('CHARACTER_PROPOSAL_SOURCE_CHANGED')
    })
  })
  return { begin: (selection: BeginGenerationRequest) => begin(selection), execute, resume, list, assertSourcesCurrent,
    characterProposals: characters,
    readFinalizedCharacterContext: (draftId: number) => finalizedCharacters.readContext(draftId),
    commitFinalizedCharacterStates: (request: FinalizedCharacterGenerationCommit) => finalizedCharacters.commit(request, characters, assertSourcesCurrent),
    readContext, readBatch, prepareDraftContext, preparedKnowledge, draftPreparationBinding,
    beginBatch: (request: BeginGenerationBatchRequest) => {
      assertGenerationBatchIntent(request)
      const { mode, range, targetUnits, ...intent } = request
      const run = begin({ ...intent, operation: 'batch-chapters', selectedDraftIds: [], selectedFinalizedDraftIds: [],
        output: 'visible-text', batchIntent: { mode, range, targetUnits } }, true)
      return readBatch(run.handle.runId)
    },
    listBatches: () => { assertCurrent(); return list().filter(item => repository.get(item.handle.runId).binding.sourceManifest.batchIntent).map(item => readBatch(item.handle.runId)) },
    confirmBatchFinalization: (request: { batchId: string; chapterNumber: number; finalizationId: string }) => {
      const batch = readBatch(request.batchId)
      if (!batch.completedChapters.some(item => item.chapterNumber === request.chapterNumber && item.finalizationId === request.finalizationId && item.postProcessComplete)) throw new Error('GENERATION_BATCH_FINALIZATION_REQUIRED')
      return batch
    },
    commitDraft: (request: GenerationDraftCommitRequest) => { requireRun(request.handle); return draftEffects.commit(request, () => assertSourcesCurrent(request.handle)) },
    read: (handle: MainGenerationRunHandle) => viewOf(requireRun(handle)),
    listDirectoryProgress: () => { assertCurrent(); return repository.listDirectoryProgress().map(progress => ({ ...progress,
      authorInputs: structuredClone(repository.get(progress.sourceHandle.runId).binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined) })) },
    recordDirectoryCommit: (handle: MainGenerationRunHandle, requestedRange: { startChapter: number; endChapter: number }, receipt: BlueprintRangeCommitReceipt) => {
      requireRun(handle, true)
      const existing = repository.listDirectoryProgress().find(item => item.operationId === receipt.operationId)
      if (existing) {
        if (existing.payloadHash !== receipt.payloadHash || existing.sourceHandle.runId !== handle.runId || !isDeepStrictEqual(existing.requestedRange, requestedRange)) throw new Error('GENERATION_DIRECTORY_PROGRESS_CONFLICT')
        return existing
      }
      const progress = { operationId: receipt.operationId, payloadHash: receipt.payloadHash, sourceHandle: handle,
        requestedRange, committedRange: { startChapter: receipt.startChapter, endChapter: receipt.endChapter },
        remainingRange: receipt.endChapter < requestedRange.endChapter ? { startChapter: receipt.endChapter + 1, endChapter: requestedRange.endChapter } : null }
      repository.recordDirectoryProgress(progress)
      return progress
    },
    composeVisible: (handle: MainGenerationRunHandle, artifactIds: string[], expectedTextHash: string, algorithm?: VisibleCompositionAlgorithm) => {
      assertSourcesCurrent(handle)
      if (algorithm === 'draft-visible-v1' && requireRun(handle).binding.sourceManifest.operation !== 'chapter-draft') throw new Error('GENERATION_COMPOSITION_ALGORITHM_INVALID')
      return repository.composeVisible(handle.runId, artifactIds, expectedTextHash, algorithm)
    },
    readVisibleComposition: (handle: MainGenerationRunHandle) => {
      const run = requireRun(handle), composition = repository.readVisibleComposition(run.runId)
      return composition ? { ...composition, authorInputs: structuredClone(run.binding.sourceManifest.authorInputs as GenerationAuthorInput[] | undefined) } : null
    },
    pause: (handle: MainGenerationRunHandle) => { const run = requireRun(handle, true); service.pause(run.rootActionId); return viewOf(repository.get(run.runId)) },
    cancel: (handle: MainGenerationRunHandle) => { const run = requireRun(handle); service.cancel(run.rootActionId); return viewOf(repository.get(run.runId)) },
    restart: (handle: MainGenerationRunHandle, selection: BeginGenerationRequest) => {
      const old = requireRun(handle)
      if (selection.parentRootActionId || selection.uiActionNonce === repository.budget(old.rootActionId).root.uiActionNonce) throw new Error('GENERATION_RESTART_NEW_NONCE_REQUIRED')
      // Admit the replacement before cancelling; rejected sources must leave the original resumable.
      const next = begin(selection)
      service.cancel(old.rootActionId)
      return next
    },
    discardCandidate: (handle: MainGenerationRunHandle, artifactId: string) => {
      const run = requireRun(handle)
      const artifact = viewOf(run).candidates?.find(item => item.artifactId === artifactId)
      if (!artifact || artifact.status === 'running') throw new Error('GENERATION_CANDIDATE_NOT_DISCARDABLE')
      service.discardCandidate(artifactId)
      volatileReceipts.delete(artifact.attemptId)
      return viewOf(run)
    },
    suspendForProjectClose: () => {
      preparations.clear()
      finalizedCharacters.close()
      if (closed) return
      service.suspendForProjectClose()
      closed = true
      for (const leaseId of runLeases.values()) deps.leases.close(leaseId)
      runLeases.clear()
    },
  }
}
