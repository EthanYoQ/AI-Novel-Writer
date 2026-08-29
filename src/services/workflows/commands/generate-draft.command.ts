import { BaseWorkflowCommand, CommandExecuteParams, type LLMCompletion } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { requireWorkflowProjectSession, workflowWritingLanguage } from '../workflow-project-session'
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
import { promptLanguageText } from '../../prompt-language'

const CONTINUE_PROMPT_MAX_CHARS = 1600
const MIN_TARGET_COMPLETION_RATIO = 0.82
const MAX_AUTO_CONTINUE_ROUNDS = 7
const MAX_TARGET_OVERAGE_RATIO = 0.12
const PREVIOUS_ENDING_MAX_CHARS = 1000
const CHINESE_CHARACTER_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu
const ENGLISH_WORD_PATTERN = /[A-Za-z]+(?:['’][A-Za-z]+)*/g
const WHITESPACE_OR_PUNCTUATION_PATTERN = /[\s\p{P}\p{S}]/gu

export function countDraftUnits(text: string): number {
  const englishWords = text.match(ENGLISH_WORD_PATTERN)?.length ?? 0
  const withoutEnglishWords = text.replace(ENGLISH_WORD_PATTERN, '')
  const chineseCharacters = withoutEnglishWords.match(CHINESE_CHARACTER_PATTERN)?.length ?? 0
  const otherCharacters = withoutEnglishWords
    .replace(CHINESE_CHARACTER_PATTERN, '')
    .replace(WHITESPACE_OR_PUNCTUATION_PATTERN, '')
    .length
  return chineseCharacters + englishWords + otherCharacters
}

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
  for (let length = 1; length < longestTag; length += 1) {
    const suffix = lower.slice(-length)
    if (THINKING_TAGS.some(tag => tag.startsWith(suffix))) {
      safeEnd = rawText.length - length
    }
  }
  return sanitizeDraftText(rawText.slice(0, safeEnd))
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
  return content.slice(-PREVIOUS_ENDING_MAX_CHARS)
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
  phase: string,
  receipt: GenerationAttemptReceipt,
): void {
  callbacks.log(
    `  ${phase}：租约请求上限 ${receipt.budget.requestedOutputTokens} Tokens` +
    `（单次上限 ${receipt.budget.maxRequestedOutputTokensPerAttempt}，` +
    `累计 ${receipt.budget.cumulativeRequestedOutputTokens}/${receipt.budget.maxRequestedOutputTokens}）`,
  )
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

function takeSentenceBoundaryWithin(text: string, maxChars: number): string {
  let units = 0
  let boundaryIndex = -1
  let segmentStart = 0

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (!'。！？….?!'.includes(char)) continue

    let candidateBoundary = index + 1
    while (candidateBoundary < text.length && '”’」』）】'.includes(text[candidateBoundary])) {
      candidateBoundary += 1
    }
    units += countDraftUnits(text.slice(segmentStart, candidateBoundary))
    if (units > maxChars) break
    boundaryIndex = candidateBoundary
    segmentStart = candidateBoundary
    index = candidateBoundary - 1
  }

  return boundaryIndex > 0 ? text.slice(0, boundaryIndex).trim() : ''
}

function capDraftAtNaturalBoundary(text: string, maxChars: number): string {
  const cleaned = sanitizeDraftText(text)
  if (countDraftUnits(cleaned) <= maxChars) return cleaned

  const paragraphs = cleaned.split(/\n\s*\n/).map(paragraph => paragraph.trim()).filter(Boolean)
  let capped = ''

  for (const paragraph of paragraphs) {
    const candidate = capped ? `${capped}\n\n${paragraph}` : paragraph
    if (countDraftUnits(candidate) <= maxChars) {
      capped = candidate
      continue
    }

    const remaining = maxChars - countDraftUnits(capped)
    const sentence = takeSentenceBoundaryWithin(paragraph, remaining)
    if (sentence) capped = capped ? `${capped}\n\n${sentence}` : sentence
    break
  }

  return capped.trim()
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
    const expectedProjectPath = this.chapterInfo.projectPath
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) {
      throw new Error('当前项目已切换，章节生成已停止')
    }
    const novelConfig = Object.freeze({ ...project.novelConfig })
    const writingLanguage = workflowWritingLanguage(context)

    callbacks.log('拼装章节上下文 (强类型注入中)...')

    const architecture = await this.readArchitecture(expectedProjectPath, projectSession)
    const projectPrompts = await this.readProjectPrompts(
      expectedProjectPath,
      projectSession,
      writingLanguage,
    )
    const mergedGuidance = [novelConfig.globalGuidance || '', projectPrompts].filter(Boolean).join('\n\n')

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
    if (!template) throw new Error(`未找到模板: ${templateKey}`)

    // ==========================================
    // Prompt 构建——按「稳定前缀 → 可变后缀」排列
    // 以最大化 LLM 上下文缓存命中率
    // ==========================================
    const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
      // ---- 缓存命中区（跨章稳定，前缀对齐）----
      .withArchitecture(architecture)
      .withGlobalGuidance(mergedGuidance)
      .withWritingStyle(novelConfig.writingStyle || '')
      .withNovelConfig(novelConfig)
      .withWordNumber(normalizeChapterWordsTarget(this.chapterInfo.wordsTarget, novelConfig.wordsPerChapter))
      // ---- 章节公共区（首章与后续章都必须完整注入）----
      .withChapterInfo(this.chapterInfo)
      .withFutureBlueprints(futureBlueprintsStr)
      .withUserGuidance(this.chapterInfo.userGuidance?.trim() || promptLanguageText(
        writingLanguage,
        '（无微操指导）',
        '(no author guidance)',
      ))

    if (!isFirstChapter) {
      // 从蓝图 JSON 的 notes 字段读取章节要点时间线（按序拼装，利于前缀缓存）
      const chapterTimeline = await this.readChapterNotesTimeline(
        expectedProjectPath,
        this.chapterInfo.chapterNumber,
        projectSession,
        writingLanguage,
        this.chapterInfo.characters,
      )
      callbacks.log(`  📋 已加载章节要点与连续性事实（${chapterTimeline.factCount} 条）`)

      let previousEnding = this.previousDraftEnding ?? ''
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
        callbacks.log('  🔍 检索知识库相关片段...')
        let searchQuery = `${this.chapterInfo.title} ${this.chapterInfo.keyEvents} ${this.chapterInfo.characters.join(' ')}`
        if (this.chapterInfo.knowledgeQueryHint?.trim()) {
          searchQuery += ` ${this.chapterInfo.knowledgeQueryHint.trim()}`
          callbacks.log(`  📌 追加用户检索关键词：${this.chapterInfo.knowledgeQueryHint.trim()}`)
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
        .withGlobalSummary(chapterTimeline.text)
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

    callbacks.log('调用 AI 生成章节草稿...')
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
          this.assertNotCancelled(context)
          callbacks.setProgress(10)
          let rawPreview = ''
          let previewActive = true
          let initialOutcome: GenerationOutcome
          try {
            initialOutcome = await session.complete({
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
                if (!previewActive || context.cancelled) return
                rawPreview += chunk
                callbacks.replaceText?.(visibleDraftStreamText(rawPreview))
              },
            })
          } finally {
            previewActive = false
          }
          const initialCompletion = completionFromOutcome(initialOutcome)
          logDraftAttempt(callbacks, '初始生成', initialOutcome.receipt)
          callbacks.log(`  初始生成响应结束：finishReason=${initialCompletion.finishReason}`)
          const initialVisibleDraft = sanitizeDraftText(this.stripThinkingTags(initialCompletion.content))
          callbacks.log(`  初始生成可见单位：visibleUnits=${countDraftUnits(initialVisibleDraft)}`)
          callbacks.replaceText?.(initialVisibleDraft)
          callbacks.setProgress(90)
          this.assertNotCancelled(context)
          return this.extendDraftIfNeeded({
            session,
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
            writingStyle: novelConfig.writingStyle || '',
            writingLanguage,
            reasoning: initialOutcome.receipt.capabilities.reasoning === true,
          })
        })
      } catch (error) {
        if (context.cancelled) throw new Error('工作流已取消')
        throw error
      } finally {
        cancellation.dispose()
        if (runtime) {
          try { await runtime.close() } catch { /* execute close failure already fails before persistence */ }
        }
      }
      this.assertNotCancelled(context)
      const boundedDraftText = capDraftAtNaturalBoundary(cleanDraftText, maxDraftChars)
      if (!boundedDraftText) {
        throw new Error('草稿超过目标字数容差，且无法在自然句或段落边界内安全截断，结果未保存。')
      }
      if (boundedDraftText !== cleanDraftText) {
        callbacks.log(`  草稿超过目标容差，已在自然边界收束至约 ${countDraftUnits(boundedDraftText)}/${targetChars} 字`)
      }

      // 落于数据库
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) {
        throw new Error('当前项目已切换，已拒绝保存章节草稿')
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
        content: boundedDraftText,
        wordCount: boundedDraftText.length,
      }, expectedProjectPath)
      if (!createResult.success || !createResult.id) {
        throw new Error(createResult.error || '章节草稿保存失败')
      }
      this.assertNotCancelled(context)
      draftPersisted = true
      callbacks.replaceText?.(boundedDraftText)

      const pseudoPath = createResult.id ? `vela://draft/${createResult.id}` : `vela://draft/ch${this.chapterInfo.chapterNumber}/v${nextVersion}`

      context.data.draft = boundedDraftText
      context.data.draftContent = boundedDraftText
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
        )) throw new Error('当前项目已切换，已拒绝打开旧草稿')
        const { useEditorStore } = await import('../../../stores/editor-store')
        useEditorStore.getState().openFile({
          id: pseudoPath,
          name: `第${this.chapterInfo.chapterNumber}章 ${this.chapterInfo.title} v${nextVersion}`,
          type: 'chapter',
          filePath: pseudoPath,
          content: boundedDraftText,
          savedContent: boundedDraftText,
          projectKey: expectedProjectPath,
        })
      } catch { /* 忽略 */ }

      callbacks.log(`✅ 草稿已自动入库保存为版本 v${nextVersion}（${boundedDraftText.length} 字）`)
      return boundedDraftText
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
    writingLanguage: WritingLanguage
    reasoning: boolean
  }): Promise<string> {
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
        '模型的输出预算主要消耗在推理阶段，尚未产生足够正文。无法安全续接隐藏推理过程；' +
        '请关闭模型思考模式、提高最大输出 Tokens，或改用更适合正文创作的非推理模型。',
      )
    }

    while (this.shouldAutoContinue(draft, params.targetChars, rounds, lastFinishReason)) {
      if (params.context.cancelled) break
      rounds += 1
      const currentChars = countDraftUnits(draft)
      params.callbacks.log(`  自动续写第 ${rounds} 段：当前约 ${currentChars}/${params.targetChars} 字`)

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

[End of existing manuscript]
${visibleTail}`,
      )

      let rawPreview = ''
      let previewActive = true
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
            if (!previewActive || params.context.cancelled) return
            rawPreview += chunk
            params.callbacks.replaceText?.(appendVisibleDraftContinuation(
              draft,
              visibleDraftStreamText(rawPreview),
            ))
          },
        })
      } finally {
        previewActive = false
      }
      const addition = completionFromOutcome(outcome)
      logDraftAttempt(params.callbacks, `自动续写第 ${rounds} 段`, outcome.receipt)
      params.callbacks.log(`  自动续写第 ${rounds} 段响应结束：finishReason=${addition.finishReason}`)
      this.assertNotCancelled(params.context)
      const beforeChars = countDraftUnits(draft)
      const visibleAddition = sanitizeDraftText(this.stripThinkingTags(addition.content))
      const candidateDraft = appendVisibleDraftContinuation(
        draft,
        visibleAddition,
      )
      const mergedDelta = countDraftUnits(candidateDraft) - beforeChars
      const accepted = addition.finishReason === 'stop' || mergedDelta >= 300
      params.callbacks.log(
        `  自动续写可见单位：visibleUnitsBefore=${beforeChars} `
        + `candidateVisibleUnits=${countDraftUnits(visibleAddition)} `
        + `mergedDelta=${mergedDelta} accepted=${accepted}`,
      )
      if (addition.finishReason === 'length' && mergedDelta < 300) {
        params.callbacks.replaceText?.(draft)
        if (noProgressRecoveryUsed) {
          throw new Error('唯一一次无进展恢复请求仍未增加足够的新正文，结果未保存。请缩短章节目标后重试。')
        }
        noProgressRecoveryUsed = true
        recoveryPending = true
        lastFinishReason = addition.finishReason
        params.callbacks.log('  本轮低增量截断内容已丢弃，将使用剩余预算执行一次无进展恢复请求')
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
      throw this.createIncompleteCompletionError(lastFinishReason)
    }

    const lowerBound = Math.floor(params.targetChars * MIN_TARGET_COMPLETION_RATIO)
    if (countDraftUnits(draft) < lowerBound) {
      throw new Error(
        `模型已声明生成结束，但正文仅约 ${countDraftUnits(draft)}/${params.targetChars} 字，明显未达到章节目标，结果未保存。` +
        '请提高最大输出 Tokens、降低本章目标字数，或改用输出能力更强的模型后重试。',
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
}
