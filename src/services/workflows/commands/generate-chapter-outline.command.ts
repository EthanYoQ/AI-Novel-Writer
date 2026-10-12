import { randomUUID } from 'node:crypto'
import { BaseWorkflowCommand, type CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../ipc-client'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { synopsisForDraftChapter } from './generate-draft.command'
import type { BlueprintData } from '../../../../electron/repositories/blueprint-repository'

/** 单章大纲 AI 起草命令：只返回大纲文本供作者编辑，不落盘、不替代作者确认。 */
export class GenerateChapterOutlineCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly blueprint: Pick<BlueprintData, 'chapterNumber' | 'title' | 'role' | 'purpose' | 'keyEvents' | 'characters' | 'suspenseHook' | 'userGuidance'>,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'chapter-outline:blueprint', text: JSON.stringify(this.blueprint) }],
      operation: 'generate-chapter-outline', promptKeys: ['chapter_outline_draft'], skillStages: ['planning'], output: 'visible-text',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(project))) {
      throw new Error(workflowUiText(context, '当前项目已切换，大纲生成已停止', 'The current project changed, so outline generation stopped.'))
    }
    const writingLanguage = workflowWritingLanguage(context)
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const blueprint = this.blueprint

    callbacks.log(uiText(
      `正在为第 ${blueprint.chapterNumber} 章起草场景级大纲...`,
      `Drafting the scene-level outline for Chapter ${blueprint.chapterNumber}...`,
    ))

    // 上下文：小说配置 + 本章故事大纲投影 + 前一章蓝图要点（连续性）
    const config = project.novelConfig
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectSession.projectPath)
    const previousNotes = blueprint.chapterNumber > 1
      ? await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', blueprint.chapterNumber - 1, projectSession.projectPath)
      : null

    const configSummary = [config.coreOutline, config.worldSetting, config.goldenFinger, config.protagonistProfile]
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
      .join('\n')
    const chapterSynopsis = synopsisForDraftChapter(core?.synopsis ?? '', blueprint.chapterNumber)
    const previousSummary = previousNotes
      ? promptLanguageText(writingLanguage,
        `第${previousNotes.chapterNumber}章《${previousNotes.title}》要点：${previousNotes.notes || '（未提取）'}`,
        `Chapter ${previousNotes.chapterNumber} “${previousNotes.title}” notes: ${previousNotes.notes || '(none)'}`)
      : promptLanguageText(writingLanguage, '（本章为第一章）', '(This is the first chapter.)')

    const prompt = promptLanguageText(writingLanguage, [
      '请为本章起草一份场景级执行大纲，供作者审阅修改后用于正文写作。',
      '只输出大纲正文，不要标题、解释、Markdown 代码块或正文试写。',
      '要求：',
      '- 按场景分条（每条以「场景N：」开头），每条写清：场景目标 / 冲突或障碍 / 关键转折 / 结束状态。',
      '- 必须兑现本章定位、关键事件与悬念钩子；本章该发生的事件要落到具体动作与结果，不得用旧事复述替代。',
      '- 与前一章衔接自然，遵守既有事实与人物知识边界。',
      '- 3–6 个场景为宜；语言简练（每条 1–3 句），这是计划不是成稿。',
      '',
      `【小说核心设定】\n${configSummary || '（未填写）'}`,
      `【本章故事大纲】\n${chapterSynopsis || '（未填写）'}`,
      `【前一章要点】\n${previousSummary}`,
      `【本章蓝图】\n章号：第${blueprint.chapterNumber}章\n标题：${blueprint.title}\n定位：${blueprint.role}\n核心目的：${blueprint.purpose}\n关键事件：${blueprint.keyEvents}\n出场角色：${blueprint.characters.join('、') || '（未指定）'}\n悬念钩子：${blueprint.suspenseHook || '（无）'}`,
      `【作者微操指导（必须遵守）】\n${blueprint.userGuidance?.trim() || '（无）'}`,
    ].join('\n'), [
      'Draft a scene-level execution outline for this chapter. The author will review and edit it before prose writing.',
      'Output only the outline itself: no title, no explanation, no Markdown code fences, no prose sample.',
      'Requirements:',
      '- One item per scene, each starting with "Scene N:", covering: scene goal / conflict or obstacle / key turn / ending state.',
      '- Deliver this chapter\'s positioning, key events, and suspense hook; events required here must land as concrete actions and outcomes, not recaps of earlier chapters.',
      '- Transition naturally from the previous chapter and respect established facts and character knowledge boundaries.',
      '- Aim for 3–6 scenes; keep each item to 1–3 concise sentences. This is a plan, not finished prose.',
      '',
      `[Core novel setup]\n${configSummary || '(not provided)'}`,
      `[Chapter synopsis]\n${chapterSynopsis || '(not provided)'}`,
      `[Previous chapter notes]\n${previousSummary}`,
      `[Chapter blueprint]\nNumber: Chapter ${blueprint.chapterNumber}\nTitle: ${blueprint.title}\nRole: ${blueprint.role}\nPurpose: ${blueprint.purpose}\nKey events: ${blueprint.keyEvents}\nCharacters: ${blueprint.characters.join(', ') || '(none)'}\nSuspense hook: ${blueprint.suspenseHook || '(none)'}`,
      `[Author guidance (must follow)]\n${blueprint.userGuidance?.trim() || '(none)'}`,
    ].join('\n'))
    const systemPrompt = promptLanguageText(writingLanguage,
      '你是严谨的小说章节策划助手。你只做计划与拆解，不写正文，不确立新事实，不改变作者目标。',
      'You are a rigorous novel chapter planning assistant. You only plan and break down scenes; you never write prose, establish new facts, or change author goals.')

    const result = await this.callLLM(prompt, systemPrompt, callbacks,
      { purpose: 'chapter-outline-draft', reasoningStage: 'planning', writingSkillStage: 'planning' }, context)
    this.assertNotCancelled(context)
    const outline = this.stripThinkingTags(result).trim()
    if (!outline) throw new Error(uiText('大纲生成返回空结果，请重试。', 'Outline generation returned no content. Please try again.'))

    if (!sameProjectSessionContext(projectSession, projectSessionContextFromProject(useProjectStore.getState().currentProject))) {
      throw new Error(uiText('当前项目已切换，大纲结果未应用', 'The current project changed, so the outline was not applied.'))
    }
    callbacks.log(uiText('本章大纲已生成，请审阅修改后保存。', 'Chapter outline generated. Review, edit, and save it.'))
    return outline
  }
}

/** UI 侧直接调用入口使用的合成 runId 前缀。 */
export function chapterOutlineRunId(): string {
  return `chapter-outline:${randomUUID()}`
}
