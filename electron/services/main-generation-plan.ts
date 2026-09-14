import type { ModelProfile, ModelExecutionLeaseReceipt } from '../../src/shared/ipc-channels'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { tokenLiability, type ProviderUsagePolicy, type RootBudget } from '../../src/shared/generation-contract'
import type { GenerationBudgetReceipt } from '../repositories/generation-run-repository'
import { resolveGenerationParameters } from '../llm/generation-parameter-policy'
import type { LLMGenerateOptions } from '../llm/provider.interface'

/** Transitional finite ceilings. S07 calibrates a versioned product policy before rollout. */
export const MAIN_GENERATION_POLICY = Object.freeze({
  version: 's05-bounded-liability-v1',
  budget: Object.freeze({ maxPhysicalRequests: 32, maxTokenLiability: 2_097_152,
    maxOutputPerRequest: 32_768, maxActiveElapsedMs: 3_600_000 } satisfies RootBudget),
  estimatorVersion: 'utf8-bytes-plus-chat-framing-v1',
  safetyMarginTokens: 512,
})

export interface MainGenerationPlan {
  options: LLMGenerateOptions
  usagePolicy: ProviderUsagePolicy
  trustedUsage: boolean
  reservedTokens: number
  inputUpperBoundTokens: number
  reasoningUpperBoundTokens: number
  requestedOutputTokens: number
}

export function assertSemanticGenerationTask(task: GenerationTask): void {
  if (!task || typeof task !== 'object' || !/^[a-z0-9][a-z0-9:_-]{0,127}$/u.test(task.purpose)
    || !['visible-text', 'structured-data'].includes(task.output)
    || !Array.isArray(task.messages) || !task.messages.length || task.messages.length > 1024
    || task.messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string')
    || Object.keys(task).some(key => !['purpose', 'output', 'messages', 'reasoningStage', 'promptBudget'].includes(key))
    || task.reasoningStage !== undefined && !['drafting', 'planning', 'review', 'general'].includes(task.reasoningStage)) {
    throw new Error('GENERATION_SEMANTIC_TASK_INVALID')
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
  const context = siliconV4 ? Math.min(evidence.contextWindowTokens ?? 1_048_576, 1_048_576) : evidence.contextWindowTokens
  const safety = MAIN_GENERATION_POLICY.safetyMarginTokens
  const remaining = budget.policy.maxTokenLiability - budget.attempts.reduce((sum, attempt) => sum + tokenLiability(attempt), 0)
  const parameters = resolveGenerationParameters(model, { reasoningStage: task.reasoningStage ?? (task.output === 'visible-text' ? 'drafting' : 'planning') })
  const geminiReasoning = parameters.reasoning?.adapter === 'gemini-thinking-budget' ? parameters.reasoning.thinkingBudget : null
  const canBound = openai || deepseek || siliconV4 || gemini && geminiReasoning !== null && geminiReasoning >= 0
  if (!canBound) throw new Error('GENERATION_LIABILITY_UNBOUNDED')
  const separateReasoning = gemini ? geminiReasoning! : 0
  const requestedOutputTokens = Math.min(evidence.maxOutputTokens, budget.policy.maxOutputPerRequest,
    remaining - inputUpperBoundTokens - separateReasoning - safety,
    (context ?? remaining) - inputUpperBoundTokens - separateReasoning - safety)
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
