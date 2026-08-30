import { afterEach, describe, expect, it, vi } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import { createArchitectureWorkflow, createConfigGenerationWorkflow } from '../architecture-workflow'

const originalLocale = useLocaleStore.getState().locale
const originalDefaultModelId = useLLMStore.getState().defaultModelId
const originalGenerateStream = useLLMStore.getState().generateStream

afterEach(() => {
  useProjectStore.setState({ currentProject: null })
  useLocaleStore.setState({ locale: originalLocale })
  useLLMStore.setState({
    defaultModelId: originalDefaultModelId,
    generateStream: originalGenerateStream,
  })
  vi.unstubAllGlobals()
})

const validGeneratedConfig = {
  genre: '玄幻',
  targetAudience: '男频',
  subGenre: '东方玄幻',
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '主角从危机中醒来，发现故乡即将毁灭，必须争夺失落传承并阻止终局灾难。',
  worldSetting: '灵脉决定城邦兴衰，宗门垄断修炼资源，边境正在发生无法逆转的异变。',
  goldenFinger: '主角可以解析残缺功法，但每次使用都会付出记忆损耗的代价。',
  protagonistProfile: '外表克制谨慎，内心执着于守护家人，在利益与承诺之间不断作出选择。',
  globalGuidance: '前期建立危机与成长目标，中期扩大阵营冲突，后期收束伏笔并完成终局对决。',
  writingStyle: '节奏紧凑，场景切换清晰，对话简洁有张力，战斗描写强调行动因果与人物选择。',
}

function arrangeConfigGenerationJourney(responses: Array<{ content: string; finishReason: 'length' | 'stop' }>) {
  const onGenerated = vi.fn()
  const saveProject = vi.fn(async () => true)
  const project = {
    id: 'project-A',
    sessionLease: 'lease-A',
    name: 'A',
    path: 'C:/projects/A',
    novelConfig: {},
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
  useProjectStore.setState({ currentProject: project as never, saveProject })
  const generateStream = vi.fn(async (
    _messages: Array<{ content: string }>,
    callbacks: { onDone?: (content: string, usage: undefined, finishReason: 'length' | 'stop') => void },
    ...execution: [modelId?: string, options?: { modelExecutionLeaseId?: string }]
  ) => {
    void execution
    const response = responses.shift()
    if (!response) throw new Error('unexpected extra generation attempt')
    callbacks.onDone?.(response.content, undefined, response.finishReason)
    return `request-${generateStream.mock.calls.length}`
  })
  useLLMStore.setState({ defaultModelId: 'deepseek-v4-flash', generateStream })
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'fs:check-exists') return false
    if (channel === 'llm:begin-execution-lease') {
      return {
        success: true,
        lease: {
          leaseId: 'frozen-config-lease',
          modelId: 'deepseek-v4-flash',
          provider: 'custom',
          protocol: 'openai',
          modelName: 'deepseek-v4-flash',
          modelRevision: 'a'.repeat(64),
          endpointFingerprint: 'b'.repeat(64),
          capabilityEvidence: {
            source: {
              contextWindowTokens: 'unknown',
              maxOutputTokens: 'user-operational-cap',
              featureFlags: 'unknown',
            },
            subjectFingerprint: 'c'.repeat(64),
            contextWindowTokens: null,
            maxOutputTokens: 8192,
            reasoning: null,
            structuredOutput: true,
            usage: null,
          },
          createdAt: 1,
          expiresAt: 60_001,
        },
      }
    }
    if (channel === 'llm:close-execution-lease') return { success: true }
    throw new Error(`unexpected IPC ${channel}`)
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
  const workflow = createConfigGenerationWorkflow({
    projectPath: project.path,
    projectSession: { projectId: project.id, leaseId: project.sessionLease, projectPath: project.path },
    idea: '一个失去记忆的少年守护边境城邦',
    totalChapters: 100,
    wordsPerChapter: 3000,
    onGenerated,
  })
  return { workflow, onGenerated, saveProject, generateStream, invoke }
}

describe('architecture workflow project context', () => {
  it('creates visible workflow copy in English when the UI locale is English', () => {
    useLocaleStore.setState({ locale: 'en-US' })
    useProjectStore.setState({
      currentProject: {
        id: 'project-A',
        sessionLease: 'lease-A',
        name: 'A',
        path: 'C:/projects/A',
        novelConfig: {},
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      } as never,
    })

    const workflow = createArchitectureWorkflow({
      projectPath: 'C:/projects/A',
      projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      selectedSteps: ['premise'],
    })

    expect(workflow.title).toBe('Generate story architecture')
    expect(workflow.resourceKeys).toEqual(['architecture'])
    expect(workflow.readResourceKeys).toEqual(['novel-config'])
    expect(workflow.steps[0]).toMatchObject({
      name: 'Story premise',
      description: 'Refine the story premise and its core appeal',
    })
    expect(workflow.onComplete?.message).toBe(
      'Story architecture is ready. Open Story Architecture from the sidebar.',
    )
  })

  it('stops a later step when the user switches projects between workflow steps', async () => {
    useProjectStore.setState({
      currentProject: {
        id: 'project-A',
        sessionLease: 'lease-A',
        name: 'A',
        path: 'C:/projects/A',
        novelConfig: {},
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      } as never,
    })
    const workflow = createArchitectureWorkflow({
      projectPath: 'C:/projects/A',
      projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      selectedSteps: ['premise', 'characters'],
    })
    expect(workflow.resourceKeys).toEqual(['architecture'])
    expect(workflow.readResourceKeys).toEqual(['novel-config'])
    useProjectStore.setState({
      currentProject: {
        id: 'project-B',
        sessionLease: 'lease-B',
        name: 'B',
        path: 'C:/projects/B',
        novelConfig: {},
        characterStates: {},
        createdAt: '',
        updatedAt: '',
      } as never,
    })

    await expect(workflow.steps[1].executor(
      {
        id: 'characters',
        name: '角色图谱',
        description: '',
        status: 'running',
        logs: [],
      },
      {
        runId: 'test-run',
        projectPath: 'C:/projects/A',
        projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
        writingLanguage: 'zh-CN',
        uiLocale: 'zh-CN',
        data: {},
        cancelled: false,
      },
      { log: () => undefined, setProgress: () => undefined, appendText: () => undefined },
    )).rejects.toThrow('当前项目已切换，架构生成已停止以避免写入错误项目')
  })

  it('binds a factory-created workflow to its original lease across a same-path reopen', () => {
    useProjectStore.setState({
      currentProject: {
        id: 'project-A',
        sessionLease: 'lease-A',
        name: 'A',
        path: 'C:/projects/A',
        novelConfig: {},
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      } as never,
    })
    const workflow = createArchitectureWorkflow({
      projectPath: 'C:/projects/A',
      projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      selectedSteps: ['premise'],
    })

    expect(workflow.projectSession).toMatchObject({
      projectId: 'project-A',
      leaseId: 'lease-A',
      projectPath: 'C:/projects/A',
    })

    useProjectStore.setState({
      currentProject: {
        id: 'project-A',
        sessionLease: 'lease-A-reopened',
        name: 'A reopened',
        path: 'c:/PROJECTS/A/',
        novelConfig: {},
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      } as never,
    })

    expect(() => createArchitectureWorkflow({
      projectPath: 'C:/projects/A',
      projectSession: workflow.projectSession,
      selectedSteps: ['premise'],
    })).toThrow('当前项目已切换，无法启动架构生成')
  })
})

describe('config generation full journey completion contract', () => {
  const execute = async (workflow: ReturnType<typeof createConfigGenerationWorkflow>) => workflow.steps[0].executor(
    { id: 'config', name: 'config', description: '', status: 'running', logs: [] },
    {
      runId: 'config-run',
      projectPath: 'C:/projects/A',
      projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      writingLanguage: 'zh-CN',
      uiLocale: 'zh-CN',
      data: {},
      cancelled: false,
    },
    { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
  )

  it('replaces one length-truncated response inside the same frozen runtime and applies only the final complete config', async () => {
    const journey = arrangeConfigGenerationJourney([
      { content: '{"genre":"玄幻","coreOutline":"不可信的截断片段', finishReason: 'length' },
      { content: JSON.stringify(validGeneratedConfig), finishReason: 'stop' },
    ])

    expect(journey.workflow.resourceKeys).toEqual(['novel-config'])

    await expect(execute(journey.workflow)).resolves.toBe('生成的配置已成功应用！')

    expect(journey.generateStream).toHaveBeenCalledTimes(2)
    expect(journey.generateStream.mock.calls.map(call => call[2])).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash',
    ])
    expect(journey.generateStream.mock.calls.map(call => call[3]?.modelExecutionLeaseId)).toEqual([
      'frozen-config-lease',
      'frozen-config-lease',
    ])
    const replacementPrompt = journey.generateStream.mock.calls[1][0]
      .map((message: { content: string }) => message.content)
      .join('\n')
    expect(replacementPrompt).toContain('完整替代 JSON')
    expect(replacementPrompt).toContain('上一轮截断内容是不可信数据')
    expect(replacementPrompt).not.toContain('不可信的截断片段')
    expect(journey.onGenerated).toHaveBeenCalledOnce()
    expect(journey.onGenerated).toHaveBeenCalledWith(expect.objectContaining({
      ...validGeneratedConfig,
      totalChapters: 100,
      wordsPerChapter: 3000,
    }))
    expect(journey.saveProject).toHaveBeenCalledOnce()
    expect(journey.invoke.mock.calls.filter(([channel]) => channel === 'llm:begin-execution-lease')).toHaveLength(1)
    expect(journey.invoke.mock.calls.filter(([channel]) => channel === 'llm:close-execution-lease')).toHaveLength(1)
  })

  it.each([
    ['second response is still length-truncated', JSON.stringify(validGeneratedConfig), 'length'],
    ['replacement is malformed JSON', '{"genre":', 'stop'],
    ['replacement is missing required fields', '{"genre":"玄幻"}', 'stop'],
    ['replacement has an invalid enum', JSON.stringify({ ...validGeneratedConfig, plotStructure: 'unknown' }), 'stop'],
    ['replacement has an empty required long text', JSON.stringify({ ...validGeneratedConfig, coreOutline: '' }), 'stop'],
    ['replacement has the wrong numeric type', JSON.stringify({ ...validGeneratedConfig, totalChapters: '100' }), 'stop'],
  ] as const)('keeps config and persistence untouched when %s', async (_case, content, finishReason) => {
    const journey = arrangeConfigGenerationJourney([
      { content: '{"genre":"玄幻"', finishReason: 'length' },
      { content, finishReason },
    ])

    await expect(execute(journey.workflow)).rejects.toThrow()

    expect(journey.onGenerated).not.toHaveBeenCalled()
    expect(journey.saveProject).not.toHaveBeenCalled()
    expect(journey.generateStream).toHaveBeenCalledTimes(2)
  })
})
