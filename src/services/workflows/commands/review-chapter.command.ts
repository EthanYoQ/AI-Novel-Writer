import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ReviewPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { readConsistencyPreflight } from '../../consistency-preflight'
import { mergeConsistencyFindingsIntoReview, type ReviewLike } from '../../../shared/consistency-preflight'


export interface ReviewChapterParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  /** 审稿维度侧重点（可选） */
  reviewFocus?: string
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

    const draft = this.params.draftContent
    if (!draft) throw new Error(text('无草稿内容', 'There is no draft content to review.'))

    callbacks.log(text('准备启动一致性审查引擎...', 'Preparing the continuity review...'))
    callbacks.log(text('  检索全书设定档案...', '  Retrieving established story facts...'))

    // 使用向量检索获取与待审章节相关的历史上下文（替代全局摘要）
    let contextSummary = promptLanguageText(writingLanguage, '（无上下文参考）', '(no relevant prior context)')
    try {
      // 从待审内容中提取前 200 字作为检索 query
      const queryText = draft.slice(0, 200)
      const results = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(
        projectSession,
        'kb:search',
        queryText,
        5,
        context.projectPath,
      ))
      if (results.length > 0) {
        contextSummary = results
          .map((r: { fileName: string; score: number; text: string }, i: number) =>
            promptLanguageText(
              writingLanguage,
              `[${i + 1}] (${r.fileName}, 相关度 ${(r.score * 100).toFixed(0)}%)\n${r.text}`,
              `[${i + 1}] (${r.fileName}, relevance ${(r.score * 100).toFixed(0)}%)\n${r.text}`,
            ))
          .join('\n\n')
      }
    } catch {
      contextSummary = promptLanguageText(writingLanguage, '（知识库检索不可用）', '(knowledge-base search unavailable)')
    }

    const characterState = await this.readCharacterStates(context.projectPath, projectSession, writingLanguage)
    const worldBuilding = await this.readWorldBuilding(context.projectPath, projectSession, writingLanguage)

    const template = await resolvePromptTemplate('consistency_check', projectSession, writingLanguage)
    if (!template) throw new Error(text('未找到审稿模板', 'The review prompt template was not found.'))

    const promptBuilder = new ReviewPromptBuilder(template, writingLanguage)
      .withChapterContent(draft)
      .withCharacterStates(characterState)
      .withGlobalSummary(contextSummary)
      .withWorldBuilding(worldBuilding)
      .withReviewFocus(this.params.reviewFocus || '')

    callbacks.log(text('调用 AI 审查员对本章进行多维度扫描...', 'Running the AI continuity review...'))

    // 期望 JSON 格式返回
    const reviewResultRaw = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
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

    const baseDraft = await readWorkflowDraftMeta(this.params.draftPath, context.projectPath, projectSession)
    if (!baseDraft) throw new Error(text('找不到基准草稿版本', 'The source draft version could not be found.'))
    const baseVersion = baseDraft.version

    const revIndex = await ipc.invokeWithProjectSession(projectSession, 'db:review-next-index', baseDraft.id, context.projectPath)

    let parsedResult: ReviewLike
    try {
      const parsed = this.parseJSON(reviewResultClean)
      parsedResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as ReviewLike
        : { summary: text('解析失败', 'Parsing failed'), items: [] }
    } catch {
      callbacks.log(text('审稿结果解析失败，返回原始文本', 'The review result could not be parsed; preserving the raw response.'))
      parsedResult = { summary: text('解析失败', 'Parsing failed'), items: [] }
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

    this.assertNotCancelled(context)
    const createResult = await ipc.invokeWithProjectSession(projectSession, 'db:review-create', {
      baseDraftId: baseDraft.id,
      reviewIndex: revIndex,
      content: JSON.stringify(parsedResult, null, 2),
    }, context.projectPath)
    requireIpcSuccess(createResult, text('保存审稿报告', 'Save the review report'))

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
