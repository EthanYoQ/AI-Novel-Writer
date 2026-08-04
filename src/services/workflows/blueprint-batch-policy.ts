/** A physical blueprint request must stay small enough for local models. */
export const MAX_BLUEPRINT_CHAPTERS_PER_LLM_REQUEST = 5
export const DEFAULT_BLUEPRINT_GENERATION_COUNT = MAX_BLUEPRINT_CHAPTERS_PER_LLM_REQUEST

const MIN_BLUEPRINT_CHAPTERS_PER_LLM_REQUEST = 1
const BLUEPRINT_OUTPUT_BUDGET_RATIO = 0.6
const ESTIMATED_BLUEPRINT_TOKENS_PER_CHAPTER = 200

export function getBlueprintBatchAdvice(locale: 'zh-CN' | 'en-US'): string {
  if (locale === 'en-US') {
    return 'Each request is split into batches of at most 5 chapters. More chapters take more time and API calls; reduce the scope or raise the output limit for lower-output models.'
  }
  return '每次最多5章分批调用；章节越多耗时/调用次数越多，低输出能力模型应减少章节或提高输出上限。'
}

/**
 * Derive a conservative physical request size from the selected model, while
 * preserving the product invariant that no request may ask for more than five
 * chapter blueprints.
 */
export function getBlueprintBatchSize(modelMaxTokens: number | undefined): number {
  const safeModelMaxTokens = Number.isFinite(modelMaxTokens) && (modelMaxTokens ?? 0) > 0
    ? Number(modelMaxTokens)
    : 4096
  const estimatedCapacity = Math.floor(
    (safeModelMaxTokens * BLUEPRINT_OUTPUT_BUDGET_RATIO) / ESTIMATED_BLUEPRINT_TOKENS_PER_CHAPTER,
  )
  return Math.min(
    MAX_BLUEPRINT_CHAPTERS_PER_LLM_REQUEST,
    Math.max(MIN_BLUEPRINT_CHAPTERS_PER_LLM_REQUEST, estimatedCapacity),
  )
}
