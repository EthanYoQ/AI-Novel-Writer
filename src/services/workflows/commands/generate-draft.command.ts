import { BaseWorkflowCommand, CommandExecuteParams, type LLMCompletion } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { requireWorkflowProjectSession } from '../workflow-project-session'
import {
  DIR_PROMPTS
} from '../../../shared/project-paths'
import type { ChapterInfo } from '../chapter-workflow'
import { normalizeChapterWordsTarget } from '../chapter-creation-parameters'
import { appendVisibleTextContinuation } from '../bounded-completion'
import { stripThinkingTags } from '../workflow-utils'

const CONTINUE_PROMPT_MAX_CHARS = 1600
const MIN_TARGET_COMPLETION_RATIO = 0.82
const MAX_AUTO_CONTINUE_ROUNDS = 7
const MAX_TARGET_OVERAGE_RATIO = 0.12
const INPUT_CHARS_PER_TOKEN = 1
const SAFE_DEFAULT_MODEL_MAX_TOKENS = 4096
const UNKNOWN_CONTEXT_SAFE_WINDOW_TOKENS = 8192
const CONTEXT_SAFETY_RESERVE_TOKENS = 512
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

function maxDraftCharsForTarget(targetChars: number): number {
  return Math.floor(targetChars * (1 + MAX_TARGET_OVERAGE_RATIO))
}

export interface DraftModelLimits {
  /** `null` means the model did not declare a context window; it is not a guessed model limit. */
  contextWindowTokens: number | null
  /** The request output ceiling, resolved from new capability metadata or legacy maxTokens. */
  maxOutputTokens: number
  /** Whether the endpoint may consume output budget on hidden reasoning. */
  reasoning: boolean
}

function positiveTokenLimit(value: unknown): number | null {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Resolve persisted model data at the workflow boundary. Older profiles only
 * have `maxTokens`; unknown or malformed context windows must remain unknown,
 * rather than becoming a fabricated provider limit.
 */
export function resolveDraftModelLimits(model?: {
  maxTokens?: unknown
    capabilities?: {
      contextWindowTokens?: unknown
      maxOutputTokens?: unknown
      reasoning?: unknown
  } | null
} | null): DraftModelLimits {
  return {
    contextWindowTokens: positiveTokenLimit(model?.capabilities?.contextWindowTokens),
    maxOutputTokens: positiveTokenLimit(model?.capabilities?.maxOutputTokens)
      ?? positiveTokenLimit(model?.maxTokens)
      ?? SAFE_DEFAULT_MODEL_MAX_TOKENS,
    reasoning: model?.capabilities?.reasoning === true,
  }
}

function defaultModelLimits(): DraftModelLimits {
  const { defaultModelId, models } = useLLMStore.getState()
  return resolveDraftModelLimits(models.find(model => model.id === defaultModelId))
}

function estimatedPromptTokens(prompt: string): number {
  // Prompt estimation is intentionally conservative for Chinese text. It is
  // used only to protect the context window, never to derive an output budget
  // from the requested chapter length.
  return Math.ceil(prompt.length / INPUT_CHARS_PER_TOKEN)
}

interface DraftRequestBudget {
  maxTokens: number
  contextCapacityTokens: number
  contextWindowDeclared: boolean
}

function resolveDraftRequestBudget(
  prompt: string,
  systemPrompt: string,
  modelLimits: DraftModelLimits,
): DraftRequestBudget {
  const inputTokens = estimatedPromptTokens(`${systemPrompt}\n${prompt}`)
  const contextWindowTokens = modelLimits.contextWindowTokens ?? UNKNOWN_CONTEXT_SAFE_WINDOW_TOKENS
  const contextCapacityTokens = contextWindowTokens - inputTokens - CONTEXT_SAFETY_RESERVE_TOKENS
  if (contextCapacityTokens <= 0) {
    const source = modelLimits.contextWindowTokens === null
      ? `当前模型未声明上下文窗口，本次按保守窗口 ${UNKNOWN_CONTEXT_SAFE_WINDOW_TOKENS} tokens 估算`
      : `模型已声明上下文窗口 ${contextWindowTokens} tokens`
    throw new Error(
      `${source}；当前输入上下文预算扣除 Prompt 约 ${inputTokens} tokens 与安全余量 ` +
      `${CONTEXT_SAFETY_RESERVE_TOKENS} 后，已无安全输出空间。` +
      '请缩短项目设定、提示词或前文，或选择上下文窗口更大的模型后重试。',
    )
  }
  return {
    maxTokens: Math.min(modelLimits.maxOutputTokens, contextCapacityTokens),
    contextCapacityTokens,
    contextWindowDeclared: modelLimits.contextWindowTokens !== null,
  }
}

function logDraftRequestBudget(
  callbacks: CommandExecuteParams['callbacks'],
  phase: string,
  budget: DraftRequestBudget,
  modelLimits: DraftModelLimits,
): void {
  const contextLabel = budget.contextWindowDeclared ? '已声明上下文' : '保守上下文'
  callbacks.log(
    `  ${phase}：请求上限 ${budget.maxTokens} Tokens` +
    `（模型配置上限 ${modelLimits.maxOutputTokens}，${contextLabel}可用输出 ${budget.contextCapacityTokens}）`,
  )
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

  constructor(private chapterInfo: ChapterInfo) {
    super()
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

    callbacks.log('拼装章节上下文 (强类型注入中)...')

    const architecture = await this.readArchitecture(expectedProjectPath, projectSession)
    const projectPrompts = await this.readProjectPrompts(expectedProjectPath, projectSession)
    const mergedGuidance = [novelConfig.globalGuidance || '', projectPrompts].filter(Boolean).join('\n\n')

    const characterState = await this.readCharacterStates(expectedProjectPath, projectSession)
    let futureBlueprintsStr = '（无后续蓝图）'
    try {
      const { loadDirectoryBlueprints } = await import('../directory-workflow')
      const allBlueprints = await loadDirectoryBlueprints(expectedProjectPath, projectSession)
      const futureBlueprintsArr = allBlueprints.filter(
        b => b.chapterNumber > this.chapterInfo.chapterNumber && b.chapterNumber <= this.chapterInfo.chapterNumber + 5
      )
      if (futureBlueprintsArr.length > 0) {
        futureBlueprintsStr = futureBlueprintsArr.map(b => `第${b.chapterNumber}章 ${b.title}：${b.keyEvents}`).join('\n')
      }
    } catch { /* 忽略 */ }

    const isFirstChapter = this.chapterInfo.chapterNumber === 1
    const templateKey = isFirstChapter ? 'first_chapter_draft' : 'next_chapter_draft'
    const template = getPromptTemplate(templateKey, projectSession)
    if (!template) throw new Error(`未找到模板: ${templateKey}`)

    // ==========================================
    // Prompt 构建——按「稳定前缀 → 可变后缀」排列
    // 以最大化 LLM 上下文缓存命中率
    // ==========================================
    const promptBuilder = new ChapterPromptBuilder(template)
      // ---- 缓存命中区（跨章稳定，前缀对齐）----
      .withArchitecture(architecture)
      .withGlobalGuidance(mergedGuidance)
      .withWritingStyle(novelConfig.writingStyle || '')
      .withNovelConfig(novelConfig)
      .withWordNumber(normalizeChapterWordsTarget(this.chapterInfo.wordsTarget, novelConfig.wordsPerChapter))

    if (!isFirstChapter) {
      // 从蓝图 JSON 的 notes 字段读取章节要点时间线（按序拼装，利于前缀缓存）
      const chapterTimeline = await this.readChapterNotesTimeline(expectedProjectPath, this.chapterInfo.chapterNumber, projectSession)
      callbacks.log(`  📋 已加载章节要点时间线（${chapterTimeline.length} 字）`)

      let previousEnding = ''
      try {
        const prevNum = this.chapterInfo.chapterNumber - 1
        const meta = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-finalized', prevNum, expectedProjectPath)
        if (meta) {
          const full = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', meta.id, expectedProjectPath)
          if (full?.content) previousEnding = full.content.slice(-1000)
        }
      } catch { /* 忽略 */ }

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
          'kb:search',
          searchQuery,
          5,
          expectedProjectPath,
        ))
        filteredContext = results.length > 0
          ? results.map((r: { fileName: string; score: number; text: string }, i: number) => `[${i + 1}] (${r.fileName}, 相关度 ${(r.score * 100).toFixed(0)}%)\n${r.text}`).join('\n\n')
          : '（知识库中无相关内容）'
      } catch {
        filteredContext = '（知识库检索不可用）'
      }

      promptBuilder
        // ---- 缓存命中区续（要点时间线按序追加，前缀对齐）----
        .withGlobalSummary(chapterTimeline)
        .withCharacterStates(characterState)
        // ---- 缓存失效区（逐章变化）----
        .withPreviousEnding(previousEnding || '（无前文）')
        .withChapterInfo(this.chapterInfo)
        .withFutureBlueprints(futureBlueprintsStr)
        .withFilteredContext(filteredContext)
        .withShortSummary('')
        .withUserGuidance(this.chapterInfo.userGuidance?.trim() || '（无微操指导）')
    }

    // 输入与输出预算独立：输出上限来自模型配置，输入则必须为输出和
    // 上下文安全余量留出空间，不能把 legacy maxTokens 当作上下文窗口。
    const prompt = promptBuilder.build()
    const targetChars = normalizeChapterWordsTarget(this.chapterInfo.wordsTarget, novelConfig.wordsPerChapter)
    const maxDraftChars = maxDraftCharsForTarget(targetChars)
    const modelLimits = defaultModelLimits()
    const initialBudget = resolveDraftRequestBudget(prompt, promptBuilder.getSystemRole(), modelLimits)

    callbacks.log('调用 AI 生成章节草稿...')
    logDraftRequestBudget(callbacks, '初始生成', initialBudget, modelLimits)
    const initialCompletion = await this.callLLMResultWithBuilder(promptBuilder, callbacks, {
      thinking: false,
      maxTokens: initialBudget.maxTokens,
    }, context)
    callbacks.log(`  初始生成完成：finishReason=${initialCompletion.finishReason}`)
    this.assertNotCancelled(context)
    const cleanDraftText = await this.extendDraftIfNeeded({
      initialDraft: sanitizeDraftText(this.stripThinkingTags(initialCompletion.content)),
      initialFinishReason: initialCompletion.finishReason,
      targetChars,
      callbacks,
      context,
      systemRole: promptBuilder.getSystemRole(),
      chapterInfo: this.chapterInfo,
      futureBlueprints: futureBlueprintsStr,
      globalGuidance: mergedGuidance,
      writingStyle: novelConfig.writingStyle || '',
      modelLimits,
    })
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
  }

  private shouldAutoContinue(
    currentText: string,
    targetChars: number,
    rounds: number,
    finishReason: LLMCompletion['finishReason'],
  ): boolean {
    if (rounds >= MAX_AUTO_CONTINUE_ROUNDS) return false
    // `stop` means the provider declares this response complete. Only an
    // explicit output-length terminal state is eligible for continuation.
    if (finishReason !== 'length') return false
    const currentChars = countDraftUnits(currentText)
    return currentChars < maxDraftCharsForTarget(targetChars)
  }

  private async extendDraftIfNeeded(params: {
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
    modelLimits: DraftModelLimits
  }): Promise<string> {
    let draft = params.initialDraft
    let rounds = 0
    let lastFinishReason = params.initialFinishReason

    if (
      params.modelLimits.reasoning
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
      const continuationPrompt = `请无缝续写当前章节正文。

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
${visibleTail}`

      const continuationBudget = resolveDraftRequestBudget(
        continuationPrompt,
        params.systemRole,
        params.modelLimits,
      )
      logDraftRequestBudget(
        params.callbacks,
        `自动续写第 ${rounds} 段`,
        continuationBudget,
        params.modelLimits,
      )

      const addition = await this.callLLMResult(
        continuationPrompt,
        params.systemRole,
        params.callbacks,
        {
          thinking: false,
          maxTokens: continuationBudget.maxTokens,
        },
        params.context
      )
      params.callbacks.log(`  自动续写第 ${rounds} 段完成：finishReason=${addition.finishReason}`)
      this.assertNotCancelled(params.context)
      lastFinishReason = addition.finishReason
      const beforeChars = countDraftUnits(draft)
      draft = appendVisibleDraftContinuation(
        draft,
        this.stripThinkingTags(addition.content),
      )
      const afterChars = countDraftUnits(draft)
      if (afterChars - beforeChars < 300) {
        params.callbacks.log('  自动续写增量过短，停止继续请求')
        break
      }
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

  private async readProjectPrompts(projectPath: string, projectSession: ProjectSessionContext): Promise<string> {
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
          parts.push(`## 项目专属指导（${f.name.replace(/\.md$/, '')}）\n${result.content.trim()}`)
        }
      }
      return parts.join('\n\n')
    } catch { return '' }
  }

  private async readCharacterStates(projectPath: string, projectSession: ProjectSessionContext): Promise<string> {
    try {
      const allChars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
      const states: string[] = []
      for (const card of allChars) {
        if (card.name && card.currentState) {
          const cs = card.currentState
          states.push(
            `${card.name}（${card.role || '未知'}）| ` +
            `境界：${cs.powerLevel || '未知'} | ` +
            `位置：${cs.location || '未知'} | ` +
            `身体：${cs.physicalState || '正常'} | ` +
            `心理：${cs.mentalState || '正常'} | ` +
            `道具：${cs.keyItems || '无'} | ` +
            `最近：第${cs.updatedAtChapter || 0}章 ${cs.recentEvents || ''}`
          )
        }
      }
      return states.length > 0 ? `【角色状态档案】\n${states.join('\n')}` : '（暂无角色状态档案）'
    } catch { return '（角色状态档案读取失败）' }
  }

  /**
   * 从蓝图 JSON 的 notes 字段读取章节要点时间线。
   * 近 5 章完整收录；更早期仅保留标题行，控制总量 ≤ 3000 字。
   * 按序拼装保证前缀稳定，最大化 LLM 上下文缓存命中。
   */
  private async readChapterNotesTimeline(
    projectPath: string,
    currentChapter: number,
    projectSession: ProjectSessionContext,
  ): Promise<string> {
    const FULL_WINDOW = 5  // 近 N 章完整收录
    const MAX_CHARS = 3000 // 总量上限
    const lines: string[] = []

    for (let i = 1; i < currentChapter; i++) {
      try {
        const bp = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', i, projectPath)
        if (!bp) continue
        const isRecent = i >= currentChapter - FULL_WINDOW

        if (isRecent && bp.notes?.trim()) {
          // 近 N 章：完整收录要点
          lines.push(`【第${i}章 ${bp.title || ''}】\n${bp.notes.trim()}`)
        } else {
          // 远期章节：仅保留标题行（节省 Token）
          lines.push(`【第${i}章 ${bp.title || ''}】`)
        }
      } catch { /* 忽略单章读取失败 */ }
    }

    // Token 预算控制：超限时从最早的完整要点开始精简
    let result = lines.join('\n\n')
    if (result.length > MAX_CHARS) {
      // 保留近章完整内容，远期章节已经是标题行了
      result = result.slice(-MAX_CHARS)
    }

    return result || '（无章节要点）'
  }
}
