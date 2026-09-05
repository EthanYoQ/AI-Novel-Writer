import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ModelExecutionLeaseReceipt,
  ProjectData,
  ProjectSessionContext,
} from '../../../shared/ipc-channels'
import type { CreativeStrategy } from '../../../shared/reasoning-types'

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
import { useProjectStore } from '../../../stores/project-store'
import { createGenerationRuntime } from '../generation-runtime'

function project(id: string, creativeStrategy: CreativeStrategy): ProjectData {
  return {
    id,
    name: id,
    path: `C:/projects/${id}`,
    sessionLease: `lease-${id}`,
    novelConfig: {
      creativeStrategy,
      genre: 'fantasy',
      subGenre: '',
      targetAudience: 'all',
      totalChapters: 10,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  }
}

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
    useProjectStore.setState({ currentProject: project('project-a', 'consistency-first') })
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

  it('freezes the project strategy for initial and continuation attempts when the current project changes', async () => {
    const runtime = await createGenerationRuntime({
      budget: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 8192,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    useProjectStore.setState({ currentProject: project('project-b', 'fluent-drafting') })

    await runtime.execute(async ({ session }) => {
      await session.complete({
        purpose: 'chapter-draft',
        reasoningStage: 'drafting',
        output: 'visible-text',
        messages: [{ role: 'user', content: 'initial' }],
      })
      await session.complete({
        purpose: 'chapter-draft-continuation',
        reasoningStage: 'drafting',
        output: 'visible-text',
        messages: [{ role: 'user', content: 'continue' }],
      })
    })

    const requests = mocks.invoke.mock.calls
      .filter(([channel]) => channel === 'llm:generate-stream')
      .map(([, , request]) => request)
    expect(requests).toHaveLength(2)
    expect(requests).toEqual([
      expect.objectContaining({
        creativeStrategy: 'consistency-first',
        reasoningStage: 'drafting',
      }),
      expect.objectContaining({
        creativeStrategy: 'consistency-first',
        reasoningStage: 'drafting',
      }),
    ])
  })

  it('uses an explicitly captured strategy instead of the project active when the runtime opens', async () => {
    useProjectStore.setState({ currentProject: project('project-b', 'fluent-drafting') })
    const runtime = await createGenerationRuntime({
      creativeStrategy: 'consistency-first',
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })

    await runtime.execute(({ session }) => session.complete({
      purpose: 'explicit-project-strategy',
      reasoningStage: 'general',
      output: 'visible-text',
      messages: [{ role: 'user', content: 'write' }],
    }))

    const streamCall = mocks.invoke.mock.calls.find(([channel]) => channel === 'llm:generate-stream')
    expect(streamCall?.[2]).toEqual(expect.objectContaining({
      creativeStrategy: 'consistency-first',
    }))
  })

  it('keeps the captured project session while the model lease is opening', async () => {
    const projectSession: ProjectSessionContext = {
      projectId: 'project-a',
      leaseId: 'lease-project-a',
      projectPath: 'C:/projects/project-a',
    }
    const expectedProjectSession = { ...projectSession }
    let resolveLease: ((value: { success: true; lease: ModelExecutionLeaseReceipt }) => void) | undefined
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'llm:begin-execution-lease') {
        return new Promise(resolve => { resolveLease = resolve })
      }
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

    const runtimePromise = createGenerationRuntime({
      projectSession,
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    await vi.waitFor(() => expect(resolveLease).toBeTypeOf('function'))
    useProjectStore.setState({ currentProject: project('project-b', 'fluent-drafting') })
    projectSession.projectId = 'mutated-after-capture'
    resolveLease!({ success: true, lease: LEASE })

    const runtime = await runtimePromise
    await runtime.execute(({ session }) => session.complete({
      purpose: 'project-session-freeze',
      reasoningStage: 'planning',
      output: 'structured-data',
      messages: [{ role: 'user', content: 'project A facts' }],
    }))

    const streamCall = mocks.invoke.mock.calls.find(([channel]) => channel === 'llm:generate-stream')
    expect(streamCall?.[2]).toEqual(expect.objectContaining({
      projectSession: expectedProjectSession,
    }))
    expect(Object.isFrozen(streamCall?.[2]?.projectSession)).toBe(true)
  })

  it('captures the current project session before an implicit model lease starts', async () => {
    let resolveLease: ((value: { success: true; lease: ModelExecutionLeaseReceipt }) => void) | undefined
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'llm:begin-execution-lease') {
        return new Promise(resolve => { resolveLease = resolve })
      }
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

    const runtimePromise = createGenerationRuntime({
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    await vi.waitFor(() => expect(resolveLease).toBeTypeOf('function'))
    useProjectStore.setState({ currentProject: project('project-b', 'fluent-drafting') })
    resolveLease!({ success: true, lease: LEASE })

    const runtime = await runtimePromise
    await runtime.execute(({ session }) => session.complete({
      purpose: 'implicit-project-session-freeze',
      reasoningStage: 'planning',
      output: 'structured-data',
      messages: [{ role: 'user', content: 'project A facts' }],
    }))

    const streamCall = mocks.invoke.mock.calls.find(([channel]) => channel === 'llm:generate-stream')
    expect(streamCall?.[2]).toEqual(expect.objectContaining({
      projectSession: {
        projectId: 'project-a',
        leaseId: 'lease-project-a',
        projectPath: 'C:/projects/project-a',
      },
    }))
    expect(Object.isFrozen(streamCall?.[2]?.projectSession)).toBe(true)
  })

  it('leaves the generation request unbound when no project is open', async () => {
    useProjectStore.setState({ currentProject: null })
    const runtime = await createGenerationRuntime({
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })

    await runtime.execute(({ session }) => session.complete({
      purpose: 'projectless-generation',
      reasoningStage: 'planning',
      output: 'structured-data',
      messages: [{ role: 'user', content: 'projectless facts' }],
    }))

    const streamCall = mocks.invoke.mock.calls.find(([channel]) => channel === 'llm:generate-stream')
    expect(streamCall?.[2]).toEqual(expect.objectContaining({ projectSession: undefined }))
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

  it('delivers authored stream text before the terminal completion arrives', async () => {
    let streamRequestId = ''
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'llm:begin-execution-lease') return { success: true, lease: LEASE }
      if (channel === 'llm:close-execution-lease') return { success: true }
      if (channel === 'llm:generate-stream') {
        const requestId = String(args[0])
        streamRequestId = requestId
        queueMicrotask(() => {
          mocks.listeners.get('llm:stream-chunk')?.({
            requestId,
            chunk: '林岚推开门。',
          } as never)
        })
        return { requestId, started: true }
      }
      throw new Error(`unexpected channel: ${channel}`)
    })

    const runtime = await createGenerationRuntime({
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const streamed = vi.fn()
    let completed = false
    const execution = runtime.execute(async ({ session }) => session.complete({
      purpose: 'renderer-progressive-preview',
      output: 'visible-text',
      messages: [{ role: 'user', content: 'write' }],
    }, { onChunk: streamed })).then(result => {
      completed = true
      return result
    })

    await vi.waitFor(() => expect(streamed).toHaveBeenCalledWith('林岚推开门。'))
    expect(completed).toBe(false)
    mocks.listeners.get('llm:stream-done')?.({
      requestId: streamRequestId,
      fullText: '林岚推开门。',
      finishReason: 'stop',
    } as never)
    await expect(execution).resolves.toMatchObject({ content: '林岚推开门。' })
  })

  it('ignores stream chunks that arrive after cancellation', async () => {
    let streamRequestId = ''
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'llm:begin-execution-lease') return { success: true, lease: LEASE }
      if (channel === 'llm:close-execution-lease') return { success: true }
      if (channel === 'llm:cancel') return undefined
      if (channel === 'llm:generate-stream') {
        streamRequestId = String(args[0])
        return { requestId: streamRequestId, started: true }
      }
      throw new Error(`unexpected channel: ${channel}`)
    })

    const runtime = await createGenerationRuntime({
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const streamed = vi.fn()
    const cancellation = new AbortController()
    const execution = runtime.execute(async ({ session }) => session.complete({
      purpose: 'renderer-cancelled-preview',
      output: 'visible-text',
      messages: [{ role: 'user', content: 'write' }],
    }, { signal: cancellation.signal, onChunk: streamed }))
    await vi.waitFor(() => expect(streamRequestId).not.toBe(''))
    const chunkListener = mocks.listeners.get('llm:stream-chunk')

    chunkListener?.({ requestId: streamRequestId, chunk: '取消前正文' } as never)
    expect(streamed).toHaveBeenLastCalledWith('取消前正文')
    cancellation.abort()
    await expect(execution).rejects.toMatchObject({ code: 'CANCELLED' })

    chunkListener?.({ requestId: streamRequestId, chunk: '取消后晚到正文' } as never)
    expect(streamed).toHaveBeenCalledTimes(1)
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
