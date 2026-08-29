import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import {
  requireWorkflowProjectSession,
  workflowUiLocale,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { assertMateriallyCompleteRevision } from './refinement-completeness'
import {
  hasIncludedReviewItems,
  parseHumanConfirmedReviewSnapshot,
  renderHumanConfirmedReviewBrief,
  serializeHumanConfirmedReviewSnapshot,
  type HumanConfirmedReviewSnapshot,
} from '../../../shared/human-confirmed-review'


export interface RefineFromReviewParams {
  draftPath: string
  draftContent: string
  /** Persisted JSON content of the immutable human-confirmed review snapshot. */
  confirmedReviewContent?: string
  /** ID of the review row that stores the confirmed snapshot. */
  reviewSourceId?: number
  /** @deprecated Raw AI review content is deliberately never sent to the refiner. */
  reviewReport?: string
  reviewFileName?: string
  chapterNumber: number
  /** @deprecated Author guidance must be persisted in the confirmation snapshot. */
  userRefinePrompt?: string
}

export class RefineFromReviewCommand extends BaseWorkflowCommand<string> {
  constructor(
    private params: RefineFromReviewParams,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    const confirmedReview = await this.requireConfirmedReview(params)
    return this.executeWithGenerationRuntime(
      'text',
      params,
      () => this.executeWithinGeneration(params, confirmedReview.snapshot, confirmedReview.reviewSourceId),
    )
  }

  /**
   * A renderer-provided JSON string is only a request to use a confirmation
   * record. Before acquiring a generation lease, resolve that record through
   * the frozen project session and use its persisted content as the source of
   * truth. This keeps review_source_id traceable to the exact prompt input.
   */
  private async requireConfirmedReview({ context }: CommandExecuteParams): Promise<{
    snapshot: HumanConfirmedReviewSnapshot
    reviewSourceId: number
  }> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const reviewSourceId = this.params.reviewSourceId
    if (
      typeof reviewSourceId !== 'number'
      || !Number.isSafeInteger(reviewSourceId)
      || reviewSourceId <= 0
    ) {
      throw new Error(text(
        '审稿修稿需要已保存的人工确认快照，未调用模型。',
        'Review-based revision requires a saved human-confirmed review snapshot. The model was not called.',
      ))
    }

    const requestedSnapshot = this.params.confirmedReviewContent
      ? parseHumanConfirmedReviewSnapshot(this.params.confirmedReviewContent)
      : null
    if (!requestedSnapshot) {
      throw new Error(text(
        '审稿修稿需要有效的人工确认快照，未调用模型。',
        'Review-based revision requires a valid human-confirmed review snapshot. The model was not called.',
      ))
    }

    const projectSession = requireWorkflowProjectSession(context)
    this.assertNotCancelled(context)
    const persistedReview = await ipc.invokeWithProjectSession(
      projectSession,
      'db:review-get-full',
      reviewSourceId,
      context.projectPath,
    )
    this.assertNotCancelled(context)
    if (!persistedReview) {
      throw new Error(text(
        '找不到已保存的人工确认快照，未调用模型。',
        'The saved human-confirmed review snapshot could not be found. The model was not called.',
      ))
    }
    if (persistedReview.id !== reviewSourceId) {
      throw new Error(text(
        '人工确认快照记录校验失败，未调用模型。',
        'The human-confirmed review snapshot record failed validation. The model was not called.',
      ))
    }

    const persistedSnapshot = parseHumanConfirmedReviewSnapshot(persistedReview.content)
    if (!persistedSnapshot) {
      throw new Error(text(
        '已保存的审稿记录不是有效的人工确认快照，未调用模型。',
        'The saved review record is not a valid human-confirmed review snapshot. The model was not called.',
      ))
    }
    if (
      serializeHumanConfirmedReviewSnapshot(requestedSnapshot)
      !== serializeHumanConfirmedReviewSnapshot(persistedSnapshot)
    ) {
      throw new Error(text(
        '人工确认快照与已保存记录不一致，请重新确认后再试。',
        'The human-confirmed review snapshot does not match the saved record. Confirm it again and retry.',
      ))
    }

    const baseDraft = await readWorkflowDraftMeta(
      this.params.draftPath,
      context.projectPath,
      projectSession,
    )
    this.assertNotCancelled(context)
    if (!baseDraft) {
      throw new Error(text(
        '找不到基准草稿版本，未调用模型。',
        'The base draft version could not be found. The model was not called.',
      ))
    }
    if (persistedReview.baseDraftId !== baseDraft.id) {
      throw new Error(text(
        '人工确认快照不属于当前草稿版本，未调用模型。',
        'The human-confirmed review snapshot does not belong to the current draft version. The model was not called.',
      ))
    }
    if (!hasIncludedReviewItems(persistedSnapshot)) {
      throw new Error(text(
        '人工确认快照没有任何纳入项，未调用模型。',
        'The human-confirmed review snapshot has no included items. The model was not called.',
      ))
    }

    return { snapshot: persistedSnapshot, reviewSourceId }
  }

  private async executeWithinGeneration(
    { context, callbacks }: CommandExecuteParams,
    confirmedReview: HumanConfirmedReviewSnapshot,
    reviewSourceId: number,
  ): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error(text('当前项目已切换，修稿已停止', 'The current project changed, so revision stopped.'))
    const novelConfig = Object.freeze({ ...project.novelConfig })
    const writingLanguage = workflowWritingLanguage(context)

    callbacks.log(text(
      '正在根据已确认的审稿项精准修复...',
      'Revising from the confirmed review checklist...',
    ))

    const template = await resolvePromptTemplate('refine_from_review', projectSession, writingLanguage)
    if (!template) throw new Error(text('未找到审稿修复模板', 'The review-based revision template was not found.'))

    const confirmedReviewBrief = renderHumanConfirmedReviewBrief(confirmedReview, writingLanguage)

    const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
      .withReviewReport(confirmedReviewBrief)
      .withDraftContent(this.params.draftContent)
      .withGlobalGuidance(novelConfig.globalGuidance || '')
      // The brief already contains the confirmed author guidance. Do not let
      // a transient UI field bypass the persisted confirmation snapshot.
      .withUserRefinePrompt('')

    const refined = await this.callLLMWithBoundedCompletion(
      promptBuilder.build(),
      promptBuilder.getSystemRole(),
      callbacks,
      { mode: 'append-visible-text', maxContinuations: 3 },
      { purpose: 'refine-from-review', reasoningStage: 'review' },
      context,
    )
    this.assertNotCancelled(context)
    const cleanRefined = this.stripThinkingTags(refined).trim()
    assertMateriallyCompleteRevision(
      this.params.draftContent,
      cleanRefined,
      novelConfig.wordsPerChapter,
      workflowUiLocale(context),
    )

    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text('当前项目已切换，修稿结果未保存', 'The current project changed, so the revision was not saved.'))

    const baseDraft = await readWorkflowDraftMeta(this.params.draftPath, context.projectPath, projectSession)
    if (!baseDraft) throw new Error(text('找不到基准草稿版本', 'The base draft version could not be found.'))

    this.assertNotCancelled(context)
    const createRes = await ipc.invokeWithProjectSession(projectSession, 'db:revision-replace-pending', {
      baseDraftId: baseDraft.id,
      revisionType: 'review-fix',
      content: cleanRefined,
      wordCount: cleanRefined.length,
      userPrompt: confirmedReview.authorGuidance || undefined,
      reviewSourceId,
    }, context.projectPath)
    requireIpcSuccess(createRes, text('创建审稿修订稿', 'Create review-based revision'))
    if (createRes.id === undefined) throw new Error(text(
      '创建审稿修订稿失败：未返回修订稿编号',
      'Failed to create the review-based revision: no revision ID was returned.',
    ))

    const revIndex = createRes.revisionIndex ?? 0

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text(
      '当前项目已切换，已拒绝打开旧修订稿',
      'The current project changed, so the stale revision was not opened.',
    ))
    const { useEditorStore } = await import('../../../stores/editor-store')
    useEditorStore.getState().openFile({
      id: `diff-${this.params.draftPath}-${createRes.id}`,
      name: text(
        `审稿修复：第${this.params.chapterNumber}章`,
        `Review fix: Chapter ${this.params.chapterNumber}`,
      ),
      type: 'diff',
      filePath: this.params.draftPath,
      originalContent: this.params.draftContent,
      content: cleanRefined,
      revisionPath: `vela://revision/${createRes.id}`,
      chapterNumber: this.params.chapterNumber,
      chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
      projectKey: context.projectPath,
    })

    callbacks.log(text(
      `审稿修复完成（${cleanRefined.length} 字），已生成修订稿版本 r${revIndex}`,
      `Review-based revision complete (${cleanRefined.length} characters); revision r${revIndex} is ready.`,
    ))
    return cleanRefined
  }
}
