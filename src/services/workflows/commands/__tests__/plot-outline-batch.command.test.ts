import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
  GeneratePlotArchitectureCommand,
  PLOT_OUTLINE_RESUME_ERROR_CODE,
  PlotOutlineResumeAvailableError,
  synopsisFactsFingerprint,
} from '../architecture.command'
import { createWorkflowRuntimeDependencies } from './workflow-generation-runtime.fixture'
import { clearProjectCustomPrompts } from '../../../prompt-templates'

/**
 * 情节大纲批次状态机：
 * - 完成必须携带与批次范围一致的进度行（截断误报 stop 时不误判成功）；
 * - 断点续写 fail-closed（无有效检查点 / 指纹不符绝不退化为覆盖生成）；
 * - 分批连续续写（from = coveredTo+1），已确认前缀永不覆盖；
 * - 检查点绑定源事实指纹。
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
  globalGuidance: '保持因果推进。',
  writingStyle: '节奏紧凑，行动描写强调因果。',
} as const

const premise = '故事前提：主角林舟在铁砧镇当学徒，宗门封锁后他必须找到失落传承才能守住家人，终局灾难逼近。'.repeat(2)
const charactersArch = '角色图谱：林舟（主角）、苏绾（引导者）、顾岩（执法者）。'.repeat(2)
const worldbuilding = '世界观：灵脉决定城邦兴衰，宗门垄断资源。'.repeat(2)

const fingerprint = synopsisFactsFingerprint([
  premise,
  charactersArch,
  worldbuilding,
  '100',
  '3000',
  'three_act',
])

const coreSeed = { premise, charactersArch, worldbuilding }

function progressLine(from: number, to: number, total: number): string {
  return `大纲批次进度：已覆盖第${from}–${to}章，全书共${total}章`
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

interface CheckpointSnapshot {
  synopsis_result?: string
  synopsis_incomplete?: boolean
  synopsis_covered_to?: number
  synopsis_range?: { from: number; to: number }
  synopsis_facts_fingerprint?: string
}

interface IpcHarness {
  invoke: ReturnType<typeof vi.fn>
  coreUpdates: Array<Record<string, unknown>>
  partialWrites: Array<Record<string, unknown>>
}

function harnessWith(checkpoint: CheckpointSnapshot = {}): IpcHarness {
  const coreUpdates: Array<Record<string, unknown>> = []
  const partialWrites: Array<Record<string, unknown>> = []
  const invoke = vi.fn(async (_channel: string, ...rest: unknown[]) => {
    const channel = String(_channel)
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'fs:check-exists') return false
    if (channel === 'db:project-core-get') return { ...coreSeed }
    if (channel === 'db:project-core-update') {
      coreUpdates.push(rest[0] as Record<string, unknown>)
      return { success: true }
    }
    if (channel === 'fs:read-json') return { success: true, data: checkpoint }
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

function makeCommand(options?: { resumeSynopsis?: boolean; synopsisRange?: { from: number; to: number } }) {
  return new GeneratePlotArchitectureCommand(
    ['synopsis'],
    snapshot(),
    createWorkflowRuntimeDependencies(),
    options,
  )
}

function bodyOf(persisted: string): string {
  return persisted.replace(/^# 情节大纲\n\n/u, '').replace(/\n$/u, '')
}

beforeEach(() => {
  vi.clearAllMocks()
  context.data = {}
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

describe('GeneratePlotArchitectureCommand 批次状态机', () => {
  it('首次全量成功：输出带完成进度行才按完整保存，正文剥离进度行', async () => {
    const body = '## 第一卷\n\n第一章：铁砧镇的学徒。宗门封锁前夜，林舟发现了旧铁锤里的秘密。\n\n第二章：宗门封锁。'
    const completed = `${body}\n\n${progressLine(1, 100, 100)}`
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([completed]),
    })
    const harness = harnessWith()
    const command = makeCommand()

    const result = await command.execute({ step: {}, context, callbacks })

    expect(result).toContain('第一章：铁砧镇的学徒')
    expect(result).not.toContain('大纲批次进度')
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    expect(bodyOf(String(synopsisUpdate!.synopsis))).not.toContain('大纲批次进度')
    expect(bodyOf(String(synopsisUpdate!.synopsis))).not.toContain('未完成')
    const checkpointWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(checkpointWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: false,
      synopsis_covered_to: 100,
      synopsis_range: { from: 1, to: 100 },
      synopsis_facts_fingerprint: fingerprint,
    }))
  })

  it('P0：全量输出被截断（stop 且无进度行）绝不当成功——保存部分并抛可续写错误', async () => {
    // 模拟网关在输出上限把截断报成 stop：内容只写了两章，没有批次完成进度行。
    const truncated = '## 第一卷\n\n第一章：铁砧镇的学徒。宗门封锁前夜，林舟发现了旧铁锤里的秘密。\n\n第二章：宗门封锁。'
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([truncated]),
    })
    const harness = harnessWith()
    const command = makeCommand()

    const failure = await command.execute({ step: {}, context, callbacks }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PlotOutlineResumeAvailableError)
    expect(failure).toMatchObject({ code: PLOT_OUTLINE_RESUME_ERROR_CODE })

    // 部分内容已自动保存（检查点 incomplete=true + 范围 + 指纹；DB 带未完成标记）
    const checkpointWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(checkpointWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: true,
      synopsis_range: { from: 1, to: 100 },
      synopsis_facts_fingerprint: fingerprint,
      synopsis_result: expect.stringContaining('第二章：宗门封锁') as never,
    }))
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    expect(String(synopsisUpdate!.synopsis)).toContain('本大纲未完成')
  })

  it('断点续写：有效检查点（incomplete+范围+指纹匹配）续写完成后清除未完成标记', async () => {
    const partialBody = '## 第一卷\n\n第一章：铁砧镇的学徒。宗门封锁前夜，林舟发现了旧铁锤里的秘密。\n\n第二章：宗门封锁。\n\n第三章：废墟外的风声。'.repeat(2)
    const addition = '\n\n第四章：废墟里的传承。林舟找到了残缺功法，但代价是记忆损耗。\n\n' + progressLine(1, 100, 100)
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([addition]),
    })
    const harness = harnessWith({
      synopsis_result: partialBody,
      synopsis_incomplete: true,
      synopsis_range: { from: 1, to: 100 },
      synopsis_facts_fingerprint: fingerprint,
    })
    const command = makeCommand({ resumeSynopsis: true })

    const result = await command.execute({ step: {}, context, callbacks })

    expect(result).toContain('第四章：废墟里的传承')
    expect(result.split('第二章：宗门封锁').length - 1).toBe(2)
    const checkpointWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(checkpointWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: false,
      synopsis_covered_to: 100,
      synopsis_range: { from: 1, to: 100 },
    }))
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    expect(String(synopsisUpdate!.synopsis)).not.toContain('未完成')
    expect(String(synopsisUpdate!.synopsis)).not.toContain('大纲批次进度')
  })

  it('fail-closed：没有中断检查点却请求续写 → 拒绝且不发起任何模型调用', async () => {
    const harness = harnessWith({}) // 无检查点
    const generateStream = vi.fn()
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const command = makeCommand({ resumeSynopsis: true })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('未找到中断的情节大纲检查点')
    expect(generateStream).not.toHaveBeenCalled()
    expect(harness.partialWrites).toHaveLength(0)
    expect(harness.coreUpdates).toHaveLength(0)
  })

  it('fail-closed：续写检查点的源事实指纹与当前不一致 → 拒绝续接', async () => {
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream(['should never run']),
    })
    harnessWith({
      synopsis_result: 'some older outline body that is at least a reasonably long piece of text content'.repeat(3),
      synopsis_incomplete: true,
      synopsis_range: { from: 1, to: 100 },
      synopsis_facts_fingerprint: 'stale-fingerprint',
    })
    const command = makeCommand({ resumeSynopsis: true })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('源事实')
    expect(useLLMStore.getState().generateStream).not.toHaveBeenCalled()
  })

  it('分批续写：已覆盖 1–20 章后从第 21 章连续生成到 100，前缀不被覆盖', async () => {
    const prefixBody = '## 第一卷\n\n第一章至第二十章已确认大纲内容（长度足够的已确认前缀）。'.repeat(3)
    const nextSegment = '## 第二卷\n\n第二十一章：破门。宗门废墟之下，林舟第一次触碰那柄旧铁锤里的传承。\n\n'
      + '第二十二章：反噬。记忆损耗的代价开始显现。\n\n'
      + progressLine(21, 100, 100)
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([nextSegment]),
    })
    const harness = harnessWith({
      synopsis_result: prefixBody,
      synopsis_covered_to: 20,
      synopsis_range: { from: 1, to: 20 },
      synopsis_facts_fingerprint: fingerprint,
    })
    const command = makeCommand({ synopsisRange: { from: 21, to: 100 } })

    const result = await command.execute({ step: {}, context, callbacks })

    // 前缀保留、新段追加、最终覆盖到全书
    expect(result).toContain('第二十一章：破门')
    expect(result.split('大纲批次进度').length - 1).toBe(0)
    const checkpointWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(checkpointWrite).toEqual(expect.objectContaining({
      synopsis_covered_to: 100,
      synopsis_incomplete: false,
      synopsis_range: { from: 21, to: 100 },
    }))
    expect((checkpointWrite.synopsis_result as string)).toContain('第一章至第二十章已确认大纲内容')
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    const dbBody = bodyOf(String(synopsisUpdate!.synopsis))
    expect(dbBody).toContain('第一章至第二十章已确认大纲内容')
    expect(dbBody).toContain('第二十二章：反噬')
    expect(dbBody).not.toContain('大纲批次进度')
  })

  it('分批必须连续：from ≤ coveredTo（非 1）→ 拒绝且不覆盖已确认前缀', async () => {
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream(['never']),
    })
    harnessWith({
      synopsis_result: 'already confirmed prefix content that is long enough for the checkpoint'.repeat(2),
      synopsis_covered_to: 20,
      synopsis_range: { from: 1, to: 20 },
      synopsis_facts_fingerprint: fingerprint,
    })
    const command = makeCommand({ synopsisRange: { from: 10, to: 30 } })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('已包含在已确认大纲中')
    expect(useLLMStore.getState().generateStream).not.toHaveBeenCalled()
  })

  it('存在未完成批次时不允许再发起新批次（先断点续写）', async () => {
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream(['never']),
    })
    harnessWith({
      synopsis_result: 'interrupted body content with enough characters to be meaningful here',
      synopsis_incomplete: true,
      synopsis_covered_to: 20,
      synopsis_range: { from: 21, to: 40 },
      synopsis_facts_fingerprint: fingerprint,
    })
    const command = makeCommand({ synopsisRange: { from: 41, to: 60 } })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('先完成该批次')
    expect(useLLMStore.getState().generateStream).not.toHaveBeenCalled()
  })

  it('分批范围收尾：首批只生成 1–20 章（进度行校验）后 covered_to=20，仍可继续', async () => {
    const firstBatch = '## 第一卷\n\n第一章：铁砧镇的学徒。\n\n第二十章：初窥门径。\n\n' + progressLine(1, 20, 100)
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([firstBatch]),
    })
    const harness = harnessWith()
    const command = makeCommand({ synopsisRange: { from: 1, to: 20 } })

    await command.execute({ step: {}, context, callbacks })

    const checkpointWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(checkpointWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: false,
      synopsis_covered_to: 20,
      synopsis_range: { from: 1, to: 20 },
    }))
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    expect(String(synopsisUpdate!.synopsis)).toContain('已覆盖至第 20 章')
    expect(String(synopsisUpdate!.synopsis)).not.toContain('大纲批次进度')
  })
})
