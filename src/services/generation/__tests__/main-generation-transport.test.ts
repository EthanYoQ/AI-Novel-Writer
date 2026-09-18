import { afterEach, expect, it, vi } from 'vitest'
import { createMainGenerationTransport } from '../main-generation-transport'
import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationSnapshot } from '../generation-runtime'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { BeginGenerationRequest } from '../../../shared/generation-owner-contract'

const session: ProjectSessionContext = { projectId: '项目甲', leaseId: '会话甲', projectPath: 'C:/合成项目甲' }
const handle: MainGenerationRunHandle = { projectId: '项目甲', epoch: '会话甲', rootActionId: '根甲', runId: '运行甲' }
const view: MainGenerationRunView = { handle, budget: { maxAttempts: 2, maxRequestedOutputTokens: 100, maxRequestedOutputTokensPerAttempt: 50, deadlineAt: 1000 }, status: 'running', nonReplayable: false, artifacts: [] }
const intent: BeginGenerationRequest = { operation: '正文', uiActionNonce: '点击甲', modelId: '模型甲', selectedDraftIds: [], selectedFinalizedDraftIds: [], promptKeys: [], skillStages: [], output: 'visible-text' }
function fixture() {
  let active: ProjectSessionContext | null = { ...session }
  let listener: (snapshot: MainGenerationSnapshot) => void = () => {}
  const unsubscribe = vi.fn()
  const invoke = vi.fn(async (channel: string) => channel === 'generation:list' ? [structuredClone(view)] : channel === 'generation:execute' ? { outcome: { status: 'incomplete', finishReason: 'unknown' }, run: structuredClone(view) } : structuredClone(view))
  const on = vi.fn((_channel, callback) => { listener = callback; return unsubscribe })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on } })
  const capture = vi.fn(() => active)
  const transport = createMainGenerationTransport(capture)
  return { transport, invoke, on, unsubscribe, capture, activate: (next: ProjectSessionContext | null) => { active = next }, emit: (value: MainGenerationSnapshot) => listener(value) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('构造及安装对象无IPC；begin显式冻结session和语义intent', async () => {
  const f = fixture(); expect(f.capture).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled()
  const mutable = { ...session }, request = structuredClone(intent)
  const result = f.transport.begin(mutable, request)
  mutable.leaseId = '后来会话'; request.selectedDraftIds.push(99)
  await result
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith('generation:begin', intent, session)
})
it('读取时捕获的session不会被稍后currentproject替换，execute只发一次', async () => {
  const f = fixture(); await f.transport.read(handle)
  f.activate({ projectId: '项目乙', leaseId: '会话乙', projectPath: 'C:/合成项目乙' })
  const request = { handle, invocationNonce: '原点击', task: { purpose: '正文', output: 'visible-text' as const, messages: [{ role: 'user' as const, content: '铜钥匙' }] } }
  await f.transport.execute(request)
  expect(f.invoke).toHaveBeenLastCalledWith('generation:execute', request, session)
  expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')).toHaveLength(1)
})
it('新会话可读旧epoch历史，但不能借read授权执行；resume沿显式当前session重新授权', async () => {
  const f = fixture(); f.activate({ ...session, leaseId: '新会话' })
  await f.transport.read(handle)
  expect(f.invoke).toHaveBeenCalledWith('generation:read', handle, { ...session, leaseId: '新会话' })
  await expect(f.transport.execute({ handle, invocationNonce: '点击', task: { purpose: '正文', output: 'visible-text', messages: [] } })).rejects.toThrow('MISMATCH')
  const current = { ...session, leaseId: '新会话' }
  f.invoke.mockResolvedValueOnce({ ...view, handle: { ...handle, epoch: '新会话' } })
  await f.transport.resume(current, handle)
  expect(f.invoke).toHaveBeenLastCalledWith('generation:resume', handle, current)
  await expect(f.transport.resume({ ...current, projectId: '外项目' }, handle)).rejects.toThrow('MISMATCH')
  expect(f.invoke).toHaveBeenCalledTimes(2)
})
it('外项目handle在invoke前拒绝，list冻结显式session', async () => {
  const f = fixture()
  await expect(f.transport.read({ ...handle, projectId: '外项目' })).rejects.toThrow('MISMATCH')
  const mutable = { ...session }; const promise = f.transport.list(mutable); mutable.projectId = '后来项目'
  await promise
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith('generation:list', session)
})
it('snapshot按完整handle筛选，退订后迟到事件不再投影', () => {
  const f = fixture(); const received = vi.fn(); const stop = f.transport.subscribe(handle, received)
  const snapshot: MainGenerationSnapshot = { ...handle, artifactId: '候选', attemptId: '请求', text: '雨夜', textHash: 'a'.repeat(64), revision: 1, durableRevision: 1, status: 'running' }
  for (const key of ['projectId', 'epoch', 'rootActionId', 'runId']) f.emit({ ...snapshot, [key]: '外来' })
  expect(received).not.toHaveBeenCalled(); f.emit(snapshot); expect(received).toHaveBeenCalledExactlyOnceWith(snapshot)
  stop(); stop(); f.emit(snapshot); expect(received).toHaveBeenCalledTimes(1); expect(f.unsubscribe).toHaveBeenCalledTimes(1)
})
it('transport失败不重发unknown请求，不改nonce也不另发cancel', async () => {
  const f = fixture(); f.invoke.mockRejectedValue(new Error('回包丢失'))
  await expect(f.transport.execute({ handle, invocationNonce: '原点击', task: { purpose: '正文', output: 'visible-text', messages: [] } })).rejects.toThrow('回包丢失')
  expect(f.invoke).toHaveBeenCalledTimes(1)
})
it('restart及discard沿显式新session，旧候选仍由main重新验证', async () => {
  const f = fixture(); const current = { ...session, leaseId: '新会话' }
  f.invoke.mockResolvedValueOnce({ ...view, handle: { ...handle, epoch: '新会话', rootActionId: '新根' } })
  await f.transport.restart(current, handle, intent)
  expect(f.invoke).toHaveBeenLastCalledWith('generation:restart', handle, intent, current)
  await f.transport.discard(current, handle, '候选甲')
  expect(f.invoke).toHaveBeenLastCalledWith('generation:discard-candidate', handle, '候选甲', current)
})
it('返回外项目view不能污染绑定或被当作当前运行', async () => {
  const f = fixture(); f.invoke.mockResolvedValueOnce({ ...view, handle: { ...handle, projectId: '外项目' } })
  await expect(f.transport.read(handle)).rejects.toThrow('RESPONSE_IDENTITY_MISMATCH')
})


it('resume freezes the explicit current session and rejects a replaced root', async () => {
  const f = fixture(), current = { ...session, leaseId: '新会话' }
  f.invoke.mockResolvedValueOnce({ ...view, handle: { ...handle, epoch: '新会话', rootActionId: '外来根' } })
  const pending = f.transport.resume(current, handle)
  current.leaseId = '后来会话'
  await expect(pending).rejects.toThrow('RESPONSE_IDENTITY_MISMATCH')
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith('generation:resume', handle, { ...session, leaseId: '新会话' })
})
