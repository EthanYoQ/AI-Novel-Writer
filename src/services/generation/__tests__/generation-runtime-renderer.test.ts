import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelExecutionLeaseReceipt } from '../../../shared/ipc-channels'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (data: never) => void>(),
}))

vi.mock('../../ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    on: vi.fn((channel: string, callback: (data: never) => void) => {
      mocks.listeners.set(channel, callback)
      return () => mocks.listeners.delete(channel)
    }),
    get isElectron() { return true },
  },
}))

vi.mock('../../../components/ui/AlertDialog', () => ({ alertError: vi.fn() }))

import { useLLMStore } from '../../../stores/llm-store'
import { createGenerationRuntime } from '../generation-runtime'

const LEASE: ModelExecutionLeaseReceipt = {
  leaseId: 'opaque-main-process-lease',
  modelId: 'model-a',
  provider: 'custom',
  protocol: 'openai',
  modelName: 'model-a-v1',
  modelRevision: 'a'.repeat(64),
  endpointFingerprint: 'b'.repeat(64),
  capabilityEvidence: {
    source: {
      contextWindowTokens: 'unknown',
      maxOutputTokens: 'legacy-profile',
      featureFlags: 'unknown',
    },
    subjectFingerprint: 'c'.repeat(64),
    contextWindowTokens: null,
    maxOutputTokens: 4096,
    reasoning: null,
    structuredOutput: null,
    usage: null,
  },
  createdAt: 1000,
  expiresAt: 61_000,
}

describe('GenerationRuntime renderer lease adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
    useLLMStore.setState({
      defaultModelId: 'model-a',
      activeRequests: new Map(),
      loaded: true,
    })
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'llm:begin-execution-lease') return { success: true, lease: LEASE }
      if (channel === 'llm:close-execution-lease') return { success: true }
      if (channel === 'llm:generate-stream') {
        const requestId = String(args[0])
        queueMicrotask(() => {
          mocks.listeners.get('llm:stream-done')?.({
            requestId,
            fullText: 'leased completion',
            finishReason: 'stop',
          } as never)
        })
        return { requestId, started: true }
      }
      throw new Error(`unexpected channel: ${channel}`)
    })
  })

  it('binds begin, stream attempts, and close to one lease-authoritative IPC path', async () => {
    const runtime = await createGenerationRuntime({
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    useLLMStore.setState({ defaultModelId: 'model-b' })

    await runtime.execute(async ({ session }) => {
      const outcome = await session.complete({
        purpose: 'renderer-integration',
        output: 'visible-text',
        messages: [{ role: 'user', content: 'write' }],
      })
      expect(outcome.content).toBe('leased completion')
    })

    expect(mocks.invoke).toHaveBeenCalledWith('llm:begin-execution-lease', 'model-a')
    expect(mocks.invoke).toHaveBeenCalledWith(
      'llm:generate-stream',
      expect.any(String),
      expect.objectContaining({
        modelId: 'model-a',
        modelExecutionLeaseId: 'opaque-main-process-lease',
        maxTokens: 4096,
      }),
    )
    expect(mocks.invoke).toHaveBeenCalledWith(
      'llm:close-execution-lease',
      'opaque-main-process-lease',
    )

    const streamCall = mocks.invoke.mock.calls.find(([channel]) => channel === 'llm:generate-stream')
    expect(JSON.stringify(streamCall)).not.toContain('apiKey')
    expect(JSON.stringify(streamCall)).not.toContain('baseUrl')
  })

  it('maps a typed unknown explicit model result before opening any stream', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'llm:begin-execution-lease') {
        return {
          success: false,
          errorCode: 'MODEL_NOT_FOUND',
          error: 'opaque main-process detail',
        }
      }
      throw new Error(`unexpected channel: ${channel}`)
    })

    await expect(createGenerationRuntime({
      modelId: 'deleted-model',
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      message: '指定的生成模型不存在或已被删除。',
    })
    expect(mocks.invoke).toHaveBeenCalledOnce()
    expect(mocks.invoke).toHaveBeenCalledWith('llm:begin-execution-lease', 'deleted-model')
    expect(mocks.invoke).not.toHaveBeenCalledWith('llm:generate-stream', expect.anything())
  })
})
