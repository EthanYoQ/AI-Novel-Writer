import { afterEach, expect, it, vi } from 'vitest'
import { createEditorInlineGeneration } from '../editor-inline-generation'

const session = { projectId: '项目', leaseId: '会话', projectPath: 'C:/合成项目' }
const handle = { projectId: '项目', epoch: '会话', rootActionId: '原预算', runId: '原运行' }
const input = { action: 'refine' as const, documentText: '甲😀乙', from: 1, to: 3, selectedText: '😀' }
async function recovery() {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.documentText))), byte => byte.toString(16).padStart(2, '0')).join('')
  return { view: { handle, status: 'running', artifacts: [] }, modelId: '原模型', sourceStatus: 'current', context: { ...input, kind: 'author-draft', documentHash: hash } }
}
function bridge(invoke: ReturnType<typeof vi.fn>) { vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } }) }
afterEach(() => vi.unstubAllGlobals())
it('原 UTF16 选区与原 handle 恢复，不创建模型或预算', async () => {
  const stored = await recovery()
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'editor-inline:read-recovery') return stored
    if (channel === 'editor-inline:execute') return { run: stored.view, outcome: { status: 'completed', content: '原回执', finishReason: 'stop' } }
    throw new Error(channel)
  })
  bridge(invoke)
  const client = createEditorInlineGeneration(session)
  expect((await client.open({ handle })).context.selectedText).toBe('😀')
  expect((await client.execute()).outcome.content).toBe('原回执')
  client.detach()
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['editor-inline:read-recovery', 'editor-inline:execute', 'editor-inline:read-recovery'])
})
it.each(['span', 'hash', 'identity'])('拒绝损坏的 %s 恢复上下文', async kind => {
  const stored = await recovery()
  if (kind === 'span') stored.context.to = 2
  if (kind === 'hash') stored.context.documentHash = 'a'.repeat(64)
  if (kind === 'identity') stored.view.handle = { ...handle, runId: '别的运行' }
  bridge(vi.fn(async () => stored))
  await expect(createEditorInlineGeneration(session).open({ handle })).rejects.toThrow()
})
it('begin 晚到仍取消 main，绝不 execute', async () => {
  const stored = await recovery()
  let resolve!: (value: unknown) => void
  const invoke = vi.fn(async (channel: string) => channel === 'editor-inline:begin' ? new Promise(r => { resolve = r }) : { handle, status: 'cancelled', artifacts: [] })
  bridge(invoke)
  const client = createEditorInlineGeneration(session)
  const opened = client.open({ input, modelId: '模型', uiActionNonce: '动作' })
  const rejected = expect(opened).rejects.toThrow('EDITOR_INLINE_CANCELLED')
  const cancelled = client.cancel()
  resolve(stored)
  await rejected; await cancelled
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['editor-inline:begin', 'editor-inline:cancel'])
})
it('卸载只 detach，晚到 begin 不取消持久工作也不 execute', async () => {
  const stored = await recovery()
  let resolve!: (value: unknown) => void
  const invoke = vi.fn(async () => new Promise(r => { resolve = r }))
  bridge(invoke)
  const client = createEditorInlineGeneration(session)
  const opened = client.open({ input, modelId: '模型', uiActionNonce: '动作' })
  const rejected = expect(opened).rejects.toThrow('EDITOR_INLINE_DETACHED')
  client.detach(); resolve(stored); await rejected
  expect(invoke).toHaveBeenCalledTimes(1)
})
it('source conflict 仍可读取，禁止执行', async () => {
  const stored = { ...await recovery(), sourceStatus: 'conflict' }
  const invoke = vi.fn(async () => stored)
  bridge(invoke)
  const client = createEditorInlineGeneration(session)
  await client.open({ handle })
  await expect(client.execute()).rejects.toThrow('EDITOR_INLINE_NOT_EXECUTABLE')
  expect(invoke).toHaveBeenCalledTimes(1)
})
it('begin 回执不能替换作者选定的动作', async () => {
  const stored = await recovery()
  bridge(vi.fn(async () => stored))
  await expect(createEditorInlineGeneration(session).open({ input: { ...input, action: 'expand' }, modelId: '模型', uiActionNonce: '动作' })).rejects.toThrow('EDITOR_INLINE_CONTEXT_MISMATCH')
})
it('主进程显式恢复更新 epoch，后续 read/cancel 使用原 run 当前身份', async () => {
  const stored = await recovery()
  const oldHandle = { ...handle, epoch: '旧会话' }
  let advanced = false
  const invoke = vi.fn(async (channel: string, request: unknown) => {
    if (channel === 'editor-inline:read-recovery') return { ...stored, view: { ...stored.view, handle: advanced ? handle : oldHandle } }
    if (channel === 'editor-inline:execute') { advanced = true; return { run: stored.view, outcome: { status: 'completed', finishReason: 'stop', content: '原结果' } } }
    if (channel === 'editor-inline:cancel') { expect(request).toEqual({ handle }); return { ...stored.view, status: 'cancelled' } }
    throw new Error(channel)
  })
  bridge(invoke)
  const client = createEditorInlineGeneration(session)
  await client.open({ handle: oldHandle })
  expect((await client.execute()).sourceStatus).toBe('current')
  await client.cancel()
})
it('生成期间来源变化：结果保留但 sourceStatus 禁止应用', async () => {
  const stored = await recovery()
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'editor-inline:begin') return stored
    if (channel === 'editor-inline:execute') return { run: stored.view, outcome: { status: 'completed', content: '可复制结果', finishReason: 'stop' } }
    return { ...stored, sourceStatus: 'conflict' }
  })
  bridge(invoke)
  const client = createEditorInlineGeneration(session)
  await client.open({ input, modelId: '模型', uiActionNonce: '动作' })
  const result = await client.execute()
  expect(result.outcome.content).toBe('可复制结果')
  expect(result.sourceStatus).toBe('conflict')
})
it('恢复 ACK 丢失后 old handle 可读同 run 持久 epoch，空 epoch 仍拒绝', async () => {
  const stored = await recovery()
  const invoke = vi.fn(async () => stored)
  bridge(invoke)
  const client = createEditorInlineGeneration(session)
  expect((await client.open({ handle: { ...handle, epoch: '原始epoch' } })).view.handle).toEqual(handle)
  invoke.mockResolvedValue({ ...stored, view: { ...stored.view, handle: { ...handle, epoch: '' } } })
  await expect(client.read()).rejects.toThrow('EDITOR_INLINE_IDENTITY_MISMATCH')
})

it('三会话重开接受 main 返回第二会话持久身份，read execute cancel 均保持原根和运行', async () => {
  const stored = await recovery()
  const persistedHandle = { ...handle, epoch: 'session-2' }
  const view = { ...stored.view, handle: persistedHandle }
  const invoke = vi.fn(async (channel: string, request: unknown) => {
    if (channel === 'editor-inline:read-recovery') return { ...stored, view }
    expect(request).toEqual({ handle: persistedHandle })
    if (channel === 'editor-inline:execute') return { run: view, outcome: { status: 'completed', content: '原回执', finishReason: 'stop' } }
    if (channel === 'editor-inline:cancel') return { ...view, status: 'cancelled' }
    throw new Error(channel)
  })
  bridge(invoke)
  const client = createEditorInlineGeneration({ ...session, leaseId: 'session-3' })
  expect((await client.open({ handle: { ...handle, epoch: 'session-1' } })).view.handle).toEqual(persistedHandle)
  expect((await client.read()).view.handle).toEqual(persistedHandle)
  expect((await client.execute()).outcome.content).toBe('原回执')
  await client.cancel()
})
it.each(['projectId', 'rootActionId', 'runId'] as const)('持久 epoch 不放宽 %s 身份', async field => {
  const stored = await recovery()
  bridge(vi.fn(async () => ({ ...stored, view: { ...stored.view, handle: { ...handle, epoch: 'session-2', [field]: '伪造' } } })))
  await expect(createEditorInlineGeneration({ ...session, leaseId: 'session-3' }).open({ handle: { ...handle, epoch: 'session-1' } })).rejects.toThrow('EDITOR_INLINE_IDENTITY_MISMATCH')
})
