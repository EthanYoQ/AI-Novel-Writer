import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { useLLMStore } from '../../../../stores/llm-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
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
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({
    defaultModelId: originalDefaultModelId,
    generateStream: originalGenerateStream,
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

    await new InferBlueprintsPerChapterCommand().execute({
      step: {},
      context: workflowContext,
      callbacks,
    })

    expect(workflowContext.data.blueprintCommitReceipt).toMatchObject({ operationId: 'import-commit' })
    expect(workflowContext.data.blueprintCharacterSyncReceipt).toMatchObject({ operationId: 'import-sync' })
    expect(invoke.mock.calls.map(([channel]) => channel)).toContain('db:blueprint-character-sync-complete')
  })
})

describe('InferGlobalSettingsCommand', () => {
  it('rejects inferred free-text relationships before any roster commit', async () => {
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'kb:search') return []
      throw new Error(`unexpected IPC ${channel}`)
    })
    const command = new InferGlobalSettingsCommand()
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM')
      .mockResolvedValue(JSON.stringify({
        characterCards: [{
          name: '陆舟',
          role: '主角',
          relationships: '与旧友苏绾保持复杂关系',
        }],
      }))

    await expect(command.execute({ step: {}, context: createContext(), callbacks }))
      .rejects.toThrow('导入角色卡包含无法验证的自由文本关系')

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'kb:search',
      'kb:search',
      'kb:search',
      'kb:search',
    ])
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:character-roster-commit')
  })

  it('commits structurally complete inferred relationships through the roster seam', async () => {
    const invoke = stubIpcInvoke((channel) => {
      if (channel === 'kb:search') return []
      if (channel === 'db:character-roster-read') return { status: 'ready', revision: 7, entries: [] }
      if (channel === 'db:character-roster-commit') return { success: true, receipt: { revision: 8 } }
      throw new Error(`unexpected IPC ${channel}`)
    })
    const command = new InferGlobalSettingsCommand()
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM')
      .mockResolvedValue(JSON.stringify({
        characterCards: [
          { name: '陆舟', role: '主角', relationships: { 苏绾: '旧友' } },
          { name: '苏绾', role: '配角' },
        ],
      }))

    await command.execute({ step: {}, context: createContext(), callbacks })

    expect(invoke).toHaveBeenLastCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        intent: 'novel_import',
        expectedRevision: 7,
        entries: [
          expect.objectContaining({
            name: '陆舟',
            relationships: [{ target: '苏绾', relation: '旧友' }],
          }),
          expect.objectContaining({ name: '苏绾' }),
        ],
      }),
      'C:\\tmp\\vela-import-test',
      expect.objectContaining({ projectId: 'project-1' }),
    )
  })

  it('stops and keeps renderer config unchanged when project:save reports failure', async () => {
    stubIpcInvoke((channel) => {
      if (channel === 'kb:search') return []
      if (channel === 'project:save') return { success: false, error: '配置文件写入失败' }
      throw new Error(`unexpected IPC ${channel}`)
    })
    const command = new InferGlobalSettingsCommand()
    vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM')
      .mockResolvedValue('{"novelConfig":{"genre":"都市"}}')

    await expect(command.execute({
      step: {},
      context: createContext(),
      callbacks,
    })).rejects.toThrow(/配置文件写入失败/)
    expect(useProjectStore.getState().currentProject?.novelConfig.genre).toBe('玄幻')
  })
})
