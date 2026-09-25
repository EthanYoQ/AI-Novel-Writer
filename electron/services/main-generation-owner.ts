import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { BeginGenerationRequest, ExecuteGenerationRequest, BeginGenerationBatchRequest, GenerationDraftCommitRequest, GenerationRecoveryContext, MaterialDecisionReceipt, VisibleCompositionAlgorithm } from '../../src/shared/generation-owner-contract'
import { generationOutputContract, type GenerationAuthorInput } from '../../src/shared/generation-owner-contract'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunView, MainGenerationSnapshot } from '../../src/services/generation/generation-runtime'
import type { ModelProfile, ModelExecutionLeaseReceipt, LLMFinishReason } from '../../src/shared/ipc-channels'
import { tokenLiability } from '../../src/shared/generation-contract'
import { GenerationRunRepository, textHash, type DurableGenerationRun, type RunBinding, type GenerationExecutionReceipt } from '../repositories/generation-run-repository'
import { getCurrentProjectPath } from '../database'
import { ModelExecutionLeaseRegistry, createModelExecutionLeaseReceipt } from './model-execution-lease'
import { createGenerationRunService, type GenerationRunServiceDependencies } from './generation-run-service'
import { assertSemanticGenerationTask, buildMainGenerationPlan, MAIN_GENERATION_POLICY, type MainGenerationPlan } from './main-generation-plan'
import { LLMFactory } from '../llm/llm-factory'
import type { GenerationAttemptReceipt, GenerationTask } from '../../src/services/generation/generation-harness'
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
import type { ReviewRevisionContext, PrepareReviewRevisionRequest, ReviewGenerationCommitRequest, RevisionGenerationCommitRequest } from '../../src/shared/review-revision-generation'
import { ReviewRevisionGeneration } from './review-revision-generation'
import { AgentGeneration, type AgentBeginSelection } from './agent-generation'
import { ImportGeneration } from './import-generation'
import type { ImportGenerationSlot } from '../../src/shared/import-generation'
import { importGenerationSlotKey } from './import-generation-source'
import type { ApproveCharacterProposalRequest } from '../../src/shared/character-proposal'
import type { AgentGenerationContext, AgentGenerationInput } from '../../src/shared/agent-generation'
import type { EditorInlineInput, EditorInlineRecovery, EditorInlineGenerationChannels } from '../../src/shared/editor-inline-generation'
import { validateEditorInlineInput, readEditorInlineContext, readEditorInlineTask } from './editor-inline-generation'
import type { FinalizationGenerationChannels, FinalizationGenerationSlot, FinalizationGenerationRecovery } from '../../src/shared/finalization-generation'
import { FinalizationGeneration } from './finalization-generation'
import { finalizationSlotKey, readFinalizationGenerationContext } from './finalization-generation-source'
import { proveFinalizedCharacterGeneration } from './finalized-character-generation-proof'
import { parseFinalizedCharacterStateResponse } from '../../src/shared/finalized-continuity'
import type { GraphGenerationChannels, GraphGenerationInput, GraphGenerationRecovery } from '../../src/shared/graph-generation'
import { GraphGeneration } from './graph-generation'
import type { LegacyRosterGenerationChannels, LegacyRosterGenerationRecovery } from '../../src/shared/legacy-roster-generation'
import { LegacyRosterGeneration } from './legacy-roster-generation'
import { readLegacyRosterGenerationProof } from './legacy-roster-generation-proof'
import { readLegacyRosterGenerationContext } from './legacy-roster-generation-context'
import { readPortableRuntimeFreeze } from './portable-runtime-freeze'
import { readLegacyRosterSource, adoptLegacyCards } from './legacy-roster-source'
import { buildLegacyRosterJsonRepairTask, buildLegacyRosterReplacementTask, parseLegacyRosterJson } from '../../src/shared/legacy-roster-generation-pure'
import { validateGraphGenerationInput, readGraphGenerationContext } from './graph-generation-source'
const graphOperations = { plot: 'plot-tree-snapshot', plan: 'narrative-thread-plan-candidate', event: 'narrative-thread-event-candidate' } as const

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
  buildBinding: (selection: BeginGenerationRequest & { knowledgeSnapshot?: GenerationKnowledgeSnapshot; finalizedCharacterContextHash?: string; reviewRevisionContext?: ReviewRevisionContext; agentInput?: AgentGenerationInput; agentSession?: { key: string; roundIndex: number }; editorInlineInput?: EditorInlineInput; finalizationGenerationSlot?: FinalizationGenerationSlot; graphGenerationInput?: GraphGenerationInput; graphGenerationKey?: string; legacyRosterKey?: string }, model: SafeGenerationModelReceipt) => RunBinding
  rebuildBinding: (previous: RunBinding, model: SafeGenerationModelReceipt) => RunBinding
  beforeDispatch?: () => void
  onSnapshot?: (snapshot: MainGenerationSnapshot) => void
  onReasoning?: (event: { projectId: string; epoch: string; rootActionId: string; runId: string; attemptId: string; text: string }) => void
  dispatch?: GenerationRunServiceDependencies['dispatch']
}

interface ProviderRequest { model: ModelProfile; task: GenerationTask; plan: MainGenerationPlan }
async function dispatchProvider(value: unknown, options: Parameters<GenerationRunServiceDependencies['dispatch']>[1]) {
  const { model, task, plan } = value as ProviderRequest
  let evidence: ProviderUsageEvidence | null = null
  let finishReason: LLMFinishReason | null = null
  let failureCode: string | null = null
  await LLMFactory.getProvider(model).generateStream(model, task.messages.map(message => ({ ...message })), {
    ...plan.options, signal: options.signal, visibleOnly: true,
    onChunk: text => options.onVisible({ kind: 'delta', text }),
    onReasoning: options.onReasoning,
    onUsageEvidence: value => { evidence = value },
    onDone: (text, _usage, reason) => { options.onVisible({ kind: 'cumulative', text }); finishReason = reason },
    onError: error => {
      failureCode = /fetch failed|failed to fetch|network|ECONNRESET|ETIMEDOUT|无法读取响应流|完成标记前结束/iu.test(error)
        ? 'NETWORK_ERROR' : 'GENERATION_PROVIDER_FAILED'
    },
  })
  if (failureCode || finishReason === null) throw new Error(failureCode ?? 'GENERATION_PROVIDER_FAILED')
  const usageEvidence = evidence as ProviderUsageEvidence | null
  return { finishReason, usage: usageEvidence ? { ...usageEvidence.usage, reasoningTokens: usageEvidence.reasoningTokens,
    accounting: usageEvidence.accounting, totalIncludesReasoning: usageEvidence.totalIncludesReasoning,
    trusted: plan.trustedUsage && usageEvidence.protocol === model.protocol } : null }
}

/** One owner per captured database/session. No renderer budget, lease or hash is authoritative. */
export function createMainGenerationOwner(deps: MainGenerationOwnerDependencies) {
  const runtimeFreeze = readPortableRuntimeFreeze(getCurrentProjectPath())
  const repository = new GenerationRunRepository(() => deps.database, Date.now, (table, recordId) => runtimeFreeze.isFrozen(table, recordId))
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
  const reviewRevisions = new ReviewRevisionGeneration(deps.database, repository, { projectId: deps.projectId, epoch: deps.epoch }, assertCurrent)
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
    onReasoning: event => deps.onReasoning?.({ projectId: deps.projectId, epoch: deps.epoch, ...event }),
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
    const budgetDiagnostics: NonNullable<MainGenerationRunView['budgetDiagnostics']> = budget.attempts.map(attempt => {
      const receipt = volatileReceipts.get(attempt.attemptId) ?? repository.receipt(attempt.attemptId)
      const usage = receipt.result?.usage
      return {
        attemptId: attempt.attemptId, plannerVersion: receipt.budgetDecision?.policyVersion,
        requestedOutputTokens: receipt.budgetDecision?.requestedOutputTokens ?? attempt.requestedOutputTokens,
        reservedTokens: attempt.reservedTokens,
        actualState: attempt.status === 'cancelled-before-dispatch' ? 'not-dispatched' : attempt.status === 'settled' ? 'settled' : ['reserved', 'dispatch-marked'].includes(attempt.status) ? 'reserved' : 'unknown',
        actual: usage?.trusted ? { input: usage.inputTokens ?? null, completion: usage.completionTokens ?? null,
          reasoning: usage.reasoningTokens ?? null, total: usage.actualTokens ?? null } : null,
        finishReason: receipt.result?.finishReason ?? null, failureCode: receipt.failureCode ?? budget.blockedCode,
        reasons: receipt.budgetDecision?.reasons ?? [],
      }
    })
    return { handle: handleOf(run), status: run.status as MainGenerationRunView['status'], operation: run.binding.sourceManifest.operation as string,
      budgetDiagnostics,
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
  // S10B：'materialDecision'/'materialDecisionHash' 只在**取得准入之后**才可能出现在真正
  // 运行的 manifest 上（prepare 阶段早于材料装配），因此与 selectedFinalizedDraftIds 同类，
  // 不参与「准备期冻结源未变」的比对。指纹侧的 contextSnapshotHash 本就被排除。
  const preparationProjection = (binding: RunBinding, excludeKnowledge = false) => ({
    manifest: Object.fromEntries(Object.entries(binding.sourceManifest).filter(([key]) => !['selectedDraftIds', 'selectedFinalizedDraftIds', 'materialDecision', 'materialDecisionHash', ...(excludeKnowledge ? ['knowledgeSnapshot'] : [])].includes(key))),
    fingerprint: Object.fromEntries(Object.entries(binding.fingerprint).filter(([key]) => !['contextSnapshotHash', 'dependencyHash'].includes(key))),
    sources: binding.sourceRefs.filter(ref => !/^(draft|finalized):/.test(ref.sourceId) && (!excludeKnowledge || !/^(kb:|knowledge-selection$)/.test(ref.sourceId))),
  })
  const materialDecisionProjection = (binding: RunBinding) => ({
    manifest: Object.fromEntries(Object.entries(binding.sourceManifest)
      .filter(([key]) => key !== 'materialDecision' && key !== 'materialDecisionHash')),
    fingerprint: Object.fromEntries(Object.entries(binding.fingerprint).filter(([key]) => key !== 'contextSnapshotHash')),
    sources: binding.sourceRefs,
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
  const begin = (selection: (BeginGenerationRequest | AgentBeginSelection) & { editorInlineInput?: EditorInlineInput; finalizationGenerationSlot?: FinalizationGenerationSlot; graphGenerationInput?: GraphGenerationInput; graphGenerationKey?: string; legacyRosterKey?: string }, batchInitialization = false, agentInitialization = false, editorInitialization = false, finalizationInitialization = false, graphInitialization = false, legacyInitialization = false): MainGenerationRunView => {
    assertCurrent()
    if (!selection || typeof selection.operation !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(selection.operation)
      || !Array.isArray(selection.promptKeys) || selection.promptKeys.length === 0
      || Object.hasOwn(selection, 'parentRootActionId') && (typeof selection.parentRootActionId !== 'string' || !selection.parentRootActionId.trim())
      || typeof selection.uiActionNonce !== 'string' || !selection.uiActionNonce.trim() || selection.uiActionNonce.length > 256
      || Object.keys(selection).some(key => !['operation', 'uiActionNonce', 'modelId', 'chapterNumber', 'selectedDraftIds', 'selectedFinalizedDraftIds', 'selectedBlueprintChapterNumbers', 'promptKeys', 'skillStages', 'authorInputs', 'output', 'outputOverrides', 'parentRootActionId', 'continueDirectoryOperationId', 'batchId', 'batchIntent', 'preparationId', 'finalizedCharacterContextId', 'reviewRevisionContextId', 'agentWorkflowRegistrationId', 'materialDecision', 'importSlot', 'importExecution', ...(agentInitialization ? ['agentInput', 'agentSession'] : []), ...(editorInitialization ? ['editorInlineInput'] : []), ...(finalizationInitialization ? ['finalizationGenerationSlot'] : []), ...(graphInitialization ? ['graphGenerationInput', 'graphGenerationKey'] : []), ...(legacyInitialization ? ['legacyRosterKey'] : [])].includes(key))) throw new Error('GENERATION_BEGIN_INVALID')
    if (selection.operation === 'editor-inline' && !editorInitialization) throw new Error('GENERATION_EDITOR_ADMISSION_REQUIRED')
    if (['finalized-chapter-notes', 'finalized-character-state'].includes(selection.operation) && !finalizationInitialization) throw new Error('GENERATION_FINALIZATION_ADMISSION_REQUIRED')
    if (Object.values(graphOperations).includes(selection.operation as typeof graphOperations[keyof typeof graphOperations]) && !graphInitialization) throw new Error('GENERATION_GRAPH_ADMISSION_REQUIRED')
    if (selection.operation === 'legacy-character-roster-repair' && !legacyInitialization) throw new Error('GENERATION_LEGACY_ADMISSION_REQUIRED')
    const importAdmission = imports.admit(selection)
    if (importAdmission?.existing) return viewOf(importAdmission.existing)
    if (importAdmission) selection = { ...selection, uiActionNonce: `import:${importGenerationSlotKey(selection.importSlot!)}`,
      ...(importAdmission.parentRootActionId ? { parentRootActionId: importAdmission.parentRootActionId, modelId: importAdmission.modelId! } : {}) }
    if (selection.operation === 'agent-round' && !agentInitialization) throw new Error('GENERATION_AGENT_ADMISSION_REQUIRED')
    const agentWorkflow = agentInitialization ? undefined : agents.admitWorkflow(selection)
    if (selection.parentRootActionId && repository.budget(selection.parentRootActionId).root.operation === 'editor-inline') throw new Error('GENERATION_EDITOR_CHILD_FORBIDDEN')
    if (selection.parentRootActionId && Object.values(graphOperations).includes(repository.budget(selection.parentRootActionId).root.operation as typeof graphOperations[keyof typeof graphOperations])) throw new Error('GENERATION_GRAPH_CHILD_FORBIDDEN')
    if (selection.parentRootActionId && repository.budget(selection.parentRootActionId).root.operation === 'legacy-character-roster-repair') throw new Error('GENERATION_LEGACY_CHILD_FORBIDDEN')
    if (agentWorkflow?.existing) return viewOf(repository.get(agentWorkflow.existing.runId))
    generationOutputContract(selection)
    const finalizedCharacterContextHash = finalizedCharacters.admit(selection)
    const reviewRevision = reviewRevisions.admit(selection)
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
      if (selection.operation === 'chapter-draft' && selection.preparationId && !selection.materialDecision)
        throw new Error('GENERATION_MATERIAL_DECISION_REQUIRED')
      const binding = deps.buildBinding({ ...selection, ...(prepared ? { knowledgeSnapshot: prepared.knowledgeSnapshot } : {}),
        ...(finalizedCharacterContextHash ? { finalizedCharacterContextHash } : {}),
        ...(reviewRevision ? { reviewRevisionContext: reviewRevision.context } : {}) }, safeGenerationModelReceipt(lease))
      if (prepared && !preparationMatches(prepared.binding, binding)) throw new Error('GENERATION_DRAFT_PREPARATION_CHANGED')
      if (binding.projectId !== deps.projectId || binding.epoch !== deps.epoch) throw new Error('GENERATION_BINDING_INVALID')
      const run = deps.database.transaction(() => {
      if (selection.importSlot) {
        const existing = imports.find(selection.importSlot)
        if (existing) return existing
      }
      if (selection.finalizationGenerationSlot) {
        const existing = finalizations.find(selection.finalizationGenerationSlot)
        if (existing) return existing
        if (selection.parentRootActionId) repository.activateRootForCommittedStage(selection.parentRootActionId, binding)
      }
      if (batch) repository.activateRootForCommittedStage(batch.rootHandle.rootActionId, binding)
      if (reviewRevision?.parentRootActionId) repository.activateRootForCommittedStage(reviewRevision.parentRootActionId, binding)
      if (agentInitialization && selection.parentRootActionId) repository.activateRootForCommittedStage(selection.parentRootActionId, binding)
      if (agentWorkflow) repository.activateRootForCommittedStage(agentWorkflow.parentRootActionId, binding)
      if (importAdmission?.parentRootActionId) repository.activateRootForCommittedStage(importAdmission.parentRootActionId, binding)
      if (continuation && !continuation.continuationHandle) repository.activateRootForCommittedStage(continuation.sourceHandle.rootActionId, binding)
      const next = service.open({ ...binding, operation: selection.operation, uiActionNonce: selection.uiActionNonce,
        frozenInputHash: textHash(JSON.stringify([binding.fingerprint, binding.contextSnapshotId, selection.output])),
        budget: MAIN_GENERATION_POLICY.budget, parentRootActionId: continuation?.sourceHandle.rootActionId ?? selection.parentRootActionId })
      if (continuation?.continuationHandle && continuation.continuationHandle.runId !== next.runId) throw new Error('GENERATION_DIRECTORY_CONTINUATION_EXISTS')
      if (batch?.currentChapterRunHandle && batch.currentChapterRunHandle.runId !== next.runId) throw new Error('GENERATION_BATCH_RECOVERY_REQUIRED')
      if (continuation && !continuation.continuationHandle) repository.bindDirectoryContinuation(continuation.operationId, handleOf(next))
      if (selection.agentWorkflowRegistrationId) agents.recordWorkflowChild(selection.agentWorkflowRegistrationId, handleOf(next))
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
    const safeFailureCode = receipt.failureCode === 'GENERATION_PROVIDER_FAILED' ? 'GENERATION_PROVIDER_FAILED'
      : receipt.failureCode === 'NETWORK_ERROR' ? 'NETWORK_ERROR' : undefined
    const details: GenerationAttemptReceipt = { purpose: task.purpose,
      ...(safeFailureCode ? { failureCode: safeFailureCode } : {}),
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
  const execute = async (request: ExecuteGenerationRequest, agentExecution = false, importExecution = false, editorExecution = false, finalizationExecution = false, graphExecution = false, legacyExecution = false): Promise<MainGenerationExecuteReceipt> => {
    const run = requireRun(request.handle, true)
    if (run.binding.sourceManifest.operation === 'agent-round' && !agentExecution) throw new Error('GENERATION_AGENT_ADMISSION_REQUIRED')
    if (run.binding.sourceManifest.importSlot && !importExecution) throw new Error('GENERATION_IMPORT_ADMISSION_REQUIRED')
    if (run.binding.sourceManifest.operation === 'editor-inline' && !editorExecution) throw new Error('GENERATION_EDITOR_ADMISSION_REQUIRED')
    if (['finalized-chapter-notes', 'finalized-character-state'].includes(run.binding.sourceManifest.operation as string) && !finalizationExecution) throw new Error('GENERATION_FINALIZATION_ADMISSION_REQUIRED')
    if (Object.values(graphOperations).includes(run.binding.sourceManifest.operation as typeof graphOperations[keyof typeof graphOperations]) && !graphExecution) throw new Error('GENERATION_GRAPH_ADMISSION_REQUIRED')
    if (run.binding.sourceManifest.operation === 'legacy-character-roster-repair' && !legacyExecution) throw new Error('GENERATION_LEGACY_ADMISSION_REQUIRED')
    assertSemanticGenerationTask(request.task)
    const task = structuredClone(request.task)
    const materialDecision = run.binding.sourceManifest.materialDecision as MaterialDecisionReceipt | undefined
    const materialOperation = String(run.binding.sourceManifest.operation)
    if ((!materialDecision && ['review-chapter', 'refine-draft', 'refine-from-review'].includes(materialOperation))
      || !materialDecision && materialOperation === 'chapter-draft' && run.binding.sourceManifest.preparationId)
      throw new Error('GENERATION_MATERIAL_DECISION_REQUIRED')
    if (materialDecision && !repository.hasNonCancelledAttempt(run.runId)) {
      const userMessages = task.messages.filter(message => message.role === 'user')
      if (task.purpose !== run.binding.sourceManifest.operation || userMessages.length !== 1
        || textHash(userMessages[0]!.content) !== materialDecision.promptHash)
        throw new Error('GENERATION_MATERIAL_PROMPT_MISMATCH')
    }
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
    reviewRevisions.assertMutable(run.runId)
    imports.assertMutable(run)
    finalizations.assertMutable(run)
    graphs.assertMutable(run)
    legacyRosters.assertMutable(run)
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
      reasoningUpperBoundTokens: plan.reasoningUpperBoundTokens, usagePolicy: plan.usagePolicy, purpose: task.purpose,
      ...(plan.budgetDecision ? { budgetDecision: plan.budgetDecision } : {}),
      ...(run.binding.sourceManifest.importSlot ? { replayTask: task } : {}),
      ...(agentExecution ? { agentToolNames: (run.binding.sourceManifest.agentContext as AgentGenerationContext).input.tools.map(tool => tool.name) } : {}) })
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
    imports.assertMutable(run)
    finalizations.assertMutable(run)
    graphs.assertMutable(run)
    legacyRosters.assertMutable(run)
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
  const bindMaterialDecision = (handle: MainGenerationRunHandle, materialDecision: MaterialDecisionReceipt): MainGenerationRunView => {
    const run = requireRun(handle, true)
    const operation = run.binding.sourceManifest.operation
    if (!['review-chapter', 'refine-draft', 'refine-from-review'].includes(String(operation)))
      throw new Error('GENERATION_MATERIAL_DECISION_INVALID')
    const existing = run.binding.sourceManifest.materialDecision
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, materialDecision)) throw new Error('GENERATION_MATERIAL_DECISION_CONFLICT')
      return viewOf(run)
    }
    const candidate = deps.rebuildBinding({ ...run.binding,
      sourceManifest: { ...run.binding.sourceManifest, materialDecision } }, currentModelReceipt(run.binding))
    if (!isDeepStrictEqual(materialDecisionProjection(run.binding), materialDecisionProjection(candidate)))
      throw new Error('GENERATION_SOURCE_CHANGED')
    return viewOf(repository.replaceUnstartedBinding(run.runId, run.binding, candidate))
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
    const materialDecision = manifest.materialDecision as MaterialDecisionReceipt | undefined
    const requiredCandidateDraftIds = new Set((materialDecision?.included ?? [])
      .filter(item => item.required && /^candidate:\d+$/u.test(item.sourceId))
      .map(item => Number(item.sourceId.slice('candidate:'.length))))
    const selectedDrafts = (manifest.selectedDraftIds as number[] ?? []).map(draftId => {
      const row = deps.database.prepare('SELECT d.chapter_number,d.version,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(draftId) as { chapter_number: number; version: number; body: string } | undefined
      const ref = run.binding.sourceRefs.find(source => source.sourceId === `draft:${draftId}`)
      return row && ref && row.version === ref.revision && textHash(row.body) === ref.contentHash
        ? { draftId, chapterNumber: row.chapter_number, version: row.version, contentHash: ref.contentHash, content: row.body,
            ...(requiredCandidateDraftIds.has(draftId) ? { required: true } : {}) } : null
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
  const imports = new ImportGeneration(deps.database, repository, deps.projectId)
  const legacyRosters = new LegacyRosterGeneration(deps.database, repository, deps.projectId, characters)
  const graphs = new GraphGeneration(deps.database, repository, deps.projectId)
  const finalizations = new FinalizationGeneration(deps.database, repository, deps.projectId, characters)
  const agents = new AgentGeneration(deps.database, repository, { projectId: deps.projectId, epoch: deps.epoch }, assertCurrent, {
    begin: selection => begin(selection, false, true), read: handle => viewOf(requireRun(handle)), resume,
    execute: (handle, invocationNonce, task) => execute({ handle, invocationNonce, task }, true),
    current: (run, expected) => { try { return compareGenerationSourceBindings(expected ?? run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))) } catch { return false } },
    capture: run => deps.rebuildBinding(run.binding, currentModelReceipt(run.binding)),
  })
  const requireEditorInlineRun = (handle: MainGenerationRunHandle) => {
    assertCurrent()
    if (!handle || Object.keys(handle).some(key => !['projectId', 'epoch', 'rootActionId', 'runId'].includes(key))
      || handle.projectId !== deps.projectId || typeof handle.epoch !== 'string' || !handle.epoch) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    const run = repository.get(handle.runId)
    readEditorInlineContext(run)
    if (run.binding.projectId !== handle.projectId || run.rootActionId !== handle.rootActionId
      || handle.epoch !== run.binding.epoch && handle.epoch !== run.binding.sourceManifest.editorInlineOriginEpoch) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    return run
  }
  const readEditorInlineRecovery = (handle: MainGenerationRunHandle): EditorInlineRecovery => {
    const run = requireEditorInlineRun(handle)
    const context = readEditorInlineContext(run)
    let current = false
    try { current = repository.budget(run.rootActionId).root.status !== 'cancelled' && compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))) } catch { /* Original text remains readable after source or model changes. */ }
    return { view: viewOf(run), modelId: modelReceipt(run.binding).modelId, context, sourceStatus: current ? 'current' : 'conflict' }
  }
  const finalizationRecovery = (run: DurableGenerationRun): FinalizationGenerationRecovery => {
    assertCurrent()
    const context = readFinalizationGenerationContext(run), effect = finalizations.readEffect(run)
    let current = false
    try { current = repository.budget(run.rootActionId).root.status !== 'cancelled' && compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))) } catch { /* History remains readable without current source/model admission. */ }
    return { view: viewOf(run), context, modelId: modelReceipt(run.binding).modelId, sourceStatus: current ? 'current' : 'conflict',
      attemptCount: deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) as number, ...(effect ? { effect } : {}) }
  }
  const assertFinalizationSources = (run: DurableGenerationRun) => {
    assertCurrent()
    if (repository.budget(run.rootActionId).root.status === 'cancelled') throw new Error('GENERATION_ACTION_CANCELLED')
    if (!compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding)))) throw new Error('GENERATION_SOURCE_CHANGED')
  }
  const graphRecovery = (run: DurableGenerationRun): GraphGenerationRecovery => {
    assertCurrent()
    const context = readGraphGenerationContext(run), effects = graphs.effects(run)
    const attempts = deps.database.prepare('SELECT attempt_id FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(run.runId) as { attempt_id: string }[]
    if (attempts.length > 1) throw new Error('GENERATION_GRAPH_ATTEMPT_CONFLICT')
    let artifact: GraphGenerationRecovery['artifact'], result: GraphGenerationRecovery['result']
    if (attempts[0]) {
      const candidate = repository.receipt(attempts[0].attempt_id).artifact
      if (candidate) {
        const reference = { artifactId: candidate.artifactId, revision: candidate.revision, textHash: candidate.textHash }
        try { result = graphs.result(run, reference); artifact = reference } catch { /* Unqualified raw output remains in the run view for copying. */ }
      }
    }
    let current = false
    try { assertFinalizationSources(run); current = true } catch { /* Historical context/result does not require current sources or model. */ }
    return { view: viewOf(run), modelId: modelReceipt(run.binding).modelId, context, effects, attemptCount: attempts.length,
      sourceStatus: current ? 'current' : 'conflict', ...(artifact && result ? { artifact, result } : {}) }
  }
  const legacyRosterRecovery = (run: DurableGenerationRun): LegacyRosterGenerationRecovery => {
    assertCurrent()
    const context = readLegacyRosterGenerationContext(run), proposal = legacyRosters.proposal(run), artifact = legacyRosters.artifactFor(run)
    let current = false
    try { assertFinalizationSources(run); current = true } catch { /* Preserve original candidate/proposal when author facts or model change. */ }
    return { view: viewOf(run), modelId: modelReceipt(run.binding).modelId, context, sourceStatus: current ? 'current' : 'conflict',
      attemptCount: deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) as number,
      ...(artifact ? {artifact} : {}), ...(proposal ? {proposal} : {}) }
  }
  return { begin: (selection: BeginGenerationRequest) => begin(selection), bindMaterialDecision, execute: (request: ExecuteGenerationRequest) => execute(request), resume, list, assertSourcesCurrent, agents,
    readLegacyRosterSource: () => { assertCurrent(); return readLegacyRosterSource(deps.database) },
    adoptLegacyCards: (request: LegacyRosterGenerationChannels['legacy-roster:adopt-existing']['args'][0]) => { assertCurrent(); return adoptLegacyCards(deps.database, request) },
    beginLegacyRosterGeneration: (request: LegacyRosterGenerationChannels['legacy-roster:begin']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['modelId','uiActionNonce'].includes(key)) || typeof request.uiActionNonce !== 'string'
        || !request.uiActionNonce.trim() || request.uiActionNonce.length > 256) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      const rows = deps.database.prepare("SELECT r.run_id FROM generation_runs r JOIN generation_roots g ON g.root_action_id=r.root_action_id WHERE json_extract(g.action_json,'$.projectId')=? AND json_extract(g.action_json,'$.uiActionNonce')=? AND json_extract(r.binding_json,'$.sourceManifest.legacyRosterContext') IS NOT NULL").all(deps.projectId,request.uiActionNonce) as {run_id:string}[]
      if (rows.length > 1) throw new Error('GENERATION_NONCE_CONFLICT')
      if (rows[0]) return legacyRosterRecovery(repository.get(rows[0].run_id))
      const view = begin({operation:'legacy-character-roster-repair',uiActionNonce:request.uiActionNonce,modelId:request.modelId,
        selectedDraftIds:[],selectedFinalizedDraftIds:[],promptKeys:['legacy-roster'],skillStages:[],output:'structured-data',legacyRosterKey:randomUUID()},false,false,false,false,false,true)
      return legacyRosterRecovery(repository.get(view.handle.runId))
    },
    readLegacyRosterGeneration: (request: LegacyRosterGenerationChannels['legacy-roster:read']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      return legacyRosterRecovery(legacyRosters.require(request.handle))
    },
    executeLegacyRosterGeneration: async (request: LegacyRosterGenerationChannels['legacy-roster:execute']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      let run = legacyRosters.require(request.handle)
      const context = readLegacyRosterGenerationContext(run), initialTask = legacyRosters.task(run)
      let stageTask = initialTask, total = 0
      for (const stage of ['initial','repair'] as const) {
        let previousText: string | undefined
        for (let ordinal = 0; ordinal < 3; ordinal++, total++) {
          const task = previousText === undefined ? stageTask : buildLegacyRosterReplacementTask(stageTask, previousText, context.source.writingLanguage)
          const invocationNonce = `legacy:${stage}:${ordinal}`
          const requestHash = textHash(JSON.stringify([task,run.binding.fingerprint.modelLeaseRevision,run.binding.fingerprint.policyHash]))
          const prior = repository.findInvocation(run.runId,invocationNonce,requestHash)
          let result: MainGenerationExecuteReceipt
          if (prior) result = await (pending.get(JSON.stringify([run.runId,invocationNonce]))?.promise ?? outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior,task))
          else {
            legacyRosters.assertMutable(run)
            if (deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) !== total) throw new Error('GENERATION_LEGACY_ATTEMPT_CONFLICT')
            const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
            result = await execute({handle:current.handle,invocationNonce,task},false,false,false,false,false,true)
          }
          run = repository.get(run.runId)
          const reference = result.outcome.receipt.visibleArtifact
          const candidate = (result.run.candidates ?? result.run.artifacts).find(item => item.artifactId === reference?.artifactId)
          if (!candidate?.compositionEligible || repository.budget(run.rootActionId).root.status === 'cancelled') return result
          if (textHash(candidate.text) !== candidate.textHash) throw new Error('GENERATION_LEGACY_ARTIFACT_INVALID')
          if (result.outcome.finishReason === 'length') {
            if (ordinal === 2) return result
            previousText = candidate.text
            continue
          }
          if (result.outcome.finishReason !== 'stop' || result.outcome.status !== 'completed') return result
          try { parseLegacyRosterJson(candidate.text); return result } catch {
            if (stage === 'repair') return result
            stageTask = buildLegacyRosterJsonRepairTask(candidate.text)
            total++
            break
          }
        }
      }
      throw new Error('GENERATION_LEGACY_ATTEMPT_CONFLICT')
    },
    stageLegacyRosterGeneration: (request: LegacyRosterGenerationChannels['legacy-roster:stage']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['handle','artifact'].includes(key))) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      return legacyRosters.stage(request.handle,request.artifact,assertFinalizationSources)
    },
    cancelLegacyRosterGeneration: (request: LegacyRosterGenerationChannels['legacy-roster:cancel']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_LEGACY_REQUEST_INVALID')
      const run = legacyRosters.require(request.handle); service.cancel(run.rootActionId); return viewOf(repository.get(run.runId))
    },
    beginGraphGeneration: (request: GraphGenerationChannels['graph-generation:begin']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['input', 'modelId', 'uiActionNonce'].includes(key))
        || typeof request.uiActionNonce !== 'string' || !request.uiActionNonce.trim() || request.uiActionNonce.length > 256) throw new Error('GENERATION_GRAPH_INPUT_INVALID')
      const input = validateGraphGenerationInput(request.input)
      const rows = deps.database.prepare("SELECT r.run_id FROM generation_runs r JOIN generation_roots g ON g.root_action_id=r.root_action_id WHERE json_extract(g.action_json,'$.projectId')=? AND json_extract(g.action_json,'$.uiActionNonce')=? AND json_extract(r.binding_json,'$.sourceManifest.graphGenerationContext') IS NOT NULL").all(deps.projectId, request.uiActionNonce) as { run_id: string }[]
      if (rows.length > 1) throw new Error('GENERATION_NONCE_CONFLICT')
      if (rows[0]) {
        const run = repository.get(rows[0].run_id)
        if (!isDeepStrictEqual(readGraphGenerationContext(run).input, input)) throw new Error('GENERATION_NONCE_CONFLICT')
        return graphRecovery(run)
      }
      const view = begin({ operation: graphOperations[input.kind], uiActionNonce: request.uiActionNonce, modelId: request.modelId,
        selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: [`graph-${input.kind}`], skillStages: [], output: 'structured-data',
        graphGenerationInput: input, graphGenerationKey: randomUUID() }, false, false, false, false, true)
      return graphRecovery(repository.get(view.handle.runId))
    },
    readGraphGeneration: (request: GraphGenerationChannels['graph-generation:read']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_GRAPH_REQUEST_INVALID')
      return graphRecovery(graphs.require(request.handle))
    },
    executeGraphGeneration: async (request: GraphGenerationChannels['graph-generation:execute']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_GRAPH_REQUEST_INVALID')
      const run = graphs.require(request.handle), task = graphs.task(run), invocationNonce = 'graph:0'
      const requestHash = textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
      const prior = repository.findInvocation(run.runId, invocationNonce, requestHash)
      if (prior) return pending.get(JSON.stringify([run.runId, invocationNonce]))?.promise ?? outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior, task)
      graphs.assertMutable(run)
      legacyRosters.assertMutable(run)
      if (deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) !== 0) throw new Error('GENERATION_GRAPH_ATTEMPT_CONFLICT')
      const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
      return execute({ handle: current.handle, invocationNonce, task }, false, false, false, false, true)
    },
    confirmGraphGeneration: (request: GraphGenerationChannels['graph-generation:confirm']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['handle', 'artifact', 'index'].includes(key))) throw new Error('GENERATION_GRAPH_REQUEST_INVALID')
      return graphs.confirm(request.handle, request.artifact, request.index, assertFinalizationSources)
    },
    cancelGraphGeneration: (request: GraphGenerationChannels['graph-generation:cancel']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_GRAPH_REQUEST_INVALID')
      const run = graphs.require(request.handle)
      service.cancel(run.rootActionId)
      return viewOf(repository.get(run.runId))
    },
    readFinalizationGeneration: (request: FinalizationGenerationChannels['finalization-generation:read']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'slot')) throw new Error('GENERATION_FINALIZATION_SLOT_INVALID')
      const run = finalizations.find(request.slot)
      return run ? finalizationRecovery(run) : null
    },
    beginFinalizationGeneration: (request: FinalizationGenerationChannels['finalization-generation:begin']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['slot', 'modelId', 'parentRootActionId'].includes(key))) throw new Error('GENERATION_FINALIZATION_SLOT_INVALID')
      const { slot } = request, prior = finalizations.find(slot)
      if (prior) return finalizationRecovery(prior)
      const sibling = finalizations.find({ source: slot.source, stepKey: slot.stepKey === 'chapter_notes' ? 'character_cards' : 'chapter_notes' })
      let parentRootActionId = sibling?.rootActionId, selectedModelId = sibling ? modelReceipt(sibling.binding).modelId : request.modelId
      if (request.parentRootActionId !== undefined) {
        const root = repository.budget(request.parentRootActionId).root
        if (root.operation !== 'batch-chapters' || root.projectId !== deps.projectId || parentRootActionId && parentRootActionId !== request.parentRootActionId) throw new Error('GENERATION_FINALIZATION_PARENT_INVALID')
        const rows = deps.database.prepare('SELECT run_id FROM generation_runs WHERE root_action_id=? ORDER BY rowid').all(root.rootActionId) as { run_id: string }[]
        const committed = rows.map(row => repository.get(row.run_id)).filter(run => run.binding.sourceManifest.operation === 'chapter-draft')
          .map(run => ({ run, receipt: draftEffects.readCommit(run.runId) })).find(item => item.receipt?.id === slot.source.draftId)
        if (!committed || committed.receipt?.contentHash !== slot.source.contentHash) throw new Error('GENERATION_FINALIZATION_PARENT_INVALID')
        parentRootActionId = root.rootActionId; selectedModelId = modelReceipt(committed.run.binding).modelId
      }
      if (sibling && !finalizations.readEffect(sibling)) throw new Error('GENERATION_FINALIZATION_PREDECESSOR_REQUIRED')
      const prepared = finalizedCharacters.readContext(slot.source.draftId)
      if (!isDeepStrictEqual(prepared.context.source, slot.source)) throw new Error('GENERATION_FINALIZATION_SOURCE_CHANGED')
      const characterStep = slot.stepKey === 'character_cards'
      const view = begin({ operation: characterStep ? 'finalized-character-state' : 'finalized-chapter-notes', uiActionNonce: `finalization:${finalizationSlotKey(slot)}`,
        modelId: selectedModelId, chapterNumber: slot.source.chapterNumber, selectedDraftIds: [], selectedFinalizedDraftIds: [slot.source.draftId],
        promptKeys: [characterStep ? 'update_character_cards' : 'generate_chapter_notes'], skillStages: ['review'], output: characterStep ? 'structured-data' : 'visible-text',
        authorInputs: [{ id: 'finalized-character-context', text: JSON.stringify(prepared.context) }],
        ...(characterStep ? { finalizedCharacterContextId: prepared.contextId } : {}), ...(parentRootActionId ? { parentRootActionId } : {}), finalizationGenerationSlot: slot }, false, false, false, true)
      return finalizationRecovery(repository.get(view.handle.runId))
    },
    executeFinalizationGeneration: async (request: FinalizationGenerationChannels['finalization-generation:execute']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_FINALIZATION_REQUEST_INVALID')
      let run = finalizations.require(request.handle)
      const initialTask = finalizations.task(run), context = readFinalizationGenerationContext(run)
      let invalidText: string | undefined
      for (let ordinal = 0; ordinal < 3; ordinal++) {
        const task: GenerationTask = invalidText === undefined ? initialTask : { ...initialTask, purpose: `${initialTask.purpose}:repair:${ordinal}`,
          messages: [...initialTask.messages, { role: 'assistant', content: invalidText }, { role: 'user', content: context.writingLanguage === 'en-US'
            ? 'The preceding response does not satisfy the required JSON structure or exact source evidence. Return a corrected JSON object using only the original frozen source and character IDs. Do not change or invent evidence. Return {"updates":[]} when there is no supported update.'
            : '上一份回答未满足要求的 JSON 结构或原文证据校验。请仅依据原始冻结正文和角色 ID 返回修正后的 JSON 对象，不得改写或虚构证据。没有可靠更新时返回 {"updates":[]}。' }] }
        const invocationNonce = `finalization:${ordinal}`
        const requestHash = textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
        const prior = repository.findInvocation(run.runId, invocationNonce, requestHash)
        let result: MainGenerationExecuteReceipt
        if (prior) result = await (pending.get(JSON.stringify([run.runId, invocationNonce]))?.promise ?? outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior, task))
        else {
          if (deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) !== ordinal) throw new Error('GENERATION_FINALIZATION_ATTEMPT_CONFLICT')
          const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
          result = await execute({ handle: current.handle, invocationNonce, task }, false, false, false, true)
        }
        run = repository.get(run.runId)
        if (context.slot.stepKey !== 'character_cards' || result.outcome.status !== 'completed' || ordinal === 2
          || repository.budget(run.rootActionId).root.status === 'cancelled') return result
        const reference = result.outcome.receipt?.visibleArtifact
        const candidate = (result.run.candidates ?? result.run.artifacts).find(item => item.artifactId === reference?.artifactId)
        if (!candidate?.compositionEligible) return result
        if (textHash(candidate.text) !== candidate.textHash) throw new Error('GENERATION_FINALIZATION_ARTIFACT_INVALID')
        try { parseFinalizedCharacterStateResponse(result.outcome.content, context.identity); return result } catch { invalidText = result.outcome.content }
      }
      throw new Error('GENERATION_FINALIZATION_ATTEMPT_CONFLICT')
    },
    commitFinalizationGeneration: (request: FinalizationGenerationChannels['finalization-generation:commit']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['handle', 'artifact'].includes(key))) throw new Error('GENERATION_FINALIZATION_REQUEST_INVALID')
      return finalizations.commit(request.handle, request.artifact, characters, assertFinalizationSources)
    },
    cancelFinalizationGeneration: (request: FinalizationGenerationChannels['finalization-generation:cancel']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => key !== 'handle')) throw new Error('GENERATION_FINALIZATION_REQUEST_INVALID')
      const run = finalizations.require(request.handle)
      service.cancel(run.rootActionId)
      return viewOf(repository.get(run.runId))
    },
    readEditorInlineRecovery,
    cancelEditorInline: (handle: MainGenerationRunHandle) => {
      const run = requireEditorInlineRun(handle)
      service.cancel(run.rootActionId)
      return viewOf(repository.get(run.runId))
    },
    beginEditorInline: (request: EditorInlineGenerationChannels['editor-inline:begin']['args'][0]) => {
      assertCurrent()
      if (!request || Object.keys(request).some(key => !['input', 'modelId', 'uiActionNonce'].includes(key))
        || typeof request.uiActionNonce !== 'string' || !request.uiActionNonce.trim() || request.uiActionNonce.length > 256) throw new Error('GENERATION_EDITOR_INPUT_INVALID')
      const input = validateEditorInlineInput(request.input)
      const rows = deps.database.prepare("SELECT r.run_id FROM generation_runs r JOIN generation_roots g ON g.root_action_id=r.root_action_id WHERE json_extract(g.action_json,'$.operation')='editor-inline' AND json_extract(g.action_json,'$.projectId')=? AND json_extract(g.action_json,'$.uiActionNonce')=?").all(deps.projectId, request.uiActionNonce) as { run_id: string }[]
      if (rows.length > 1) throw new Error('GENERATION_NONCE_CONFLICT')
      if (rows[0]) {
        const prior = repository.get(rows[0].run_id)
        if (!isDeepStrictEqual(input, prior.binding.sourceManifest.editorInlineInput) || request.modelId !== modelReceipt(prior.binding).modelId) throw new Error('GENERATION_NONCE_CONFLICT')
        return readEditorInlineRecovery(handleOf(prior))
      }
      const view = begin({ operation: 'editor-inline', uiActionNonce: request.uiActionNonce, modelId: request.modelId,
        selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: ['edit_selected_text'], skillStages: [], output: 'visible-text', editorInlineInput: input }, false, false, true)
      return readEditorInlineRecovery(view.handle)
    },
    executeEditorInline: async (handle: MainGenerationRunHandle) => {
      const run = requireEditorInlineRun(handle), task = readEditorInlineTask(run)
      const invocationNonce = 'editor-inline:0'
      const requestHash = textHash(JSON.stringify([task, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash]))
      const prior = repository.findInvocation(run.runId, invocationNonce, requestHash)
      if (prior) {
        const running = pending.get(JSON.stringify([run.runId, invocationNonce]))
        return running ? running.promise : outcomeOf(volatileReceipts.get(prior.attempt.attemptId) ?? prior, task)
      }
      if (deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) !== 0) throw new Error('GENERATION_EDITOR_ATTEMPT_CONFLICT')
      const current = viewOf(run).nonReplayable ? await resume(handleOf(run)) : viewOf(run)
      return execute({ handle: current.handle, invocationNonce, task }, false, false, true)
    },
    readImportGeneration: (slot: ImportGenerationSlot) => {
      assertCurrent()
      const run = imports.find(slot)
      return run ? { view: viewOf(run), modelId: modelReceipt(run.binding).modelId, frozenContext: imports.context(run) } : null
    },
    assertImportGenerationSources: (handle: MainGenerationRunHandle, slot?: ImportGenerationSlot, allowLegacyStyle = false) => {
      const run = requireRun(handle)
      // Historical standalone style runs predate the checkpoint seam.
      if (!run.binding.sourceManifest.importSlot) {
        if (!allowLegacyStyle || !slot || slot.stage !== 'style' || run.binding.sourceManifest.operation !== 'analyze-writing-style'
          || !repository.budget(run.rootActionId).attempts.some(attempt => { const receipt = repository.receipt(attempt.attemptId); return receipt.run.runId === run.runId && receipt.result?.finishReason === 'stop' }))
          throw new Error('GENERATION_IMPORT_EFFECT_SLOT_CHANGED')
        assertSourcesCurrent(handle); return
      }
      if (!slot || !isDeepStrictEqual(imports.context(run).slot, slot)) throw new Error('GENERATION_IMPORT_EFFECT_SLOT_CHANGED')
      const current = deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))
      const attempts = repository.budget(run.rootActionId).attempts.filter(attempt => repository.receipt(attempt.attemptId).run.runId === run.runId)
      if (repository.budget(run.rootActionId).root.status === 'cancelled' || !compareGenerationSourceBindings(run.binding, current)
        || !attempts.length || attempts.some(attempt => {
          const receipt = repository.receipt(attempt.attemptId), artifact = receipt.artifact
          return receipt.result?.finishReason !== 'stop' || !artifact || !artifact.text.trim() || textHash(artifact.text) !== artifact.textHash
            || deps.database.prepare("SELECT 1 FROM generation_artifacts WHERE artifact_id=? AND status<>'discarded'").pluck().get(artifact.artifactId) !== 1
        }))
        throw new Error('GENERATION_IMPORT_EFFECT_SOURCE_CHANGED')
    },
    executeImportGeneration: async (request: import('../../src/shared/import-generation').ImportGenerationChannels['import-generation:execute']['args'][0]) => {
      const run = requireRun(request.handle)
      if (!Number.isSafeInteger(request.ordinal) || request.ordinal < 0 || request.ordinal >= MAIN_GENERATION_POLICY.budget.maxPhysicalRequests) throw new Error('GENERATION_IMPORT_ORDINAL_INVALID')
      imports.context(run)
      const invocationNonce = `import:${request.ordinal}`
      const prior = deps.database.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? AND invocation_nonce=?').get(run.runId, invocationNonce) as { attempt_id: string; usage_receipt_json: string } | undefined
      if (prior) {
        const usage = JSON.parse(prior.usage_receipt_json) as { replayTask?: GenerationTask; requestHash?: string }
        if (!usage.replayTask || textHash(JSON.stringify([usage.replayTask, run.binding.fingerprint.modelLeaseRevision, run.binding.fingerprint.policyHash])) !== usage.requestHash) throw new Error('GENERATION_IMPORT_TASK_INVALID')
        // Explicit ordinal replay reads the original request/receipt even when
        // the caller rebuilt a template or changed its current model selection.
        const running = pending.get(JSON.stringify([run.runId, invocationNonce]))
        return running ? running.promise : outcomeOf(repository.receipt(prior.attempt_id), usage.replayTask)
      }
      const count = deps.database.prepare('SELECT COUNT(*) FROM generation_attempts WHERE run_id=?').pluck().get(run.runId) as number
      if (count !== request.ordinal) throw new Error('GENERATION_IMPORT_ORDINAL_GAP')
      imports.assertMutable(run)
      imports.assertExecution(run, request.execution)
      const previous = repository.budget(run.rootActionId).attempts.map(attempt => repository.receipt(attempt.attemptId)).filter(receipt => receipt.run.runId === run.runId)
      if (previous.some(receipt => receipt.result?.finishReason !== 'stop')) throw new Error('GENERATION_IMPORT_PREVIOUS_ATTEMPT_INCOMPLETE')
      const current = viewOf(run).nonReplayable ? await resume(request.handle) : viewOf(run)
      return execute({ handle: current.handle, invocationNonce, task: request.task }, false, true)
    },
    characterProposals: characters,
    approveCharacterProposal: (request: ApproveCharacterProposalRequest) => {
      assertCurrent()
      return deps.database.transaction(() => {
        const batch = characters.read(request.proposalBatchId)
        if (batch.status === 'approved') return characters.approve(request)
        const source = batch.source
        const handle = source.kind === 'finalized-generation' ? proveFinalizedCharacterGeneration(deps.database, repository, deps.projectId, source.handle, source.artifact).currentHandle
          : source.kind === 'legacy-roster-generation' ? readLegacyRosterGenerationProof(deps.database, repository, deps.projectId, source).currentHandle : source.kind === 'generation' ? source.handle
          : source.kind === 'directory' ? repository.listDirectoryProgress().find(item => item.operationId === source.operationId)?.sourceHandle : undefined
        return handle ? agents.withChildEffect(handle, () => characters.approve(request)) : characters.approve(request)
      }).immediate()
    },
    readFinalizedCharacterContext: (draftId: number) => finalizedCharacters.readContext(draftId),
    commitFinalizedCharacterStates: (request: FinalizedCharacterGenerationCommit) => finalizedCharacters.commit(request, characters, assertSourcesCurrent),
    listPendingFinalizedCharacterStateCandidates: () => finalizedCharacters.listPendingStateCandidates(),
    readPendingFinalizedCharacterStateCandidate: (request: { draftId: number; candidateKey: string }) => finalizedCharacters.readPendingStateCandidate(request),
    decideFinalizedCharacterStateCandidate: (request: import('../../src/shared/finalized-continuity').FinalizedCharacterStateDecisionRequest) => finalizedCharacters.decideStateCandidate(request),
    prepareReviewRevision: (request: PrepareReviewRevisionRequest) => reviewRevisions.prepare(request),
    commitReview: (request: ReviewGenerationCommitRequest) => reviewRevisions.commitReview(request, assertSourcesCurrent),
    commitRevision: (request: RevisionGenerationCommitRequest) => reviewRevisions.commitRevision(request, assertSourcesCurrent),
    readReviewRevisionRecovery: (handle: MainGenerationRunHandle) => reviewRevisions.readRecovery(handle,
      run => compareGenerationSourceBindings(run.binding, deps.rebuildBinding(run.binding, currentModelReceipt(run.binding))),
      run => viewOf(run).candidates?.at(-1)),
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
    commitDraft: (request: GenerationDraftCommitRequest) => {
      requireRun(request.handle)
      return deps.database.transaction(() => {
        // The effect owner still validates the exact target/hash on a saved ACK.
        if (draftEffects.readCommit(request.handle.runId)) return draftEffects.commit(request, () => { throw new Error('GENERATION_DRAFT_REPLAY_NOT_SAVED') })
        return agents.withChildEffect(request.handle, () => draftEffects.commit(request, () => assertSourcesCurrent(request.handle)))
      }).immediate()
    },
    withAgentChildEffect: <T>(handle: MainGenerationRunHandle, effect: () => T): T => { requireRun(handle); return agents.withChildEffect(handle, effect) },
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
      if (requireRun(handle).binding.sourceManifest.operation === 'agent-round') throw new Error('GENERATION_AGENT_CONTROL_IMMUTABLE')
      reviewRevisions.assertMutable(requireRun(handle).runId)
      imports.assertMutable(requireRun(handle))
      finalizations.assertMutable(requireRun(handle))
      graphs.assertMutable(requireRun(handle))
      legacyRosters.assertMutable(requireRun(handle))
      const run = requireRun(handle, true)
      if (repository.budget(run.rootActionId).root.status === 'cancelled') throw new Error('GENERATION_ACTION_CANCELLED')
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
      imports.assertMutable(old)
      finalizations.assertMutable(old)
      graphs.assertMutable(old)
      legacyRosters.assertMutable(old)
      if (old.binding.sourceManifest.legacyRosterContext) throw new Error('GENERATION_LEGACY_ADMISSION_REQUIRED')
      if (old.binding.sourceManifest.graphGenerationContext) throw new Error('GENERATION_GRAPH_ADMISSION_REQUIRED')
      if (selection.parentRootActionId || selection.uiActionNonce === repository.budget(old.rootActionId).root.uiActionNonce) throw new Error('GENERATION_RESTART_NEW_NONCE_REQUIRED')
      // Admit the replacement before cancelling; rejected sources must leave the original resumable.
      const next = begin(selection)
      service.cancel(old.rootActionId)
      return next
    },
    discardCandidate: (handle: MainGenerationRunHandle, artifactId: string) => {
      const run = requireRun(handle)
      if (run.binding.sourceManifest.operation === 'agent-round') throw new Error('GENERATION_AGENT_CONTROL_IMMUTABLE')
      reviewRevisions.assertMutable(run.runId)
      imports.assertMutable(run)
      finalizations.assertMutable(run)
      graphs.assertMutable(run)
      legacyRosters.assertMutable(run)
      const artifact = viewOf(run).candidates?.find(item => item.artifactId === artifactId)
      if (!artifact || artifact.status === 'running') throw new Error('GENERATION_CANDIDATE_NOT_DISCARDABLE')
      service.discardCandidate(artifactId)
      volatileReceipts.delete(artifact.attemptId)
      return viewOf(run)
    },
    suspendForProjectClose: () => {
      preparations.clear()
      finalizedCharacters.close()
      reviewRevisions.close()
      if (closed) return
      service.suspendForProjectClose()
      closed = true
      for (const leaseId of runLeases.values()) deps.leases.close(leaseId)
      runLeases.clear()
    },
  }
}
