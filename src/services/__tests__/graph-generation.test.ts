import { afterEach, expect, it, vi } from 'vitest'
import { createGraphGeneration } from '../graph-generation'
const session = { projectId: '项目', leaseId: '会话3', projectPath: 'C:/合成剧情' }
const handle = { projectId: '项目', epoch: '会话1', rootActionId: '根', runId: '运行' }
const artifact = { artifactId: '候选', revision: 1, textHash: 'a'.repeat(64) }
const result = { kind: 'plan', candidates: [{ title: '线索甲' }, { title: '线索乙' }] }
const stored = { view: { handle, status: 'completed', artifacts: [] }, modelId: '原模型',
  context: { projectId: '项目', kind: 'plan', input: { kind: 'plan', chapterNumber: 2 } },
  attemptCount: 1, sourceStatus: 'current', artifact, result, effects: [] }
function setup(invoke: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } })
  return createGraphGeneration(session)
}
afterEach(() => vi.unstubAllGlobals())
it('原handle跨三个会话读取，仅核stable身份不猜中间epoch', async () => {
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => ({ ...stored, view: { ...stored.view, handle: { ...handle, epoch: '会话2' } } }))
  const client = setup(invoke)
  expect((await client.open({ handle })).view.handle.epoch).toBe('会话2')
  expect(invoke).toHaveBeenCalledTimes(1)
})
it.each(['projectId', 'rootActionId', 'runId'])('拒绝串用%s', async key => {
  const client = setup(vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => ({ ...stored, view: { ...stored.view, handle: { ...handle, [key]: '伪造' } } })))
  await expect(client.open({ handle })).rejects.toThrow('GRAPH_GENERATION_IDENTITY_MISMATCH')
})
it('已确认首项后仍确认原index1，不提交renderer候选内容', async () => {
  const effect = { success: true, kind: 'plan', index: 1, plan: { id: 9 } }
  const invoke = vi.fn(async (channel: string, request: unknown) => {
    if (channel === 'graph-generation:read') return { ...stored, effects: [{ success: true, kind: 'plan', index: 0, plan: { id: 8 } }] }
    expect(channel).toBe('graph-generation:confirm')
    expect(request).toEqual({ handle, artifact, index: 1 })
    return effect
  })
  const client = setup(invoke)
  await client.open({ handle })
  await expect(client.confirm(1)).resolves.toEqual(effect)
})
it('saved ACK在来源变化后仍只读，不再次confirm', async () => {
  const effect = { success: true, kind: 'plan', index: 0, plan: { id: 8 } }
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => ({ ...stored, sourceStatus: 'conflict', effects: [effect] }))
  const client = setup(invoke)
  await client.open({ handle })
  await expect(client.confirm(0)).resolves.toEqual(effect)
  expect(invoke.mock.calls.every(([channel]) => channel === 'graph-generation:read')).toBe(true)
})
it.each(['conflict', 'cancelled'])('%s原候选只读不可确认', async state => {
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => ({ ...stored, sourceStatus: state === 'conflict' ? state : 'current', view: { ...stored.view, status: state === 'cancelled' ? state : 'completed' } }))
  const client = setup(invoke)
  await client.open({ handle })
  await expect(client.confirm(0)).rejects.toThrow('GRAPH_GENERATION_NOT_CONFIRMABLE')
  expect(invoke.mock.calls.every(([channel]) => channel === 'graph-generation:read')).toBe(true)
})
it('unknown占位不可重发', async () => {
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => ({ ...stored, result: undefined, artifact: undefined }))
  const client = setup(invoke)
  await client.open({ handle })
  await expect(client.execute()).rejects.toThrow('GRAPH_GENERATION_OUTCOME_UNKNOWN')
  expect(invoke).toHaveBeenCalledTimes(1)
})
it('界面切换恢复对象时旧行的确认不能落到新run同序号', async () => {
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => stored)
  const client = setup(invoke)
  await client.open({ handle })
  await expect(client.confirm(0, { ...handle, runId: '另一运行' })).rejects.toThrow('GRAPH_GENERATION_IDENTITY_MISMATCH')
  expect(invoke.mock.calls.every(([channel]) => channel === 'graph-generation:read')).toBe(true)
})
it('卸载detach不取消main，且晚确认不能写', async () => {
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => stored)
  const client = setup(invoke)
  await client.open({ handle })
  client.detach()
  await expect(client.confirm(0)).rejects.toThrow('GRAPH_GENERATION_NOT_CONFIRMABLE')
  expect(invoke.mock.calls.every(([channel]) => channel === 'graph-generation:read')).toBe(true)
})
it('显式取消等待晚begin，取消确切原run而不execute', async () => {
  let release!: (value: typeof stored) => void
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'graph-generation:begin') return new Promise(resolve => { release = resolve })
    if (channel === 'graph-generation:cancel') return { ...stored.view, status: 'cancelled' }
    throw new Error(channel)
  })
  const client = setup(invoke)
  const opened = client.open({ input: { kind: 'plan', chapterNumber: 2 }, modelId: '原模型', uiActionNonce: '作者点击' })
  const failed = expect(opened).rejects.toThrow('GRAPH_GENERATION_CANCELLED')
  const cancelled = client.cancel()
  release(stored)
  await failed
  await cancelled
  expect(invoke.mock.calls.every(([channel]) => channel !== 'graph-generation:execute')).toBe(true)
})
