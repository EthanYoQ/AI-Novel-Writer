import { afterEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { createArchitectureWorkflow, createCharacterExtractSteps } from '../architecture-workflow'

const originalGenerateStream = useLLMStore.getState().generateStream
const originalLocale = useLocaleStore.getState().locale

afterEach(() => {
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ generateStream: originalGenerateStream })
  useLocaleStore.setState({ locale: originalLocale })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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

  it('saves the source-complete role list when the model returns only the protagonist', async () => {
    const source = JSON.stringify({
      characters: [
        { name: '林晓薇', role: 'protagonist' },
        { name: '周砚', role: 'supporting' },
        { name: 'Ethan', role: 'antagonist' },
      ],
    })
    const generatedCard = JSON.stringify({
      characters: [{ name: '林晓薇', role: 'protagonist', appearance: '灰色职业套装' }],
    })
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      callbacks.onChunk?.(generatedCard)
      callbacks.onDone?.(generatedCard)
      return Promise.resolve('request-id')
    })
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      void args
      if (channel === 'db:character-get-all') return []
      if (channel === 'db:character-save-all') return { success: true }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    useLLMStore.setState({ generateStream })
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

    const [extractStep] = createCharacterExtractSteps('C:/projects/A', source, '科幻')
    await extractStep.executor(
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
      {
        runId: 'extract-run',
        projectPath: 'C:/projects/A',
        projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
        data: {},
        cancelled: false,
      },
    )

    expect(invoke).toHaveBeenCalledWith(
      'db:character-save-all',
      expect.arrayContaining([
        expect.objectContaining({ name: '林晓薇', role: 'protagonist' }),
        expect.objectContaining({ name: '周砚', role: 'supporting' }),
        expect.objectContaining({ name: 'Ethan', role: 'antagonist' }),
      ]),
      undefined,
      'C:/projects/A',
      expect.objectContaining({ projectId: 'project-A', leaseId: 'lease-A' }),
    )
    const savedCards = invoke.mock.calls.find(([channel]) => channel === 'db:character-save-all')?.[1] as Array<{ name: string }>
    expect(new Set(savedCards.map(card => card.name)).size).toBe(savedCards.length)
  })

  it('does not save over existing manual cards when the architecture cannot establish a complete role list', async () => {
    const manualCards = [{ name: '手工角色', role: 'supporting', notes: '作者已确认' }]
    const generatedCard = JSON.stringify({
      characters: [{ name: '林晓薇', role: 'protagonist' }],
    })
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      callbacks.onChunk?.(generatedCard)
      callbacks.onDone?.(generatedCard)
      return Promise.resolve('request-id')
    })
    const invoke = vi.fn(async () => {
      manualCards.splice(0, manualCards.length)
      return { success: true }
    })
    useLLMStore.setState({ generateStream })
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

    const [extractStep] = createCharacterExtractSteps(
      'C:/projects/A',
      '故事围绕主角林晓薇与反派 Ethan 的冲突展开，但没有明确角色条目。',
      '科幻',
    )

    await expect(extractStep.executor(
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
      {
        runId: 'extract-run',
        projectPath: 'C:/projects/A',
        projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
        data: {},
        cancelled: false,
      },
    )).rejects.toThrow('无法从角色图谱中安全识别完整角色清单')

    expect(invoke).not.toHaveBeenCalled()
    expect(manualCards).toEqual([{ name: '手工角色', role: 'supporting', notes: '作者已确认' }])
  })

  it('keeps manual character fields and cards when source-only extraction is sparse', async () => {
    const source = JSON.stringify({
      characters: [
        { name: '陈默', role: 'protagonist', gender: '男', appearance: '生成的黑衣形象', relationships: '李霜：盟友' },
        { name: '李霜', role: 'supporting', background: '来自边境的向导' },
      ],
    })
    const generatedCard = JSON.stringify({ characters: [] })
    const existingCards = [
      {
        name: '陈默', role: 'supporting', gender: '', age: '', appearance: '作者手写的旧斗篷',
        personality: '', background: '', abilities: '', motivation: '', relationships: '[暂无明确关系]',
        arc: '', notes: '作者已确认，不应覆盖',
      },
      {
        name: '手工旁角色', role: 'minor', gender: '', age: '', appearance: '', personality: '',
        background: '不在本轮架构中的既有角色', abilities: '', motivation: '', relationships: '', arc: '', notes: '',
      },
    ]
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      callbacks.onChunk?.(generatedCard)
      callbacks.onDone?.(generatedCard)
      return Promise.resolve('request-id')
    })
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      void args
      if (channel === 'db:character-get-all') return existingCards
      if (channel === 'db:character-save-all') return { success: true }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    useLLMStore.setState({ generateStream })
    useProjectStore.setState({
      currentProject: {
        id: 'project-A', sessionLease: 'lease-A', name: 'A', path: 'C:/projects/A',
        novelConfig: {}, characterStates: '', createdAt: '', updatedAt: '',
      } as never,
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(),
        setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(),
      },
    })

    const [extractStep] = createCharacterExtractSteps('C:/projects/A', source, '玄幻')
    await extractStep.executor(
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
      {
        runId: 'extract-run', projectPath: 'C:/projects/A',
        projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
        data: {}, cancelled: false,
      },
    )

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'db:character-get-all',
      'C:/projects/A',
      expect.objectContaining({ projectId: 'project-A', leaseId: 'lease-A' }),
    )
    const saveCall = invoke.mock.calls.find(([channel]) => channel === 'db:character-save-all')
    const savedCards = saveCall?.[1] as Array<Record<string, unknown>>
    expect(savedCards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: '陈默', role: 'supporting', gender: '男', appearance: '作者手写的旧斗篷',
        relationships: '[暂无明确关系]', notes: '作者已确认，不应覆盖',
      }),
      expect.objectContaining({ name: '李霜', background: '来自边境的向导' }),
      expect.objectContaining({ name: '手工旁角色', background: '不在本轮架构中的既有角色' }),
    ]))
  })

  it('does not save when existing character identities are unsafe to merge', async () => {
    const source = JSON.stringify({
      characters: [{ name: '陈默', role: 'protagonist' }],
    })
    const generatedCard = JSON.stringify({ characters: [] })
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      callbacks.onChunk?.(generatedCard)
      callbacks.onDone?.(generatedCard)
      return Promise.resolve('request-id')
    })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:character-get-all') {
        return [
          { name: '陈默', role: 'supporting' },
          { name: '陈默', role: 'antagonist' },
        ]
      }
      if (channel === 'db:character-save-all') return { success: true }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    useLLMStore.setState({ generateStream })
    useProjectStore.setState({
      currentProject: {
        id: 'project-A', sessionLease: 'lease-A', name: 'A', path: 'C:/projects/A',
        novelConfig: {}, characterStates: '', createdAt: '', updatedAt: '',
      } as never,
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(),
        setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(),
      },
    })

    const [extractStep] = createCharacterExtractSteps('C:/projects/A', source, '玄幻')
    await expect(extractStep.executor(
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
      {
        runId: 'extract-run', projectPath: 'C:/projects/A',
        projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
        data: {}, cancelled: false,
      },
    )).rejects.toThrow('无法安全合并已有角色卡')

    expect(invoke).toHaveBeenCalledWith(
      'db:character-get-all',
      'C:/projects/A',
      expect.objectContaining({ projectId: 'project-A', leaseId: 'lease-A' }),
    )
    expect(invoke).not.toHaveBeenCalledWith(
      'db:character-save-all',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
  })

  it('rejects character persistence when project A extraction finishes after switching to B', async () => {
    let currentProjectPath = 'C:/projects/A'
    let finishGeneration: (() => void) | undefined
    const projectBCharacters: unknown[] = []
    const generatedCard = JSON.stringify({
      characters: [{ name: 'Alice', role: 'protagonist' }],
    })
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      callbacks.onChunk?.(generatedCard)
      return new Promise<string>((resolve) => {
        finishGeneration = () => {
          callbacks.onDone?.(generatedCard)
          resolve(generatedCard)
        }
      })
    })
    useLLMStore.setState({ generateStream })
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

    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel !== 'db:character-save-all') {
        throw new Error(`Unexpected IPC channel: ${channel}`)
      }
      const expectedProjectPath = args[2]
      if (expectedProjectPath !== currentProjectPath) {
        return { success: false, error: '项目上下文已切换，已拒绝跨项目读写' }
      }
      projectBCharacters.push(...(args[0] as unknown[]))
      return { success: true }
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

    const [extractStep] = createCharacterExtractSteps(
      'C:/projects/A',
      JSON.stringify({ characters: [{ name: 'Alice', role: 'protagonist' }] }),
      '科幻',
    )
    const execution = extractStep.executor(
      { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
      {
        runId: 'extract-run',
        projectPath: 'C:/projects/A',
        projectSession: { projectId: 'project-A', leaseId: 'lease-A', projectPath: 'C:/projects/A' },
        data: {},
        cancelled: false,
      },
    )
    await vi.waitFor(() => expect(generateStream).toHaveBeenCalledOnce())

    currentProjectPath = 'C:/projects/B'
    useProjectStore.setState({
      currentProject: {
        id: 'project-B',
        sessionLease: 'lease-B',
        name: 'B',
        path: 'C:/projects/B',
        novelConfig: {},
        characterStates: '',
        createdAt: '',
        updatedAt: '',
      } as never,
    })
    finishGeneration?.()

    await expect(execution).rejects.toThrow('项目上下文已切换')
    expect(projectBCharacters).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })
})
