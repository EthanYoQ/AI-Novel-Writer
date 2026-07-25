import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { GenerateDirectoryCommand } from '../directory.command'

const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

const context: WorkflowContext = {
  runId: 'test-run',
  projectPath: 'C:\\tmp\\vela-test',
  projectSession: {
    projectId: 'project-1',
    leaseId: 'lease-project-1',
    projectPath: 'C:\\tmp\\vela-test',
  },
  data: {
    architecture: '故事前提'.repeat(30),
  },
  cancelled: false,
}

const projectSnapshot = {
  expectedProjectPath: 'C:\\tmp\\vela-test',
  novelConfig: {
    totalChapters: 3,
    globalGuidance: '',
    genre: '玄幻',
  },
}

function stubIpcInvoke(handler: (channel: string, ...args: unknown[]) => unknown) {
  const invoke = vi.fn((channel: string, ...args: unknown[]) => Promise.resolve(handler(channel, ...args)))
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
  return invoke
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectStore.setState({
    currentProject: {
      id: 'project-1',
      name: '测试项目',
      path: 'C:\\tmp\\vela-test',
      sessionLease: 'lease-project-1',
      novelConfig: {
        genre: '玄幻',
        subGenre: '',
        targetAudience: '男频',
        totalChapters: 3,
        wordsPerChapter: 3000,
        plotStructure: 'three_act',
        narrativePOV: 'third_limited',
        coreOutline: '',
        worldSetting: '',
        goldenFinger: '',
        protagonistProfile: '',
        globalGuidance: '',
      },
      characterStates: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  })
  useLLMStore.setState({
    defaultModelId: 'model-1',
    models: [{
      id: 'model-1',
      name: '测试模型',
      provider: 'custom',
      protocol: 'openai',
      modelName: 'test',
      apiKey: '',
      baseUrl: '',
      temperature: 0.7,
      maxTokens: 4096,
      purposes: ['generation'],
    }],
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ defaultModelId: null, models: [] })
})

describe('GenerateDirectoryCommand', () => {
  it('fails when a generated batch parses to no blueprints', async () => {
    stubIpcInvoke(() => ({ success: true }))
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot)
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM').mockResolvedValue('[]')

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(/未解析到/)
  })

  it('fails when a saved blueprint cannot be read back from the DB', async () => {
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'db:blueprint-upsert-many') return { success: true }
      if (channel === 'db:blueprint-get') return null
      return { success: true }
    })
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot)
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM').mockResolvedValue(
      '[{"chapterNumber":1,"title":"启程","keyEvents":"主角发现异常"}]',
    )

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(/保存后验证/)
    expect(invoke).toHaveBeenCalledWith('db:blueprint-get', 1, projectSnapshot.expectedProjectPath, context.projectSession)
  })

  it('fails when generated blueprints skip required target chapters', async () => {
    const invoke = stubIpcInvoke(() => ({ success: true }))
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 3 }, projectSnapshot)
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM').mockResolvedValue(
      '[{"chapterNumber":3,"title":"错位","keyEvents":"只返回第三章"}]',
    )

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(/缺少目标章节/)
    expect(invoke).not.toHaveBeenCalledWith('db:blueprint-upsert-many', expect.anything())
  })

  it('repairs malformed blueprint JSON once before saving it', async () => {
    const savedBlueprint = {
      chapterNumber: 1,
      title: '启程',
      role: '发展',
      purpose: '',
      keyEvents: '主角发现异常',
      characters: [],
      suspenseHook: '',
      userGuidance: '',
      notes: '',
      notesUpdatedAt: '',
    }
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'db:blueprint-upsert-many') return { success: true }
      if (channel === 'db:blueprint-get') return savedBlueprint
      return { success: true }
    })
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot)
    const callLLM = vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM')
      .mockResolvedValueOnce('{"blueprints":[{"chapterNumber" 1,"title":"启程"}]}')
      .mockResolvedValueOnce('[{"chapterNumber":1,"title":"启程","keyEvents":"主角发现异常"}]')

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toEqual([savedBlueprint])
    expect(callLLM).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledWith(
      'db:blueprint-upsert-many',
      [savedBlueprint],
      projectSnapshot.expectedProjectPath,
      context.projectSession,
    )
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('正在请求模型修复格式'))
  })

  it('keeps the frozen project path after an LLM response returns following a project switch', async () => {
    let resolveLlm!: (value: string) => void
    const llmResult = new Promise<string>((resolve) => {
      resolveLlm = resolve
    })
    const invoke = stubIpcInvoke((channel, ...args) => {
      if (
        (channel === 'db:blueprint-upsert-many' || channel === 'db:blueprint-get')
        && args[1] !== projectSnapshot.expectedProjectPath
      ) {
        throw new Error('unexpected project path')
      }
      if (channel === 'db:blueprint-upsert-many') {
        return useProjectStore.getState().currentProject?.path === args[1]
          ? { success: true }
          : { success: false, error: '项目上下文已切换' }
      }
      return { success: true }
    })
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot)
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM')
      .mockReturnValue(llmResult)

    const execution = command.execute({ step: {}, context, callbacks })
    await Promise.resolve()
    useProjectStore.setState((state) => ({
      currentProject: state.currentProject
        ? { ...state.currentProject, id: 'project-2', path: 'C:\\tmp\\project-b' }
        : null,
    }))
    resolveLlm('[{"chapterNumber":1,"title":"启程","keyEvents":"主角发现异常"}]')

    await expect(execution).rejects.toThrow(/项目上下文已切换/)
    expect(invoke).toHaveBeenCalledWith(
      'db:blueprint-upsert-many',
      [expect.objectContaining({ chapterNumber: 1 })],
      projectSnapshot.expectedProjectPath,
      context.projectSession,
    )
    expect(invoke.mock.calls.some(([, ...args]) => args.includes('C:\\tmp\\project-b'))).toBe(false)
  })
})
