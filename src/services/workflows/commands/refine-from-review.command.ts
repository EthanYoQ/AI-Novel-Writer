import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from './base-command'
import type { PreparedReviewRevisionContext } from '../../../shared/review-revision-generation'
import { ReviewRevisionCommand, type ReviewRevisionCommandSource } from './review-revision-command'
import { hasIncludedReviewItems, parseHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief } from '../../../shared/human-confirmed-review'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'

export interface RefineFromReviewParams extends ReviewRevisionCommandSource {
  confirmedReviewContent?: string
  reviewSourceId?: number
  /** @deprecated Only the persisted confirmation is a revision input. */
  reviewReport?: string
  reviewFileName?: string
  /** @deprecated Author guidance is read from the persisted confirmation. */
  userRefinePrompt?: string
}

export class RefineFromReviewCommand extends ReviewRevisionCommand {
  private readonly requested: RefineFromReviewParams
  constructor(params: RefineFromReviewParams, dependencies?: WorkflowGenerationRuntimeDependencies) {
    super('refine-from-review', params, [], {
      reviewSourceId: params.reviewSourceId, confirmedReviewContent: params.confirmedReviewContent,
    }, dependencies)
    this.requested = params
  }

  override execute(params: CommandExecuteParams): Promise<string> {
    if (!this.requested.recoveryHandle) {
      if (!Number.isSafeInteger(this.requested.reviewSourceId) || (this.requested.reviewSourceId ?? 0) <= 0) {
        return Promise.reject(new Error(workflowUiText(params.context, '审稿修稿需要已保存的人工确认快照，未调用模型。',
          'Review-based revision requires a saved human-confirmed review snapshot. The model was not called.')))
      }
      if (!parseHumanConfirmedReviewSnapshot(this.requested.confirmedReviewContent ?? '')) {
        return Promise.reject(new Error(workflowUiText(params.context, '审稿修稿需要有效的人工确认快照，未调用模型。',
          'Review-based revision requires a valid human-confirmed review snapshot. The model was not called.')))
      }
    }
    return super.execute(params)
  }

  protected async generateAndCommit(prepared: PreparedReviewRevisionContext, params: CommandExecuteParams) {
    if (this.recovery?.composition && this.recovery.lastCompositionFinishReason === 'stop') {
      return this.generateRevision(prepared, params, '', '')
    }
    const frozen = prepared.context
    const confirmation = frozen.confirmation?.snapshot
    if (!confirmation?.sourceDraft || !hasIncludedReviewItems(confirmation)) throw new Error(workflowUiText(params.context,
      '缺少有效的已确认审稿清单，请重新确认。', 'A valid confirmed review checklist is required. Confirm the review again.'))
    params.callbacks.log(workflowUiText(params.context, '正在根据已确认的审稿项精准修复...', 'Revising from the confirmed review checklist...'))
    const projectSession = requireWorkflowProjectSession(params.context)
    const template = await resolvePromptTemplate('refine_from_review', projectSession, frozen.writingLanguage)
    if (!template) throw new Error(workflowUiText(params.context, '未找到审稿修复模板', 'The review-based revision template was not found.'))
    const builder = new ChapterPromptBuilder(template, frozen.writingLanguage)
      .withReviewReport(renderHumanConfirmedReviewBrief(confirmation, frozen.writingLanguage))
      .withDraftContent(frozen.source.content)
      .withGlobalGuidance(frozen.config.globalGuidance || '')
      .withUserRefinePrompt('')
    return this.generateRevision(prepared, params, builder.build(), builder.getSystemRole())
  }
}
