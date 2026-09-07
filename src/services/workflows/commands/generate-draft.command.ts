import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type LLMCompletion,
} from './base-command'
import { useProjectStore } from '../../../stores/project-store'
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
import { appendVisibleTextContinuation } from '../bounded-completion'
import { stripThinkingTags } from '../workflow-utils'
import {
  createGenerationRuntime,
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
import { countDraftUnits } from '../../../shared/draft-units'
import type { RecoveryChapterSource } from '../../../shared/recovery-candidate'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../../shared/character-roster'
import {
  assembleChapterMaterials,
  type ChapterMaterialReference,
  type FinalizedMaterialSource,
  type SelectedCandidateDraft,
} from '../chapter-materials'
import type { DraftSourceDependency } from '../../../shared/draft-source-dependency'

export { countDraftUnits } from '../../../shared/draft-units'
export { previousChapterEnding } from '../chapter-materials'

const CONTINUE_PROMPT_MAX_CHARS = 1600
const MIN_TARGET_COMPLETION_RATIO = 0.82
const MAX_AUTO_CONTINUE_ROUNDS = 7
const NEXT_CHAPTER_HEAD_MAX_CHARS = 1200
const CROSS_CHAPTER_REUSE_CJK_NGRAM_CHARS = 8
const CROSS_CHAPTER_REUSE_ENGLISH_NGRAM_CHARS = 20
const CROSS_CHAPTER_REUSE_LONG_RUN_CHARS = 80
const ACTIVE_THREAD_CONTEXT_MAX_CHARS = 1200
const ACTIVE_THREAD_CONTEXT_MAX_ITEMS = 6
const STREAM_PREVIEW_INTERVAL_MS = 250
export function sanitizeDraftText(text: string): string {
  const cleaned = stripThinkingTags(text)
    .replace(/^\s*(?:点我继续生成后续内容|继续生成后续内容|请点击继续|未完待续)\s*$/gmi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const paragraphs = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const paragraph of paragraphs) {
    const key = paragraph.replace(/\s+/g, '')
    if (key.length >= 40 && seen.has(key)) continue
    if (key.length >= 40) seen.add(key)
    deduped.push(paragraph)
  }
  return deduped.join('\n\n').trim()
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
  createRuntime(options: CreateGenerationRuntimeOptions): Promise<GenerationRuntime>
}

export interface GenerateDraftCommandOptions {
  /** Exact saved draft versions selected by this batch; never inferred as finalized history. */
  readonly selectedCandidateDrafts?: readonly SelectedCandidateDraft[]
  readonly dependencies?: Partial<GenerateDraftCommandDependencies>
}

const DEFAULT_DEPENDENCIES: GenerateDraftCommandDependencies = {
  createRuntime: options => createGenerationRuntime(options),
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
  return appendVisibleTextContinuation(draft, continuation, sanitizeDraftText)
}

export class GenerateDraftCommand extends BaseWorkflowCommand {
  private readonly dependencies: GenerateDraftCommandDependencies
  private readonly selectedCandidateDrafts: readonly SelectedCandidateDraft[]

  constructor(
    private chapterInfo: ChapterInfo,
    options: GenerateDraftCommandOptions = {},
  ) {
    super()
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
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

    const architecture = await this.readArchitecture(expectedProjectPath, projectSession)
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

    const isFirstChapter = this.chapterInfo.chapterNumber === 1
    const templateKey = isFirstChapter ? 'first_chapter_draft' : 'next_chapter_draft'
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
    const { coreOutline, worldSetting, goldenFinger, protagonistProfile } = novelConfig
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
      const knowledgeQueryHint = this.chapterInfo.knowledgeQueryHint?.trim() ?? ''
      const searchQuery = [
        knowledgeQueryHint,
        this.chapterInfo.title,
        this.chapterInfo.keyEvents,
        this.chapterInfo.characters.join(' '),
      ].filter(Boolean).join(' ')
      if (knowledgeQueryHint) {
        callbacks.log(uiText(
          `  追加用户检索关键词：${knowledgeQueryHint}`,
          `  Added author search keywords: ${knowledgeQueryHint}`,
        ))
      }
      const results = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(
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
    const writerChapterInfo = toWriterChapterInfo(this.chapterInfo)
    const targetChars = normalizeChapterWordsTarget(this.chapterInfo.wordsTarget, novelConfig.wordsPerChapter)
    const lowerTargetChars = Math.round(targetChars * 0.8)
    const upperTargetChars = Math.round(targetChars * 1.2)
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

    const selectedCandidateDrafts = this.selectedCandidateDrafts
      .filter(candidate => candidate.chapterNumber < this.chapterInfo.chapterNumber)
      .sort((left, right) => left.chapterNumber - right.chapterNumber)
    const previousChapterNumber = this.chapterInfo.chapterNumber - 1
    const hasRequiredPreviousCandidate = selectedCandidateDrafts.some(candidate => (
      candidate.chapterNumber === previousChapterNumber && Boolean(candidate.content.trim())
    ))
    const hasRequiredFinalizedSource = finalizedSources.some(source => (
      source.chapterNumber === previousChapterNumber
      && source.sourceStatus !== 'invalid'
      && Boolean(source.content.trim())
    ))
    if (!isFirstChapter && !hasRequiredPreviousCandidate && !hasRequiredFinalizedSource) {
      throw new Error(uiText(
        `无法固定第 ${previousChapterNumber} 章的必需定稿来源，已停止生成。请修复或重新定稿该章后再试。`,
        `The required finalized source for Chapter ${previousChapterNumber} could not be fixed, so generation stopped. Repair or re-finalize that chapter and try again.`,
      ))
    }
    const chapterMaterials = assembleChapterMaterials({
      writingLanguage,
      authorProjectFacts: [coreOutline, worldSetting, goldenFinger, protagonistProfile]
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim())),
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
    if (chapterMaterials.omissions.length > 0) {
      callbacks.log(uiText(
        `  可选材料覆盖缺口：${chapterMaterials.omissions.length} 项`,
        `  Optional material coverage gaps: ${chapterMaterials.omissions.length}`,
      ))
    }
    const chapterLengthContract = promptLanguageText(
      writingLanguage,
      `【本章篇幅合同】\n用户目标 ${targetChars} 字；可接受范围 ${lowerTargetChars}–${upperTargetChars} 字（±20%）。在此篇幅内完整落实本章蓝图中的全部作者任务和必需事件；不得为满足篇幅而删除、改写或截断这些要求，不要为凑字数增加无关内容。`,
      `[Chapter length contract]\nThe user's target is ${targetChars} words; the acceptable range is ${lowerTargetChars}-${upperTargetChars} words (±20%). Within this length, fully realize every author task and required event in the chapter blueprint; do not delete, rewrite, or truncate those requirements to meet the range, and do not add unrelated content just to fill space.`,
    )
    const executionItems = [
      { zhCN: '必需事件', enUS: 'Required events', value: this.chapterInfo.keyEvents },
      { zhCN: '章节钩子', enUS: 'Chapter hook', value: this.chapterInfo.suspenseHook },
      { zhCN: '作者本章指导', enUS: 'Author guidance for this chapter', value: this.chapterInfo.userGuidance },
    ]
    const chapterExecutionCard = executionItems.some(item => item.value?.trim())
      ? promptLanguageText(
          writingLanguage,
          `【本章执行卡（作者原文重列）】\n以下非空项是当前章应落实的动作和收束，不是新增事实。请在输出前核对各项已通过正文动作或结果落实；后一项动作必须承接正文实际形成的物品持有、人物知情和计划完成状态。\n${executionItems.flatMap(item => item.value?.trim() ? [`- ${item.zhCN}: ${item.value}`] : []).join('\n')}`,
          `[Current-chapter execution card (author text repeated verbatim)]\nThe non-empty items below are current-chapter actions and end states, not new facts. Before output, check that each item is realized through manuscript action or outcome. Each later action must continue from the item ownership, character knowledge, and plan-completion state actually established in the prose.\n${executionItems.flatMap(item => item.value?.trim() ? [`- ${item.enUS}: ${item.value}`] : []).join('\n')}`,
        )
      : ''
    const prompt = [chapterMaterials.text, promptBuilder.build(), chapterExecutionCard, chapterLengthContract]
      .filter(Boolean)
      .join('\n\n')
    const previousEnding = chapterMaterials.previousEnding

    callbacks.log(uiText(
      '调用 AI 生成章节草稿...',
      'Calling AI to generate the chapter draft...',
    ))
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
      try {
        const generationModelId = workflowGenerationModelId(context)
        runtime = await this.dependencies.createRuntime({
          budget: DRAFT_GENERATION_BUDGET,
          ...(generationModelId ? { modelId: generationModelId } : {}),
        })
        cleanDraftText = await runtime.execute(async ({ session }) => {
          const draftingSession = injectWritingSkillIntoSession(session, context, 'drafting')
          if (context.writingSkills?.drafting) {
            callbacks.log(uiText(
              `本次 drafting 阶段使用已冻结写作 Skill：${context.writingSkills.drafting.name}`,
              `Using the workflow-start-frozen writing skill for drafting: ${context.writingSkills.drafting.name}`,
            ))
          }
          this.assertNotCancelled(context)
          callbacks.setProgress(10)
          const preview = createDraftStreamPreview(
            callbacks.replaceText,
            visibleDraftStreamText,
          )
          let initialOutcome: GenerationOutcome
          try {
            initialOutcome = await draftingSession.complete({
              purpose: 'chapter-draft',
              reasoningStage: 'drafting',
              output: 'visible-text',
              messages: [
                { role: 'system', content: promptBuilder.getSystemRole() },
                { role: 'user', content: prompt },
              ],
            }, {
              signal: cancellation.signal,
              onChunk: chunk => {
                if (context.cancelled) return
                preview.push(chunk)
              },
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
          const initialVisibleDraft = sanitizeDraftText(this.stripThinkingTags(initialCompletion.content))
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
            signal: cancellation.signal,
            initialDraft: initialVisibleDraft,
            initialFinishReason: initialCompletion.finishReason,
            targetChars,
            callbacks,
            context,
            systemRole: promptBuilder.getSystemRole(),
            chapterInfo: writerChapterInfo,
            globalGuidance: mergedGuidance,
            writingStyle,
            novelConfigFacts: novelConfigFactsJson,
            chapterMaterials: chapterMaterials.text,
            writingLanguage,
            reasoning: initialOutcome.receipt.capabilities.reasoning === true,
            onRecoverableCandidate: candidate => { recoverableDraftCandidate = candidate },
          })
          recoverableDraftCandidate = completedDraft
          return completedDraft
        })
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
      if (hasSubstantialPreviousChapterReuse(previousEnding, cleanDraftText, writingLanguage)) {
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
          .filter(candidate => !finalizedDraftIds.has(candidate.draftId))
          .map(async candidate => ({
            draftId: candidate.draftId,
            contentHash: await sha256Hex(candidate.content),
          })),
      )
      const createResult = await ipc.invokeWithProjectSession(projectSession, 'db:draft-create', {
        chapterNumber: this.chapterInfo.chapterNumber,
        version: nextVersion,
        source: 'write',
        content: cleanDraftText,
        wordCount: countDraftUnits(cleanDraftText),
        sourceDependencies: [...candidateDependencies, ...finalizedDependencies],
      }, expectedProjectPath)
      if (!createResult.success || !createResult.id) {
        throw new Error(createResult.error || uiText('章节草稿保存失败', 'Failed to save the chapter draft.'))
      }
      this.assertNotCancelled(context)
      draftPersisted = true
      callbacks.replaceText?.(cleanDraftText)

      const pseudoPath = createResult.id ? `vela://draft/${createResult.id}` : `vela://draft/ch${this.chapterInfo.chapterNumber}/v${nextVersion}`

      context.data.draft = cleanDraftText
      context.data.draftContent = cleanDraftText
      context.data.draftPath = pseudoPath
      context.data.draftId = createResult.id
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
    } catch (error) {
      if (!draftPersisted && recoverableDraftCandidate) {
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
      } else if (!draftPersisted) {
        callbacks.replaceText?.('')
      }
      throw error
    }
  }

  private shouldAutoContinue(
    currentText: string,
    targetChars: number,
    rounds: number,
    finishReason: LLMCompletion['finishReason'],
  ): boolean {
    if (rounds >= MAX_AUTO_CONTINUE_ROUNDS) return false
    const currentChars = countDraftUnits(currentText)
    if (finishReason === 'stop') {
      return currentChars < Math.floor(targetChars * MIN_TARGET_COMPLETION_RATIO)
    }
    return finishReason === 'length'
  }

  private async extendDraftIfNeeded(params: {
    session: GenerationSession
    signal: AbortSignal
    initialDraft: string
    initialFinishReason: LLMCompletion['finishReason']
    targetChars: number
    callbacks: CommandExecuteParams['callbacks']
    context: CommandExecuteParams['context']
    systemRole: string
    chapterInfo: WriterChapterInfo
    globalGuidance: string
    writingStyle: string
    novelConfigFacts: string
    chapterMaterials: string
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
    let rounds = 0
    let lastFinishReason = params.initialFinishReason
    let noProgressRecoveryUsed = false
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

      const remaining = Math.max(0, params.targetChars - currentChars)
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
      const continuationPrompt = promptLanguageText(
        params.writingLanguage,
        `${recoveryInstruction}请无缝续写当前章节正文。

【硬性要求】
- 只输出新增正文，不要复述已写内容。
- 从“已写正文末尾”自然接下去，保持同一场景逻辑或合理转场。
- 本次续写尽可能完成剩余约 ${remaining} 字；如果无法达到，停在自然段落末尾。
- 不要输出标题、解释、总结、Markdown、思考过程或“点我继续”。
- 避免重复已写正文中的整句、整段、动作链和意象。
- 不提前写后续章节，只完成本章蓝图允许的内容。

【本章蓝图】
${JSON.stringify(params.chapterInfo, null, 2)}

【全局写作要求】
${params.globalGuidance}

【文风要求】
${params.writingStyle || '（无）'}

【小说配置事实】
${params.novelConfigFacts}

${params.chapterMaterials}

【已写正文末尾】
${visibleTail}`,
        `${recoveryInstruction}Continue the current chapter seamlessly.

[Requirements]
- Output only new manuscript prose; do not repeat existing text.
- Continue naturally from the existing ending, preserving the same scene logic or making a justified transition.
- Complete as much as possible of the remaining approximately ${remaining} words; if that is not possible, stop at a natural paragraph boundary.
- Do not output a title, explanation, summary, Markdown, reasoning, or an interface continuation prompt.
- Avoid repeating complete sentences, paragraphs, action sequences, or imagery from the existing manuscript.
- Complete only the current chapter blueprint; do not advance later chapters.

[Current chapter blueprint]
${JSON.stringify(params.chapterInfo, null, 2)}

[Project-wide writing guidance]
${params.globalGuidance}

[Writing style]
${params.writingStyle || '(none)'}

[Novel configuration facts]
${params.novelConfigFacts}

${params.chapterMaterials}

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
          messages: [
            { role: 'system', content: params.systemRole },
            { role: 'user', content: continuationPrompt },
          ],
        }, {
          signal: params.signal,
          onChunk: chunk => {
            if (params.context.cancelled) return
            preview.push(chunk)
          },
        })
      } catch (error) {
        params.onRecoverableCandidate(preview.snapshot())
        throw error
      } finally {
        preview.stop()
      }
      const addition = completionFromOutcome(outcome)
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
      draft = candidateDraft
      params.onRecoverableCandidate(draft)
      params.callbacks.replaceText?.(draft)
      lastFinishReason = addition.finishReason
      recoveryPending = false
      if (mergedDelta < 300) break
    }

    this.assertNotCancelled(params.context)
    if (lastFinishReason !== 'stop') {
      const error = this.createIncompleteCompletionError(lastFinishReason)
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

    const lowerBound = Math.floor(params.targetChars * MIN_TARGET_COMPLETION_RATIO)
    if (countDraftUnits(draft) < lowerBound) {
      throw new Error(
        uiText(
          `模型已声明生成结束，但正文仅约 ${countDraftUnits(draft)}/${params.targetChars} 字，明显未达到章节目标，结果未保存。` +
            '请提高最大输出 Tokens、降低本章目标字数，或改用输出能力更强的模型后重试。',
          `The model reported completion, but the draft is only about ${countDraftUnits(draft)}/${params.targetChars} units and clearly misses the chapter target, so it was not saved. ` +
            'Increase the maximum output tokens, lower the chapter target, or use a model with greater output capacity and try again.',
        ),
      )
    }

    return draft
  }

  // --- 抽取自原文件的辅助方法 ---
  private async readArchitecture(projectPath: string, projectSession: ProjectSessionContext): Promise<string> {
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
    const parts: string[] = []
    if (core?.premise) parts.push(core.premise.trim())
    if (core?.worldbuilding) parts.push(core.worldbuilding.trim())
    if (core?.synopsis) parts.push(core.synopsis.trim())
    return parts.join('\n\n---\n\n')
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
        const sourceRead = await ipc.invokeWithProjectSession(
          projectSession,
          'db:continuity-read-source',
          projection.draftId,
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
          draftId: projection.draftId,
          title: projection.chapterTitle,
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
