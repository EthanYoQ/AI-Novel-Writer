import { BaseWorkflowCommand, type CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import type { GenerationAuthorInput } from '../../../shared/generation-owner-contract'
import type { PreparedReviewRevisionContext, ReviewRevisionContext, ReviewRevisionOperation, ReviewRevisionRecovery, ReviewRevisionCommitReceipt } from '../../../shared/review-revision-generation'
import type { FrozenDraftSourceIdentity } from '../chapter-workflow'
import { hashAuthorText } from '../../../shared/source-ref'
import type { DraftStatus } from '../../../shared/draft-status'
import { formatResourceUri } from '../../../shared/project-paths'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../ipc-client'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import { requireWorkflowProjectSession, workflowUiLocale, workflowUiText } from '../workflow-project-session'
import { assertMateriallyCompleteRevision } from './refinement-completeness'
import { countDraftUnits } from '../../../shared/draft-units'
import { throwIfSourceDraftChanged } from '../source-draft-changed'

export interface ReviewRevisionCommandSource {
  draftPath: string
  draftContent: string
  sourceDraft?: FrozenDraftSourceIdentity
  chapterNumber: number
  recoveryHandle?: MainGenerationRunHandle
}

/** Shared consumer lifecycle; source authority and formal effects remain in main. */
export abstract class ReviewRevisionCommand extends BaseWorkflowCommand<string> {
  private openedHandle?: MainGenerationRunHandle
  protected recovery?: ReviewRevisionRecovery

  constructor(
    protected readonly operation: ReviewRevisionOperation,
    protected readonly sourceParams: ReviewRevisionCommandSource,
    private readonly authorInputs: GenerationAuthorInput[],
    private readonly confirmation: { reviewSourceId?: number; confirmedReviewContent?: string },
    dependencies?: WorkflowGenerationRuntimeDependencies,
  ) { super(dependencies) }

  async execute(params: CommandExecuteParams): Promise<string> {
    try { return await this.executePrepared(params) } catch (error) {
      if (error instanceof Error && (error.message.includes('SOURCE_DRAFT_CHANGED')
        || 'code' in error && error.code === 'SOURCE_DRAFT_CHANGED')) {
        throwIfSourceDraftChanged({ errorCode: 'SOURCE_DRAFT_CHANGED' }, workflowUiLocale(params.context), this.operation === 'review-chapter' ? 'review' : 'refine')
      }
      throw error
    }
  }

  private async executePrepared(params: CommandExecuteParams): Promise<string> {
    this.assertNotCancelled(params.context)
    this.assertSession(params)
    const session = requireWorkflowProjectSession(params.context)
    const recoveryHandle = this.openedHandle ?? this.sourceParams.recoveryHandle
    let prepared: PreparedReviewRevisionContext
    if (recoveryHandle) {
      this.recovery = await ipc.invokeWithProjectSession(session, 'review-revision:read-recovery', { handle: recoveryHandle })
      if (this.recovery.context.operation !== this.operation) throw new Error('GENERATION_REVIEW_REVISION_OPERATION_MISMATCH')
      if (this.recovery.saved) return this.openReceipt(this.recovery.saved, this.recovery.context, params)
      if (this.recovery.sourceStatus !== 'current' || !this.recovery.contextId) throw new Error('SOURCE_DRAFT_CHANGED')
      prepared = { contextId: this.recovery.contextId, context: this.recovery.context, modelId: this.recovery.modelId }
    } else {
      const source = this.sourceParams.sourceDraft ?? await this.readSelectedSource(params)
      if (source.chapterNumber !== this.sourceParams.chapterNumber || !this.sourceParams.draftContent) throw new Error('SOURCE_DRAFT_CHANGED')
      prepared = await ipc.invokeWithProjectSession(session, 'review-revision:prepare', {
        operation: this.operation,
        draftId: source.id,
        expectedDraft: { chapterNumber: source.chapterNumber, version: source.version, status: source.status,
          contentHash: await hashAuthorText(this.sourceParams.draftContent) },
        authorInputs: this.authorInputs,
        ...this.confirmation,
        uiLocale: workflowUiLocale(params.context),
      })
      if (prepared.context.source.content !== this.sourceParams.draftContent) throw new Error('SOURCE_DRAFT_CHANGED')
    }
    if (prepared.context.operation !== this.operation) throw new Error('GENERATION_REVIEW_REVISION_OPERATION_MISMATCH')
    this.assertSession(params)
    this.assertNotCancelled(params.context)
    params.context.writingLanguage = prepared.context.writingLanguage
    params.context.uiLocale = prepared.context.uiLocale
    if (prepared.modelId) params.context.generationModelId = prepared.modelId
    const finalized = prepared.context.source.status === 'finalized'
    return this.executeWithGenerationRuntime('text', params, async () => {
      const receipt = await this.generateAndCommit(prepared, params)
      return this.openReceipt(receipt, prepared.context, params)
    }, {
      operation: this.operation,
      chapterNumber: prepared.context.source.chapterNumber,
      promptKeys: [this.operation === 'review-chapter' ? 'consistency_check' : this.operation === 'refine-draft' ? 'refine_chapter' : 'refine_from_review'],
      skillStages: [this.operation === 'review-chapter' ? 'review' : 'refinement'],
      output: this.operation === 'review-chapter' ? 'structured-data' : 'visible-text',
      reviewRevisionContextId: prepared.contextId,
      selectedDraftIds: finalized ? [] : [prepared.context.source.id],
      selectedFinalizedDraftIds: finalized ? [prepared.context.source.id] : [],
      selectedBlueprintChapterNumbers: prepared.context.blueprints.map(blueprint => blueprint.chapterNumber),
      authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(prepared.context) }],
      ...(prepared.parentRootActionId ? { parentRootActionId: prepared.parentRootActionId } : {}),
      ...(this.recovery ? { resumeHandle: this.recovery.handle } : {}),
      onRunOpened: async handle => { this.openedHandle = handle },
    })
  }

  protected abstract generateAndCommit(prepared: PreparedReviewRevisionContext, params: CommandExecuteParams): Promise<ReviewRevisionCommitReceipt>

  private assertSession(params: CommandExecuteParams): void {
    if (!sameProjectSessionContext(requireWorkflowProjectSession(params.context), projectSessionContextFromProject(useProjectStore.getState().currentProject))) {
      throw new Error(workflowUiText(params.context, '当前项目已切换，结果未保存', 'The project changed, so the result was not saved.'))
    }
  }

  private async readSelectedSource(params: CommandExecuteParams): Promise<Pick<FrozenDraftSourceIdentity, 'id' | 'chapterNumber' | 'version' | 'status'>> {
    const session = requireWorkflowProjectSession(params.context)
    const meta = await readWorkflowDraftMeta(this.sourceParams.draftPath, params.context.projectPath, session)
    const full = meta ? await ipc.invokeWithProjectSession(session, 'db:draft-get-full', meta.id, params.context.projectPath) : null
    if (!full || full.content !== this.sourceParams.draftContent || full.chapterNumber !== this.sourceParams.chapterNumber
      || !['draft', 'revised', 'reviewed', 'finalized', 'archived'].includes(full.status)) throw new Error('SOURCE_DRAFT_CHANGED')
    return { id: full.id, chapterNumber: full.chapterNumber, version: full.version, status: full.status as DraftStatus }
  }

  protected async readRecovery(params: CommandExecuteParams): Promise<ReviewRevisionRecovery> {
    const handle = params.context.mainGenerationRunHandle
    if (!handle) throw new Error('GENERATION_REVIEW_REVISION_HANDLE_REQUIRED')
    const recovery = await ipc.invokeWithProjectSession(requireWorkflowProjectSession(params.context), 'review-revision:read-recovery', { handle })
    if (recovery.context.operation !== this.operation) throw new Error('GENERATION_REVIEW_REVISION_OPERATION_MISMATCH')
    if (recovery.sourceStatus !== 'current' && !recovery.saved) throw new Error('SOURCE_DRAFT_CHANGED')
    return recovery
  }

  protected async generateRevision(prepared: PreparedReviewRevisionContext, params: CommandExecuteParams,
    taskPrompt: string, systemPrompt: string): Promise<ReviewRevisionCommitReceipt> {
    const frozen = prepared.context
    let composition = this.recovery?.composition
    if (!composition || this.recovery?.lastCompositionFinishReason !== 'stop') {
      const priorAttempts = this.recovery?.attemptedPurposes.filter(purpose => purpose === this.operation || purpose.startsWith(`${this.operation}-`)).length ?? 0
      // The initial request plus three continuations share this bound across recovery.
      const remainingRequests = 4 - priorAttempts
      if (remainingRequests <= 0) throw this.createIncompleteCompletionError('length')
      await this.callLLMWithAppendContinuation({
        taskPrompt, systemPrompt, callbacks: params.callbacks, context: params.context,
        llmOptions: { purpose: this.operation, reasoningStage: 'review', writingSkillStage: 'refinement' },
        seedText: composition?.text,
        maxContinuations: composition?.text ? remainingRequests : remainingRequests - 1,
      })
      composition = (await this.readMainVisibleComposition()) ?? undefined
    }
    if (!composition) throw new Error('GENERATION_COMPOSITION_REQUIRED')
    assertMateriallyCompleteRevision(frozen.source.content, composition.text, frozen.config.wordsPerChapter, frozen.uiLocale)
    this.assertSession(params)
    this.assertNotCancelled(params.context)
    const handle = params.context.mainGenerationRunHandle
    if (!handle) throw new Error('GENERATION_REVIEW_REVISION_HANDLE_REQUIRED')
    return ipc.invokeWithProjectSession(requireWorkflowProjectSession(params.context), 'review-revision:commit-revision', {
      contextId: prepared.contextId, handle, expectedCompositionHash: composition.textHash,
    })
  }

  private async openReceipt(receipt: ReviewRevisionCommitReceipt, frozen: ReviewRevisionContext, params: CommandExecuteParams): Promise<string> {
    this.assertSession(params)
    this.assertNotCancelled(params.context)
    const expectedKind = this.operation === 'review-chapter' ? 'review' : 'revision'
    if (!receipt.success || receipt.kind !== expectedKind || !Number.isSafeInteger(receipt.id) || receipt.id <= 0
      || await hashAuthorText(receipt.content) !== receipt.contentHash
      || receipt.source.id !== frozen.source.id || receipt.source.chapterNumber !== frozen.source.chapterNumber
      || receipt.source.version !== frozen.source.version || receipt.source.status !== frozen.source.status
      || receipt.source.content !== frozen.source.content) throw new Error('GENERATION_REVIEW_REVISION_RECEIPT_MISMATCH')
    this.assertSession(params)
    const { context, callbacks } = params
    const text = (zh: string, en: string) => workflowUiText({ ...context, uiLocale: frozen.uiLocale }, zh, en)
    const sourcePath = formatResourceUri({ kind: 'draft', id: receipt.source.id })
    const chapter = receipt.source.chapterNumber
    const { useEditorStore } = await import('../../../stores/editor-store')
    this.assertSession(params)
    this.assertNotCancelled(context)
    if (receipt.kind === 'review') {
      useEditorStore.getState().openFile({
        id: `review-${sourcePath}-${receipt.index}`, name: text(`审稿报告：第${chapter}章`, `Review report: Chapter ${chapter}`),
        type: 'review-report', content: receipt.content, filePath: sourcePath,
        reportPath: `ai-novel://draft/ch${chapter}/v${receipt.source.version}/review${receipt.index}`,
        reviewReport: receipt.content, chapterNumber: chapter, chapterDir: `ai-novel://draft/ch${chapter}`,
        reviewId: receipt.id, projectKey: context.projectPath,
      })
      callbacks.log(text(`审查完成，已生成审稿报告 r${receipt.index}`, `Review complete; created review report r${receipt.index}`))
    } else {
      const pending = receipt.revisionStatus === 'pending'
      const revisionPath = formatResourceUri({ kind: 'revision', id: receipt.id })
      useEditorStore.getState().openFile({
        id: `diff-${sourcePath}-${receipt.id}`,
        name: this.operation === 'refine-from-review'
          ? text(`审稿修复：第${chapter}章`, `Review fix: Chapter ${chapter}`)
          : text(`修稿合并：第${chapter}章`, `Revision merge: Chapter ${chapter}`),
        type: pending ? 'diff' : 'chapter', filePath: pending ? sourcePath : revisionPath,
        ...(!pending ? { draftStatus: 'archived' as const } : {}),
        originalContent: receipt.source.content, content: receipt.content, revisionPath,
        chapterNumber: chapter, chapterDir: `ai-novel://draft/ch${chapter}`, projectKey: context.projectPath,
      })
      context.data.refined = receipt.content
      context.data.refinedPath = sourcePath
      callbacks.log(this.operation === 'refine-from-review'
        ? text(`审稿修复完成（${countDraftUnits(receipt.content)} 字），修订稿版本 r${receipt.index}`,
          `Review-based revision complete (${countDraftUnits(receipt.content)} words); revision r${receipt.index} is ready.`)
        : text(`修稿完成（${countDraftUnits(receipt.content)} 字），修订稿版本 r${receipt.index}`,
          `Revision complete (${countDraftUnits(receipt.content)} words); revision r${receipt.index} is ready.`))
    }
    callbacks.replaceText?.(receipt.content)
    return receipt.content
  }
}
