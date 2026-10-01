import { sanitizeDraftText, composeDraftVisibleContinuation, DRAFT_CONDENSE_PURPOSE, DRAFT_VISIBLE_TEXT_VERSION } from '../../../shared/draft-visible-text'
import { DRAFT_RECONCILE_PURPOSE, draftReconciliationBlock } from '../../../shared/draft-reconciliation'
export { sanitizeDraftText } from '../../../shared/draft-visible-text'
import { createWorkflowMainGenerationRuntime, type WorkflowMainGenerationRequest } from '../workflow-main-generation'
import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import { formatResourceUri } from '../../../shared/project-paths'
import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type LLMCompletion,
} from './base-command'
import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import { hashAuthorText } from '../../../shared/source-ref'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import {
  DIR_PROMPTS
} from '../../../shared/project-paths'
import type { ChapterInfo } from '../chapter-workflow'
import { normalizeChapterWordsTarget } from '../chapter-creation-parameters'
import {
  type CreateGenerationRuntimeOptions,
  type GenerationRuntime,
} from '../../generation/generation-runtime'
import type {
  GenerationAttemptReceipt,
  GenerationOutcome,
  GenerationSession,
} from '../../generation/generation-harness'
import type { WritingLanguage } from '../../../shared/writing-language'
import type { FinalizedContinuityProjection } from '../../../shared/finalized-continuity'
import type { NarrativeThreadView } from '../../../shared/narrative-thread'
import { promptLanguageText } from '../../prompt-language'
import { countDraftUnits, draftTargetUnitRange } from '../../../shared/draft-units'
import type { RecoveryChapterSource } from '../../../shared/recovery-candidate'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../../shared/character-roster'
import {
  assembleChapterMaterials,
  ChapterMaterialCapacityError,
  type ChapterMaterialAssembly,
  type ChapterMaterialReference,
  type FinalizedMaterialSource,
  type SelectedCandidateDraft,
} from '../chapter-materials'
import type { DraftSourceDependency } from '../../../shared/draft-source-dependency'

export { countDraftUnits } from '../../../shared/draft-units'
export { previousChapterEnding } from '../chapter-materials'

const CONTINUE_PROMPT_MAX_CHARS = 1600
const MAX_AUTO_CONTINUE_ROUNDS = 7
const NEXT_CHAPTER_HEAD_MAX_CHARS = 1200
const CROSS_CHAPTER_REUSE_CJK_NGRAM_CHARS = 8
const CROSS_CHAPTER_REUSE_ENGLISH_NGRAM_CHARS = 20
const CROSS_CHAPTER_REUSE_LONG_RUN_CHARS = 80
const ACTIVE_THREAD_CONTEXT_MAX_CHARS = 1200
const ACTIVE_THREAD_CONTEXT_MAX_ITEMS = 6
const STREAM_PREVIEW_INTERVAL_MS = 250

type ChapterHeading = Readonly<{
  lineIndex: number
  from: number
  to: number
  markdownLevel: number
}>

function parseChapterHeading(line: string, lineIndex: number): ChapterHeading | null {
  const match = /^\s*(?:(#{1,6})[\t ]+)?(?:第\s*([1-9]\d*)(?:\s*[–—-]\s*([1-9]\d*))?\s*章|Chapters?[\t ]+([1-9]\d*)(?:[\t ]*[–—-][\t ]*([1-9]\d*))?)(?=[\t ]*(?:[:：.．—-]|$))/iu.exec(line)
  if (!match) return null
  // Bare headings must use the production outline's explicit title separator.
  if (!match[1] && !/^[\t ]*[:：]\s*\S/u.test(line.slice(match[0].length))) return null
  const from = Number(match[2] ?? match[4])
  const to = Number(match[3] ?? match[5] ?? from)
  return {
    lineIndex,
    from,
    to,
    markdownLevel: match[1]?.length ?? 0,
  }
}

/**
 * Project an explicitly chapter-structured synopsis onto one chapter without
 * cutting any selected section. Ambiguous or unlocatable structures stay
 * verbatim so author facts are never discarded on a guess.
 */
export function synopsisForDraftChapter(synopsis: string, chapterNumber: number): string {
  // Quoted examples can contain chapter-like headings; do not interpret them.
  if (/^\s*(?:`{3,}|~{3,})/mu.test(synopsis)) return synopsis.trim()
  const lines = synopsis.trim().split(/\r?\n/u)
  const headings = lines
    .map((line, lineIndex) => parseChapterHeading(line, lineIndex))
    .filter((heading): heading is ChapterHeading => heading !== null)
  if (headings.length < 2) return synopsis.trim()

  const firstLevel = headings[0]!.markdownLevel
  const hasConsistentHeadingStyle = headings.every(heading => heading.markdownLevel === firstLevel)
  const hasStrictChapterOrder = headings.every((heading, index) => (
    heading.from <= heading.to
    && (index === 0 || heading.from > headings[index - 1]!.to)
  ))
  const currentHeadings = headings.filter(heading => heading.from <= chapterNumber && chapterNumber <= heading.to)
  if (!hasConsistentHeadingStyle || !hasStrictChapterOrder || currentHeadings.length !== 1) {
    return synopsis.trim()
  }

  const headingsByLine = new Map(headings.map(heading => [heading.lineIndex, heading]))
  let activeRange: Pick<ChapterHeading, 'from' | 'to'> | null = null
  const projected: string[] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!
    const chapterHeading = headingsByLine.get(lineIndex)
    if (chapterHeading) {
      activeRange = chapterHeading
    } else {
      const markdownHeading = /^\s*(#{1,6})\s+/u.exec(line)
      if (markdownHeading && (firstLevel === 0 || markdownHeading[1]!.length <= firstLevel)) {
        activeRange = null
      }
    }
    if (
      activeRange === null
      || (activeRange.from <= chapterNumber && chapterNumber <= activeRange.to)
    ) projected.push(line)
  }
  return projected.join('\n').trim()
}

function exactParagraphs(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.flatMap(value => (
    value.split(/\r?\n\s*\r?\n/u).map(paragraph => paragraph.trim()).filter(Boolean)
  )))
}

function withoutExactParagraphDuplicates(content: string, duplicates: ReadonlySet<string>): string {
  return content
    .split(/\r?\n\s*\r?\n/u)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph && !duplicates.has(paragraph))
    .join('\n\n')
}


const THINKING_TAGS = ['<think>', '</think>'] as const

/**
 * Convert the cumulative raw stream into safe provisional prose. A suffix that
 * could still become a thinking tag is withheld so split tags never flash in
 * the writing panel before the next chunk arrives.
 */
export function visibleDraftStreamText(rawText: string): string {
  const lower = rawText.toLowerCase()
  let safeEnd = rawText.length
  const longestTag = Math.max(...THINKING_TAGS.map(tag => tag.length))
  for (let length = 1; length < longestTag && length <= rawText.length; length += 1) {
    const suffix = lower.slice(-length)
    if (THINKING_TAGS.some(tag => tag.startsWith(suffix))) {
      safeEnd = rawText.length - length
    }
  }
  return sanitizeDraftText(rawText.slice(0, safeEnd))
}

function createDraftStreamPreview(
  replaceText: ((text: string) => void) | undefined,
  composeVisibleText: (rawText: string) => string,
  initialRenderedText = '',
): { push(chunk: string): void; snapshot(): string; stop(): void } {
  let active = true
  let rawText = ''
  let renderedText = initialRenderedText
  let lastRenderedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const render = () => {
    timer = undefined
    if (!active || !replaceText) return
    const nextText = composeVisibleText(rawText)
    if (nextText === renderedText) return
    renderedText = nextText
    lastRenderedAt = Date.now()
    replaceText(nextText)
  }

  return {
    push(chunk) {
      if (!active) return
      rawText += chunk
      if (!replaceText || timer) return
      if (lastRenderedAt === 0) {
        render()
        return
      }
      const delay = Math.max(0, STREAM_PREVIEW_INTERVAL_MS - (Date.now() - lastRenderedAt))
      timer = setTimeout(render, delay)
    },
    snapshot() {
      return composeVisibleText(rawText)
    },
    stop() {
      active = false
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

export const DRAFT_GENERATION_BUDGET = Object.freeze({
  maxAttempts: 8,
  maxRequestedOutputTokens: 32_768,
  maxRequestedOutputTokensPerAttempt: 8192,
  deadlineMs: 20 * 60_000,
})

export interface GenerateDraftCommandDependencies {
  createRuntime(options: CreateGenerationRuntimeOptions, mainRequest?: WorkflowMainGenerationRequest): Promise<GenerationRuntime>
}

export interface GenerateDraftCommandOptions {
  /** Exact saved draft versions selected by this batch; never inferred as finalized history. */
  readonly selectedCandidateDrafts?: readonly SelectedCandidateDraft[]
  readonly resumeHandle?: MainGenerationRunHandle
  readonly batchId?: string
  readonly dependencies?: Partial<GenerateDraftCommandDependencies>
}

const DEFAULT_DEPENDENCIES: GenerateDraftCommandDependencies = {
  createRuntime: (_options, mainRequest) => {
    if (!mainRequest) throw new Error('DRAFT_MAIN_GENERATION_REQUEST_REQUIRED')
    return createWorkflowMainGenerationRuntime(mainRequest)
  },
}

type WriterChapterInfo = Pick<ChapterInfo,
  | 'chapterNumber'
  | 'title'
  | 'role'
  | 'purpose'
  | 'characters'
  | 'keyEvents'
  | 'suspenseHook'
  | 'userGuidance'
>

/** Keep workflow metadata out of both initial and continuation writer prompts. */
function toWriterChapterInfo(chapterInfo: ChapterInfo): WriterChapterInfo {
  return {
    chapterNumber: chapterInfo.chapterNumber,
    title: chapterInfo.title,
    role: chapterInfo.role,
    purpose: chapterInfo.purpose,
    characters: chapterInfo.characters,
    keyEvents: chapterInfo.keyEvents,
    suspenseHook: chapterInfo.suspenseHook,
    userGuidance: chapterInfo.userGuidance,
  }
}

function hasSubstantialPreviousChapterReuse(
  previousEnding: string,
  draft: string,
  writingLanguage: WritingLanguage,
): boolean {
  const ngramCharacters = writingLanguage === 'en-US'
    ? CROSS_CHAPTER_REUSE_ENGLISH_NGRAM_CHARS
    : CROSS_CHAPTER_REUSE_CJK_NGRAM_CHARS
  const normalize = (text: string) => text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
  const previous = normalize(previousEnding)
  const nextHead = normalize(draft.slice(0, NEXT_CHAPTER_HEAD_MAX_CHARS))
  if (previous.length < ngramCharacters || nextHead.length < ngramCharacters) {
    return false
  }

  const previousNgrams = new Set<string>()
  for (let index = 0; index <= previous.length - ngramCharacters; index += 1) {
    previousNgrams.add(previous.slice(index, index + ngramCharacters))
  }

  const covered = new Uint8Array(nextHead.length)
  for (let index = 0; index <= nextHead.length - ngramCharacters; index += 1) {
    if (!previousNgrams.has(nextHead.slice(index, index + ngramCharacters))) continue
    for (let offset = index; offset < index + ngramCharacters; offset += 1) {
      covered[offset] = 1
    }
  }

  let runLength = 0
  for (let index = 0; index <= covered.length; index += 1) {
    if (covered[index]) {
      runLength += 1
      continue
    }
    if (runLength >= CROSS_CHAPTER_REUSE_LONG_RUN_CHARS) return true
    runLength = 0
  }
  return false
}

function observeWorkflowCancellation(context: CommandExecuteParams['context']): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const timer = setInterval(() => {
    if (context.cancelled) controller.abort()
  }, 25)
  if (context.cancelled) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => clearInterval(timer),
  }
}

function logDraftAttempt(
  callbacks: CommandExecuteParams['callbacks'],
  context: CommandExecuteParams['context'],
  phase: { zhCN: string; enUS: string },
  receipt: GenerationAttemptReceipt,
): void {
  callbacks.log(workflowUiText(
    context,
    `  ${phase.zhCN}：租约请求上限 ${receipt.budget.requestedOutputTokens} Tokens` +
      `（单次上限 ${receipt.budget.maxRequestedOutputTokensPerAttempt}，` +
      `累计 ${receipt.budget.cumulativeRequestedOutputTokens}/${receipt.budget.maxRequestedOutputTokens}）`,
    `  ${phase.enUS}: lease request limit ${receipt.budget.requestedOutputTokens} tokens ` +
      `(per-attempt limit ${receipt.budget.maxRequestedOutputTokensPerAttempt}, ` +
      `cumulative ${receipt.budget.cumulativeRequestedOutputTokens}/${receipt.budget.maxRequestedOutputTokens})`,
  ))
}

function completionFromOutcome(outcome: GenerationOutcome): LLMCompletion {
  return { content: outcome.content, finishReason: outcome.finishReason, receipt: outcome.receipt }
}

function workflowGenerationModelId(context: CommandExecuteParams['context']): string | undefined {
  return context.generationModelId?.trim() || undefined
}

function recoveryFailureCode(error: unknown, cancelled: boolean): string {
  if (cancelled) return 'CANCELLED'
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 160)
  }
  return 'GENERATION_FAILED'
}

function draftLengthOutOfRangeError(): Error & { code: string } {
  return Object.assign(new Error('GENERATION_DRAFT_LENGTH_OUT_OF_RANGE'), {
    code: 'GENERATION_DRAFT_LENGTH_OUT_OF_RANGE',
  })
}

function draftTooShortError(
  context: CommandExecuteParams['context'],
  units: number,
  targetUnits: number,
): Error {
  return new Error(workflowUiText(
    context,
    `模型已声明生成结束，但正文仅约 ${units}/${targetUnits} 字，明显未达到章节目标，结果未保存。` +
      '请提高最大输出 Tokens、降低本章目标字数，或改用输出能力更强的模型后重试。',
    `The model reported completion, but the draft is only about ${units}/${targetUnits} units and clearly misses the chapter target, so it was not saved. ` +
      'Increase the maximum output tokens, lower the chapter target, or use a model with greater output capacity and try again.',
  ))
}

/**
 * 本章篇幅合同：门禁仍是 draftTargetUnitRange（±30%）；这里只向模型给出更紧的写作目标，
 * 并明确上限是会被退回的硬上限。初始生成、自动续写与压缩修订共用同一措辞。
 */
function chapterLengthContractText(writingLanguage: WritingLanguage, targetUnits: number): string {
  const { minimum, maximum } = draftTargetUnitRange(targetUnits)
  const aimLow = Math.round(targetUnits * 0.85)
  return promptLanguageText(
    writingLanguage,
    `【本章篇幅合同】\n目标 ${targetUnits} 字（按汉字计，不含标点）；请写到约 ${aimLow}–${targetUnits} 字。${maximum} 字是硬上限，超过即被退回；少于 ${minimum} 字同样会被退回。篇幅紧张时，压缩描写与过渡、减少场景数量，而不是删掉必需事件；本章蓝图中的全部作者任务和必需事件都要落实，不得删除、改写或截断，也不要为凑字数增加无关内容。`,
    `[Chapter length contract]\nTarget: ${targetUnits} words (counted as words, excluding punctuation); aim for about ${aimLow}-${targetUnits} words. ${maximum} words is a hard ceiling: drafts beyond it are rejected, and drafts under ${minimum} words are rejected too. When space is tight, compress description and transitions and use fewer scenes rather than dropping required events; realize every author task and required event in the chapter blueprint without deleting, rewriting, or truncating them, and do not add unrelated content to fill space.`,
  )
}

/**
 * 固定解释规则与作者原文分开角色；规则仅按写作语言和是否有前驱分支。
 * 首稿、续写、压缩和历史恢复共用规则，但不扩大各次请求的操作范围。
 */
function chapterExecutionContractText(writingLanguage: WritingLanguage, chapterInfo: WriterChapterInfo): {
  rules: string
  authorItems: string
} {
  const executionItems = [
    { zhCN: '必需事件', enUS: 'Required events', value: chapterInfo.keyEvents },
    { zhCN: '章节钩子', enUS: 'Chapter hook', value: chapterInfo.suspenseHook },
    { zhCN: '作者本章指导', enUS: 'Author guidance for this chapter', value: chapterInfo.userGuidance },
  ]
  const zhItems = executionItems.flatMap(item => item.value?.trim() ? [`- ${item.zhCN}: ${item.value}`] : []).join('\n')
  const enItems = executionItems.flatMap(item => item.value?.trim() ? [`- ${item.enUS}: ${item.value}`] : []).join('\n')
  const hasPredecessor = chapterInfo.chapterNumber > 1
  const rules = promptLanguageText(
    writingLanguage,
    `【本章执行合同】
【作者本章任务】按作者原文含义遵循：明确要求在本章发生的事件与收束须由正文动作或结果落实；持续状态、知情边界、禁止事项和文风要求是叙述约束，不要仅为证明遵守而新增或反复确认动作、对话或解释。悬念按原文揭示时点处理，留待后文的事不得提前写成已完成；作者明确要求的回顾、回忆、动作、揭示或反复仍按原文执行。后一项动作必须承接正文实际形成的物品持有、人物知情和计划完成状态。
【本章可推进的事件】可以写与既有事实相容的新行动和结果；普通无代价情节无需增加代价。${hasPredecessor ? `
【前文已定稿事实】本章蓝图、章节计划或必需事件的措辞与已定稿章节中确立的事实（包括作者在定稿中的最新更正）冲突时，以定稿事实为准：按与定稿事实一致的方式落实该条目，不得把已撤回、取消或被取代的计划追溯写成已执行。人物身份、物品持有、人物知情、付款与收回及事件时点应承接前文；付款、收回、失去等状态改变必须按事件先后写清，不能把同一笔钱款或物品同时写成已收回与仍然失去。
【前文计划与本章决定】人物的等待、暂停或撤回是当时的计划状态，不是作者禁令；本章可以先写出人物基于既有事实作出的新决定、理由及连续性依据，再推进或替换计划，但不能违反作者明确禁令、必需呈现或既成事实。
【本章事件兑现】作者或本章蓝图要求在本章发生的事件，必须在本章通过具体行动及其实际后果发生；复述、确认或记账前章已发生的结果不能替代本章要求发生的动作或结果。
【前文待核实问题】定稿只发现疑点、提出猜测或写明待核实时，不能把某一解释、原因或哪一方出错写成已确认事实；本章可以通过新线索和调查推进并解决疑点，但须先写出与既有事实相容且足以支持结论的核验过程与证据，证据不足时保留疑点，结论的方向、时间和因果前后必须一致。
【时间承接】本章紧接上一章结尾：作者没有写明跨日或时间间隔时，视为同一天内的紧接发展，上一章事件就发生在不久之前，不得写成“昨天”“昨夜”“前一天”。已定稿事件的时点以定稿原文和【本章写作方向】里的时点说明为准，本章提到这些事件时须按该时点换算（例如定稿写“黄昏”、本章时点为“同日深夜”，则那些事件发生在“黄昏时”“傍晚那会儿”；定稿写“傍晚”、本章时点为“次日上午”，则写“昨晚”“昨天傍晚”）。` : ''}
【操作边界】本合同不扩大本次请求的操作范围：续写及无进展恢复只接续已有正文，不重写旧文；已达目标篇幅时只补完断句并收束。压缩只删减既有正文，不新增情节或修补缺失事件。`,
    `[Current-chapter execution contract]
[Author tasks for this chapter] Follow the author text according to its meaning: events and outcomes explicitly required in this chapter must be realized through manuscript action or outcome. Ongoing states, knowledge boundaries, prohibitions, and style requests are narrative constraints; do not add or repeatedly confirm actions, dialogue, or explanations merely to prove compliance. Follow the reveal timing specified by the author; do not present what is reserved for later chapters as already completed. Still carry out explicitly requested recollections, flashbacks, actions, reveals, or repetition. Each later action must continue from the item ownership, character knowledge, and plan-completion state actually established in the prose.
[Events this chapter may advance] New actions and outcomes consistent with established facts are allowed. Ordinary events need no added cost.${hasPredecessor ? `
[Established finalized facts] When the chapter blueprint, chapter plans, or the wording of required events conflict with facts established in finalized chapters (including the author's latest corrections in them), the finalized facts prevail: realize the item consistently and never retroactively portray a withdrawn, cancelled, or superseded plan as executed. Preserve identities, item ownership, character knowledge, payments and recoveries, and event times from prior prose. Keep the order and result of paying, recovering, or losing money or property consistent; do not describe the same amount or item as both recovered and still lost.
[Prior plans and current decisions] Characters' waiting, paused, or withdrawn plans describe their prior intention, not an author prohibition; this chapter may first show a new decision grounded in established facts, the character's reason, and continuity evidence, then advance or replace the plan without violating explicit author prohibitions, required on-page events, or completed facts.
[Required events in this chapter] Events required by the author or this chapter blueprint to happen in this chapter must happen through concrete action and actual consequence here; merely repeating, confirming, or accounting for an outcome already completed in an earlier chapter cannot replace the action or outcome required in this chapter.
[Unverified prior questions] If a finalized chapter only discovers a discrepancy, raises a suspicion, or leaves a question for verification, do not present an explanation, cause, or which side is wrong as confirmed. This chapter may pursue new clues and resolve the question, but first show a verification process and evidence sufficient for a conclusion consistent with established facts; otherwise keep it unresolved. The conclusion's direction, timing, and causality must remain consistent throughout.
[Time continuity] This chapter follows directly on the previous chapter's ending: when the author states no day change or time gap, treat it as a continuation within the same day; events of the previous chapter happened a little while ago and must not be written as "yesterday", "last night", or "the day before". The time of finalized events is fixed by the finalized text and by the time stated in [Chapter brief]; when this chapter mentions those events, convert their time accordingly (for example, if the finalized text says "dusk" and this chapter is "late the same night", those events happened "at dusk" or "earlier this evening"; if it says "evening" and this chapter is "the next morning", write "last night" or "yesterday evening").` : ''}
[Operation boundary] This contract does not expand the current request's scope: continuation and no-progress recovery only append to existing prose without rewriting it; at the target length, only finish the truncated sentence and close. Condensing only cuts existing prose and must not add plot or repair missing events.`,
  )
  return { rules, authorItems: promptLanguageText(writingLanguage, zhItems, enItems) }
}

/** 自动续写与压缩修订共用的作者资料块：本章蓝图、全局写作要求、文风、小说配置事实与章节材料。 */
function draftAuthorMaterialBlock(writingLanguage: WritingLanguage, material: {
  chapterInfo: WriterChapterInfo
  globalGuidance: string
  writingStyle: string
  novelConfigFacts: string
  chapterMaterials: string
  /** 生成前定稿对账注入块；无对账时为空。 */
  reconciliation?: string
}): string {
  const reconciliation = material.reconciliation ? `${material.reconciliation}\n\n` : ''
  return promptLanguageText(
    writingLanguage,
    `【本章蓝图】
${JSON.stringify(material.chapterInfo, null, 2)}

【全局写作要求】
${material.globalGuidance}

【文风要求】
${material.writingStyle || '（无）'}

【文风适用边界】
- 文风仅用于选择表达方式，不是新增事实或事件要求；无需逐条强行兑现。
- 作者明确事实与指导、实际前文、本章关键因果和本章篇幅优先。不得用文风改写这些内容或仅为兑现文风增加场景、动作或事件；不得把作者明确事实或要求降格为推测。

【小说配置事实】
${material.novelConfigFacts}

${material.chapterMaterials}

${reconciliation}${chapterExecutionContractText(writingLanguage, material.chapterInfo).authorItems}`,
    `[Current chapter blueprint]
${JSON.stringify(material.chapterInfo, null, 2)}

[Project-wide writing guidance]
${material.globalGuidance}

[Writing style]
${material.writingStyle || '(none)'}

[Writing-style applicability]
- Writing style selects expression only; it adds no facts or events, and not every item must be forced into the manuscript.
- Explicit author facts and guidance, actual prior prose, the chapter's key causality, and its target length take priority. Do not use style guidance to rewrite them, relabel explicit author facts or requirements as guesses, or add scenes, actions, or events merely to satisfy style guidance.

[Novel configuration facts]
${material.novelConfigFacts}

${material.chapterMaterials}

${reconciliation}${chapterExecutionContractText(writingLanguage, material.chapterInfo).authorItems}`,
  )
}

function recoveryChapterSource(chapter: ChapterInfo): RecoveryChapterSource {
  return {
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    role: chapter.role,
    purpose: chapter.purpose,
    keyEvents: chapter.keyEvents,
    characters: [...chapter.characters],
    suspenseHook: chapter.suspenseHook ?? '',
    userGuidance: chapter.userGuidance ?? '',
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Join a visible continuation without allowing a repeated prompt tail to count as new prose. */
export function appendVisibleDraftContinuation(draft: string, continuation: string): string {
  return composeDraftVisibleContinuation(draft, continuation)
}

export class GenerateDraftCommand extends BaseWorkflowCommand {
  private readonly dependencies: GenerateDraftCommandDependencies
  private readonly selectedCandidateDrafts: readonly SelectedCandidateDraft[]
  private readonly resumeHandle?: MainGenerationRunHandle
  private readonly batchId?: string

  constructor(
    private chapterInfo: ChapterInfo,
    options: GenerateDraftCommandOptions = {},
  ) {
    super()
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
    this.resumeHandle = options.resumeHandle ? Object.freeze({ ...options.resumeHandle }) : undefined
    this.batchId = options.batchId
    this.selectedCandidateDrafts = Object.freeze([...(options.selectedCandidateDrafts ?? [])])
  }

  async execute({ step, context, callbacks }: CommandExecuteParams): Promise<string> {
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const expectedProjectPath = this.chapterInfo.projectPath
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) {
      throw new Error(uiText(
        '当前项目已切换，章节生成已停止',
        'The project changed, so chapter generation was stopped.',
      ))
    }
    const novelConfig = Object.freeze({ ...project.novelConfig })
    const writingLanguage = workflowWritingLanguage(context)
    const defaultMain = this.dependencies.createRuntime === DEFAULT_DEPENDENCIES.createRuntime
    const isFirstChapter = this.chapterInfo.chapterNumber === 1
    const templateKey = isFirstChapter ? 'first_chapter_draft' : 'next_chapter_draft'
    const writerChapterInfo = toWriterChapterInfo(this.chapterInfo)
    const targetChars = normalizeChapterWordsTarget(this.chapterInfo.wordsTarget, novelConfig.wordsPerChapter)
    const knowledgeQueryHint = this.chapterInfo.knowledgeQueryHint?.trim() ?? ''
    const searchQuery = [knowledgeQueryHint, this.chapterInfo.title, this.chapterInfo.keyEvents,
      this.chapterInfo.characters.join(' ')].filter(Boolean).join(' ')
    const authorInputs = [{ id: 'draft:chapter-info', text: JSON.stringify(writerChapterInfo) },
      { id: 'draft:author-config', text: JSON.stringify(novelConfig) },
      { id: 'draft:target-units', text: String(targetChars) }]
    const earlyRecovery = defaultMain && this.resumeHandle
      ? await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle: this.resumeHandle }) : null
    if (earlyRecovery?.savedDraft) {
      const saved = earlyRecovery.savedDraft
      if (earlyRecovery.operation !== 'chapter-draft' || earlyRecovery.chapterNumber !== this.chapterInfo.chapterNumber
        || saved.contentHash !== await sha256Hex(saved.content)) throw new Error('GENERATION_DRAFT_RECOVERY_SCOPE_INVALID')
      this.assertNotCancelled(context)
      context.mainGenerationRunHandle = this.resumeHandle
      return this.publishSavedDraft({ context, callbacks, projectSession, expectedProjectPath,
        cleanDraftText: saved.content, id: saved.id, nextVersion: saved.version, mergedGuidance: '' })
    }
    if (defaultMain) context.generationModelId = workflowGenerationModelId(context) || useLLMStore.getState().defaultModelId || undefined
    const prepared = defaultMain && !this.resumeHandle
      ? await ipc.invokeWithProjectSession(projectSession, 'generation:prepare-draft-context', {
        chapterNumber: this.chapterInfo.chapterNumber, modelId: context.generationModelId!,
        promptKeys: [templateKey], skillStages: ['drafting'], authorInputs, query: searchQuery,
        selectedDraftIds: [...new Set(this.selectedCandidateDrafts.filter(item => item.chapterNumber < this.chapterInfo.chapterNumber).map(item => item.draftId))],
        ...(this.batchId ? { batchId: this.batchId } : {}),
      }) : null
    const knowledgeSnapshot = prepared?.knowledgeSnapshot ?? earlyRecovery?.knowledgeSnapshot
    // Recovery uses the original main snapshot, including retrieval hints outside the writer prompt.
    if (defaultMain && (!knowledgeSnapshot || prepared && knowledgeSnapshot.query !== searchQuery))
      throw new Error('GENERATION_DRAFT_KNOWLEDGE_SNAPSHOT_REQUIRED')
    const sourceDraft = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-latest',
      this.chapterInfo.chapterNumber,
      expectedProjectPath,
    )

    callbacks.log(uiText(
      '拼装章节上下文 (强类型注入中)...',
      'Building chapter context...',
    ))

    const { coreOutline, worldSetting, goldenFinger, protagonistProfile } = novelConfig
    const authoredConfigFacts = [coreOutline, worldSetting, goldenFinger, protagonistProfile]
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    const architecture = await this.readArchitecture(
      expectedProjectPath,
      projectSession,
      this.chapterInfo.chapterNumber,
      authoredConfigFacts,
    )
    const projectPrompts = await this.readProjectPrompts(
      expectedProjectPath,
      projectSession,
      writingLanguage,
    )
    const mergedGuidance = [
      novelConfig.globalGuidance?.trim() || '',
      projectPrompts,
    ].filter(Boolean).join('\n\n')

    const characterProfiles = await this.readCharacterProfiles(
      expectedProjectPath,
      projectSession,
      writingLanguage,
      this.chapterInfo.characters,
    )
    let futureBlueprintsStr = promptLanguageText(
      writingLanguage,
      '（无后续蓝图）',
      '(no future chapter blueprints)',
    )
    try {
      const { loadDirectoryBlueprints } = await import('../directory-workflow')
      const allBlueprints = await loadDirectoryBlueprints(expectedProjectPath, projectSession)
      const futureBlueprintsArr = allBlueprints.filter(
        b => b.chapterNumber > this.chapterInfo.chapterNumber && b.chapterNumber <= this.chapterInfo.chapterNumber + 5
      )
      if (futureBlueprintsArr.length > 0) {
        futureBlueprintsStr = futureBlueprintsArr.map(b => promptLanguageText(
          writingLanguage,
          `第${b.chapterNumber}章 ${b.title}：${b.keyEvents}`,
          `Chapter ${b.chapterNumber}: ${b.title} — ${b.keyEvents}`,
        )).join('\n')
      }
    } catch { /* 忽略 */ }

    const template = await resolvePromptTemplate(templateKey, projectSession, writingLanguage)
    if (!template) throw new Error(uiText(
      `未找到模板: ${templateKey}`,
      `Template not found: ${templateKey}`,
    ))

    // ==========================================
    // Prompt 构建——按「稳定前缀 → 可变后缀」排列
    // 以最大化 LLM 上下文缓存命中率
    // ==========================================
    const writingStyle = novelConfig.writingStyle?.trim() || ''
    const promptOnlyConfigKeys = new Set([
      'globalGuidance',
      'writingStyle',
      'coreOutline',
      'worldSetting',
      'goldenFinger',
      'protagonistProfile',
    ])
    const novelConfigFacts = Object.fromEntries(
      Object.entries(novelConfig).filter(([key]) => !promptOnlyConfigKeys.has(key)),
    )
    const novelConfigFactsJson = JSON.stringify(novelConfigFacts, null, 2)
    let knowledgeReferences: ChapterMaterialReference[] = []
    try {
      callbacks.log(uiText(
        '  检索知识库相关片段...',
        '  Searching the knowledge base for relevant passages...',
      ))
      if (knowledgeQueryHint) {
        callbacks.log(uiText(
          `  追加用户检索关键词：${knowledgeQueryHint}`,
          `  Added author search keywords: ${knowledgeQueryHint}`,
        ))
      }
      const results = defaultMain ? knowledgeSnapshot!.items : unwrapKnowledgeValue(await ipc.invokeWithProjectSession(
        projectSession,
        'kb:search-writing-context',
        searchQuery,
        5,
        expectedProjectPath,
      ))
      if (results.length > 0) {
        knowledgeReferences = results.map((result: { fileName: string; score: number; text: string }, index: number) => ({
          text: result.text,
          rendered: promptLanguageText(
            writingLanguage,
            `[${index + 1}] (${result.fileName}, 相关度 ${(result.score * 100).toFixed(0)}%)\n${result.text}`,
            `[${index + 1}] (${result.fileName}, relevance ${(result.score * 100).toFixed(0)}%)\n${result.text}`,
          ),
          deduplicateAgainstFinalized: true,
        }))
      } else {
        const emptyContext = promptLanguageText(writingLanguage, '（知识库中无相关内容）', '(no relevant knowledge-base context)')
        knowledgeReferences = [{ text: emptyContext, rendered: emptyContext }]
      }
    } catch {
      const unavailableContext = promptLanguageText(writingLanguage, '（知识库检索不可用）', '(knowledge-base search unavailable)')
      knowledgeReferences = [{ text: unavailableContext, rendered: unavailableContext }]
    }
    const chapterLengthContract = chapterLengthContractText(writingLanguage, targetChars)
    const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
      // ---- 缓存命中区（跨章稳定，前缀对齐）----
      .withArchitecture(architecture)
      .withGlobalGuidance(mergedGuidance)
      .withWritingStyle(writingStyle)
      .withNovelConfig(novelConfigFactsJson)
      .withWordNumber(targetChars)
      // ---- 章节公共区（首章与后续章都必须完整注入）----
      .withChapterInfo(writerChapterInfo)
      .withCharacterStates('')
      .withFutureBlueprints('')
      .withFilteredContext('')
      .withUserGuidance(this.chapterInfo.userGuidance?.trim() || promptLanguageText(
        writingLanguage,
        '（无微操指导）',
        '(no author guidance)',
      ))

    let finalizedSources: FinalizedMaterialSource[] = []
    let activeThreadContext = ''
    if (!isFirstChapter) {
      const finalized = await this.readFinalizedMaterials(
        expectedProjectPath,
        this.chapterInfo.chapterNumber,
        projectSession,
        this.chapterInfo.characters,
      )
      finalizedSources = finalized.sources
      callbacks.log(uiText(
        `  已定位定稿连续性原文（${finalized.locatedFactCandidates} 条候选）`,
        `  Located finalized continuity excerpts (${finalized.locatedFactCandidates} candidates)`,
      ))
      const activeThreads = await this.readActiveNarrativeThreads(
        expectedProjectPath,
        projectSession,
        writingLanguage,
      )
      callbacks.log(uiText(
        `  已加载相关活跃叙事线索（${activeThreads.count} 条）`,
        `  Loaded relevant active narrative threads (${activeThreads.count})`,
      ))
      activeThreadContext = activeThreads.text
      promptBuilder
        // Old summaries, currentState and previous-ending slots stay empty. One
        // source-labelled material package is appended below.
        .withGlobalSummary('')
        .withPreviousEnding('')
        .withShortSummary('')
    }

    if (defaultMain && earlyRecovery?.selectedDraftIds.length && !earlyRecovery.selectedDrafts)
      throw new Error('GENERATION_DRAFT_SOURCE_CHANGED')
    const explicitlyRequiredDraftIds = new Set(this.selectedCandidateDrafts
      .filter(candidate => candidate.required === true).map(candidate => candidate.draftId))
    const selectedCandidateDrafts = (defaultMain ? prepared?.selectedDrafts ?? earlyRecovery?.selectedDrafts ?? [] : this.selectedCandidateDrafts)
      .filter(candidate => candidate.chapterNumber < this.chapterInfo.chapterNumber)
      .map(candidate => explicitlyRequiredDraftIds.has(candidate.draftId) && candidate.required !== true
        ? { ...candidate, required: true }
        : candidate)
      .sort((left, right) => left.chapterNumber - right.chapterNumber)
    const previousChapterNumber = this.chapterInfo.chapterNumber - 1
    const hasRequiredPreviousCandidate = selectedCandidateDrafts.some(candidate => (
      candidate.chapterNumber === previousChapterNumber && Boolean(candidate.content.trim())
    ))
    const requiredFinalizedSource = finalizedSources.find(source => (
      source.chapterNumber === previousChapterNumber
      && source.sourceStatus !== 'invalid'
      && Boolean(source.content.trim())
    ))
    if (!isFirstChapter && !hasRequiredPreviousCandidate && !requiredFinalizedSource) {
      throw new Error(uiText(
        `无法固定第 ${previousChapterNumber} 章的必需定稿来源，已停止生成。请修复或重新定稿该章后再试。`,
        `The required finalized source for Chapter ${previousChapterNumber} could not be fixed, so generation stopped. Repair or re-finalize that chapter and try again.`,
      ))
    }
    let chapterMaterials: ChapterMaterialAssembly
    try {
      chapterMaterials = await assembleChapterMaterials({
        identity: { projectId: projectSession.projectId, epoch: projectSession.leaseId },
        writingLanguage,
        budgetChars: 8_000,
        authorProjectFacts: authoredConfigFacts,
        characterProfiles,
        futurePlans: futureBlueprintsStr,
        references: [
          ...(activeThreadContext ? [{ text: activeThreadContext, rendered: activeThreadContext }] : []),
          ...knowledgeReferences,
        ],
        finalized: finalizedSources,
        candidates: selectedCandidateDrafts,
        relevanceTerms: [
          this.chapterInfo.title,
          this.chapterInfo.keyEvents,
          ...this.chapterInfo.characters,
        ],
      })
    } catch (error) {
      // 必需材料（作者资料/角色档案/后续计划）超出容量：显式失败，绝不静默裁掉。
      if (!(error instanceof ChapterMaterialCapacityError)) throw error
      const blocked = error.decision.decision === 'capacity-conflict'
        ? `${error.decision.blockingSourceId}:${error.decision.blockingReason}`
        : error.decision.remainingRequired.join('、')
      callbacks.log(uiText(
        `  必需材料超出上下文容量（${error.decision.decision}）：${blocked}`,
        `  Required material exceeds the context capacity (${error.decision.decision}): ${blocked}`,
      ))
      throw new Error(uiText(
        '本章必需材料（作者资料、角色档案、后续计划）超出上下文容量，已停止生成。请精简这些内容后重试。',
        'The required material for this chapter (author facts, character profiles, future plans) exceeds the context capacity, so generation stopped. Trim it and try again.',
      ))
    }
    const admittedCandidateSourceIds = new Set(chapterMaterials.selection.included
      .map(material => material.ref.sourceId)
      .filter(sourceId => sourceId.startsWith('candidate:')))
    if (selectedCandidateDrafts.length > 0 && admittedCandidateSourceIds.size === 0) {
      throw new Error('GENERATION_DRAFT_REQUIRED_PREDECESSOR_NOT_ADMITTED')
    }
    // 无未定稿候选时上一章原文只经直接前驱的定稿块（整块或降级后的结尾）到达模型：
    // 来源存在不等于模型收到了它，未被选入提示词就不得开始生成。
    if (selectedCandidateDrafts.length === 0 && requiredFinalizedSource
      && !chapterMaterials.selection.included.some(material => material.ref.sourceId === `finalized:${requiredFinalizedSource.draftId}`)) {
      throw new Error('GENERATION_DRAFT_REQUIRED_PREDECESSOR_NOT_ADMITTED')
    }
    if (chapterMaterials.omissions.length > 0) {
      callbacks.log(uiText(
        `  可选材料覆盖缺口：${chapterMaterials.omissions.length} 项`,
        `  Optional material coverage gaps: ${chapterMaterials.omissions.length}`,
      ))
    }
    // 仅历史恢复沿用已记录的对账块；新 run 直接使用作者材料与定稿事实。
    const chapterExecutionContract = chapterExecutionContractText(writingLanguage, writerChapterInfo)
    const systemRole = `${promptBuilder.getSystemRole()}\n\n${chapterExecutionContract.rules}`
    const composeInitialPrompt = (reconciliationBlock: string) => [chapterMaterials.text, promptBuilder.build(),
      reconciliationBlock, chapterExecutionContract.authorItems, chapterLengthContract]
      .filter(Boolean)
      .join('\n\n')
    const prompt = composeInitialPrompt('')
    const materialDecision = { ...chapterMaterials.decision, promptHash: await hashAuthorText(prompt) }
    const previousEnding = chapterMaterials.previousEnding

    callbacks.log(uiText(
      '调用 AI 生成章节草稿...',
      'Calling AI to generate the chapter draft...',
    ))
    let mainOwned = false
    let alreadySaved = false
    let draftPersisted = false
    let recoverableDraftCandidate = ''
    const workflowStepId = step && typeof step === 'object' && 'id' in step && typeof step.id === 'string'
      ? step.id
      : 'generate-draft'
    try {
      this.assertNotCancelled(context)
      const cancellation = observeWorkflowCancellation(context)
      let runtime: GenerationRuntime | null = null
      let cleanDraftText: string
      let acknowledgedPreview = ''
      // 对账输出不是正文：对账请求进行期间不把它的快照显示到写作面板。
      const mainCallbacks = callbacks.replaceText ? { ...callbacks,
        replaceText: (text: string) => { callbacks.replaceText?.(composeDraftVisibleContinuation(acknowledgedPreview, text)) },
      } : callbacks
      try {
        const generationModelId = workflowGenerationModelId(context)
        const priorSave = this.resumeHandle
          ? await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle: this.resumeHandle })
          : null
        if (priorSave?.savedDraft) {
          if (priorSave.operation !== 'chapter-draft' || priorSave.chapterNumber !== this.chapterInfo.chapterNumber)
            throw new Error('GENERATION_DRAFT_RECOVERY_SCOPE_INVALID')
          mainOwned = true
          alreadySaved = true
          context.mainGenerationRunHandle = this.resumeHandle
          cleanDraftText = priorSave.savedDraft.content
        } else {
        runtime = await this.dependencies.createRuntime({
          budget: DRAFT_GENERATION_BUDGET,
          ...(generationModelId ? { modelId: generationModelId } : {}),
        }, { context, callbacks: mainCallbacks, selection: {
          operation: 'chapter-draft', chapterNumber: this.chapterInfo.chapterNumber,
          ...(prepared ? { preparationId: prepared.preparationId } : {}),
          ...(this.batchId ? { batchId: this.batchId } : {}),
          promptKeys: [templateKey], skillStages: ['drafting'], output: 'visible-text',
          selectedDraftIds: [...new Set(selectedCandidateDrafts.map(item => item.draftId))],
          selectedFinalizedDraftIds: [...new Set(chapterMaterials.consumedFinalizedSources.map(item => item.draftId))],
          selectedBlueprintChapterNumbers: Array.from({ length: 6 }, (_, index) => this.chapterInfo.chapterNumber + index),
          // S10B 步骤 3：本次准入的脱敏收据随冻结上下文一起进主进程，并被恢复指纹绑定。
          materialDecision,
          authorInputs: [{ id: 'draft:chapter-info', text: JSON.stringify(writerChapterInfo) },
            { id: 'draft:author-config', text: JSON.stringify(novelConfig) },
            { id: 'draft:target-units', text: String(targetChars) }],
          ...(this.resumeHandle ? { resumeHandle: this.resumeHandle } : {}),
        } })
        mainOwned = (runtime as { mainOwned?: boolean }).mainOwned === true
        cleanDraftText = await runtime.execute(async ({ session }) => {
          const recovery = mainOwned && this.resumeHandle
            ? await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle: context.mainGenerationRunHandle! })
            : null
          if (this.resumeHandle && !mainOwned) throw new Error('GENERATION_DRAFT_LEGACY_RESUME_REFUSED')
          const reconciliationArtifactIds = new Set(recovery?.draftReconciliation?.artifactIds ?? [])
          // 对账已完成而首稿尚未发出（如进程在两者之间中断）：沿用记录的对账结果直接生成首稿。
          const reconciledOnly = !!recovery && !recovery.composition && !recovery.savedDraft && recovery.attemptedPurposes.length > 0
            && recovery.attemptedPurposes.every(purpose => purpose === DRAFT_RECONCILE_PURPOSE)
          const failedBatchView = recovery && this.batchId && recovery.batchId === this.batchId
            && !recovery.composition && !recovery.savedDraft && recovery.lastCompositionFinishReason === null
            && recovery.attemptedPurposes.at(-1) === 'chapter-draft'
            ? await ipc.invokeWithProjectSession(projectSession, 'generation:read', this.resumeHandle!) : null
          const lastAttempt = failedBatchView?.budgetDiagnostics?.at(-1)
          const retryFailedBatch = !!failedBatchView && failedBatchView.status === 'running' && !failedBatchView.nonReplayable
            && failedBatchView.handle.runId === this.resumeHandle?.runId && (failedBatchView.ledger?.physicalRequests ?? 0) > 0
            && !failedBatchView.ledger?.blockedCode && lastAttempt?.finishReason === null
            && (lastAttempt.failureCode === 'GENERATION_PROVIDER_FAILED' || lastAttempt.failureCode === 'NETWORK_ERROR')
            && ![...failedBatchView.artifacts, ...(failedBatchView.candidates ?? [])].some(artifact => !reconciliationArtifactIds.has(artifact.artifactId) && artifact.text.trim())
            && !failedBatchView.unsavedTails?.some(tail => tail.text.trim())
          if (recovery && (recovery.operation !== 'chapter-draft'
            || recovery.chapterNumber !== this.chapterInfo.chapterNumber
            || !retryFailedBatch && !reconciledOnly && (!recovery.composition || recovery.composition.algorithm !== DRAFT_VISIBLE_TEXT_VERSION
              || !['stop', 'length'].includes(recovery.lastCompositionFinishReason ?? ''))))
            throw new Error('GENERATION_DRAFT_RECOVERY_EVIDENCE_REQUIRED')
          const expectedInputs = [{ id: 'draft:chapter-info', text: JSON.stringify(writerChapterInfo) },
            { id: 'draft:author-config', text: JSON.stringify(novelConfig) },
            { id: 'draft:target-units', text: String(targetChars) }]
          if (recovery && expectedInputs.some(input => recovery.authorInputs.find(item => item.id === input.id)?.text !== input.text))
            throw new Error('GENERATION_DRAFT_RECOVERY_AUTHOR_INPUT_CHANGED')
          const sameIds = (a: readonly number[], b: readonly number[]) => JSON.stringify([...new Set(a)].sort((a, b) => a - b)) === JSON.stringify([...new Set(b)].sort((a, b) => a - b))
          if (recovery && (!sameIds(recovery.selectedDraftIds, selectedCandidateDrafts.map(item => item.draftId))
            || !sameIds(recovery.selectedFinalizedDraftIds, chapterMaterials.consumedFinalizedSources.map(item => item.draftId))
            || !sameIds(recovery.selectedBlueprintChapterNumbers, Array.from({ length: 6 }, (_, index) => this.chapterInfo.chapterNumber + index))))
            throw new Error('GENERATION_DRAFT_RECOVERY_SOURCE_SELECTION_CHANGED')
          let acknowledgedIds: string[] = [...(recovery?.composition?.artifactIds ?? [])]
          acknowledgedPreview = recovery?.composition?.text ?? ''
          const acknowledge = async (outcome: GenerationOutcome, text: string) => {
            if (!mainOwned || !text || !['stop', 'length'].includes(outcome.finishReason)) return
            const handle = context.mainGenerationRunHandle
            const artifact = outcome.receipt.visibleArtifact
            if (!handle || !artifact) throw new Error('GENERATION_COMPOSITION_ARTIFACT_REQUIRED')
            const hash = await sha256Hex(text)
            const expectedIds = [...acknowledgedIds, artifact.artifactId]
            const receipt = await ipc.invokeWithProjectSession(projectSession, 'generation:compose-visible',
              handle, expectedIds, hash, DRAFT_VISIBLE_TEXT_VERSION)
            if (receipt.text !== text || receipt.textHash !== hash || receipt.algorithm !== DRAFT_VISIBLE_TEXT_VERSION
              || JSON.stringify(receipt.artifactIds) !== JSON.stringify(expectedIds))
              throw new Error('GENERATION_COMPOSITION_RECEIPT_MISMATCH')
            acknowledgedIds = [...receipt.artifactIds]
            acknowledgedPreview = receipt.text
          }
          const draftingSession = injectWritingSkillIntoSession(session, context, 'drafting')
          if (context.writingSkills?.drafting) {
            callbacks.log(uiText(
              `本次 drafting 阶段使用已冻结写作 Skill：${context.writingSkills.drafting.name}`,
              `Using the workflow-start-frozen writing skill for drafting: ${context.writingSkills.drafting.name}`,
            ))
          }
          const recordedReconciliation = recovery?.draftReconciliation?.completedOutput
          const reconciliationBlock = recordedReconciliation ? draftReconciliationBlock(writingLanguage, recordedReconciliation) : ''
          this.assertNotCancelled(context)
          callbacks.setProgress(10)
          const preview = createDraftStreamPreview(
            callbacks.replaceText,
            visibleDraftStreamText,
          )
          let initialVisibleDraft: string
          let initialFinishReason: LLMCompletion['finishReason']
          let initialFailureCode: GenerationAttemptReceipt['failureCode']
          let initialReasoning = true
          if (recovery?.composition) {
            initialVisibleDraft = recovery.composition!.text
            initialFinishReason = recovery.lastCompositionFinishReason as 'stop' | 'length'
            preview.stop()
          } else {
            let initialOutcome: GenerationOutcome
            try {
              initialOutcome = await draftingSession.complete({
                purpose: 'chapter-draft',
                budgetDemand: { kind: 'draft-units', writingLanguage, requestedUnits: targetChars, segmentable: false },
                reasoningStage: 'drafting',
                output: 'visible-text',
                messages: [
                  { role: 'system', content: systemRole },
                  { role: 'user', content: composeInitialPrompt(reconciliationBlock) },
                ],
              }, {
                signal: cancellation.signal,
                ...(!mainOwned ? { onChunk: (chunk: string) => {
                  if (context.cancelled) return
                  preview.push(chunk)
                } } : {}),
              })
            } catch (error) {
              recoverableDraftCandidate = preview.snapshot()
              throw error
            } finally {
              preview.stop()
            }
            const initialCompletion = completionFromOutcome(initialOutcome)
            logDraftAttempt(
              callbacks,
              context,
              { zhCN: '初始生成', enUS: 'Initial generation' },
              initialOutcome.receipt,
            )
            callbacks.log(uiText(
              `  初始生成响应结束：finishReason=${initialCompletion.finishReason}`,
              `  Initial generation response ended: finishReason=${initialCompletion.finishReason}`,
            ))
            initialVisibleDraft = sanitizeDraftText(this.stripThinkingTags(initialCompletion.content))
            initialFinishReason = initialCompletion.finishReason
            initialFailureCode = initialOutcome.receipt.failureCode
            initialReasoning = initialOutcome.receipt.capabilities.reasoning === true
            await acknowledge(initialOutcome, initialVisibleDraft)
            }
          recoverableDraftCandidate = initialVisibleDraft
          callbacks.log(uiText(
            `  初始生成可见单位：visibleUnits=${countDraftUnits(initialVisibleDraft)}`,
            `  Initial generation visible units: visibleUnits=${countDraftUnits(initialVisibleDraft)}`,
          ))
          callbacks.replaceText?.(initialVisibleDraft)
          callbacks.setProgress(90)
          this.assertNotCancelled(context)
          const completedDraft = await this.extendDraftIfNeeded({
            session: draftingSession,
            mainOwned,
            acknowledge,
            signal: cancellation.signal,
            initialDraft: initialVisibleDraft,
            initialFinishReason,
            initialFailureCode,
            initialRounds: recovery?.attemptedPurposes.filter(purpose => purpose === 'chapter-draft-continuation' || purpose === 'chapter-draft-no-progress-recovery').length,
            noProgressRecoveryUsed: recovery?.attemptedPurposes.includes('chapter-draft-no-progress-recovery'),
            targetChars,
            callbacks,
            context,
            systemRole,
            chapterInfo: writerChapterInfo,
            globalGuidance: mergedGuidance,
            writingStyle,
            novelConfigFacts: novelConfigFactsJson,
            chapterMaterials: chapterMaterials.text,
            reconciliation: reconciliationBlock,
            writingLanguage,
            reasoning: initialReasoning,
            onRecoverableCandidate: candidate => { recoverableDraftCandidate = candidate },
          })
          recoverableDraftCandidate = completedDraft
          const lengthCheckedDraft = await this.condenseDraftIfNeeded({
            session: draftingSession,
            acknowledge,
            signal: cancellation.signal,
            draft: completedDraft,
            alreadyAttempted: recovery?.attemptedPurposes.includes(DRAFT_CONDENSE_PURPOSE) === true,
            targetChars,
            callbacks,
            context,
            systemRole,
            chapterInfo: writerChapterInfo,
            globalGuidance: mergedGuidance,
            writingStyle,
            novelConfigFacts: novelConfigFactsJson,
            chapterMaterials: chapterMaterials.text,
            reconciliation: reconciliationBlock,
            writingLanguage,
          })
          recoverableDraftCandidate = lengthCheckedDraft
          return lengthCheckedDraft
        })
        }
      } catch (error) {
        if (context.cancelled) throw new Error(uiText('工作流已取消', 'Workflow was cancelled.'))
        throw error
      } finally {
        cancellation.dispose()
        if (runtime) {
          try { await runtime.close() } catch { /* execute close failure already fails before persistence */ }
        }
      }
      this.assertNotCancelled(context)
      if (!alreadySaved) {
        const units = countDraftUnits(cleanDraftText)
        const range = draftTargetUnitRange(targetChars)
        if (units < range.minimum) throw draftTooShortError(context, units, targetChars)
        if (units > range.maximum) {
          if (mainOwned) {
            const handle = context.mainGenerationRunHandle
            if (!handle) throw new Error('GENERATION_COMPOSITION_HANDLE_REQUIRED')
            await ipc.invokeWithProjectSession(projectSession, 'generation:pause', handle)
          }
          throw draftLengthOutOfRangeError()
        }
      }
      if (!alreadySaved && hasSubstantialPreviousChapterReuse(previousEnding, cleanDraftText, writingLanguage)) {
        throw new Error(uiText(
          '新章节开头与上一章结尾存在大段重演，结果未保存。请重新生成，并让本章从上一章已完成事件之后继续。',
          'The new chapter substantially replays the previous ending, so it was not saved. Regenerate it and continue after the events already completed in the previous chapter.',
        ))
      }

      // 落于数据库
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) {
        throw new Error(uiText(
          '当前项目已切换，已拒绝保存章节草稿',
          'The project changed, so saving the chapter draft was refused.',
        ))
      }
      this.assertNotCancelled(context)
      if (mainOwned && !alreadySaved
        && JSON.stringify(useProjectStore.getState().currentProject?.novelConfig) !== JSON.stringify(novelConfig))
        throw new Error('GENERATION_DRAFT_AUTHOR_CONFIG_CHANGED')
      const createResult = mainOwned ? await (async () => {
        const handle = context.mainGenerationRunHandle
        if (!handle) throw new Error('GENERATION_COMPOSITION_HANDLE_REQUIRED')
        const saved = await ipc.invokeWithProjectSession(projectSession, 'generation:commit-draft', {
          handle, chapterNumber: this.chapterInfo.chapterNumber, source: 'write',
          ...(this.batchId ? { batchId: this.batchId } : {}),
          expectedCompositionHash: await sha256Hex(cleanDraftText),
        })
        if (saved.content !== cleanDraftText || saved.contentHash !== await sha256Hex(cleanDraftText))
          throw new Error('GENERATION_DRAFT_COMMIT_RECEIPT_MISMATCH')
        return saved
      })() : await (async () => {
        const nextVersion: number = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-next-version',
          this.chapterInfo.chapterNumber,
          expectedProjectPath,
        )
        this.assertNotCancelled(context)
        const finalizedDependencies: DraftSourceDependency[] = await Promise.all(
          chapterMaterials.consumedFinalizedSources.map(async source => source.sourceIdentity?.kind === 'finalized'
            ? {
                kind: 'finalized' as const,
                draftId: source.draftId,
                chapterNumber: source.chapterNumber,
                finalizationId: source.sourceIdentity.finalizationId,
                contentHash: source.sourceIdentity.contentHash,
              }
            : {
                kind: 'legacy-finalized' as const,
                draftId: source.draftId,
                chapterNumber: source.chapterNumber,
                contentHash: await sha256Hex(source.content),
              }),
        )
        const finalizedDraftIds = new Set(finalizedDependencies.map(dependency => dependency.draftId))
        const candidateDependencies: DraftSourceDependency[] = await Promise.all(
          selectedCandidateDrafts
            .filter(candidate => admittedCandidateSourceIds.has(`candidate:${candidate.draftId}`)
              && !finalizedDraftIds.has(candidate.draftId))
            .map(async candidate => ({
              draftId: candidate.draftId,
              contentHash: await sha256Hex(candidate.content),
            })),
        )
        const saved = await ipc.invokeWithProjectSession(projectSession, 'db:draft-create', {
          chapterNumber: this.chapterInfo.chapterNumber,
          version: nextVersion,
          source: 'write',
          content: cleanDraftText,
          wordCount: countDraftUnits(cleanDraftText),
          sourceDependencies: [...candidateDependencies, ...finalizedDependencies],
        }, expectedProjectPath)
          return { ...saved, version: nextVersion }
      })()
      const nextVersion = createResult.version
      if (!createResult.success || !createResult.id) {
        throw new Error(('error' in createResult ? String(createResult.error) : '') || uiText('章节草稿保存失败', 'Failed to save the chapter draft.'))
      }
      this.assertNotCancelled(context)
      draftPersisted = true
      return this.publishSavedDraft({ context, callbacks, projectSession, expectedProjectPath,
        cleanDraftText, id: createResult.id, nextVersion, mergedGuidance })
    } catch (error) {
      if (!mainOwned && !draftPersisted && recoverableDraftCandidate) {
        callbacks.replaceText?.(recoverableDraftCandidate)
        const failureCode = recoveryFailureCode(error, context.cancelled)
        const failureReason = error instanceof Error ? error.message : String(error)
        try {
          const result = await ipc.invokeWithProjectSession(
            projectSession,
            'db:recovery-candidate-record',
            {
              runId: context.runId,
              stepId: workflowStepId,
              chapterNumber: this.chapterInfo.chapterNumber,
              chapterTitle: this.chapterInfo.title,
              source: recoveryChapterSource(this.chapterInfo),
              sourceDraft: sourceDraft ? { id: sourceDraft.id, version: sourceDraft.version } : null,
              visibleText: recoverableDraftCandidate,
              failureCode,
              failureReason,
            },
            expectedProjectPath,
          )
          if (!result.success || !result.candidate) {
            throw new Error(result.error || uiText('未知存储错误', 'Unknown storage error.'))
          }
          callbacks.log(uiText(
            '生成未能安全完成；已收到的可见正文已保存为项目恢复候选，未进入草稿库。',
            'Generation could not complete safely. The visible prose was saved as a project recovery candidate and was not added to the draft library.',
          ))
        } catch (persistenceError) {
          const persistenceReason = persistenceError instanceof Error
            ? persistenceError.message
            : String(persistenceError)
          callbacks.log(uiText(
            `恢复候选保存失败；可见正文仍保留在当前步骤中：${persistenceReason}`,
            `Saving the recovery candidate failed. The visible prose remains in the current step: ${persistenceReason}`,
          ))
          throw new Error(uiText(
            `${failureReason}；恢复候选保存失败：${persistenceReason}`,
            `${failureReason}; saving the recovery candidate failed: ${persistenceReason}`,
          ))
        }
      } else if (!mainOwned && !draftPersisted) {
        callbacks.replaceText?.('')
      }
      throw error
    }
  }

  private async publishSavedDraft({ context, callbacks, projectSession, expectedProjectPath,
    cleanDraftText, id, nextVersion, mergedGuidance }: {
    context: CommandExecuteParams['context']; callbacks: CommandExecuteParams['callbacks']
    projectSession: ProjectSessionContext; expectedProjectPath: string
    cleanDraftText: string; id: number; nextVersion: number; mergedGuidance: string
  }): Promise<string> {
    const uiText = (zh: string, en: string) => workflowUiText(context, zh, en)
    callbacks.replaceText?.(cleanDraftText)

    const pseudoPath = formatResourceUri({ kind: 'draft', id })

    context.data.draft = cleanDraftText
    context.data.draftContent = cleanDraftText
    context.data.draftPath = pseudoPath
    context.data.draftId = id
    context.data.draftVersion = nextVersion
    context.data.chapterNumber = this.chapterInfo.chapterNumber
    context.data.chapterInfo = this.chapterInfo
    context.data.mergedGuidance = mergedGuidance
    context.data.shortSummary = ''

    await useProjectStore.getState().refreshFileTree(expectedProjectPath, undefined, projectSession)
    try {
      const { useDraftStore } = await import('../../../stores/draft-store')
      await useDraftStore.getState().loadAllDrafts(expectedProjectPath, projectSession)
    } catch { /* 忽略 */ }

    try {
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) throw new Error(uiText(
        '当前项目已切换，已拒绝打开旧草稿',
        'The project changed, so opening the old draft was refused.',
      ))
      const { useEditorStore } = await import('../../../stores/editor-store')
      useEditorStore.getState().openFile({
        id: pseudoPath,
        name: uiText(
        `第${this.chapterInfo.chapterNumber}章 ${this.chapterInfo.title} v${nextVersion}`,
        `Chapter ${this.chapterInfo.chapterNumber} ${this.chapterInfo.title} v${nextVersion}`,
        ),
        type: 'chapter',
        filePath: pseudoPath,
        content: cleanDraftText,
        savedContent: cleanDraftText,
        projectKey: expectedProjectPath,
      })
    } catch { /* 忽略 */ }

    callbacks.log(uiText(
      `草稿已自动入库保存为版本 v${nextVersion}（${countDraftUnits(cleanDraftText)} 字）`,
      `Draft saved automatically as version v${nextVersion} (${countDraftUnits(cleanDraftText)} units)`,
    ))
    return cleanDraftText
  }

  private shouldAutoContinue(
    currentText: string,
    targetChars: number,
    rounds: number,
    finishReason: LLMCompletion['finishReason'],
  ): boolean {
    if (rounds >= MAX_AUTO_CONTINUE_ROUNDS) return false
    const currentChars = countDraftUnits(currentText)
    if (currentChars > draftTargetUnitRange(targetChars).maximum) return false
    if (finishReason === 'stop') {
      return currentChars < draftTargetUnitRange(targetChars).minimum
    }
    return finishReason === 'length'
  }

  private async extendDraftIfNeeded(params: {
    session: GenerationSession
    mainOwned?: boolean
    acknowledge?: (outcome: GenerationOutcome, text: string) => Promise<void>
    signal: AbortSignal
    initialDraft: string
    initialRounds?: number
    noProgressRecoveryUsed?: boolean
    initialFinishReason: LLMCompletion['finishReason']
    initialFailureCode?: GenerationAttemptReceipt['failureCode']
    targetChars: number
    callbacks: CommandExecuteParams['callbacks']
    context: CommandExecuteParams['context']
    systemRole: string
    chapterInfo: WriterChapterInfo
    globalGuidance: string
    writingStyle: string
    novelConfigFacts: string
    chapterMaterials: string
    reconciliation?: string
    writingLanguage: WritingLanguage
    reasoning: boolean
    onRecoverableCandidate(candidate: string): void
  }): Promise<string> {
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(
      params.context,
      zhCNText,
      enUSText,
    )
    let draft = params.initialDraft
    let rounds = params.initialRounds ?? 0
    let lastFinishReason = params.initialFinishReason
    let lastFailureCode = params.initialFailureCode
    let noProgressRecoveryUsed = params.noProgressRecoveryUsed ?? false
    let recoveryPending = false

    if (
      params.reasoning
      && lastFinishReason === 'length'
      && countDraftUnits(draft) < 100
    ) {
      throw new Error(
        uiText(
          '模型的输出预算主要消耗在推理阶段，尚未产生足够正文。无法安全续接隐藏推理过程；' +
            '请关闭模型思考模式、提高最大输出 Tokens，或改用更适合正文创作的非推理模型。',
          'The model spent most of its output budget on reasoning and did not produce enough prose. Hidden reasoning cannot be continued safely. ' +
            'Disable reasoning mode, increase the maximum output tokens, or use a non-reasoning model better suited to drafting.',
        ),
      )
    }

    while (this.shouldAutoContinue(draft, params.targetChars, rounds, lastFinishReason)) {
      if (params.context.cancelled) break
      rounds += 1
      const currentChars = countDraftUnits(draft)
      params.callbacks.log(uiText(
        `  自动续写第 ${rounds} 段：当前约 ${currentChars}/${params.targetChars} 字`,
        `  Auto-continuation ${rounds}: currently about ${currentChars}/${params.targetChars} units`,
      ))

      // 续写额度：未到目标时补足剩余篇幅；已到目标（长度截断）时只允许补完断句并收束。两者都不得越过门禁上限。
      const range = draftTargetUnitRange(params.targetChars)
      const remaining = Math.max(0, params.targetChars - currentChars)
      const ceiling = Math.max(0, range.maximum - currentChars)
      const allowance = remaining > 0 ? Math.min(remaining, ceiling) : Math.min(150, ceiling)
      const visibleTail = sanitizeDraftText(draft).slice(-CONTINUE_PROMPT_MAX_CHARS)
      const recoveryInstruction = recoveryPending
        ? promptLanguageText(
            params.writingLanguage,
            '上一轮续写达到输出上限且没有增加足够的新正文，已被全部丢弃。\n'
              + '这是本次任务唯一一次无进展恢复机会：请直接推进下一事件、动作或对话，禁止复述已写末尾。\n\n',
            'The previous continuation reached the output limit without adding enough new prose, so it was discarded in full.\n'
              + 'This is the only no-progress recovery attempt: advance directly to the next event, action, or line of dialogue without repeating the existing ending.\n\n',
          )
        : ''
      const lengthInstruction = remaining > 0
        ? promptLanguageText(
            params.writingLanguage,
            `- 本次续写补足约 ${allowance} 字即可，新增部分绝不超过 ${ceiling} 字；接近时按本章结束状态收束，停在完整句子和自然段落末尾。`,
            `- Add about ${allowance} words in this continuation and never more than ${ceiling}; as you approach that length, close at the chapter's ending state and stop at the end of a complete sentence and paragraph.`,
          )
        : promptLanguageText(
            params.writingLanguage,
            `- 本章已达到目标篇幅：只补完被截断的句子并收束当前场景，新增部分约 ${allowance} 字以内、绝不超过 ${ceiling} 字，不要展开新事件。`,
            `- The chapter has reached its target length: only finish the truncated sentence and close the current scene in about ${allowance} words or fewer, never more than ${ceiling}; do not start new events.`,
          )
      const authorMaterial = draftAuthorMaterialBlock(params.writingLanguage, params)
      const lengthContract = chapterLengthContractText(params.writingLanguage, params.targetChars)
      const continuationPrompt = promptLanguageText(
        params.writingLanguage,
        `${recoveryInstruction}请无缝续写当前章节正文。

【硬性要求】
- 只输出新增正文，不要复述已写内容。
- 从“已写正文末尾”自然接下去，保持同一场景逻辑或合理转场。
${lengthInstruction}
- 不要输出标题、解释、总结、Markdown、思考过程或“点我继续”。
- 避免重复已写正文中的整句、整段、动作链和意象。
- 不提前写后续章节，只完成本章蓝图允许的内容。

${lengthContract}

${authorMaterial}

【已写正文末尾】
${visibleTail}`,
        `${recoveryInstruction}Continue the current chapter seamlessly.

[Requirements]
- Output only new manuscript prose; do not repeat existing text.
- Continue naturally from the existing ending, preserving the same scene logic or making a justified transition.
${lengthInstruction}
- Do not output a title, explanation, summary, Markdown, reasoning, or an interface continuation prompt.
- Avoid repeating complete sentences, paragraphs, action sequences, or imagery from the existing manuscript.
- Complete only the current chapter blueprint; do not advance later chapters.

${lengthContract}

${authorMaterial}

[End of existing manuscript]
${visibleTail}`,
      )

      const preview = createDraftStreamPreview(
        params.callbacks.replaceText,
        rawText => appendVisibleDraftContinuation(draft, visibleDraftStreamText(rawText)),
        draft,
      )
      let outcome: GenerationOutcome
      try {
        outcome = await params.session.complete({
          purpose: recoveryPending
            ? 'chapter-draft-no-progress-recovery'
            : 'chapter-draft-continuation',
          reasoningStage: 'drafting',
          output: 'visible-text',
          budgetDemand: { kind: 'draft-units', writingLanguage: params.writingLanguage, requestedUnits: Math.max(1, allowance), segmentable: false },
          messages: [
            { role: 'system', content: params.systemRole },
            { role: 'user', content: continuationPrompt },
          ],
        }, {
          signal: params.signal,
          ...(!params.mainOwned ? { onChunk: (chunk: string) => {
            if (params.context.cancelled) return
            preview.push(chunk)
          } } : {}),
        })
      } catch (error) {
        params.onRecoverableCandidate(preview.snapshot())
        throw error
      } finally {
        preview.stop()
      }
      const addition = completionFromOutcome(outcome)
      lastFailureCode = outcome.receipt.failureCode
      logDraftAttempt(
        params.callbacks,
        params.context,
        { zhCN: `自动续写第 ${rounds} 段`, enUS: `Auto-continuation ${rounds}` },
        outcome.receipt,
      )
      params.callbacks.log(uiText(
        `  自动续写第 ${rounds} 段响应结束：finishReason=${addition.finishReason}`,
        `  Auto-continuation ${rounds} response ended: finishReason=${addition.finishReason}`,
      ))
      this.assertNotCancelled(params.context)
      const beforeChars = countDraftUnits(draft)
      const visibleAddition = sanitizeDraftText(this.stripThinkingTags(addition.content))
      const candidateDraft = appendVisibleDraftContinuation(
        draft,
        visibleAddition,
      )
      const mergedDelta = countDraftUnits(candidateDraft) - beforeChars
      const accepted = addition.finishReason === 'stop' || mergedDelta >= 300
      params.callbacks.log(uiText(
        `  自动续写可见单位：visibleUnitsBefore=${beforeChars} `
          + `candidateVisibleUnits=${countDraftUnits(visibleAddition)} `
          + `mergedDelta=${mergedDelta} accepted=${accepted}`,
        `  Auto-continuation visible units: visibleUnitsBefore=${beforeChars} `
          + `candidateVisibleUnits=${countDraftUnits(visibleAddition)} `
          + `mergedDelta=${mergedDelta} accepted=${accepted}`,
      ))
      if (addition.finishReason === 'length' && mergedDelta < 300) {
        params.callbacks.replaceText?.(draft)
        if (noProgressRecoveryUsed) {
          throw new Error(uiText(
            '唯一一次无进展恢复请求仍未增加足够的新正文，结果未保存。请缩短章节目标后重试。',
            'The single no-progress recovery request still did not add enough new prose, so the result was not saved. Shorten the chapter target and try again.',
          ))
        }
        noProgressRecoveryUsed = true
        recoveryPending = true
        lastFinishReason = addition.finishReason
        params.callbacks.log(uiText(
          '  本轮低增量截断内容已丢弃，将使用剩余预算执行一次无进展恢复请求',
          '  Discarded this low-progress truncated continuation; using the remaining budget for one no-progress recovery request',
        ))
        continue
      }
      await params.acknowledge?.(outcome, candidateDraft)
      draft = candidateDraft
      params.onRecoverableCandidate(draft)
      params.callbacks.replaceText?.(draft)
      lastFinishReason = addition.finishReason
      recoveryPending = false
      if (mergedDelta < 300) break
    }

    this.assertNotCancelled(params.context)
    if (lastFinishReason === 'length'
      && countDraftUnits(draft) > draftTargetUnitRange(params.targetChars).maximum) return draft
    if (lastFinishReason !== 'stop') {
      const error = this.createIncompleteCompletionError(lastFinishReason)
      if (lastFailureCode === 'GENERATION_PROVIDER_FAILED' || lastFailureCode === 'NETWORK_ERROR')
        Object.assign(error, { code: lastFailureCode })
      error.message = uiText(error.message, (() => {
        switch (lastFinishReason) {
          case 'length':
            return 'AI output reached the model maximum length and is incomplete. Increase the maximum output tokens or shorten the task, then try again.'
          case 'content_filter':
            return 'AI output was stopped by content restrictions, so the result was not saved.'
          case 'cancelled':
            return 'AI generation was cancelled, so the result was not saved.'
          default:
            return 'AI generation did not complete normally, so the result was not saved.'
        }
      })())
      throw error
    }

    const lowerBound = draftTargetUnitRange(params.targetChars).minimum
    const draftUnits = countDraftUnits(draft)
    if (draftUnits < lowerBound) throw draftTooShortError(params.context, draftUnits, params.targetChars)

    return draft
  }

  /**
   * 超出篇幅上限时，经同一生成会话做唯一一次压缩修订。压缩稿落入可接受范围且完整结束才采用；
   * 否则（仍越界、未完整结束或请求失败）原样返回原稿，由保存前的篇幅门禁按原语义暂停并报错。
   */
  private async condenseDraftIfNeeded(params: {
    session: GenerationSession
    acknowledge: (outcome: GenerationOutcome, text: string) => Promise<void>
    signal: AbortSignal
    draft: string
    alreadyAttempted: boolean
    targetChars: number
    callbacks: CommandExecuteParams['callbacks']
    context: CommandExecuteParams['context']
    systemRole: string
    chapterInfo: WriterChapterInfo
    globalGuidance: string
    writingStyle: string
    novelConfigFacts: string
    chapterMaterials: string
    reconciliation?: string
    writingLanguage: WritingLanguage
  }): Promise<string> {
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(params.context, zhCNText, enUSText)
    const range = draftTargetUnitRange(params.targetChars)
    const originalUnits = countDraftUnits(params.draft)
    if (originalUnits <= range.maximum || params.alreadyAttempted || params.context.cancelled) return params.draft
    params.callbacks.log(uiText(
      `  正文约 ${originalUnits} 字，超出可接受上限 ${range.maximum} 字，执行唯一一次压缩修订`,
      `  Draft is about ${originalUnits} units, above the acceptable maximum of ${range.maximum}; running the single condense revision`,
    ))
    // 顺序：任务与硬性要求 → 作者资料块 → 篇幅合同 → 待压缩正文；固定执行规则在 system。
    const authorMaterial = draftAuthorMaterialBlock(params.writingLanguage, params)
    const lengthContract = chapterLengthContractText(params.writingLanguage, params.targetChars)
    // 篇幅现状：告知模型待压缩正文当前长度与需删量（只说“须落入区间”时，模型常原样返回而压缩不足）。
    // 压缩仅在 originalUnits > range.maximum 时触发，故 cutUnits > 0；ceilUnits 不超过 range.maximum 且必大于 aimUnits。
    const aimUnits = Math.round(params.targetChars * 0.89)
    const ceilUnits = Math.min(range.maximum, Math.max(Math.round(params.targetChars * 1.05), aimUnits + 1))
    const cutUnits = originalUnits - aimUnits
    const cutPercent = Math.round(cutUnits / originalUnits * 100)
    const condensePrompt = promptLanguageText(
      params.writingLanguage,
      `请把下面的本章正文压缩修订到可接受篇幅内，输出修订后的完整正文。

【篇幅现状】待压缩正文当前约 ${originalUnits} 字，超出上限。请压缩到约 ${aimUnits} 字（绝对不得超过 ${ceilUnits} 字），即删去约 ${cutUnits} 字，约占全文 ${cutPercent}%。做法：逐段压缩，每段都删减描写、重复动作和心理，不要只删某一段。

【硬性要求】
- 修订后正文须在 ${range.minimum}–${range.maximum} 字之间，按下方篇幅合同写到约 ${Math.round(params.targetChars * 0.85)}–${params.targetChars} 字。
- 保留本章蓝图中的全部必需事件、作者任务和情节事实，保留人物身份与关系，保留本章结尾的收束与钩子。
- 只通过删减冗余描写、重复动作、重复心理和啰嗦对话来缩短；不得新增情节、人物、设定或事实，不得改变事件顺序与因果。
- 只输出修订后的完整正文；不要输出标题、解释、总结、Markdown、思考过程或“点我继续”。

${authorMaterial}

${lengthContract}

【待压缩正文】
${params.draft}`,
      `Condense the chapter manuscript below into the acceptable length and output the complete revised manuscript.

[Current length] The manuscript to condense is about ${originalUnits} words, above the ceiling. Condense it to about ${aimUnits} words (never more than ${ceilUnits} words), which means cutting about ${cutUnits} words, roughly ${cutPercent}% of the text. Method: condense paragraph by paragraph, trimming description, repeated actions, and repeated introspection in every paragraph rather than cutting only one part.

[Requirements]
- The revised manuscript must be between ${range.minimum} and ${range.maximum} words; following the length contract below, aim for about ${Math.round(params.targetChars * 0.85)}-${params.targetChars} words.
- Keep every required event, author task, and plot fact from the chapter blueprint, keep character identities and relationships, and keep the chapter ending and hook.
- Shorten only by cutting redundant description, repeated actions, repeated introspection, and wordy dialogue; do not add plot, characters, setting, or facts, and do not change event order or causality.
- Output only the complete revised manuscript; do not output a title, explanation, summary, Markdown, reasoning, or an interface continuation prompt.

${authorMaterial}

${lengthContract}

[Manuscript to condense]
${params.draft}`,
    )
    let condensed: string
    try {
      const outcome = await params.session.complete({
        purpose: DRAFT_CONDENSE_PURPOSE,
        reasoningStage: 'drafting',
        output: 'visible-text',
        budgetDemand: { kind: 'draft-units', writingLanguage: params.writingLanguage, requestedUnits: params.targetChars, segmentable: false },
        messages: [
          { role: 'system', content: params.systemRole },
          { role: 'user', content: condensePrompt },
        ],
      }, { signal: params.signal })
      logDraftAttempt(params.callbacks, params.context, { zhCN: '压缩修订', enUS: 'Condense revision' }, outcome.receipt)
      condensed = sanitizeDraftText(this.stripThinkingTags(outcome.content))
      const units = countDraftUnits(condensed)
      const accepted = outcome.finishReason === 'stop' && units >= range.minimum && units <= range.maximum
      params.callbacks.log(uiText(
        `  压缩修订响应结束：finishReason=${outcome.finishReason} visibleUnits=${units} accepted=${accepted}`,
        `  Condense revision response ended: finishReason=${outcome.finishReason} visibleUnits=${units} accepted=${accepted}`,
      ))
      if (!accepted) {
        params.callbacks.replaceText?.(params.draft)
        return params.draft
      }
      this.assertNotCancelled(params.context)
      await params.acknowledge(outcome, condensed)
    } catch (error) {
      if (params.context.cancelled || params.signal.aborted) throw error
      params.callbacks.log(uiText(
        `  压缩修订未完成，保留原稿：${error instanceof Error ? error.message : String(error)}`,
        `  Condense revision did not complete; keeping the original draft: ${error instanceof Error ? error.message : String(error)}`,
      ))
      params.callbacks.replaceText?.(params.draft)
      return params.draft
    }
    params.callbacks.replaceText?.(condensed)
    return condensed
  }

  // --- 抽取自原文件的辅助方法 ---
  private async readArchitecture(
    projectPath: string,
    projectSession: ProjectSessionContext,
    chapterNumber: number,
    authoredConfigFacts: readonly string[],
  ): Promise<string> {
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
    const duplicates = exactParagraphs(authoredConfigFacts)
    const parts: string[] = []
    if (core?.premise) parts.push(withoutExactParagraphDuplicates(core.premise, duplicates))
    if (core?.worldbuilding) parts.push(withoutExactParagraphDuplicates(core.worldbuilding, duplicates))
    if (core?.synopsis) {
      parts.push(withoutExactParagraphDuplicates(
        synopsisForDraftChapter(core.synopsis, chapterNumber),
        duplicates,
      ))
    }
    return parts.filter(Boolean).join('\n\n---\n\n')
  }

  private async readProjectPrompts(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: WritingLanguage,
  ): Promise<string> {
    try {
      const files = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:list-dir',
        `${projectPath}/${DIR_PROMPTS}`,
        projectPath,
      )
      const mdFiles = files.filter((f: { isDir: boolean; name: string }) => !f.isDir && f.name.endsWith('.md'))
      if (mdFiles.length === 0) return ''
      const parts: string[] = []
      for (const f of mdFiles) {
        const result = await ipc.invokeWithProjectSession(projectSession, 'fs:read-file', f.path, projectPath)
        if (result.success && result.content.trim()) {
          parts.push(promptLanguageText(
            writingLanguage,
            `## 项目专属指导（${f.name.replace(/\.md$/, '')}）\n${result.content.trim()}`,
            `## Project-specific guidance (${f.name.replace(/\.md$/, '')})\n${result.content.trim()}`,
          ))
        }
      }
      return parts.join('\n\n')
    } catch { return '' }
  }

  private async readCharacterProfiles(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: WritingLanguage,
    relevantCharacterNames: readonly string[],
  ): Promise<string> {
    try {
      const roster = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectPath)
      if (roster.status !== 'ready' && roster.status !== 'empty') {
        return promptLanguageText(
          writingLanguage,
          '（角色资料来源未知或待修复；未作为作者事实注入）',
          '(character-profile provenance is unknown or needs repair; it was not injected as author fact)',
        )
      }
      const profiles: string[] = []
      const relevantNames = new Set(relevantCharacterNames.map(name => name.trim()).filter(Boolean))
      for (const card of roster.entries) {
        if (!relevantNames.has(card.name)) continue
        const facts = [
          card.gender && `gender: ${card.gender}`,
          card.age && `age: ${card.age}`,
          card.appearance && `appearance: ${card.appearance}`,
          card.personality && `personality: ${card.personality}`,
          card.background && `background: ${card.background}`,
          card.abilities && `abilities: ${card.abilities}`,
          card.motivation && `motivation: ${card.motivation}`,
          card.arc && `arc: ${card.arc}`,
          card.notes && `notes: ${card.notes}`,
        ].filter(Boolean)
        for (const relationship of card.relationships ?? []) {
          const target = relationship.target?.trim()
          const relation = relationship.relation?.trim()
          if (target && relation) facts.push(`relationship: ${target} (${relation})`)
        }
        const legacyRelationshipNotes = card.legacyRelationshipNotes?.trim()
        if (legacyRelationshipNotes) {
          facts.push(promptLanguageText(
            writingLanguage,
            `relationship（legacy 来源未知）: ${legacyRelationshipNotes}`,
            `relationship (legacy provenance unknown): ${legacyRelationshipNotes}`,
          ))
        }
        for (const field of CHARACTER_STATE_TEXT_FIELDS) {
          const provenance = card.currentState?.provenance?.[field]
          const value = card.currentState?.[field]?.trim()
          if (provenance?.kind === 'author' && value) {
            facts.push(`${field}@chapter${provenance.chapterNumber}: ${value}`)
          }
        }
        profiles.push(`${card.name} (${card.role || 'unknown'})${facts.length ? ` | ${facts.join(' | ')}` : ''}`)
      }
      return profiles.length > 0 ? profiles.join('\n') : ''
    } catch {
      return promptLanguageText(
        writingLanguage,
        '（角色资料读取失败；未把旧 currentState 或 characters_arch 当作作者事实）',
        '(character profiles unavailable; legacy currentState and characters_arch were not treated as author facts)',
      )
    }
  }

  private async readFinalizedMaterials(
    projectPath: string,
    currentChapter: number,
    projectSession: ProjectSessionContext,
    currentEntities: readonly string[],
  ): Promise<{ sources: FinalizedMaterialSource[]; locatedFactCandidates: number }> {
    const FULL_WINDOW = 5
    let finalizedContinuity: FinalizedContinuityProjection[] = []
    try {
      finalizedContinuity = await ipc.invokeWithProjectSession(
        projectSession,
        'db:continuity-list-before',
        currentChapter,
        projectPath,
      )
    } catch { /* Optional derived index may be unavailable; finalized prose still loads below. */ }

    const selected = finalizedContinuity.flatMap(projection => {
      const isRecent = projection.chapterNumber >= currentChapter - FULL_WINDOW
      const factEvidence = (projection.facts ?? []).filter(fact => {
        const entityRelevant = fact.entities.some(entity => currentEntities.includes(entity))
          || currentEntities.some(entity => (
            fact.statement.includes(entity) || fact.evidence.includes(entity)
          ))
        return isRecent || entityRelevant
      }).map(fact => fact.evidence).filter(Boolean)
      const candidateEvidence = (projection.characterStateCandidates ?? [])
        .filter(candidate => isRecent || currentEntities.includes(candidate.characterName))
        .map(candidate => candidate.value || candidate.characterName)
        .filter(Boolean)
      const evidence = [...new Set([...factEvidence, ...candidateEvidence])]
      return evidence.length > 0 ? [{ projection, evidence }] : []
    }).sort((left, right) => right.projection.chapterNumber - left.projection.chapterNumber).slice(0, 12)

    const sources: FinalizedMaterialSource[] = []
    for (const { projection, evidence } of selected) {
      try {
        const sourceDraftId = projection.sourceStatus === 'stale' && projection.currentFinalizedDraftId
          ? projection.currentFinalizedDraftId : projection.draftId
        const sourceRead = await ipc.invokeWithProjectSession(
          projectSession,
          'db:continuity-read-source',
          sourceDraftId,
          projectPath,
        )
        const content = sourceRead.status === 'valid'
          ? sourceRead.snapshot.content
          : sourceRead.status === 'legacy'
            ? sourceRead.content
            : ''
        if (projection.chapterNumber === currentChapter - 1 && !content.trim()) continue
        sources.push({
          chapterNumber: projection.chapterNumber,
          draftId: sourceDraftId,
          title: sourceRead.status === 'valid' ? sourceRead.snapshot.chapterTitle : sourceRead.status === 'legacy' ? sourceRead.chapterTitle : projection.chapterTitle,
          content,
          evidence,
          includeEnding: projection.chapterNumber === currentChapter - 1,
          sourceStatus: sourceRead.status === 'invalid'
            ? 'invalid'
            : sourceRead.status === 'legacy'
              ? 'legacy'
              : projection.sourceStatus ?? 'current',
          ...(sourceRead.status === 'valid'
            ? {
                sourceIdentity: {
                  kind: 'finalized' as const,
                  finalizationId: sourceRead.snapshot.source.finalizationId,
                  contentHash: sourceRead.snapshot.source.contentHash,
                },
              }
            : sourceRead.status === 'legacy'
              ? { sourceIdentity: { kind: 'legacy-finalized' as const } }
              : {}),
        })
      } catch {
        if (projection.chapterNumber === currentChapter - 1) continue
        sources.push({
          chapterNumber: projection.chapterNumber,
          draftId: projection.draftId,
          title: projection.chapterTitle,
          content: '',
          evidence,
          includeEnding: projection.chapterNumber === currentChapter - 1,
          sourceStatus: 'invalid',
        })
      }
    }

    if (!sources.some(source => (
      source.chapterNumber === currentChapter - 1
      && source.sourceStatus !== 'invalid'
      && Boolean(source.content.trim())
    ))) {
      try {
        const meta = await ipc.invokeWithProjectSession(
          projectSession,
          'db:draft-get-finalized',
          currentChapter - 1,
          projectPath,
        )
        if (meta) {
          try {
            const sourceRead = await ipc.invokeWithProjectSession(
              projectSession,
              'db:continuity-read-source',
              meta.id,
              projectPath,
            )
            sources.push({
              chapterNumber: currentChapter - 1,
              draftId: meta.id,
              title: sourceRead.status === 'valid'
                ? sourceRead.snapshot.chapterTitle
                : sourceRead.status === 'legacy'
                  ? sourceRead.chapterTitle
                  : meta.chapterTitle ?? '',
              content: sourceRead.status === 'valid'
                ? sourceRead.snapshot.content
                : sourceRead.status === 'legacy'
                  ? sourceRead.content
                  : '',
              evidence: [],
              includeEnding: true,
              sourceStatus: sourceRead.status === 'valid' ? 'current' : sourceRead.status,
              ...(sourceRead.status === 'valid'
                ? {
                    sourceIdentity: {
                      kind: 'finalized' as const,
                      finalizationId: sourceRead.snapshot.source.finalizationId,
                      contentHash: sourceRead.snapshot.source.contentHash,
                    },
                  }
                : sourceRead.status === 'legacy'
                  ? { sourceIdentity: { kind: 'legacy-finalized' as const } }
                  : {}),
            })
          } catch {
            sources.push({
              chapterNumber: currentChapter - 1,
              draftId: meta.id,
              title: meta.chapterTitle ?? '',
              content: '',
              evidence: [],
              includeEnding: true,
              sourceStatus: 'invalid',
            })
          }
        }
      } catch { /* Existing guard owns absence; do not invent a source identity. */ }
    }
    return { sources, locatedFactCandidates: selected.reduce((sum, item) => sum + item.evidence.length, 0) }
  }

  private async readActiveNarrativeThreads(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: WritingLanguage,
  ): Promise<{ text: string; count: number }> {
    let threads: NarrativeThreadView[] = []
    try {
      threads = await ipc.invokeWithProjectSession(
        projectSession,
        'db:narrative-thread-list-relevant',
        {
          chapterNumber: this.chapterInfo.chapterNumber,
          title: this.chapterInfo.title,
          keyEvents: this.chapterInfo.keyEvents,
          characters: [...this.chapterInfo.characters],
        },
        projectPath,
      )
    } catch {
      return { text: '', count: 0 }
    }

    const header = promptLanguageText(
      writingLanguage,
      '【当前相关活跃叙事线索】',
      '[Relevant active narrative threads]',
    )
    const lines: string[] = []
    let usedChars = header.length + 1
    for (const thread of threads.slice(0, ACTIVE_THREAD_CONTEXT_MAX_ITEMS)) {
      const source = thread.events.at(-1)
      const line = promptLanguageText(
        writingLanguage,
        `- ${thread.title} [${thread.status}]（目标第${thread.targetStartChapter}–${thread.targetEndChapter}章；作者意图：${thread.authorIntent}${source ? `；来源第${source.chapterNumber}章：${source.evidence}` : ''}）`,
        `- ${thread.title} [${thread.status}] (target Chapters ${thread.targetStartChapter}–${thread.targetEndChapter}; author intent: ${thread.authorIntent}${source ? `; source Chapter ${source.chapterNumber}: ${source.evidence}` : ''})`,
      )
      const nextLength = line.length + (lines.length > 0 ? 1 : 0)
      if (usedChars + nextLength > ACTIVE_THREAD_CONTEXT_MAX_CHARS) break
      lines.push(line)
      usedChars += nextLength
    }
    if (lines.length === 0) return { text: '', count: 0 }
    return {
      text: `${header}\n${lines.join('\n')}`,
      count: lines.length,
    }
  }
}
