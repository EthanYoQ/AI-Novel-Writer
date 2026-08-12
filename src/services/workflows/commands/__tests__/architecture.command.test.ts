import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import type { CharacterRosterEntry, CharacterRosterSnapshot } from '../../../../shared/character-roster'
import {
  GenerateCharactersCommand as RuntimeGenerateCharactersCommand,
  GenerateConfigCommand as RuntimeGenerateConfigCommand,
} from '../architecture.command'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'

class GenerateConfigCommand extends RuntimeGenerateConfigCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeGenerateConfigCommand>) {
    super(args[0], args[1], args[2], args[3], workflowRuntimeDependencies)
  }
}

class GenerateCharactersCommand extends RuntimeGenerateCharactersCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeGenerateCharactersCommand>) {
    super(args[0], workflowRuntimeDependencies)
  }
}

const projectAPath = 'C:\\novels\\A'
const projectBPath = 'C:\\novels\\B'
const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId
const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

const rosterEntries: CharacterRosterEntry[] = [
  {
    name: '林舟',
    role: 'protagonist',
    gender: '男',
    age: '十八岁',
    appearance: '灰袍少年',
    personality: '克制',
    background: '铁砧镇学徒',
    abilities: '锻造',
    motivation: '守住家人',
    relationships: [{ target: '苏绾', relation: '师徒' }],
    arc: '从学徒成长为守护者',
    notes: '',
  },
  {
    name: '苏绾',
    role: 'supporting',
    gender: '女',
    age: '二十六岁',
    appearance: '青衣剑客',
    personality: '冷静',
    background: '游侠',
    abilities: '剑术',
    motivation: '偿还旧债',
    relationships: [{ target: '林舟', relation: '师徒' }],
    arc: '学会托付',
    notes: '',
  },
]

const readyRoster: CharacterRosterSnapshot = {
  schemaVersion: 1,
  revision: 1,
  migrationState: 'ready',
  status: 'ready',
  entries: rosterEntries,
  renderedMarkdown: '# 角色图谱\n\n## 主角：林舟\n\n## 配角：苏绾',
  projectionHash: 'projection-hash',
  factHash: 'fact-hash',
}
const context: WorkflowContext = {
  runId: 'architecture-config-run',
  projectPath: projectAPath,
  projectSession: { projectId: 'main', leaseId: 'lease-main', projectPath: projectAPath },
  data: {},
  cancelled: false,
}

function project(path: string) {
  return {
    id: 'main',
    name: path,
    path,
    sessionLease: `lease-${path === projectAPath ? 'main' : 'other'}`,
    novelConfig: {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    velaAPI: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
        if (channel === 'fs:check-exists') return false
        throw new Error(`Unexpected IPC channel: ${channel}`)
      }),
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  useProjectStore.setState({
    currentProject: project(projectAPath) as never,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useLLMStore.setState({
    defaultModelId: originalDefaultModelId,
    generateStream: originalGenerateStream,
  })
  useProjectStore.setState({ currentProject: null })
})

describe('GenerateConfigCommand error boundaries', () => {
  it('preserves the project-switch error instead of reporting it as invalid JSON', async () => {
    let resolveLlm: ((value: string) => void) | undefined
    const command = new GenerateConfigCommand('idea', 100, 3000, vi.fn())
    vi.spyOn(
      command as unknown as { callLLMWithBuilder: () => Promise<string> },
      'callLLMWithBuilder',
    ).mockImplementation(() => new Promise<string>((resolve) => { resolveLlm = resolve }))

    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(resolveLlm).toBeTypeOf('function'))
    useProjectStore.setState({ currentProject: project(projectBPath) as never })
    resolveLlm!('{"genre":"玄幻"}')

    await expect(execution).rejects.toThrow('当前项目已切换，智能配置结果未应用')
  })

  it('preserves save errors after valid JSON parsing', async () => {
    const command = new GenerateConfigCommand('idea', 100, 3000, vi.fn())
    vi.spyOn(
      command as unknown as { callLLMWithBuilder: () => Promise<string> },
      'callLLMWithBuilder',
    ).mockResolvedValue('{"genre":"玄幻"}')
    useProjectStore.setState({
      saveProject: vi.fn().mockRejectedValue(new Error('磁盘写入失败')),
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('磁盘写入失败')
  })
})

describe('GenerateCharactersCommand structured roster seam', () => {
  it('reports character architecture success only after one direct structured response commits readable graph and cards', async () => {
    const modelResult = JSON.stringify({ schemaVersion: 1, entries: rosterEntries })
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      streamCallbacks.onChunk?.(modelResult)
      streamCallbacks.onDone?.(modelResult, undefined, 'stop')
      return Promise.resolve('character-request')
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })

    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并写入结构化角色事实，且不会因为前置条件长度不足而提前中止本次端到端工作流验证。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
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

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: {
        genre: '玄幻',
        totalChapters: 100,
        wordsPerChapter: 3000,
      } as never,
    })
    const result = await command.execute({ step: {}, context, callbacks })

    expect(result).toBe(readyRoster.renderedMarkdown)
    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        operationId: context.runId,
        expectedRevision: 0,
        schemaVersion: 1,
        entries: rosterEntries,
        intent: 'architecture_generation',
      }),
      projectAPath,
      context.projectSession,
    )
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:project-core-update')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:character-save-all')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:post-process-create-run')
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith('角色图谱与 2 张角色卡已生成')
  })

  it('does not issue checkpoint IPC after a readable roster receipt when cancellation has arrived', async () => {
    const modelResult = JSON.stringify({ schemaVersion: 1, entries: rosterEntries })
    const committedThenCancelledContext: WorkflowContext = {
      ...context,
      data: {},
      cancelled: false,
    }
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      streamCallbacks.onDone?.(modelResult, undefined, 'stop')
      return Promise.resolve('character-request')
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证原子角色名单提交后若收到取消请求，不会再调用任何检查点 IPC。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          committedThenCancelledContext.cancelled = true
          return {
            success: true,
            receipt: {
              operationId: committedThenCancelledContext.runId,
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

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context: committedThenCancelledContext, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'db:project-core-get',
      'db:character-roster-read',
      'db:character-roster-commit',
    ])
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith('角色图谱与 2 张角色卡已生成；后续工作流已取消')
  })

  it('keeps a committed roster successful when only its partial checkpoint write fails', async () => {
    const modelResult = JSON.stringify({ schemaVersion: 1, entries: rosterEntries })
    const checkpointContext: WorkflowContext = { ...context, data: {}, cancelled: false }
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      streamCallbacks.onDone?.(modelResult, undefined, 'stop')
      return Promise.resolve('character-request')
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证角色事实提交成功后，检查点写入失败不会误报角色图谱生成失败。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: checkpointContext.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: false, error: '磁盘已满' }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
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

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context: checkpointContext, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(checkpointContext.data.partial).toEqual({
      character_dynamics_result: readyRoster.renderedMarkdown,
    })
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith(expect.stringContaining('检查点保存失败'))
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith('角色图谱与 2 张角色卡已生成')
  })

  it('replaces a truncated roster JSON before committing the readable roster receipt', async () => {
    const truncated = '{"schemaVersion":1,"entries":['
    const completed = JSON.stringify({ schemaVersion: 1, entries: rosterEntries })
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
      modelId: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[2],
    ) => {
      void modelId
      const output = generateStream.mock.calls.length === 1 ? truncated : completed
      const finishReason = generateStream.mock.calls.length === 1 ? 'length' : 'stop'
      if (generateStream.mock.calls.length === 1) {
        useLLMStore.setState({ defaultModelId: 'model-2' })
      }
      streamCallbacks.onChunk?.(output)
      streamCallbacks.onDone?.(output, undefined, finishReason)
      return Promise.resolve(`truncated-character-request-${generateStream.mock.calls.length}`)
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证截断结构化响应必须先由完整替代 JSON 覆盖后才允许写入结构化角色事实。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
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

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(generateStream.mock.calls.map(call => call[2])).toEqual(['model-1', 'model-1'])
    const continuationMessages = generateStream.mock.calls[1]?.[0] ?? []
    const continuationPrompt = continuationMessages.find(message => message.role === 'user')?.content ?? ''
    expect(continuationPrompt).toContain('返回完整 JSON，从头重建，不要只补后缀')
    expect(invoke.mock.calls.map(([channel]) => channel)).toContain('db:character-roster-commit')
  })

  it('repairs only one complete but syntactically invalid roster response before committing it', async () => {
    const malformed = '{"schemaVersion":1,"entries":['
    const repaired = JSON.stringify({ schemaVersion: 1, entries: rosterEntries })
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      const output = generateStream.mock.calls.length === 1 ? malformed : repaired
      streamCallbacks.onChunk?.(output)
      streamCallbacks.onDone?.(output, undefined, 'stop')
      return Promise.resolve(`character-request-${generateStream.mock.calls.length}`)
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证一次 JSON 语法修复后的原子角色名单提交，避免测试因为前置长度不足而提前中止。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return {
            success: true,
            receipt: {
              operationId: context.runId,
              payloadHash: 'payload-hash',
              revision: 1,
              idempotent: false,
              snapshot: readyRoster,
            },
          }
        case 'fs:read-json':
          return { success: true, data: {} }
        case 'fs:write-json':
          return { success: true }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
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

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .resolves.toBe(readyRoster.renderedMarkdown)

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.map(([channel]) => channel)).toContain('db:character-roster-commit')
  })

  it('lets the atomic roster seam reject semantic invalidity without a JSON repair or partial write', async () => {
    const syntacticallyValidButEmpty = JSON.stringify({ schemaVersion: 1, entries: [] })
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      streamCallbacks.onDone?.(syntacticallyValidButEmpty, undefined, 'stop')
      return Promise.resolve('invalid-roster-request')
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'prompt:load-global':
          return []
        case 'fs:check-exists':
          return false
        case 'db:project-core-get':
          return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并将空角色名单的语义错误交给原子角色名单 seam 拒绝。' }
        case 'db:character-roster-read':
          return { ...readyRoster, revision: 0, migrationState: 'empty', entries: [], renderedMarkdown: '' }
        case 'db:character-roster-commit':
          return { success: false, error: '角色名单不能为空' }
        default:
          throw new Error(`Unexpected IPC channel: ${channel}`)
      }
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

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('角色名单不能为空')

    expect(generateStream).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'db:project-core-get',
      'db:character-roster-read',
      'db:character-roster-commit',
    ])
  })

  it('fails closed after the single allowed JSON repair attempt is still invalid', async () => {
    const malformed = '{"schemaVersion":1,"entries":['
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      streamCallbacks.onDone?.(malformed, undefined, 'stop')
      return Promise.resolve(`invalid-repair-${generateStream.mock.calls.length}`)
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证第二次 JSON 仍无效时绝不继续重试或写入，同时避免测试因为前置长度不足而提前中止。' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
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

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('角色名单 JSON 格式仍无效')

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['db:project-core-get'])
  })

  it('does not commit a completed model response after the frozen project session has switched', async () => {
    const result = JSON.stringify({ schemaVersion: 1, entries: rosterEntries })
    let finishGeneration: (() => void) | undefined
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      finishGeneration = () => streamCallbacks.onDone?.(result, undefined, 'stop')
      return Promise.resolve('late-character-request')
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证项目会话切换后不会提交任何角色图谱或角色卡，同时避免测试因为前置长度不足而提前中止。' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
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

    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(generateStream).toHaveBeenCalledOnce())
    useProjectStore.setState({ currentProject: project(projectBPath) as never })
    finishGeneration?.()

    await expect(execution).rejects.toThrow('当前项目已切换，架构生成已停止以避免写入错误项目')
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['db:project-core-get'])
  })

  it('does not commit when cancellation wins before the roster commit boundary', async () => {
    const result = JSON.stringify({ schemaVersion: 1, entries: rosterEntries })
    let finishGeneration: (() => void) | undefined
    const generateStream = vi.fn((
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      finishGeneration = () => streamCallbacks.onDone?.(result, undefined, 'stop')
      return Promise.resolve('cancelled-character-request')
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') {
        return { premise: '足够长的故事前提，确保角色架构命令能够开始生成并验证取消发生在提交前时不会写入角色图谱或角色卡，同时避免测试因为前置长度不足而提前中止。' }
      }
      throw new Error(`Unexpected IPC channel: ${channel}`)
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

    const cancelledContext: WorkflowContext = { ...context, cancelled: false }
    const command = new GenerateCharactersCommand({
      expectedProjectPath: projectAPath,
      novelConfig: { genre: '玄幻', totalChapters: 100, wordsPerChapter: 3000 } as never,
    })
    const execution = command.execute({ step: {}, context: cancelledContext, callbacks })
    await vi.waitFor(() => expect(generateStream).toHaveBeenCalledOnce())
    cancelledContext.cancelled = true
    finishGeneration?.()

    await expect(execution).rejects.toThrow('工作流已取消')
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['db:project-core-get'])
  })
})
