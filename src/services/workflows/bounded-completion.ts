import type { LLMFinishReason } from '../../shared/ipc-channels'
import { stripThinkingTags } from './workflow-utils'

const CONTINUATION_VISIBLE_TAIL_CHARS = 1600
const MIN_VISIBLE_OVERLAP_CHARS = 48
const MAX_BOUNDED_CONTINUATIONS = 7
const MAX_STRUCTURED_CONTINUATIONS = 2
const MAX_TEXT_CONTINUATIONS = 3
const SAFE_UNKNOWN_CONTEXT_WINDOW_TOKENS = 8192
const SAFE_UNKNOWN_OUTPUT_TOKENS = 4096
const CONTEXT_SAFETY_RESERVE_TOKENS = 512
const ESTIMATED_CHARS_PER_TOKEN = 1.5
const MAX_CONTINUATION_PROMPT_CHARS = 12_000
const MIN_ORIGINAL_TASK_CHARS = 256
const MIN_VISIBLE_REFERENCE_CHARS = 192
const TRUNCATION_MARKER = '\n…[内容已按上下文预算截断]…\n'

export type BoundedCompletionMode = 'append-visible-text' | 'replace-structured-output'

export interface BoundedCompletion {
  content: string
  finishReason: LLMFinishReason
}

/**
 * The continuation module owns prompt composition, so callers provide only
 * the model limits it needs to reserve a bounded input slice. `null` means
 * unknown and intentionally falls back to the conservative 8k window.
 */
export interface BoundedCompletionPromptBudget {
  contextWindowTokens?: number | null
  maxOutputTokens?: number | null
  systemPromptChars?: number
}

export interface BoundedCompletionRequest {
  initial: BoundedCompletion
  mode: BoundedCompletionMode
  maxContinuations: number
  originalPrompt: string
  promptBudget?: BoundedCompletionPromptBudget
  requestContinuation: (prompt: string) => Promise<BoundedCompletion>
  isCancelled?: () => boolean
  redactVisibleText?: (text: string) => string
  mergeVisibleText?: (existing: string, addition: string) => string
}

/** Remove hidden reasoning and malformed thinking-tag remnants before any continuation context is composed. */
export function redactVisibleCompletionText(text: string): string {
  return stripThinkingTags(text)
}

function removeLeadingNonWhitespaceCharacters(text: string, count: number): string {
  if (count <= 0) return text
  let consumed = 0
  for (let index = 0; index < text.length; index += 1) {
    if (!/\s/u.test(text[index])) consumed += 1
    if (consumed >= count) return text.slice(index + 1).trimStart()
  }
  return ''
}

function overlappingVisiblePrefixLength(existingText: string, addition: string): number {
  const existingTail = existingText.slice(-CONTINUATION_VISIBLE_TAIL_CHARS).replace(/\s+/gu, '')
  const additionHead = addition.slice(0, CONTINUATION_VISIBLE_TAIL_CHARS).replace(/\s+/gu, '')
  const maximum = Math.min(existingTail.length, additionHead.length)

  for (let length = maximum; length >= MIN_VISIBLE_OVERLAP_CHARS; length -= 1) {
    if (existingTail.slice(-length) === additionHead.slice(0, length)) return length
  }
  return 0
}

/**
 * Join a visible text continuation without letting the repeated prompt tail
 * count as newly generated content. Callers may supply their own domain
 * sanitizer (draft generation removes UI residue and duplicate paragraphs).
 */
export function appendVisibleTextContinuation(
  existing: string,
  addition: string,
  redactVisibleText: (text: string) => string = redactVisibleCompletionText,
): string {
  const visibleExisting = redactVisibleText(existing)
  const visibleAddition = redactVisibleText(addition)
  const overlap = overlappingVisiblePrefixLength(visibleExisting, visibleAddition)
  const newVisibleText = removeLeadingNonWhitespaceCharacters(visibleAddition, overlap)
  return redactVisibleText([visibleExisting, newVisibleText].filter(Boolean).join('\n\n'))
}

function incompleteCompletionError(finishReason: LLMFinishReason): Error {
  switch (finishReason) {
    case 'length':
      return new Error('AI 输出达到模型最大长度，结果不完整。请提高模型最大输出 Tokens 或缩短本次任务后重试。')
    case 'content_filter':
      return new Error('AI 输出因内容限制而未完成，结果未被保存。')
    case 'cancelled':
      return new Error('AI 生成已取消，结果未被保存。')
    default:
      return new Error('AI 未正常完成生成，结果未被保存。')
  }
}

export function createBoundedCompletionError(finishReason: LLMFinishReason): Error {
  return incompleteCompletionError(finishReason)
}

function continuationLimitExceededError(maxContinuations: number): Error {
  return new Error(
    `AI 输出连续达到模型最大长度，已自动续写 ${maxContinuations} 次仍未完成，结果未被保存。` +
    '请提高模型最大输出 Tokens、缩短本次任务，或拆分为更小批次后重试。',
  )
}

function assertNotCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) throw new Error('工作流已取消')
}

function modeContinuationLimit(mode: BoundedCompletionMode): number {
  return mode === 'replace-structured-output'
    ? MAX_STRUCTURED_CONTINUATIONS
    : MAX_TEXT_CONTINUATIONS
}

function assertValidContinuationLimit(mode: BoundedCompletionMode, maxContinuations: number): void {
  if (
    !Number.isSafeInteger(maxContinuations)
    || maxContinuations < 0
    || maxContinuations > MAX_BOUNDED_CONTINUATIONS
  ) {
    throw new Error(`自动续写次数必须是 0 到 ${MAX_BOUNDED_CONTINUATIONS} 的整数。请缩短任务或提高模型最大输出 Tokens 后重试。`)
  }
  const modeLimit = modeContinuationLimit(mode)
  if (maxContinuations > modeLimit) {
    throw new Error(
      `当前输出类型最多自动续写 ${modeLimit} 次。` +
      '请缩短本次任务、提高模型最大输出 Tokens，或拆分为更小批次后重试。',
    )
  }
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

function nonNegativeSafeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0
}

function insufficientContextBudgetError(): Error {
  return new Error(
    '当前模型上下文预算不足以安全续写，结果未被保存。' +
    '请提高上下文窗口、降低最大输出 Tokens，或缩短本次任务后重试。',
  )
}

function continuationPromptCharBudget(budget?: BoundedCompletionPromptBudget): number {
  const contextWindowTokens = positiveSafeInteger(budget?.contextWindowTokens)
    ?? SAFE_UNKNOWN_CONTEXT_WINDOW_TOKENS
  const maxOutputTokens = positiveSafeInteger(budget?.maxOutputTokens)
    ?? SAFE_UNKNOWN_OUTPUT_TOKENS
  const inputTokens = contextWindowTokens - maxOutputTokens - CONTEXT_SAFETY_RESERVE_TOKENS
  const availableChars = Math.floor(inputTokens * ESTIMATED_CHARS_PER_TOKEN)
    - nonNegativeSafeInteger(budget?.systemPromptChars)
  const boundedChars = Math.min(MAX_CONTINUATION_PROMPT_CHARS, availableChars)
  if (inputTokens <= 0 || boundedChars <= 0) throw insufficientContextBudgetError()
  return boundedChars
}

function truncateWithHeadAndTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= TRUNCATION_MARKER.length + 2) return text.slice(-maxChars)
  const preservedChars = maxChars - TRUNCATION_MARKER.length
  const headChars = Math.ceil(preservedChars * 0.6)
  const tailChars = preservedChars - headChars
  return `${text.slice(0, headChars)}${TRUNCATION_MARKER}${text.slice(-tailChars)}`
}

function truncateVisibleReference(
  mode: BoundedCompletionMode,
  text: string,
  maxChars: number,
): string {
  if (text.length <= maxChars) return text
  return mode === 'append-visible-text'
    ? `${TRUNCATION_MARKER}${text.slice(-Math.max(0, maxChars - TRUNCATION_MARKER.length))}`
    : truncateWithHeadAndTail(text, maxChars)
}

function buildStructuredReplacementPrompt(originalPrompt: string, visiblePartial: string): string {
  return `上一轮结构化输出因长度限制而中断。请重新完成任务。\n\n`
    + `【原始任务】\n${originalPrompt}\n\n`
    + `【上一轮可见的不完整输出（仅供参考，可能不完整）】\n${visiblePartial || '（没有可用输出）'}\n\n`
    + `【硬性要求】\n`
    + `- 返回完整 JSON，从头重建，不要只补后缀。\n`
    + `- 仅输出可被 JSON.parse 解析的完整 JSON；不要 Markdown、解释或思考过程。\n`
    + `- 以上一轮可见内容为参考，但以原始任务为准，补全所有必需字段和数组。`
}

function buildTextContinuationPrompt(originalPrompt: string, visibleText: string): string {
  return `上一轮文本因长度限制而中断。请继续完成原始任务。\n\n`
    + `【原始任务】\n${originalPrompt}\n\n`
    + `【已完成可见文本末尾】\n${visibleText.slice(-CONTINUATION_VISIBLE_TAIL_CHARS) || '（没有可用输出）'}\n\n`
    + `【硬性要求】\n`
    + `- 只输出新增的可见文本，不要复述、总结、解释、Markdown 或思考过程。\n`
    + `- 从已完成文本的末尾自然续写，完成原始任务。`
}

function buildContinuationPrompt(
  mode: BoundedCompletionMode,
  originalPrompt: string,
  visibleText: string,
  maxChars: number,
): string {
  const build = mode === 'replace-structured-output'
    ? buildStructuredReplacementPrompt
    : buildTextContinuationPrompt
  // The empty form includes all fixed instructions and is intentionally a
  // conservative overhead estimate because it uses the visible fallback text.
  const variableBudget = maxChars - build('', '').length
  const originalMinimum = originalPrompt ? Math.min(MIN_ORIGINAL_TASK_CHARS, originalPrompt.length) : 0
  const visibleMinimum = visibleText ? Math.min(MIN_VISIBLE_REFERENCE_CHARS, visibleText.length) : 0
  if (variableBudget < originalMinimum + visibleMinimum) {
    throw insufficientContextBudgetError()
  }

  const originalBudget = originalPrompt
    ? Math.min(originalPrompt.length, Math.max(originalMinimum, Math.floor(variableBudget * 0.6)))
    : 0
  const visibleBudget = visibleText
    ? Math.min(visibleText.length, Math.max(visibleMinimum, variableBudget - originalBudget))
    : 0

  // Reallocate unused room so a short contract never starves the visible
  // reference, and vice versa.
  let remainingBudget = variableBudget - originalBudget - visibleBudget
  const expandedOriginalBudget = Math.min(originalPrompt.length, originalBudget + remainingBudget)
  remainingBudget -= expandedOriginalBudget - originalBudget
  const expandedVisibleBudget = Math.min(visibleText.length, visibleBudget + remainingBudget)

  const prompt = build(
    truncateWithHeadAndTail(originalPrompt, expandedOriginalBudget),
    truncateVisibleReference(mode, visibleText, expandedVisibleBudget),
  )
  if (prompt.length > maxChars) throw insufficientContextBudgetError()
  return prompt
}

/**
 * Complete one LLM task through a bounded, fail-closed continuation loop.
 * A `stop` completion is the only successful terminal state. Structured
 * outputs replace a partial response, while visible prose is overlap-merged.
 */
export async function completeBoundedCompletion(request: BoundedCompletionRequest): Promise<string> {
  assertValidContinuationLimit(request.mode, request.maxContinuations)
  const redact = request.redactVisibleText ?? redactVisibleCompletionText
  const merge = request.mergeVisibleText ?? appendVisibleTextContinuation
  let content = redact(request.initial.content)
  let finishReason = request.initial.finishReason
  let continuationCount = 0

  while (finishReason !== 'stop') {
    assertNotCancelled(request.isCancelled)
    if (finishReason !== 'length') throw incompleteCompletionError(finishReason)
    if (continuationCount >= request.maxContinuations) {
      throw continuationLimitExceededError(request.maxContinuations)
    }

    const continuationPrompt = buildContinuationPrompt(
      request.mode,
      request.originalPrompt,
      content,
      continuationPromptCharBudget(request.promptBudget),
    )
    const next = await request.requestContinuation(continuationPrompt)
    assertNotCancelled(request.isCancelled)
    continuationCount += 1
    const nextVisible = redact(next.content)
    content = request.mode === 'replace-structured-output'
      ? nextVisible
      : merge(content, nextVisible)
    finishReason = next.finishReason
  }

  assertNotCancelled(request.isCancelled)
  return content
}
