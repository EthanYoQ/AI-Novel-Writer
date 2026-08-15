import type {
  ModelExecutionCapabilityEvidence,
  ModelExecutionLeaseReceipt,
} from '../../shared/ipc-channels'
import type { CreativeStrategy, GenerationReasoningStage } from '../../shared/reasoning-types'
import { ipc } from '../ipc-client'
import { useLLMStore } from '../../stores/llm-store'
import { useProjectStore } from '../../stores/project-store'
import {
  assertGenerationHarnessPolicy,
  createGenerationHarness,
  GenerationHarnessError,
  type GenerationHarnessPolicy,
  type GenerationMessage,
  type GenerationSession,
  type PhysicalGenerationPlan,
  type ProviderCompletion,
  type ResolvedCapabilityEvidence,
} from './generation-harness'

export type GenerationRuntimeBudget = GenerationHarnessPolicy

export interface LeaseCompletionRequest {
  leaseId: string
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
  /** Alternate physical budget inputs are forbidden; one budget owns both consumers. */
  policy?: never
  structuredLimits?: never
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
  options: CreateGenerationRuntimeOptions,
  environment: GenerationRuntimeEnvironment = createDefaultEnvironment(),
): Promise<GenerationRuntime> {
  if ('policy' in options || 'structuredLimits' in options) {
    throw new GenerationRuntimeError(
      'INVALID_BUDGET_SOURCE',
      '生成运行时只能接受一个共享 budget。',
    )
  }
  const budget = freezeBudget(options.budget)
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
  const frozenCreativeStrategy = environment.snapshotCreativeStrategy?.() ?? 'auto'

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
