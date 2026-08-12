import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GenerationRuntime } from '../../services/generation/generation-runtime'
import type { GenerationSession } from '../../services/generation/generation-harness'
import { useLLMStore } from '../llm-store'
import {
  AGENT_GENERATION_BUDGET,
  useAgentStore,
} from '../agent-store'

const generationRuntime = vi.hoisted(() => ({
  create: vi.fn(),
}))

vi.mock('../../services/generation/generation-runtime', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/generation/generation-runtime')>(),
  createGenerationRuntime: generationRuntime.create,
}))

function completed(content: string, attempt: number) {
  return {
    status: 'completed' as const,
    content,
    finishReason: 'stop' as const,
    receipt: {
      model: { id: 'model-a', configurationRevision: 'r1', endpointFingerprint: 'f1' },
      capabilities: {
        contextWindowTokens: null,
        maxOutputTokens: 2048,
        reasoning: null,
        structuredOutput: null,
        usage: null,
        source: {
          contextWindowTokens: 'unknown' as const,
          maxOutputTokens: 'user-operational-cap' as const,
          featureFlags: 'unknown' as const,
        },
      },
      budget: {
        attempt,
        maxAttempts: 8,
        requestedOutputTokens: 2048,
        cumulativeRequestedOutputTokens: attempt * 2048,
        maxRequestedOutputTokens: 65_536,
        maxRequestedOutputTokensPerAttempt: 8192,
        deadlineAt: Date.now() + 60_000,
      },
      finishReason: 'stop' as const,
    },
  }
}

describe('Agent GenerationRuntime boundary', () => {
  beforeEach(() => {
    useAgentStore.setState({
      conversations: [],
      activeConversationId: null,
      generating: false,
      activeRequestId: null,
    })
    useLLMStore.setState({ defaultModelId: 'model-a' })
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'uuid') })
  })

  afterEach(() => {
    generationRuntime.create.mockReset()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('freezes the selected conversation model and reuses one session across tool-loop turns', async () => {
    const complete = vi.fn<GenerationSession['complete']>()
      .mockImplementationOnce(async () => {
        useLLMStore.setState({ defaultModelId: 'model-b' })
        return completed('<tool_call>{"name":"missing_probe","arguments":{}}</tool_call>', 1)
      })
      .mockResolvedValueOnce(completed('最终回复', 2))
    const close = vi.fn(async () => {})
    const runtime: GenerationRuntime = {
      execute: async operation => {
        try {
          return await operation({
            session: {
              complete,
              budget: {
                maxAttempts: AGENT_GENERATION_BUDGET.maxAttempts,
                maxRequestedOutputTokens: AGENT_GENERATION_BUDGET.maxRequestedOutputTokens,
                maxRequestedOutputTokensPerAttempt: AGENT_GENERATION_BUDGET.maxRequestedOutputTokensPerAttempt,
                deadlineAt: Date.now() + AGENT_GENERATION_BUDGET.deadlineMs,
              },
            },
          })
        } finally {
          await close()
        }
      },
      close,
    }
    const createRuntime = vi.fn(async () => runtime)
    generationRuntime.create.mockImplementation(createRuntime)
    const conversation = useAgentStore.getState().createConversation()
    useAgentStore.getState().setModelId('model-a')

    await useAgentStore.getState().sendMessage('检查项目')

    expect(createRuntime).toHaveBeenCalledOnce()
    expect(createRuntime).toHaveBeenCalledWith({
      modelId: 'model-a',
      budget: AGENT_GENERATION_BUDGET,
    })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
    const updated = useAgentStore.getState().conversations.find(item => item.id === conversation.id)
    expect(updated?.messages.at(-1)?.content).toBe('最终回复')
  })
})
