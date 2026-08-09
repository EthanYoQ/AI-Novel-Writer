import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { requireWorkflowProjectSession } from '../workflow-project-session'
import {
  CHARACTER_ROSTER_JSON_CONTRACT,
  CHARACTER_ROSTER_JSON_REPAIR_SYSTEM,
  parseCharacterRosterJsonResponse,
} from './character-roster-json-contract'

import type { NovelConfig, ProjectSessionContext } from '../../../shared/ipc-channels'
import {
  CHARACTER_ROSTER_SCHEMA_VERSION,
  type CharacterRosterCommitRequest,
  type CharacterRosterEntry,
} from '../../../shared/character-roster'

// --- 基础工具库 ---

interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  synopsis_result?: string
}

/**
 * 不可由设置页模板覆盖的结构契约。用户仍可调整角色创作指导，但角色身份
 * 不再依赖 Markdown 标题或后续第二次模型提取。
 */
const DIRECT_CHARACTER_ROSTER_SYSTEM_PROMPT = `
你必须只输出一个可由 JSON.parse 读取的 JSON 对象。不得输出 Markdown、解释、代码围栏或思考过程。
输出必须符合 schemaVersion=1 的角色名单契约；未知文字字段填写“（待确认）”，不要留空。`

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

  /**
   * 角色架构的模型输出只负责 JSON 语法；角色身份、定位、关系闭包等语义
   * 统一交给主进程的 CharacterRosterRepository 校验，避免重新建立一套
   * renderer 侧的事实判断。
   */
  private async parseDirectRosterResponse(
    rawText: string,
    callbacks: CommandExecuteParams['callbacks'],
    context: CommandExecuteParams['context'],
  ): Promise<{ schemaVersion: unknown; entries: unknown }> {
    // 仅完整的 stop 响应会到达这里；截断状态在调用方已 fail-closed。
    return parseCharacterRosterJsonResponse(rawText, {
      parseJson: text => this.parseJSON<unknown>(text),
      assertNotCancelled: () => this.assertNotCancelled(context),
      log: message => callbacks.log(message),
      repair: ({ prompt, systemPrompt, purpose }) => this.callLLM(
        prompt,
        systemPrompt,
        callbacks,
        {
          responseFormat: { type: 'json_object' },
          thinking: false,
          maxTokens: 4096,
          temperature: 0.1,
          purpose,
        },
        context,
      ),
    }, {
      repairSystemPrompt: CHARACTER_ROSTER_JSON_REPAIR_SYSTEM,
      repairPurpose: 'character-architecture-json-repair',
    })
  }

  private assertCommittedRosterReadable(
    receipt: { snapshot?: { entries?: Array<{ name?: unknown }>; renderedMarkdown?: unknown } } | undefined,
    candidateEntries: unknown,
  ): asserts receipt is { snapshot: { entries: Array<{ name: string }>; renderedMarkdown: string } } {
    const snapshot = receipt?.snapshot
    if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0 || typeof snapshot.renderedMarkdown !== 'string' || !snapshot.renderedMarkdown.trim()) {
      throw new Error('角色名单提交后未能回读角色卡和角色图谱，未将本步骤标记为成功')
    }

    if (!Array.isArray(candidateEntries)) return
    const candidateNames = candidateEntries
      .map(entry => (
        entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
          ? (entry as { name: string }).name.trim()
          : ''
      ))
      .filter(Boolean)
    const committedNames = new Set(snapshot.entries
      .map(entry => typeof entry.name === 'string' ? entry.name.trim() : '')
      .filter(Boolean))
    if (candidateNames.length === 0 || candidateNames.some(name => !committedNames.has(name))) {
      throw new Error('角色名单提交回读不完整，未将本步骤标记为成功')
    }
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

    const completion = await this.callLLMResult(
      `${promptBuilder.build()}\n\n${CHARACTER_ROSTER_JSON_CONTRACT}`,
      `${promptBuilder.getSystemRole()}\n\n${DIRECT_CHARACTER_ROSTER_SYSTEM_PROMPT}`,
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        thinking: false,
        maxTokens: 4096,
        temperature: 0.35,
        purpose: 'character-architecture',
      },
      context,
    )
    if (completion.finishReason !== 'stop') {
      throw this.createIncompleteCompletionError(completion.finishReason)
    }
    if (!completion.content.trim()) throw new Error('角色名单生成失败，AI 返回空内容')

    const candidate = await this.parseDirectRosterResponse(completion.content, callbacks, context)
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession)
    const currentRoster = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      expectedProjectPath,
    )
    this.assertNotCancelled(context)
    assertArchitectureProjectSessionCurrent(projectSession)

    const commitResult = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-commit',
      {
        operationId: context.runId,
        expectedRevision: currentRoster.revision,
        schemaVersion: candidate.schemaVersion as typeof CHARACTER_ROSTER_SCHEMA_VERSION,
        entries: candidate.entries as CharacterRosterEntry[],
        intent: 'architecture_generation',
      } satisfies CharacterRosterCommitRequest,
      expectedProjectPath,
    )
    if (!commitResult.success) {
      throw new Error(commitResult.error || '角色名单提交失败，未保存角色图谱或角色卡')
    }
    this.assertCommittedRosterReadable(commitResult.receipt, candidate.entries)
    const renderedMarkdown = commitResult.receipt.snapshot.renderedMarkdown
    const characterCount = commitResult.receipt.snapshot.entries.length

    // 事务 receipt 是取消边界：提交成功后不再把已保存的角色事实误报为零写入取消。
    if (context.cancelled) {
      this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)
      callbacks.log(`角色图谱与 ${characterCount} 张角色卡已生成；后续工作流已取消`)
      return renderedMarkdown
    }

    this.notifyRefresh(['characterCards'], expectedProjectPath, projectSession)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(expectedProjectPath, projectSession)
    if (context.cancelled) {
      callbacks.log(`角色图谱与 ${characterCount} 张角色卡已生成；后续工作流已取消`)
      return renderedMarkdown
    }
    partial.character_dynamics_result = renderedMarkdown
    context.data.partial = partial
    try {
      await savePartialData(expectedProjectPath, partial, projectSession)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      callbacks.log(
        `[警告] 角色图谱与 ${characterCount} 张角色卡已保存，但检查点保存失败：${detail}。当前流程可继续；若中断，将无法从此步骤恢复。`,
      )
    }

    callbacks.log(`角色图谱与 ${characterCount} 张角色卡已生成`)
    return renderedMarkdown
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
