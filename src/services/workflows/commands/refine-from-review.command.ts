import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from './base-command'
import type { PreparedReviewRevisionContext } from '../../../shared/review-revision-generation'
import { ReviewRevisionCommand, type ReviewRevisionCommandSource } from './review-revision-command'
import { hasIncludedReviewItems, parseHumanConfirmedReviewSnapshot, renderHumanConfirmedReviewBrief } from '../../../shared/human-confirmed-review'
import { hashAuthorText } from '../../../shared/source-ref'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import {
  ChapterMaterialCapacityError,
  selectReviewRevisionMaterials,
  type ReviewRevisionMaterialAdmission,
} from '../chapter-materials'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'
import { countDraftUnits } from '../../../shared/draft-units'

function appendCompleteRevisionContract(prompt: string, source: string, writingLanguage: 'zh-CN' | 'en-US'): string {
  const sourceUnits = countDraftUnits(source)
  const range = { minimum: Math.floor(sourceUnits * 0.8), maximum: Math.ceil(sourceUnits * 1.2) }
  const contract = writingLanguage === 'en-US'
    ? `[Complete-revision hard constraint]\nThe frozen source contains ${sourceUnits} prose units. Output the complete revised chapter, between ${range.minimum} and ${range.maximum} prose units (80%-120% of the source). Preserve every unaffected paragraph or line in full. Do not summarize, excerpt, collapse repeated passages, or use placeholders. Apply only the confirmed findings. If a confirmed finding requires an action or result to occur in this chapter, the added action or result must itself satisfy the finding's target meaning and must already have happened in the prose. For a cost or loss, show the concrete consequence already lost, spent, or endured; signing, accepting responsibility, or saying that a character will pay later remains a promise and is not the cost itself. Merely reversing a negation, or stating an abstract decision, plan, promise, or commitment, does not count. Reconcile later paragraphs so they do not preserve a state that contradicts the new event. Output revision prose only.`
    : `【完整修稿硬约束】\n冻结源稿共 ${sourceUnits} 个正文单位。必须输出修订后的完整章节，长度须在 ${range.minimum}-${range.maximum} 个正文单位之间（源稿的 80%-120%）。所有未受影响的段落或行必须完整保留；不得摘要、节选、合并重复段落或使用占位符。只处理已确认的问题。若已确认问题要求当章发生动作或结果，新增动作或结果本身必须满足该问题的目标语义，并且已经在正文中发生。对于代价或损失，必须写出已经失去、消耗或承受的具体后果；签字、认责或声称以后负责仍只是承诺，不是代价本身。简单否定翻转，或抽象的决定、计划、承诺、保证，均不算完成。必须同步修正后文，不得保留与新增事件相反的状态。最终只输出修订后正文。`
  return `${prompt}\n\n${contract}`
}

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
    // 本入口的证据材料就是人工确认快照渲染出的清单：它是作者已确认的事实，
    // 因此按 author 来源、必需材料进同一条准入。措辞不变，渲染文本逐字透传。
    const reviewBrief = renderHumanConfirmedReviewBrief(confirmation, frozen.writingLanguage)
    const current = { projectId: projectSession.projectId, epoch: projectSession.leaseId }
    let admission: ReviewRevisionMaterialAdmission
    try {
      admission = selectReviewRevisionMaterials({
        current,
        writingLanguage: frozen.writingLanguage,
        materials: [{
          identity: { projectId: current.projectId, sourceId: `review:confirmed:${frozen.confirmation!.reviewSourceId}`,
            revision: frozen.confirmation!.reviewSourceId, contentHash: await hashAuthorText(reviewBrief),
            provenance: 'author' },
          category: 'author',
          required: true,
          text: reviewBrief,
        }],
        relevanceTerms: [],
      })
    } catch (error) {
      if (!(error instanceof ChapterMaterialCapacityError)) throw error
      throw new Error(workflowUiText(params.context,
        '已确认的审稿清单超出上下文容量，已停止修稿。请精简审稿项后重试。',
        'The confirmed review checklist exceeds the context capacity, so the revision stopped. Trim the review items and try again.'))
    }
    const builder = new ChapterPromptBuilder(template, frozen.writingLanguage)
      .withReviewReport(admission.admitted[0]?.text ?? '')
      .withDraftContent(frozen.source.content)
      .withGlobalGuidance(frozen.config.globalGuidance || '')
      .withUserRefinePrompt('')
    const prompt = appendCompleteRevisionContract(builder.build(), frozen.source.content, frozen.writingLanguage)
    await this.bindMaterialDecision(params, admission.decision, prompt)
    return this.generateRevision(prepared, params, prompt, builder.getSystemRole())
  }
}
