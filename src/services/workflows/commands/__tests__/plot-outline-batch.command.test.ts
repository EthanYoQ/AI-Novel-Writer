import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
  GeneratePlotArchitectureCommand,
  PLOT_OUTLINE_RESUME_ERROR_CODE,
  PlotOutlineResumeAvailableError,
} from '../architecture.command'
import { createWorkflowRuntimeDependencies } from './workflow-generation-runtime.fixture'
import { clearProjectCustomPrompts } from '../../../prompt-templates'

/**
 * 情节大纲分批/断流保护：自动续写拼接、长度耗尽自动落盘、检查点续写、
 * 「本次只详写前 N 章」分块指令。
 */

const projectAPath = 'C:\\novels\\plot-batch'
const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId

const novelConfig = {
  genre: '玄幻',
  targetAudience: '男频',
  subGenre: '东方玄幻',
  totalChapters: 100,
  wordsPerChapter: 3000,
  plotStructure: 'three_act',
  narrativePOV: 'third_limited',
  coreOutline: '主角在宗门废墟中找到失落的传承，必须赶在终局灾难前成长。',
  worldSetting: '灵脉决定城邦兴衰，宗门垄断资源，边境异变正在瓦解旧有秩序。',
  goldenFinger: '主角能够解析残缺功法，但每次使用都会付出记忆损耗的代价。',
  protagonistProfile: '外表谨慎克制，内心执着于守护家人。',
  globalGuidance: '保持因果推进。\n保留已建立的角色状态。\n用行动升级冲突。\n收束已兑现的伏笔。',
  writingStyle: '节奏紧凑，行动描写强调因果。',
} as const

const coreSeed = {
  premise: '这是足够长的故事前提：主角林舟在铁砧镇当学徒，宗门封锁后他必须找到失落传承才能守住家人，大陆深处的终局灾难正在逼近。'.repeat(2),
  charactersArch: '角色图谱：林舟（主角）、苏绾（引导者）、顾岩（执法者）。三人关系在封锁中不断反转。'.repeat(2),
  worldbuilding: '世界观：灵脉决定城邦兴衰，宗门垄断资源，边境异变正在瓦解旧有秩序。'.repeat(2),
}

function project(path: string) {
  return {
    id: 'main',
    name: path,
    path,
    sessionLease: 'lease-main',
    novelConfig,
  }
}

const context: WorkflowContext = {
  runId: 'plot-batch-run',
  projectPath: projectAPath,
  projectSession: { projectId: 'main', leaseId: 'lease-main', projectPath: projectAPath },
  writingLanguage: 'zh-CN',
  uiLocale: 'zh-CN',
  data: {},
  cancelled: false,
}

const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

/** 依调用顺序返回响应的 generateStream mock。 */
function responseStream(
  responses: readonly string[],
  finishReasons: ReadonlyArray<'stop' | 'length'> = responses.map(() => 'stop'),
) {
  let nextResponseIndex = 0
  return vi.fn((
    _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
    streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
  ) => {
    const index = nextResponseIndex++
    const output = responses[index]
    if (output === undefined) throw new Error(`unexpected generation attempt ${index + 1}`)
    streamCallbacks.onDone?.(output, undefined, finishReasons[index] ?? 'stop')
    return Promise.resolve(`plot-request-${index + 1}`)
  })
}

interface IpcHarness {
  invoke: ReturnType<typeof vi.fn>
  coreUpdates: Array<Record<string, unknown>>
  partialWrites: Array<Record<string, unknown>>
}

function harnessWith(core: Record<string, string> = {}): IpcHarness {
  const coreUpdates: Array<Record<string, unknown>> = []
  const partialWrites: Array<Record<string, unknown>> = []
  const invoke = vi.fn(async (_channel: string, ...rest: unknown[]) => {
    const channel = String(_channel)
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'fs:check-exists') return false
    if (channel === 'db:project-core-get') return { ...coreSeed, ...core }
    if (channel === 'db:project-core-update') {
      const update = rest[0] as Record<string, unknown>
      coreUpdates.push(update)
      return { success: true }
    }
    if (channel === 'fs:read-json') return { success: true, data: {} }
    if (channel === 'fs:write-json') {
      partialWrites.push(rest[1] as Record<string, unknown>)
      return { success: true }
    }
    if (channel === 'fs:write-file') return { success: true }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  vi.stubGlobal('window', {
    velaAPI: {
      invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(),
      setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(),
    },
  })
  return { invoke, coreUpdates, partialWrites }
}

function snapshot() {
  return { expectedProjectPath: projectAPath, novelConfig } as never
}

function expectSynopsisBody(persisted: string): string {
  // DB 内容为 `# 情节大纲\n\n<body>`；此处剥掉标题便于断言正文。
  const withoutHeading = persisted.replace(/^# 情节大纲\n\n/u, '')
  return withoutHeading.replace(/\n$/u, '')
}

beforeEach(() => {
  vi.clearAllMocks()
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
  clearProjectCustomPrompts()
})

describe('GeneratePlotArchitectureCommand 分批/断流保护', () => {
  it('首次输出即 stop 时：单次调用并按完整大纲落库', async () => {
    const body = '## 第一卷\n\n第一章：铁砧镇的学徒。\n\n第二章：宗门封锁。\n\n'
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([body]),
    })
    const harness = harnessWith()
    const command = new GeneratePlotArchitectureCommand(
      ['synopsis'], snapshot(), createWorkflowRuntimeDependencies(),
    )

    const result = await command.execute({ step: {}, context, callbacks })

    expect(result).toContain('第二章：宗门封锁')
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    expect(synopsisUpdate).toBeDefined()
    expect(expectSynopsisBody(String(synopsisUpdate!.synopsis))).toContain('第一章：铁砧镇的学徒')
    expect(String(synopsisUpdate!.synopsis)).not.toContain('未完成')
    const partialWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(partialWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: false,
    }))
  })

  it('输出 length 时自动续写：第二次响应 stop 后拼接保存且无标题重复', async () => {
    const first = '## 第一卷\n\n第一章：铁砧镇的学徒。宗门封锁前夜，林舟发现了旧铁锤里的秘密。\n\n第二章：宗门封锁。'
    const second = '\n\n第三章：废墟里的传承。林舟在宗门废墟中找到了残缺功法。\n\n第四章：边境异变。'
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([first, second], ['length', 'stop']),
    })
    const harness = harnessWith()
    const command = new GeneratePlotArchitectureCommand(
      ['synopsis'], snapshot(), createWorkflowRuntimeDependencies(),
    )

    const result = await command.execute({ step: {}, context, callbacks })

    expect(useLLMStore.getState().generateStream).toHaveBeenCalledTimes(2)
    expect(result).toContain('第一章：铁砧镇的学徒')
    expect(result).toContain('第四章：边境异变')
    // 续写提示要求模型只输出新增内容；重叠合并不得产生重复章节行。
    expect(result.split('第四章：边境异变').length - 1).toBe(1)
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    expect(expectSynopsisBody(String(synopsisUpdate!.synopsis))).toContain('第四章：边境异变')
    const partialWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(partialWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: false,
      synopsis_result: expect.stringContaining('第四章：边境异变') as never,
    }))
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith(expect.stringContaining('自动续写第 1 轮请求已发起'))
  })

  it('自动续写耗尽时：先自动保存已完成部分，再抛出可续写错误（带 resume 错误码）', async () => {
    const segments = [
      '## 第一卷\n\n第一章：铁砧镇的学徒。宗门封锁前夜，林舟发现了旧铁锤里的秘密。',
      '第二章：宗门封锁。苏绾带来大陆深处的警告，顾岩的执法队包围了铁砧镇。',
      '第三章：废墟里的传承。林舟在宗门废墟中找到了残缺功法，但代价是记忆损耗。',
      '第四章：边境异变。妖兽潮冲击边关，宗门封锁线开始崩溃。',
    ]
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream(segments, ['length', 'length', 'length', 'length']),
    })
    const harness = harnessWith()
    const command = new GeneratePlotArchitectureCommand(
      ['synopsis'], snapshot(), createWorkflowRuntimeDependencies(),
    )

    const execution = command.execute({ step: {}, context, callbacks })
    const failure = await execution.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PlotOutlineResumeAvailableError)
    expect(failure).toMatchObject({ code: PLOT_OUTLINE_RESUME_ERROR_CODE })
    expect((failure as Error).message).toContain('已自动保存为不完整大纲')

    // 已完成部分必须已经自动落库（DB 带未完成标记；partial 检查点带断点数据）
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    expect(synopsisUpdate).toBeDefined()
    const persisted = String(synopsisUpdate!.synopsis)
    expect(persisted).toContain('第一章：铁砧镇的学徒')
    expect(persisted).toContain('第四章：边境异变')
    expect(persisted).toContain('本大纲未完成')
    const partialWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(partialWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: true,
      synopsis_result: expect.stringContaining('第四章：边境异变') as never,
    }))
  })

  it('断点续写：读取中断检查点作为种子，只续写新增内容且覆盖未完成标记', async () => {
    const seedBody = '## 第一卷\n\n第一章：铁砧镇的学徒。宗门封锁前夜，林舟发现了旧铁锤里的秘密。\n\n第二章：宗门封锁。'
    const addition = '\n\n第三章：废墟里的传承。林舟在宗门废墟中找到了残缺功法。\n\n第四章：边境异变。'
    const invoke = vi.fn(async (_channel: string) => {
      const channel = String(_channel)
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists') return false
      if (channel === 'db:project-core-get') return { ...coreSeed }
      if (channel === 'fs:read-json') {
        // 中断检查点：上次自动保存的已完成部分
        return { success: true, data: { synopsis_result: seedBody, synopsis_incomplete: true } }
      }
      if (channel === 'db:project-core-update') return { success: true }
      if (channel === 'fs:write-json') return { success: true }
      if (channel === 'fs:write-file') return { success: true }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    vi.stubGlobal('window', {
      velaAPI: {
        invoke, on: vi.fn(), once: vi.fn(), send: vi.fn(),
        setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(),
      },
    })
    let resumedPrompt = ''
    const generateStream = vi.fn((
      messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      resumedPrompt = messages.map(message => message.content).join('\n')
      streamCallbacks.onDone?.(addition, undefined, 'stop')
      return Promise.resolve('plot-resume-request')
    })
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const command = new GeneratePlotArchitectureCommand(
      ['synopsis'], snapshot(), createWorkflowRuntimeDependencies(),
      { resumeSynopsis: true },
    )

    const result = await command.execute({ step: {}, context, callbacks })

    // 续写模式不重发已有正文的首轮任务，只发「从断点继续」指令并携带种子末尾
    expect(useLLMStore.getState().generateStream).toHaveBeenCalledTimes(1)
    expect(resumedPrompt).toContain('上一轮文本因长度限制而中断')
    expect(resumedPrompt).toContain('从已完成文本的末尾自然续写')
    expect(resumedPrompt).toContain('第二章：宗门封锁')
    expect(result).toContain('第一章：铁砧镇的学徒')
    expect(result).toContain('第四章：边境异变')

    const updates = (invoke.mock.calls as unknown as Array<[string, unknown]>)
      .filter(([channel]) => channel === 'db:project-core-update')
      .map(([, update]) => update as Record<string, unknown>)
    expect(updates.length).toBe(1)
    const persisted = String(updates[0].synopsis)
    expect(persisted).toContain('第四章：边境异变')
    expect(persisted).not.toContain('未完成')
    // 合并后的正文不得出现两处「第二章：宗门封锁」
    expect(persisted.split('第二章：宗门封锁').length - 1).toBe(1)
    const partialWrites = (invoke.mock.calls as unknown as Array<[string, unknown, unknown]>)
      .filter(([channel]) => channel === 'fs:write-json')
      .map(([, , data]) => data as Record<string, unknown>)
    expect(partialWrites[partialWrites.length - 1]).toEqual(expect.objectContaining({
      synopsis_incomplete: false,
    }))
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith(expect.stringContaining('从断点续写'))
  })

  it('填写本次生成章节数时：提示词注入分块指令，只详写前 N 章', async () => {
    let observedUserPrompt = ''
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn((
        messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
        streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
      ) => {
        observedUserPrompt = messages.map(message => message.content).join('\n')
        streamCallbacks.onDone?.('## 第一卷\n\n第一章……', undefined, 'stop')
        return Promise.resolve('plot-scope-request')
      }),
    })
    harnessWith()
    const command = new GeneratePlotArchitectureCommand(
      ['synopsis'], snapshot(), createWorkflowRuntimeDependencies(),
      { synopsisChapters: 20 },
    )

    await command.execute({ step: {}, context, callbacks })

    expect(observedUserPrompt).toContain('本次生成范围')
    expect(observedUserPrompt).toContain('只对第 1–20 章输出完整详细的情节大纲')
    expect(observedUserPrompt).toContain('第 21 章')
    expect(vi.mocked(callbacks.log)).toHaveBeenCalledWith(expect.stringContaining('仅详细生成前 20 章'))
  })

  it('不传章节数时按全书生成（无分块指令）', async () => {
    let observedUserPrompt = ''
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn((
        messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
        streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
      ) => {
        observedUserPrompt = messages.map(message => message.content).join('\n')
        streamCallbacks.onDone?.('## 第一卷\n\n第一章……', undefined, 'stop')
        return Promise.resolve('plot-full-request')
      }),
    })
    harnessWith()
    const command = new GeneratePlotArchitectureCommand(
      ['synopsis'], snapshot(), createWorkflowRuntimeDependencies(),
    )

    await command.execute({ step: {}, context, callbacks })

    expect(observedUserPrompt).not.toContain('本次生成范围')
    expect(observedUserPrompt).toContain('100 章')
  })
})
