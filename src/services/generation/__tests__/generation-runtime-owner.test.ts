import { describe, expect, it, vi } from 'vitest'
import { createGenerationRuntime as createFacade, createMainOwnedGenerationRuntime as createGenerationRuntime, listMainGenerationRuns, readMainGenerationRun, type MainGenerationRunHandle, type MainGenerationRunView, type MainGenerationSnapshot, type MainGenerationTransport } from '../generation-runtime'
import type { GenerationOutcome, GenerationTask } from '../generation-harness'
import { hashAuthorText } from '../../../shared/source-ref'
import { useLLMStore } from '../../../stores/llm-store'

const handle: MainGenerationRunHandle = { projectId: '项目甲', epoch: '打开甲', rootActionId: '动作甲', runId: '运行甲' }
const task: GenerationTask = { purpose: '正文', output: 'visible-text', messages: [{ role: 'user', content: '续写铜钥匙的故事' }] }
function fixture() {
  let listener: ((snapshot: MainGenerationSnapshot) => void) | undefined
  const view: MainGenerationRunView = { handle, budget: { maxAttempts: 4, maxRequestedOutputTokens: 10000, maxRequestedOutputTokensPerAttempt: 2000, deadlineAt: 50000 }, status: 'running', nonReplayable: false, artifacts: [] }
  const outcome: GenerationOutcome = { status: 'incomplete', content: '雨夜来信', finishReason: 'unknown', receipt: {
    model: { id: '模型甲', configurationRevision: 'a'.repeat(64), endpointFingerprint: 'b'.repeat(64) },
    capabilities: { contextWindowTokens: null, maxOutputTokens: 2000, reasoning: null, structuredOutput: null, usage: null, source: { contextWindowTokens: 'unknown', maxOutputTokens: 'legacy-profile', featureFlags: 'unknown' } },
    budget: { attempt: 1, maxAttempts: 4, requestedOutputTokens: 2000, cumulativeRequestedOutputTokens: 2000, maxRequestedOutputTokens: 10000, maxRequestedOutputTokensPerAttempt: 2000, deadlineAt: 50000 }, finishReason: 'unknown',
  } }
  const detach = vi.fn()
  const transport: MainGenerationTransport = {
    read: vi.fn(async () => structuredClone(view)), list: vi.fn(async () => [structuredClone(view)]),
    execute: vi.fn(async () => ({ outcome: structuredClone(outcome), run: structuredClone(view) })),
    cancel: vi.fn(async () => ({ ...structuredClone(view), status: 'cancelled' as const })),
    subscribe: vi.fn((_handle, callback) => { listener = callback; return detach }),
  }
  return { transport, view, outcome, detach, emit: (snapshot: MainGenerationSnapshot) => listener!(snapshot) }
}
async function snapshot(text = '雨夜', revision = 1, durableRevision = revision): Promise<MainGenerationSnapshot> {
  return { ...handle, artifactId: '候选甲', attemptId: '请求甲', text, revision, durableRevision, textHash: await hashAuthorText(text), status: 'running' }
}

describe('main owned generation facade', () => {
  it('仅转发主进程句柄和语义请求，不经旧模型store或新预算', async () => {
    const f = fixture(); const oldProvider = vi.spyOn(useLLMStore.getState(), 'generateStream')
    try {
      const runtime = await createFacade({ runHandle: handle }, f.transport)
      const result = await runtime.execute(({ session }) => session.complete(task, { invocationNonce: '点击甲' }))
      expect(result).toEqual(f.outcome)
      expect(f.transport.execute).toHaveBeenCalledExactlyOnceWith({ handle, invocationNonce: '点击甲', task })
      expect(oldProvider).not.toHaveBeenCalled()
      await runtime.close(); await runtime.close()
      expect(f.detach).toHaveBeenCalledTimes(1); expect(f.transport.cancel).not.toHaveBeenCalled()
    } finally { oldProvider.mockRestore() }
  })
  it('缺失transport或nonce拒绝，不生成空指纹/新动作', async () => {
    await expect(createGenerationRuntime({ runHandle: handle })).rejects.toThrow('TRANSPORT_REQUIRED')
    const f = fixture(); const runtime = await createGenerationRuntime({ runHandle: handle }, f.transport)
    await expect(runtime.execute(({ session }) => session.complete(task))).rejects.toThrow('NONCE_REQUIRED')
    expect(f.transport.execute).not.toHaveBeenCalled(); await runtime.close()
  })
  it('不接收renderer预算覆盖，不对未知请求自行重试', async () => {
    const f = fixture()
    await expect(createGenerationRuntime({ runHandle: handle, budget: {} } as never, f.transport)).rejects.toThrow('CONTROLS_BUDGET')
    const runtime = await createGenerationRuntime({ runHandle: handle }, f.transport)
    await runtime.execute(({ session }) => session.complete(task, { invocationNonce: '原点击' }))
    expect(f.transport.execute).toHaveBeenCalledTimes(1)
    await runtime.close()
  })
  it('同nonce原样传递给主owner幂等读取，facade不派生新attempt', async () => {
    const f = fixture(); const runtime = await createGenerationRuntime({ runHandle: handle }, f.transport)
    const call = () => runtime.execute(({ session }) => session.complete(task, { invocationNonce: '原点击' }))
    expect(await call()).toEqual(await call())
    expect(vi.mocked(f.transport.execute).mock.calls.map(([request]) => request.invocationNonce)).toEqual(['原点击', '原点击'])
    await runtime.close()
  })
  it('主进程全文快照单调显示，乱序重复不能回退durable前缀', async () => {
    const f = fixture(); const shown = vi.fn(); const runtime = await createGenerationRuntime({ runHandle: handle, onSnapshot: shown }, f.transport)
    f.emit(await snapshot('雨夜来信', 2)); f.emit(await snapshot('雨夜', 1)); f.emit(await snapshot('雨夜来信', 2))
    await runtime.read()
    expect(shown).toHaveBeenCalledTimes(1)
    expect(shown).toHaveBeenCalledWith(expect.objectContaining({ text: '雨夜来信', durableRevision: 2 }))
    await runtime.close()
  })
  it.each(['epoch', 'hash', 'prefix', 'attempt'] as const)('拒绝%s冲突快照，停止后续execute', async mutation => {
    const f = fixture(); const runtime = await createGenerationRuntime({ runHandle: handle }, f.transport)
    f.emit(await snapshot()); await runtime.read()
    const next = await snapshot(mutation === 'prefix' ? '晴天' : '雨夜来信', 2)
    if (mutation === 'epoch') next.epoch = '旧会话'
    if (mutation === 'hash') next.textHash = 'f'.repeat(64)
    if (mutation === 'attempt') next.attemptId = '另一请求'
    f.emit(next)
    await expect(runtime.read()).rejects.toThrow()
    await expect(runtime.execute(({ session }) => session.complete(task, { invocationNonce: '新点击' }))).rejects.toThrow()
    expect(f.transport.execute).not.toHaveBeenCalled(); await runtime.close()
  })
  it('显式取消仅调用主owner，关闭只是脱离观察', async () => {
    const f = fixture(); const runtime = await createGenerationRuntime({ runHandle: handle }, f.transport)
    expect((await runtime.cancel()).status).toBe('cancelled')
    expect(f.transport.cancel).toHaveBeenCalledExactlyOnceWith(handle)
    await runtime.close()
    await expect(runtime.read()).rejects.toThrow('已关闭')
  })
  it('便携历史只能读取不自动重放，两个壳消费相同read/list', async () => {
    const f = fixture(); f.view.nonReplayable = true
    const runtime = await createGenerationRuntime({ runHandle: handle }, f.transport)
    await expect(runtime.execute(({ session }) => session.complete(task, { invocationNonce: '旧点击' }))).rejects.toThrow('NON_REPLAYABLE')
    expect(await readMainGenerationRun(f.transport, handle)).toEqual(f.view)
    expect(await listMainGenerationRuns(f.transport, { projectId: handle.projectId, projectPath: '合成项目', leaseId: '会话' })).toEqual([f.view])
    expect(f.transport.execute).not.toHaveBeenCalled(); await runtime.close()
  })
  it('read失败释放订阅，不把主进程错误改成空运行', async () => {
    const f = fixture(); vi.mocked(f.transport.read).mockRejectedValue(new Error('磁盘失败'))
    await expect(createGenerationRuntime({ runHandle: handle }, f.transport)).rejects.toThrow('磁盘失败')
    expect(f.detach).toHaveBeenCalledTimes(1)
  })
  it('网络响应丢失不自动重发，也不取消或释放根预算', async () => {
    const f = fixture(); vi.mocked(f.transport.execute).mockRejectedValue(new Error('回包丢失'))
    const runtime = await createGenerationRuntime({ runHandle: handle }, f.transport)
    await expect(runtime.execute(({ session }) => session.complete(task, { invocationNonce: '发送甲' }))).rejects.toThrow('回包丢失')
    expect(f.transport.execute).toHaveBeenCalledTimes(1)
    await runtime.close(); expect(f.transport.cancel).not.toHaveBeenCalled()
  })
  it('旧delta和AbortSignal接口必须显式迁移，不能形成第二取消owner', async () => {
    const f = fixture(); const runtime = await createGenerationRuntime({ runHandle: handle }, f.transport)
    await expect(runtime.execute(({ session }) => session.complete(task, { invocationNonce: '点击甲', onChunk: vi.fn() }))).rejects.toThrow('SNAPSHOT_CALLBACK')
    await expect(runtime.execute(({ session }) => session.complete(task, { invocationNonce: '点击甲', signal: new AbortController().signal }))).rejects.toThrow('EXPLICIT_ACTION')
    expect(f.transport.execute).not.toHaveBeenCalled(); await runtime.close()
  })
  it('新attempt独立全文展示，不与前一候选拼接；关闭后迟到事件不更新UI', async () => {
    const f = fixture(); const shown = vi.fn(); const runtime = await createGenerationRuntime({ runHandle: handle, onSnapshot: shown }, f.transport)
    f.emit(await snapshot('雨夜'))
    f.emit({ ...await snapshot('清晨'), artifactId: '候选乙', attemptId: '请求乙' })
    await runtime.read()
    expect(shown.mock.calls.map(([value]) => value.text)).toEqual(['雨夜', '清晨'])
    await runtime.close(); f.emit(await snapshot('雨夜来信', 2))
    await Promise.resolve()
    expect(shown).toHaveBeenCalledTimes(2)
  })

  it('终态候选即使status不变也不能推进revision或追加正文', async () => {
    const f = fixture(); const shown = vi.fn(); const runtime = await createGenerationRuntime({ runHandle: handle, onSnapshot: shown }, f.transport)
    f.emit({ ...await snapshot('甲'), status: 'completed' }); await runtime.read()
    f.emit({ ...await snapshot('甲乙', 2), status: 'completed' })
    await expect(runtime.read()).rejects.toThrow('REGRESSION')
    expect(shown).toHaveBeenCalledTimes(1); await runtime.close()
  })
  it('hash验证挂起时关闭runtime，验证完成后仍不得通知UI', async () => {
    const f = fixture(); const shown = vi.fn(); const runtime = await createGenerationRuntime({ runHandle: handle, onSnapshot: shown }, f.transport)
    const value = await snapshot('雨夜')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.text))
    let resume!: (value: ArrayBuffer) => void
    const gate = new Promise<ArrayBuffer>(resolve => { resume = resolve })
    const hashing = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => gate)
    try {
      f.emit(value); await Promise.resolve()
      expect(hashing).toHaveBeenCalledTimes(1)
      await runtime.close(); resume(digest)
      await gate; await Promise.resolve(); await Promise.resolve()
      expect(shown).not.toHaveBeenCalled()
    } finally { hashing.mockRestore() }
  })

})
