import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from './base-command'
import type { PreparedReviewRevisionContext } from '../../../shared/review-revision-generation'
import { ReviewRevisionCommand, type ReviewRevisionCommandSource } from './review-revision-command'
import { hasIncludedReviewItems, parseHumanConfirmedReviewSnapshot } from '../../../shared/human-confirmed-review'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import {
  ChapterMaterialCapacityError,
  type ReviewRevisionMaterialAdmission,
} from '../chapter-materials'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'
import { countDraftUnits, draftTargetUnitRange } from '../../../shared/draft-units'
import { selectFrozenReviewRevisionMaterials } from './review-revision-materials'
import { promptLanguageText } from '../../prompt-language'
import { reviewTimeContinuity } from '../../../shared/chapter-time-continuity'

function appendCompleteRevisionContract(prompt: string, source: string, writingLanguage: 'zh-CN' | 'en-US'): string {
  const sourceUnits = countDraftUnits(source)
  const range = draftTargetUnitRange(sourceUnits)
  const contract = writingLanguage === 'en-US'
    ? `[Complete revision task contract]
Confirming an AI finding selects the scope, not its factual claims or proposed replacement. Check each selected issue and proposed factual change against author facts, predecessor prose and the manuscript for the same subject, time and conditions. Resolve the selected issues established by the sources, using the smallest source-supported remedy; do not copy unsupported or conflicting replacements. If the facts remain uncertain, preserve that uncertainty rather than inventing a replacement fact. Explicit author-written requests remain author guidance. Do not polish or rewrite unrelated material; preserve the manuscript's voice and pacing.

The frozen source contains ${sourceUnits} prose units. Output the complete revised chapter. Aim for ${range.minimum}-${range.maximum} prose units (70%-130% of the source); the upper value is guidance. Completeness and author facts take priority. A longer complete revision is saved with a notice. Preserve every unaffected paragraph or line in full. Do not summarize, excerpt, collapse repeated passages, or use placeholders. If an established issue or explicit author request requires an action or result to occur in this chapter, the added action or result must itself satisfy that requirement's target meaning and must already have happened in the prose. For a cost or loss, show the concrete consequence already lost, spent, or endured; signing, accepting responsibility, or saying that a character will pay later remains a promise and is not the cost itself. Merely reversing a negation, or stating an abstract decision, plan, promise, or commitment, does not count. Reconcile later paragraphs so they do not preserve a state that contradicts the new event.

Output the complete revised chapter as plain prose only, without a preface, explanation, Markdown, analysis, or screenplay formatting. Leave one blank line between paragraphs.`
    : `【完整修稿任务合同】
确认 AI 意见只确定处理范围，不确认其事实判断或替换方案。先按作者事实、前驱原文和正文的对象、时点及条件核对所选问题及拟修改的事实。解决经来源核实后成立的问题，采用来源支持的最小修法；不得照搬无依据或与来源冲突的替换。仍无法确定时保留不确定性，不编造替换事实。作者亲写的明确要求仍按作者指导执行。不要润色或改写无关内容，保留原文风格和节奏。

冻结源稿共 ${sourceUnits} 个正文单位。必须输出修订后的完整章节，建议保持 ${range.minimum}-${range.maximum} 个正文单位（源稿的 70%-130%），其中上限仅作指导。完整性和作者事实优先，完整修稿仍超长时保存全文并提示。所有未受影响的段落或行必须完整保留；不得摘要、节选、合并重复段落或使用占位符。若成立的问题或作者明确要求当章发生动作或结果，新增动作或结果本身必须满足该要求的目标语义，并且已经在正文中发生。对于代价或损失，必须写出已经失去、消耗或承受的具体后果；签字、认责或声称以后负责仍只是承诺，不是代价本身。简单否定翻转，或抽象的决定、计划、承诺、保证，均不算完成。必须同步修正后文，不得保留与新增事件相反的状态。

最终只输出修订后完整正文，使用纯文本，不得包含开场白、解释、Markdown、分析或剧本式格式。段落之间保留一个空行。`
  return `${prompt}\n\n${reviewTimeContinuity(writingLanguage)}\n\n${contract}`
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
    const current = { projectId: projectSession.projectId, epoch: projectSession.leaseId }
    let admission: ReviewRevisionMaterialAdmission
    try {
      admission = await selectFrozenReviewRevisionMaterials(frozen, current)
    } catch (error) {
      if (!(error instanceof ChapterMaterialCapacityError)) throw error
      throw new Error(workflowUiText(params.context,
        '审稿修稿必需材料超出上下文容量，已停止修稿。请精简必需材料后重试。',
        'The confirmed review checklist exceeds the context capacity, so the revision stopped. Trim the review items and try again.'))
    }
    const aiReviewSourceId = `review:confirmed:${frozen.confirmation!.reviewSourceId}`
    const basis = admission.admitted.filter(material => material.identity.sourceId !== aiReviewSourceId)
      .map(material => material.text).join('\n\n')
    const builder = new ChapterPromptBuilder(template, frozen.writingLanguage)
      .withReviewReport(admission.admitted.filter(material => material.identity.sourceId === aiReviewSourceId)
        .map(material => material.text).join('\n\n'))
      .withDraftContent(frozen.source.content)
      .withGlobalGuidance(frozen.config.globalGuidance || '')
      .withUserRefinePrompt('')
    const prompt = appendCompleteRevisionContract([
      promptLanguageText(frozen.writingLanguage, '【修稿依据｜作者材料与前驱原文】', '[Revision sources | author material and predecessor prose]'),
      basis, builder.build(),
    ].join('\n\n'), frozen.source.content, frozen.writingLanguage)
    await this.bindMaterialDecision(params, admission.decision, prompt)
    return this.generateRevision(prepared, params, prompt, builder.getSystemRole())
  }
}
