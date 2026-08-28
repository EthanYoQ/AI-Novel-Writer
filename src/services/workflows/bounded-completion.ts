import type { LLMFinishReason } from '../../shared/ipc-channels'
import type { WritingLanguage } from '../../shared/writing-language'
import { promptLanguageText } from '../prompt-language'
import { stripThinkingTags } from './workflow-utils'

const CONTINUATION_VISIBLE_TAIL_CHARS = 1600
const MIN_VISIBLE_OVERLAP_CHARS = 48
const MAX_BOUNDED_CONTINUATIONS = 7
const MAX_STRUCTURED_CONTINUATIONS = 2
const MAX_TEXT_CONTINUATIONS = 3
const SAFE_UNKNOWN_CONTINUATION_PROMPT_CHARS = 5376
const CONTEXT_SAFETY_RESERVE_TOKENS = 512
const ESTIMATED_CHARS_PER_TOKEN = 1.5
const MAX_CONTINUATION_PROMPT_CHARS = 12_000
const MIN_ORIGINAL_TASK_CHARS = 256
const MIN_VISIBLE_REFERENCE_CHARS = 192
const ZH_CN_TRUNCATION_MARKER = '\n…[内容已按上下文预算截断]…\n'
const EN_US_TRUNCATION_MARKER = '\n…[content truncated to fit the context budget]…\n'
const MAX_META_OPENING_VISIBLE_UNITS = 200
const MIN_OBVIOUS_DUPLICATE_PARAGRAPH_VISIBLE_UNITS = 120

export type BoundedCompletionMode = 'append-visible-text' | 'replace-structured-output'

export interface BoundedCompletion {
  content: string
  finishReason: LLMFinishReason
}

/** A non-stop terminal model state that made a bounded completion fail closed. */
export type BoundedCompletionFailureCode = Exclude<LLMFinishReason, 'stop'>

/**
 * Carries the provider-neutral terminal reason without changing the user-safe
 * message used by commands and workflow logs.
 */
export class BoundedCompletionFailure extends Error {
  readonly failureCode: BoundedCompletionFailureCode

  constructor(failureCode: BoundedCompletionFailureCode, message: string) {
    super(message)
    this.name = 'BoundedCompletionFailure'
    this.failureCode = failureCode
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export function getBoundedCompletionFailureCode(
  error: unknown,
): BoundedCompletionFailureCode | undefined {
  return error instanceof BoundedCompletionFailure ? error.failureCode : undefined
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
  writingLanguage?: WritingLanguage
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

function visibleProseUnitCount(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0
}

function noVisibleContinuationProgressError(): Error {
  return new Error('AI 续写未增加新的可见正文，结果未被保存。请重试或缩短本次修改范围。')
}

function mechanicalCompletionError(reason: string): Error {
  return new Error(`AI 输出包含${reason}，可能仍不完整，结果未被保存。`)
}

function assertMechanicallyCompleteVisibleText(content: string): void {
  const trimmed = content.trim()
  if (visibleProseUnitCount(trimmed) === 0) throw mechanicalCompletionError('空白或无可见正文')
  if (/(?:^|\n)\s*```/u.test(trimmed)) throw mechanicalCompletionError('代码围栏')
  if (/<\/?\s*think(?:\s|>|$)/iu.test(trimmed)) throw mechanicalCompletionError('think 标签残片')

  const paragraphs = trimmed
    .split(/\n\s*\n+/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
  const opening = trimmed.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? ''
  if (
    visibleProseUnitCount(opening) <= MAX_META_OPENING_VISIBLE_UNITS
    && /^(?:(?:以下|下面)(?:是|为).{0,40}(?:修订|修改|重写|生成|完成|提供|正文|章节|内容)|(?:根据|按照)(?:您|用户).{0,40}(?:要求|指示)|这是(?:我为您|根据您的要求).{0,30}(?:修订|修改|重写|生成)|here\s+is|below\s+is|as\s+requested|certainly[,!:]?\s+(?:here\s+is|i(?:'ve|\s+have))|i\s+(?:have\s+(?:revised|rewritten|generated)|will\s+(?:provide|write|revise))\b)/iu.test(opening)
  ) {
    throw mechanicalCompletionError('首段元话术')
  }

  if (
    trimmed.includes(ZH_CN_TRUNCATION_MARKER.trim())
    || trimmed.includes(EN_US_TRUNCATION_MARKER.trim())
    || paragraphs.some(paragraph => /^(?:…\s*)?(?:\[(?:内容已按上下文预算截断|内容截断|输出被截断|content truncated to fit the context budget|truncated)\]|[（(]?(?:未完待续|未完)[）)]?)(?:\s*…)?$/iu.test(paragraph))
  ) {
    throw mechanicalCompletionError('截断标记')
  }

  const duplicateCandidateGroups = [
    paragraphs,
    trimmed.split(/\r?\n/u).map(line => line.trim()).filter(Boolean),
  ]
  for (const candidates of duplicateCandidateGroups) {
    const seenParagraphs = new Set<string>()
    for (const paragraph of candidates) {
      const normalized = paragraph.replace(/\s+/gu, ' ').trim()
      if (visibleProseUnitCount(normalized) < MIN_OBVIOUS_DUPLICATE_PARAGRAPH_VISIBLE_UNITS) continue
      if (seenParagraphs.has(normalized)) throw mechanicalCompletionError('明显重复段落')
      seenParagraphs.add(normalized)
    }
  }
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

function incompleteCompletionError(finishReason: LLMFinishReason): BoundedCompletionFailure {
  // `stop` should not reach this path, but preserve fail-closed behavior if a
  // legacy caller does invoke the public helper with it.
  const failureCode: BoundedCompletionFailureCode = finishReason === 'stop'
    ? 'unknown'
    : finishReason

  switch (finishReason) {
    case 'length':
      return new BoundedCompletionFailure(
        failureCode,
        'AI 输出达到模型最大长度，结果不完整。请提高模型最大输出 Tokens 或缩短本次任务后重试。',
      )
    case 'content_filter':
      return new BoundedCompletionFailure(failureCode, 'AI 输出因内容限制而未完成，结果未被保存。')
    case 'cancelled':
      return new BoundedCompletionFailure(failureCode, 'AI 生成已取消，结果未被保存。')
    default:
      return new BoundedCompletionFailure(failureCode, 'AI 未正常完成生成，结果未被保存。')
  }
}

export function createBoundedCompletionError(finishReason: LLMFinishReason): BoundedCompletionFailure {
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
  if (contextWindowTokens === null) {
    // Unknown means unknown: bound the continuation prompt by product policy,
    // but never invent an 8k model window and subtract the leased output cap.
    const availableChars = SAFE_UNKNOWN_CONTINUATION_PROMPT_CHARS
      - nonNegativeSafeInteger(budget?.systemPromptChars)
    if (availableChars <= 0) throw insufficientContextBudgetError()
    return Math.min(MAX_CONTINUATION_PROMPT_CHARS, availableChars)
  }
  const maxOutputTokens = positiveSafeInteger(budget?.maxOutputTokens)
  if (maxOutputTokens === null) throw insufficientContextBudgetError()
  const inputTokens = contextWindowTokens - maxOutputTokens - CONTEXT_SAFETY_RESERVE_TOKENS
  const availableChars = Math.floor(inputTokens * ESTIMATED_CHARS_PER_TOKEN)
    - nonNegativeSafeInteger(budget?.systemPromptChars)
  const boundedChars = Math.min(MAX_CONTINUATION_PROMPT_CHARS, availableChars)
  if (inputTokens <= 0 || boundedChars <= 0) throw insufficientContextBudgetError()
  return boundedChars
}

function truncationMarker(writingLanguage: WritingLanguage): string {
  return writingLanguage === 'en-US' ? EN_US_TRUNCATION_MARKER : ZH_CN_TRUNCATION_MARKER
}

function truncateWithHeadAndTail(
  text: string,
  maxChars: number,
  writingLanguage: WritingLanguage,
): string {
  if (text.length <= maxChars) return text
  const marker = truncationMarker(writingLanguage)
  if (maxChars <= marker.length + 2) return text.slice(-maxChars)
  const preservedChars = maxChars - marker.length
  const headChars = Math.ceil(preservedChars * 0.6)
  const tailChars = preservedChars - headChars
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`
}

function truncateVisibleReference(
  mode: BoundedCompletionMode,
  text: string,
  maxChars: number,
  writingLanguage: WritingLanguage,
): string {
  if (text.length <= maxChars) return text
  const marker = truncationMarker(writingLanguage)
  return mode === 'append-visible-text'
    ? `${marker}${text.slice(-Math.max(0, maxChars - marker.length))}`
    : truncateWithHeadAndTail(text, maxChars, writingLanguage)
}

function buildStructuredReplacementPrompt(
  originalPrompt: string,
  visiblePartial: string,
  writingLanguage: WritingLanguage,
): string {
  return promptLanguageText(
    writingLanguage,
    `上一轮结构化输出因长度限制而中断。请重新完成任务。\n\n`
      + `【原始任务】\n${originalPrompt}\n\n`
      + `【上一轮可见的不完整输出（仅供参考，可能不完整）】\n${visiblePartial || '（没有可用输出）'}\n\n`
      + `【硬性要求】\n`
      + `- 返回完整 JSON，从头重建，不要只补后缀。\n`
      + `- 仅输出可被 JSON.parse 解析的完整 JSON；不要 Markdown、解释或思考过程。\n`
      + `- 以上一轮可见内容为参考，但以原始任务为准，补全所有必需字段和数组。`,
    `The previous structured output stopped at the length limit. Complete the task again.\n\n`
      + `[Original task]\n${originalPrompt}\n\n`
      + `[Visible incomplete output from the previous attempt — reference only]\n${visiblePartial || '(no visible output)'}\n\n`
      + `[Requirements]\n`
      + `- Rebuild and return the complete JSON from the beginning; do not return only a suffix.\n`
      + `- Output only complete JSON accepted by JSON.parse, with no Markdown, explanation, or reasoning.\n`
      + `- Use the visible prior output only as evidence; the original task remains authoritative, and every required field and array must be complete.`,
  )
}

function buildTextContinuationPrompt(
  originalPrompt: string,
  visibleText: string,
  writingLanguage: WritingLanguage,
): string {
  const visibleTail = visibleText.slice(-CONTINUATION_VISIBLE_TAIL_CHARS)
  return promptLanguageText(
    writingLanguage,
    `上一轮文本因长度限制而中断。请继续完成原始任务。\n\n`
      + `【原始任务】\n${originalPrompt}\n\n`
      + `【已完成可见文本末尾】\n${visibleTail || '（没有可用输出）'}\n\n`
      + `【硬性要求】\n`
      + `- 只输出新增的可见文本，不要复述、总结、解释、Markdown 或思考过程。\n`
      + `- 从已完成文本的末尾自然续写，完成原始任务。`,
    `The previous text stopped at the length limit. Continue and complete the original task.\n\n`
      + `[Original task]\n${originalPrompt}\n\n`
      + `[End of the completed visible text]\n${visibleTail || '(no visible output)'}\n\n`
      + `[Requirements]\n`
      + `- Output only new visible prose. Do not repeat, summarize, explain, use Markdown, or reveal reasoning.\n`
      + `- Continue naturally from the end of the completed text and finish the original task.`,
  )
}

function buildContinuationPrompt(
  mode: BoundedCompletionMode,
  originalPrompt: string,
  visibleText: string,
  maxChars: number,
  writingLanguage: WritingLanguage,
): string {
  const build = (original: string, visible: string) => mode === 'replace-structured-output'
    ? buildStructuredReplacementPrompt(original, visible, writingLanguage)
    : buildTextContinuationPrompt(original, visible, writingLanguage)
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
    truncateWithHeadAndTail(originalPrompt, expandedOriginalBudget, writingLanguage),
    truncateVisibleReference(mode, visibleText, expandedVisibleBudget, writingLanguage),
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
      request.writingLanguage ?? 'zh-CN',
    )
    const next = await request.requestContinuation(continuationPrompt)
    assertNotCancelled(request.isCancelled)
    continuationCount += 1
    const nextVisible = redact(next.content)
    if (request.mode === 'replace-structured-output') {
      content = nextVisible
    } else {
      const merged = merge(content, nextVisible)
      if (visibleProseUnitCount(merged) <= visibleProseUnitCount(content)) {
        throw noVisibleContinuationProgressError()
      }
      content = merged
    }
    finishReason = next.finishReason
  }

  assertNotCancelled(request.isCancelled)
  if (request.mode === 'append-visible-text') assertMechanicallyCompleteVisibleText(content)
  return content
}
