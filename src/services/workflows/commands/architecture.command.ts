import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { requireWorkflowProjectSession } from '../workflow-project-session'

import type { NovelConfig, ProjectSessionContext } from '../../../shared/ipc-channels'

// --- 基础工具库 ---

interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  synopsis_result?: string
}

export interface ArchitectureProjectSnapshot {
  expectedProjectPath: string
  novelConfig: Readonly<NovelConfig>
}

function assertArchitectureProjectSessionCurrent(projectSession: ProjectSessionContext): void {
  if (!sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) {
    throw new Error('当前项目已切换，架构生成已停止以避免写入错误项目')
  }
}

async function loadPartialData(
  projectPath: string,
  projectSession: ProjectSessionContext,
): Promise<PartialArchData> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:read-json',
    `${projectPath}/.vela/partial_arch.json`,
    projectPath,
  )
  if (result.success && result.data) return result.data as PartialArchData
  return {}
}

export async function savePartialData(
  projectPath: string,
  data: PartialArchData,
  projectSession: ProjectSessionContext,
): Promise<void> {
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:write-json',
    `${projectPath}/.vela/partial_arch.json`,
    data,
    projectPath,
  )
  requireIpcSuccess(result, '保存架构生成检查点')
}

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
}

async function writeArchToDb(
  key: 'premise' | 'charactersArch' | 'worldbuilding' | 'synopsis',
  content: string,
  expectedProjectPath: string,
  runId: string,
  projectSession: ProjectSessionContext,
): Promise<void> {
  const cleanContent = stripThinkingTags(content)
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'db:project-core-update',
    { [key]: cleanContent },
    expectedProjectPath,
  )
  if (!result.success) {
    throw new Error(result.error || '故事架构写入数据库失败')
  }

  // 通知 UI 层实时刷新架构完成状态
  const { globalEventBus } = await import('../../../shared/event-bus')
  globalEventBus.emit('ARCH_FILE_UPDATED', {
    fileName: `${key}.md`,
    projectPath: expectedProjectPath,
    projectSession,
    runId,
  })
}

// --- 独立命令类 ---

export class GenerateConfigCommand extends BaseWorkflowCommand<string> {
  constructor(
    private idea: string,
    private totalChapters: number,
    private wordsPerChapter: number,
    private onGenerated: (config: Partial<NovelConfig>) => void,
  ) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession)
    callbacks.log('正在调度配置专家 AI，准备解析您的脑洞...')

    const template = getPromptTemplate('generate_global_config', projectSession)
    if (!template) throw new Error('未找到 generate_global_config 模板')

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withUserIdea(this.idea)
      .withNumberOfChapters(this.totalChapters)
      .withWordNumber(this.wordsPerChapter)

    const resultRaw = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
      { responseFormat: { type: 'json_object' }, thinking: false, maxTokens: 4096, temperature: 0.75 },
      context,
    )
    this.assertNotCancelled(context)

    callbacks.log('解析完成，正在应用到项目配置...')
    let parsed: Partial<NovelConfig>
    try {
      parsed = this.parseJSON<Partial<NovelConfig>>(resultRaw)
    } catch (e) {
      throw new Error('AI 返回的内容无法解析为 JSON，请重试或缩短输入。详细信息: ' + String(e))
    }

    // 防御：LLM 常常将长文本字段错误地生成为对象或数组
    const stringifyField = (val: unknown) => {
      if (!val) return ''
      if (typeof val === 'string') return val
      if (Array.isArray(val)) return val.join('\n')
      if (typeof val === 'object') return JSON.stringify(val, null, 2)
      return String(val)
    }

    if (parsed.coreOutline !== undefined) parsed.coreOutline = stringifyField(parsed.coreOutline)
    if (parsed.worldSetting !== undefined) parsed.worldSetting = stringifyField(parsed.worldSetting)
    if (parsed.goldenFinger !== undefined) parsed.goldenFinger = stringifyField(parsed.goldenFinger)
    if (parsed.protagonistProfile !== undefined) parsed.protagonistProfile = stringifyField(parsed.protagonistProfile)
    if (parsed.globalGuidance !== undefined) parsed.globalGuidance = stringifyField(parsed.globalGuidance)
    if (parsed.referenceWorks !== undefined) parsed.referenceWorks = stringifyField(parsed.referenceWorks)
    if (parsed.writingStyle !== undefined) parsed.writingStyle = stringifyField(parsed.writingStyle)

    if (parsed.totalChapters !== undefined) parsed.totalChapters = parseInt(String(parsed.totalChapters)) || 100
    if (parsed.wordsPerChapter !== undefined) parsed.wordsPerChapter = parseInt(String(parsed.wordsPerChapter)) || 3000

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error('当前项目已切换，智能配置结果未应用')
    }
    this.onGenerated(parsed)
    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) {
      throw new Error('当前项目已切换，智能配置结果未保存')
    }
    const saved = await useProjectStore.getState().saveProject(projectSession)
    this.assertNotCancelled(context)

    if (saved) {
      callbacks.log('AI 配置生成并保存成功，请检查各字段后点击「生成架构」')
    } else {
      callbacks.log('AI 配置生成成功，请检查各字段后点击「立即保存」')
    }
    callbacks.setProgress(100)
    return '生成的配置已成功应用！'
  }
}

export class GenerateCoreSeedCommand extends BaseWorkflowCommand<string> {
  constructor(private snapshot: ArchitectureProjectSnapshot) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    callbacks.log('生成故事前提...')

    const template = getPromptTemplate('premise', projectSession)
    if (!template) throw new Error('未找到 premise 模板')

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withGenre(config.genre)
      .withSubGenre(config.subGenre || config.genre)
      .withTopic(config.coreOutline || '（未填写）')
      .withTargetAudience(config.targetAudience)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withCoreSetting(config.worldSetting || '（未填写）')
      .withGoldenFinger(config.goldenFinger || '（未填写）')
      .withProtagonistProfile(config.protagonistProfile || '（未填写）')
      .withGlobalGuidance(config.globalGuidance || '（未填写）')
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).premise || '')
      .withReferenceWorks(config.referenceWorks || '')

    const result = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, context)
    if (!result.trim()) throw new Error('故事前提生成失败，AI 返回空内容')
    if (context.cancelled) throw new Error('工作流已取消')

    const content = `# 故事前提\n\n${result}\n`
    this.assertNotCancelled(context)
    await writeArchToDb('premise', content, expectedProjectPath, context.runId, projectSession)
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.premise_result = result
    this.assertNotCancelled(context)
    await savePartialData(expectedProjectPath, partial, projectSession)
    context.data.partial = partial

    callbacks.log('故事前提已生成并写入数据库')
    return result
  }
}

export class GenerateCharactersCommand extends BaseWorkflowCommand<string> {
  constructor(private snapshot: ArchitectureProjectSnapshot) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw new Error('故事前提尚未生成或内容不完整，请返回勾选生成')
    }

    callbacks.log('生成角色图谱...')
    const template = getPromptTemplate('character_dynamics', projectSession)
    if (!template) throw new Error('未找到 character_dynamics 模板')

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withCoreSeed(premise_result)
      .withGenre(config.genre)
      .withProtagonistProfile(config.protagonistProfile || '（未填写）')
      .withGoldenFinger(config.goldenFinger || '（未填写）')
      .withWorldBuilding(config.worldSetting || '（未填写）')
      .withNumberOfChapters(config.totalChapters)
      .withGlobalGuidance(config.globalGuidance || '（未填写）')
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).characters || '')
      .withReferenceWorks(config.referenceWorks || '')

    const result = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, context)
    if (!result.trim()) throw new Error('角色图谱生成失败')
    if (context.cancelled) throw new Error('工作流已取消')

    this.assertNotCancelled(context)
    await writeArchToDb('charactersArch', `# 角色图谱\n\n${result}\n`, expectedProjectPath, context.runId, projectSession)
    this.assertNotCancelled(context)

    callbacks.log('📇 正在启动角色卡自动提取流水线...')
    const { runArchCharacterExtract } = await import('../architecture-workflow')
    this.assertNotCancelled(context)
    runArchCharacterExtract(expectedProjectPath, result, config.genre, projectSession)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.character_dynamics_result = result
    this.assertNotCancelled(context)
    await savePartialData(expectedProjectPath, partial, projectSession)
    context.data.partial = partial

    callbacks.log('角色图谱已生成并写入数据库')
    return result
  }
}

export class GenerateWorldBuildingCommand extends BaseWorkflowCommand<string> {
  constructor(private snapshot: ArchitectureProjectSnapshot) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw new Error('故事前提尚未生成或内容不完整，请返回勾选生成')
    }

    callbacks.log('生成世界观...')
    const template = getPromptTemplate('world_building', projectSession)
    if (!template) throw new Error('模板丢失')

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withCoreSeed(premise_result)
      .withGenre(config.genre)
      .withCoreSetting(config.worldSetting || '（未填写）')
      .withGoldenFinger(config.goldenFinger || '（未填写）')
      .withProtagonistProfile(config.protagonistProfile || '（未填写）')
      .withGlobalGuidance(config.globalGuidance || '（未填写）')
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).worldbuilding || '')

    const result = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, context)
    if (context.cancelled) throw new Error('工作流已取消')

    this.assertNotCancelled(context)
    await writeArchToDb('worldbuilding', `# 世界观\n\n${result}\n`, expectedProjectPath, context.runId, projectSession)
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.world_building_result = result
    this.assertNotCancelled(context)
    await savePartialData(expectedProjectPath, partial, projectSession)
    context.data.partial = partial

    callbacks.log('世界观已生成并写入数据库')
    return result
  }
}

export class GeneratePlotArchitectureCommand extends BaseWorkflowCommand<string> {
  constructor(private selectedSteps: string[], private snapshot: ArchitectureProjectSnapshot) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    assertArchitectureProjectSessionCurrent(projectSession)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise = core?.premise || ''
    const char_dyn = core?.charactersArch || ''
    const world_b = core?.worldbuilding || ''

    if (!premise || premise.includes('待生成')) throw new Error('故事前提未生成')
    if (!char_dyn || char_dyn.includes('待生成')) throw new Error('角色图谱未生成')
    if (!world_b || world_b.includes('待生成')) throw new Error('世界观未生成')

    callbacks.log('生成情节大纲...')
    const template = getPromptTemplate('synopsis', projectSession)
    if (!template) throw new Error('模板丢失')

    const { getPlotStructureGuide, getNarrativePOVLabel } = await import('../architecture-workflow')
    const guide = getPlotStructureGuide(config.plotStructure || 'three_act', config.totalChapters)
    const pov = getNarrativePOVLabel(config.narrativePOV || 'third_limited')

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withCoreSeed(premise)
      .withCharacterDynamics(char_dyn)
      .withWorldBuilding(world_b)
      .withGenre(config.genre)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withPlotStructureGuide(guide)
      .withNarrativePov(pov)
      .withGlobalGuidance(config.globalGuidance || '（未填写）')
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).synopsis || '')

    const result = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, context)
    if (context.cancelled) throw new Error('工作流已取消')

    this.assertNotCancelled(context)
    await writeArchToDb('synopsis', `# 情节大纲\n\n${result}\n`, expectedProjectPath, context.runId, projectSession)
    this.assertNotCancelled(context)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    partial.synopsis_result = result
    context.data.partial = partial

    if (this.selectedSteps.includes('premise') && this.selectedSteps.includes('characters') &&
      this.selectedSteps.includes('worldbuilding') && this.selectedSteps.includes('synopsis')) {
      this.assertNotCancelled(context)
      requireIpcSuccess(
        await ipc.invokeWithProjectSession(
          projectSession,
          'fs:write-file',
          `${expectedProjectPath}/.vela/partial_arch.json`,
          '{}',
          expectedProjectPath,
        ),
        '清理架构生成检查点',
      )
    }

    callbacks.log('情节大纲已生成并写入数据库')
    return result
  }
}
