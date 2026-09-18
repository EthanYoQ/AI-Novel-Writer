import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from './base-command'
import type { ChapterInfo } from '../chapter-workflow'
import type { PreparedReviewRevisionContext, ReviewRevisionContext } from '../../../shared/review-revision-generation'
import { ReviewRevisionCommand, type ReviewRevisionCommandSource } from './review-revision-command'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { promptLanguageText } from '../../prompt-language'
import {
  ChapterMaterialCapacityError,
  selectReviewRevisionMaterials,
  unknownReviewMaterialIdentity,
  type ChapterMaterialIdentity,
  type ReviewRevisionMaterial,
  type ReviewRevisionMaterialAdmission,
} from '../chapter-materials'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'

export interface RefineDraftParams extends ReviewRevisionCommandSource {
  chapterInfo: ChapterInfo
  mergedGuidance?: string
  userRefinePrompt?: string
  shortSummary?: string
}

/**
 * 修稿路径的材料候选：材料文本就是定稿原文本身，因此准入没有改变集合时
 * `join('\n\n')` 的结果与接入前逐字节相同。前一章的定稿是必需锚点。
 *
 * 导出是为了让 `context-entry-parity.test.ts` 驱动本入口**真实的**装配缝，
 * 而不是在测试里另写一份近似实现。
 */
export function refineHistoryMaterials(frozen: ReviewRevisionContext, current: ChapterMaterialIdentity): ReviewRevisionMaterial[] {
  return frozen.history.map(item => ({
    identity: item.identity ?? unknownReviewMaterialIdentity(current),
    category: 'finalized-history',
    required: item.chapterNumber === frozen.source.chapterNumber - 1,
    text: item.content,
  }))
}

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
      admission = selectReviewRevisionMaterials({
        current,
        writingLanguage: language,
        materials: refineHistoryMaterials(frozen, current),
        relevanceTerms: [blueprint?.title ?? '', blueprint?.keyEvents ?? '', ...(blueprint?.characters ?? [])],
      })
    } catch (error) {
      if (!(error instanceof ChapterMaterialCapacityError)) throw error
      const blocked = error.decision.decision === 'capacity-conflict'
        ? `${error.decision.blockingSourceId}:${error.decision.blockingReason}`
        : error.decision.remainingRequired.join('、')
      params.callbacks.log(workflowUiText(params.context,
        `  必需材料超出上下文容量（${error.decision.decision}）：${blocked}`,
        `  Required material exceeds the context capacity (${error.decision.decision}): ${blocked}`))
      throw new Error(workflowUiText(params.context,
        '本章修稿的必需材料（前一章定稿）超出上下文容量，已停止修稿。请精简该章定稿材料后重试。',
        'The required material for this revision (the previous chapter\'s finalized manuscript) exceeds the context capacity, so the revision stopped. Trim that chapter and try again.'))
    }
    // 准入只决定成员；顺序仍是定稿历史的原有顺序，因此集合未变时提示词逐字节不变。
    const historySummary = admission.admitted.map(material => material.text).join('\n\n')
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
    return this.generateRevision(prepared, params, builder.build(), builder.getSystemRole())
  }
}
