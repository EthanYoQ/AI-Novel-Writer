import type {
  LLMFinishReason,
  ModelExecutionCapabilityEvidenceSource,
  ModelProfile,
  TokenUsage,
} from '../../shared/ipc-channels'

export type GenerationOutput = 'visible-text' | 'structured-data'

export interface GenerationMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** A semantic generation contract. Physical provider parameters are deliberately absent. */
export interface GenerationTask {
  purpose: string
  output: GenerationOutput
  messages: readonly GenerationMessage[]
  /** Physical request controls belong exclusively to this module's plan. */
  maxTokens?: never
  maxOutputTokens?: never
  responseFormat?: never
  thinking?: never
  plan?: never
}

export interface DefaultModelSnapshot {
  revision: string
  model: Pick<
    ModelProfile,
    'id' | 'provider' | 'protocol' | 'modelName' | 'baseUrl' | 'maxTokens' | 'capabilities'
  >
  /** Main-process lease identity; the renderer never receives its model secret snapshot. */
  modelExecutionLeaseId?: string
  /** Authoritative non-secret identity supplied by the main-process lease receipt. */
  endpointFingerprint?: string
  /** Authoritative non-secret capability evidence supplied by the main-process lease receipt. */
  resolvedCapabilities?: ResolvedCapabilityEvidence
}

export interface DefaultModelSource {
  snapshotDefaultModel(): DefaultModelSnapshot | null
}

export interface GenerationHarnessPolicy {
  maxAttempts: number
  maxRequestedOutputTokens: number
  /** Intent-level cost cap for one physical request; independent of model identity. */
  maxRequestedOutputTokensPerAttempt: number
  deadlineMs: number
}

/**
 * Application-wide safety ceiling. Workflows may choose smaller intent budgets,
 * but no model capability or caller may enlarge one run beyond these bounds.
 */
export const GENERATION_ABSOLUTE_BUDGET_LIMITS = Object.freeze({
  maxAttempts: 32,
  maxRequestedOutputTokens: 147_456,
  maxRequestedOutputTokensPerAttempt: 32_768,
  deadlineMs: 60 * 60_000,
})

export type CapabilityEvidenceSource = ModelExecutionCapabilityEvidenceSource

export interface ResolvedCapabilityEvidence {
  contextWindowTokens: number | null
  maxOutputTokens: number
  reasoning: boolean | null
  structuredOutput: boolean | null
  usage: boolean | null
  source: {
    contextWindowTokens: CapabilityEvidenceSource
    maxOutputTokens: CapabilityEvidenceSource
    featureFlags: CapabilityEvidenceSource
  }
}

export interface FrozenGenerationModelIdentity {
  id: string
  configurationRevision: string
  endpointFingerprint: string
}

export interface PhysicalGenerationPlan {
  attempt: number
  output: GenerationOutput
  maxOutputTokens: number
  contextWindowTokens: number | null
  estimatedInputTokens: number
  deadlineAt: number
  responseFormat?: { type: 'json_object' }
}

export interface PhysicalGenerationRequest {
  /** The only model authorization crossing the completion seam. */
  modelExecutionLeaseId: string | null
  purpose: string
  messages: readonly GenerationMessage[]
  plan: Readonly<PhysicalGenerationPlan>
  signal: AbortSignal
}

export interface ProviderCompletion {
  content: string
  finishReason?: LLMFinishReason
  usage?: TokenUsage
}

/** The only true-external seam owned by the generation module. */
export interface CompletionPort {
  complete(request: PhysicalGenerationRequest): Promise<ProviderCompletion>
}

export interface GenerationAttemptReceipt {
  model: FrozenGenerationModelIdentity
  capabilities: ResolvedCapabilityEvidence
  budget: {
    attempt: number
    maxAttempts: number
    requestedOutputTokens: number
    cumulativeRequestedOutputTokens: number
    maxRequestedOutputTokens: number
    maxRequestedOutputTokensPerAttempt: number
    deadlineAt: number
  }
  finishReason: LLMFinishReason
  usage?: TokenUsage
}

export type GenerationOutcome =
  | {
      status: 'completed'
      content: string
      finishReason: 'stop'
      receipt: GenerationAttemptReceipt
    }
  | {
      status: 'incomplete'
      content: string
      finishReason: Exclude<LLMFinishReason, 'stop'>
      receipt: GenerationAttemptReceipt
    }

export interface GenerationExecutionOptions {
  signal?: AbortSignal
}

export interface GenerationSessionBudget {
  maxAttempts: number
  maxRequestedOutputTokens: number
  maxRequestedOutputTokensPerAttempt: number
  deadlineAt: number
}

export interface GenerationSession {
  readonly budget: Readonly<GenerationSessionBudget>
  complete(task: GenerationTask, options?: GenerationExecutionOptions): Promise<GenerationOutcome>
}

export interface GenerationHarness {
  openSession(): GenerationSession
}

export class GenerationHarnessError extends Error {
  constructor(
    readonly code:
      | 'NO_DEFAULT_MODEL'
      | 'INVALID_MODEL_REVISION'
      | 'UNTRUSTED_CAPABILITY_EVIDENCE'
      | 'INVALID_POLICY'
      | 'ATTEMPT_BUDGET_EXHAUSTED'
      | 'REQUESTED_TOKEN_BUDGET_EXHAUSTED'
      | 'CONTEXT_BUDGET_EXHAUSTED'
      | 'DEADLINE_EXHAUSTED'
      | 'CANCELLED'
      | 'PROVIDER_REQUEST_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'GenerationHarnessError'
  }
}

/** Failed physical attempt with a non-sensitive budget receipt for orchestration and audit. */
export class GenerationAttemptError extends GenerationHarnessError {
  constructor(
    code: 'CANCELLED' | 'DEADLINE_EXHAUSTED' | 'PROVIDER_REQUEST_FAILED',
    message: string,
    readonly receipt: GenerationAttemptReceipt,
  ) {
    super(code, message)
    this.name = 'GenerationAttemptError'
  }
}

const CONTEXT_SAFETY_RESERVE_TOKENS = 512

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

export function assertGenerationHarnessPolicy(policy: GenerationHarnessPolicy): void {
  if (
    positiveInteger(policy.maxAttempts) === null
    || positiveInteger(policy.maxRequestedOutputTokens) === null
    || positiveInteger(policy.maxRequestedOutputTokensPerAttempt) === null
    || positiveInteger(policy.deadlineMs) === null
  ) {
    throw new GenerationHarnessError('INVALID_POLICY', '生成会话预算必须是正整数。')
  }
  if (
    policy.maxAttempts > GENERATION_ABSOLUTE_BUDGET_LIMITS.maxAttempts
    || policy.maxRequestedOutputTokens > GENERATION_ABSOLUTE_BUDGET_LIMITS.maxRequestedOutputTokens
    || policy.maxRequestedOutputTokensPerAttempt
      > GENERATION_ABSOLUTE_BUDGET_LIMITS.maxRequestedOutputTokensPerAttempt
    || policy.deadlineMs > GENERATION_ABSOLUTE_BUDGET_LIMITS.deadlineMs
  ) {
    throw new GenerationHarnessError('INVALID_POLICY', '生成会话预算超过应用安全上限。')
  }
}

type GenerationModelDescriptor = DefaultModelSnapshot['model']

function freezeModel(model: GenerationModelDescriptor): Readonly<GenerationModelDescriptor> {
  const clone: GenerationModelDescriptor = {
    id: model.id,
    provider: model.provider,
    protocol: model.protocol,
    modelName: model.modelName,
    baseUrl: model.baseUrl,
    maxTokens: model.maxTokens,
    ...(model.capabilities ? { capabilities: { ...model.capabilities } } : {}),
  }
  if (clone.capabilities) Object.freeze(clone.capabilities)
  return Object.freeze(clone)
}

function normalizedBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, '')
  try {
    const endpoint = new URL(trimmed)
    endpoint.username = ''
    endpoint.password = ''
    endpoint.hash = ''
    endpoint.search = ''
    return endpoint.toString().replace(/\/+$/u, '')
  } catch {
    return trimmed
  }
}

function endpointFingerprint(model: GenerationModelDescriptor): string {
  return [
    model.protocol,
    model.provider,
    normalizedBaseUrl(model.baseUrl),
    model.modelName.trim(),
  ].join('|')
}

function resolveInitialCapabilities(model: Readonly<GenerationModelDescriptor>): ResolvedCapabilityEvidence {
  const legacyMaxOutputTokens = positiveInteger(model.maxTokens)
  const maxOutputTokens = legacyMaxOutputTokens ?? 1
  return {
    contextWindowTokens: null,
    maxOutputTokens,
    reasoning: null,
    structuredOutput: null,
    usage: null,
    source: {
      contextWindowTokens: 'unknown',
      maxOutputTokens: legacyMaxOutputTokens ? 'legacy-profile' : 'unknown',
      featureFlags: 'unknown',
    },
  }
}

function estimateInputTokens(messages: readonly GenerationMessage[]): number {
  return Math.max(1, Math.ceil(messages.reduce((total, message) => total + message.content.length, 0)))
}

function copyCapabilities(capabilities: ResolvedCapabilityEvidence): ResolvedCapabilityEvidence {
  return {
    ...capabilities,
    source: { ...capabilities.source },
  }
}

export function createGenerationHarness(dependencies: {
  modelSource: DefaultModelSource
  completionPort: CompletionPort
  policy: GenerationHarnessPolicy
  now?: () => number
}): GenerationHarness {
  const { modelSource, completionPort } = dependencies
  const policy = Object.freeze({ ...dependencies.policy })
  const now = dependencies.now ?? Date.now
  assertGenerationHarnessPolicy(policy)

  return {
    openSession(): GenerationSession {
      const selected = modelSource.snapshotDefaultModel()
      if (!selected) {
        throw new GenerationHarnessError('NO_DEFAULT_MODEL', '未配置默认生成模型。')
      }
      if (!selected.revision.trim()) {
        throw new GenerationHarnessError('INVALID_MODEL_REVISION', '默认模型配置缺少 revision。')
      }

      const modelExecutionLeaseId = selected.modelExecutionLeaseId?.trim() || null
      if (selected.resolvedCapabilities && !modelExecutionLeaseId) {
        throw new GenerationHarnessError(
          'UNTRUSTED_CAPABILITY_EVIDENCE',
          '已解析模型能力必须来自主进程执行租约。',
        )
      }

      const frozenModel = freezeModel(selected.model)
      const frozenIdentity = Object.freeze({
        id: frozenModel.id,
        configurationRevision: selected.revision,
        endpointFingerprint: selected.endpointFingerprint ?? endpointFingerprint(frozenModel),
      })
      const capabilities = selected.resolvedCapabilities
        ? copyCapabilities(selected.resolvedCapabilities)
        : resolveInitialCapabilities(frozenModel)
      const sessionBudget = Object.freeze({
        maxAttempts: policy.maxAttempts,
        maxRequestedOutputTokens: policy.maxRequestedOutputTokens,
        maxRequestedOutputTokensPerAttempt: policy.maxRequestedOutputTokensPerAttempt,
        deadlineAt: now() + policy.deadlineMs,
      })
      let attempts = 0
      let cumulativeRequestedOutputTokens = 0

      const attemptReceipt = (
        attempt: number,
        requestedOutputTokens: number,
        finishReason: LLMFinishReason,
        usage?: TokenUsage,
      ): GenerationAttemptReceipt => ({
        model: { ...frozenIdentity },
        capabilities: copyCapabilities(capabilities),
        budget: {
          attempt,
          maxAttempts: sessionBudget.maxAttempts,
          requestedOutputTokens,
          cumulativeRequestedOutputTokens,
          maxRequestedOutputTokens: sessionBudget.maxRequestedOutputTokens,
          maxRequestedOutputTokensPerAttempt: sessionBudget.maxRequestedOutputTokensPerAttempt,
          deadlineAt: sessionBudget.deadlineAt,
        },
        finishReason,
        ...(usage ? { usage: { ...usage } } : {}),
      })

      return {
        budget: sessionBudget,
        async complete(
          task: GenerationTask,
          options?: GenerationExecutionOptions,
        ): Promise<GenerationOutcome> {
          if (options?.signal?.aborted) {
            throw new GenerationHarnessError('CANCELLED', '生成请求已取消。')
          }
          if (now() >= sessionBudget.deadlineAt) {
            throw new GenerationHarnessError('DEADLINE_EXHAUSTED', '生成会话已超过截止时间。')
          }
          if (attempts >= sessionBudget.maxAttempts) {
            throw new GenerationHarnessError('ATTEMPT_BUDGET_EXHAUSTED', '生成会话已用尽请求次数。')
          }

          const remainingRequestedTokens = sessionBudget.maxRequestedOutputTokens
            - cumulativeRequestedOutputTokens
          if (remainingRequestedTokens <= 0) {
            throw new GenerationHarnessError(
              'REQUESTED_TOKEN_BUDGET_EXHAUSTED',
              '生成会话已用尽请求 Token 预算。',
            )
          }

          const estimatedInputTokens = estimateInputTokens(task.messages)
          const contextAvailableOutputTokens = capabilities.contextWindowTokens === null
            ? null
            : capabilities.contextWindowTokens - estimatedInputTokens - CONTEXT_SAFETY_RESERVE_TOKENS
          if (contextAvailableOutputTokens !== null && contextAvailableOutputTokens <= 0) {
            throw new GenerationHarnessError(
              'CONTEXT_BUDGET_EXHAUSTED',
              '当前生成输入没有安全的输出空间。',
            )
          }

          const maxOutputTokens = Math.min(
            capabilities.maxOutputTokens,
            remainingRequestedTokens,
            sessionBudget.maxRequestedOutputTokensPerAttempt,
            contextAvailableOutputTokens ?? Number.POSITIVE_INFINITY,
          )
          const attempt = attempts + 1
          const plan = Object.freeze({
            attempt,
            output: task.output,
            maxOutputTokens,
            contextWindowTokens: capabilities.contextWindowTokens,
            estimatedInputTokens,
            deadlineAt: sessionBudget.deadlineAt,
            ...(task.output === 'structured-data' && capabilities.structuredOutput === true
              ? { responseFormat: { type: 'json_object' as const } }
              : {}),
          })
          attempts = attempt
          cumulativeRequestedOutputTokens += maxOutputTokens

          const controller = new AbortController()
          const remainingMs = Math.max(1, sessionBudget.deadlineAt - now())
          let timeoutId: ReturnType<typeof setTimeout> | undefined
          let termination: 'cancelled' | 'deadline' | null = null
          let rejectTermination: ((reason: GenerationHarnessError) => void) | undefined
          const terminationPromise = new Promise<never>((_resolve, reject) => {
            rejectTermination = reject
            timeoutId = setTimeout(() => {
              termination = 'deadline'
              controller.abort()
              reject(new GenerationHarnessError('DEADLINE_EXHAUSTED', '生成请求超过会话截止时间。'))
            }, remainingMs)
          })
          const cancel = () => {
            termination = 'cancelled'
            controller.abort()
            rejectTermination?.(new GenerationHarnessError('CANCELLED', '生成请求已取消。'))
          }
          options?.signal?.addEventListener('abort', cancel, { once: true })

          let completion: ProviderCompletion
          try {
            completion = await Promise.race([
              completionPort.complete({
                modelExecutionLeaseId,
                purpose: task.purpose,
                messages: task.messages.map(message => Object.freeze({ ...message })),
                plan,
                signal: controller.signal,
              }),
              terminationPromise,
            ])
          } catch {
            const cancellationCode = termination === 'cancelled'
              ? 'CANCELLED'
              : termination === 'deadline'
                ? 'DEADLINE_EXHAUSTED'
                : 'PROVIDER_REQUEST_FAILED'
            throw new GenerationAttemptError(
              cancellationCode,
              cancellationCode === 'CANCELLED'
                ? '生成请求已取消。'
                : cancellationCode === 'DEADLINE_EXHAUSTED'
                  ? '生成请求超过会话截止时间。'
                  : '模型请求失败。',
              attemptReceipt(
                attempt,
                maxOutputTokens,
                cancellationCode === 'CANCELLED' ? 'cancelled' : 'error',
              ),
            )
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId)
            options?.signal?.removeEventListener('abort', cancel)
          }

          // Missing terminal evidence is never equivalent to a completed
          // creative fact. Provider adapters may preserve omitted values and
          // this seam normalizes them fail-closed.
          const finishReason = completion.finishReason ?? 'unknown'
          const receipt = attemptReceipt(
            attempt,
            maxOutputTokens,
            finishReason,
            completion.usage,
          )

          if (finishReason === 'stop') {
            return {
              status: 'completed',
              content: completion.content,
              finishReason,
              receipt,
            }
          }
          return {
            status: 'incomplete',
            content: completion.content,
            finishReason,
            receipt,
          }
        },
      }
    },
  }
}
