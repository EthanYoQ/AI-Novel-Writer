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
import { GENERATED_GLOBAL_GUIDANCE_MAX_CHARS } from '../novel-config-expansion'

export { countDraftUnits } from '../../../shared/draft-units'

const CONTINUE_PROMPT_MAX_CHARS = 1600
const DRAFT_AUTHOR_FACT_MAX_CHARS = 1000
const MIN_TARGET_COMPLETION_RATIO = 0.82
const MAX_AUTO_CONTINUE_ROUNDS = 7
const MAX_TARGET_OVERAGE_RATIO = 0.12
const PREVIOUS_ENDING_MAX_CHARS = 1000
const NEXT_CHAPTER_HEAD_MAX_CHARS = 1200
const CROSS_CHAPTER_REUSE_CJK_NGRAM_CHARS = 8
const CROSS_CHAPTER_REUSE_ENGLISH_NGRAM_CHARS = 20
const CROSS_CHAPTER_REUSE_LONG_RUN_CHARS = 80
const CROSS_CHAPTER_REUSE_TOTAL_CHARS = 36
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
): { push(chunk: string): void; stop(): void } {
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
    stop() {
      active = false
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

function maxDraftCharsForTarget(targetChars: number): number {
  return Math.floor(targetChars * (1 + MAX_TARGET_OVERAGE_RATIO))
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
  /**
   * Ephemeral ending from the immediately preceding draft in the same batch.
   * It is prompt-only context and must never be persisted as finalized state.
   */
  readonly previousDraftEnding?: string
  readonly dependencies?: Partial<GenerateDraftCommandDependencies>
}

const DEFAULT_DEPENDENCIES: GenerateDraftCommandDependencies = {
  createRuntime: options => createGenerationRuntime(options),
}

/** Use the same bounded previous-ending window for finalized and in-batch prose. */
export function previousChapterEnding(content: string): string {
  const trimmed = content.trim()
  if (trimmed.length <= PREVIOUS_ENDING_MAX_CHARS) return trimmed

  const tail = trimmed.slice(-PREVIOUS_ENDING_MAX_CHARS)
  const firstBoundary = /(?:\r?\n\s*\r?\n|[。！？!?][”’"'）)\]】」』]*|\.[”’"')\]]*(?=\s|$))/u.exec(tail)
  if (!firstBoundary) return tail.trim()

  return tail.slice(firstBoundary.index + firstBoundary[0].length).trim() || tail.trim()
}

function boundedPromptPrefix(content: string, maxChars: number): string {
  const trimmed = content.trim()
  if (trimmed.length <= maxChars) return trimmed

  const prefix = trimmed.slice(0, maxChars)
  const boundary = /(?:\r?\n|[。！？!?][”’"'）)\]】」』]*|\.[”’"')\]]*(?=\s|$))/gu
  let safeEnd = 0
  for (const match of prefix.matchAll(boundary)) {
    safeEnd = match.index + match[0].length
  }
  return prefix.slice(0, safeEnd || maxChars).trim()
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

  let matchedChars = 0
  let matchedRuns = 0
  let runLength = 0
  for (let index = 0; index <= covered.length; index += 1) {
    if (covered[index]) {
      runLength += 1
      continue
    }
    if (runLength >= CROSS_CHAPTER_REUSE_LONG_RUN_CHARS) return true
    if (runLength >= ngramCharacters) {
      matchedChars += runLength
      matchedRuns += 1
    }
    runLength = 0
  }
  return matchedRuns >= 2 && matchedChars >= CROSS_CHAPTER_REUSE_TOTAL_CHARS
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

/** Join a visible continuation without allowing a repeated prompt tail to count as new prose. */
export function appendVisibleDraftContinuation(draft: string, continuation: string): string {
  return appendVisibleTextContinuation(draft, continuation, sanitizeDraftText)
}

export class GenerateDraftCommand extends BaseWorkflowCommand {
  private readonly dependencies: GenerateDraftCommandDependencies
  private readonly previousDraftEnding: string | undefined

  constructor(
    private chapterInfo: ChapterInfo,
    options: GenerateDraftCommandOptions = {},
  ) {
    super()
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
    this.previousDraftEnding = options.previousDraftEnding
      ? previousChapterEnding(options.previousDraftEnding)
      : undefined
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
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
      boundedPromptPrefix(
        novelConfig.globalGuidance || '',
        GENERATED_GLOBAL_GUIDANCE_MAX_CHARS,
      ),
      projectPrompts,
    ].filter(Boolean).join('\n\n')

    const characterState = await this.readCharacterStates(
      expectedProjectPath,
      projectSession,
      writingLanguage,
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
    const writingStyle = boundedPromptPrefix(
      novelConfig.writingStyle || '',
      DRAFT_AUTHOR_FACT_MAX_CHARS,
    )
    const novelConfigFacts = {
      ...novelConfig,
      coreOutline: boundedPromptPrefix(novelConfig.coreOutline || '', DRAFT_AUTHOR_FACT_MAX_CHARS),
      worldSetting: boundedPromptPrefix(novelConfig.worldSetting || '', DRAFT_AUTHOR_FACT_MAX_CHARS),
      goldenFinger: boundedPromptPrefix(novelConfig.goldenFinger || '', DRAFT_AUTHOR_FACT_MAX_CHARS),
      protagonistProfile: boundedPromptPrefix(
        novelConfig.protagonistProfile || '',
        DRAFT_AUTHOR_FACT_MAX_CHARS,
      ),
      globalGuidance: undefined,
      writingStyle: undefined,
    }
    const novelConfigFactsJson = JSON.stringify(novelConfigFacts, null, 2)
    const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
      // ---- 缓存命中区（跨章稳定，前缀对齐）----
      .withArchitecture(architecture)
      .withGlobalGuidance(mergedGuidance)
      .withWritingStyle(writingStyle)
      .withNovelConfig(novelConfigFactsJson)
      .withWordNumber(normalizeChapterWordsTarget(this.chapterInfo.wordsTarget, novelConfig.wordsPerChapter))
      // ---- 章节公共区（首章与后续章都必须完整注入）----
      .withChapterInfo(this.chapterInfo)
      .withFutureBlueprints(futureBlueprintsStr)
      .withUserGuidance(this.chapterInfo.userGuidance?.trim() || promptLanguageText(
        writingLanguage,
        '（无微操指导）',
        '(no author guidance)',
      ))

    let previousEnding = ''
    if (!isFirstChapter) {
      // 从蓝图 JSON 的 notes 字段读取章节要点时间线（按序拼装，利于前缀缓存）
      const chapterTimeline = await this.readChapterNotesTimeline(
        expectedProjectPath,
        this.chapterInfo.chapterNumber,
        projectSession,
        writingLanguage,
        this.chapterInfo.characters,
      )
      callbacks.log(uiText(
        `  已加载章节要点与连续性事实（${chapterTimeline.factCount} 条）`,
        `  Loaded chapter notes and continuity facts (${chapterTimeline.factCount})`,
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

      previousEnding = this.previousDraftEnding ?? ''
      if (!previousEnding) {
        try {
          const prevNum = this.chapterInfo.chapterNumber - 1
          const meta = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-finalized', prevNum, expectedProjectPath)
          if (meta) {
            const full = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', meta.id, expectedProjectPath)
            if (full?.content) previousEnding = previousChapterEnding(full.content)
          }
        } catch { /* 忽略 */ }
      }

      let filteredContext = ''
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
        filteredContext = results.length > 0
          ? results.map((r: { fileName: string; score: number; text: string }, i: number) => promptLanguageText(
              writingLanguage,
              `[${i + 1}] (${r.fileName}, 相关度 ${(r.score * 100).toFixed(0)}%)\n${r.text}`,
              `[${i + 1}] (${r.fileName}, relevance ${(r.score * 100).toFixed(0)}%)\n${r.text}`,
            )).join('\n\n')
          : promptLanguageText(writingLanguage, '（知识库中无相关内容）', '(no relevant knowledge-base context)')
      } catch {
        filteredContext = promptLanguageText(writingLanguage, '（知识库检索不可用）', '(knowledge-base search unavailable)')
      }

      promptBuilder
        // ---- 缓存命中区续（要点时间线按序追加，前缀对齐）----
        .withGlobalSummary([chapterTimeline.text, activeThreads.text].filter(Boolean).join('\n\n'))
        .withCharacterStates(characterState)
        // ---- 缓存失效区（逐章变化）----
        .withPreviousEnding(previousEnding || promptLanguageText(
          writingLanguage,
          '（无前文）',
          '(no previous manuscript)',
        ))
        .withFilteredContext(filteredContext)
        .withShortSummary('')
    }

    const prompt = promptBuilder.build()
    const targetChars = normalizeChapterWordsTarget(this.chapterInfo.wordsTarget, novelConfig.wordsPerChapter)
    const maxDraftChars = maxDraftCharsForTarget(targetChars)

    callbacks.log(uiText(
      '调用 AI 生成章节草稿...',
      'Calling AI to generate the chapter draft...',
    ))
    let draftPersisted = false
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
            chapterInfo: this.chapterInfo,
            futureBlueprints: futureBlueprintsStr,
            globalGuidance: mergedGuidance,
            writingStyle,
            novelConfigFacts: novelConfigFactsJson,
            writingLanguage,
            reasoning: initialOutcome.receipt.capabilities.reasoning === true,
          })
          const completedUnits = countDraftUnits(completedDraft)
          if (completedUnits <= maxDraftChars) return completedDraft

          callbacks.log(uiText(
            `  草稿超过目标容差，将在当前模型会话中压缩至不超过 ${maxDraftChars} 个正文单位`,
            `  Draft exceeded the target tolerance; compressing it in the current model session to at most ${maxDraftChars} prose units`,
          ))
          const minimumDraftChars = Math.floor(targetChars * MIN_TARGET_COMPLETION_RATIO)
          const lengthRewritePrompt = (draft: string, currentUnits: number, final: boolean) => {
            const rewriteMaxDraftChars = final ? Math.floor(targetChars * 0.9) : maxDraftChars
            const paragraphCount = Math.max(4, Math.min(80, Math.round(rewriteMaxDraftChars / 100)))
            const paragraphUnits = Math.round(rewriteMaxDraftChars / paragraphCount)
            const rewriteChapterInfo = final
              ? { ...this.chapterInfo, wordsTarget: rewriteMaxDraftChars }
              : this.chapterInfo
            const sourceDraft = final ? previousChapterEnding(draft) : draft
            return promptLanguageText(
              writingLanguage,
              `${final
                ? '上一轮完整重写结果未落入本地长度范围；这是最终压缩阶段的有界完整重写。不要继续逐句删改上一稿；请从空白页重新写作。'
                : `当前完整章节经本地计数有 ${currentUnits} 个正文单位，需要压缩并完整重写。`}

【硬性要求】
- 只输出重写后的完整章节正文，不要解释、总结、Markdown 或思考过程。
${final
  ? `- 本次兜底写作目标为 ${rewriteMaxDraftChars} 个正文单位，不得超过 ${rewriteMaxDraftChars} 个正文单位；中文汉字与英文单词计数，标点和空白不计。`
  : `- 本地计数结果不得少于 ${minimumDraftChars} 个正文单位，也不得超过 ${rewriteMaxDraftChars} 个正文单位；中文汉字与英文单词计数，标点和空白不计。`}
${final ? `- 全章绝对不得超过 ${paragraphCount} 个自然段，每段不得超过约 ${paragraphUnits} 个正文单位；总计不得超过上述兜底目标。
- 对白必须并入人物动作、反应或环境描写所在的段落，不得让一句对白或单个动作独占一段。
- 交付前自行核对段落数与正文单位预算，不要输出核对过程。` : ''}
- 完整保留本章蓝图中的每一个事件、角色行动、因果关系与关键结果。
- 保留原稿结尾的最终事件与结果，并以完整、自然的句子或段落收束。
- 优先删除重复说明、复述、冗余对话和装饰性描写，不得用删除蓝图事件或结尾来满足长度。
- 不得只输出节选，不得提前写后续章节。

【本章蓝图】
${JSON.stringify(rewriteChapterInfo, null, 2)}

${final ? '【仅供事实核对的原稿结尾】' : '【待压缩的完整章节草稿】'}
${sourceDraft}`,
              `${final
                ? 'The previous full rewrite fell outside the local length range. This is a bounded full rewrite in the final compression stage. Do not keep line-editing the prior draft; rewrite it from a blank page.'
                : `The complete chapter currently contains ${currentUnits} locally counted prose units and must be compressed and rewritten in full.`}

[Requirements]
- Output only the complete rewritten chapter prose; do not include explanations, summaries, Markdown, or reasoning.
${final
  ? `- The fallback writing target is ${rewriteMaxDraftChars} prose units; do not exceed ${rewriteMaxDraftChars} prose units. Chinese Han characters and English words count, while punctuation and whitespace do not.`
  : `- The local count must be at least ${minimumDraftChars} prose units and no more than ${rewriteMaxDraftChars}; Chinese Han characters and English words count, while punctuation and whitespace do not.`}
${final ? `- Use no more than ${paragraphCount} natural paragraphs, with each paragraph no longer than about ${paragraphUnits} prose units; the total must not exceed the fallback target above.
- Fold dialogue into the paragraph containing character action, reaction, or setting; do not give one line of dialogue or one action its own paragraph.
- Before delivery, silently verify the paragraph count and prose-unit budget; do not output the verification.` : ''}
- Preserve every blueprint event, character action, causal link, and key outcome.
- Preserve the final event and outcome from the original ending, and finish with a complete, natural sentence or paragraph.
- Remove repeated explanation, recap, redundant dialogue, and decorative description first; never remove blueprint events or the ending to meet the limit.
- Do not output an excerpt and do not advance into later chapters.

[Current chapter blueprint]
${JSON.stringify(rewriteChapterInfo, null, 2)}

[${final ? 'Original ending for fact checking only' : 'Complete chapter draft to compress'}]
${sourceDraft}`,
            )
          }
          const repairPrompt = lengthRewritePrompt(
            completedDraft,
            completedUnits,
            false,
          )
          const repairOutcome = await draftingSession.complete({
            purpose: 'chapter-draft-length-repair',
            reasoningStage: 'drafting',
            output: 'visible-text',
            messages: [
              { role: 'system', content: promptBuilder.getSystemRole() },
              { role: 'user', content: repairPrompt },
            ],
          }, { signal: cancellation.signal })
          const repairCompletion = completionFromOutcome(repairOutcome)
          logDraftAttempt(
            callbacks,
            context,
            { zhCN: '章节长度修复', enUS: 'Chapter length repair' },
            repairOutcome.receipt,
          )
          this.assertNotCancelled(context)
          if (repairCompletion.finishReason !== 'stop') {
            throw new Error(uiText(
              '章节长度修复未完整结束，结果未保存。',
              'The chapter length repair did not complete, so the result was not saved.',
            ))
          }
          const repairedDraft = sanitizeDraftText(this.stripThinkingTags(repairCompletion.content))
          const repairedUnits = countDraftUnits(repairedDraft)
          if (repairedUnits > maxDraftChars || repairedUnits < minimumDraftChars) {
            callbacks.log(uiText(
              `  首次长度修复结果为 ${repairedUnits} 个正文单位，超出本地长度范围，将执行最后一次完整重写`,
              `  The first length repair has ${repairedUnits} prose units, outside the local length range; running one final full rewrite`,
            ))
            const finalOutcome = await draftingSession.complete({
              purpose: 'chapter-draft-length-final-rewrite',
              reasoningStage: 'drafting',
              output: 'visible-text',
              messages: [
                { role: 'system', content: promptBuilder.getSystemRole() },
                {
                  role: 'user',
                  content: lengthRewritePrompt(repairedDraft, repairedUnits, true),
                },
              ],
            }, { signal: cancellation.signal })
            const finalCompletion = completionFromOutcome(finalOutcome)
            logDraftAttempt(
              callbacks,
              context,
              { zhCN: '最终完整重写', enUS: 'Final full rewrite' },
              finalOutcome.receipt,
            )
            this.assertNotCancelled(context)
            if (finalCompletion.finishReason !== 'stop') {
              throw new Error(uiText(
                '最终完整重写未完整结束，结果未保存。',
                'The final full rewrite did not complete, so the result was not saved.',
              ))
            }
            let finalDraft = sanitizeDraftText(this.stripThinkingTags(finalCompletion.content))
            let finalUnits = countDraftUnits(finalDraft)
            if (finalUnits > maxDraftChars || finalUnits < minimumDraftChars) {
              callbacks.log(uiText(
                `  最终完整重写结果为 ${finalUnits} 个正文单位，超出本地长度范围，将执行唯一一次重写重试`,
                `  The final full rewrite has ${finalUnits} prose units, outside the local length range; running the single rewrite retry`,
              ))
              const retryOutcome = await draftingSession.complete({
                purpose: 'chapter-draft-length-final-rewrite-retry',
                reasoningStage: 'drafting',
                output: 'visible-text',
                messages: [
                  { role: 'system', content: promptBuilder.getSystemRole() },
                  {
                    role: 'user',
                    content: lengthRewritePrompt(finalDraft, finalUnits, true),
                  },
                ],
              }, { signal: cancellation.signal })
              const retryCompletion = completionFromOutcome(retryOutcome)
              logDraftAttempt(
                callbacks,
                context,
                { zhCN: '最终完整重写重试', enUS: 'Final full rewrite retry' },
                retryOutcome.receipt,
              )
              this.assertNotCancelled(context)
              if (retryCompletion.finishReason !== 'stop') {
                throw new Error(uiText(
                  '最终完整重写重试未完整结束，结果未保存。',
                  'The final full rewrite retry did not complete, so the result was not saved.',
                ))
              }
              finalDraft = sanitizeDraftText(this.stripThinkingTags(retryCompletion.content))
              finalUnits = countDraftUnits(finalDraft)
              if (finalUnits > maxDraftChars) {
                throw new Error(uiText(
                  `最终完整重写后仍超过 ${maxDraftChars} 个正文单位，结果未保存。`,
                  `The final full rewrite still exceeds ${maxDraftChars} prose units, so the result was not saved.`,
                ))
              }
            }
            if (finalUnits < minimumDraftChars) {
              throw new Error(uiText(
                '最终完整重写删减过多，结果未保存。',
                'The final full rewrite removed too much prose, so the result was not saved.',
              ))
            }
            callbacks.replaceText?.(finalDraft)
            return finalDraft
          }
          callbacks.replaceText?.(repairedDraft)
          return repairedDraft
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
      const createResult = await ipc.invokeWithProjectSession(projectSession, 'db:draft-create', {
        chapterNumber: this.chapterInfo.chapterNumber,
        version: nextVersion,
        source: 'write',
        content: cleanDraftText,
        wordCount: countDraftUnits(cleanDraftText),
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
      if (!draftPersisted) callbacks.replaceText?.('')
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
    if (finishReason !== 'length') return false
    return currentChars < maxDraftCharsForTarget(targetChars)
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
    chapterInfo: ChapterInfo
    futureBlueprints: string
    globalGuidance: string
    writingStyle: string
    novelConfigFacts: string
    writingLanguage: WritingLanguage
    reasoning: boolean
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

【后续章节大纲预告】
${params.futureBlueprints}

【全局写作要求】
${params.globalGuidance}

【文风要求】
${params.writingStyle || '（无）'}

【小说配置事实】
${params.novelConfigFacts}

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

[Upcoming chapter blueprints]
${params.futureBlueprints}

[Project-wide writing guidance]
${params.globalGuidance}

[Writing style]
${params.writingStyle || '(none)'}

[Novel configuration facts]
${params.novelConfigFacts}

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
      params.callbacks.replaceText?.(draft)
      lastFinishReason = addition.finishReason
      recoveryPending = false
      if (mergedDelta < 300) break
    }

    this.assertNotCancelled(params.context)
    // A length finish is always an incomplete physical response. Reaching a
    // word-count threshold is not proof that the model completed its sentence
    // or scene, so never persist it as a successful chapter.
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
    if (core?.charactersArch) parts.push(core.charactersArch.trim())
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

  private async readCharacterStates(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: WritingLanguage,
  ): Promise<string> {
    try {
      const allChars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
      const states: string[] = []
      for (const card of allChars) {
        if (card.name && card.currentState) {
          const cs = card.currentState
          states.push(promptLanguageText(
            writingLanguage,
            `${card.name}（${card.role || '未知'}）| `
              + `境界：${cs.powerLevel || '未知'} | `
              + `位置：${cs.location || '未知'} | `
              + `身体：${cs.physicalState || '正常'} | `
              + `心理：${cs.mentalState || '正常'} | `
              + `道具：${cs.keyItems || '无'} | `
              + `最近：第${cs.updatedAtChapter || 0}章 ${cs.recentEvents || ''}`,
            `${card.name} (${card.role || 'unknown'}) | `
              + `power: ${cs.powerLevel || 'unknown'} | `
              + `location: ${cs.location || 'unknown'} | `
              + `physical: ${cs.physicalState || 'normal'} | `
              + `mental: ${cs.mentalState || 'normal'} | `
              + `key items: ${cs.keyItems || 'none'} | `
              + `recent: chapter ${cs.updatedAtChapter || 0} ${cs.recentEvents || ''}`,
          ))
        }
      }
      return states.length > 0
        ? promptLanguageText(writingLanguage, `【角色状态档案】\n${states.join('\n')}`, `[Character state records]\n${states.join('\n')}`)
        : promptLanguageText(writingLanguage, '（暂无角色状态档案）', '(no character state records)')
    } catch {
      return promptLanguageText(writingLanguage, '（角色状态档案读取失败）', '(character state records unavailable)')
    }
  }

  /**
   * 从 finalized 定稿连续性投影读取章节要点时间线，旧蓝图 notes 仅作兼容回退。
   * 近 5 章完整收录；更早期仅保留标题行，控制总量 ≤ 3000 字。
   * 按序拼装保证前缀稳定，最大化 LLM 上下文缓存命中。
   */
  private async readChapterNotesTimeline(
    projectPath: string,
    currentChapter: number,
    projectSession: ProjectSessionContext,
    writingLanguage: WritingLanguage,
    currentEntities: readonly string[],
  ): Promise<{ text: string; factCount: number }> {
    const FULL_WINDOW = 5  // 近 N 章完整收录
    const MAX_CHARS = 3000 // 总量上限
    const FACT_BUDGET = 1500
    const lines: string[] = []
    const factCandidates: Array<{ text: string; entityRelevant: boolean; sourceChapter: number }> = []
    let finalizedContinuity: FinalizedContinuityProjection[] = []
    try {
      finalizedContinuity = await ipc.invokeWithProjectSession(
        projectSession,
        'db:continuity-list-before',
        currentChapter,
        projectPath,
      )
    } catch { /* 兼容未迁移的旧项目，逐章读取蓝图 notes */ }
    const continuityByChapter = new Map(
      finalizedContinuity.map(projection => [projection.chapterNumber, projection]),
    )

    for (let i = 1; i < currentChapter; i++) {
      try {
        const projection = continuityByChapter.get(i)
        const bp = projection
          ? null
          : await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', i, projectPath)
        if (!projection && !bp) continue
        const isRecent = i >= currentChapter - FULL_WINDOW
        const title = projection?.chapterTitle || bp?.title || ''
        const notes = projection?.chapterNotes || bp?.notes || ''
        for (const fact of projection?.facts ?? []) {
          const entityRelevant = fact.entities.some(entity => currentEntities.includes(entity))
            || currentEntities.some(entity => (
              fact.statement.includes(entity) || fact.evidence.includes(entity)
            ))
          if (!isRecent && !entityRelevant) continue
          factCandidates.push({
            text: promptLanguageText(
              writingLanguage,
              `- [${fact.category}] ${fact.statement}（来源第${fact.sourceChapter}章；证据：${fact.evidence}）`,
              `- [${fact.category}] ${fact.statement} (source: Chapter ${fact.sourceChapter}; evidence: ${fact.evidence})`,
            ),
            entityRelevant,
            sourceChapter: fact.sourceChapter,
          })
        }

        if (isRecent && notes.trim()) {
          // 近 N 章：完整收录要点
          lines.push(promptLanguageText(
            writingLanguage,
            `【第${i}章 ${title}】\n${notes.trim()}`,
            `[Chapter ${i}: ${title}]\n${notes.trim()}`,
          ))
        } else {
          // 远期章节：仅保留标题行（节省 Token）
          lines.push(promptLanguageText(
            writingLanguage,
            `【第${i}章 ${title}】`,
            `[Chapter ${i}: ${title}]`,
          ))
        }
      } catch { /* 忽略单章读取失败 */ }
    }

    const selectedFacts: string[] = []
    let usedFactChars = 0
    for (const candidate of factCandidates
      .sort((a, b) => Number(b.entityRelevant) - Number(a.entityRelevant) || b.sourceChapter - a.sourceChapter)
      .slice(0, 12)) {
      const nextLength = candidate.text.length + (selectedFacts.length > 0 ? 1 : 0)
      if (usedFactChars + nextLength > FACT_BUDGET) continue
      selectedFacts.push(candidate.text)
      usedFactChars += nextLength
    }
    const factBlock = selectedFacts.length > 0
      ? promptLanguageText(
          writingLanguage,
          `【已定稿连续性事实】\n${selectedFacts.join('\n')}`,
          `[Finalized continuity facts]\n${selectedFacts.join('\n')}`,
        )
      : ''
    const notesBudget = Math.max(MAX_CHARS - factBlock.length - (factBlock ? 2 : 0), 0)
    const notesText = lines.join('\n\n').slice(-notesBudget)
    const result = [notesText, factBlock].filter(Boolean).join('\n\n')

    return {
      text: result || promptLanguageText(writingLanguage, '（无章节要点）', '(no chapter notes)'),
      factCount: selectedFacts.length,
    }
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
