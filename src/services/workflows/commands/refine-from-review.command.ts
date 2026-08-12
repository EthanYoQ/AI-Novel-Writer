import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ChapterPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import { requireWorkflowProjectSession } from '../workflow-project-session'


export interface RefineFromReviewParams {
  draftPath: string
  draftContent: string
  reviewReport: string
  reviewFileName?: string
  chapterNumber: number
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
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error('当前项目已切换，修稿已停止')
    const novelConfig = Object.freeze({ ...project.novelConfig })

    callbacks.log('正在根据审稿报告精准修复...')

    const template = await resolvePromptTemplate('refine_from_review', projectSession)
    if (!template) throw new Error('未找到审稿修复模板')

    const userPromptBlock = this.params.userRefinePrompt?.trim()
      ? `★【用户额外修稿指导（绝对优先级）】★：\n${this.params.userRefinePrompt}`
      : ''

    const promptBuilder = new ChapterPromptBuilder(template)
      .withReviewReport(this.params.reviewReport)
      .withDraftContent(this.params.draftContent)
      .withGlobalGuidance(novelConfig.globalGuidance || '')
      .withUserRefinePrompt(userPromptBlock)

    const refined = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, context)
    this.assertNotCancelled(context)
    const cleanRefined = this.stripThinkingTags(refined)

    const baseDraft = await readWorkflowDraftMeta(this.params.draftPath, context.projectPath, projectSession)
    if (!baseDraft) throw new Error('找不到基准草稿版本')

    // 清理该草稿下已有的 pending 状态修稿，保证只保留最新的一条
    const pendingRevs = await ipc.invokeWithProjectSession(projectSession, 'db:revision-get-pending', baseDraft.id, context.projectPath)
    for (const rev of pendingRevs) {
      this.assertNotCancelled(context)
      const discardResult = await ipc.invokeWithProjectSession(projectSession, 'db:revision-mark-discarded', rev.id, context.projectPath)
      requireIpcSuccess(discardResult, '清理旧修订稿')
    }

    this.assertNotCancelled(context)
    const createRes = await ipc.invokeWithProjectSession(projectSession, 'db:revision-create', {
      baseDraftId: baseDraft.id,
      revisionType: 'review-fix',
      content: cleanRefined,
      wordCount: cleanRefined.length,
      userPrompt: this.params.userRefinePrompt,
    }, context.projectPath)
    requireIpcSuccess(createRes, '创建审稿修订稿')
    if (createRes.id === undefined) throw new Error('创建审稿修订稿失败：未返回修订稿编号')

    const revIndex = createRes.revisionIndex ?? 0

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error('当前项目已切换，已拒绝打开旧修订稿')
    const { useEditorStore } = await import('../../../stores/editor-store')
    useEditorStore.getState().openFile({
      id: `diff-${this.params.draftPath}-${createRes.id}`,
      name: `审稿修复：第${this.params.chapterNumber}章`,
      type: 'diff',
      filePath: this.params.draftPath,
      originalContent: this.params.draftContent,
      content: cleanRefined,
      revisionPath: String(createRes.id),
      chapterNumber: this.params.chapterNumber,
      chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
      projectKey: context.projectPath,
    })

    callbacks.log(`✅ 审稿修复完成（${cleanRefined.length} 字），已生成修订稿版本 r${revIndex}`)
    return refined
  }
}
