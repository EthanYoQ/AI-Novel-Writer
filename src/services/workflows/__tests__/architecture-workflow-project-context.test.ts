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
      '角色图谱正文',
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
    expect(invoke).toHaveBeenCalledWith(
      'db:character-save-all',
      expect.arrayContaining([expect.objectContaining({ name: 'Alice' })]),
      undefined,
      'C:/projects/A',
      expect.objectContaining({ projectId: 'project-A', leaseId: 'lease-A' }),
    )
  })
})
