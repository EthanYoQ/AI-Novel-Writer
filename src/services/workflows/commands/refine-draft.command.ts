import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from './base-command'
import type { ChapterInfo } from '../chapter-workflow'
import type { PreparedReviewRevisionContext } from '../../../shared/review-revision-generation'
import { ReviewRevisionCommand, type ReviewRevisionCommandSource } from './review-revision-command'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { promptLanguageText } from '../../prompt-language'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'

export interface RefineDraftParams extends ReviewRevisionCommandSource {
  chapterInfo: ChapterInfo
  mergedGuidance?: string
  userRefinePrompt?: string
  shortSummary?: string
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
    const template = await resolvePromptTemplate('refine_chapter', requireWorkflowProjectSession(params.context), language)
    if (!template) throw new Error(workflowUiText(params.context, '未找到修稿模板', 'The revision prompt template was not found.'))
    const blueprint = frozen.blueprints.find(item => item.chapterNumber === frozen.source.chapterNumber)
    const guidance = frozen.authorInputs.find(input => input.id === 'merged-guidance')?.text || frozen.config.globalGuidance || ''
    const userPrompt = frozen.authorInputs.find(input => input.id === 'user-prompt')?.text || ''
    const userPromptBlock = userPrompt.trim() ? promptLanguageText(language,
      `【用户额外修稿指导（最高优先级）】\n${userPrompt}`,
      `[Additional author revision guidance — highest priority]\n${userPrompt}`) : ''
    const summary = frozen.history.map(item => item.content).join('\n\n')
    const builder = new ChapterPromptBuilder(template, language)
      .withDraftContent(frozen.source.content)
      .withChapterInfo({ projectPath: params.context.projectPath, chapterNumber: frozen.source.chapterNumber,
        title: blueprint?.title ?? '', role: blueprint?.role ?? '', purpose: blueprint?.purpose ?? '',
        characters: blueprint?.characters ?? [], keyEvents: blueprint?.keyEvents ?? '' })
      .withGlobalGuidance(guidance)
      .withGlobalSummary(summary)
      .withShortSummary(summary)
      .withWordNumber(frozen.config.wordsPerChapter)
      .withWritingStyle(frozen.config.writingStyle || '')
      .withUserRefinePrompt(userPromptBlock)
    return this.generateRevision(prepared, params, builder.build(), builder.getSystemRole())
  }
}
