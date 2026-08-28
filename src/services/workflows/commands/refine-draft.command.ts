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
import { promptLanguageText } from '../../prompt-language'
import { assertMateriallyCompleteRevision } from './refinement-completeness'

import type { ChapterInfo } from '../chapter-workflow'

export interface RefineDraftParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  chapterInfo: ChapterInfo
  mergedGuidance?: string
  userRefinePrompt?: string
  shortSummary?: string
}

export class RefineDraftCommand extends BaseWorkflowCommand<string> {
  constructor(
    private params: RefineDraftParams,
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
    )) throw new Error(text('当前项目已切换，修稿已停止', 'The project changed, so the revision stopped.'))
    const novelConfig = Object.freeze({ ...project.novelConfig })

    const draft = this.params.draftContent
    if (!draft) throw new Error(text('无草稿内容', 'There is no draft content to revise.'))

    callbacks.log(text('正在进行大神级修稿...', 'Refining the chapter...'))

    const template = await resolvePromptTemplate('refine_chapter', projectSession, writingLanguage)
    if (!template) throw new Error(text('未找到修稿模板', 'The revision prompt template was not found.'))

    const mergedGuidance = this.params.mergedGuidance || novelConfig.globalGuidance || ''
    const userPromptBlock = this.params.userRefinePrompt?.trim()
      ? promptLanguageText(
          writingLanguage,
          `【用户额外修稿指导（最高优先级）】\n${this.params.userRefinePrompt}`,
          `[Additional author revision guidance — highest priority]\n${this.params.userRefinePrompt}`,
        )
      : ''

    const promptBuilder = new ChapterPromptBuilder(template, writingLanguage)
      .withDraftContent(draft)
      .withChapterInfo(this.params.chapterInfo)
      .withGlobalGuidance(mergedGuidance)
      .withGlobalSummary(this.params.shortSummary || '')
      .withShortSummary(this.params.shortSummary || '')
      .withWordNumber(novelConfig.wordsPerChapter)
      .withWritingStyle(novelConfig.writingStyle || '')
      .withUserRefinePrompt(userPromptBlock)

    const refined = await this.callLLMWithBoundedCompletion(
      promptBuilder.build(),
      promptBuilder.getSystemRole(),
      callbacks,
      { mode: 'append-visible-text', maxContinuations: 3 },
      { purpose: 'refine-draft', reasoningStage: 'review' },
      context,
    )
    this.assertNotCancelled(context)
    const cleanRefined = this.stripThinkingTags(refined).trim()
    assertMateriallyCompleteRevision(
      draft,
      cleanRefined,
      novelConfig.wordsPerChapter,
      workflowUiLocale(context),
    )

    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text('当前项目已切换，修稿结果未保存', 'The project changed, so the revision was not saved.'))

    const baseDraft = await readWorkflowDraftMeta(this.params.draftPath, context.projectPath, projectSession)
    if (!baseDraft) throw new Error(text('找不到基准草稿版本', 'The source draft version could not be found.'))

    this.assertNotCancelled(context)
    const createRes = await ipc.invokeWithProjectSession(projectSession, 'db:revision-replace-pending', {
      baseDraftId: baseDraft.id,
      revisionType: 'refine',
      content: cleanRefined,
      wordCount: cleanRefined.length,
    }, context.projectPath)
    requireIpcSuccess(createRes, text('创建修订稿', 'Create the pending revision'))
    if (createRes.id === undefined) {
      throw new Error(text('创建修订稿失败：未返回修订稿编号', 'The pending revision did not return an ID.'))
    }

    const revIndex = createRes.revisionIndex ?? 0

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text('当前项目已切换，已拒绝打开旧修订稿', 'The project changed, so the stale revision was not opened.'))
    const { useEditorStore } = await import('../../../stores/editor-store')
    useEditorStore.getState().openFile({
      id: `diff-${this.params.draftPath}-${createRes.id}`,
      name: text(
        `修稿合并：第${this.params.chapterNumber}章`,
        `Revision merge: Chapter ${this.params.chapterNumber}`,
      ),
      type: 'diff',
      filePath: this.params.draftPath,
      originalContent: this.params.draftContent,
      content: cleanRefined,
      revisionPath: String(createRes.id),
      chapterNumber: this.params.chapterNumber,
      chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
      projectKey: context.projectPath,
    })

    context.data.refined = cleanRefined
    context.data.refinedPath = this.params.draftPath
    callbacks.log(text(
      `修稿完成（${cleanRefined.length} 字），已生成修订稿版本 r${revIndex}`,
      `Revision complete (${cleanRefined.length} characters); created revision r${revIndex}`,
    ))
    return cleanRefined
  }
}
