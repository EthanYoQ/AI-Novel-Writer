import type { ModelProfile, ModelExecutionLeaseReceipt } from '../../src/shared/ipc-channels'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { tokenLiability, type ProviderUsagePolicy, type RootBudget } from '../../src/shared/generation-contract'
import type { GenerationBudgetReceipt } from '../repositories/generation-run-repository'
import { resolveGenerationParameters, resolveGenerationCapabilityConstraints } from '../llm/generation-parameter-policy'
import { planTaskBudget, S07_TASK_BUDGET_POLICY, type TaskBudgetDecision } from '../../src/services/generation/task-budget-planner'
import { formatTaskBudgetDecisionFailure } from '../../src/services/generation/prompt-budget-failure'
import type { LLMGenerateOptions } from '../llm/provider.interface'
import type { CreativeStrategy, GenerationReasoningStage } from '../../src/shared/reasoning-types'
import { CREATIVE_STRATEGIES } from '../../src/shared/reasoning-types'
import { isDeepStrictEqual } from 'node:util'
import type { ArchitecturePlanningIntent, BeginGenerationRequest, PlanningGenerationScope } from '../../src/shared/generation-owner-contract'
import { planBlueprintGenerationCost } from '../../src/services/workflows/blueprint-batch-policy'
import { PLOT_OUTLINE_CONTENT, PLOT_OUTLINE_PROTOCOL, assertPlanningActionRange, parsePlanningTargetUnits, DEFAULT_PLANNING_ACTION_CHAPTERS } from '../../src/shared/plot-outline-contract'

/** Finite root ceilings and semantic sizing are frozen into each source binding. */
export const MAIN_GENERATION_POLICY = Object.freeze({
  version: 's07-task-and-liability-v1',
  taskBudgetPolicy: S07_TASK_BUDGET_POLICY,
  capabilityPolicyVersion: 'verified-endpoint-model-budget-v1',
  budget: Object.freeze({ maxPhysicalRequests: 32, maxTokenLiability: 2_097_152,
    maxOutputPerRequest: 32_768, maxActiveElapsedMs: 3_600_000 } satisfies RootBudget),
  estimatorVersion: 'utf8-bytes-plus-chat-framing-v1',
  safetyMarginTokens: 512,
})

export type MainGenerationPolicy = Readonly<Omit<typeof MAIN_GENERATION_POLICY, 'version' | 'budget'> & {
  version: typeof MAIN_GENERATION_POLICY.version | 's07-planning-v1' | 's07-capacity-v2'
  budget: RootBudget
  planning?: PlanningGenerationScope
}>

function scaledRootBudget(requests: number, maxOutputPerRequest: number, perRequestLiability = MAIN_GENERATION_POLICY.budget.maxTokenLiability / MAIN_GENERATION_POLICY.budget.maxPhysicalRequests): RootBudget {
  const base = MAIN_GENERATION_POLICY.budget
  const maxPhysicalRequests = Math.max(base.maxPhysicalRequests, requests)
  const budget = { maxPhysicalRequests,
    maxTokenLiability: perRequestLiability * maxPhysicalRequests,
    maxOutputPerRequest,
    maxActiveElapsedMs: base.maxActiveElapsedMs / base.maxPhysicalRequests * maxPhysicalRequests }
  if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('GENERATION_PLANNING_BUDGET_INVALID')
  return Object.freeze(budget)
}

function planningRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GENERATION_PLANNING_INTENT_INVALID')
  return value as Record<string, unknown>
}

function planningInput(selection: Pick<BeginGenerationRequest, 'authorInputs'>, id: string): Record<string, unknown> | undefined {
  const inputs = selection.authorInputs?.filter(input => input.id === id) ?? []
  if (!inputs.length) return undefined
  if (inputs.length !== 1) throw new Error('GENERATION_PLANNING_INTENT_INVALID')
  try { return planningRecord(JSON.parse(inputs[0].text)) }
  catch { throw new Error('GENERATION_PLANNING_INTENT_INVALID') }
}

function planningRange(from: unknown, to: unknown): { from: number; to: number } {
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
    || from < 1 || to < from) throw new Error('GENERATION_PLANNING_INTENT_INVALID')
  return Object.freeze({ from, to })
}

function architectureIntent(value: unknown): ArchitecturePlanningIntent {
  const record = planningRecord(value)
  const order = ['premise', 'characters', 'worldbuilding'] as const
  const steps = record.priorSteps
  if (record.version !== 'architecture-action-v1' || !Array.isArray(steps)
    || !isDeepStrictEqual(steps, order.filter(step => steps.includes(step))))
    throw new Error('GENERATION_PLANNING_INTENT_INVALID')
  const range = record.synopsisRange === null ? null : planningRecord(record.synopsisRange)
  const intent = { version: 'architecture-action-v1' as const,
    priorSteps: order.filter(step => steps.includes(step)),
    synopsisRange: range === null ? null : planningRange(range.from, range.to) }
  if (!isDeepStrictEqual(value, intent) || !intent.priorSteps.length && !intent.synopsisRange) throw new Error('GENERATION_PLANNING_INTENT_INVALID')
  return Object.freeze({ ...intent, priorSteps: Object.freeze(intent.priorSteps) })
}

export function planningGenerationScope(selection: Pick<BeginGenerationRequest, 'operation' | 'authorInputs'>): PlanningGenerationScope | null {
  if (selection.operation === 'chapter-blueprint-directory') {
    const range = planningInput(selection, 'directory:requested-range')
    const config = planningInput(selection, 'directory:author-config')
    if (!range || !config || !['full', 'append'].includes(String(range.mode))) throw new Error('GENERATION_PLANNING_INTENT_INVALID')
    const { from, to } = planningRange(range.startChapter, range.endChapter)
    assertPlanningActionRange({ from, to })
    planningRange(to, config.totalChapters)
    const requestedRange = { mode: range.mode as 'full' | 'append', startChapter: from, endChapter: to }
    if (!isDeepStrictEqual(range, requestedRange)) throw new Error('GENERATION_PLANNING_INTENT_INVALID')
    return Object.freeze({ kind: 'directory', requestedRange: Object.freeze(requestedRange) })
  }
  const step = selection.operation === 'generate-core-seed' ? 'premise'
    : selection.operation === 'character-architecture' ? 'characters'
      : selection.operation === 'generate-world-building' ? 'worldbuilding'
        : selection.operation === 'generate-plot-outline' ? 'synopsis' : null
  if (!step) return null
  const provided = planningInput(selection, 'architecture:planning-intent')
  const config = planningInput(selection, 'architecture:author-config')
  const intent = architectureIntent(provided ?? { version: 'architecture-action-v1',
    priorSteps: step === 'synopsis' ? [] : [step],
    synopsisRange: step === 'synopsis' ? { from: 1, to: Math.min(Number(config?.totalChapters), DEFAULT_PLANNING_ACTION_CHAPTERS) } : null })
  if (step === 'synopsis' ? !intent.synopsisRange : !intent.priorSteps.includes(step)) throw new Error('GENERATION_PLANNING_OPERATION_NOT_SELECTED')
  if (intent.synopsisRange) {
    planningRange(intent.synopsisRange.to, config?.totalChapters)
    assertPlanningActionRange(intent.synopsisRange)
  }
  return Object.freeze({ kind: 'architecture', intent, outlineProtocol: PLOT_OUTLINE_PROTOCOL, outlineContent: PLOT_OUTLINE_CONTENT })
}

export function newMainGenerationPolicy(selection: BeginGenerationRequest, model: ModelProfile): MainGenerationPolicy {
  const planning = planningGenerationScope(selection)
  if (planning) {
    const targets = selection.authorInputs?.filter(input => input.id === 'planning:target-units') ?? []
    if (targets.length > 1) throw new Error('GENERATION_PLANNING_TARGET_INVALID')
    parsePlanningTargetUnits(targets.length ? Number(targets[0].text) : undefined)
  }
  const limits = resolveGenerationCapabilityConstraints(model)
  if (limits.userMaxOutputTokens === null) throw new Error('GENERATION_PLANNING_BUDGET_INVALID')
  const cap = Math.min(limits.userMaxOutputTokens, limits.modelMaxOutputTokens ?? limits.userMaxOutputTokens)
  const requests = selection.batchIntent ? selection.batchIntent.range.endChapter - selection.batchIntent.range.startChapter + 1
    : planning?.kind === 'directory'
    ? planBlueprintGenerationCost(planning.requestedRange.endChapter - planning.requestedRange.startChapter + 1).recoveryCallBound
    : planning?.kind === 'architecture' ? planning.intent.priorSteps.reduce((sum, step) => sum + (step === 'premise' ? 1 : step === 'worldbuilding' ? 2
      : 3 + (2 * 8 - Math.ceil(8 / 3)) + 1), 0)
      + (planning.intent.synopsisRange ? 2 * (planning.intent.synopsisRange.to - planning.intent.synopsisRange.from + 1) : 0)
    : MAIN_GENERATION_POLICY.budget.maxPhysicalRequests
  const liability = Math.max(...(['drafting', 'planning', 'review', 'general'] as const).flatMap(stage =>
    CREATIVE_STRATEGIES.map(strategy => resolvePhysicalLiability(model, strategy, stage).reservationCeiling)))
  return Object.freeze({ ...MAIN_GENERATION_POLICY, version: 's07-capacity-v2', ...(planning ? { planning } : {}),
    budget: scaledRootBudget(selection.batchIntent ? requests * BATCH_ROOT_PHYSICAL_REQUESTS_PER_CHAPTER : requests, cap, liability) })
}

export function readMainGenerationPolicy(value: unknown): MainGenerationPolicy {
  const record = planningRecord(value)
  if (record.version === MAIN_GENERATION_POLICY.version && isDeepStrictEqual(value, MAIN_GENERATION_POLICY)) return MAIN_GENERATION_POLICY
  if (!['s07-planning-v1', 's07-capacity-v2', MAIN_GENERATION_POLICY.version].includes(String(record.version))) throw new Error('GENERATION_POLICY_UNSUPPORTED')
  const budget = planningRecord(record.budget), scope = record.planning === undefined ? null : planningRecord(record.planning)
  if (!isDeepStrictEqual(Object.keys(budget).sort(), Object.keys(MAIN_GENERATION_POLICY.budget).sort())
    || Object.values(budget).some(number => typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0))
    throw new Error('GENERATION_PLANNING_BUDGET_INVALID')
  let planning: PlanningGenerationScope | undefined
  if (!scope) {
    if (record.version === 's07-planning-v1') throw new Error('GENERATION_POLICY_UNSUPPORTED')
  } else if (scope.kind === 'architecture' && scope.outlineProtocol === 'legacy-range-v1') {
    planning = { kind: 'architecture', intent: architectureIntent(scope.intent), outlineProtocol: scope.outlineProtocol }
  } else if (scope.kind === 'architecture' && scope.outlineProtocol === PLOT_OUTLINE_PROTOCOL && isDeepStrictEqual(scope.outlineContent, PLOT_OUTLINE_CONTENT)) {
    planning = { kind: 'architecture', intent: architectureIntent(scope.intent), outlineProtocol: PLOT_OUTLINE_PROTOCOL, outlineContent: PLOT_OUTLINE_CONTENT }
  } else if (scope.kind === 'directory') {
    const range = planningRecord(scope.requestedRange), { from, to } = planningRange(range.startChapter, range.endChapter)
    if (range.mode !== 'full' && range.mode !== 'append') throw new Error('GENERATION_PLANNING_INTENT_INVALID')
    planning = { kind: 'directory', requestedRange: { mode: range.mode, startChapter: from, endChapter: to } }
  } else throw new Error('GENERATION_POLICY_UNSUPPORTED')
  if (!isDeepStrictEqual(value, { ...MAIN_GENERATION_POLICY, version: record.version, budget, ...(planning ? { planning } : {}) }))
    throw new Error('GENERATION_POLICY_UNSUPPORTED')
  return value as MainGenerationPolicy
}

/**
 * 批量根预算按章数缩放（线程 10 复用原有写前调用余量）。
 *
 * 批量创作的所有子运行（每章首稿、auto_finalize 的 notes/cards）共用批次根的一份预算。短细纲让 auto_finalize 每章最低物理请求从 3 次（首稿、notes、cards）变为 4 次，10 章最低 40 次，
 * 超过单根的 32 次上限，第 9 章起会确定性 ROOT_BUDGET_EXHAUSTED。
 *
 * 每章预算 8 次 = 最低 4 次（细纲、首稿、notes、cards）+ 4 次余量，足够覆盖典型的一次压缩或续写
 * 加两次角色卡修复；余量在整批内共享。单章理论上限（细纲 1 + 首稿 1 + 续写/无进展恢复 7 + 压缩 1
 * + notes 1 + cards 3 = 14 次）不按章预留：超出仍 fail-closed。token 责任上限与活动时长按每次
 * 请求的同一比例（65 536 tokens、112.5 秒）缩放，使批量每次请求可用的额度与单根一致；单章非批量根不变。
 */
export const BATCH_ROOT_PHYSICAL_REQUESTS_PER_CHAPTER = 8
export function batchRootBudget(chapterCount: number): RootBudget {
  if (!Number.isSafeInteger(chapterCount) || chapterCount < 1) throw new Error('GENERATION_BATCH_INTENT_INVALID')
  return scaledRootBudget(chapterCount * BATCH_ROOT_PHYSICAL_REQUESTS_PER_CHAPTER, MAIN_GENERATION_POLICY.budget.maxOutputPerRequest)
}

export interface MainGenerationPlan {
  budgetDecision?: TaskBudgetDecision
  options: LLMGenerateOptions
  usagePolicy: ProviderUsagePolicy
  trustedUsage: boolean
  reservedTokens: number
  inputUpperBoundTokens: number
  reasoningUpperBoundTokens: number
  requestedOutputTokens: number
}

/** Only main-created semantic decisions may cross the IPC error filter. */
export class TaskBudgetPreflightError extends Error {
  constructor(readonly decision: TaskBudgetDecision) {
    super(decision.decision === 'split-required' ? `TASK_BUDGET_SCOPE_SPLIT_REQUIRED:${decision.selectedQuantity}`
      : `TASK_BUDGET_CAPACITY_CONFLICT: ${formatTaskBudgetDecisionFailure(decision, decision.writingLanguage)}`)
  }
}

export function assertSemanticGenerationTask(task: GenerationTask): void {
  if (!task || typeof task !== 'object' || !/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(task.purpose)
    || !['visible-text', 'structured-data'].includes(task.output)
    || !Array.isArray(task.messages) || !task.messages.length || task.messages.length > 1024
    || task.messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string')
    || Object.keys(task).some(key => !['purpose', 'output', 'messages', 'reasoningStage', 'promptBudget', 'budgetDemand'].includes(key))
    || task.reasoningStage !== undefined && !['drafting', 'planning', 'review', 'general'].includes(task.reasoningStage)) {
    throw new Error('GENERATION_SEMANTIC_TASK_INVALID')
  }
  if (task.budgetDemand !== undefined) {
    const demand = task.budgetDemand
    if (!demand || typeof demand !== 'object' || Array.isArray(demand)
      || !['draft-units', 'structured-items'].includes(demand.kind)
      || !['zh-CN', 'en-US'].includes(demand.writingLanguage)
      || Object.keys(demand).some(key => !(demand.kind === 'draft-units'
        ? ['kind', 'writingLanguage', 'requestedUnits', 'segmentable'] : ['kind', 'writingLanguage', 'requestedItems']).includes(key))
      || demand.kind === 'draft-units' && (!Number.isSafeInteger(demand.requestedUnits) || demand.requestedUnits <= 0 || typeof demand.segmentable !== 'boolean')
      || demand.kind === 'structured-items' && (!Number.isSafeInteger(demand.requestedItems) || demand.requestedItems <= 0)) throw new Error('GENERATION_SEMANTIC_TASK_INVALID')
  }
}

function resolvePhysicalLiability(model: ModelProfile, creativeStrategy: CreativeStrategy, stage: GenerationReasoningStage) {
  const endpoint = new URL(model.baseUrl)
  const official = endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.port
  const host = official ? endpoint.hostname : ''
  const openai = host === 'api.openai.com' && model.protocol === 'openai'
  const deepseek = host === 'api.deepseek.com' && model.protocol === 'openai'
  const gemini = host === 'generativelanguage.googleapis.com' && model.protocol === 'gemini'
  const siliconV4 = ['api.siliconflow.cn', 'api.siliconflow.com'].includes(host) && model.protocol === 'openai'
    && /^(?:Pro\/)?deepseek-ai\/DeepSeek-V4(?:-Flash|-Pro)?(?:-\d{4})?$/iu.test(model.modelName)
  const siliconQwen = host === 'api.siliconflow.cn' && model.protocol === 'openai'
    && endpoint.pathname.replace(/\/+$/u, '') === '/v1' && !endpoint.search && !endpoint.hash
    && model.modelName === 'Qwen/Qwen3.8-27B'
  // Qwen's usable capacity remains 256K. Reserve the model card's expanded 1M
  // envelope conservatively under the provider's context truncation policy:
  // https://docs.siliconflow.cn/docs/userguide/capabilities/reasoning
  // https://huggingface.co/Qwen/Qwen3.8-27B
  // This is engineering headroom, not an empirically proven billing maximum.
  const capability = resolveGenerationCapabilityConstraints(model)
  const { modelContextWindowTokens: modelContext, modelMaxOutputTokens: modelOutput } = capability
  const knownCapacity = modelContext !== null && modelOutput !== null
  const safety = MAIN_GENERATION_POLICY.safetyMarginTokens
  const parameters = resolveGenerationParameters(model, { creativeStrategy, reasoningStage: stage })
  const geminiReasoning = parameters.reasoning?.adapter === 'gemini-thinking-budget' ? parameters.reasoning.thinkingBudget : null
  const compatibleReasoning = parameters.reasoning?.adapter === 'openai-thinking-budget' ? parameters.reasoning.thinkingBudget : null
  // An explicit compatible budget sizes both billed output parts. It does not
  // prove the service enforces a hard limit; preserve estimate settlement.
  const totalBounded = compatibleReasoning === null && knownCapacity && (siliconV4 || siliconQwen)
  // The catalog supplies bounds, not permission to use a compatible model.
  // Missing bounds produce an operational estimate and remain unknown.
  const canBound = compatibleReasoning === null && !model.reasoningMapping && knownCapacity && (openai || deepseek || siliconV4 || gemini && geminiReasoning !== null && geminiReasoning >= 0)
  const separateReasoning = compatibleReasoning ?? geminiReasoning ?? 0
  const usagePolicy: ProviderUsagePolicy = { estimatorVersion: MAIN_GENERATION_POLICY.estimatorVersion,
    safetyMarginTokens: safety, reasoning: !canBound ? 'unknown' : model.protocol === 'gemini' ? 'separately-billed' : 'included-in-completion',
    canBoundTotalLiability: canBound }
  const effectiveContext = Math.min(modelContext ?? Infinity, capability.userContextWindowTokens ?? Infinity)
  const reservationCeiling = totalBounded ? 1_048_576 : Number.isFinite(effectiveContext)
    ? effectiveContext : MAIN_GENERATION_POLICY.budget.maxTokenLiability
  return { capability, parameters, usagePolicy, reservationCeiling, effectiveContext, modelOutput,
    openai, gemini, totalBounded, canBound, separateReasoning, geminiReasoning, compatibleReasoning }
}

export function buildMainGenerationPlan(model: ModelProfile, receipt: Pick<ModelExecutionLeaseReceipt, 'capabilityEvidence'>,
  task: GenerationTask, budget: GenerationBudgetReceipt, creativeStrategy: CreativeStrategy = 'auto',
  policy: MainGenerationPolicy = MAIN_GENERATION_POLICY): MainGenerationPlan {
  assertSemanticGenerationTask(task)
  const inputUpperBoundTokens = task.messages.reduce((sum, message) =>
    sum + Buffer.byteLength(message.content, 'utf8') + Buffer.byteLength(message.role) + 32, 32)
  const { capability, parameters, usagePolicy, reservationCeiling, effectiveContext, modelOutput,
    openai, gemini, totalBounded, canBound, separateReasoning, geminiReasoning, compatibleReasoning }
    = resolvePhysicalLiability(model, creativeStrategy, task.reasoningStage ?? (task.output === 'visible-text' ? 'drafting' : 'planning'))
  const evidence = receipt.capabilityEvidence, safety = MAIN_GENERATION_POLICY.safetyMarginTokens
  const rootRemaining = budget.policy.maxTokenLiability - budget.attempts.reduce((sum, attempt) => sum + tokenLiability(attempt), 0)
  const remaining = policy.version === 's07-capacity-v2' ? Math.min(rootRemaining, reservationCeiling) : rootRemaining
  if (task.budgetDemand) {
    if (remaining <= 0 || totalBounded && remaining < 1_048_576) throw new Error('ROOT_BUDGET_EXHAUSTED')
    const separateOutput = totalBounded || model.protocol === 'gemini' || geminiReasoning !== null
      || compatibleReasoning !== null || parameters.reasoning?.adapter === 'siliconflow-v4-thinking'
    const thinkingDisabled = parameters.reasoning?.adapter === 'deepseek-v4-thinking'
      ? parameters.reasoning.thinking === 'disabled'
      : parameters.reasoning?.adapter === 'openai-reasoning-effort'
        && ['off', 'none', 'disabled'].includes(parameters.reasoning.reasoningEffort)
    const decision = planTaskBudget({
      stage: task.reasoningStage ?? (task.output === 'visible-text' ? 'drafting' : 'planning'),
      demand: task.budgetDemand,
      inputEstimate: { upperBoundTokens: inputUpperBoundTokens, estimatorVersion: MAIN_GENERATION_POLICY.estimatorVersion },
      capability,
      root: { remainingTokenLiability: remaining, maxOutputPerRequest: budget.policy.maxOutputPerRequest },
      liability: totalBounded ? { mode: 'total-bounded', totalLiabilityUpperBoundTokens: 1_048_576 }
        : !canBound ? { mode: 'unknown', reasoningUpperBoundTokens: separateReasoning }
          : gemini ? { mode: 'separate-bounded', reasoningUpperBoundTokens: separateReasoning } : { mode: 'included-in-output' },
      outputAllocation: policy.version === 's07-capacity-v2' ? 'physical-capacity'
        : policy.version !== 's07-planning-v1' && (separateOutput || thinkingDisabled) ? 'semantic-estimate' : 'available-ceiling',
      safetyMarginTokens: safety,
    })
    // No reservation or dispatch occurs for a larger semantic scope. The caller
    // rebuilds an exact smaller scope, preserving every required input byte.
    if (decision.decision !== 'ready') throw new TaskBudgetPreflightError(decision)
    return {
      budgetDecision: decision,
      options: { ...parameters, maxTokens: decision.reservedOutputTokens,
        ...(openai ? { outputTokenParameter: 'max_completion_tokens' as const } : {}),
        ...(task.output === 'structured-data' && evidence.structuredOutput ? { responseFormat: { type: 'json_object' } } : {}) },
      usagePolicy,
      trustedUsage: true, reservedTokens: decision.reservationLiabilityTokens, inputUpperBoundTokens,
      reasoningUpperBoundTokens: decision.reasoningUpperBoundTokens, requestedOutputTokens: decision.reservedOutputTokens,
    }
  }
  // A total-bounded attempt requires room for its full reservation envelope.
  // Report exhausted root accounting before
  // deriving a misleading non-positive per-request input capacity.
  if (remaining <= 0 || totalBounded && remaining < 1_048_576) throw new Error('ROOT_BUDGET_EXHAUSTED')
  // Same capability merge as planTaskBudget: the verified model limits are only
  // ever narrowed by the user's ModelSettings limits, the root ceiling/remaining
  // liability and the input occupancy. The lease's frozen evidence numbers are
  // not a bound here: they take the user's value when the preset has no lease-level
  // capabilities (OpenAI, Silicon) and let a verified context hide a smaller user one.
  const requestedOutputTokens = Math.min(modelOutput ?? Infinity, capability.userMaxOutputTokens ?? Infinity,
    budget.policy.maxOutputPerRequest, remaining - inputUpperBoundTokens - separateReasoning - safety,
    effectiveContext - inputUpperBoundTokens - separateReasoning - safety)
  if (!Number.isSafeInteger(requestedOutputTokens) || requestedOutputTokens <= 0) throw new Error('GENERATION_INPUT_CAPACITY_EXCEEDED')
  // SiliconFlow max_tokens excludes reasoning, and thinking_budget is not a hard
  // stop for every model. Reserve the separately selected envelope instead.
  // This is a reservation, never a claim that the model consumed that many tokens.
  const reasoningUpperBoundTokens = totalBounded
    ? 1_048_576 - inputUpperBoundTokens - requestedOutputTokens - safety : separateReasoning
  const reservedTokens = inputUpperBoundTokens + requestedOutputTokens + reasoningUpperBoundTokens + safety
  if (reservedTokens > remaining) throw new Error('ROOT_BUDGET_EXHAUSTED')
  return {
    options: { ...parameters, maxTokens: requestedOutputTokens,
      ...(openai ? { outputTokenParameter: 'max_completion_tokens' as const } : {}),
      ...(task.output === 'structured-data' && evidence.structuredOutput ? { responseFormat: { type: 'json_object' } } : {}) },
    usagePolicy,
    trustedUsage: true, reservedTokens, inputUpperBoundTokens, reasoningUpperBoundTokens, requestedOutputTokens,
  }
}
