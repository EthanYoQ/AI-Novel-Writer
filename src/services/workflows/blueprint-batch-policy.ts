/** Product-level maximum for one semantic blueprint batch. */
export const MAX_BLUEPRINT_ITEMS_PER_BATCH = 5
export const DEFAULT_BLUEPRINT_GENERATION_COUNT = MAX_BLUEPRINT_ITEMS_PER_BATCH

const DIRECTORY_MAX_ATTEMPTS_HARD_LIMIT = 32
const DIRECTORY_MAX_REQUESTED_TOKENS = 131_072
const DIRECTORY_SYNTAX_REPAIR_RESERVE_CALLS = 1
export const MAX_BLUEPRINT_CHAPTERS_PER_TASK = 50
const DIRECTORY_MAX_REQUESTED_TOKENS_PER_ATTEMPT = 4_096
const DIRECTORY_MIN_DEADLINE_MS = 10 * 60_000
const DIRECTORY_MAX_DEADLINE_MS = 30 * 60_000
const DIRECTORY_DEADLINE_PER_ATTEMPT_MS = 2 * 60_000

export interface BlueprintGenerationCostPlan {
  chapterCount: number
  semanticBatchCount: number
  /** Baseline calls when every semantic batch completes without splitting. */
  expectedCalls: number
  /** Allowed physical-call ceiling after recursive-split/repair planning and the product hard cap. */
  maxCalls: number
  maxCompactSingleFallbacks: number
  /** True means the logical scope must be split into separate workflow runs. */
  exceedsHardLimit: boolean
  runtimeBudget: {
    maxAttempts: number
    maxRequestedOutputTokens: number
    maxRequestedOutputTokensPerAttempt: number
    deadlineMs: number
  }
}

/**
 * Derive a task cost envelope from logical work only. This deliberately does
 * not inspect provider names, model IDs, or a model-specific token registry.
 */
export function planBlueprintGenerationCost(chapterCount: number): BlueprintGenerationCostPlan {
  const normalizedChapterCount = Number.isFinite(chapterCount)
    ? Math.max(0, Math.floor(chapterCount))
    : 0
  const semanticBatchCount = Math.ceil(normalizedChapterCount / MAX_BLUEPRINT_ITEMS_PER_BATCH)
  const maxCompactSingleFallbacks = normalizedChapterCount
  // For a semantic batch of n items, recursively splitting every non-single
  // length result creates a full binary tree with 2n-1 physical calls. Across
  // B initial batches this is 2N-B. The executor additionally permits one
  // compact fallback per item key and one
  // global syntax repair.
  const uncappedMaxCalls = normalizedChapterCount === 0
    ? 0
    : (2 * normalizedChapterCount)
      - semanticBatchCount
      + maxCompactSingleFallbacks
      + DIRECTORY_SYNTAX_REPAIR_RESERVE_CALLS
  const maxCalls = Math.min(DIRECTORY_MAX_ATTEMPTS_HARD_LIMIT, uncappedMaxCalls)

  return {
    chapterCount: normalizedChapterCount,
    semanticBatchCount,
    expectedCalls: semanticBatchCount,
    maxCalls,
    maxCompactSingleFallbacks,
    exceedsHardLimit: normalizedChapterCount > MAX_BLUEPRINT_CHAPTERS_PER_TASK,
    runtimeBudget: {
      maxAttempts: maxCalls,
      maxRequestedOutputTokens: Math.min(
        DIRECTORY_MAX_REQUESTED_TOKENS,
        maxCalls * DIRECTORY_MAX_REQUESTED_TOKENS_PER_ATTEMPT,
      ),
      maxRequestedOutputTokensPerAttempt: DIRECTORY_MAX_REQUESTED_TOKENS_PER_ATTEMPT,
      deadlineMs: Math.min(
        DIRECTORY_MAX_DEADLINE_MS,
        Math.max(
          DIRECTORY_MIN_DEADLINE_MS,
          maxCalls * DIRECTORY_DEADLINE_PER_ATTEMPT_MS,
        ),
      ),
    },
  }
}

export function getBlueprintBatchAdvice(
  locale: 'zh-CN' | 'en-US',
  chapterCount?: number,
): string {
  const plan = chapterCount === undefined ? null : planBlueprintGenerationCost(chapterCount)
  if (locale === 'en-US') {
    const estimate = plan === null
      ? ''
      : ` Estimated baseline: ${plan.expectedCalls} model call(s); task allowance: up to ${plan.maxCalls}.`
    return `Each semantic batch contains at most 5 chapters; more chapters take more time and API calls.${estimate} Output-limited batches split automatically.`
  }
  const estimate = plan === null
    ? ''
    : `预计至少 ${plan.expectedCalls} 次模型调用，本任务最多允许 ${plan.maxCalls} 次；`
  return `每个语义批次最多 5 章；${estimate}章节越多耗时和调用次数越多，达到输出限制时会自动继续拆分。`
}
