import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MainGenerationRunView } from '../../generation/generation-runtime'
import type { GenerationTask } from '../../generation/generation-harness'
import { assertSemanticGenerationTask } from '../../../../electron/services/main-generation-plan'
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
  globalGuidance: '保持因果推进。\n维持角色动机一致。\n控制场景节奏。\n及时回收伏笔。',
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
  const generateStream = vi.fn(() => { throw new Error('Renderer provider dispatch is forbidden') })
  useLLMStore.setState({ defaultModelId: 'deepseek-v4-flash', generateStream })
  const view: MainGenerationRunView = {
    handle: { projectId: project.id, epoch: project.sessionLease, rootActionId: '合成配置根', runId: '合成配置运行' },
    status: 'running', nonReplayable: false, artifacts: [],
    budget: { maxAttempts: 32, maxRequestedOutputTokens: 2097152, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 },
  }
  const executeMain = vi.fn(async (request: { handle: MainGenerationRunView['handle']; invocationNonce: string; task: GenerationTask }) => {
    assertSemanticGenerationTask(request.task)
    expect(request.handle).toEqual(view.handle)
    const response = responses.shift()
    if (!response) throw new Error('unexpected extra generation attempt')
    return { run: structuredClone(view), outcome: {
      status: response.finishReason === 'length' ? 'truncated' : 'completed',
      content: response.content, finishReason: response.finishReason,
      receipt: { finishReason: response.finishReason },
    } }
  })
  const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'db:project-core-commit-generated') return { success: true }
    if (channel === 'fs:check-exists') return false
    if (channel === 'generation:begin' || channel === 'generation:read') return structuredClone(view)
    if (channel === 'generation:execute') return executeMain(args[0] as Parameters<typeof executeMain>[0])
    throw new Error('unexpected IPC ' + channel)
  })
  vi.stubGlobal('window', {
    aiNovelAPI: {
      invoke,
      on: vi.fn(() => () => {}),
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
  return { workflow, onGenerated, saveProject, generateStream, executeMain, invoke }
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

  it('uses the caller-frozen locale after the live locale changes', () => {
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
    useLocaleStore.setState({ locale: 'en-US' })
    const frozenLocale = useLocaleStore.getState().locale
    useLocaleStore.setState({ locale: 'zh-CN' })

    const workflow = createArchitectureWorkflow({
      projectPath: 'C:/projects/A',
      projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      selectedSteps: ['premise'],
    }, frozenLocale)

    expect(workflow).toMatchObject({
      uiLocale: 'en-US',
      title: 'Generate story architecture',
      steps: [expect.objectContaining({ name: 'Story premise' })],
    })
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
    expect(workflow.resourceKeys).toEqual(['architecture', 'character-roster'])
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

    expect(journey.executeMain).toHaveBeenCalledTimes(2)
    expect(journey.generateStream).not.toHaveBeenCalled()
    expect(new Set(journey.executeMain.mock.calls.map(([request]) => request.invocationNonce)).size).toBe(2)
    const replacementPrompt = journey.executeMain.mock.calls[1][0].task.messages
      .map(message => message.content).join('\n')
    expect(replacementPrompt).toContain('完整替代 JSON')
    expect(replacementPrompt).toContain('上一轮截断内容是不可信数据')
    expect(replacementPrompt).not.toContain('不可信的截断片段')
    expect(journey.onGenerated).toHaveBeenCalledOnce()
    expect(journey.onGenerated).toHaveBeenCalledWith(expect.objectContaining({
      ...validGeneratedConfig,
      totalChapters: 100,
      wordsPerChapter: 3000,
    }))
    expect(journey.saveProject).not.toHaveBeenCalled()
    expect(journey.invoke.mock.calls.filter(([channel]) => channel === 'db:project-core-commit-generated')).toHaveLength(1)
    expect(journey.invoke.mock.calls.filter(([channel]) => channel === 'generation:begin')).toHaveLength(1)
    expect(journey.invoke.mock.calls.some(([channel]) => channel.startsWith('llm:'))).toBe(false)
  })

  it('freezes the narrow visible guidance repair contract under the same main run', async () => {
    const guidance = validGeneratedConfig.globalGuidance
    const journey = arrangeConfigGenerationJourney([
      { content: JSON.stringify({ ...validGeneratedConfig, globalGuidance: '太短' }), finishReason: 'stop' },
      { content: guidance, finishReason: 'stop' },
    ])
    await expect(execute(journey.workflow)).resolves.toBe('生成的配置已成功应用！')
    expect(journey.executeMain.mock.calls.map(([request]) => [request.task.purpose, request.task.output]))
      .toEqual([['generate-global-config', 'structured-data'], ['generate-global-guidance-replacement', 'visible-text']])
    const begin = journey.invoke.mock.calls.filter(([channel]) => channel === 'generation:begin')
    expect(begin).toHaveLength(1)
    expect(begin[0][1]).toMatchObject({
      output: 'structured-data',
      outputOverrides: [{ purpose: 'generate-global-guidance-replacement', output: 'visible-text' }],
    })
    expect(journey.onGenerated).toHaveBeenCalledOnce()
    expect(journey.onGenerated).toHaveBeenCalledWith(expect.objectContaining({ globalGuidance: guidance }))
    expect(journey.saveProject).not.toHaveBeenCalled()
    expect(journey.invoke.mock.calls.filter(([channel]) => channel === 'db:project-core-commit-generated')).toHaveLength(1)
    expect(journey.generateStream).not.toHaveBeenCalled()
  })

  it('does not apply the callback or save again when the main source guard rejects', async () => {
    const journey = arrangeConfigGenerationJourney([{ content: JSON.stringify(validGeneratedConfig), finishReason: 'stop' }])
    const original = journey.invoke.getMockImplementation()!
    journey.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'db:project-core-commit-generated') return { success: false, error: 'GENERATION_SOURCE_CHANGED' }
      return original(channel, ...args)
    })
    await expect(execute(journey.workflow)).rejects.toThrow('GENERATION_SOURCE_CHANGED')
    expect(journey.onGenerated).not.toHaveBeenCalled()
    expect(journey.saveProject).not.toHaveBeenCalled()
    expect(journey.executeMain).toHaveBeenCalledOnce()
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
    expect(journey.executeMain).toHaveBeenCalledTimes(2)
    expect(journey.generateStream).not.toHaveBeenCalled()
  })
})


describe('恢复按钮确认的运行身份', () => {
  it.each(['worldbuilding', 'synopsis'] as const)('在 %s 检查点换成另一运行后拒绝续写', async kind => {
    const journey = arrangeConfigGenerationJourney([])
    const expected = { projectId: 'project-A', epoch: '原会话', rootActionId: '原作者动作', runId: '已确认候选运行' }
    const replacement = { ...expected, runId: '后来覆盖的运行' }
    const prefix = kind === 'worldbuilding' ? 'world_building' : 'synopsis'
    journey.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'fs:read-json') return { success: true, data: { [prefix + '_incomplete']: true, [prefix + '_generation_handle']: replacement } }
      throw new Error('不应触达后续通道：' + channel)
    })
    const workflow = createArchitectureWorkflow({
      projectPath: 'C:/projects/A', projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      resumeWorldBuilding: kind === 'worldbuilding', resumeSynopsis: kind === 'synopsis', expectedRecoveryHandle: expected,
    })
    const context = { runId: '恢复动作', projectPath: 'C:/projects/A', projectSession: workflow.projectSession,
      writingLanguage: 'zh-CN' as const, uiLocale: 'zh-CN' as const, data: {}, cancelled: false }
    await expect(workflow.steps[0].executor({ id: kind, name: kind, description: '', status: 'running', logs: [] }, context,
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })).rejects.toThrow('恢复记录已变化')
    expect(journey.invoke.mock.calls.map(([channel]) => channel)).toEqual(['fs:read-json'])
    expect(context.data).not.toHaveProperty('partial')
  })

  it('冻结按钮身份，调用方后续改写对象不能把另一运行变成已确认候选', async () => {
    const journey = arrangeConfigGenerationJourney([])
    const expected = { projectId: 'project-A', epoch: '原会话', rootActionId: '原作者动作', runId: '已确认候选运行' }
    const workflow = createArchitectureWorkflow({ projectPath: 'C:/projects/A',
      projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
      resumeWorldBuilding: true, expectedRecoveryHandle: expected })
    expected.runId = '后来覆盖的运行'
    journey.invoke.mockImplementation(async () => ({ success: true, data: {
      world_building_incomplete: true, world_building_generation_handle: expected,
    } }))
    await expect(workflow.steps[0].executor({ id: '恢复', name: '恢复', description: '', status: 'running', logs: [] },
      { runId: '恢复动作', projectPath: 'C:/projects/A', projectSession: workflow.projectSession,
        writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false },
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() })).rejects.toThrow('恢复记录已变化')
  })
})
