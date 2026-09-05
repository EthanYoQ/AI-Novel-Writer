import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import type { NovelConfig } from '../../../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../../shared/project-session-context'
import { requireWorkflowProjectSession } from '../workflow-project-session'
import { workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import { composePromptSystemRole, resolvePromptTemplate, renderPrompt } from '../../prompt-templates'
import { promptLanguageText } from '../../prompt-language'
import type { WritingLanguage } from '../../../shared/writing-language'
import { GenerationAttemptError, PromptBudgetExceededError } from '../../generation/generation-harness'
import { BoundedCompletionFailure } from '../bounded-completion'
import {
  GENERATED_GLOBAL_GUIDANCE_MAX_CHARS,
  preserveAuthorText,
} from '../novel-config-expansion'

/**
 * 支持的单字段生成 Key
 * 每个 key 对应 NovelConfig 中的一个文本字段
 */
export type GeneratableField =
  | 'coreOutline'
  | 'worldSetting'
  | 'goldenFinger'
  | 'protagonistProfile'
  | 'globalGuidance'
  | 'writingStyle'

const FIELD_LABELS: Record<GeneratableField, readonly [string, string]> = {
  coreOutline: ['核心大纲', 'Core outline'],
  worldSetting: ['世界观设定', 'World setting'],
  goldenFinger: ['金手指/核心卖点', 'Special advantage / core story engine'],
  protagonistProfile: ['主角人设', 'Protagonist profile'],
  globalGuidance: ['全局写作要求', 'Global writing guidance'],
  writingStyle: ['文风配置', 'Writing-style guide'],
}

/**
 * 单字段 AI 生成命令
 * 根据已有的 NovelConfig 上下文，只生成指定字段的内容
 */
export class GenerateFieldCommand extends BaseWorkflowCommand<string> {
  constructor(
    private fieldKey: GeneratableField,
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
    if (
      !project
      || !sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(project),
      )
    ) {
      throw new Error(workflowUiText(
        context,
        '当前项目已切换，字段生成已停止',
        'The current project changed, so field generation stopped.',
      ))
    }

    const config = project.novelConfig
    const writingLanguage = workflowWritingLanguage(context)
    const labelPair = FIELD_LABELS[this.fieldKey]
    const label = workflowUiText(context, labelPair[0], labelPair[1])

    callbacks.log(workflowUiText(context, `正在为「${label}」生成内容...`, `Generating “${label}”...`))

    // 构建上下文摘要（已填写的字段作为参考）
    const contextSummary = this.buildContext(config, writingLanguage)
    // 构建针对性 prompt
    const template = await resolvePromptTemplate(
      'generate_novel_config_field',
      projectSession,
      writingLanguage,
    )
    if (!template) throw new Error(workflowUiText(context, '未找到字段生成提示词', 'Field-generation prompt is unavailable'))
    const prompt = renderPrompt(template, {
      existing_config: contextSummary,
      field_label: promptLanguageText(writingLanguage, labelPair[0], labelPair[1]),
      field_requirements: this.fieldRequirements(config, writingLanguage),
    }, writingLanguage)
    const systemPrompt = composePromptSystemRole(template, writingLanguage)

    let result: string
    try {
      result = await this.callLLM(
        prompt,
        systemPrompt,
        callbacks,
        {
          purpose: `generate-field-${this.fieldKey}`,
          reasoningStage: 'planning',
          writingSkillStage: 'planning',
        },
        context,
      )
    } catch (error) {
      if (context.cancelled) this.assertNotCancelled(context)
      if (error instanceof BoundedCompletionFailure || error instanceof PromptBudgetExceededError) {
        throw error
      }
      const safeMessage = workflowUiText(
        context,
        '字段生成失败，请重试。',
        'Field generation failed. Please try again.',
      )
      if (error instanceof GenerationAttemptError) {
        const code = error.code === 'CANCELLED'
          || error.code === 'DEADLINE_EXHAUSTED'
          || error.code === 'PROVIDER_REQUEST_FAILED'
          ? error.code
          : 'PROVIDER_REQUEST_FAILED'
        throw new GenerationAttemptError(code, safeMessage, error.receipt)
      }
      throw new Error(safeMessage)
    }
    this.assertNotCancelled(context)
    const cleanResult = this.stripThinkingTags(result).trim()

    if (!cleanResult) {
      callbacks.log(workflowUiText(context, `「${label}」生成返回空结果`, `Generation returned no content for “${label}”.`))
      return ''
    }
    if (
      this.fieldKey === 'globalGuidance'
      && cleanResult.length > GENERATED_GLOBAL_GUIDANCE_MAX_CHARS
    ) {
      throw new Error(workflowUiText(
        context,
        `AI 生成的全局写作要求超过 ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} 字符，结果未保存。`,
        `The generated global writing guidance exceeds ${GENERATED_GLOBAL_GUIDANCE_MAX_CHARS} characters and was not saved.`,
      ))
    }

    // LLM 返回后再次核对冻结项目，禁止把旧项目上下文写入后来切换的项目。
    let projectState = useProjectStore.getState()
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(projectState.currentProject),
    )) {
      throw new Error(workflowUiText(
        context,
        '当前项目已切换，字段生成结果未保存',
        'The current project changed, so the generated field was not saved.',
      ))
    }

    // updateNovelConfig 是同步操作，此处检查与修改之间不会让出事件循环。
    this.assertNotCancelled(context)
    const { updateNovelConfig, saveProject } = projectState
    const expandedResult = preserveAuthorText(config[this.fieldKey], cleanResult)
    updateNovelConfig({ [this.fieldKey]: expandedResult }, projectSession)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error(workflowUiText(
        context,
        '当前项目已切换，字段生成结果未保存',
        'The current project changed, so the generated field was not saved.',
      ))
    }
    this.assertNotCancelled(context)
    const saved = await saveProject(projectSession)
    this.assertNotCancelled(context)
    projectState = useProjectStore.getState()
    if (!saved) {
      throw new Error(workflowUiText(
        context,
        '字段生成结果保存失败',
        'The generated field could not be saved.',
      ))
    }
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(projectState.currentProject),
    )) {
      throw new Error(workflowUiText(
        context,
        '当前项目已切换，字段生成已停止',
        'The current project changed, so field generation stopped.',
      ))
    }
    callbacks.log(workflowUiText(context, `「${label}」已生成并保存`, `“${label}” was generated and saved.`))

    return expandedResult
  }

  /** 构建已有配置的上下文摘要 */
  private buildContext(config: NovelConfig, writingLanguage: WritingLanguage): string {
    const parts: string[] = []
    const line = (zhLabel: string, enLabel: string, value: string | number) => (
      `- ${promptLanguageText(writingLanguage, zhLabel, enLabel)}: ${value}`
    )
    if (config.genre) parts.push(line('类型', 'Genre', config.genre))
    if (config.subGenre) parts.push(line('细分类型', 'Subgenre', config.subGenre))
    if (config.targetAudience) parts.push(line('目标受众', 'Target audience', config.targetAudience))
    if (config.totalChapters) parts.push(line('总章数', 'Total chapters', config.totalChapters))
    if (config.wordsPerChapter) parts.push(line('每章目标字数', 'Target words per chapter', config.wordsPerChapter))
    if (config.coreOutline?.trim())
      parts.push(line('核心大纲', 'Core outline', config.coreOutline))
    if (config.worldSetting?.trim())
      parts.push(line('世界观设定', 'World setting', config.worldSetting))
    if (config.goldenFinger?.trim())
      parts.push(line('金手指体系', 'Special advantage', config.goldenFinger))
    if (config.protagonistProfile?.trim())
      parts.push(line('主角人设', 'Protagonist profile', config.protagonistProfile))
    if (config.globalGuidance?.trim())
      parts.push(line('全局写作要求', 'Global writing guidance', config.globalGuidance))
    if (config.referenceWorks?.trim())
      parts.push(line('参考作品', 'Reference works', config.referenceWorks))
    if (config.writingStyle?.trim())
      parts.push(line('文风描述', 'Writing style', config.writingStyle))
    return parts.length > 0
      ? parts.join('\n')
      : promptLanguageText(writingLanguage, '（尚未填写任何配置）', '(No configuration has been provided yet.)')
  }

  private fieldRequirements(config: NovelConfig, writingLanguage: WritingLanguage): string {
    const fieldPrompts: Record<GeneratableField, readonly [string, string]> = {
      coreOutline: ['不少于150字，包含主角开局困境、核心目标、主要冲突升级与最终危机，明确故事的差异化吸引力。', 'Write at least 150 words covering the protagonist’s opening predicament, core objective, escalating conflict, final crisis, and distinctive story appeal.'],
      worldSetting: ['描述时代、地点、力量或制度规则、权力结构和稀缺资源；每项设定都应能制造具体冲突。', 'Describe the era, setting, governing rules or power system, power structure, and scarce resources. Every element should create concrete conflict.'],
      goldenFinger: ['说明差异化优势的来源、机制、成长路径、限制与代价，使其与世界规则发生冲突而非成为万能能力。', 'Define the origin, mechanism, growth path, limits, and cost of the protagonist’s special advantage. It must interact with world rules rather than solve everything.'],
      protagonistProfile: ['包含外在形象、真实个性、反差弱点、显性目标、深层渴望，以及清晰的成长弧起点和方向。', 'Include public persona, true personality, a contrasting weakness, visible goal, deeper desire, and a clear starting point and direction for the character arc.'],
      globalGuidance: ['写 4–8 条跨章节长期有效的简短执行规则，总计不超过 600 字；禁止逐章列大纲、分配章节区间或复述核心大纲。', 'Write 4–8 short, stable, cross-chapter execution rules within 600 characters. Do not enumerate chapters, allocate chapter ranges, or restate the core outline.'],
      writingStyle: [`提供不少于100字的可执行文风指南，涵盖节奏、场景切换、描写密度、对话、用词、情感基调和标志性手法，并适配${config.genre || '当前题材'}与${config.targetAudience || '目标受众'}。`, `Provide an actionable style guide of at least 100 words covering pacing, scene transitions, descriptive density, dialogue, diction, emotional tone, and signature techniques, suited to ${config.genre || 'the genre'} and ${config.targetAudience || 'the target audience'}.`],
    }
    return promptLanguageText(writingLanguage, ...fieldPrompts[this.fieldKey])
  }
}
