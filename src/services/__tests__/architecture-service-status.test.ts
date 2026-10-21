import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: invoke } }))

import { checkArchConfirmed, checkArchStatus } from '../architecture-service'
import { PLOT_OUTLINE_PROTOCOL, renderPlotOutlineRange, renderPlotOutlineSynopsis } from '../../shared/plot-outline-contract'
import { outlineProgress, synopsisFactsFingerprint } from '../../shared/plot-outline-checkpoint'

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const LONG = '内容。'.repeat(30)
const body = Array.from({ length: 16 }, (_, index) => `## 第${index + 1}章：灯${index + 1}\n守灯人记下第${index + 1}夜的来船。`).join('\n\n')
const partialOutline = renderPlotOutlineSynopsis(body, 16, { totalChapters: 24, writingLanguage: 'zh-CN' })
const batchCheckpoint = {
  synopsis_result: body, synopsis_incomplete: false, synopsis_covered_to: 16, synopsis_range: { from: 11, to: 16 },
  synopsis_db_hash: synopsisFactsFingerprint([partialOutline]),
}

let synopsis: string
let partial: Record<string, unknown> | null

beforeEach(() => {
  synopsis = LONG
  partial = null
  invoke.mockReset()
  invoke.mockImplementation(async (_session: unknown, channel: string) => {
    if (channel === 'db:project-core-get') return { premise: LONG, worldbuilding: LONG, synopsis, totalChapters: 24, writingLanguage: 'zh-CN' }
    if (channel === 'fs:read-json') return partial ? { success: true, data: partial } : { success: false, error: 'not found' }
    return { status: 'ready' }
  })
})

describe('旧外壳侧栏的架构状态：有内容就算已生成', () => {
  it('分批写到第 16 章的大纲有内容，算已生成（侧栏据此显示勾与清空入口）', async () => {
    synopsis = partialOutline
    partial = batchCheckpoint
    expect(await checkArchStatus(session)).toEqual({ premise: true, characters: true, worldbuilding: true, synopsis: true })
    expect(invoke.mock.calls.some(([, channel]) => channel === 'fs:read-json')).toBe(false)
  })
})

describe('流程脊的架构四节是否已确认：与架构页徽标同一判定', () => {
  it('分批检查点写到第 16 章（全书 24 章）：大纲未确认', async () => {
    synopsis = partialOutline
    partial = batchCheckpoint
    expect(await checkArchConfirmed(session)).toEqual({ premise: true, characters: true, worldbuilding: true, synopsis: false })
  })

  it('有一批被打断（检查点 incomplete 且带运行记录）：大纲未确认', async () => {
    synopsis = partialOutline
    partial = { synopsis_protocol: PLOT_OUTLINE_PROTOCOL, synopsis_incomplete: true, synopsis_generation_handle: { runId: 'r' }, synopsis_covered_to: 0, synopsis_range: { from: 1, to: 5 } }
    expect((await checkArchConfirmed(session)).synopsis).toBe(false)
  })

  it('分批写满全书或没有分批检查点：大纲已确认', async () => {
    synopsis = LONG
    expect((await checkArchConfirmed(session)).synopsis).toBe(true)
    synopsis = renderPlotOutlineSynopsis(body, 24, { totalChapters: 24, writingLanguage: 'zh-CN' })
    partial = { ...batchCheckpoint, synopsis_covered_to: 24, synopsis_range: { from: 21, to: 24 }, synopsis_db_hash: synopsisFactsFingerprint([synopsis]) }
    expect((await checkArchConfirmed(session)).synopsis).toBe(true)
  })

  it('正文里留着分批标记、但作者在末尾补写过（主进程已不能紧接续写）：未确认，按接不上续写算', async () => {
    synopsis = `${partialOutline}\n\n作者补的一句。`
    partial = batchCheckpoint
    expect(outlineProgress(synopsis, partial, 'zh-CN', 24)).toEqual({ kind: 'unresumable' })
    expect((await checkArchConfirmed(session)).synopsis).toBe(false)
  })

  it('分批写到第 16 章后重写第 1–5 章：检查点记成本批终章第 5 章，大纲仍按正式大纲算写到第 16 章', async () => {
    const rewritten = Array.from({ length: 5 }, (_, index) => `## 第${index + 1}章：新灯${index + 1}\n守灯人重写第${index + 1}夜。`).join('\n\n')
    const expected = { synopsis: partialOutline, totalChapters: 24, writingLanguage: 'zh-CN' as const }
    synopsis = renderPlotOutlineRange(rewritten, { from: 1, to: 5 }, expected)
    // executeChapterOutline 提交后 saveNavigation(outline, true) 写下的检查点。
    partial = {
      synopsis_protocol: PLOT_OUTLINE_PROTOCOL, synopsis_incomplete: false, synopsis_range: { from: 1, to: 5 }, synopsis_covered_to: 5,
      synopsis_result: rewritten, synopsis_body_hash: synopsisFactsFingerprint([rewritten]), synopsis_db_hash: synopsisFactsFingerprint([synopsis]),
    }
    expect(outlineProgress(synopsis, partial, 'zh-CN', 24)).toEqual({ kind: 'partial', coveredTo: 16, total: 24 })
    expect((await checkArchConfirmed(session)).synopsis).toBe(false)
  })

  it('检查点可用时与正式大纲给出同一进度', () => {
    expect(outlineProgress(partialOutline, batchCheckpoint, 'zh-CN', 24)).toEqual({ kind: 'partial', coveredTo: 16, total: 24 })
    expect(outlineProgress(partialOutline, null, 'zh-CN', 24)).toEqual({ kind: 'partial', coveredTo: 16, total: 24 })
  })

  it('作者手写、只列了部分章的大纲不算分批没写完', () => {
    const sparse = `# 情节大纲\n\n${[1, 5, 12].map(n => `## 第${n}章：转折${n}\n这一章发生的大事。`).join('\n\n')}`
    expect(outlineProgress(sparse, null, 'zh-CN', 24)).toEqual({ kind: 'complete' })
  })

  it('只有空白（超过 50 个字符）与没有内容一样未确认', async () => {
    const blank = ' \n'.repeat(40)
    invoke.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:project-core-get') return { premise: blank, worldbuilding: blank, synopsis: blank, totalChapters: 24, writingLanguage: 'zh-CN' }
      if (channel === 'fs:read-json') return { success: false, error: 'not found' }
      return { status: 'ready' }
    })
    expect(await checkArchConfirmed(session)).toEqual({ premise: false, characters: true, worldbuilding: false, synopsis: false })
  })

  it('没有内容：未确认', async () => {
    synopsis = ''
    expect((await checkArchConfirmed(session)).synopsis).toBe(false)
  })
})
