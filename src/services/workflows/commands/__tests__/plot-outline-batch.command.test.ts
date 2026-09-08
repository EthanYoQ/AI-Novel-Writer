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
import { clearProjectCustomPrompts, getBuiltinPromptTemplate } from '../../../prompt-templates'

/**
 * 情节大纲批次状态机：
 * - 完成必须有本批完整正文覆盖；可选进度行不得与本批冲突；
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

const legacyFingerprint = synopsisFactsFingerprint([
  premise,
  charactersArch,
  worldbuilding,
  '100',
  '3000',
  'three_act',
])

function currentFingerprint(
  range: { from: number; to: number },
  stepGuidance = '',
): string {
  return synopsisFactsFingerprint([
    JSON.stringify({
      premise,
      charactersArch,
      worldbuilding,
      genre: novelConfig.genre,
      totalChapters: novelConfig.totalChapters,
      wordsPerChapter: novelConfig.wordsPerChapter,
      writingLanguage: 'zh-CN',
      plotStructure: novelConfig.plotStructure,
      narrativePov: novelConfig.narrativePOV,
      globalGuidance: novelConfig.globalGuidance,
    }),
    stepGuidance,
    `${range.from}:${range.to}`,
    JSON.stringify(getBuiltinPromptTemplate('synopsis', 'zh-CN')),
  ])
}

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

function lengthThenNetworkFailure(firstBody: string) {
  let callIndex = 0
  return vi.fn((
    _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
    streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
  ) => {
    callIndex += 1
    if (callIndex === 1) {
      streamCallbacks.onDone?.(firstBody, undefined, 'length')
    } else {
      streamCallbacks.onError?.('模拟网络中断')
    }
    return Promise.resolve(`outline-request-${callIndex}`)
  })
}

interface CheckpointSnapshot {
  [key: string]: unknown
  synopsis_result?: string
  synopsis_incomplete?: boolean
  synopsis_covered_to?: number
  synopsis_range?: { from: number; to: number }
  synopsis_facts_fingerprint?: string
  synopsis_db_hash?: string
  synopsis_body_hash?: string
  synopsis_step_guidance?: string
}

interface IpcHarness {
  invoke: ReturnType<typeof vi.fn>
  coreUpdates: Array<Record<string, unknown>>
  partialWrites: Array<Record<string, unknown>>
  synopsisCommits: Array<Record<string, unknown>>
}

interface HarnessOptions {
  commitResult?: { success: boolean; error?: string }
  concurrentPartialUpdate?: Record<string, unknown>
  afterPartialWrite?: (
    checkpoint: CheckpointSnapshot,
    writeCount: number,
  ) => Record<string, unknown> | undefined
}

function dbHashOf(dbOutlineText: string): string {
  return synopsisFactsFingerprint([dbOutlineText])
}

function harnessWith(
  checkpoint: CheckpointSnapshot = {},
  dbSynopsis = '',
  options: HarnessOptions = {},
): IpcHarness {
  const coreUpdates: Array<Record<string, unknown>> = []
  const partialWrites: Array<Record<string, unknown>> = []
  const synopsisCommits: Array<Record<string, unknown>> = []
  let storedCheckpoint = { ...checkpoint }
  let storedDbSynopsis = dbSynopsis
  const invoke = vi.fn(async (_channel: string, ...rest: unknown[]) => {
    const channel = String(_channel)
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'fs:check-exists') return false
    if (channel === 'db:project-core-get') return storedDbSynopsis ? { ...coreSeed, synopsis: storedDbSynopsis } : { ...coreSeed }
    if (channel === 'db:project-core-update') {
      coreUpdates.push(rest[0] as Record<string, unknown>)
      return { success: true }
    }
    if (channel === 'db:project-core-synopsis-commit') {
      const request = rest[0] as Record<string, unknown> & { synopsis: string }
      synopsisCommits.push(request)
      if (options.concurrentPartialUpdate) {
        storedCheckpoint = { ...storedCheckpoint, ...options.concurrentPartialUpdate }
      }
      const result = options.commitResult ?? { success: true }
      if (result.success) {
        storedDbSynopsis = request.synopsis
        coreUpdates.push({ synopsis: request.synopsis })
      }
      return result
    }
    if (channel === 'fs:read-json') return { success: true, data: storedCheckpoint }
    if (channel === 'fs:write-json') {
      storedCheckpoint = { ...(rest[1] as CheckpointSnapshot) }
      partialWrites.push(storedCheckpoint)
      const concurrentUpdate = options.afterPartialWrite?.(storedCheckpoint, partialWrites.length)
      if (concurrentUpdate) storedCheckpoint = { ...storedCheckpoint, ...concurrentUpdate }
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
  return { invoke, coreUpdates, partialWrites, synopsisCommits }
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
  context.uiLocale = 'zh-CN'
  context.writingLanguage = 'zh-CN'
  context.cancelled = false
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
  it('完整非空的章节覆盖正常结束时不因缺少自报进度行而返工', async () => {
    const body = Array.from({ length: 20 }, (_, index) =>
      `第${index + 1}章：核对记录\n周岚核对记录并据此推进调查，确认本章线索的来源。`,
    ).join('\n\n')
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream: responseStream([body]) })
    const harness = harnessWith()

    const result = await makeCommand({ synopsisRange: { from: 1, to: 20 } })
      .execute({ step: {}, context, callbacks })

    expect(result).toContain(body)
    expect(harness.partialWrites.at(-1)).toMatchObject({
      synopsis_incomplete: false,
      synopsis_covered_to: 20,
    })
    expect(useLLMStore.getState().generateStream).toHaveBeenCalledTimes(1)
  })

  it('length 后续写失败即使章节覆盖齐全也仍保存为未完成', async () => {
    const body = `第1–20章：核对记录\n${'周岚核对记录并据此推进调查，确认各条线索的来源。'.repeat(6)}`
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream: lengthThenNetworkFailure(body) })
    const harness = harnessWith()

    await expect(makeCommand({ synopsisRange: { from: 1, to: 20 } })
      .execute({ step: {}, context, callbacks })).rejects.toBeInstanceOf(PlotOutlineResumeAvailableError)
    expect(harness.partialWrites.at(-1)).toMatchObject({ synopsis_incomplete: true })
  })

  it.each([progressLine(21, 40, 100), '大纲批次进度：本批结束'])('正文完整但显式进度行无效时仍拒绝完成：%s', async mark => {
    const body = `第1–20章：核对记录\n${'周岚核对记录并据此推进调查，确认各条线索的来源。'.repeat(6)}`
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([`${body}\n${mark}`]),
    })
    const harness = harnessWith()

    await expect(makeCommand({ synopsisRange: { from: 1, to: 20 } })
      .execute({ step: {}, context, callbacks })).rejects.toBeInstanceOf(PlotOutlineResumeAvailableError)
    expect(harness.partialWrites.at(-1)).toMatchObject({ synopsis_incomplete: true })
  })

  it('首次全量成功：完整正文带正确进度行时保存并剥离进度行', async () => {
    const body = '## 第一卷\n\n第1–100章：终局守门人\n林舟从铁砧镇学徒成长为终局守门人，每章均有独立推进。'
    const completed = `${body}\n\n${progressLine(1, 100, 100)}`
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([completed]),
    })
    const harness = harnessWith()
    const command = makeCommand()

    const result = await command.execute({ step: {}, context, callbacks })

    expect(result).toContain('第1–100章：终局守门人\n林舟从铁砧镇学徒成长为终局守门人')
    expect(result).not.toContain('大纲批次进度')
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    expect(bodyOf(String(synopsisUpdate!.synopsis))).not.toContain('大纲批次进度')
    expect(bodyOf(String(synopsisUpdate!.synopsis))).not.toContain('未完成')
    const checkpointWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(checkpointWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: false,
      synopsis_covered_to: 100,
      synopsis_range: { from: 1, to: 100 },
      synopsis_facts_fingerprint: expect.any(String) as never,
    }))
    expect(harness.synopsisCommits[0]?.expected).toEqual({
      synopsis: '',
      premise,
      charactersArch,
      worldbuilding,
      genre: novelConfig.genre,
      totalChapters: novelConfig.totalChapters,
      wordsPerChapter: novelConfig.wordsPerChapter,
      writingLanguage: 'zh-CN',
      plotStructure: novelConfig.plotStructure,
      narrativePov: novelConfig.narrativePOV,
      globalGuidance: novelConfig.globalGuidance,
    })
  })

  it('P0：全量输出被截断（stop 且无进度行）绝不当成功——保存部分并抛可续写错误', async () => {
    // 模拟网关在输出上限把截断报成 stop：内容只写了两章，没有批次完成进度行。
    const truncated = `## 第一卷\n\n第一章：旧铁锤\n${'宗门封锁前夜，林舟发现了旧铁锤里的秘密，并沿着灵脉追查家人的下落。'.repeat(4)}\n\n第二章：宗门封锁\n林舟被迫改变追查路线。`
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
      synopsis_facts_fingerprint: expect.any(String) as never,
      synopsis_result: expect.stringContaining('第二章：宗门封锁') as never,
    }))
    const synopsisUpdate = harness.coreUpdates.find(update => typeof update.synopsis === 'string')
    expect(String(synopsisUpdate!.synopsis)).toContain('本大纲未完成')
  })

  it('uses writing language, not UI locale, for the visible incomplete note', async () => {
    context.writingLanguage = 'en-US'
    context.uiLocale = 'zh-CN'
    const truncated = `Chapters 1-3: The first clues\n${'The apprentice follows each clue while preserving the causal chain. '.repeat(4)}`
    const generateStream = responseStream([truncated])
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const harness = harnessWith()

    await expect(makeCommand({ synopsisRange: { from: 1, to: 20 } }).execute({ step: {}, context, callbacks }))
      .rejects.toBeInstanceOf(PlotOutlineResumeAvailableError)

    const persisted = String(harness.coreUpdates.at(-1)?.synopsis)
    expect(persisted).toContain('This outline is incomplete')
    expect(persisted).not.toContain('本大纲未完成')
    const prompt = generateStream.mock.calls[0]?.[0]
      .map((message: { content: string }) => message.content)
      .join('\n')
    expect(prompt).toContain('“Chapter N: Title” or “Chapters N-M: Title”')
    expect(prompt).toContain('“Later overview: ...”')
    expect(prompt).toContain('Do not title it “Chapter N” or “Chapters N-M”')
  })

  it('断点续写：有效检查点（incomplete+范围+指纹匹配）续写完成后清除未完成标记', async () => {
    const partialBody = `## 第一卷\n\n第1–3章：追入废墟\n${'林舟从铁砧镇追入宗门废墟，逐步发现灵脉异变。'.repeat(5)}`
    const addition = '\n\n第4–100章：传承试炼\n林舟完成传承试炼并承担记忆代价，后续各章连续推进至终局。\n\n' + progressLine(1, 100, 100)
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([addition]),
    })
    const dbOutline = `# 情节大纲\n\n${partialBody}\n\n> ⚠️ **本大纲未完成**：生成被输出长度中断，以上为已自动保存的已完成部分。\n> 可在「AI 输出」提示处点击「继续生成情节大纲」，从断点续写补齐本批章节。`
    const harness = harnessWith({
      synopsis_result: partialBody,
      synopsis_incomplete: true,
      synopsis_range: { from: 1, to: 100 },
      synopsis_facts_fingerprint: currentFingerprint({ from: 1, to: 100 }),
      synopsis_db_hash: dbHashOf(dbOutline),
      synopsis_step_guidance: '',
    }, dbOutline)
    const command = makeCommand({ resumeSynopsis: true })

    const result = await command.execute({ step: {}, context, callbacks })

    expect(result).toContain('第4–100章：传承试炼\n林舟完成传承试炼')
    expect(result.split('第1–3章').length - 1).toBe(1)
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
      synopsis_step_guidance: '',
    })
    const command = makeCommand({ resumeSynopsis: true })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('源事实')
    expect(useLLMStore.getState().generateStream).not.toHaveBeenCalled()
  })

  it.each([
    ['interrupted resume', true, { from: 1, to: 100 }],
    ['next batch', false, { from: 21, to: 40 }],
  ] as const)('keeps a legacy checkpoint without complete input binding but rejects automatic %s', async (
    _caseName,
    incomplete,
    requestedRange,
  ) => {
    const checkpointBody = `第1–20章：旧检查点\n${'旧版大纲正文保留，但来源输入没有完整绑定。'.repeat(8)}`
    const checkpoint: CheckpointSnapshot = {
      synopsis_result: checkpointBody,
      synopsis_incomplete: incomplete,
      synopsis_covered_to: incomplete ? 0 : 20,
      synopsis_range: incomplete ? { from: 1, to: 100 } : { from: 1, to: 20 },
      synopsis_facts_fingerprint: legacyFingerprint,
    }
    const dbOutline = incomplete
      ? `# 情节大纲\n\n${checkpointBody}\n\n> ⚠️ **本大纲未完成**：生成被输出长度中断，以上为已自动保存的已完成部分。\n> 可在「AI 输出」提示处点击「继续生成情节大纲」，从断点续写补齐本批章节。`
      : `# 情节大纲\n\n${checkpointBody}\n\n> 本大纲已覆盖至第 20 章（全书 100 章），其余章节将在后续批次继续生成。`
    checkpoint.synopsis_db_hash = dbHashOf(dbOutline)
    const harness = harnessWith(checkpoint, dbOutline)
    const generateStream = vi.fn()
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })

    const command = incomplete
      ? makeCommand({ resumeSynopsis: true })
      : makeCommand({ synopsisRange: requestedRange })
    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('缺少完整输入绑定')

    expect(generateStream).not.toHaveBeenCalled()
    expect(harness.partialWrites).toHaveLength(0)
    expect(harness.synopsisCommits).toHaveLength(0)
  })

  it('分批续写：已覆盖 1–20 章后从第 21 章连续生成到 100，前缀不被覆盖', async () => {
    const prefixBody = '## 第一卷\n\n第一章至第二十章已确认大纲内容（长度足够的已确认前缀）。'.repeat(3)
    const nextSegment = '## 第二卷\n\n第21章：破门\n宗门废墟之下，林舟第一次触碰那柄旧铁锤里的传承。\n\n'
      + '第22–100章：反噬\n记忆损耗的代价持续推进并最终在终局兑现。\n\n'
      + progressLine(21, 100, 100)
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([nextSegment]),
    })
    const dbOutline = `# 情节大纲\n\n${prefixBody}\n\n> 本大纲已覆盖至第 20 章（全书 100 章），其余章节将在后续批次继续生成。`
    const harness = harnessWith({
      synopsis_result: prefixBody,
      synopsis_covered_to: 20,
      synopsis_range: { from: 1, to: 20 },
      synopsis_facts_fingerprint: currentFingerprint({ from: 1, to: 20 }),
      synopsis_db_hash: dbHashOf(dbOutline),
      synopsis_step_guidance: '',
    }, dbOutline)
    const command = makeCommand({ synopsisRange: { from: 21, to: 100 } })

    const result = await command.execute({ step: {}, context, callbacks })

    // 前缀保留、新段追加、最终覆盖到全书
    expect(result).toContain('第21章：破门')
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
    expect(dbBody).toContain('第22–100章：反噬')
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
      synopsis_facts_fingerprint: currentFingerprint({ from: 1, to: 20 }),
      synopsis_step_guidance: '',
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
      synopsis_facts_fingerprint: currentFingerprint({ from: 21, to: 40 }),
      synopsis_step_guidance: '',
    })
    const command = makeCommand({ synopsisRange: { from: 41, to: 60 } })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('先完成该批次')
    expect(useLLMStore.getState().generateStream).not.toHaveBeenCalled()
  })

  it('分批范围收尾：首批只生成 1–20 章（进度行校验）后 covered_to=20，仍可继续', async () => {
    const firstBatch = '## 第一卷\n\n第1章：铁砧镇的学徒\n林舟发现宗门封锁的第一条线索。\n\n第2–20章：初窥门径\n林舟步步追查并初窥门径。\n\n' + progressLine(1, 20, 100)
    const generateStream = responseStream([firstBatch])
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream,
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
    const prompt = generateStream.mock.calls[0]?.[0]
      .map((message: { content: string }) => message.content)
      .join('\n')
    expect(prompt).toContain('“第N章：标题”或“第N–M章：标题”')
    expect(prompt).toContain('“后续概览：……”')
    expect(prompt).toContain('不得使用“第N章”或“第N–M章”标题')
  })

  it('P1：续批时 DB 大纲已被手动修改 → 拒绝续批（不覆盖用户修改）', async () => {
    const prefixBody = '## 第一卷\n\n第一章至第二十章已确认大纲内容（长度足够的已确认前缀）。'.repeat(3)
    const dbOutline = `# 情节大纲\n\n${prefixBody}\n\n> 本大纲已覆盖至第 20 章（全书 100 章），其余章节将在后续批次继续生成。\n`
    // 用户随后在编辑器里手动改写了第 5 章的内容并保存（DB 与镜像指纹不一致）
    const editedDbOutline = dbOutline.replace('第一章', '第一章（手动修订后的新表述）')
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream(['should never run']),
    })
    const harness = harnessWith({
      synopsis_result: prefixBody,
      synopsis_covered_to: 20,
      synopsis_range: { from: 1, to: 20 },
      synopsis_facts_fingerprint: currentFingerprint({ from: 1, to: 20 }),
      synopsis_db_hash: dbHashOf(dbOutline),
      synopsis_step_guidance: '',
    }, editedDbOutline)
    const command = makeCommand({ synopsisRange: { from: 21, to: 100 } })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('已被手动修改')
    expect(useLLMStore.getState().generateStream).not.toHaveBeenCalled()
    expect(harness.coreUpdates).toHaveLength(0)
  })

  it('P1：完成进度行的 from 与本批不一致 → 视为未完成并保存为可续写检查点', async () => {
    // 请求 1–100 章，模型正文只写了一小段却谎报 80–100：严格校验 from/to 后必须拒绝。
    const shortBody = `## 第一卷\n\n第一章：铁砧镇\n${'铁砧镇的学徒追查宗门封锁背后的灵脉异变。'.repeat(6)}\n\n第二章：宗门封锁\n林舟改变追查路线。`
    const wrongMarkBody = `${shortBody}\n\n${progressLine(80, 100, 100)}`
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([wrongMarkBody]),
    })
    const harness = harnessWith()
    const command = makeCommand()

    const failure = await command.execute({ step: {}, context, callbacks }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PlotOutlineResumeAvailableError)
    const checkpointWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(checkpointWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: true,
      synopsis_range: { from: 1, to: 100 },
    }))
  })

  it.each([
    ['empty entry bodies', `第1章：启程\n第2章：抵达`],
    ['out-of-order entries', `第2章：抵达\n港口的阻力迫使主角改变计划。\n第1章：启程\n主角从故乡出发并承担选择的代价。`],
  ])('does not report malformed %s as complete or automatically resumable', async (_caseName, entries) => {
    const response = `${'卷首背景。'.repeat(40)}\n${entries}\n${progressLine(1, 2, 100)}`
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream: responseStream([response]) })
    const harness = harnessWith()

    const failure = await makeCommand({ synopsisRange: { from: 1, to: 2 } })
      .execute({ step: {}, context, callbacks })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(PlotOutlineResumeAvailableError)
    expect(String((failure as Error).message)).toContain('不能自动续写')
    expect(harness.partialWrites).toHaveLength(0)
    expect(harness.synopsisCommits).toHaveLength(0)
  })

  it.each([
    ['缺少末章', '第1–99章：连续推进\n主角沿既定因果逐章推进。', true],
    ['重复章', '第1–100章：连续推进\n主角沿既定因果逐章推进。\n\n第100章：重复终局\n再次写入同一终局。', false],
    ['越界章', '第1–100章：连续推进\n主角沿既定因果逐章推进。\n\n第101章：越过范围\n写入全书范围外的事件。', false],
  ] as const)('标题覆盖%s：只为合法连续前缀提供自动恢复', async (_caseName, headings, resumable) => {
    const body = `## 第一卷\n\n${headings}\n\n${'每一段都保留角色行动、条件与后果的连续关系。'.repeat(6)}`
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([`${body}\n\n${progressLine(1, 100, 100)}`]),
    })
    const harness = harnessWith()

    const failure = await makeCommand().execute({ step: {}, context, callbacks }).catch((error: unknown) => error)

    if (resumable) {
      expect(failure).toBeInstanceOf(PlotOutlineResumeAvailableError)
      expect(harness.partialWrites.at(-1)).toEqual(expect.objectContaining({ synopsis_incomplete: true }))
      expect(harness.coreUpdates.at(-1)?.synopsis).toContain('本大纲未完成')
    } else {
      expect(failure).not.toBeInstanceOf(PlotOutlineResumeAvailableError)
      expect(String((failure as Error).message)).toContain('不能自动续写')
      expect(harness.partialWrites).toHaveLength(0)
      expect(harness.coreUpdates).toHaveLength(0)
    }
  })

  it('不足 120 字的错误标题覆盖不宣称可恢复，也不写检查点或 DB', async () => {
    const body = `第1章：开端。\n\n${progressLine(1, 100, 100)}`
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream: responseStream([body]) })
    const harness = harnessWith()

    const failure = await makeCommand().execute({ step: {}, context, callbacks }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(PlotOutlineResumeAvailableError)
    expect(String((failure as Error).message)).toContain('不能自动续写')
    expect(harness.partialWrites).toHaveLength(0)
    expect(harness.coreUpdates).toHaveLength(0)
  })

  it('检查点正文与 DB 渲染正文不一致时，即使 DB hash 匹配也在模型调用前拒绝', async () => {
    const originalBody = `## 第一卷\n\n第1–3章：${'林舟连续追查灵脉异变并记录每一步因果。'.repeat(5)}`
    const corruptedBody = originalBody.replace('灵脉异变', '另一条旧线索')
    const dbOutline = `# 情节大纲\n\n${originalBody}\n\n> ⚠️ **本大纲未完成**：生成被输出长度中断，以上为已自动保存的已完成部分。\n> 可在「AI 输出」提示处点击「继续生成情节大纲」，从断点续写补齐本批章节。`
    const harness = harnessWith({
      synopsis_result: corruptedBody,
      synopsis_incomplete: true,
      synopsis_range: { from: 1, to: 100 },
      synopsis_facts_fingerprint: currentFingerprint({ from: 1, to: 100 }),
      synopsis_db_hash: dbHashOf(dbOutline),
      synopsis_step_guidance: '',
    }, dbOutline)
    const generateStream = vi.fn()
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })

    await expect(makeCommand({ resumeSynopsis: true }).execute({ step: {}, context, callbacks }))
      .rejects.toThrow('检查点正文与数据库原文不一致')
    expect(generateStream).not.toHaveBeenCalled()
    expect(harness.partialWrites).toHaveLength(0)
  })

  it('CAS 冲突按 UI 语言报错，并只回滚本次 synopsis 字段而保留同期其他阶段字段', async () => {
    context.uiLocale = 'en-US'
    const oldBody = '旧的大纲检查点正文'
    const harness = harnessWith({
      synopsis_result: oldBody,
      synopsis_incomplete: false,
      synopsis_covered_to: 100,
      synopsis_range: { from: 1, to: 100 },
      synopsis_facts_fingerprint: 'old-fingerprint',
      world_building_result: 'old world phase',
    }, '', {
      commitResult: { success: false, error: '项目数据已变化，已拒绝覆盖情节大纲' },
      concurrentPartialUpdate: { world_building_result: 'concurrent world phase' },
    })
    const body = `第1–100章：完整终局\n${'主角遵循明确条件行动，结果逐章承接至终局。'.repeat(5)}`
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: responseStream([`${body}\n\n${progressLine(1, 100, 100)}`]),
    })

    await expect(makeCommand().execute({ step: {}, context, callbacks }))
      .rejects.toThrow('Project data changed while the outline was being generated')

    expect(harness.synopsisCommits).toHaveLength(1)
    expect(harness.partialWrites.at(-1)).toEqual(expect.objectContaining({
      synopsis_result: oldBody,
      synopsis_incomplete: false,
      world_building_result: 'concurrent world phase',
    }))
    expect(harness.coreUpdates).toHaveLength(0)
  })

  it.each([
    ['completed result', true],
    ['interrupted result', false],
  ] as const)('rolls back only this run checkpoint when cancellation arrives after saving a %s', async (
    _caseName,
    complete,
  ) => {
    const oldCheckpoint: CheckpointSnapshot = {
      synopsis_result: '作者原有的大纲检查点',
      synopsis_incomplete: false,
      synopsis_covered_to: 20,
      synopsis_range: { from: 1, to: 20 },
      synopsis_facts_fingerprint: 'old-fingerprint',
      synopsis_body_hash: 'old-body-hash',
      synopsis_db_hash: 'old-db-hash',
      synopsis_step_guidance: '原有指导',
      world_building_result: 'old world phase',
    }
    const body = `第1–100章：完整终局\n${'主角依据已确认事实行动，并使后果逐章承接至终局。'.repeat(8)}`
    const response = complete ? `${body}\n\n${progressLine(1, 100, 100)}` : body
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream: responseStream([response]) })
    const harness = harnessWith(oldCheckpoint, '作者原有的数据库大纲', {
      afterPartialWrite: (_checkpoint, writeCount) => {
        if (writeCount !== 1) return undefined
        context.cancelled = true
        return { world_building_result: 'concurrent world phase' }
      },
    })

    await expect(makeCommand().execute({ step: {}, context, callbacks }))
      .rejects.toThrow('工作流已取消')

    expect(harness.synopsisCommits).toHaveLength(0)
    expect(harness.partialWrites).toHaveLength(2)
    expect(harness.partialWrites.at(-1)).toEqual(expect.objectContaining({
      ...oldCheckpoint,
      world_building_result: 'concurrent world phase',
    }))
  })

  it('恢复沿用检查点保存的 step guidance，不读取恢复时的新指导', async () => {
    const partialBody = `第1–3章：旧指导开局\n${'林舟沿旧指导推进灵脉调查，动作与结果连续。'.repeat(6)}`
    const addition = `\n\n第4–100章：后续终局\n后续因果连续推进至终局。\n\n${progressLine(1, 100, 100)}`
    const prompts: string[] = []
    let callIndex = 0
    useLLMStore.setState({
      defaultModelId: 'model-1',
      generateStream: vi.fn((messages, streamCallbacks) => {
        prompts.push(messages.map((message: { content: string }) => message.content).join('\n'))
        const output = callIndex++ === 0 ? partialBody : addition
        streamCallbacks.onDone?.(output, undefined, 'stop')
        return Promise.resolve(`plot-request-${callIndex}`)
      }),
    })
    const harness = harnessWith()
    context.data.stepGuidance = { synopsis: '只属于旧检查点的指导' }
    await expect(makeCommand().execute({ step: {}, context, callbacks }))
      .rejects.toBeInstanceOf(PlotOutlineResumeAvailableError)
    context.data.stepGuidance = { synopsis: '恢复时新增但不应使用的指导' }

    await makeCommand({ resumeSynopsis: true }).execute({ step: {}, context, callbacks })

    expect(prompts[1]).toContain('只属于旧检查点的指导')
    expect(prompts[1]).not.toContain('恢复时新增但不应使用的指导')
    expect(harness.synopsisCommits).toHaveLength(2)
  })

  it.each([
    ['duplicate chapter', `第1章：铁砧镇\n${'林舟沿灵脉追查宗门封锁的原因。'.repeat(10)}\n第1章：重复开章\n同一章被再次输出。`],
    ['out-of-range chapter', `第1–100章：完整范围\n${'林舟沿灵脉追查宗门封锁的原因。'.repeat(10)}\n第101章：越界\n模型越过了全书范围。`],
  ])('does not persist a resumable checkpoint when a length continuation fails with a %s partial', async (
    _caseName,
    malformedPartial,
  ) => {
    const generateStream = lengthThenNetworkFailure(malformedPartial)
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const harness = harnessWith()

    const failure = await makeCommand().execute({ step: {}, context, callbacks }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(PlotOutlineResumeAvailableError)
    expect(String((failure as Error).message)).toContain('不能自动续写')
    expect(harness.partialWrites).toHaveLength(0)
    expect(harness.synopsisCommits).toHaveLength(0)
  })

  it('P1：续写请求本身失败时，首轮收到的超限正文仍被保存为检查点', async () => {
    // 第一轮返回了超过阈值的有效正文且 finishReason=length；第二轮（自动续写）
    // 请求抛网络错误。此前会丢掉首轮内容，现在应保存并可断点续写。
    const firstBody = `## 第一卷\n\n第一章：铁砧镇的学徒\n${'宗门封锁前夜，林舟发现了旧铁锤里的秘密。'.repeat(8)}\n\n第二章：被长度上限截断`
    const generateStream = lengthThenNetworkFailure(firstBody)
    useLLMStore.setState({ defaultModelId: 'model-1', generateStream })
    const harness = harnessWith()
    const command = makeCommand()

    const failure = await command.execute({ step: {}, context, callbacks }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PlotOutlineResumeAvailableError)
    const checkpointWrite = harness.partialWrites[harness.partialWrites.length - 1]
    expect(checkpointWrite).toEqual(expect.objectContaining({
      synopsis_incomplete: true,
      synopsis_range: { from: 1, to: 100 },
      synopsis_result: expect.stringContaining('第一章：铁砧镇的学徒') as never,
    }))
  })
})
