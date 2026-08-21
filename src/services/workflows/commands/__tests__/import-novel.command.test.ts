import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
  ImportInitializeCommand,
  InferBlueprintsPerChapterCommand as RuntimeInferBlueprintsPerChapterCommand,
  InferGlobalSettingsCommand as RuntimeInferGlobalSettingsCommand,
} from '../import-novel.command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'

class InferBlueprintsPerChapterCommand extends RuntimeInferBlueprintsPerChapterCommand {
  constructor() { super(workflowRuntimeDependencies) }
}

class InferGlobalSettingsCommand extends RuntimeInferGlobalSettingsCommand {
  constructor() { super(workflowRuntimeDependencies) }
}

const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}
const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId
const originalRefreshFileTree = useProjectStore.getState().refreshFileTree

function createContext(): WorkflowContext {
  return {
    runId: 'test-run',
    projectPath: 'C:\\tmp\\vela-import-test',
    projectSession: {
      projectId: 'project-1',
      leaseId: 'lease-project-1',
      projectPath: 'C:\\tmp\\vela-import-test',
    },
    data: {
      novelConfigSummary: '类型: 玄幻',
      chapters: [
        {
          number: 1,
          title: '启程',
          content: '主角在雨夜发现异常，并踏上旅程。',
          wordCount: 18,
        },
      ],
    },
    cancelled: false,
  }
}

function validInference() {
  const card = (name: string, role: 'protagonist' | 'supporting' | 'antagonist') => ({
    name,
    role,
    gender: '未知',
    age: 18,
    appearance: '外貌明确',
    personality: '性格明确',
    background: '背景明确',
    abilities: '能力明确',
    motivation: '动机明确',
    relationships: [],
    arc: '角色弧光',
    notes: '待确认',
    currentState: {
      location: '城中',
      powerLevel: '普通',
      physicalState: '正常',
      mentalState: '警觉',
      keyItems: '无',
      recentEvents: '启程',
      updatedAtChapter: 1,
    },
  })
  return {
    novelConfig: {
      genre: '现实',
      subGenre: '讽刺',
      targetAudience: '通用',
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '主角在冲突中逐步认识世界。',
      worldSetting: '现实社会。',
      goldenFinger: '无。',
      protagonistProfile: '敏感而倔强。',
      globalGuidance: '保持克制叙事。',
    },
    architectureFiles: {
      premise: '个人与环境持续冲突。',
      worldbuilding: '现实社会结构。',
      synopsis: '主角经历挫折并作出选择。',
    },
    characterCards: [
      card('陆舟', 'protagonist'),
      card('苏绾', 'supporting'),
      card('顾岩', 'antagonist'),
    ],
  }
}

function successfulInferenceIpc() {
  return stubIpcInvoke((channel, request) => {
    if (channel === 'kb:search') return []
    if (channel === 'db:character-roster-read') return { status: 'ready', revision: 7, entries: [] }
    if (channel === 'db:import-global-facts-commit') {
      const candidate = request as {
        operationId: string
        core: object
        characterEntries: unknown[]
      }
      return {
        success: true,
        receipt: {
          operationId: candidate.operationId,
          payloadHash: 'f'.repeat(64),
          idempotent: false,
          core: candidate.core,
          roster: { snapshot: { status: 'ready', entries: candidate.characterEntries } },
        },
      }
    }
    throw new Error(`unexpected IPC ${channel}`)
  })
}

function stubIpcInvoke(handler: (channel: string, ...args: unknown[]) => unknown) {
  const invoke = vi.fn((channel: string, ...args: unknown[]) => Promise.resolve(
    channel === 'prompt:load-global' ? { templates: [], diagnostics: [] }
      : channel === 'fs:check-exists' && String(args[0]).endsWith('/.vela/prompts') ? false
        : handler(channel, ...args),
  ))
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
      name: '导入项目',
      path: 'C:\\tmp\\vela-import-test',
      sessionLease: 'lease-project-1',
      novelConfig: {
        genre: '玄幻',
        subGenre: '',
        targetAudience: '男频',
        totalChapters: 1,
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
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  useProjectStore.setState({ currentProject: null, refreshFileTree: originalRefreshFileTree })
  useLLMStore.setState({
    defaultModelId: originalDefaultModelId,
    generateStream: originalGenerateStream,
  })
})

describe('ImportInitializeCommand', () => {
  function finalizedReceipt(context: WorkflowContext) {
    const chapters = context.data.chapters as Array<{
      number: number
      content: string
    }>
    return {
      operationId: `novel-import-finalized-${context.runId}`,
      payloadHash: 'a'.repeat(64),
      chapterNumbers: chapters.map(chapter => chapter.number),
      drafts: chapters.map((chapter, index) => ({
        chapterNumber: chapter.number,
        draftId: index + 10,
        finalizationId: `finalization-${chapter.number}`,
        contentHash: String(index + 1).repeat(64),
        targetFileName: `第${chapter.number}章.txt`,
        status: 'finalized' as const,
        publicationStatus: 'pending' as const,
      })),
      idempotent: false,
    }
  }

  it('uses one finalized batch commit before any knowledge-base write and records its receipt', async () => {
    const context = createContext()
    const receipt = finalizedReceipt(context)
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'db:draft-import-finalized-batch') {
        return { success: true, receipt }
      }
      if (channel === 'kb:import-text') return { success: true }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC ${channel}`)
    })

    await new ImportInitializeCommand(context.data.chapters as never[]).execute({
      step: {},
      context,
      callbacks,
    })

    const channels = invoke.mock.calls.map(([channel]) => channel)
    expect(channels.filter(channel => channel === 'db:draft-import-finalized-batch')).toHaveLength(1)
    expect(channels).not.toContain('db:draft-create')
    expect(channels).not.toContain('db:draft-update-status')
    expect(channels.indexOf('db:draft-import-finalized-batch'))
      .toBeLessThan(channels.indexOf('kb:import-text'))
    expect(context.data.finalizedDraftImportReceipt).toEqual(receipt)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('数据库定稿事实已提交'))
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('实体稿发布记录已进入待发布队列'))
  })

  it('continues after a pending derived file-tree refresh while preserving the finalized import receipt', async () => {
    vi.useFakeTimers()
    const context = createContext()
    const receipt = finalizedReceipt(context)
    stubIpcInvoke((channel) => {
      if (channel === 'db:draft-import-finalized-batch') return { success: true, receipt }
      if (channel === 'kb:import-text') return { success: true }
      throw new Error(`unexpected IPC ${channel}`)
    })
    const refreshFileTree = vi.fn(() => new Promise<void>(() => {}))
    useProjectStore.setState({ refreshFileTree })
    let settled = false
    let failure: unknown

    void new ImportInitializeCommand(context.data.chapters as never[]).execute({
      step: {},
      context,
      callbacks,
    }).then(
      () => { settled = true },
      error => {
        settled = true
        failure = error
      },
    )

    await vi.advanceTimersByTimeAsync(5_000)

    expect(settled).toBe(true)
    expect(failure).toBeUndefined()
    expect(refreshFileTree).toHaveBeenCalledOnce()
    expect(context.data.finalizedDraftImportReceipt).toEqual(receipt)
    expect(context.data.chapters).toEqual(createContext().data.chapters)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('文件树刷新'))
  })

  it('continues after a rejected derived file-tree refresh while preserving the finalized import receipt', async () => {
    const context = createContext()
    const receipt = finalizedReceipt(context)
    stubIpcInvoke((channel) => {
      if (channel === 'db:draft-import-finalized-batch') return { success: true, receipt }
      if (channel === 'kb:import-text') return { success: true }
      throw new Error(`unexpected IPC ${channel}`)
    })
    const refreshFileTree = vi.fn(() => Promise.reject(new Error('refresh failed')))
    useProjectStore.setState({ refreshFileTree })

    await expect(new ImportInitializeCommand(context.data.chapters as never[]).execute({
      step: {},
      context,
      callbacks,
    })).resolves.toBeUndefined()

    expect(refreshFileTree).toHaveBeenCalledOnce()
    expect(context.data.finalizedDraftImportReceipt).toEqual(receipt)
    expect(context.data.chapters).toEqual(createContext().data.chapters)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('文件树刷新'))
  })

  it('fails closed on a malformed batch receipt before any knowledge-base write', async () => {
    const context = createContext()
    const receipt = finalizedReceipt(context)
    receipt.chapterNumbers = []
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'db:draft-import-finalized-batch') {
        return { success: true, receipt }
      }
      throw new Error(`unexpected IPC ${channel}`)
    })

    await expect(new ImportInitializeCommand(context.data.chapters as never[]).execute({
      step: {},
      context,
      callbacks,
    })).rejects.toThrow(/收据/)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('kb:import-text')
    expect(context.data.finalizedDraftImportReceipt).toBeUndefined()
  })
})

describe('InferBlueprintsPerChapterCommand', () => {
  it('performs zero per-chapter writes and throws when the one range commit fails', async () => {
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'db:blueprint-commit-range') return { success: false, error: 'DB 写入失败' }
      return { success: true }
    })
    useLLMStore.setState({
      defaultModelId: 'model-a',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(JSON.stringify({
          blueprints: [{
            chapterNumber: 1,
            title: '启程',
            role: '建置',
            purpose: '引出主角目标',
            keyEvents: '主角发现异常',
            characters: ['主角'],
            relationshipHints: [],
            suspenseHook: '门外有人',
          }],
        }), undefined, 'stop')
        return 'import-blueprint-request'
      }),
    })
    const command = new InferBlueprintsPerChapterCommand()

    await expect(command.execute({ step: {}, context: createContext(), callbacks })).rejects.toThrow(/DB 写入失败/)
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-upsert')
  })

  it('fails closed with a stable relationship diagnostic when relation is missing', async () => {
    const invoke = stubIpcInvoke((channel) => {
      throw new Error(`unexpected mutation ${channel}`)
    })
    const generateStream = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(
      async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(JSON.stringify({
          blueprints: [{
            chapterNumber: 1,
            title: '启程',
            role: '建置',
            purpose: '引出主角目标',
            keyEvents: '主角发现异常',
            characters: ['主角', '故人'],
            relationships: [{ from: '主角', to: '故人' }],
            suspenseHook: '门外有人',
          }],
        }), undefined, 'stop')
        return 'import-blueprint-request'
      },
    )
    useLLMStore.setState({ defaultModelId: 'model-a', generateStream })

    await expect(new InferBlueprintsPerChapterCommand().execute({
      step: {},
      context: createContext(),
      callbacks,
    })).rejects.toThrow(
      'code=missing_field path=blueprints[0].relationships[0].relation field=relation',
    )

    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })

  it('records the atomic commit receipt and completes its durable character-sync operation before success', async () => {
    const workflowContext = createContext()
    const snapshot = [{
      chapterNumber: 1,
      title: '启程',
      role: '建置',
      purpose: '引出主角目标',
      keyEvents: '主角发现异常',
      characters: ['主角'],
      relationshipHints: [],
      suspenseHook: '门外有人',
      userGuidance: '',
      notes: '',
      notesUpdatedAt: '',
    }]
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'db:blueprint-commit-range') {
        return {
          success: true,
          receipt: {
            mode: 'replace-range',
            operationId: 'import-commit',
            payloadHash: 'payload',
            idempotent: false,
            startChapter: 1,
            endChapter: 1,
            chapterNumbers: [1],
            snapshot,
            characterSyncInput: snapshot,
            characterSyncOperation: {
              operationId: 'import-sync',
              blueprintCommitOperationId: 'import-commit',
              blueprintCommitPayloadHash: 'payload',
              status: 'pending',
              startChapter: 1,
              endChapter: 1,
              characterSyncInput: snapshot,
              createdAt: '2026-01-01',
              updatedAt: '2026-01-01',
            },
          },
        }
      }
      if (channel === 'db:blueprint-character-sync-get') {
        return {
          operationId: 'import-sync',
          status: 'pending',
          characterSyncInput: snapshot,
        }
      }
      if (channel === 'db:character-roster-read') {
        return {
          status: 'ready',
          revision: 1,
          entries: [{ name: '主角' }],
        }
      }
      if (channel === 'db:blueprint-character-sync-complete') {
        return {
          success: true,
          operation: {
            status: 'completed',
            completionReceipt: {
              blueprintCommitOperationId: 'import-commit',
              operationId: 'import-sync',
              status: 'committed',
            },
          },
        }
      }
      throw new Error(`unexpected ${channel}`)
    })
    let generationPrompt = ''
    useLLMStore.setState({
      defaultModelId: 'model-a',
      generateStream: vi.fn(async (
        messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
        streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
      ) => {
        generationPrompt = messages.map(message => message.content).join('\n')
        streamCallbacks.onDone?.(JSON.stringify({
          blueprints: [{
            chapterNumber: 1,
            title: '启程',
            role: '建置',
            purpose: '引出主角目标',
            keyEvents: '主角发现异常',
            characters: ['主角'],
            relationships: [],
            suspenseHook: '门外有人',
          }],
        }), undefined, 'stop')
        return 'import-blueprint-request'
      }),
    })

    await new InferBlueprintsPerChapterCommand().execute({
      step: {},
      context: workflowContext,
      callbacks,
    })

    expect(workflowContext.data.blueprintCommitReceipt).toMatchObject({ operationId: 'import-commit' })
    expect(workflowContext.data.blueprintCharacterSyncReceipt).toMatchObject({ operationId: 'import-sync' })
    expect(generationPrompt).toContain('relationships 必须是数组')
    expect(generationPrompt).toContain('每项必须含非空 from、to、relation')
    expect(generationPrompt).not.toContain('relationshipHints（无关系时为空数组）')
    expect(invoke.mock.calls.map(([channel]) => channel)).toContain('db:blueprint-character-sync-complete')
  })
})

describe('InferGlobalSettingsCommand', () => {
  it('repairs one direct malformed JSON response on the same lease before writing', async () => {
    const invoke = successfulInferenceIpc()
    const valid = JSON.stringify(validInference())
    const malformed = `${valid.slice(0, -1)},}`
    const generateStream = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(
      async (_messages, streamCallbacks, _modelId, options) => {
        expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
          'kb:search', 'kb:search', 'kb:search', 'kb:search',
        ])
        streamCallbacks.onDone?.(generateStream.mock.calls.length === 1 ? malformed : valid, undefined, 'stop')
        return String(options?.modelExecutionLeaseId)
      },
    )
    useLLMStore.setState({ defaultModelId: 'model-a', generateStream })

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(generateStream.mock.calls[0][3]?.modelExecutionLeaseId)
      .toBe(generateStream.mock.calls[1][3]?.modelExecutionLeaseId)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:import-global-facts-commit')).toHaveLength(1)
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('project:save')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:project-core-update')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:character-roster-commit')
  })

  it('does not repair parseable semantic omissions and performs zero writes', async () => {
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'kb:search') return []
      throw new Error(`unexpected mutation ${channel}`)
    })
    const valid = validInference()
    const architectureFiles: Record<string, string> = { ...valid.architectureFiles }
    Reflect.deleteProperty(architectureFiles, 'synopsis')
    const invalid = { ...valid, architectureFiles }
    const generateStream = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(
      async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(JSON.stringify(invalid), undefined, 'stop')
        return 'request'
      },
    )
    useLLMStore.setState({ defaultModelId: 'model-a', generateStream })

    await expect(new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks }))
      .rejects.toThrow('code=missing_field path=architectureFiles.synopsis')
    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'kb:search', 'kb:search', 'kb:search', 'kb:search',
    ])
  })

  it('fails closed when the replacement is incomplete', async () => {
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'kb:search') return []
      throw new Error(`unexpected mutation ${channel}`)
    })
    const valid = JSON.stringify(validInference())
    const generateStream = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(
      async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(generateStream.mock.calls.length === 1 ? `${valid.slice(0, -1)},}` : valid, undefined,
          generateStream.mock.calls.length === 1 ? 'stop' : 'length')
        return 'request'
      },
    )
    useLLMStore.setState({ defaultModelId: 'model-a', generateStream })

    await expect(new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks }))
      .rejects.toThrow(/最大长度/)
    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'kb:search', 'kb:search', 'kb:search', 'kb:search',
    ])
  })

  it('accepts a valid response in one call', async () => {
    successfulInferenceIpc()
    const generateStream = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(
      async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(JSON.stringify(validInference()), undefined, 'stop')
        return 'request'
      },
    )
    useLLMStore.setState({ defaultModelId: 'model-a', generateStream })
    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })
    expect(generateStream).toHaveBeenCalledOnce()
  })

  it('rejects inferred free-text relationships before any roster commit', async () => {
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'kb:search') return []
      throw new Error(`unexpected IPC ${channel}`)
    })
    const invalid = validInference()
    invalid.characterCards[0].relationships = '与旧友苏绾保持复杂关系' as never
    useLLMStore.setState({
      defaultModelId: 'model-a',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(JSON.stringify(invalid), undefined, 'stop')
        return 'request'
      }),
    })

    await expect(new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks }))
      .rejects.toThrow('code=invalid_type path=characterCards[0].relationships')

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'kb:search',
      'kb:search',
      'kb:search',
      'kb:search',
    ])
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:character-roster-commit')
  })

  it('commits structurally complete inferred relationships through the atomic global-facts seam', async () => {
    const invoke = stubIpcInvoke((channel, request) => {
      if (channel === 'kb:search') return []
      if (channel === 'db:character-roster-read') return { status: 'ready', revision: 7, entries: [] }
      if (channel === 'db:import-global-facts-commit') {
        const candidate = request as { operationId: string; core: object; characterEntries: unknown[] }
        return {
          success: true,
          receipt: {
            operationId: candidate.operationId,
            payloadHash: 'f'.repeat(64),
            idempotent: false,
            core: candidate.core,
            roster: { snapshot: { status: 'ready', entries: candidate.characterEntries } },
          },
        }
      }
      throw new Error(`unexpected IPC ${channel}`)
    })
    const valid = validInference()
    ;(valid.characterCards[0].relationships as Array<{ target: string; relation: string }>).push({
      target: '苏绾',
      relation: '旧友',
    })
    useLLMStore.setState({
      defaultModelId: 'model-a',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(JSON.stringify(valid), undefined, 'stop')
        return 'request'
      }),
    })

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(invoke).toHaveBeenLastCalledWith(
      'db:import-global-facts-commit',
      expect.objectContaining({
        expectedRosterRevision: 7,
        characterEntries: expect.arrayContaining([
          expect.objectContaining({
            name: '陆舟',
            relationships: [{ target: '苏绾', relation: '旧友' }],
          }),
          expect.objectContaining({ name: '苏绾' }),
        ]),
      }),
      'C:\\tmp\\vela-import-test',
      expect.objectContaining({ projectId: 'project-1' }),
    )
  })

  it('stops and keeps renderer config unchanged when the atomic global-facts commit fails', async () => {
    stubIpcInvoke((channel) => {
      if (channel === 'kb:search') return []
      if (channel === 'db:character-roster-read') return { status: 'ready', revision: 7, entries: [] }
      if (channel === 'db:import-global-facts-commit') return { success: false, error: '全局事实事务失败' }
      throw new Error(`unexpected IPC ${channel}`)
    })
    useLLMStore.setState({
      defaultModelId: 'model-a',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(JSON.stringify(validInference()), undefined, 'stop')
        return 'request'
      }),
    })

    await expect(new InferGlobalSettingsCommand().execute({
      step: {},
      context: createContext(),
      callbacks,
    })).rejects.toThrow(/全局事实事务失败/)
    expect(useProjectStore.getState().currentProject?.novelConfig.genre).toBe('玄幻')
  })
})
