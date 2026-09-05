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
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { readConsistencyPreflight } from '../../consistency-preflight'
import { mergeConsistencyFindingsIntoReview, type ReviewLike } from '../../../shared/consistency-preflight'
import type { ChapterBlueprint } from '../directory-workflow'
import type { FrozenDraftSourceIdentity } from '../chapter-workflow'
import { throwIfSourceDraftChanged } from '../source-draft-changed'


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

interface ReviewResultItem extends Record<string, unknown> {
  category: string
  severity: 'error' | 'warning' | 'pass'
  description: string
  quote?: string
}

interface ReviewResult extends Record<string, unknown> {
  summary: string
  items: ReviewResultItem[]
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
  if (Object.keys(review).some(key => key !== 'summary' && key !== 'items')
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
    try {
      const { loadDirectoryBlueprints } = await import('../directory-workflow')
      const blueprints = (await loadDirectoryBlueprints(context.projectPath, projectSession))
        .filter(blueprint => (
          blueprint.chapterNumber >= this.params.chapterNumber
          && blueprint.chapterNumber <= this.params.chapterNumber + 5
        ))
      planningMaterial = formatReviewPlanningMaterial(blueprints, writingLanguage)
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
    const reviewPrompt = [
      promptBuilder.build(),
      authorGuidanceSection,
      authorConfigSection,
      planningMaterial,
    ].join('\n\n')

    callbacks.log(text('调用 AI 审查员对本章进行多维度扫描...', 'Running the AI continuity review...'))

    // 期望 JSON 格式返回
    const reviewResultRaw = await this.callLLMWithBoundedCompletion(
      reviewPrompt,
      promptBuilder.getSystemRole(),
      callbacks,
      { mode: 'replace-structured-output', maxContinuations: 1 },
      {
        responseFormat: { type: 'json_object' },
        purpose: 'review-chapter',
        reasoningStage: 'review',
        writingSkillStage: 'review',
      },
      context,
    )
    this.assertNotCancelled(context)

    const reviewResultClean = this.stripThinkingTags(reviewResultRaw)

    let parsedResult: ReviewLike
    try {
      parsedResult = parseReviewResult(reviewResultClean)
    } catch {
      throw new Error(text(
        'AI 返回的审稿结果无效，因此未保存报告。',
        'The AI review response was invalid, so no report was saved.',
      ))
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
    throwIfSourceDraftChanged(createResult, writingLanguage, 'review')
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
    return reviewResultClean
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
          states.push(promptLanguageText(
            writingLanguage,
            `${card.name}（${card.role || '未知'}）: ${cs.powerLevel || ''}, ${cs.location || ''}, ${cs.physicalState || ''}, ${cs.mentalState || ''}, 最近：${cs.recentEvents || ''}`,
            `${card.name} (${card.role || 'unknown'}): power ${cs.powerLevel || ''}; location ${cs.location || ''}; physical ${cs.physicalState || ''}; mental ${cs.mentalState || ''}; recent ${cs.recentEvents || ''}`,
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
}
