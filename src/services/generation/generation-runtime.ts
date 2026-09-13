import type { FrozenInputFingerprint } from '../../shared/source-ref'
import type {
  ModelExecutionCapabilityEvidence,
  ModelExecutionLeaseReceipt,
  ProjectSessionContext,
} from '../../shared/ipc-channels'
import type { CreativeStrategy, GenerationReasoningStage } from '../../shared/reasoning-types'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import type { RootBudget } from '../../shared/generation-contract'
import { hashAuthorText, isContentHash } from '../../shared/source-ref'
import { ipc } from '../ipc-client'
import { useLLMStore } from '../../stores/llm-store'
import { useProjectStore } from '../../stores/project-store'
import {
  assertGenerationHarnessPolicy,
  createGenerationHarness,
  GenerationHarnessError,
  type GenerationHarnessPolicy,
  type GenerationMessage,
  type GenerationOutcome,
  type GenerationTask,
  type GenerationSessionBudget,
  type GenerationSession,
  type PhysicalGenerationPlan,
  type ProviderCompletion,
  type ResolvedCapabilityEvidence,
} from './generation-harness'

export type GenerationRuntimeBudget = GenerationHarnessPolicy

export interface LeaseCompletionRequest {
  leaseId: string
  projectSession?: ProjectSessionContext
  purpose: string
  creativeStrategy: CreativeStrategy
  reasoningStage: GenerationReasoningStage
  messages: readonly GenerationMessage[]
  plan: Readonly<PhysicalGenerationPlan>
  signal: AbortSignal
  onChunk?: (chunk: string) => void
}

/** Renderer adapter for the authoritative main-process model lease seam. */
export interface GenerationRuntimeEnvironment {
  snapshotDefaultModelId(): string | null
  snapshotCreativeStrategy?(): CreativeStrategy
  beginModelExecution(modelId: string): Promise<ModelExecutionLeaseReceipt>
  completeWithLease(request: LeaseCompletionRequest): Promise<ProviderCompletion>
  closeModelExecution(leaseId: string): Promise<void>
}

export interface GenerationRuntimeScope {
  session: GenerationSession
}

export interface GenerationRuntime {
  execute<T>(operation: (scope: GenerationRuntimeScope) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export interface CreateGenerationRuntimeOptions {
  budget: GenerationRuntimeBudget
  /** Optional semantic model identity; omitted means snapshot the renderer default once. */
  modelId?: string
  /** Project identity captured by the caller before any asynchronous lease work. */
  projectSession?: ProjectSessionContext
  /** Project writing policy captured by the caller before asynchronous preparation. */
  creativeStrategy?: CreativeStrategy
  /** Alternate physical budget inputs are forbidden; one budget owns both consumers. */
  policy?: never
  structuredLimits?: never
}

/** Opt-in S05 handle. Only the main-process begin action may issue this identity. */
export interface MainGenerationRunHandle {
  projectId: string
  epoch: string
  rootActionId: string
  runId: string
}
export interface MainGenerationSnapshot extends MainGenerationRunHandle {
  artifactId: string
  attemptId: string
  revision: number
  durableRevision: number
  text: string
  textHash: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  /** Main-verified settled stop/length artifact; status alone never authorizes composition. */
  compositionEligible?: boolean
}
export interface MainGenerationRunView {
  candidates?: readonly (MainGenerationSnapshot & { fingerprint: FrozenInputFingerprint; nonReplayable: true })[]
  unsavedTails?: readonly { attemptId: string; artifactId: string; durableRevision: number; text: string; failureCode: string }[]
  ledger?: { policy: RootBudget; tokenLiability: number; physicalRequests: number; activeElapsedMs: number; blockedCode: string | null }
  handle: MainGenerationRunHandle
  /** Read-only compatibility projection from the persistent main ledger. */
  budget: Readonly<GenerationSessionBudget>
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  nonReplayable: boolean
  artifacts: readonly MainGenerationSnapshot[]
}
export interface MainGenerationExecuteReceipt {
  outcome: GenerationOutcome
  run: MainGenerationRunView
}
/** No provider, model lease creation, reservation or root creation methods exist here. */
export interface MainGenerationTransport {
  execute(request: { handle: MainGenerationRunHandle; invocationNonce: string; task: GenerationTask }): Promise<MainGenerationExecuteReceipt>
  read(handle: MainGenerationRunHandle): Promise<MainGenerationRunView>
  list(projectSession: ProjectSessionContext): Promise<readonly MainGenerationRunView[]>
  cancel(handle: MainGenerationRunHandle): Promise<MainGenerationRunView>
  subscribe(handle: MainGenerationRunHandle, listener: (snapshot: MainGenerationSnapshot) => void): () => void
}
export interface MainOwnedGenerationRuntimeOptions {
  runHandle: MainGenerationRunHandle
  onSnapshot?: (snapshot: Readonly<MainGenerationSnapshot>) => void
  budget?: never
  modelId?: never
  policy?: never
  structuredLimits?: never
}
export interface MainOwnedGenerationRuntime extends GenerationRuntime {
  read(): Promise<MainGenerationRunView>
  cancel(): Promise<MainGenerationRunView>
}
/** Pure read seam for F04; neither operation creates roots nor resumes execution. */
export function listMainGenerationRuns(transport: MainGenerationTransport, session: ProjectSessionContext): Promise<readonly MainGenerationRunView[]> {
  return transport.list({ ...session })
}
export function readMainGenerationRun(transport: MainGenerationTransport, handle: MainGenerationRunHandle): Promise<MainGenerationRunView> {
  return transport.read({ ...handle })
}
let defaultMainTransport: MainGenerationTransport | undefined
/** Installed once by the central typed IPC adapter; absent wiring fails closed. */
export function installMainGenerationTransport(transport: MainGenerationTransport): void {
  if (defaultMainTransport && defaultMainTransport !== transport) throw new Error('GENERATION_TRANSPORT_ALREADY_INSTALLED')
  defaultMainTransport = transport
}
function sameHandle(left: MainGenerationRunHandle, right: MainGenerationRunHandle): boolean {
  return ['projectId', 'epoch', 'rootActionId', 'runId'].every(key => {
    const field = key as keyof MainGenerationRunHandle
    return typeof left[field] === 'string' && Boolean(left[field].trim()) && left[field] === right[field]
  })
}
export async function createMainOwnedGenerationRuntime(options: MainOwnedGenerationRuntimeOptions, injected?: MainGenerationTransport): Promise<MainOwnedGenerationRuntime> {
  const transport = injected ?? defaultMainTransport
  if (!transport) throw new Error('MAIN_GENERATION_TRANSPORT_REQUIRED')
  if (['budget', 'modelId', 'policy', 'structuredLimits'].some(key => Object.hasOwn(options, key))) throw new Error('MAIN_OWNER_CONTROLS_BUDGET_AND_MODEL')
  const handle = Object.freeze({ ...options.runHandle })
  if (!sameHandle(handle, handle)) throw new Error('INVALID_MAIN_RUN_HANDLE')
  let closed = false
  let projectionError: unknown
  let queue = Promise.resolve()
  const snapshots = new Map<string, MainGenerationSnapshot>()
  const assertView = (view: MainGenerationRunView) => {
    if (!sameHandle(handle, view.handle)) throw new Error('MAIN_RUN_IDENTITY_MISMATCH')
    return view
  }
  const accept = (snapshot: MainGenerationSnapshot) => {
    const captured = { ...snapshot }
    queue = queue.then(async () => {
      if (closed) return
      if (!sameHandle(handle, captured) || !captured.artifactId?.trim() || !captured.attemptId?.trim()
        || !Number.isSafeInteger(captured.revision) || captured.revision < 0
        || !Number.isSafeInteger(captured.durableRevision) || captured.durableRevision < 0 || captured.durableRevision > captured.revision
        || !['running', 'completed', 'failed', 'cancelled', 'unknown'].includes(captured.status)
        || typeof captured.text !== 'string' || !isContentHash(captured.textHash) || await hashAuthorText(captured.text) !== captured.textHash) throw new Error('INVALID_MAIN_SNAPSHOT')
      if (closed) return
      const previous = snapshots.get(captured.artifactId)
      if (previous) {
        if (previous.attemptId !== captured.attemptId) throw new Error('MAIN_ARTIFACT_ATTEMPT_CHANGED')
        // Delivery order can differ from commit order. Older acknowledged views never replace newer ones.
        if (captured.revision < previous.revision) return
        if (previous.status !== 'running' && (captured.status !== previous.status || captured.textHash !== previous.textHash || captured.revision !== previous.revision)
          || captured.durableRevision < previous.durableRevision || !captured.text.startsWith(previous.text)
          || captured.revision === previous.revision && captured.textHash !== previous.textHash) throw new Error('MAIN_SNAPSHOT_REGRESSION')
        if (captured.revision === previous.revision && captured.durableRevision === previous.durableRevision && captured.status === previous.status) return
      }
      snapshots.set(captured.artifactId, Object.freeze(captured))
      options.onSnapshot?.(captured)
    }).catch(error => { projectionError = error })
  }
  const unsubscribe = transport.subscribe(handle, accept)
  let initial: MainGenerationRunView
  try {
    initial = assertView(await transport.read(handle))
    for (const snapshot of initial.artifacts) accept(snapshot)
    await queue
    if (projectionError) throw projectionError
  } catch (error) { closed = true; unsubscribe(); throw error }
  const assertOpen = () => {
    if (closed) throw new GenerationRuntimeError('RUNTIME_CLOSED', '模型生成运行时已关闭。')
    if (projectionError) throw projectionError
  }
  const read = async () => {
    assertOpen()
    const view = assertView(await transport.read(handle))
    for (const snapshot of view.artifacts) accept(snapshot)
    await queue
    assertOpen()
    return view
  }
  const session: GenerationSession = {
    budget: Object.freeze({ ...initial.budget }),
    async complete(task, execution) {
      assertOpen()
      const invocationNonce = execution?.invocationNonce
      if (!invocationNonce?.trim()) throw new Error('MAIN_INVOCATION_NONCE_REQUIRED')
      if (execution?.signal?.aborted) throw new GenerationHarnessError('CANCELLED', '生成请求已取消。')
      const view = await read()
      if (view.nonReplayable) throw new Error('MAIN_RUN_NON_REPLAYABLE')
      if (execution?.signal) throw new Error('MAIN_CANCEL_REQUIRES_EXPLICIT_ACTION')
      // Old onChunk cannot safely append independent attempts. Use full snapshot receipts instead.
      if (execution?.onChunk) throw new Error('MAIN_SNAPSHOT_CALLBACK_REQUIRED')
      const receipt = await transport.execute({ handle, invocationNonce, task: structuredClone(task) })
      assertView(receipt.run)
      for (const snapshot of receipt.run.artifacts) accept(snapshot)
      await queue
      if (projectionError) throw projectionError
      if (receipt.outcome.status === 'completed' && receipt.outcome.finishReason !== 'stop'
        || receipt.outcome.receipt.finishReason !== receipt.outcome.finishReason) throw new Error('INVALID_MAIN_OUTCOME')
      return receipt.outcome
    },
  }
  return {
    execute: async operation => { assertOpen(); return operation({ session }) },
    close: async () => { if (!closed) { closed = true; unsubscribe() } },
    read,
    cancel: async () => { assertOpen(); const view = assertView(await transport.cancel(handle)); for (const snapshot of view.artifacts) accept(snapshot); await queue; if (projectionError) throw projectionError; return view },
  }
}

export class GenerationRuntimeError extends Error {
  constructor(
    readonly code:
      | 'NO_DEFAULT_MODEL'
      | 'MODEL_NOT_FOUND'
      | 'INVALID_BUDGET_SOURCE'
      | 'LEASE_BEGIN_FAILED'
      | 'LEASE_IDENTITY_MISMATCH'
      | 'LEASE_CAPABILITY_INVALID'
      | 'LEASE_CLOSE_FAILED'
      | 'RUNTIME_CLOSED',
    message: string,
  ) {
    super(message)
    this.name = 'GenerationRuntimeError'
  }
}

function capabilityEvidenceFromLease(
  evidence: ModelExecutionCapabilityEvidence,
): ResolvedCapabilityEvidence {
  const positiveInteger = (value: unknown): value is number => (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  )
  const validSource = (value: unknown): boolean => [
    'verified-provider-preset',
    'user-operational-cap',
    'legacy-profile',
    'unknown',
  ].includes(String(value))
  const source = evidence.source as unknown as Record<string, unknown>
  const validContext = evidence.contextWindowTokens === null
    || positiveInteger(evidence.contextWindowTokens)
  const validFlags = [evidence.reasoning, evidence.structuredOutput, evidence.usage]
    .every(value => value === null || typeof value === 'boolean')
  const validSources = source !== null
    && typeof source === 'object'
    && validSource(source.contextWindowTokens)
    && validSource(source.maxOutputTokens)
    && validSource(source.featureFlags)
  const validFingerprint = /^[a-f0-9]{64}$/u.test(evidence.subjectFingerprint)
  if (
    !validContext
    || !positiveInteger(evidence.maxOutputTokens)
    || !validFlags
    || !validSources
    || !validFingerprint
  ) {
    throw new GenerationRuntimeError('LEASE_CAPABILITY_INVALID', '模型执行租约的能力证据无效。')
  }
  return {
    contextWindowTokens: evidence.contextWindowTokens,
    maxOutputTokens: evidence.maxOutputTokens,
    reasoning: evidence.reasoning,
    structuredOutput: evidence.structuredOutput,
    usage: evidence.usage,
    source: { ...evidence.source },
  }
}

function validateLeaseFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new GenerationRuntimeError('LEASE_CAPABILITY_INVALID', '模型执行租约的身份指纹无效。')
  }
}

function createDefaultEnvironment(): GenerationRuntimeEnvironment {
  const leaseModels = new Map<string, string>()
  return {
    snapshotDefaultModelId: () => useLLMStore.getState().defaultModelId,
    snapshotCreativeStrategy: () => (
      useProjectStore.getState().currentProject?.novelConfig.creativeStrategy ?? 'auto'
    ),
    async beginModelExecution(modelId) {
      const result = await ipc.invoke('llm:begin-execution-lease', modelId)
      if (!result.success || !result.lease) {
        if (result.errorCode === 'MODEL_NOT_FOUND') {
          throw new GenerationRuntimeError(
            'MODEL_NOT_FOUND',
            '指定的生成模型不存在或已被删除。',
          )
        }
        throw new GenerationRuntimeError(
          'LEASE_BEGIN_FAILED',
          result.error || '无法创建模型执行租约。',
        )
      }
      leaseModels.set(result.lease.leaseId, result.lease.modelId)
      return result.lease
    },
    completeWithLease(request) {
      const frozenModelId = leaseModels.get(request.leaseId)
      if (!frozenModelId) {
        return Promise.reject(new Error('模型执行租约无效或已关闭'))
      }
      const llmStore = useLLMStore.getState()
      return new Promise<ProviderCompletion>((resolve, reject) => {
        let requestId: string | null = null
        let settled = false
        const cleanup = () => request.signal.removeEventListener('abort', cancel)
        const succeed = (completion: ProviderCompletion) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(completion)
        }
        const fail = () => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error('模型租约请求失败'))
        }
        const cancel = () => {
          if (requestId) llmStore.cancelGeneration(requestId).catch(() => {})
          fail()
        }
        request.signal.addEventListener('abort', cancel, { once: true })
        if (request.signal.aborted) {
          cancel()
          return
        }

        llmStore.generateStream(
          [...request.messages],
          {
            onChunk: chunk => {
              if (!settled && !request.signal.aborted) request.onChunk?.(chunk)
            },
            onDone: (content, usage, finishReason) => succeed({ content, usage, finishReason }),
            onError: fail,
          },
          frozenModelId,
          {
            modelExecutionLeaseId: request.leaseId,
            projectSession: request.projectSession,
            purpose: request.purpose,
            creativeStrategy: request.creativeStrategy,
            reasoningStage: request.reasoningStage,
            maxTokens: request.plan.maxOutputTokens,
            responseFormat: request.plan.responseFormat,
          },
        ).then(id => {
          requestId = id
          if (request.signal.aborted) cancel()
        }).catch(fail)
      })
    },
    async closeModelExecution(leaseId) {
      const result = await ipc.invoke('llm:close-execution-lease', leaseId)
      if (!result.success) {
        throw new GenerationRuntimeError(
          'LEASE_CLOSE_FAILED',
          result.error || '关闭模型执行租约失败。',
        )
      }
      leaseModels.delete(leaseId)
    },
  }
}

function freezeBudget(budget: GenerationRuntimeBudget): Readonly<GenerationRuntimeBudget> {
  return Object.freeze({ ...budget })
}

/**
 * The sole renderer entry for one model-frozen generation run. It opens one
 * main-process lease and guarantees a close after every execute scope.
 */
export async function createGenerationRuntime(
  options: CreateGenerationRuntimeOptions | MainOwnedGenerationRuntimeOptions,
  injected?: GenerationRuntimeEnvironment | MainGenerationTransport,
): Promise<GenerationRuntime> {
  if ('runHandle' in options) {
    const transport = injected ?? defaultMainTransport
    if (!transport || !('subscribe' in transport)) throw new Error('MAIN_GENERATION_TRANSPORT_REQUIRED')
    return createMainOwnedGenerationRuntime(options, transport)
  }
  const environment = injected && 'beginModelExecution' in injected ? injected : createDefaultEnvironment()
  if ('policy' in options || 'structuredLimits' in options) {
    throw new GenerationRuntimeError(
      'INVALID_BUDGET_SOURCE',
      '生成运行时只能接受一个共享 budget。',
    )
  }
  const budget = freezeBudget(options.budget)
  const sessionCandidate = options.projectSession
    ?? projectSessionContextFromProject(useProjectStore.getState().currentProject)
  const projectSession = sessionCandidate
    ? Object.freeze({ ...sessionCandidate })
    : undefined
  // Validate before reading mutable renderer state or opening a billable model
  // lease. Oversized plans therefore fail without any provider-side effect.
  assertGenerationHarnessPolicy(budget)
  const explicitModelId = options.modelId?.trim()
  if (Object.hasOwn(options, 'modelId') && !explicitModelId) {
    throw new GenerationRuntimeError('MODEL_NOT_FOUND', '指定的生成模型不存在或已被删除。')
  }
  const frozenModelId = explicitModelId ?? environment.snapshotDefaultModelId()
  if (!frozenModelId) {
    throw new GenerationRuntimeError('NO_DEFAULT_MODEL', '未配置默认生成模型。')
  }
  const frozenCreativeStrategy = options.creativeStrategy
    ?? environment.snapshotCreativeStrategy?.()
    ?? 'auto'

  let lease: ModelExecutionLeaseReceipt
  try {
    lease = await environment.beginModelExecution(frozenModelId)
  } catch (error) {
    if (error instanceof GenerationRuntimeError && error.code === 'MODEL_NOT_FOUND') {
      throw new GenerationRuntimeError('MODEL_NOT_FOUND', '指定的生成模型不存在或已被删除。')
    }
    throw new GenerationRuntimeError('LEASE_BEGIN_FAILED', '无法创建模型执行租约。')
  }
  if (lease.modelId !== frozenModelId) {
    try {
      await environment.closeModelExecution(lease.leaseId)
    } catch { /* the identity failure remains authoritative */ }
    throw new GenerationRuntimeError(
      'LEASE_IDENTITY_MISMATCH',
      '模型执行租约与已冻结的生成模型不一致。',
    )
  }

  let resolvedCapabilities: ResolvedCapabilityEvidence
  try {
    validateLeaseFingerprint(lease.modelRevision)
    validateLeaseFingerprint(lease.endpointFingerprint)
    resolvedCapabilities = capabilityEvidenceFromLease(lease.capabilityEvidence)
  } catch {
    try {
      await environment.closeModelExecution(lease.leaseId)
    } catch { /* invalid evidence remains authoritative */ }
    throw new GenerationRuntimeError('LEASE_CAPABILITY_INVALID', '模型执行租约的能力证据无效。')
  }

  let closed = false
  let closePromise: Promise<void> | null = null
  const close = async () => {
    if (closed) return
    if (closePromise) return closePromise
    closePromise = environment.closeModelExecution(lease.leaseId)
      .then(() => { closed = true })
      .catch(() => {
        closePromise = null
        throw new GenerationRuntimeError('LEASE_CLOSE_FAILED', '关闭模型执行租约失败。')
      })
    return closePromise
  }

  const harness = createGenerationHarness({
    modelSource: {
      snapshotDefaultModel: () => ({
        revision: lease.modelRevision,
        model: {
          id: lease.modelId,
          provider: lease.provider,
          protocol: lease.protocol,
          modelName: lease.modelName,
          baseUrl: '',
          maxTokens: lease.capabilityEvidence.maxOutputTokens,
        },
        modelExecutionLeaseId: lease.leaseId,
        endpointFingerprint: lease.endpointFingerprint,
        resolvedCapabilities,
      }),
    },
    completionPort: {
      complete(request) {
        if (!request.modelExecutionLeaseId) {
          return Promise.reject(new GenerationHarnessError(
            'PROVIDER_REQUEST_FAILED',
            '模型生成缺少执行租约。',
          ))
        }
        return environment.completeWithLease({
          leaseId: request.modelExecutionLeaseId,
          projectSession,
          purpose: request.purpose,
          creativeStrategy: request.creativeStrategy,
          reasoningStage: request.reasoningStage,
          messages: request.messages,
          plan: request.plan,
          signal: request.signal,
          onChunk: request.onChunk,
        })
      },
    },
    policy: budget,
    creativeStrategy: frozenCreativeStrategy,
  })
  const session = harness.openSession()

  return {
    async execute<T>(operation: (scope: GenerationRuntimeScope) => Promise<T>): Promise<T> {
      if (closed) throw new GenerationRuntimeError('RUNTIME_CLOSED', '模型生成运行时已关闭。')
      let result: T
      try {
        result = await operation({ session })
      } catch (error) {
        try { await close() } catch { /* do not replace the operation failure */ }
        throw error
      }
      // Lease disposal is cleanup, not part of the caller's domain outcome.
      // Keep close() retryable for callers that retain the runtime; the
      // main-process lease TTL bounds any genuinely unreachable cleanup.
      try { await close() } catch { /* never turn a completed operation into a failure */ }
      return result
    },
    close,
  }
}
