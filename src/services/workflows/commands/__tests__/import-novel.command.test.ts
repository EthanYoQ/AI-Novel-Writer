import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
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
const originalLocale = useLocaleStore.getState().locale
const CJK_TEXT = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u

function stripExactPayloads(request: string, payloads: readonly string[]): string {
  return payloads.reduce(
    (copy, payload) => payload ? copy.replaceAll(payload, '<USER_OR_MODEL_PAYLOAD>') : copy,
    request,
  )
}

function createContext(): WorkflowContext {
  return {
    runId: 'test-run',
    projectPath: 'C:\\tmp\\vela-import-test',
    projectSession: {
      projectId: 'project-1',
      leaseId: 'lease-project-1',
      projectPath: 'C:\\tmp\\vela-import-test',
    },
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
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
  useLocaleStore.setState({ locale: 'zh-CN' })
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
  useLocaleStore.setState({ locale: originalLocale })
})

describe('ImportInitializeCommand', () => {
  it('logs the new reference-only import flow in English when the UI locale is English', async () => {
    const context = createContext()
    context.uiLocale = 'en-US'
    context.writingLanguage = 'en-US'
    useLocaleStore.setState({ locale: 'zh-CN' })
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'kb:import-text') {
        useLocaleStore.setState({ locale: 'zh-CN' })
        return { success: true }
      }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC ${channel}`)
    })

    await new ImportInitializeCommand(context.data.chapters as never[]).execute({
      step: {},
      context,
      callbacks,
    })

    expect(callbacks.log).toHaveBeenCalledWith('Importing 1 reference chapter into the knowledge base...')
    expect(callbacks.log).toHaveBeenCalledWith('Building the vector knowledge base...')
    expect(callbacks.log).toHaveBeenCalledWith('Knowledge base build complete (1 succeeded, 0 failed)')
    expect(invoke).toHaveBeenCalledWith(
      'kb:import-text',
      '主角在雨夜发现异常，并踏上旅程。',
      'Chapter 1 启程.txt',
      context.projectPath,
      context.projectSession,
    )
  })

  it('uses Chinese KB document names from writing language independently of English UI copy', async () => {
    const context = createContext()
    context.writingLanguage = 'zh-CN'
    context.uiLocale = 'en-US'
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'kb:import-text') return { success: true }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC ${channel}`)
    })

    await new ImportInitializeCommand(context.data.chapters as never[]).execute({
      step: {},
      context,
      callbacks,
    })

    expect(invoke).toHaveBeenCalledWith(
      'kb:import-text',
      '主角在雨夜发现异常，并踏上旅程。',
      '第1章 启程.txt',
      context.projectPath,
      context.projectSession,
    )
    expect(callbacks.log).toHaveBeenCalledWith('Building the vector knowledge base...')
  })

  it('treats imported chapters as reference material: it writes the knowledge base without creating drafts or finalized manuscript chapters', async () => {
    const context = createContext()
    const chapters = context.data.chapters as never[]
    Reflect.deleteProperty(context.data, 'chapters')
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'kb:import-text') return { success: true }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC ${channel}`)
    })

    await new ImportInitializeCommand(chapters).execute({
      step: {},
      context,
      callbacks,
    })

    const channels = invoke.mock.calls.map(([channel]) => channel)
    expect(channels).toContain('kb:import-text')
    expect(channels.filter(channel => channel === 'kb:import-text')).toHaveLength(chapters.length)
    expect(channels.some(channel => String(channel).startsWith('db:draft-'))).toBe(false)
    expect(channels).not.toContain('db:draft-create')
    expect(channels).not.toContain('db:draft-update-status')
    expect(channels).not.toContain('db:draft-import-finalized-batch')
    expect(channels.some(channel => String(channel).startsWith('manuscript:'))).toBe(false)
    expect(context.data.chapters).toEqual(chapters)
    expect(context.data.finalizedDraftImportReceipt).toBeUndefined()
  })

  it('continues after a pending derived file-tree refresh while preserving imported reference chapters', async () => {
    vi.useFakeTimers()
    const context = createContext()
    stubIpcInvoke((channel) => {
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
    expect(context.data.chapters).toEqual(createContext().data.chapters)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('文件树刷新'))
  })

  it('continues after a rejected derived file-tree refresh while preserving imported reference chapters', async () => {
    const context = createContext()
    stubIpcInvoke((channel) => {
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
    expect(context.data.chapters).toEqual(createContext().data.chapters)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('文件树刷新'))
  })

  it('keeps the imported reference context when a knowledge-base chapter fails without creating a draft', async () => {
    const context = createContext()
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'kb:import-text') return { success: false, error: '向量服务不可用' }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC ${channel}`)
    })

    await expect(new ImportInitializeCommand(context.data.chapters as never[]).execute({
      step: {},
      context,
      callbacks,
    })).resolves.toBeUndefined()

    expect(invoke.mock.calls.map(([channel]) => channel)).toContain('kb:import-text')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:draft-import-finalized-batch')
    expect(context.data.finalizedDraftImportReceipt).toBeUndefined()
    expect(context.data.chapters).toEqual(createContext().data.chapters)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('部分参照文本未能进入知识库'))
  })
})

describe('InferBlueprintsPerChapterCommand', () => {
  it('keeps imported UTF-8 intact in English blueprint inference and its syntax-repair request', async () => {
    const importedText = 'At “夜航 Café”, Mara sees 招牌写着“回家” and hears déjà vu in the rain.'
    const valid = JSON.stringify({
      blueprints: [{
        chapterNumber: 1,
        title: 'Night Café 夜航',
        role: 'setup',
        purpose: 'Trace the repeated signal.',
        keyEvents: 'Mara enters “夜航 Café” and hears the same warning twice.',
        characters: ['Mara'],
        relationships: [],
        suspenseHook: 'The clock resets to midnight.',
      }],
    })
    const malformed = `${valid.slice(0, -1)},}`
    const observed: Array<Array<{ role: string; content: string }>> = []
    stubIpcInvoke((channel) => {
      if (channel === 'db:blueprint-commit-range') return { success: false, error: 'captured after repair' }
      throw new Error(`unexpected IPC ${channel}`)
    })
    useProjectStore.setState(state => ({
      currentProject: state.currentProject
        ? {
            ...state.currentProject,
            novelConfig: { ...state.currentProject.novelConfig, writingLanguage: 'en-US' },
          }
        : null,
    }))
    useLLMStore.setState({
      defaultModelId: 'model-a',
      generateStream: vi.fn(async (messages, streamCallbacks) => {
        observed.push(messages)
        streamCallbacks.onDone?.(observed.length === 1 ? malformed : valid, undefined, 'stop')
        return `import-blueprint-language-${observed.length}`
      }),
    })
    const context = createContext()
    context.writingLanguage = 'en-US'
    context.uiLocale = 'en-US'
    const configSummary = 'A time-loop mystery at “夜航 Café”.'
    context.data.novelConfigSummary = configSummary
    context.data.chapters = [{
      number: 1,
      title: 'Night Café 夜航',
      content: importedText,
      wordCount: importedText.length,
    }]

    await expect(new InferBlueprintsPerChapterCommand().execute({
      step: {},
      context,
      callbacks,
    })).rejects.toThrow('captured after repair')

    expect(observed).toHaveLength(2)
    expect(observed[0]?.[0]?.content).toContain('professional fiction-structure analyst')
    expect(observed[0]?.[1]?.content).toContain(importedText)
    expect(observed[0]?.map(message => message.content).join('\n')).not.toContain('【最终不可变输出合同】')
    expect(observed[1]?.[0]?.content).toContain('You repair JSON syntax only')
    expect(observed[1]?.[1]?.content).toContain('Malformed candidate')
    expect(observed[1]?.[1]?.content).toContain('Night Café 夜航')
    const initialBuiltIn = stripExactPayloads(
      observed[0]?.map(message => message.content).join('\n') ?? '',
      [importedText, 'Night Café 夜航', configSummary],
    )
    const repairBuiltIn = stripExactPayloads(
      observed[1]?.map(message => message.content).join('\n') ?? '',
      [malformed, importedText, 'Night Café 夜航', configSummary],
    )
    expect(initialBuiltIn).not.toMatch(CJK_TEXT)
    expect(repairBuiltIn).not.toMatch(CJK_TEXT)
    expect(callbacks.log).toHaveBeenCalledWith('Inferring blueprints in batches (1 chapter; at most 1 model call)...')
    expect(callbacks.log).toHaveBeenCalledWith('  Inferring Chapters 1–1...')
  })

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
  it('uses the frozen English writing language for inference and syntax repair without rewriting imported UTF-8', async () => {
    const invoke = successfulInferenceIpc()
    const importedText = 'The sign reads “夜航 Café” — déjà vu.'
    const inferred = validInference()
    inferred.novelConfig.coreOutline = 'Preserve “夜航 Café” exactly.'
    const valid = JSON.stringify(inferred)
    const malformed = `${valid.slice(0, -1)},}`
    const observed: Array<Array<{ role: string; content: string }>> = []
    const generateStream = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(
      async (messages, streamCallbacks) => {
        observed.push(messages)
        streamCallbacks.onDone?.(observed.length === 1 ? malformed : valid, undefined, 'stop')
        return `import-language-${observed.length}`
      },
    )
    useProjectStore.setState(state => ({
      currentProject: state.currentProject
        ? {
            ...state.currentProject,
            novelConfig: { ...state.currentProject.novelConfig, writingLanguage: 'en-US' },
          }
        : null,
    }))
    useLLMStore.setState({ defaultModelId: 'model-a', generateStream })
    const context = createContext()
    context.writingLanguage = 'en-US'
    context.uiLocale = 'en-US'
    context.data.chapters = [{
      number: 1,
      title: 'Night Café 夜航',
      content: importedText,
      wordCount: importedText.length,
    }]

    await new InferGlobalSettingsCommand().execute({ step: {}, context, callbacks })

    expect(observed).toHaveLength(2)
    expect(observed[0]?.[0]?.content).toContain('senior fiction editor')
    expect(observed[0]?.[1]?.content).toContain(importedText)
    expect(observed[0]?.map(message => message.content).join('\n')).not.toContain('【小说全文采样】')
    expect(observed[1]?.[0]?.content).toContain('You repair JSON syntax only')
    expect(observed[1]?.[1]?.content).toContain('Malformed candidate')
    expect(observed[1]?.[1]?.content).toContain('Preserve “夜航 Café” exactly.')
    expect(context.data.novelConfigSummary).toBe(
      `Genre: ${inferred.novelConfig.genre} | Subgenre: ${inferred.novelConfig.subGenre} | Audience: ${inferred.novelConfig.targetAudience}\n`
      + `Outline: ${inferred.novelConfig.coreOutline}\n`
      + `World: ${inferred.novelConfig.worldSetting}\n`
      + `Central advantage: ${inferred.novelConfig.goldenFinger}\n`
      + `Protagonist: ${inferred.novelConfig.protagonistProfile}`,
    )
    const initialBuiltIn = stripExactPayloads(
      observed[0]?.map(message => message.content).join('\n') ?? '',
      [importedText],
    )
    const repairBuiltIn = stripExactPayloads(
      observed[1]?.map(message => message.content).join('\n') ?? '',
      [malformed],
    )
    expect(initialBuiltIn).not.toMatch(CJK_TEXT)
    expect(repairBuiltIn).not.toMatch(CJK_TEXT)
    expect(callbacks.log).toHaveBeenCalledWith('Retrieving key passages from the vector knowledge base...')
    expect(callbacks.log).toHaveBeenCalledWith('Running AI inference for the global novel configuration...')
    expect(callbacks.log).toHaveBeenCalledWith(
      `The novel configuration, non-character architecture, and ${inferred.characterCards.length} character cards were committed atomically`,
    )
    const commitCalls = invoke.mock.calls.filter(([channel]) => channel === 'db:import-global-facts-commit')
    expect(commitCalls).toHaveLength(1)
    const committedCore = (commitCalls[0]?.[1] as { core: { coreOutline: string } }).core
    expect(committedCore.coreOutline).toBe(inferred.novelConfig.coreOutline)
    expect(new TextEncoder().encode(committedCore.coreOutline))
      .toEqual(new TextEncoder().encode(inferred.novelConfig.coreOutline))
  })

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
