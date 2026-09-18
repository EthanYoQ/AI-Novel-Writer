import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ReviewPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { FinalizedContinuityProjection } from '../../../shared/finalized-continuity'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import {
  requireWorkflowProjectSession,
  workflowUiLocale,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { readConsistencyPreflight } from '../../consistency-preflight'
import { mergeConsistencyFindingsIntoReview, type ReviewLike } from '../../../shared/consistency-preflight'
import type { ChapterBlueprint } from '../directory-workflow'
import type { FrozenDraftSourceIdentity } from '../chapter-workflow'
import { throwIfSourceDraftChanged } from '../source-draft-changed'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../../shared/character-roster'
import {
  buildChapterGoalReviewBatchPrompt,
  buildChapterGoalReviewDeferredNote,
  buildChapterGoalReviewPrompt,
  chapterGoalReviewItems,
  freezeChapterGoals,
  normalizeChapterGoalReview,
  parseChapterGoalReviewBatch,
  splitChapterGoalsIntoBatches,
  type FrozenChapterGoals,
} from '../../../shared/chapter-goal-review'
import type { WritingLanguage } from '../../../shared/writing-language'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'


export interface ReviewChapterParams {
  draftPath: string
  draftContent: string
  sourceDraft?: FrozenDraftSourceIdentity
  chapterNumber: number
  /** 审稿维度侧重点（可选） */
  reviewFocus?: string
}

const REVIEW_SUMMARY_MAX_CHARACTERS = 120
const REVIEW_DESCRIPTION_MAX_CHARACTERS = 200
const REVIEW_QUOTE_MAX_CHARACTERS = 160

/**
 * 审稿注入世界观设定的上限 —— 比写稿（8 条 / 2400 字）**更紧**。
 *
 * 原因：审稿的问题清单有 `items ≤ 10` 的硬上限，且是**共享预算**——
 * 设定引起的误报挤进来，被挤掉的是真正的伏笔/连贯性问题。
 * 所以审稿这边宁可少给几条，也不要稀释信噪比。
 */
const REVIEW_WORLD_SETTING_MAX_ENTRIES = 5
const REVIEW_WORLD_SETTING_TOTAL_MAX_CHARS = 1600

interface ReviewResultItem extends Record<string, unknown> {
  category: string
  severity: 'error' | 'warning' | 'pass'
  description: string
  quote?: string
}

interface ReviewResult extends Record<string, unknown> {
  summary: string
  items: ReviewResultItem[]
  goalReviews?: unknown
}

function isBoundedText(value: unknown, maxCharacters: number): value is string {
  return typeof value === 'string'
    && Boolean(value.trim())
    && Array.from(value.trim()).length <= maxCharacters
}

function boundText(value: string, maxCharacters: number): string {
  return Array.from(value.trim()).slice(0, maxCharacters).join('')
}

function isReviewShape(value: unknown): value is ReviewResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const review = value as Record<string, unknown>
  if (Object.keys(review).some(key => key !== 'summary' && key !== 'items' && key !== 'goalReviews')
    || typeof review.summary !== 'string'
    || !Array.isArray(review.items)
    || review.items.length < 1
    || review.items.length > 10) return false
  return review.items.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    const severity = record.severity
    return !Object.keys(record).some(key => (
      key !== 'category'
      && key !== 'severity'
      && key !== 'description'
      && key !== 'quote'
    ))
      && typeof record.category === 'string'
      && (severity === 'error' || severity === 'warning' || severity === 'pass')
      && typeof record.description === 'string'
      && (record.quote === undefined
        ? severity === 'pass'
        : typeof record.quote === 'string')
  })
}

function isReviewResult(value: unknown): value is ReviewResult {
  return isReviewShape(value)
    && isBoundedText(value.summary, REVIEW_SUMMARY_MAX_CHARACTERS)
    && value.items.every(item => (
      Boolean(item.category.trim())
      && isBoundedText(item.description, REVIEW_DESCRIPTION_MAX_CHARACTERS)
      && (item.quote === undefined || isBoundedText(item.quote, REVIEW_QUOTE_MAX_CHARACTERS))
    ))
}

function parseReviewResult(content: string): ReviewResult {
  const trimmed = content.trim()
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
  const parsed: unknown = JSON.parse(fenced?.[1]?.trim() ?? trimmed)
  if (!isReviewShape(parsed)) throw new Error('invalid review contract')
  const bounded: ReviewResult = {
    ...(parsed.goalReviews === undefined ? {} : { goalReviews: parsed.goalReviews }),
    summary: boundText(parsed.summary, REVIEW_SUMMARY_MAX_CHARACTERS),
    items: parsed.items.map(item => ({
      category: item.category,
      severity: item.severity,
      description: boundText(item.description, REVIEW_DESCRIPTION_MAX_CHARACTERS),
      ...(item.quote === undefined
        ? {}
        : { quote: boundText(item.quote, REVIEW_QUOTE_MAX_CHARACTERS) }),
    })),
  }
  if (!isReviewResult(bounded)) throw new Error('invalid review contract')
  return bounded
}

function formatFinalizedHistory(
  projections: readonly FinalizedContinuityProjection[],
  writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
): string {
  const header = promptLanguageText(
    writingLanguage,
    '【已确认定稿历史｜唯一已发生事实源】',
    '[Finalized history | the only source of events that have already happened]',
  )
  if (projections.length === 0) return `${header}\n${promptLanguageText(
    writingLanguage,
    '（当前章节之前没有已定稿历史）',
    '(there is no finalized history before the current chapter)',
  )}`
  return [
    header,
    ...projections.map((projection) => {
      const facts = (projection.facts ?? []).map(fact => promptLanguageText(
        writingLanguage,
        `- [${fact.category}] ${fact.statement}（来源第${fact.sourceChapter}章；证据：${fact.evidence}）`,
        `- [${fact.category}] ${fact.statement} (source: Chapter ${fact.sourceChapter}; evidence: ${fact.evidence})`,
      ))
      return [
        promptLanguageText(
          writingLanguage,
          `### 第${projection.chapterNumber}章 ${projection.chapterTitle}`,
          `### Chapter ${projection.chapterNumber}: ${projection.chapterTitle}`,
        ),
        projection.chapterNotes,
        ...facts,
      ].filter(Boolean).join('\n')
    }),
  ].join('\n\n')
}

function formatReviewPlanningMaterial(
  blueprints: readonly ChapterBlueprint[],
  writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
): string {
  const header = promptLanguageText(
    writingLanguage,
    '【当前及未来蓝图/计划｜非既定历史】',
    '[Current and future blueprints/plans | not established history]',
  )
  if (blueprints.length === 0) return `${header}\n${promptLanguageText(
    writingLanguage,
    '（无当前或后续蓝图）',
    '(no current or future blueprints)',
  )}`
  const plans = blueprints.map(blueprint => ({
    chapterNumber: blueprint.chapterNumber,
    title: blueprint.title,
    role: blueprint.role,
    purpose: blueprint.purpose,
    keyEvents: blueprint.keyEvents,
    characters: blueprint.characters,
    suspenseHook: blueprint.suspenseHook,
    userGuidance: blueprint.userGuidance,
  }))
  return `${header}\n${JSON.stringify(plans, null, 2)}`
}

export class ReviewChapterCommand extends BaseWorkflowCommand<string> {
  constructor(
    private params: ReviewChapterParams,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error(text('当前项目已切换，审稿已停止', 'The project changed, so the review stopped.'))
    const novelConfig = Object.freeze({ ...project.novelConfig })

    const draft = this.params.draftContent
    if (!draft) throw new Error(text('无草稿内容', 'There is no draft content to review.'))

    callbacks.log(text('准备启动一致性审查引擎...', 'Preparing the continuity review...'))
    callbacks.log(text('  读取已定稿连续性事实...', '  Reading finalized continuity facts...'))

    let contextSummary = formatFinalizedHistory([], writingLanguage)
    try {
      const projections = await ipc.invokeWithProjectSession(
        projectSession,
        'db:continuity-list-before',
        this.params.chapterNumber,
        context.projectPath,
      )
      contextSummary = formatFinalizedHistory(projections, writingLanguage)
    } catch {
      contextSummary = promptLanguageText(
        writingLanguage,
        '【已确认定稿历史｜唯一已发生事实源】\n（连续性投影暂时不可用；未使用知识库资料替代）',
        '[Finalized history | the only source of events that have already happened]\n(continuity projection unavailable; knowledge-base material was not substituted)',
      )
    }

    const characterState = await this.readCharacterStates(context.projectPath, projectSession, writingLanguage)
    const worldBuilding = await this.readWorldBuilding(context.projectPath, projectSession, writingLanguage)
    // 本章引用的世界观条目：审稿的**对照基准**（只含作者为本章声明引用的那几条）。
    // 读失败按「本章没有引用」处理 —— 审稿不能因为这条可选信息而整体失败。
    let referencedWorldSettings = ''
    try {
      referencedWorldSettings = await this.readReferencedWorldSettings(
        this.params.chapterNumber,
        context.projectPath,
        writingLanguage,
      )
    } catch {
      referencedWorldSettings = ''
    }
    const globalGuidance = novelConfig.globalGuidance?.trim() || promptLanguageText(
      writingLanguage,
      '（无作者全局创作指导）',
      '(no author global creative guidance)',
    )
    const authorGuidanceSection = promptLanguageText(
      writingLanguage,
      `【作者全局创作指导｜约束而非已发生事实】\n${globalGuidance}`,
      `[Author global creative guidance | constraint, not established history]\n${globalGuidance}`,
    )
    const authorConfigSection = promptLanguageText(
      writingLanguage,
      `【作者确认项目配置｜约束而非已发生事实】\n${JSON.stringify(novelConfig, null, 2)}`,
      `[Author-confirmed project configuration | constraint, not established history]\n${JSON.stringify(novelConfig, null, 2)}`,
    )
    let planningMaterial = formatReviewPlanningMaterial([], writingLanguage)
    let frozenGoals = freezeChapterGoals(this.params.chapterNumber, undefined)
    try {
      const { loadDirectoryBlueprints } = await import('../directory-workflow')
      const blueprints = (await loadDirectoryBlueprints(context.projectPath, projectSession))
        .filter(blueprint => (
          blueprint.chapterNumber >= this.params.chapterNumber
          && blueprint.chapterNumber <= this.params.chapterNumber + 5
        ))
      planningMaterial = formatReviewPlanningMaterial(blueprints, writingLanguage)
      frozenGoals = freezeChapterGoals(this.params.chapterNumber,
        blueprints.find(blueprint => blueprint.chapterNumber === this.params.chapterNumber)?.keyEvents ?? null)
    } catch {
      planningMaterial = promptLanguageText(
        writingLanguage,
        '【当前及未来蓝图/计划｜非既定历史】\n（蓝图读取暂时不可用）',
        '[Current and future blueprints/plans | not established history]\n(blueprint retrieval unavailable)',
      )
    }

    const template = await resolvePromptTemplate('consistency_check', projectSession, writingLanguage)
    if (!template) throw new Error(text('未找到审稿模板', 'The review prompt template was not found.'))

    const promptBuilder = new ReviewPromptBuilder(template, writingLanguage)
      .withChapterContent(draft)
      .withCharacterStates(characterState)
      .withGlobalSummary(contextSummary)
      .withWorldBuilding(worldBuilding)
      .withReviewFocus(this.params.reviewFocus || '')
    /**
     * 目标逐项核对：清单短就随主审稿一次做完；清单长就拆成小批次分别核对。
     *
     * 先生（审稿截断事故）：逐项核对的输出长度正比于清单条数，条数一多，单次调用
     * 最容易顶到模型输出上限、让整份报告作废。切批之后每批只核对几项，输出天然变短，
     * 模型输出上限小也不再是问题。
     */
    const goalBatches = splitChapterGoalsIntoBatches(frozenGoals)
    const inlineGoalReview = goalBatches.length <= 1

    const reviewPrompt = [
      promptBuilder.build(),
      authorGuidanceSection,
      authorConfigSection,
      // 独立成段而不是塞进 withWorldBuilding（那是架构总纲）：
      // 让「总纲」与「本章引用条目」各司其职，也方便日后分别追踪来源。
      referencedWorldSettings,
      planningMaterial,
      inlineGoalReview
        ? buildChapterGoalReviewPrompt(frozenGoals, writingLanguage)
        : buildChapterGoalReviewDeferredNote(writingLanguage),
    ].filter(Boolean).join('\n\n')

    /**
     * 先生（审稿截断事故）：这条日志要说清「要等多久、为什么慢」。
     * 审稿是一次「大输入 + 大输出」的调用，中途没有增量进度可报 ——
     * 若只留一句「正在扫描」，作者看着进度条长时间停在原处，会以为卡死了。
     */
    callbacks.log(text(
      '调用 AI 审查员对本章进行多维度扫描（整章正文 + 目标逐项核对，输出较长，通常需要一到几分钟，请稍候）...',
      'Running the AI continuity review (full chapter plus per-goal checks; the report is long, so this usually takes a minute or more)...',
    ))

    // 期望 JSON 格式返回；bounded 模式会在 length 时自动续写。
    // 部分模型/网关在输出上限截断时会把 finishReason 报成 stop，导致
    // 坏 JSON 直接进入解析 → 这里在合同校验失败时再补一次完整替代输出。
    // 续写次数用满该模式的上限（MAX_STRUCTURED_CONTINUATIONS = 2）：
    // 报告字段多、又必须逐项覆盖冻结清单，碰上输出上限较小的模型时 1 次往往不够。
    let reviewResultRaw = await this.callLLMWithBoundedCompletion(
      reviewPrompt,
      promptBuilder.getSystemRole(),
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: 2 },
      {
        responseFormat: { type: 'json_object' },
        purpose: 'review-chapter',
        reasoningStage: 'review',
        writingSkillStage: 'review',
      },
      context,
    )
    this.assertNotCancelled(context)

    const parseAttempt = (): ReviewLike => parseReviewResult(this.stripThinkingTags(reviewResultRaw))

    let parsedResult: ReviewLike
    try {
      parsedResult = parseAttempt()
    } catch (parseError) {
      const detail = parseError instanceof SyntaxError
        ? text(
          '输出不是完整 JSON（可能被模型输出上限截断）',
          'the output is not complete JSON (it may be truncated by the model output limit)',
        )
        : text(
          '输出不符合审稿报告合同（字段缺失、越界或多余）',
          'the output does not match the review-report contract (missing, oversized, or extra fields)',
        )
      callbacks.log(text(
        `审稿结果未通过校验（${detail}），正在请求一次完整替代输出...`,
        `The review result failed validation (${detail}); requesting one complete replacement...`,
      ))
      this.assertNotCancelled(context)
      const rebuildInstruction = promptLanguageText(
        writingLanguage,
        '上一轮审稿输出未通过合同校验，已被丢弃，不得引用或续接。请重新完成原始审稿任务。',
        'The previous review output failed contract validation and was discarded. Do not quote or continue it; complete the original review task again.',
      )
      const rebuildHeading = promptLanguageText(writingLanguage, '【原始审稿任务】', '[Original review task]')
      const rebuildContract = promptLanguageText(
        writingLanguage,
        '【硬性要求】只重新输出一个完整审稿 JSON，根字段为 summary、items、goalReviews：summary 不超过 120 字符；items 为 1–10 条，每条含 category、severity(error|warning|pass)、description(≤200 字符)；quote 仅 pass 可省略，error/warning 必须提供且不超过 160 字符。goalReviews 按上方最初冻结清单逐项返回 id、status、description、evidence，不受 items 条数限制；只用原始待审正文核对。不得输出这些约定以外的字段、Markdown、解释或思考过程。',
        '[Hard requirement] Output one complete review JSON with root fields summary, items and goalReviews: summary within 120 characters; items 1–10 entries with category, severity(error|warning|pass), description(≤200 characters); quote is optional only for pass and required (≤160 characters) for error/warning. goalReviews must cover the original frozen checklist above with id, status, description and evidence, without the general items count limit; use only the original draft for evidence. No fields outside these contracts, Markdown, explanation, or reasoning.',
      )
      reviewResultRaw = await this.callLLMWithBoundedCompletion(
        [rebuildInstruction, rebuildHeading, reviewPrompt, rebuildContract].join('\n\n'),
        promptBuilder.getSystemRole(),
        callbacks,
        { mode: 'replace-structured-output', maxContinuations: 2 },
        {
          responseFormat: { type: 'json_object' },
          purpose: 'review-chapter-rebuild',
          reasoningStage: 'review',
          writingSkillStage: 'review',
        },
        context,
      )
      this.assertNotCancelled(context)
      try {
        parsedResult = parseAttempt()
      } catch (rebuildError) {
        const rebuildDetail = rebuildError instanceof SyntaxError
          ? text(
            '替代输出仍不是完整 JSON',
            'the replacement output is still not complete JSON',
          )
          : text(
            '替代输出仍不符合审稿报告合同',
            'the replacement output still does not match the review-report contract',
          )
        throw new Error(text(
          `AI 返回的审稿结果两次均无效（${rebuildDetail}），因此未保存报告。`
            + '若此问题反复出现，通常是审稿输出被模型最大长度截断：请提高模型的最大输出 Tokens 后重试。',
          `The AI review response was invalid twice (${rebuildDetail}), so no report was saved. `
            + 'If this keeps happening, the review output is usually truncated by the model maximum length: increase the model maximum output tokens and retry.',
        ))
      }
    }
    this.assertNotCancelled(context)

    // 清单长时分批核对：每批一次小调用，输出短、不易截断；合并后交给同一套归一化。
    const goalReviewPayload = inlineGoalReview
      ? parsedResult.goalReviews
      : await this.reviewChapterGoalsInBatches(
        goalBatches,
        draft,
        promptBuilder.getSystemRole(),
        writingLanguage,
        callbacks,
        context,
      )
    const goalReview = normalizeChapterGoalReview(goalReviewPayload, frozenGoals, draft, writingLanguage)
    delete parsedResult.goalReviews
    parsedResult.goalReview = goalReview
    parsedResult.items = [...(parsedResult.items ?? []), ...chapterGoalReviewItems(goalReview, writingLanguage)]
    if (parsedResult.items.some(item => item.severity === 'unknown')) {
      parsedResult.summary = text('审稿包含待核实项目，不能视为全部通过。', 'The review contains unresolved items and is not an overall pass.')
    } else if (goalReview.items.some(item => item.status === 'unmet')) {
      parsedResult.summary = text('本章存在尚未完成的目标，请核对逐项证据。', 'Some chapter goals are unmet; check their evidence.')
    }

    const blueprint = await ipc.invokeWithProjectSession(
      projectSession, 'db:blueprint-get', this.params.chapterNumber, context.projectPath,
    )
    if (blueprint) {
      try {
        const preflight = await readConsistencyPreflight(projectSession, [blueprint])
        parsedResult = mergeConsistencyFindingsIntoReview(parsedResult, preflight.findings, context.uiLocale ?? 'zh-CN')
      } catch {
        callbacks.log(text(
          '一致性证据暂时不可用；AI 审稿仍会继续。',
          'Continuity evidence is temporarily unavailable; the AI review will continue.',
        ))
      }
      if (!sameProjectSessionContext(projectSession, projectSessionContextFromProject(useProjectStore.getState().currentProject))) {
        throw new Error(text('当前项目已切换，审稿已停止', 'The project changed, so the review stopped.'))
      }
    }

    const frozenSource = this.params.sourceDraft
    const legacyBaseDraft = frozenSource
      ? null
      : await readWorkflowDraftMeta(this.params.draftPath, context.projectPath, projectSession)
    const baseDraftId = frozenSource?.id ?? legacyBaseDraft?.id
    const baseVersion = frozenSource?.version ?? legacyBaseDraft?.version
    if (baseDraftId === undefined || baseVersion === undefined) {
      throw new Error(text('找不到基准草稿版本', 'The source draft version could not be found.'))
    }

    this.assertNotCancelled(context)
    const createResult = await ipc.invokeWithProjectSession(projectSession, 'db:review-create', {
      baseDraftId,
      content: JSON.stringify(parsedResult, null, 2),
      ...(frozenSource ? {
        expectedSource: {
          id: frozenSource.id,
          chapterNumber: frozenSource.chapterNumber,
          version: frozenSource.version,
          status: frozenSource.status,
          content: draft,
        },
      } : {}),
    }, context.projectPath)
    throwIfSourceDraftChanged(createResult, workflowUiLocale(context), 'review')
    requireIpcSuccess(createResult, text('保存审稿报告', 'Save the review report'))
    const revIndex = createResult.reviewIndex ?? 0

    // 将审稿报告 JSON 序列化为字符串，作为 content 传给 Tab
    // EditorArea 渲染 ReviewReport 的条件：activeTab.content 存在
    this.assertNotCancelled(context)
    const reportContent = JSON.stringify(parsedResult, null, 2)

    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text('当前项目已切换，已拒绝打开旧审稿报告', 'The project changed, so the stale review report was not opened.'))
    const { useEditorStore } = await import('../../../stores/editor-store')
    const pseudoReviewPath = `vela://draft/ch${this.params.chapterNumber}/v${baseVersion}/review${revIndex}`
    useEditorStore.getState().openFile({
      id: `review-${this.params.draftPath}-${revIndex}`,
      name: text(
        `审稿报告：第${this.params.chapterNumber}章`,
        `Review report: Chapter ${this.params.chapterNumber}`,
      ),
      type: 'review-report',
      content: reportContent,
      filePath: this.params.draftPath,
      reportPath: pseudoReviewPath,
      reviewReport: reportContent,
      chapterNumber: this.params.chapterNumber,
      chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
      reviewId: createResult.id,
      projectKey: context.projectPath,
    })

    callbacks.log(text(
      `审查完成，已生成审稿报告 r${revIndex}`,
      `Review complete; created review report r${revIndex}`,
    ))
    return this.stripThinkingTags(reviewResultRaw)
  }

  /**
   * 分批核对本章目标。
   *
   * 每批只带「正文 + 本批清单」，**不带**模板 / 架构 / 世界观设定那几大段 ——
   * 批任务本身很小，没有理由把整套上下文再送一遍。
   *
   * 一批失败不废掉整次审稿：记一条日志、跳过该批，缺的项会在归一化时被标成
   * unknown（待人工核实），作者仍拿得到其余目标结论与通用审稿项。
   * 取消则立刻中断 —— 那是作者的意图，不能当成"这批失败"吞掉。
   */
  private async reviewChapterGoalsInBatches(
    batches: readonly FrozenChapterGoals[],
    draft: string,
    systemRole: string,
    writingLanguage: WritingLanguage,
    callbacks: StepCallbacks,
    context: WorkflowContext,
  ): Promise<readonly unknown[]> {
    const collected: unknown[] = []
    const draftSection = promptLanguageText(
      writingLanguage,
      `【待审正文】\n${draft}`,
      `[Draft under review]\n${draft}`,
    )
    for (const [index, batch] of batches.entries()) {
      this.assertNotCancelled(context)
      callbacks.log(workflowUiText(
        context,
        `本章目标核对：第 ${index + 1}/${batches.length} 批（${batch.items.length} 项）...`,
        `Chapter goal check: batch ${index + 1}/${batches.length} (${batch.items.length} item(s))...`,
      ))
      try {
        const raw = await this.callLLMWithBoundedCompletion(
          [draftSection, buildChapterGoalReviewBatchPrompt(batch, writingLanguage)].join('\n\n'),
          systemRole,
          callbacks,
          { mode: 'replace-structured-output', maxContinuations: 1 },
          {
            responseFormat: { type: 'json_object' },
            purpose: `review-chapter-goals-${index + 1}`,
            reasoningStage: 'review',
            writingSkillStage: 'review',
          },
          context,
        )
        collected.push(...parseChapterGoalReviewBatch(raw))
      } catch (error) {
        if (context.cancelled) throw error
        callbacks.log(workflowUiText(
          context,
          `第 ${index + 1} 批目标核对未完成：${error instanceof Error ? error.message : String(error)}。这批目标将标记为待人工核实，其余结论不受影响。`,
          `Goal batch ${index + 1} did not complete: ${error instanceof Error ? error.message : String(error)}. Those goals will be marked for manual verification; the rest of the review is unaffected.`,
        ))
      }
    }
    return collected
  }

  private async readCharacterStates(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
  ): Promise<string> {
    try {
      const allChars = await ipc.invokeWithProjectSession(projectSession, 'db:character-get-all', projectPath)
      const states: string[] = []
      for (const card of allChars) {
        if (card.name && card.currentState) {
          const cs = card.currentState
          const authorState = Object.fromEntries(CHARACTER_STATE_TEXT_FIELDS.flatMap((field) => {
            const provenance = cs.provenance?.[field]
            return provenance?.kind === 'author' && cs[field]
              ? [[field, `${cs[field]} @ch${provenance.chapterNumber}`]]
              : []
          }))
          if (Object.keys(authorState).length === 0) continue
          states.push(promptLanguageText(
            writingLanguage,
            `${card.name}（${card.role || '未知'}）作者状态（按标注章节理解，非永久约束）: ${JSON.stringify(authorState)}`,
            `${card.name} (${card.role || 'unknown'}) author state (time-bound to the annotated chapter, not permanent): ${JSON.stringify(authorState)}`,
          ))
        }
      }
      return states.length > 0 ? states.join('\n') : promptLanguageText(writingLanguage, '（暂无）', '(none)')
    } catch { return promptLanguageText(writingLanguage, '（读取失败）', '(unavailable)') }
  }

  private async readWorldBuilding(
    projectPath: string,
    projectSession: ProjectSessionContext,
    writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
  ): Promise<string> {
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
    return core?.worldbuilding || promptLanguageText(writingLanguage, '（暂无）', '(none)')
  }

  /**
   * 本章引用的世界观设定条目 —— 只取作者在「本章引用」区声明过的那几条。
   *
   * 三个刻意的取舍（先生拍板）：
   * 1. **只取本章引用的**，不取全库：写稿时 AI 看到的也只是这几条。
   *    如果审稿能看到全库，就会出现「审稿拿写稿不知道的设定去判写稿有罪」——
   *    审稿用自己的信息优势否定写稿，作者只会被搞糊涂。
   * 2. **只取 confirmed**：pending 是还没经作者确认的候选，不能拿它当裁判标准。
   * 3. **严格限量**（5 条 / 1600 字）：审稿的问题清单有 `items ≤ 10` 的硬上限，
   *    误报挤进来会**挤掉真正重要的问题**，所以这里的量必须比写稿更克制。
   */
  private async readReferencedWorldSettings(
    chapterNumber: number,
    projectPath: string,
    writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
  ): Promise<string> {
    const refs = await ipc.invoke('world-setting:list-chapter-refs', chapterNumber, projectPath)
    if (!Array.isArray(refs) || refs.length === 0) return ''
    const entries = await ipc.invoke('world-setting:list', projectPath)
    if (!Array.isArray(entries)) return ''
    const byId = new Map<number, (typeof entries)[number]>()
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && typeof entry.id === 'number') byId.set(entry.id, entry)
    }
    const blocks: string[] = []
    let usedChars = 0
    for (const ref of refs) {
      if (blocks.length >= REVIEW_WORLD_SETTING_MAX_ENTRIES) break
      if (!ref || typeof ref !== 'object' || typeof ref.settingId !== 'number') continue
      const entry = byId.get(ref.settingId)
      if (!entry || entry.status === 'pending') continue
      const detail = typeof entry.content === 'string' && entry.content.trim().length > 0
        ? entry.content.trim()
        : (entry.summary ?? '').trim()
      if (!detail) continue
      const name = typeof entry.name === 'string' ? entry.name.trim() : ''
      if (!name) continue
      const block = `- ${name}：${detail}`
      if (usedChars + block.length > REVIEW_WORLD_SETTING_TOTAL_MAX_CHARS) break
      blocks.push(block)
      usedChars += block.length
    }
    if (blocks.length === 0) return ''

    /**
     * 措辞是这里的关键 —— 先生特别要求防误报。
     *
     * 绝不能写成「以下是本章设定，请逐条核对」：
     * 那样等于要求它逐条审，会产出大量「设定 A 没被违反」这类 filler，
     * 白占 items 的 10 条预算，把真正的伏笔/连贯性问题挤出去。
     * 所以定性为**对照参考**、只在明显违反时开口、且必须双引证。
     */
    return promptLanguageText(
      writingLanguage,
      `【本章引用的世界观设定（**对照参考，不是检查清单**）】
仅当本章正文**直接、明显地**违反下列已确认条文时，才归入「剧情合理性」维度报告；
报告时必须同时引用**正文原句**与**所违反的设定条文**。
未被违反就不要提及，也不要新增审查维度，更不要为未违反的条目输出 pass 项。

${blocks.join('\n')}`,
      `[World-setting entries referenced by this chapter (reference only, NOT a checklist)]
Report a problem **only** when this chapter's text directly and clearly violates one of the confirmed entries below, and file it under the "plot plausibility" dimension;
you must quote both the **draft sentence** and the **violated entry text**.
If an entry is not violated, do not mention it, do not add a new review dimension, and do not emit a pass item for it.

${blocks.join('\n')}`,
    )
  }
}
