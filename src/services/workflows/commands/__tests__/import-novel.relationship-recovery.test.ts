import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { CharacterRosterEntry } from '../../../../shared/character-roster'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { InferGlobalSettingsCommand as RuntimeInferGlobalSettingsCommand } from '../import-novel.command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'

class InferGlobalSettingsCommand extends RuntimeInferGlobalSettingsCommand {
  constructor() { super(workflowRuntimeDependencies) }
}

const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId
const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
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

function card(name: string, role: CharacterRosterEntry['role']): CharacterRosterEntry {
  return {
    name,
    role,
    gender: '未知',
    age: '18',
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
  }
}

function validInference() {
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

function withMissingEndpoint(name = '韩烁') {
  const inference = validInference()
  inference.characterCards[0].relationships.push({ target: name, relation: '旧债牵连' })
  return inference
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

function stubSuccessfulImportIpc() {
  return stubIpcInvoke((channel, request) => {
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
}

function stubNoCommitIpc() {
  return stubIpcInvoke((channel) => {
    if (channel === 'kb:search') return []
    throw new Error(`unexpected IPC ${channel}`)
  })
}

function respondWith(responses: unknown[]) {
  const serialized = responses.map(response => typeof response === 'string' ? response : JSON.stringify(response))
  let callCount = 0
  const generateStream = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(
    async (_messages, streamCallbacks) => {
      const output = serialized[callCount]
      if (output === undefined) throw new Error('unexpected import inference request')
      callCount += 1
      streamCallbacks.onDone?.(output, undefined, 'stop')
      return `request-${callCount}`
    },
  )
  useLLMStore.setState({ defaultModelId: 'model-a', generateStream })
  return generateStream
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
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({
    defaultModelId: originalDefaultModelId,
    generateStream: originalGenerateStream,
  })
})

describe('InferGlobalSettingsCommand relationship endpoint recovery', () => {
  it('fails closed without correction when missing endpoint cards would exceed the eight-card contract', async () => {
    const invoke = stubNoCommitIpc()
    const initial = validInference()
    initial.characterCards = [
      card('陆舟', 'protagonist'),
      card('苏绾', 'supporting'),
      card('顾岩', 'antagonist'),
      card('林照', 'supporting'),
      card('白榆', 'supporting'),
      card('沈珩', 'minor'),
      card('周砚', 'minor'),
      card('秦若', 'minor'),
    ]
    initial.characterCards[0].relationships.push({ target: '韩烁', relation: '旧债牵连' })
    const generateStream = respondWith([initial])

    await expect(new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks }))
      .rejects.toThrow(/角色卡|8|补卡校正/)

    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:import-global-facts-commit')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:character-roster-read')
  })

  it('adds only missing endpoint cards through one bounded correction before the atomic global-facts commit', async () => {
    const invoke = stubSuccessfulImportIpc()
    const initial = withMissingEndpoint()
    const corrected = {
      ...initial,
      characterCards: [
        ...initial.characterCards,
        card('韩烁', 'supporting'),
      ],
    }
    const generateStream = respondWith([initial, corrected])

    await new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks })

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('受限补卡校正'))
    expect(invoke).toHaveBeenLastCalledWith(
      'db:import-global-facts-commit',
      expect.objectContaining({
        expectedRosterRevision: 7,
        characterEntries: [
          expect.objectContaining({
            name: '陆舟',
            relationships: [{ target: '韩烁', relation: '旧债牵连' }],
          }),
          expect.objectContaining({ name: '苏绾' }),
          expect.objectContaining({ name: '顾岩' }),
          expect.objectContaining({ name: '韩烁', relationships: [] }),
        ],
      }),
      'C:\\tmp\\vela-import-test',
      expect.objectContaining({ projectId: 'project-1' }),
    )
  })

  it('rejects a correction that changes any existing card relationship before commit', async () => {
    const invoke = stubNoCommitIpc()
    const initial = withMissingEndpoint()
    const corrected = {
      ...initial,
      characterCards: [
        {
          ...initial.characterCards[0],
          relationships: [{ target: '韩烁', relation: '改写关系' }],
        },
        initial.characterCards[1],
        initial.characterCards[2],
        card('韩烁', 'supporting'),
      ],
    }
    const generateStream = respondWith([initial, corrected])

    await expect(new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks }))
      .rejects.toThrow(/受限补卡校正|保留原有/)

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'kb:search', 'kb:search', 'kb:search', 'kb:search',
    ])
  })

  it('rejects a correction that adds arbitrary extra cards before commit', async () => {
    const invoke = stubNoCommitIpc()
    const initial = withMissingEndpoint()
    const corrected = {
      ...initial,
      characterCards: [
        ...initial.characterCards,
        card('韩烁', 'supporting'),
        card('任意新增', 'minor'),
      ],
    }
    const generateStream = respondWith([initial, corrected])

    await expect(new InferGlobalSettingsCommand().execute({ step: {}, context: createContext(), callbacks }))
      .rejects.toThrow(/受限补卡校正|新增角色/)

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'kb:search', 'kb:search', 'kb:search', 'kb:search',
    ])
  })
})
