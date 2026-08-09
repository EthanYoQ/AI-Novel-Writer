import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import type { CharacterRosterEntry, CharacterRosterSnapshot } from '../../../shared/character-roster'
import { repairArchCharacterCards } from '../architecture-workflow'

const projectPath = 'C:\\novels\\legacy-roster'
const projectSession = {
  projectId: 'legacy-project',
  leaseId: 'legacy-lease',
  projectPath,
}

const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId

const repairedEntries: CharacterRosterEntry[] = [
  {
    name: '沈砺',
    role: 'protagonist',
    gender: '男',
    age: '二十六岁',
    appearance: '左手缺一截食指，常穿旧工装',
    personality: '克制而执拗',
    background: '矿场事故幸存者',
    abilities: '机械维修',
    motivation: '查清矿场事故真相',
    relationships: [{ target: '顾湘', relation: '互相试探的盟友' }],
    arc: '从独自复仇到相信同伴',
    notes: '旧图谱未使用可解析标题',
  },
  {
    name: '顾湘',
    role: 'supporting',
    gender: '女',
    age: '二十七岁',
    appearance: '戴银框护目镜',
    personality: '冷静敏锐',
    background: '矿区检修员',
    abilities: '数据解密',
    motivation: '保护失踪的弟弟',
    relationships: [{ target: '沈砺', relation: '互相试探的盟友' }],
    arc: '从旁观者变为行动者',
    notes: '',
  },
]

const pendingLegacyRoster: CharacterRosterSnapshot = {
  schemaVersion: 1,
  revision: 0,
  migrationState: 'legacy_markdown_pending',
  status: 'legacy_repair_required',
  entries: [],
  renderedMarkdown: '',
  projectionHash: '',
  factHash: '',
  legacyMarkdown: '矿场事故后，沈砺与顾湘从互相怀疑走向共同调查。这里故意没有 Markdown 标题或角色列表。',
}

const readyRoster: CharacterRosterSnapshot = {
  schemaVersion: 1,
  revision: 1,
  migrationState: 'ready',
  status: 'ready',
  entries: repairedEntries,
  renderedMarkdown: '# 角色图谱\n\n## 主角：沈砺\n\n## 配角：顾湘',
  projectionHash: 'projection-hash',
  factHash: 'fact-hash',
  legacyMarkdown: pendingLegacyRoster.legacyMarkdown,
}

function activeProject() {
  return {
    id: projectSession.projectId,
    sessionLease: projectSession.leaseId,
    name: '旧项目',
    path: projectPath,
    novelConfig: { genre: '科幻' },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function installVela(invoke: ReturnType<typeof vi.fn>) {
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
}

beforeEach(() => {
  vi.clearAllMocks()
  useProjectStore.setState({ currentProject: activeProject() as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [] })
  useLLMStore.setState({ defaultModelId: 'legacy-repair-model' })
})

afterEach(() => {
  useProjectStore.setState({ currentProject: null })
  useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [] })
  useLLMStore.setState({
    defaultModelId: originalDefaultModelId,
    generateStream: originalGenerateStream,
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('legacy character roster repair public workflow seam', () => {
  it('repairs a zero-card legacy graph through one structured roster commit without parsing Markdown headings', async () => {
    const modelResponse = JSON.stringify({ schemaVersion: 1, entries: repairedEntries })
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      callbacks.onChunk?.(modelResponse)
      callbacks.onDone?.(modelResponse, undefined, 'stop')
      return Promise.resolve('legacy-repair-request')
    })
    useLLMStore.setState({ generateStream })

    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'db:character-roster-read':
          return pendingLegacyRoster
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: expect.any(String),
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
    installVela(invoke)

    await repairArchCharacterCards(projectPath)

    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        expectedRevision: 0,
        schemaVersion: 1,
        entries: repairedEntries,
        intent: 'legacy_repair',
      }),
      projectPath,
      projectSession,
    )
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:character-save-all')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:project-core-update')
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      type: 'post_process',
      status: 'completed',
      steps: [expect.objectContaining({ status: 'completed' })],
    })
  })

  it('allows exactly one low-temperature JSON syntax repair, then commits through the same roster seam', async () => {
    const malformed = '{"schemaVersion":1,"entries":['
    const repaired = JSON.stringify({ schemaVersion: 1, entries: repairedEntries })
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      const output = generateStream.mock.calls.length === 1 ? malformed : repaired
      callbacks.onDone?.(output, undefined, 'stop')
      return Promise.resolve(`legacy-json-${generateStream.mock.calls.length}`)
    })
    useLLMStore.setState({ generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:character-roster-read') return pendingLegacyRoster
      if (channel === 'db:character-roster-commit') {
        return {
          success: true,
          receipt: { operationId: 'repair-json', payloadHash: 'hash', revision: 1, idempotent: false, snapshot: readyRoster },
        }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    installVela(invoke)

    await repairArchCharacterCards(projectPath)

    expect(generateStream).toHaveBeenCalledTimes(2)
    const repairOptions = (generateStream.mock.calls as unknown as unknown[][])[1]?.[3]
    expect(repairOptions).toMatchObject({
      temperature: 0.1,
      purpose: 'legacy-character-roster-json-repair',
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'db:character-roster-read',
      'db:character-roster-read',
      'db:character-roster-commit',
    ])
  })

  it('does not parse, repair or commit a truncated legacy repair response', async () => {
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      callbacks.onDone?.('{"schemaVersion":1,"entries":[', undefined, 'length')
      return Promise.resolve('legacy-truncated')
    })
    useLLMStore.setState({ generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:character-roster-read') return pendingLegacyRoster
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    installVela(invoke)

    await expect(repairArchCharacterCards(projectPath)).rejects.toThrow('AI 输出达到模型最大长度')
    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['db:character-roster-read'])
  })

  it('adopts protected existing cards without a model call, then rebuilds only the read-only projection', async () => {
    const existingCards: CharacterRosterSnapshot = {
      ...pendingLegacyRoster,
      migrationState: 'legacy_cards_preserved',
      status: 'inconsistent',
      entries: repairedEntries,
    }
    const adoptedRoster: CharacterRosterSnapshot = {
      ...readyRoster,
      legacyMarkdown: existingCards.legacyMarkdown,
    }
    const generateStream = vi.fn()
    useLLMStore.setState({ generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:character-roster-read') return existingCards
      if (channel === 'db:character-roster-commit') {
        return {
          success: true,
          receipt: { operationId: 'adopt-cards', payloadHash: 'hash', revision: 1, idempotent: false, snapshot: adoptedRoster },
        }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    installVela(invoke)

    await repairArchCharacterCards(projectPath)

    expect(generateStream).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({ intent: 'legacy_cards_adoption', entries: repairedEntries }),
      projectPath,
      projectSession,
    )
  })

  it('does not commit a completed candidate when the frozen project session changes', async () => {
    const response = JSON.stringify({ schemaVersion: 1, entries: repairedEntries })
    let finishGeneration: (() => void) | undefined
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      finishGeneration = () => callbacks.onDone?.(response, undefined, 'stop')
      return Promise.resolve('legacy-switch')
    })
    useLLMStore.setState({ generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:character-roster-read') return pendingLegacyRoster
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    installVela(invoke)

    const execution = repairArchCharacterCards(projectPath)
    await vi.waitFor(() => expect(generateStream).toHaveBeenCalledOnce())
    useProjectStore.setState({
      currentProject: {
        ...activeProject(),
        path: 'C:\\novels\\other-project',
        sessionLease: 'other-lease',
      } as never,
    })
    finishGeneration?.()

    await expect(execution).rejects.toThrow('当前项目已切换，旧角色图谱修复已停止以避免写入错误项目')
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['db:character-roster-read'])
  })

  it('does not commit when cancellation reaches the repair before its atomic boundary', async () => {
    let finishGeneration: (() => void) | undefined
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      finishGeneration = () => callbacks.onDone?.(JSON.stringify({ schemaVersion: 1, entries: repairedEntries }), undefined, 'stop')
      return Promise.resolve('legacy-cancel')
    })
    useLLMStore.setState({ generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:character-roster-read') return pendingLegacyRoster
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    installVela(invoke)

    const execution = repairArchCharacterCards(projectPath)
    await vi.waitFor(() => expect(generateStream).toHaveBeenCalledOnce())
    const runId = useWorkflowStore.getState().activeRuns[0]?.id
    expect(runId).toBeTruthy()
    useWorkflowStore.getState().cancelWorkflow(runId)
    finishGeneration?.()

    await expect(execution).rejects.toThrow('工作流已取消')
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['db:character-roster-read'])
  })

  it('leaves semantic validation to the atomic seam and never falls back to Markdown parsing', async () => {
    const generateStream = vi.fn((
      _messages: Parameters<typeof originalGenerateStream>[0],
      callbacks: Parameters<typeof originalGenerateStream>[1],
    ) => {
      callbacks.onDone?.('{"schemaVersion":1,"entries":[]}', undefined, 'stop')
      return Promise.resolve('legacy-semantic-invalid')
    })
    useLLMStore.setState({ generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:character-roster-read') return pendingLegacyRoster
      if (channel === 'db:character-roster-commit') return { success: false, error: '角色名单不能为空' }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    installVela(invoke)

    await expect(repairArchCharacterCards(projectPath)).rejects.toThrow('角色名单不能为空')
    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'db:character-roster-read',
      'db:character-roster-read',
      'db:character-roster-commit',
    ])
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:character-save-all')
  })
})
