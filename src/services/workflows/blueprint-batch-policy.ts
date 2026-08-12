/** Product-level maximum for one semantic blueprint batch. */
export const MAX_BLUEPRINT_ITEMS_PER_BATCH = 5
export const DEFAULT_BLUEPRINT_GENERATION_COUNT = MAX_BLUEPRINT_ITEMS_PER_BATCH

const MIN_DIRECTORY_MAX_ATTEMPTS = 7
const MIN_DIRECTORY_REQUESTED_TOKEN_CALLS = 4
const DIRECTORY_SPLIT_RESERVE_MULTIPLIER = 2
const DIRECTORY_MAX_ATTEMPTS_HARD_LIMIT = 20
export const MAX_BLUEPRINT_CHAPTERS_PER_TASK = 50
const DIRECTORY_MAX_REQUESTED_TOKENS_PER_ATTEMPT = 4_096
const DIRECTORY_MIN_DEADLINE_MS = 10 * 60_000
const DIRECTORY_MAX_DEADLINE_MS = 10 * 60_000
const DIRECTORY_DEADLINE_PER_SEMANTIC_BATCH_MS = 60_000

export interface BlueprintGenerationCostPlan {
  chapterCount: number
  semanticBatchCount: number
  /** Baseline calls when every semantic batch completes without splitting. */
  expectedCalls: number
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
  const callsWithSplitReserve = semanticBatchCount * DIRECTORY_SPLIT_RESERVE_MULTIPLIER
  const uncappedMaxAttempts = Math.max(MIN_DIRECTORY_MAX_ATTEMPTS, callsWithSplitReserve)
  const maxAttempts = Math.min(DIRECTORY_MAX_ATTEMPTS_HARD_LIMIT, uncappedMaxAttempts)
  const requestedTokenCalls = Math.min(
    DIRECTORY_MAX_ATTEMPTS_HARD_LIMIT,
    Math.max(MIN_DIRECTORY_REQUESTED_TOKEN_CALLS, callsWithSplitReserve),
  )

  return {
    chapterCount: normalizedChapterCount,
    semanticBatchCount,
    expectedCalls: semanticBatchCount,
    exceedsHardLimit: normalizedChapterCount > MAX_BLUEPRINT_CHAPTERS_PER_TASK,
    runtimeBudget: {
      maxAttempts,
      maxRequestedOutputTokens:
        requestedTokenCalls * DIRECTORY_MAX_REQUESTED_TOKENS_PER_ATTEMPT,
      maxRequestedOutputTokensPerAttempt: DIRECTORY_MAX_REQUESTED_TOKENS_PER_ATTEMPT,
      deadlineMs: Math.min(
        DIRECTORY_MAX_DEADLINE_MS,
        Math.max(
          DIRECTORY_MIN_DEADLINE_MS,
          semanticBatchCount * DIRECTORY_DEADLINE_PER_SEMANTIC_BATCH_MS,
        ),
      ),
    },
  }
}

export function getBlueprintBatchAdvice(
  locale: 'zh-CN' | 'en-US',
  chapterCount?: number,
): string {
  const expectedCalls = chapterCount === undefined
    ? null
    : planBlueprintGenerationCost(chapterCount).expectedCalls
  if (locale === 'en-US') {
    const estimate = expectedCalls === null ? '' : ` Estimated baseline: ${expectedCalls} model call(s).`
    return `Each semantic batch contains at most 5 chapters; more chapters take more time and API calls.${estimate} Output-limited batches split automatically.`
  }
  const estimate = expectedCalls === null ? '' : `预计至少 ${expectedCalls} 次模型调用；`
  return `每个语义批次最多 5 章；${estimate}章节越多耗时和调用次数越多，达到输出限制时会自动继续拆分。`
}
