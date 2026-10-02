import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from './base-command'
import type { ChapterInfo } from '../chapter-workflow'
import type { PreparedReviewRevisionContext } from '../../../shared/review-revision-generation'
import { ReviewRevisionCommand, type ReviewRevisionCommandSource } from './review-revision-command'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { promptLanguageText } from '../../prompt-language'
import {
  ChapterMaterialCapacityError,
  type ReviewRevisionMaterialAdmission,
} from '../chapter-materials'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'
import { selectFrozenReviewRevisionMaterials } from './review-revision-materials'

export interface RefineDraftParams extends ReviewRevisionCommandSource {
  chapterInfo: ChapterInfo
  mergedGuidance?: string
  userRefinePrompt?: string
  shortSummary?: string
}

export { reviewHistoryMaterials as refineHistoryMaterials } from './review-revision-materials'

export class RefineDraftCommand extends ReviewRevisionCommand {
  constructor(params: RefineDraftParams, dependencies?: WorkflowGenerationRuntimeDependencies) {
    super('refine-draft', params, [
      { id: 'user-prompt', text: params.userRefinePrompt ?? '' },
      { id: 'merged-guidance', text: params.mergedGuidance ?? '' },
    ], {}, dependencies)
  }

  protected async generateAndCommit(prepared: PreparedReviewRevisionContext, params: CommandExecuteParams) {
    if (this.recovery?.composition && this.recovery.lastCompositionFinishReason === 'stop') {
      return this.generateRevision(prepared, params, '', '')
    }
    const frozen = prepared.context
    const language = frozen.writingLanguage
    params.callbacks.log(workflowUiText(params.context, '正在精修章节...', 'Refining the chapter...'))
    const projectSession = requireWorkflowProjectSession(params.context)
    const template = await resolvePromptTemplate('refine_chapter', projectSession, language)
    if (!template) throw new Error(workflowUiText(params.context, '未找到修稿模板', 'The revision prompt template was not found.'))
    const blueprint = frozen.blueprints.find(item => item.chapterNumber === frozen.source.chapterNumber)
    const guidance = frozen.authorInputs.find(input => input.id === 'merged-guidance')?.text || frozen.config.globalGuidance || ''
    const userPrompt = frozen.authorInputs.find(input => input.id === 'user-prompt')?.text || ''
    const userPromptBlock = userPrompt.trim() ? promptLanguageText(language,
      `【用户额外修稿指导（最高优先级）】\n${userPrompt}`,
      `[Additional author revision guidance — highest priority]\n${userPrompt}`) : ''
    // 与写稿/审稿路径同一套准入：定稿历史按身份整段纳入或整段省略，绝不无预算地整段拼接。
    const current = { projectId: projectSession.projectId, epoch: projectSession.leaseId }
    let admission: ReviewRevisionMaterialAdmission
    try {
      admission = await selectFrozenReviewRevisionMaterials(frozen, current)
    } catch (error) {
      if (!(error instanceof ChapterMaterialCapacityError)) throw error
      const blocked = error.decision.decision === 'capacity-conflict'
        ? `${error.decision.blockingSourceId}:${error.decision.blockingReason}`
        : error.decision.remainingRequired.join('、')
      params.callbacks.log(workflowUiText(params.context,
        `  必需材料超出上下文容量（${error.decision.decision}）：${blocked}`,
        `  Required material exceeds the context capacity (${error.decision.decision}): ${blocked}`))
      throw new Error(workflowUiText(params.context,
        '本章修稿的必需材料超出上下文容量，已停止修稿。请精简相关作者材料或前驱后重试。',
        'The required material for this revision exceeds the context capacity, so the revision stopped. Trim the required author material or predecessor and try again.'))
    }
    // Render only admitted materials; the frozen source text is never truncated.
    const historySummary = admission.admitted.filter(material => material.category === 'finalized-history').map(material => material.text).join('\n\n')
    const builder = new ChapterPromptBuilder(template, language)
      .withDraftContent(frozen.source.content)
      .withChapterInfo({ projectPath: params.context.projectPath, chapterNumber: frozen.source.chapterNumber,
        title: blueprint?.title ?? '', role: blueprint?.role ?? '', purpose: blueprint?.purpose ?? '',
        characters: blueprint?.characters ?? [], keyEvents: blueprint?.keyEvents ?? '' })
      .withGlobalGuidance(guidance)
      .withGlobalSummary(historySummary)
      .withShortSummary(historySummary)
      .withWordNumber(frozen.config.wordsPerChapter)
      .withWritingStyle(frozen.config.writingStyle || '')
      .withUserRefinePrompt(userPromptBlock)
    const prompt = [builder.build(), ...admission.admitted.filter(material => material.category !== 'finalized-history').map(material => material.text)].join('\n\n')
    await this.bindMaterialDecision(params, admission.decision, prompt)
    return this.generateRevision(prepared, params, prompt, builder.getSystemRole())
  }
}
