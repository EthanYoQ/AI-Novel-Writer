import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import type { CharacterRosterEntry, CharacterRosterSnapshot } from '../../../../shared/character-roster'
import {
  GenerateCharactersCommand as RuntimeGenerateCharactersCommand,
  GenerateConfigCommand as RuntimeGenerateConfigCommand,
  GenerateCoreSeedCommand,
  GenerateWorldBuildingCommand,
  GeneratePlotArchitectureCommand,
} from '../architecture.command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'
import {
  clearProjectCustomPrompts,
  getBuiltinPromptTemplate,
  loadProjectCustomPrompts,
  saveProjectCustomPrompt,
} from '../../../prompt-templates'

class GenerateConfigCommand extends RuntimeGenerateConfigCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeGenerateConfigCommand>) {
    super(args[0], args[1], args[2], args[3], workflowRuntimeDependencies)
  }
}

class GenerateCharactersCommand extends RuntimeGenerateCharactersCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeGenerateCharactersCommand>) {
    super(args[0], workflowRuntimeDependencies)
  }
}

const projectAPath = 'C:\\novels\\A'
const projectBPath = 'C:\\novels\\B'
const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId
const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

const domainIpcChannels = (invoke: ReturnType<typeof vi.fn>) => invoke.mock.calls
  .map(([channel]) => channel as string)
  .filter(channel => !channel.startsWith('prompt:') && !channel.startsWith('fs:'))
const validConfigJson = JSON.stringify({
  genre: '玄幻',
  targetAudience: '男频',
  subGenre: '东方玄幻',
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '主角必须在故乡毁灭前找到失落传承，并阻止席卷大陆的终局灾难。',
  worldSetting: '灵脉决定城邦兴衰，宗门垄断资源，边境异变正在瓦解旧有秩序。',
  goldenFinger: '主角能够解析残缺功法，但每次使用都会付出记忆损耗的代价。',
  protagonistProfile: '外表谨慎克制，内心执着于守护家人，在利益与承诺间不断抉择。',
  globalGuidance: '前期建立危机，中期扩大阵营冲突，后期收束伏笔并完成终局对决。',
  writingStyle: '节奏紧凑，场景切换清晰，对话简洁有张力，行动描写强调因果。',
})

const rosterEntries: CharacterRosterEntry[] = [
  {
    name: '林舟',
    role: 'protagonist',
    gender: '男',
    age: '十八岁',
    appearance: '灰袍少年',
    personality: '克制',
    background: '铁砧镇学徒',
    abilities: '锻造',
    motivation: '守住家人',
    relationships: [{ target: '苏绾', relation: '师徒' }],
    arc: '从学徒成长为守护者',
    notes: '主线成长职责',
    currentState: { location: '铁砧镇', powerLevel: '学徒', physicalState: '健康', mentalState: '警觉', keyItems: '旧铁锤', recentEvents: '宗门封锁', updatedAtChapter: 0 },
  },
  {
    name: '苏绾',
    role: 'supporting',
    gender: '女',
    age: '二十六岁',
    appearance: '青衣剑客',
    personality: '冷静',
    background: '游侠',
    abilities: '剑术',
    motivation: '偿还旧债',
    relationships: [{ target: '林舟', relation: '师徒' }],
    arc: '学会托付',
    notes: '关键引导职责',
    currentState: { location: '铁砧镇', powerLevel: '剑客', physicalState: '轻伤', mentalState: '冷静', keyItems: '青锋剑', recentEvents: '寻到林舟', updatedAtChapter: 0 },
  },
  {
    name: '顾岩',
    role: 'antagonist',
    gender: '男',
    age: '三十岁',
    appearance: '黑衣执剑者',
    personality: '偏执',
    background: '宗门执法者',
    abilities: '追踪',
    motivation: '维护旧秩序',
    relationships: [{ target: '林舟', relation: '对手' }],
    arc: '看见秩序的代价',
    notes: '阵营冲突职责',
    currentState: { location: '宗门', powerLevel: '执法者', physicalState: '健康', mentalState: '偏执', keyItems: '执法令', recentEvents: '奉命追捕', updatedAtChapter: 0 },
  },
]

function manifestFor(entries: readonly CharacterRosterEntry[]) {
  return {
    slots: entries.map((entry, index) => ({
      slotId: `slot-${index + 1}`,
      name: entry.name,
      role: entry.role,
      narrativeDuty: entry.notes || `${entry.name}的叙事职责`,
      relations: entry.relationships.map(relationship => ({
        targetSlotId: `slot-${entries.findIndex(candidate => candidate.name === relationship.target) + 1}`,
        relation: relationship.relation,
      })),
    })),
  }
}

function detailResponses(entries: readonly CharacterRosterEntry[]): string[] {
  const manifest = manifestFor(entries)
  return entries.map((entry, index) => {
    const details: Partial<CharacterRosterEntry> = { ...entry }
    delete details.relationships
    return JSON.stringify({
      entries: [{
        slotId: manifest.slots[index].slotId,
        ...details,
      }],
    })
  })
}

function twoStageResponses(entries: readonly CharacterRosterEntry[]): string[] {
  return [JSON.stringify(manifestFor(entries)), ...detailResponses(entries)]
}

function fencedJsonWithProse(json: string): string {
  return `下面是按合同输出的 JSON：\n\n\`\`\`json\n${json}\n\`\`\`\n\n</think`
}

function createResponseStream(
  responses: readonly string[],
  finishReasons: ReadonlyArray<'stop' | 'length'> = responses.map(() => 'stop'),
) {
  let nextResponseIndex = 0
  return vi.fn((
    _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
    streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
  ) => {
    const index = nextResponseIndex++
    const output = responses[index]
    if (output === undefined) throw new Error(`unexpected character generation attempt ${index + 1}`)
    streamCallbacks.onChunk?.(output)
    streamCallbacks.onDone?.(output, undefined, finishReasons[index] ?? 'stop')
    return Promise.resolve(`character-request-${index + 1}`)
  })
}

const readyRoster: CharacterRosterSnapshot = {
  schemaVersion: 1,
  revision: 1,
  migrationState: 'ready',
  status: 'ready',
  entries: rosterEntries,
  renderedMarkdown: '# 角色图谱\n\n## 主角：林舟\n\n## 配角：苏绾\n\n## 反派：顾岩',
  projectionHash: 'projection-hash',
  factHash: 'fact-hash',
}
const context: WorkflowContext = {
  runId: 'architecture-config-run',
  projectPath: projectAPath,
  projectSession: { projectId: 'main', leaseId: 'lease-main', projectPath: projectAPath },
  writingLanguage: 'zh-CN',
  uiLocale: 'zh-CN',
  data: {},
  cancelled: false,
}

function project(path: string) {
  return {
    id: 'main',
    name: path,
    path,
    sessionLease: `lease-${path === projectAPath ? 'main' : 'other'}`,
    novelConfig: {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    velaAPI: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
        if (channel === 'fs:check-exists') return false
        throw new Error(`Unexpected IPC channel: ${channel}`)
      }),
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  useProjectStore.setState({
    currentProject: project(projectAPath) as never,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useLLMStore.setState({
    defaultModelId: originalDefaultModelId,
    generateStream: originalGenerateStream,
  })
  useProjectStore.setState({ currentProject: null })
  clearProjectCustomPrompts()
})

describe('GenerateConfigCommand error boundaries', () => {
  it.each([
    { uiLocale: 'zh-CN', writingLanguage: 'zh-CN', expected: '你是一位经验丰富的小说编辑', unexpected: 'You are an experienced fiction editor' },
    { uiLocale: 'en-US', writingLanguage: 'zh-CN', expected: '你是一位经验丰富的小说编辑', unexpected: 'You are an experienced fiction editor' },
    { uiLocale: 'zh-CN', writingLanguage: 'en-US', expected: 'You are an experienced fiction editor', unexpected: '你是一位经验丰富的小说编辑' },
    { uiLocale: 'en-US', writingLanguage: 'en-US', expected: 'You are an experienced fiction editor', unexpected: '你是一位经验丰富的小说编辑' },
  ] as const)(
    'sends $writingLanguage configuration instructions through the provider request in a $uiLocale interface',
    async ({ uiLocale, writingLanguage, expected, unexpected }) => {
      useLocaleStore.setState({ locale: uiLocale })
      useProjectStore.setState({
        currentProject: {
          ...project(projectAPath),
          novelConfig: { writingLanguage },
        } as never,
        saveProject: vi.fn().mockResolvedValue(true),
      })
      const runContext = { ...context, writingLanguage }
      let observedMessages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0] = []
      useLLMStore.setState({
        defaultModelId: 'model-1',
        generateStream: vi.fn(async (messages, streamCallbacks) => {
          observedMessages = messages
          streamCallbacks.onDone?.(validConfigJson, undefined, 'stop')
          return 'config-language-request'
        }),
      })
      const authorIdea = 'A café named “夜航 Café” survives at the edge of two timelines.'
      const command = new GenerateConfigCommand(authorIdea, 100, 3000, vi.fn())

      await command.execute({ step: {}, context: runContext, callbacks })

      const system = observedMessages.find(message => message.role === 'system')?.content ?? ''
      const user = observedMessages.find(message => message.role === 'user')?.content ?? ''
      expect(system).toContain(expected)
      expect(system).not.toContain(unexpected)
      expect(user).toContain(authorIdea)
    },
  )

  it('sends the same exact config JSON contract on the initial and length-replacement requests', async () => {
    const observedPrompts: string[] = []
    const generateStream = vi.fn((
      messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      observedPrompts.push(messages.map(message => message.content).join('\n'))
      const index = generateStream.mock.calls.length
      const output = index === 1 ? '{"genre":"玄幻"' : validConfigJson
      streamCallbacks.onDone?.(output, undefined, index === 1 ? 'length' : 'stop')
      return Promise.resolve(`config-request-${index}`)
    })
    const onGenerated = vi.fn()
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    useProjectStore.setState({ saveProject: vi.fn().mockResolvedValue(true) })
    const command = new GenerateConfigCommand('灵脉枯竭前寻找失落传承', 100, 3000, onGenerated)

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toBe('生成的配置已成功应用！')

    expect(generateStream).toHaveBeenCalledTimes(2)
    for (const prompt of observedPrompts) {
      expect(prompt).toContain('genre、targetAudience、subGenre、coreOutline、worldSetting、goldenFinger、protagonistProfile、globalGuidance、writingStyle')
      expect(prompt).toContain('three_act | heros_journey | save_the_cat | kishotenketsu | multi_thread | freeform')
      expect(prompt).toContain('third_limited | first_person | third_omniscient | multi_pov')
      expect(prompt).toContain('totalChapters 若输出必须严格等于 100')
      expect(prompt).toContain('wordsPerChapter 若输出必须严格等于 3000')
      expect(prompt).toContain('不得输出中文枚举、近义词')
    }
    expect(onGenerated).toHaveBeenCalledOnce()
  })

  it('rejects an inexact plot structure without applying or saving config', async () => {
    const invalid = JSON.stringify({ ...JSON.parse(validConfigJson), plotStructure: '三幕式' })
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(invalid, undefined, 'stop')
        return 'config-request'
      }),
    })
    const onGenerated = vi.fn()
    const saveProject = vi.fn()
    useProjectStore.setState({ saveProject })
    const command = new GenerateConfigCommand('idea', 100, 3000, onGenerated)

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('非法 plotStructure')
    expect(onGenerated).not.toHaveBeenCalled()
    expect(saveProject).not.toHaveBeenCalled()
  })

  it('preserves the project-switch error instead of reporting it as invalid JSON', async () => {
    let finishGeneration: (() => void) | undefined
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        await new Promise<void>((resolve) => {
          finishGeneration = () => {
            streamCallbacks.onDone?.(validConfigJson, undefined, 'stop')
            resolve()
          }
        })
        return 'config-request'
      }),
    })
    const command = new GenerateConfigCommand('idea', 100, 3000, vi.fn())

    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(finishGeneration).toBeTypeOf('function'))
    useProjectStore.setState({ currentProject: project(projectBPath) as never })
    finishGeneration!()

    await expect(execution).rejects.toThrow('当前项目已切换，智能配置结果未应用')
  })

  it('preserves save errors after valid JSON parsing', async () => {
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(validConfigJson, undefined, 'stop')
        return 'config-request'
      }),
    })
    const command = new GenerateConfigCommand('idea', 100, 3000, vi.fn())
    useProjectStore.setState({
      saveProject: vi.fn().mockRejectedValue(new Error('磁盘写入失败')),
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('磁盘写入失败')
  })
})

describe('GenerateCharactersCommand structured roster seam', () => {
  it('persists English architecture headings without rewriting mixed UTF-8 model output', async () => {
    const modelOutput = 'Night Café 夜航 — “déjà vu” remains unchanged.'
    const novelConfig = {
      writingLanguage: 'en-US',
      genre: 'speculative thriller',
      targetAudience: 'general',
      totalChapters: 20,
      wordsPerChapter: 2500,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
    } as const
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig,
      } as never,
    })
    const runContext = {
      ...context,
      writingLanguage: 'en-US' as const,
      uiLocale: 'en-US' as const,
      data: {},
    }
    const englishCallbacks = callbacks
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: createResponseStream([modelOutput, modelOutput, modelOutput]),
    })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return { templates: [], diagnostics: [] }
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return {
            premise: 'A sufficiently detailed premise for worldbuilding and plot persistence verification.',
            charactersArch: 'Mara and Jules pursue conflicting goals.',
            worldbuilding: 'The overlapping cities obey a midnight boundary.',
          }
        case 'db:project-core-update':
        case 'fs:write-json':
          return { success: true }
        case 'fs:read-json':
          return { success: true, data: {} }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
    })
    const snapshot = { expectedProjectPath: projectAPath, novelConfig } as never

    await new GenerateCoreSeedCommand(snapshot, workflowRuntimeDependencies)
      .execute({ step: {}, context: runContext, callbacks: englishCallbacks })
    await new GenerateWorldBuildingCommand(snapshot, workflowRuntimeDependencies)
      .execute({ step: {}, context: runContext, callbacks: englishCallbacks })
    await new GeneratePlotArchitectureCommand(['synopsis'], snapshot, workflowRuntimeDependencies)
      .execute({ step: {}, context: runContext, callbacks: englishCallbacks })

    const persistedUpdates = (invoke.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([channel]) => channel === 'db:project-core-update')
      .map(([, update]) => update)
    expect(persistedUpdates).toEqual([
      { premise: `# Story Premise\n\n${modelOutput}` },
      { worldbuilding: `# Worldbuilding\n\n${modelOutput}` },
      { synopsis: `# Plot Outline\n\n${modelOutput}` },
    ])
    for (const update of persistedUpdates) {
      expect(JSON.stringify(update)).not.toContain('# 故事前提')
      expect(JSON.stringify(update)).not.toContain('# 世界观')
      expect(JSON.stringify(update)).not.toContain('# 情节大纲')
      expect(JSON.stringify(update)).toContain(modelOutput)
    }
    expect(englishCallbacks.log).toHaveBeenCalledWith('Generating story premise...')
    expect(englishCallbacks.log).toHaveBeenCalledWith('Story premise generated and saved to the database.')
    expect(englishCallbacks.log).toHaveBeenCalledWith('Generating worldbuilding...')
    expect(englishCallbacks.log).toHaveBeenCalledWith('Worldbuilding generated and saved to the database.')
    expect(englishCallbacks.log).toHaveBeenCalledWith('Generating plot outline...')
    expect(englishCallbacks.log).toHaveBeenCalledWith('Plot outline generated and saved to the database.')
  })

  it('uses the frozen English UI locale for premise logs and an empty-result error', async () => {
    const novelConfig = {
      writingLanguage: 'zh-CN',
      genre: '悬疑',
      targetAudience: '全龄',
      totalChapters: 20,
      wordsPerChapter: 2500,
    } as const
    useProjectStore.setState({
      currentProject: { ...project(projectAPath), novelConfig } as never,
    })
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.('', undefined, 'stop')
        return 'empty-premise-request'
      }),
    })
    const runContext = {
      ...context,
      writingLanguage: 'zh-CN' as const,
      uiLocale: 'en-US' as const,
      data: {},
    }
    const stepCallbacks = callbacks
    const snapshot = { expectedProjectPath: projectAPath, novelConfig } as never

    await expect(new GenerateCoreSeedCommand(snapshot, workflowRuntimeDependencies).execute({
      step: {},
      context: runContext,
      callbacks: stepCallbacks,
    })).rejects.toThrow('Story premise generation failed because the AI returned empty content.')
    expect(stepCallbacks.log).toHaveBeenCalledWith('Generating story premise...')
  })

  it('uses the frozen English UI locale when the provider aborts premise generation', async () => {
    const novelConfig = {
      writingLanguage: 'en-US',
      genre: 'mystery',
      targetAudience: 'general',
      totalChapters: 20,
      wordsPerChapter: 2500,
    } as const
    useProjectStore.setState({
      currentProject: { ...project(projectAPath), novelConfig } as never,
    })
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(() => new Promise<string>(() => {})),
    })
    const runContext = {
      ...context,
      writingLanguage: 'en-US' as const,
      uiLocale: 'en-US' as const,
      data: {},
    }
    const stepCallbacks = callbacks
    const snapshot = { expectedProjectPath: projectAPath, novelConfig } as never

    const execution = new GenerateCoreSeedCommand(snapshot, workflowRuntimeDependencies).execute({
      step: {},
      context: runContext,
      callbacks: stepCallbacks,
    })
    await vi.waitFor(() => expect(useLLMStore.getState().generateStream).toHaveBeenCalledOnce())
    runContext.cancelled = true

    await expect(execution).rejects.toThrow('Workflow was cancelled.')
    const visibleLogs = vi.mocked(stepCallbacks.log).mock.calls.map(([message]) => message).join('\n')
    expect(visibleLogs).toContain('Generating story premise...')
    expect(visibleLogs).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('sends English built-in instructions for premise, character, world, and synopsis requests', async () => {
    const novelConfig = {
      writingLanguage: 'en-US',
      genre: '科幻',
      subGenre: 'time-loop mystery',
      targetAudience: '全龄',
      totalChapters: 20,
      wordsPerChapter: 2500,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: 'A café exists in two timelines.',
      worldSetting: 'Two cities overlap at midnight.',
      goldenFinger: 'The protagonist remembers each reset.',
      protagonistProfile: 'Mara is cautious but stubborn.',
      globalGuidance: 'Preserve causal continuity.',
    } as const
    useProjectStore.setState({
      currentProject: {
        ...project(projectAPath),
        novelConfig,
      } as never,
    })
    const runContext = {
      ...context,
      writingLanguage: 'en-US' as const,
      uiLocale: 'en-US' as const,
    }
    const observed = new Map<string, string>()
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn(async (
        messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
        streamCallbacks,
        _modelId,
        options,
      ) => {
        observed.set(options?.purpose ?? 'unknown', messages.map(message => message.content).join('\n'))
        streamCallbacks.onError?.('captured request')
        return 'architecture-language-request'
      }),
    })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return {
          premise: 'A sufficiently detailed premise for the language contract and character planning request.',
          charactersArch: 'Mara and Jules pursue conflicting goals.',
          worldbuilding: 'The overlapping cities obey a midnight boundary.',
          synopsis: 'The investigation escalates across three acts.',
        }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
    })
    const snapshot = { expectedProjectPath: projectAPath, novelConfig } as never
    const commands = [
      [new GenerateCoreSeedCommand(snapshot, workflowRuntimeDependencies), 'Generating story premise...'],
      [new GenerateCharactersCommand(snapshot), 'Generating character graph...'],
      [new GenerateWorldBuildingCommand(snapshot, workflowRuntimeDependencies), 'Generating worldbuilding...'],
      [new GeneratePlotArchitectureCommand(['synopsis'], snapshot, workflowRuntimeDependencies), 'Generating plot outline...'],
    ] as const
    for (const [command, expectedStartLog] of commands) {
      const stepCallbacks = callbacks
      await expect(command.execute({ step: {}, context: runContext, callbacks: stepCallbacks })).rejects.toThrow()
      expect(stepCallbacks.log).toHaveBeenCalledWith(expectedStartLog)
    }

    expect(observed.get('generate-core-seed')).toContain('Build a compact story premise')
    expect(observed.get('character-architecture-manifest')).toContain('You plan character identities')
    expect(observed.get('generate-world-building')).toContain('Design the world as a conflict system')
    expect(observed.get('generate-plot-architecture')).toContain('Build the complete plot architecture')
    for (const request of observed.values()) {
      expect(request).toContain('Science fiction')
      expect(request).not.toContain('科幻')
      expect(request).not.toContain('全龄')
      expect(request).not.toContain('你是一位网络小说策划专家与故事架构师')
    }
  })

  it('preflights the character identity manifest with field attribution before any provider request', async () => {
    const generateStream = vi.fn()
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: 'A sufficiently detailed premise for prompt-budget attribution before character generation.' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
    })
    const runContext = {
      ...context,
      uiLocale: 'en-US' as const,
      data: { stepGuidance: { characters: '' } },
      cancelled: false,
    }
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: {
        genre: 'fantasy',
        totalChapters: 20,
        wordsPerChapter: 2500,
        globalGuidance: 'G'.repeat(24_001),
        referenceWorks: '',
      } as never,
    })

    let failure: unknown
    try {
      await command.execute({ step: {}, context: runContext, callbacks })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      name: 'PromptBudgetExceededError',
      code: 'PROMPT_BUDGET_EXHAUSTED',
      report: {
        limitUtf8Bytes: 24_000,
        reservedOutputTokens: 8192,
        modelId: 'model-1',
        errorCode: 'PROMPT_BUDGET_EXHAUSTED',
        sections: expect.arrayContaining([
          {
            sectionName: 'global-guidance',
            utf8Bytes: 24_020,
          },
        ]),
      },
    })
    expect(JSON.stringify(failure)).not.toContain('G'.repeat(128))
    expect(generateStream).not.toHaveBeenCalled()
  })

  it('keeps a complete 12 KB author context instead of requiring the author to delete project guidance', async () => {
    const generateStream = createResponseStream([JSON.stringify({ slots: [] })])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') return { premise: 'P'.repeat(1_747) }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
    })
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: {
        genre: 'fantasy',
        totalChapters: 20,
        wordsPerChapter: 2_500,
        globalGuidance: 'G'.repeat(9_607),
      } as never,
    })

    let failure: unknown
    try {
      await command.execute({ step: {}, context, callbacks })
    } catch (error) {
      failure = error
    }

    expect(failure).not.toMatchObject({ code: 'PROMPT_BUDGET_EXHAUSTED' })
    expect(generateStream).toHaveBeenCalledOnce()
  })

  it('generates an eight-slot manifest then bounded individual details before one atomic roster commit', async () => {
    const promptBudgetDiagnostic = vi.spyOn(console, 'info').mockImplementation(() => {})
    const names = ['江砚', '沈微澜', '顾沉舟', '白榆', '闻策', '唐霁', '陆衡', '乔岚']
    const manifest = {
      slots: names.map((name, index) => ({
        slotId: `slot-${index + 1}`,
        name,
        role: index === 0 ? 'protagonist' : index === 2 ? 'antagonist' : 'supporting',
        narrativeDuty: `第${index + 1}位角色的独立叙事职责`,
        relations: [{ targetSlotId: `slot-${((index + 1) % names.length) + 1}`, relation: '推动彼此选择' }],
      })),
    }
    const fullEntries: CharacterRosterEntry[] = manifest.slots.map((slot, index) => ({
      name: slot.name,
      role: slot.role as CharacterRosterEntry['role'],
      gender: '（待确认）',
      age: `${20 + index}岁`,
      appearance: `${slot.name}的标志性外貌`,
      personality: `${slot.name}的矛盾性格`,
      background: `${slot.name}的身份背景`,
      abilities: `${slot.name}的专长`,
      motivation: `${slot.name}的独立动机`,
      relationships: slot.relations.map(relation => ({
        target: manifest.slots.find(candidate => candidate.slotId === relation.targetSlotId)!.name,
        relation: relation.relation,
      })),
      arc: `${slot.name}的角色弧光`,
      notes: slot.narrativeDuty,
      currentState: { location: '初始地点', powerLevel: '初始阶段', physicalState: '健康', mentalState: '稳定', keyItems: '无', recentEvents: '故事开始', updatedAtChapter: 0 },
    }))
    fullEntries[0].age = '18'
    fullEntries[0].currentState = {
      ...fullEntries[0].currentState!,
      keyItems: '钥匙、旧照片',
      recentEvents: '收到密信；躲过追捕',
    }
    const generatedResponses = [
      JSON.stringify(manifest),
      ...fullEntries.map((entry, index) => {
        const details: Partial<CharacterRosterEntry> = { ...entry }
        delete details.relationships
        if (index === 0) (details as { age: unknown }).age = 18
        if (index === 0) details.currentState = {
          ...entry.currentState!,
          keyItems: ['钥匙', '旧照片'],
          recentEvents: ['收到密信', '躲过追捕'],
        } as unknown as CharacterRosterEntry['currentState']
        return JSON.stringify({ entries: [{
          slotId: manifest.slots[index].slotId,
          ...details,
        }] })
      }),
    ]
    const observedPrefixes: string[][] = []
    let manifestMessages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0] | undefined
    const generateStream = vi.fn((
      messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      if (generateStream.mock.calls.length === 1) manifestMessages = messages
      const user = messages.find(message => message.role === 'user')?.content ?? ''
      if (generateStream.mock.calls.length > 1) {
        const marker = /【已验证详情前缀】\n([^【]*)/u.exec(user)?.[1] ?? ''
        observedPrefixes.push(names.filter(name => marker.includes(`"name":"${name}"`)))
      }
      const output = generatedResponses.shift()
      if (!output) throw new Error('unexpected character generation attempt')
      streamCallbacks.onDone?.(output, undefined, 'stop')
      return Promise.resolve(`character-batch-${generateStream.mock.calls.length}`)
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const expectedSnapshot = { ...readyRoster, entries: fullEntries, renderedMarkdown: '# 八人角色图谱' }
    let committedRequest: unknown
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'fs:mkdir' || channel === 'fs:write-file') return { success: true }
      if (channel === 'db:project-core-get') return { premise: '足够长的八人群像故事前提，用于验证身份清单和分批详情始终在同一个生成会话中完成，并且只有全局关系闭包通过后才原子提交。' }
      if (channel === 'db:character-roster-read') return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
      if (channel === 'db:character-roster-commit') {
        committedRequest = args[0]
        return { success: true, receipt: { snapshot: expectedSnapshot } }
      }
      if (channel === 'fs:read-json') return { success: true, data: {} }
      if (channel === 'fs:write-json') return { success: true }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
    })
    await loadProjectCustomPrompts(context.projectSession!)
    const characterTemplate = getBuiltinPromptTemplate('character_dynamics', 'zh-CN')!
    await expect(saveProjectCustomPrompt(context.projectSession!, {
      ...characterTemplate,
      writingLanguage: 'zh-CN',
      systemRole: '自定义角色规划定位：重视人物选择与代价。',
      taskGuidance: '自定义角色指导：每个角色必须有独立欲望。',
    })).resolves.toBe(true)
    const eightContext = {
      ...context,
      uiLocale: 'en-US' as const,
      data: { stepGuidance: { characters: '必须塑造八名群像角色，覆盖不同立场且关系闭合。' } },
      writingSkills: Object.freeze({
        planning: Object.freeze({
          skillId: 'user:character-planning', name: 'Character causality', stage: 'planning' as const,
          source: 'user' as const, writingLanguage: 'zh-CN' as const,
          content: '每个角色的选择必须产生可追踪的代价。', utf8Bytes: 57,
        }),
      }),
      cancelled: false,
    }
    const stepCallbacks = callbacks
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '科幻悬疑', totalChapters: 4, wordsPerChapter: 6200 } as never,
    })

    await expect(command.execute({ step: {}, context: eightContext, callbacks: stepCallbacks })).resolves.toBe('# 八人角色图谱')

    expect(generateStream).toHaveBeenCalledTimes(9)
    const manifestPrompt = manifestMessages?.map(message => message.content).join('\n') ?? ''
    expect(manifestPrompt).not.toMatch(/appearance|currentState|"?entries"?/u)
    expect(manifestPrompt).toContain('自定义角色规划定位：重视人物选择与代价。')
    expect(manifestPrompt).toContain('【补充写作 Skill：Character causality】')
    expect(manifestPrompt).toContain('自定义角色指导：每个角色必须有独立欲望。')
    expect(manifestPrompt).toContain('{"slots":[...]}')
    expect(new TextEncoder().encode(manifestPrompt).byteLength).toBeLessThanOrEqual(24_000)
    expect(observedPrefixes).toEqual([[], ...names.slice(1).map((_, index) => names.slice(0, index + 1))])
    const detailPrompt = generateStream.mock.calls[1]?.[0].find(message => message.role === 'user')?.content ?? ''
    const detailSystem = generateStream.mock.calls[1]?.[0].find(message => message.role === 'system')?.content ?? ''
    expect(detailSystem).toContain('自定义角色规划定位：重视人物选择与代价。')
    expect(detailPrompt).toContain('自定义角色指导：每个角色必须有独立欲望。')
    expect(detailPrompt).toContain('【补充写作 Skill：Character causality】')
    expect(detailPrompt.indexOf('每个角色的选择必须产生可追踪的代价。'))
      .toBeLessThan(detailPrompt.indexOf('【不可变角色详情 JSON 合同】'))
    expect(detailPrompt).toContain('【不可变角色详情 JSON 合同】')
    expect(detailPrompt).not.toContain('## 核心角色档案')
    expect(detailPrompt).toContain('保持每个字段具体、紧凑且与叙事有关')
    expect(detailPrompt).not.toContain('background 不超过 500 字符')
    expect(detailPrompt).toContain('禁止输出 relationships')
    expect(detailPrompt).not.toContain('关系必须指向角色列表中另一位已存在角色')
    expect(detailPrompt).toContain('currentState 必填')
    expect(detailPrompt).not.toContain('schemaVersion=1')
    expect(detailPrompt).not.toContain('若输出 currentState')
    expect(detailPrompt).toContain('keyItems 可为非空字符串或非空字符串数组')
    expect(detailPrompt).toContain('recentEvents 可为非空字符串或非空字符串数组')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:character-roster-commit')).toHaveLength(1)
    expect(committedRequest).toMatchObject({
      intent: 'architecture_generation',
      entries: fullEntries,
    })
    const visibleLogs = vi.mocked(stepCallbacks.log).mock.calls.map(([message]) => message).join('\n')
    expect(visibleLogs).toContain('Generating character graph...')
    expect(visibleLogs).toContain('Initial bounded response: finishReason=stop')
    expect(visibleLogs).toContain('The character graph and 8 character cards were generated.')
    expect(visibleLogs).not.toMatch(/[\u3400-\u9fff]/u)
    expect(promptBudgetDiagnostic.mock.calls).toEqual(expect.arrayContaining([
      [
        '[GenerationPromptBudget]',
        expect.objectContaining({
          errorCode: 'OK',
          sections: expect.arrayContaining([
            expect.objectContaining({ sectionName: 'validated-prefix' }),
          ]),
        }),
      ],
    ]))
  })

  it('fails closed when the manifest stage returns the legacy entries envelope', async () => {
    const generateStream = createResponseStream([
      JSON.stringify({ schemaVersion: 1, entries: rosterEntries }),
    ])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: '足够长的故事前提，用于验证旧的完整角色卡 entries 响应不能被身份清单阶段接受，也绝不触发任何角色事实提交。' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
    })
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('角色身份清单缺少 slots')
    expect(generateStream).toHaveBeenCalledOnce()
    expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
  })

  it('rejects forged detail relationships so only the manifest can define committed edges', async () => {
    const forged = JSON.parse(detailResponses(rosterEntries)[0]) as { entries: Array<Record<string, unknown>> }
    forged.entries[0].relationships = [{ target: '顾岩', relation: '伪造关系' }]
    const generateStream = createResponseStream([
      JSON.stringify(manifestFor(rosterEntries)),
      JSON.stringify(forged),
    ])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') return { premise: '足够长的故事前提，用于验证角色详情不得伪造或覆盖身份清单中的冻结关系，任何异常关系字段都必须在提交前失败关闭。' }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
    })
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('角色详情 slotId=slot-1 字段 relationships 不得出现')
    expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
  })

  it('normalizes integer identity and relation IDs before details and one atomic roster commit', async () => {
    const numericManifest = {
      slots: rosterEntries.map((entry, index) => ({
        slotId: index + 1,
        name: entry.name,
        role: entry.role,
        narrativeDuty: entry.notes,
        relations: entry.relationships.map(relationship => ({
          targetSlotId: rosterEntries.findIndex(candidate => candidate.name === relationship.target) + 1,
          relation: relationship.relation,
        })),
      })),
    }
    const numericDetailResponses = rosterEntries.map((entry, index) => {
      const details: Partial<CharacterRosterEntry> = { ...entry }
      delete details.relationships
      return JSON.stringify({ entries: [{ slotId: String(index + 1), ...details }] })
    })
    const generateStream = createResponseStream([
      JSON.stringify(numericManifest),
      ...numericDetailResponses,
    ])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })

    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return { templates: [], diagnostics: [] }
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并写入结构化角色事实，且不会因为前置条件长度不足而提前中止本次端到端工作流验证。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: {
        genre: '玄幻',
        totalChapters: 100,
        wordsPerChapter: 3000,
      } as never,
    })
    const result = await command.execute({ step: {}, context, callbacks })

    expect(result).toBe(readyRoster.renderedMarkdown)
    expect(generateStream).toHaveBeenCalledTimes(4)
    const manifestPrompt = generateStream.mock.calls[0]?.[0].map(message => message.content).join('\n') ?? ''
    expect(manifestPrompt).toContain('slotId 与 targetSlotId 必须是 JSON 字符串')
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        operationId: context.runId,
        expectedRevision: 0,
        schemaVersion: 1,
        entries: rosterEntries,
        intent: 'architecture_generation',
      }),
      projectAPath,
      context.projectSession,
    )
    expect(domainIpcChannels(invoke)).not.toContain('db:project-core-update')
    expect(domainIpcChannels(invoke)).not.toContain('db:character-save-all')
    expect(domainIpcChannels(invoke)).not.toContain('db:post-process-create-run')
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith('角色图谱与 3 张角色卡已生成')
  })

  it('accepts a fenced manifest with leading prose before strict validation and one atomic roster commit', async () => {
    const generateStream = createResponseStream([
      fencedJsonWithProse(JSON.stringify(manifestFor(rosterEntries))),
      ...detailResponses(rosterEntries),
    ])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })

    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证带 Markdown 围栏和说明文字的身份清单仍会经过严格结构校验后再原子提交。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(generateStream).toHaveBeenCalledTimes(4)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:character-roster-commit')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        entries: rosterEntries,
        intent: 'architecture_generation',
      }),
      projectAPath,
      context.projectSession,
    )
  })

  it('rejects a manifest response with a truncated JSON fragment after a complete object before any roster commit', async () => {
    const generateStream = createResponseStream([
      `${JSON.stringify(manifestFor(rosterEntries))}\n\n{"slots":[`,
      ...detailResponses(rosterEntries),
    ])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })

    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证完整身份清单后追加截断 JSON 片段时必须在角色名单提交前失败关闭。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow(/完整 JSON|截断/u)

    expect(domainIpcChannels(invoke)).not.toContain('db:character-roster-commit')
  })

  it('accepts fenced detail batches with leading prose after a raw manifest before one atomic roster commit', async () => {
    const generateStream = createResponseStream([
      JSON.stringify(manifestFor(rosterEntries)),
      ...detailResponses(rosterEntries).map(fencedJsonWithProse),
    ])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })

    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证每个角色详情批次即使包裹说明文字和 Markdown 围栏，也必须先严格校验再原子提交。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(generateStream).toHaveBeenCalledTimes(4)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:character-roster-commit')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        entries: rosterEntries,
        intent: 'architecture_generation',
      }),
      projectAPath,
      context.projectSession,
    )
  })

  it('does not issue checkpoint IPC after a readable roster receipt when cancellation has arrived', async () => {
    const committedThenCancelledContext: WorkflowContext = {
      ...context,
      data: {},
      cancelled: false,
    }
    const generateStream = createResponseStream(twoStageResponses(rosterEntries))
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证原子角色名单提交后若收到取消请求，不会再调用任何检查点 IPC。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          committedThenCancelledContext.cancelled = true
          return {
            success: true,
            receipt: {
              operationId: committedThenCancelledContext.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context: committedThenCancelledContext, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(domainIpcChannels(invoke)).toEqual([
      'db:project-core-get',
      'db:character-roster-read',
      'db:character-roster-commit',
    ])
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith('角色图谱与 3 张角色卡已生成；后续工作流已取消')
  })

  it('keeps a committed roster successful when only its partial checkpoint write fails', async () => {
    const checkpointContext: WorkflowContext = { ...context, data: {}, cancelled: false }
    const generateStream = createResponseStream(twoStageResponses(rosterEntries))
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证角色事实提交成功后，检查点写入失败不会误报角色图谱生成失败。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: checkpointContext.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: false, error: '磁盘已满' }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context: checkpointContext, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(checkpointContext.data.partial).toEqual({
      character_dynamics_result: readyRoster.renderedMarkdown,
    })
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith(expect.stringContaining('检查点保存失败'))
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith('角色图谱与 3 张角色卡已生成')
  })

  it('replaces a truncated roster JSON before committing the readable roster receipt', async () => {
    const truncated = '{"slots":['
    const responses = [truncated, JSON.stringify(manifestFor(rosterEntries)), ...detailResponses(rosterEntries)]
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
      modelId: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[2],
    ) => {
      void modelId
      const output = responses[generateStream.mock.calls.length - 1]
      if (!output) throw new Error('unexpected character generation attempt')
      const finishReason = generateStream.mock.calls.length === 1 ? 'length' : 'stop'
      if (generateStream.mock.calls.length === 1) {
        useLLMStore.setState({ defaultModelId: 'model-2' })
      }
      streamCallbacks.onChunk?.(output)
      streamCallbacks.onDone?.(output, undefined, finishReason)
      return Promise.resolve(`truncated-character-request-${generateStream.mock.calls.length}`)
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证截断结构化响应必须先由完整替代 JSON 覆盖后才允许写入结构化角色事实。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(generateStream).toHaveBeenCalledTimes(5)
    expect(generateStream.mock.calls.map(call => call[2])).toEqual(['model-1', 'model-1', 'model-1', 'model-1', 'model-1'])
    const continuationMessages = generateStream.mock.calls[1]?.[0] ?? []
    const continuationPrompt = continuationMessages.find(message => message.role === 'user')?.content ?? ''
    expect(continuationPrompt).toContain('返回完整 JSON，从头重建，不要只补后缀')
    expect(domainIpcChannels(invoke)).toContain('db:character-roster-commit')
  })

  it('keeps the complete protected author guidance on a length replacement request', async () => {
    const promptBudgetDiagnostic = vi.spyOn(console, 'info').mockImplementation(() => {})
    const authorGuidance = [
      'AUTHOR_GUIDANCE_BEGIN',
      'Preserve every relationship, motive, and causal turn. '.repeat(85),
      'AUTHOR_GUIDANCE_END',
    ].join('\n')
    const responses = ['{"slots":[', JSON.stringify(manifestFor(rosterEntries)), ...detailResponses(rosterEntries)]
    const generateStream = createResponseStream(
      responses,
      responses.map((_, index) => index === 0 ? 'length' : 'stop'),
    )
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: 'A sufficiently detailed premise for a protected character-manifest continuation request.' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })
    const runContext = {
      ...context,
      writingLanguage: 'en-US' as const,
      uiLocale: 'en-US' as const,
      data: { stepGuidance: { characters: '' } },
      cancelled: false,
    }
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: {
        genre: 'fantasy',
        totalChapters: 100,
        wordsPerChapter: 3000,
        globalGuidance: authorGuidance,
      } as never,
    })

    await expect(command.execute({ step: {}, context: runContext, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(generateStream).toHaveBeenCalledTimes(5)
    const continuationPrompt = generateStream.mock.calls[1]?.[0]
      .find(message => message.role === 'user')?.content ?? ''
    expect(continuationPrompt).toContain(JSON.stringify({ globalGuidance: authorGuidance }).slice(1, -1))
    expect(continuationPrompt).not.toContain('[content truncated to fit the context budget]')
    expect(promptBudgetDiagnostic.mock.calls[1]?.[1]).toMatchObject({
      sections: expect.arrayContaining([
        expect.objectContaining({ sectionName: 'global-guidance' }),
      ]),
    })
    expect(promptBudgetDiagnostic.mock.calls[1]?.[1]).not.toMatchObject({
      sections: expect.arrayContaining([
        expect.objectContaining({ sectionName: 'continuation-request' }),
      ]),
    })
    expect(domainIpcChannels(invoke)).toContain('db:character-roster-commit')
  })

  it('fails the protected length replacement before an additional provider call when its complete prompt exceeds the product budget', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const generateStream = createResponseStream(['{"slots":['], ['length'])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return []
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: 'A sufficiently detailed premise for a protected character-manifest continuation request.' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })
    const runContext = {
      ...context,
      writingLanguage: 'en-US' as const,
      uiLocale: 'en-US' as const,
      data: { stepGuidance: { characters: '' } },
      cancelled: false,
    }
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: {
        genre: 'fantasy',
        totalChapters: 100,
        wordsPerChapter: 3000,
        globalGuidance: 'G'.repeat(22_000),
      } as never,
    })

    let failure: unknown
    try {
      await command.execute({ step: {}, context: runContext, callbacks })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      name: 'PromptBudgetExceededError',
      code: 'PROMPT_BUDGET_EXHAUSTED',
      report: {
        limitUtf8Bytes: 24_000,
        errorCode: 'PROMPT_BUDGET_EXHAUSTED',
        sections: expect.arrayContaining([
          { sectionName: 'global-guidance', utf8Bytes: 22_019 },
          expect.objectContaining({ sectionName: 'prompt-overhead' }),
        ]),
      },
    })
    expect(failure).not.toHaveProperty('receipt')
    expect(generateStream).toHaveBeenCalledOnce()
    expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
  })

  it('repairs one syntactically invalid detail batch before committing the complete roster', async () => {
    const details = detailResponses(rosterEntries)
    const malformed = details[0]!.slice(0, -2)
    const responses = [JSON.stringify(manifestFor(rosterEntries)), malformed, details[0]!, details[1]!, details[2]!]
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      const output = responses[generateStream.mock.calls.length - 1]
      if (!output) throw new Error('unexpected character generation attempt')
      streamCallbacks.onChunk?.(output)
      streamCallbacks.onDone?.(output, undefined, 'stop')
      return Promise.resolve(`character-request-${generateStream.mock.calls.length}`)
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证一次 JSON 语法修复后的原子角色名单提交，避免测试因为前置长度不足而提前中止。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(generateStream).toHaveBeenCalledTimes(5)
    expect(domainIpcChannels(invoke)).toContain('db:character-roster-commit')
  })

  it('rejects semantically incomplete detail coverage before any roster write', async () => {
    const generateStream = createResponseStream([
      JSON.stringify(manifestFor(rosterEntries)),
      JSON.stringify({ entries: [] }),
    ])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并将空角色名单的语义错误交给原子角色名单 seam 拒绝。' }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow(/覆盖|缺少|结构化/u)

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
  })

  it('accepts valid long character details and leaves size control to the request budget', async () => {
    const longEntries: CharacterRosterEntry[] = rosterEntries.map((entry, index) => (
      index === 0
        ? {
            ...entry,
            appearance: '外'.repeat(301),
            background: '往'.repeat(501),
            currentState: { ...entry.currentState!, recentEvents: '事'.repeat(301) },
          }
        : entry
    ))
    const longRoster = { ...readyRoster, entries: longEntries }
    const generateStream = createResponseStream(twoStageResponses(longEntries))
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global': return { templates: [], diagnostics: [] }
        case 'fs:check-exists': return false
        case 'db:project-core-get': return { premise: '这是一段足够长且包含明确冲突的故事前提，用于验证合法长文本角色详情会由整体请求预算管理，不会再被人为字符上限拒绝并且能够正常原子提交角色事实。' }
        case 'db:character-roster-read': return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit': return {
          success: true,
          receipt: {
            operationId: context.runId,
            payloadHash: 'payload-hash',
            revision: 1,
            idempotent: false,
            snapshot: longRoster,
          },
        }
        case 'fs:read-json': return { success: true, data: {} }
        case 'fs:write-json': return { success: true }
        default: break
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
    })
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toBe(readyRoster.renderedMarkdown)
    expect(generateStream).toHaveBeenCalledTimes(4)
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({ entries: longEntries }),
      projectAPath,
      context.projectSession,
    )
  })

  it('rejects non-finite, boolean, and null age values without echoing their content', async () => {
    for (const invalidAge of [Number.NaN, Number.POSITIVE_INFINITY, true, null]) {
      const invalid = JSON.parse(detailResponses(rosterEntries)[0]) as { entries: Array<Record<string, unknown>> }
      invalid.entries[0].age = invalidAge
      const generateStream = createResponseStream([JSON.stringify(manifestFor(rosterEntries)), JSON.stringify(invalid)])
      useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
      const invoke = vi.fn(async (channel: string) => {
        if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
        if (channel === 'fs:check-exists') return false
        if (channel === 'db:project-core-get') return { premise: '这是一个足够长且包含明确冲突与人物目标的故事前提，用于验证非法年龄类型必须在角色事实提交之前安全失败。' }
        throw new Error(`Unexpected IPC channel: ${channel}`)
      })
      vi.stubGlobal('window', {
        velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
      })
      const command = new GenerateCharactersCommand({
        expectedProjectPath: projectAPath,
        novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
      })

      await expect(command.execute({ step: {}, context, callbacks }))
        .rejects.toThrow('角色详情 slotId=slot-1 字段 age 必须是非空文本')
      expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
    }
  })

  it('rejects mixed, empty, and null state list scalars without echoing their content', async () => {
    for (const field of ['keyItems', 'recentEvents'] as const) {
      for (const invalidValue of [['有效项', 7], [], null]) {
        const invalid = JSON.parse(detailResponses(rosterEntries)[0]) as { entries: Array<Record<string, unknown>> }
        const state = invalid.entries[0].currentState as Record<string, unknown>
        state[field] = invalidValue
        const generateStream = createResponseStream([JSON.stringify(manifestFor(rosterEntries)), JSON.stringify(invalid)])
        useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
        const invoke = vi.fn(async (channel: string) => {
          if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
          if (channel === 'fs:check-exists') return false
          if (channel === 'db:project-core-get') return { premise: '这是一个足够长且包含明确冲突与人物目标的故事前提，用于验证非法角色状态列表必须在角色事实提交之前安全失败。' }
          throw new Error(`Unexpected IPC channel: ${channel}`)
        })
        vi.stubGlobal('window', {
          velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
        })
        const command = new GenerateCharactersCommand({
          expectedProjectPath: projectAPath,
          novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
        })

        await expect(command.execute({ step: {}, context, callbacks }))
          .rejects.toThrow(`角色详情 slotId=slot-1 字段 currentState.${field} 必须是非空文本`)
        expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
      }
    }
  })

  it('rejects a detail without required currentState before any roster write', async () => {
    const missingState = JSON.parse(detailResponses(rosterEntries)[0]) as { entries: Array<Record<string, unknown>> }
    delete missingState.entries[0].currentState
    const generateStream = createResponseStream([JSON.stringify(manifestFor(rosterEntries)), JSON.stringify(missingState)])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') return { premise: '这是一个足够长且包含明确冲突、人物目标和世界危机的故事前提，用于验证角色详情缺少必填初始状态时必须在任何角色名单读取和提交之前失败关闭。' }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: { invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
    })
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('角色详情 slotId=slot-1 字段 currentState 必填')
    expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
  })

  it('fails closed after the single allowed detail JSON repair is still invalid', async () => {
    const malformed = '{"entries":['
    const generateStream = createResponseStream([
      JSON.stringify(manifestFor(rosterEntries)),
      malformed,
      malformed,
    ])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证第二次 JSON 仍无效时绝不继续重试或写入，同时避免测试因为前置长度不足而提前中止。' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow(/语法修复|结构化/u)

    expect(generateStream).toHaveBeenCalledTimes(3)
    expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
  })

  it('does not commit a completed model response after the frozen project session has switched', async () => {
    const result = JSON.stringify(manifestFor(rosterEntries))
    let finishGeneration: (() => void) | undefined
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      finishGeneration = () => streamCallbacks.onDone?.(result, undefined, 'stop')
      return Promise.resolve('late-character-request')
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证项目会话切换后不会提交任何角色图谱或角色卡，同时避免测试因为前置长度不足而提前中止。' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(generateStream).toHaveBeenCalledOnce())
    useProjectStore.setState({ currentProject: project(projectBPath) as never })
    finishGeneration?.()

    await expect(execution).rejects.toThrow('当前项目已切换，架构生成已停止以避免写入错误项目')
    expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
  })

  it('does not commit when cancellation wins before the roster commit boundary', async () => {
    const result = JSON.stringify(manifestFor(rosterEntries))
    let finishGeneration: (() => void) | undefined
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      finishGeneration = () => streamCallbacks.onDone?.(result, undefined, 'stop')
      return Promise.resolve('cancelled-character-request')
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证取消发生在提交前时不会写入角色图谱或角色卡，同时避免测试因为前置长度不足而提前中止。' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke,
        on: vi.fn(),
        once: vi.fn(),
        send: vi.fn(),
        setZoomLevel: vi.fn(),
        setZoomFactor: vi.fn(),
        getZoomLevel: vi.fn(),
      },
    })

    const cancelledContext: WorkflowContext = { ...context, cancelled: false }
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    const execution = command.execute({ step: {}, context: cancelledContext, callbacks })
    await vi.waitFor(() => expect(generateStream).toHaveBeenCalledOnce())
    cancelledContext.cancelled = true
    finishGeneration?.()

    await expect(execution).rejects.toThrow('工作流已取消')
    expect(domainIpcChannels(invoke)).toEqual(['db:project-core-get'])
  })
})
