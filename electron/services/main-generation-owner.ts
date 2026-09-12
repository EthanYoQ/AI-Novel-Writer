import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { BeginGenerationRequest, ExecuteGenerationRequest } from '../../src/shared/generation-owner-contract'
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
  buildBinding: (selection: BeginGenerationRequest, model: SafeGenerationModelReceipt) => RunBinding
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
  const runLeases = new Map<string, string>()
  const volatileReceipts = new Map<string, GenerationExecutionReceipt>()
  const pending = new Map<string, { hash: string; promise: Promise<MainGenerationExecuteReceipt> }>()
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
    return { ...handleOf(receipt.run), epoch: artifact.epoch, artifactId: artifact.artifactId, attemptId: artifact.attemptId,
      revision: artifact.revision, durableRevision: artifact.revision, text: artifact.text, textHash: artifact.textHash, status }
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
  const begin = (selection: BeginGenerationRequest): MainGenerationRunView => {
    assertCurrent()
    if (!selection || typeof selection.operation !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(selection.operation)
      || !Array.isArray(selection.promptKeys) || selection.promptKeys.length === 0
      || typeof selection.uiActionNonce !== 'string' || !selection.uiActionNonce.trim() || selection.uiActionNonce.length > 256
      || Object.keys(selection).some(key => !['operation', 'uiActionNonce', 'modelId', 'chapterNumber', 'selectedDraftIds', 'selectedFinalizedDraftIds', 'promptKeys', 'skillStages', 'output', 'parentRootActionId'].includes(key))) throw new Error('GENERATION_BEGIN_INVALID')
    const lease = deps.leases.begin(selection.modelId)
    try {
      const binding = deps.buildBinding(selection, safeGenerationModelReceipt(lease))
      if (binding.projectId !== deps.projectId || binding.epoch !== deps.epoch) throw new Error('GENERATION_BINDING_INVALID')
      const run = service.open({ ...binding, operation: selection.operation, uiActionNonce: selection.uiActionNonce,
        frozenInputHash: textHash(JSON.stringify([binding.fingerprint, binding.contextSnapshotId, selection.output])),
        budget: MAIN_GENERATION_POLICY.budget, parentRootActionId: selection.parentRootActionId })
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
    const details = { purpose: task.purpose, model: { id: frozenModel.modelId, configurationRevision: frozenModel.modelRevision, endpointFingerprint: frozenModel.endpointFingerprint },
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
    if (task.output !== run.binding.sourceManifest.outputContract) throw new Error('GENERATION_OUTPUT_CONTRACT_CHANGED')
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
      reasoningUpperBoundTokens: plan.reasoningUpperBoundTokens, usagePolicy: plan.usagePolicy })
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
  return { begin, execute, resume, list, read: (handle: MainGenerationRunHandle) => viewOf(requireRun(handle)),
    pause: (handle: MainGenerationRunHandle) => { const run = requireRun(handle, true); service.pause(run.rootActionId); return viewOf(repository.get(run.runId)) },
    cancel: (handle: MainGenerationRunHandle) => { const run = requireRun(handle); service.cancel(run.rootActionId); return viewOf(repository.get(run.runId)) },
    restart: (handle: MainGenerationRunHandle, selection: BeginGenerationRequest) => {
      const old = requireRun(handle)
      if (selection.parentRootActionId || selection.uiActionNonce === repository.budget(old.rootActionId).root.uiActionNonce) throw new Error('GENERATION_RESTART_NEW_NONCE_REQUIRED')
      service.cancel(old.rootActionId)
      return begin(selection)
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
      if (closed) return
      service.suspendForProjectClose()
      closed = true
      for (const leaseId of runLeases.values()) deps.leases.close(leaseId)
      runLeases.clear()
    },
  }
}
