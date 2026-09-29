import type { ModelProfile, ModelExecutionLeaseReceipt } from '../../src/shared/ipc-channels'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { tokenLiability, type ProviderUsagePolicy, type RootBudget } from '../../src/shared/generation-contract'
import type { GenerationBudgetReceipt } from '../repositories/generation-run-repository'
import { resolveGenerationParameters, resolveGenerationCapabilityConstraints } from '../llm/generation-parameter-policy'
import { planTaskBudget, S07_TASK_BUDGET_POLICY, type TaskBudgetDecision } from '../../src/services/generation/task-budget-planner'
import { formatTaskBudgetDecisionFailure } from '../../src/services/generation/prompt-budget-failure'
import type { LLMGenerateOptions } from '../llm/provider.interface'

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

/**
 * 批量根预算按章数缩放（预算策略变更，2026-09 生成前定稿对账引入）。
 *
 * 批量创作的所有子运行（每章首稿、auto_finalize 的 notes/cards）共用批次根的一份预算。生成前定稿
 * 对账让 auto_finalize 每章最低物理请求从 3 次（首稿、notes、cards）变为 4 次，10 章最低 40 次，
 * 超过单根的 32 次上限，第 9 章起会确定性 ROOT_BUDGET_EXHAUSTED。
 *
 * 每章预算 8 次 = 最低 4 次（对账、首稿、notes、cards）+ 4 次余量，足够覆盖典型的一次压缩或续写
 * 加两次角色卡修复；余量在整批内共享。单章理论上限（对账 1 + 首稿 1 + 续写/无进展恢复 7 + 压缩 1
 * + notes 1 + cards 3 = 14 次）不按章预留：超出仍 fail-closed。token 责任上限与活动时长按每次
 * 请求的同一比例（65 536 tokens、112.5 秒）缩放，使批量每次请求可用的额度与单根一致；单章非批量根不变。
 */
export const BATCH_ROOT_PHYSICAL_REQUESTS_PER_CHAPTER = 8
export function batchRootBudget(chapterCount: number): RootBudget {
  const base = MAIN_GENERATION_POLICY.budget
  if (!Number.isSafeInteger(chapterCount) || chapterCount < 1) throw new Error('GENERATION_BATCH_INTENT_INVALID')
  const maxPhysicalRequests = Math.max(base.maxPhysicalRequests, chapterCount * BATCH_ROOT_PHYSICAL_REQUESTS_PER_CHAPTER)
  return Object.freeze({ maxPhysicalRequests,
    maxTokenLiability: base.maxTokenLiability / base.maxPhysicalRequests * maxPhysicalRequests,
    maxOutputPerRequest: base.maxOutputPerRequest,
    maxActiveElapsedMs: base.maxActiveElapsedMs / base.maxPhysicalRequests * maxPhysicalRequests })
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

export function buildMainGenerationPlan(model: ModelProfile, receipt: Pick<ModelExecutionLeaseReceipt, 'capabilityEvidence'>,
  task: GenerationTask, budget: GenerationBudgetReceipt): MainGenerationPlan {
  assertSemanticGenerationTask(task)
  const inputUpperBoundTokens = task.messages.reduce((sum, message) =>
    sum + Buffer.byteLength(message.content, 'utf8') + Buffer.byteLength(message.role) + 32, 32)
  const endpoint = new URL(model.baseUrl)
  const official = endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.port
  const host = official ? endpoint.hostname : ''
  const openai = host === 'api.openai.com' && model.protocol === 'openai'
  const deepseek = host === 'api.deepseek.com' && model.protocol === 'openai'
  const gemini = host === 'generativelanguage.googleapis.com' && model.protocol === 'gemini'
  const siliconV4 = ['api.siliconflow.cn', 'api.siliconflow.com'].includes(host) && model.protocol === 'openai'
    && /^(?:Pro\/)?deepseek-ai\/DeepSeek-V4(?:-Flash|-Pro)?(?:-\d{4})?$/iu.test(model.modelName)
  const evidence = receipt.capabilityEvidence
  const safety = MAIN_GENERATION_POLICY.safetyMarginTokens
  const remaining = budget.policy.maxTokenLiability - budget.attempts.reduce((sum, attempt) => sum + tokenLiability(attempt), 0)
  const parameters = resolveGenerationParameters(model, { reasoningStage: task.reasoningStage ?? (task.output === 'visible-text' ? 'drafting' : 'planning') })
  const geminiReasoning = parameters.reasoning?.adapter === 'gemini-thinking-budget' ? parameters.reasoning.thinkingBudget : null
  const canBound = openai || deepseek || siliconV4 || gemini && geminiReasoning !== null && geminiReasoning >= 0
  if (!canBound) throw new Error('GENERATION_LIABILITY_UNBOUNDED')
  const separateReasoning = gemini ? geminiReasoning! : 0
  // One admission gate for every main task, with or without a semantic demand.
  // Without it, a graph/finalization/agent task on an official host could still
  // dispatch against a user-entered or legacy output cap that proves nothing
  // about the endpoint. Unknown models fail closed before any reservation.
  const capability = resolveGenerationCapabilityConstraints(model)
  const { modelContextWindowTokens: modelContext, modelMaxOutputTokens: modelOutput } = capability
  if (modelContext === null || modelOutput === null || capability.modelContextSource !== 'verified-provider-preset'
    || capability.modelOutputSource !== 'verified-provider-preset') {
    throw new Error('GENERATION_MODEL_CAPABILITY_UNKNOWN')
  }
  if (task.budgetDemand) {
    if (remaining <= 0 || siliconV4 && remaining < 1_048_576) throw new Error('ROOT_BUDGET_EXHAUSTED')
    const decision = planTaskBudget({
      stage: task.reasoningStage ?? (task.output === 'visible-text' ? 'drafting' : 'planning'),
      demand: task.budgetDemand,
      inputEstimate: { upperBoundTokens: inputUpperBoundTokens, estimatorVersion: MAIN_GENERATION_POLICY.estimatorVersion },
      capability,
      root: { remainingTokenLiability: remaining, maxOutputPerRequest: budget.policy.maxOutputPerRequest },
      liability: siliconV4 ? { mode: 'total-bounded', totalLiabilityUpperBoundTokens: 1_048_576 }
        : gemini ? { mode: 'separate-bounded', reasoningUpperBoundTokens: separateReasoning } : { mode: 'included-in-output' },
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
      usagePolicy: { estimatorVersion: MAIN_GENERATION_POLICY.estimatorVersion, safetyMarginTokens: safety,
        reasoning: gemini ? 'separately-billed' : 'included-in-completion', canBoundTotalLiability: true },
      trustedUsage: true, reservedTokens: decision.reservationLiabilityTokens, inputUpperBoundTokens,
      reasoningUpperBoundTokens: decision.reasoningUpperBoundTokens, requestedOutputTokens: decision.reservedOutputTokens,
    }
  }
  // A Silicon V4 attempt is admitted only when the root can still carry its
  // full documented-context liability. Report exhausted root accounting before
  // deriving a misleading non-positive per-request input capacity.
  if (siliconV4 && remaining < 1_048_576) throw new Error('ROOT_BUDGET_EXHAUSTED')
  // Same capability merge as planTaskBudget: the verified model limits are only
  // ever narrowed by the user's ModelSettings limits, the root ceiling/remaining
  // liability and the input occupancy. The lease's frozen evidence numbers are
  // not a bound here: they take the user's value when the preset has no lease-level
  // capabilities (OpenAI, Silicon) and let a verified context hide a smaller user one.
  const effectiveContext = Math.min(modelContext, capability.userContextWindowTokens ?? modelContext)
  const requestedOutputTokens = Math.min(modelOutput, capability.userMaxOutputTokens ?? modelOutput,
    budget.policy.maxOutputPerRequest, remaining - inputUpperBoundTokens - separateReasoning - safety,
    effectiveContext - inputUpperBoundTokens - separateReasoning - safety)
  if (!Number.isSafeInteger(requestedOutputTokens) || requestedOutputTokens <= 0) throw new Error('GENERATION_INPUT_CAPACITY_EXCEEDED')
  // SiliconFlow max_tokens excludes reasoning, and thinking_budget is not a hard
  // stop for every model. Reserve its full documented context ceiling instead.
  // This is a reservation, never a claim that the model consumed that many tokens.
  const reasoningUpperBoundTokens = siliconV4
    ? 1_048_576 - inputUpperBoundTokens - requestedOutputTokens - safety : separateReasoning
  const reservedTokens = inputUpperBoundTokens + requestedOutputTokens + reasoningUpperBoundTokens + safety
  if (reservedTokens > remaining) throw new Error('ROOT_BUDGET_EXHAUSTED')
  return {
    options: { ...parameters, maxTokens: requestedOutputTokens,
      ...(openai ? { outputTokenParameter: 'max_completion_tokens' as const } : {}),
      ...(task.output === 'structured-data' && evidence.structuredOutput ? { responseFormat: { type: 'json_object' } } : {}) },
    usagePolicy: { estimatorVersion: MAIN_GENERATION_POLICY.estimatorVersion, safetyMarginTokens: safety,
      reasoning: gemini ? 'separately-billed' : 'included-in-completion', canBoundTotalLiability: true },
    trustedUsage: true, reservedTokens, inputUpperBoundTokens, reasoningUpperBoundTokens, requestedOutputTokens,
  }
}
