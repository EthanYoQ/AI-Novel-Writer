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

function blueprintJson(chapterNumbers: number[]): string {
  return JSON.stringify({
    blueprints: chapterNumbers.map(chapterNumber => ({
      chapterNumber,
      title: `第${chapterNumber}章`,
      role: '发展',
      purpose: `推进第${chapterNumber}章`,
      keyEvents: `第${chapterNumber}章发生关键事件`,
      characters: [],
      suspenseHook: '',
    })),
  })
}

function createPersistenceIpc() {
  const saved = new Map<number, Record<string, unknown>>()
  const invoke = stubIpcInvoke((channel, ...args) => {
    if (channel === 'db:blueprint-upsert-many') {
      for (const blueprint of args[0] as Array<Record<string, unknown>>) {
        saved.set(Number(blueprint.chapterNumber), blueprint)
      }
      return { success: true }
    }
    if (channel === 'db:blueprint-get') {
      return saved.get(Number(args[0])) ?? null
    }
    return { success: true }
  })
  return { invoke, saved }
}

function persistedBatches(invoke: ReturnType<typeof vi.fn>): number[][] {
  return invoke.mock.calls
    .filter(([channel]) => channel === 'db:blueprint-upsert-many')
    .map(([, blueprints]) => (blueprints as Array<{ chapterNumber: number }>).map(({ chapterNumber }) => chapterNumber))
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
  it('synchronizes blueprint character candidates only after the batch is persisted and verified', async () => {
    const saved = new Map<number, Record<string, unknown>>()
    const invoke = stubIpcInvoke((channel, ...args) => {
      if (channel === 'db:blueprint-upsert-many') {
        for (const blueprint of args[0] as Array<Record<string, unknown>>) {
          saved.set(Number(blueprint.chapterNumber), blueprint)
        }
        return { success: true }
      }
      if (channel === 'db:blueprint-get') return saved.get(Number(args[0])) ?? null
      if (channel === 'db:character-roster-read') {
        return { status: 'empty', revision: 0, entries: [] }
      }
      if (channel === 'db:character-roster-commit') {
        const request = args[0] as { entries: unknown[] }
        return { success: true, receipt: { revision: 1, snapshot: { status: 'ready', entries: request.entries } } }
      }
      return { success: true }
    })
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot)
    vi.spyOn(command as unknown as { callLLMWithBoundedCompletion: () => Promise<string> }, 'callLLMWithBoundedCompletion').mockResolvedValue(JSON.stringify({
      blueprints: [{
        chapterNumber: 1,
        title: '结盟',
        keyEvents: '两人结盟追查真相',
        characters: ['林岚', '周砚'],
        relationships: [{ from: '林岚', to: '周砚', relation: '共同追查真相' }],
      }],
    }))

    await command.execute({ step: {}, context, callbacks })

    const persistedAt = invoke.mock.calls.findIndex(([channel]) => channel === 'db:blueprint-upsert-many')
    const verifiedAt = invoke.mock.calls.findIndex(([channel]) => channel === 'db:blueprint-get')
    const candidateSyncAt = invoke.mock.calls.findIndex(([channel]) => channel === 'db:character-roster-read')
    expect(persistedAt).toBeGreaterThanOrEqual(0)
    expect(verifiedAt).toBeGreaterThan(persistedAt)
    expect(candidateSyncAt).toBeGreaterThan(verifiedAt)
    const candidateCommit = invoke.mock.calls
      .find(([channel]) => channel === 'db:character-roster-commit')?.[1] as { entries: unknown[] }
    expect(candidateCommit.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: '林岚',
        relationships: [{ target: '周砚', relation: '共同追查真相' }],
      }),
      expect.objectContaining({
        name: '周砚',
        relationships: [{ target: '林岚', relation: '共同追查真相' }],
      }),
    ]))
  })

  it('partitions a 12-chapter request into 1–5, 6–10, and 11–12 even for a high-output model', async () => {
    const snapshot = {
      ...projectSnapshot,
      novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 12 },
    }
    useLLMStore.setState((state) => ({
      models: state.models.map(model => ({ ...model, maxTokens: 100_000 })),
    }))
    const { invoke } = createPersistenceIpc()
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 12 }, snapshot)
    const callLLM = vi.spyOn(
      command as unknown as { callLLMWithBoundedCompletion: (...args: unknown[]) => Promise<string> },
      'callLLMWithBoundedCompletion',
    )
      .mockResolvedValueOnce(blueprintJson([1, 2, 3, 4, 5]))
      .mockResolvedValueOnce(blueprintJson([6, 7, 8, 9, 10]))
      .mockResolvedValueOnce(blueprintJson([11, 12]))

    const result = await command.execute({ step: {}, context, callbacks })

    expect(result.map(blueprint => blueprint.chapterNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(callLLM).toHaveBeenCalledTimes(3)
    const physicalRequestPrompts = callLLM.mock.calls.map(([prompt]) => String(prompt))
    expect(physicalRequestPrompts[0]).toContain('第1章到第5章')
    expect(physicalRequestPrompts[0]).toContain('全书规模：共 12 章')
    expect(physicalRequestPrompts[1]).toContain('第6章到第10章')
    expect(physicalRequestPrompts[2]).toContain('第11章到第12章')
    expect(persistedBatches(invoke)).toEqual([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12]])
  })

  it('rejects an out-of-range chapter before any blueprint batch is persisted or cursor advances', async () => {
    const snapshot = {
      ...projectSnapshot,
      novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 6 },
    }
    const { invoke } = createPersistenceIpc()
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 6 }, snapshot)
    vi.spyOn(command as unknown as { callLLMWithBoundedCompletion: () => Promise<string> }, 'callLLMWithBoundedCompletion').mockResolvedValue(
      blueprintJson([1, 2, 3, 4, 5, 6]),
    )

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(/越界/)
    expect(persistedBatches(invoke)).toEqual([])
  })

  it('rejects a batch missing its final requested chapter before any blueprint batch is persisted', async () => {
    const snapshot = {
      ...projectSnapshot,
      novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 6 },
    }
    const { invoke } = createPersistenceIpc()
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 6 }, snapshot)
    vi.spyOn(command as unknown as { callLLMWithBoundedCompletion: () => Promise<string> }, 'callLLMWithBoundedCompletion').mockResolvedValue(
      blueprintJson([1, 2, 3, 4]),
    )

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(/缺少目标章节/)
    expect(persistedBatches(invoke)).toEqual([])
  })

  it('uses the current physical batch range for JSON repair rather than the complete request range', async () => {
    const snapshot = {
      ...projectSnapshot,
      novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 6 },
    }
    createPersistenceIpc()
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 6 }, snapshot)
    const callLLM = vi.spyOn(
      command as unknown as { callLLMWithBoundedCompletion: (...args: unknown[]) => Promise<string> },
      'callLLMWithBoundedCompletion',
    )
      .mockResolvedValueOnce('{"blueprints":[{"chapterNumber" 1}]}')
      .mockResolvedValueOnce(blueprintJson([1, 2, 3, 4, 5]))
      .mockResolvedValueOnce(blueprintJson([6]))

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toHaveLength(6)
    expect(callLLM).toHaveBeenCalledTimes(3)
    expect(String(callLLM.mock.calls[1]?.[0])).toContain('第 1 至第 5 章')
  })

  it('does not try JSON repair after the model reports a length-limited completion', async () => {
    const { invoke } = createPersistenceIpc()
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot)
    const callLLM = vi.spyOn(command as unknown as { callLLMWithBoundedCompletion: () => Promise<string> }, 'callLLMWithBoundedCompletion')
      .mockRejectedValueOnce(new Error('AI 输出达到模型最大长度，结果不完整。'))

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(/最大长度/)
    expect(callLLM).toHaveBeenCalledTimes(1)
    expect(persistedBatches(invoke)).toEqual([])
  })

  it('replaces a length-truncated blueprint JSON with one complete response before atomically persisting the batch', async () => {
    const { invoke } = createPersistenceIpc()
    const partialOutput = '<think>这段推理不得进入续写上下文</think>{"blueprints":[{"chapterNumber":1,"title":"半截标题"'
    const visiblePartial = '{"blueprints":[{"chapterNumber":1,"title":"半截标题"'
    const replacementOutput = blueprintJson([1])
    const completions = [
      { content: partialOutput, finishReason: 'length' as const },
      { content: replacementOutput, finishReason: 'stop' as const },
    ]
    const generateStream = vi.fn(async (
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      const completion = completions.shift()
      if (!completion) throw new Error('unexpected extra continuation request')
      streamCallbacks.onChunk?.(completion.content)
      streamCallbacks.onDone?.(completion.content, undefined, completion.finishReason)
      return `request-${generateStream.mock.calls.length}`
    })
    useLLMStore.setState({ generateStream })

    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot)

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toEqual([
      expect.objectContaining({
        chapterNumber: 1,
        title: '第1章',
        keyEvents: '第1章发生关键事件',
      }),
    ])
    expect(generateStream).toHaveBeenCalledTimes(2)
    const continuationMessages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0]
      = generateStream.mock.calls[1]?.[0] ?? []
    const continuationPrompt = continuationMessages.find(message => message.role === 'user')?.content ?? ''
    expect(continuationPrompt).toContain(visiblePartial)
    expect(continuationPrompt).not.toContain('<think>')
    expect(continuationPrompt).toContain('返回完整 JSON，从头重建，不要只补后缀')
    expect(continuationPrompt).toContain('第1章到第1章')
    expect(persistedBatches(invoke)).toEqual([[1]])
  })

  it('fails when a generated batch parses to no blueprints', async () => {
    stubIpcInvoke(() => ({ success: true }))
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot)
    vi.spyOn(command as unknown as { callLLMWithBoundedCompletion: () => Promise<string> }, 'callLLMWithBoundedCompletion').mockResolvedValue('[]')

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(/未解析到/)
  })

  it('fails when a saved blueprint cannot be read back from the DB', async () => {
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'db:blueprint-upsert-many') return { success: true }
      if (channel === 'db:blueprint-get') return null
      return { success: true }
    })
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 }, projectSnapshot)
    vi.spyOn(command as unknown as { callLLMWithBoundedCompletion: () => Promise<string> }, 'callLLMWithBoundedCompletion').mockResolvedValue(
      '[{"chapterNumber":1,"title":"启程","keyEvents":"主角发现异常"}]',
    )

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(/保存后验证/)
    expect(invoke).toHaveBeenCalledWith('db:blueprint-get', 1, projectSnapshot.expectedProjectPath, context.projectSession)
  })

  it('fails when generated blueprints skip required target chapters', async () => {
    const invoke = stubIpcInvoke(() => ({ success: true }))
    const command = new GenerateDirectoryCommand({ mode: 'full', count: 3 }, projectSnapshot)
    vi.spyOn(command as unknown as { callLLMWithBoundedCompletion: () => Promise<string> }, 'callLLMWithBoundedCompletion').mockResolvedValue(
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
    const callLLM = vi.spyOn(command as unknown as { callLLMWithBoundedCompletion: () => Promise<string> }, 'callLLMWithBoundedCompletion')
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
    vi.spyOn(command as unknown as { callLLMWithBoundedCompletion: () => Promise<string> }, 'callLLMWithBoundedCompletion')
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
