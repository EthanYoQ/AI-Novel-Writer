import { describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../shared/ipc-channels'
import {
  createGenerationHarness,
  deriveDefaultPromptBudgetUtf8Bytes,
  type CompletionPort,
  type DefaultModelSnapshot,
} from '../generation-harness'

function model(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'model-a',
    name: 'Model A',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'model-a-v1',
    apiKey: 'test-only-key',
    baseUrl: 'https://provider-a.example/v1',
    temperature: 0.6,
    maxTokens: 4096,
    purposes: ['generation'],
    ...overrides,
  }
}

function task() {
  return {
    purpose: 'chapter-draft',
    output: 'visible-text' as const,
    messages: [
      { role: 'system' as const, content: 'Write a complete chapter.' },
      { role: 'user' as const, content: 'Begin.' },
    ],
  }
}

describe('GenerationHarness', () => {
  it('freezes the default model id, configuration revision, and endpoint for the whole session', async () => {
    let current: DefaultModelSnapshot = {
      revision: 'revision-a',
      model: model(),
    }
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: 'complete chapter',
      finishReason: 'stop',
    })
    const harness = createGenerationHarness({
      modelSource: { snapshotDefaultModel: () => current },
      completionPort: { complete },
      policy: {
        maxAttempts: 4,
        maxRequestedOutputTokens: 20_000,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const session = harness.openSession()

    current.model.modelName = 'mutated-same-id'
    current.model.baseUrl = 'https://mutated.example/v1'
    current = {
      revision: 'revision-b',
      model: model({ id: 'model-b', modelName: 'model-b-v1' }),
    }

    const outcome = await session.complete(task())

    expect(outcome.status).toBe('completed')
    expect(outcome.receipt.model).toEqual({
      id: 'model-a',
      configurationRevision: 'revision-a',
      endpointFingerprint: 'openai|custom|https://provider-a.example/v1|model-a-v1',
    })
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty('model')
    expect(complete.mock.calls[0]?.[0].modelExecutionLeaseId).toBeNull()
  })

  it('does not independently resolve provider facts in the renderer fallback', async () => {
    let current: DefaultModelSnapshot = {
      revision: 'official',
      model: model({
        provider: 'xai',
        protocol: 'openai',
        modelName: 'grok-4.5',
        baseUrl: 'https://api.x.ai/v1',
        maxTokens: 8192,
      }),
    }
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: 'complete',
      finishReason: 'stop',
    })
    const harness = createGenerationHarness({
      modelSource: { snapshotDefaultModel: () => current },
      completionPort: { complete },
      policy: {
        maxAttempts: 8,
        maxRequestedOutputTokens: 80_000,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })

    const official = await harness.openSession().complete(task())
    expect(official.receipt.capabilities).toMatchObject({
      contextWindowTokens: null,
      maxOutputTokens: 8192,
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'legacy-profile',
        featureFlags: 'unknown',
      },
    })

    for (const changedIdentity of [
      { baseUrl: 'https://proxy.example/v1' },
      { baseUrl: 'https://api.x.ai/v1?tenant=other' },
      { modelName: 'grok-4.5-latest' },
      { protocol: 'gemini' as const },
    ]) {
      current = {
        revision: JSON.stringify(changedIdentity),
        model: model({
          provider: 'xai',
          protocol: 'openai',
          modelName: 'grok-4.5',
          baseUrl: 'https://api.x.ai/v1',
          maxTokens: 8192,
          ...changedIdentity,
        }),
      }
      const outcome = await harness.openSession().complete(task())
      expect(outcome.receipt.capabilities).toMatchObject({
        contextWindowTokens: null,
        source: { contextWindowTokens: 'unknown' },
      })
    }
  })

  it('does not trust persisted renderer capabilities without main-process lease evidence', async () => {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: 'complete',
      finishReason: 'stop',
    })
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({
          revision: 'explicit-unknown-context',
          model: model({
            maxTokens: 99_999,
            capabilities: {
              contextWindowTokens: null,
              maxOutputTokens: 2048,
              reasoning: false,
              structuredOutput: false,
              usage: true,
            },
          }),
        }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 10_000,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })

    const outcome = await harness.openSession().complete({
      ...task(),
      messages: [
        { role: 'system', content: 'Write.' },
        { role: 'user', content: 'x'.repeat(12_000) },
      ],
    })

    expect(outcome.status).toBe('completed')
    expect(outcome.receipt.capabilities).toMatchObject({
      contextWindowTokens: null,
      maxOutputTokens: 99_999,
      reasoning: null,
      structuredOutput: null,
      usage: null,
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'legacy-profile',
        featureFlags: 'unknown',
      },
    })
    expect(complete.mock.calls[0]?.[0].plan).toMatchObject({
      contextWindowTokens: null,
      maxOutputTokens: 4096,
    })
  })

  it('rejects claimed resolved capabilities that are not paired with a main-process lease', () => {
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({
          revision: 'forged-capability-revision',
          model: model(),
          resolvedCapabilities: {
            contextWindowTokens: 1_000_000,
            maxOutputTokens: 384_000,
            reasoning: true,
            structuredOutput: true,
            usage: true,
            source: {
              contextWindowTokens: 'verified-provider-preset',
              maxOutputTokens: 'verified-provider-preset',
              featureFlags: 'verified-provider-preset',
            },
          },
        }),
      },
      completionPort: { complete: vi.fn() },
      policy: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })

    expect(() => harness.openSession()).toThrow(expect.objectContaining({
      code: 'UNTRUSTED_CAPABILITY_EVIDENCE',
    }))
  })

  it('reserves a 16K intent budget across attempts even for a 384K-capable model', async () => {
    const complete = vi.fn<CompletionPort['complete']>()
      .mockResolvedValueOnce({ content: 'first batch', finishReason: 'length' })
      .mockResolvedValueOnce({ content: 'continued batch', finishReason: 'stop' })
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({
          revision: 'large-context-model',
          model: model({
            maxTokens: 128_000,
            capabilities: {
              contextWindowTokens: 384_000,
              maxOutputTokens: 128_000,
              reasoning: false,
              structuredOutput: true,
              usage: true,
            },
          }),
        }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 4,
        maxRequestedOutputTokens: 16_384,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const session = harness.openSession()
    const fiveChapterDirectoryTask = {
      ...task(),
      purpose: 'five-chapter-directory',
      messages: [{ role: 'user' as const, content: 'Generate a structured directory for chapters 1 through 5.' }],
    }

    const first = await session.complete(fiveChapterDirectoryTask)
    const second = await session.complete(fiveChapterDirectoryTask)

    expect(first).toMatchObject({
      status: 'incomplete',
      finishReason: 'length',
      receipt: {
        purpose: 'five-chapter-directory',
        budget: {
          requestedOutputTokens: 4096,
          cumulativeRequestedOutputTokens: 4096,
          maxRequestedOutputTokens: 16_384,
          maxRequestedOutputTokensPerAttempt: 4096,
        },
      },
    })
    expect(second.receipt.budget).toMatchObject({
      requestedOutputTokens: 4096,
      cumulativeRequestedOutputTokens: 8192,
      maxRequestedOutputTokensPerAttempt: 4096,
    })
    expect(complete.mock.calls.map(([request]) => request.plan.maxOutputTokens)).toEqual([4096, 4096])
    expect(session.budget.maxRequestedOutputTokensPerAttempt).toBe(4096)
  })

  it('counts a known mixed-language sample as UTF-8 bytes and rejects it before a fake provider attempt', async () => {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: 'unused',
      finishReason: 'stop',
    })
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {})
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'revision-a', model: model() }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 8192,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const session = harness.openSession()
    const mixedText = 'A中🙂'

    await expect(session.complete({
      purpose: 'known-utf8-preflight',
      output: 'structured-data',
      messages: [{ role: 'user', content: mixedText }],
      promptBudget: {
        limitUtf8Bytes: 7,
        sections: [{ sectionName: 'step-guidance', messageIndex: 0, finalText: mixedText }],
      },
    })).rejects.toMatchObject({
      name: 'PromptBudgetExceededError',
      code: 'PROMPT_BUDGET_EXHAUSTED',
      report: {
        totalUtf8Bytes: 8,
        limitUtf8Bytes: 7,
        contextWindowTokens: null,
        estimatedInputTokens: 4,
        reservedOutputTokens: 4096,
        sections: [{ sectionName: 'step-guidance', utf8Bytes: 8 }],
        modelId: 'model-a',
        errorCode: 'PROMPT_BUDGET_EXHAUSTED',
      },
    })
    expect(complete).not.toHaveBeenCalled()
    expect(diagnostic).toHaveBeenCalledWith('[GenerationPromptBudget]', {
      totalUtf8Bytes: 8,
      limitUtf8Bytes: 7,
      contextWindowTokens: null,
      estimatedInputTokens: 4,
      reservedOutputTokens: 4096,
      sections: [{ sectionName: 'step-guidance', utf8Bytes: 8 }],
      modelId: 'model-a',
      errorCode: 'PROMPT_BUDGET_EXHAUSTED',
    })

    const recovered = await session.complete(task())
    expect(recovered.receipt.budget).toMatchObject({
      attempt: 1,
      cumulativeRequestedOutputTokens: 4096,
    })
    expect(complete).toHaveBeenCalledOnce()
    diagnostic.mockRestore()
  })

  it.each([
    ['repair-contract', 'c'.repeat(32_769), 'candidate'],
    ['repair-candidate', 'contract', 'd'.repeat(32_769)],
  ] as const)('enforces the protected %s byte limit before a provider attempt', async (
    oversizedSection,
    repairContract,
    repairCandidate,
  ) => {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: '{"ok":true}',
      finishReason: 'stop',
    })
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'section-limit', model: model() }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const userMessage = `${repairContract}\n${repairCandidate}`

    let failure: unknown
    try {
      await harness.openSession().complete({
        purpose: 'section-limit-preflight',
        output: 'structured-data',
        messages: [{ role: 'user', content: userMessage }],
        promptBudget: {
          limitUtf8Bytes: 70_000,
          sections: [
            {
              sectionName: 'repair-contract',
              messageIndex: 0,
              finalText: repairContract,
              limitUtf8Bytes: 32_768,
            },
            {
              sectionName: 'repair-candidate',
              messageIndex: 0,
              finalText: repairCandidate,
              limitUtf8Bytes: 32_768,
            },
          ],
        },
      })
    } catch (error) {
      failure = error
    } finally {
      diagnostic.mockRestore()
    }

    expect(failure).toMatchObject({
      name: 'PromptBudgetExceededError',
      code: 'PROMPT_BUDGET_EXHAUSTED',
      report: {
        errorCode: 'PROMPT_BUDGET_EXHAUSTED',
        sections: expect.arrayContaining([
          { sectionName: oversizedSection, utf8Bytes: 32_769 },
        ]),
      },
    })
    expect(complete).not.toHaveBeenCalled()
    expect(failure).not.toHaveProperty('receipt')
  })

  it('reports a protected byte overflow before the generic context-window failure', async () => {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: 'recovered',
      finishReason: 'stop',
    })
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({
          revision: 'small-context',
          model: model({ maxTokens: 100 }),
          modelExecutionLeaseId: 'lease-small-context',
          endpointFingerprint: 'small-context-endpoint',
          resolvedCapabilities: {
            contextWindowTokens: 600,
            maxOutputTokens: 100,
            reasoning: false,
            structuredOutput: true,
            usage: true,
            source: {
              contextWindowTokens: 'verified-provider-preset',
              maxOutputTokens: 'verified-provider-preset',
              featureFlags: 'verified-provider-preset',
            },
          },
        }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 200,
        maxRequestedOutputTokensPerAttempt: 100,
        deadlineMs: 60_000,
      },
    })
    const session = harness.openSession()
    const oversized = 'x'.repeat(100)

    await expect(session.complete({
      purpose: 'double-budget-overflow',
      output: 'structured-data',
      messages: [{ role: 'user', content: oversized }],
      promptBudget: {
        limitUtf8Bytes: 99,
        sections: [{ sectionName: 'global-guidance', messageIndex: 0, finalText: oversized }],
      },
    })).rejects.toMatchObject({
      name: 'PromptBudgetExceededError',
      code: 'PROMPT_BUDGET_EXHAUSTED',
      report: {
        totalUtf8Bytes: 100,
        limitUtf8Bytes: 99,
        contextWindowTokens: 600,
        estimatedInputTokens: 100,
        reservedOutputTokens: 0,
        sections: [{ sectionName: 'global-guidance', utf8Bytes: 100 }],
      },
    })
    expect(complete).not.toHaveBeenCalled()

    await expect(session.complete({
      purpose: 'context-only-overflow',
      output: 'structured-data',
      messages: [{ role: 'user', content: oversized }],
      promptBudget: {
        limitUtf8Bytes: 200,
        sections: [{ sectionName: 'global-guidance', messageIndex: 0, finalText: oversized }],
      },
    })).rejects.toMatchObject({
      code: 'CONTEXT_BUDGET_EXHAUSTED',
      message: expect.stringMatching(/model-a.*600 tokens.*100 tokens.*512 tokens.*0 tokens.*global-guidance=100/u),
    })
    expect(complete).not.toHaveBeenCalled()

    const recovered = await session.complete({
      purpose: 'after-double-overflow',
      output: 'visible-text',
      messages: [{ role: 'user', content: 'x' }],
    })
    expect(recovered.receipt.budget).toMatchObject({ attempt: 1, cumulativeRequestedOutputTokens: 87 })
    diagnostic.mockRestore()
  })

  it('sends an in-budget protected author section unchanged and records only its size in the receipt', async () => {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: '{"ok":true}',
      finishReason: 'stop',
    })
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {})
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'revision-a', model: model() }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const authorGuidance = 'Keep this 完整 guidance unchanged.'

    const outcome = await harness.openSession().complete({
      purpose: 'protected-guidance',
      output: 'structured-data',
      messages: [{ role: 'user', content: authorGuidance }],
      promptBudget: {
        limitUtf8Bytes: 128,
        sections: [{ sectionName: 'global-guidance', messageIndex: 0, finalText: authorGuidance }],
      },
    })

    expect(complete.mock.calls[0]?.[0].messages[0]?.content).toBe(authorGuidance)
    expect(outcome.receipt.promptBudget).toEqual({
      totalUtf8Bytes: 36,
      limitUtf8Bytes: 128,
      contextWindowTokens: null,
      estimatedInputTokens: 32,
      reservedOutputTokens: 4096,
      sections: [{ sectionName: 'global-guidance', utf8Bytes: 36 }],
      modelId: 'model-a',
      errorCode: 'OK',
    })
    expect(JSON.stringify(outcome.receipt)).not.toContain(authorGuidance)
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(authorGuidance)
    diagnostic.mockRestore()
  })

  it('rejects an invalid per-attempt requested-token cap before opening a session', () => {
    expect(() => createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'revision-a', model: model() }),
      },
      completionPort: { complete: vi.fn() },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 16_384,
        maxRequestedOutputTokensPerAttempt: 0,
        deadlineMs: 60_000,
      },
    })).toThrow(expect.objectContaining({ code: 'INVALID_POLICY' }))
  })

  it('does not classify a creative response without finishReason as completed', async () => {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: 'looks complete but has no provider terminal evidence',
    })
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'revision-a', model: model() }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 10_000,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })

    const outcome = await harness.openSession().complete(task())

    expect(outcome).toMatchObject({
      status: 'incomplete',
      finishReason: 'unknown',
      receipt: { finishReason: 'unknown' },
    })
  })

  it('does not let a caller override the physical plan after the session resolves it', async () => {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: 'complete',
      finishReason: 'stop',
    })
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'revision-a', model: model() }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 10_000,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const taskWithPhysicalOverride = {
      ...task(),
      maxTokens: 1,
      plan: { maxOutputTokens: 1 },
    }

    // @ts-expect-error Generation callers may describe intent, never physical request controls.
    const outcome = await harness.openSession().complete(taskWithPhysicalOverride)

    expect(outcome.status).toBe('completed')
    expect(complete.mock.calls[0]?.[0].plan).toMatchObject({ maxOutputTokens: 4096 })
    expect(Object.isFrozen(complete.mock.calls[0]?.[0].plan)).toBe(true)
  })

  it('charges failed physical requests to the global session budget and exposes a redacted attempt receipt', async () => {
    const complete = vi.fn<CompletionPort['complete']>()
      .mockRejectedValueOnce(new Error('provider unavailable: test-only-key'))
      .mockResolvedValueOnce({ content: 'complete', finishReason: 'stop' })
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'revision-a', model: model() }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 5000,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const session = harness.openSession()

    let failure: unknown
    try {
      await session.complete(task())
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      name: 'GenerationAttemptError',
      code: 'PROVIDER_REQUEST_FAILED',
      receipt: {
        finishReason: 'error',
        budget: {
          attempt: 1,
          requestedOutputTokens: 4096,
          cumulativeRequestedOutputTokens: 4096,
          maxRequestedOutputTokens: 5000,
          maxRequestedOutputTokensPerAttempt: 4096,
        },
      },
    })
    expect((failure as Error).cause).toBeUndefined()
    expect(String(failure)).not.toContain('test-only-key')

    const recovered = await session.complete(task())
    expect(recovered.receipt.budget).toMatchObject({
      attempt: 2,
      requestedOutputTokens: 904,
      cumulativeRequestedOutputTokens: 5000,
    })
    expect(complete.mock.calls[1]?.[0].plan.maxOutputTokens).toBe(904)
    expect(JSON.stringify(recovered.receipt)).not.toContain('test-only-key')
  })

  it('freezes the global attempt, requested-token, and deadline budget against caller mutation', async () => {
    let currentTime = 1000
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: 'complete',
      finishReason: 'stop',
    })
    const policy = {
      maxAttempts: 2,
      maxRequestedOutputTokens: 5000,
      maxRequestedOutputTokensPerAttempt: 4096,
      deadlineMs: 60_000,
    }
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'revision-a', model: model() }),
      },
      completionPort: { complete },
      policy,
      now: () => currentTime,
    })
    const session = harness.openSession()

    policy.maxAttempts = 99
    policy.maxRequestedOutputTokens = 99_999
    policy.maxRequestedOutputTokensPerAttempt = 99_999
    policy.deadlineMs = 999_999

    await session.complete(task())
    const second = await session.complete(task())
    expect(second.receipt.budget).toMatchObject({
      maxAttempts: 2,
      requestedOutputTokens: 904,
      cumulativeRequestedOutputTokens: 5000,
      maxRequestedOutputTokens: 5000,
      maxRequestedOutputTokensPerAttempt: 4096,
      deadlineAt: 61_000,
    })
    await expect(session.complete(task())).rejects.toMatchObject({
      code: 'ATTEMPT_BUDGET_EXHAUSTED',
    })

    const expired = harness.openSession()
    currentTime = 61_001
    await expect(expired.complete(task())).rejects.toMatchObject({
      code: 'DEADLINE_EXHAUSTED',
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('cancels an in-flight physical request while preserving its charged attempt receipt', async () => {
    let providerSignal: AbortSignal | undefined
    const complete = vi.fn<CompletionPort['complete']>().mockImplementation(request => {
      providerSignal = request.signal
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('adapter aborted')), { once: true })
      })
    })
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'revision-a', model: model() }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 10_000,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const cancellation = new AbortController()

    const pending = harness.openSession().complete(task(), { signal: cancellation.signal })
    cancellation.abort()

    await expect(pending).rejects.toMatchObject({
      name: 'GenerationAttemptError',
      code: 'CANCELLED',
      receipt: {
        finishReason: 'cancelled',
        budget: {
          attempt: 1,
          requestedOutputTokens: 4096,
          cumulativeRequestedOutputTokens: 4096,
        },
      },
    })
    expect(providerSignal?.aborted).toBe(true)
  })

  it('does not charge a physical attempt when cancellation already exists before planning', async () => {
    const complete = vi.fn<CompletionPort['complete']>()
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({ revision: 'revision-a', model: model() }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 10_000,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })
    const cancellation = new AbortController()
    cancellation.abort()

    await expect(harness.openSession().complete(task(), { signal: cancellation.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('never copies endpoint credentials into the observable model fingerprint', async () => {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: 'complete',
      finishReason: 'stop',
    })
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({
          revision: 'revision-a',
          model: model({
            baseUrl: 'https://account:base-url-secret@provider-a.example/v1?api_key=query-secret',
          }),
        }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    })

    const outcome = await harness.openSession().complete(task())
    const fingerprint = outcome.receipt.model.endpointFingerprint

    expect(fingerprint).not.toContain('base-url-secret')
    expect(fingerprint).not.toContain('query-secret')
    expect(fingerprint).toContain('provider-a.example/v1')
  })
})

/**
 * 缺省字节闸门必须跟着模型上下文走。
 *
 * 先生实测报错（绑定写作 Skill 的润色修稿被拦）：
 *   「提示词共 47,331 UTF-8 字节，超过上限 32,768 字节 …… 模型上下文：1,000,000 tokens；
 *     估算输入：18,696 tokens；结果码：PROMPT_BUDGET_EXHAUSTED」
 * 根因是调用方塞了一个写死的 32 KB 缺省上限 —— 与模型能力毫无关系。
 * 现在缺省值由上下文推导，下面几条把它钉住：
 *   · 百万级窗口：这等规模的提示词**必须放行**（这正是先生的场景）；
 *   · 窗口未知：仍旧 32 KB 保守兜底，**与改动前完全一致**；
 *   · 小窗口：不放宽；
 *   · 调用方显式给的上限：照旧优先。
 */
describe('缺省提示词闸门跟随模型上下文', () => {
  /** 先生那份「去 AI 味写作 Skill」的实测量级：19,276 字节。 */
  const SKILL_CHARS = 6_400          // 6,400 个汉字 ≈ 19,200 UTF-8 字节
  const OVERHEAD_CHARS = 9_300       // ≈ 27,900 字节，对应「模板与结构开销 28,055」

  /** 复刻先生那次的请求形状：写作 Skill 段 + 模板/结构开销，合计约 47 KB。 */
  function oversizedRefineTask() {
    const skillText = '技'.repeat(SKILL_CHARS)
    const overheadText = '模'.repeat(OVERHEAD_CHARS)
    const content = `${skillText}\n${overheadText}`
    return {
      purpose: 'refine-draft',
      output: 'visible-text' as const,
      messages: [{ role: 'user' as const, content }],
      promptBudget: {
        // 刻意不给 limitUtf8Bytes —— 缺省闸门必须自己看着模型来
        sections: [{
          sectionName: 'writing-skill',
          displayName: '去 AI 味写作 Skill',
          messageIndex: 0,
          finalText: skillText,
        }],
      },
    }
  }

  function harnessWithContext(contextWindowTokens: number | null) {
    const complete = vi.fn<CompletionPort['complete']>().mockResolvedValue({
      content: '润色后的正文',
      finishReason: 'stop',
    })
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => (contextWindowTokens === null
          ? { revision: 'unknown-window', model: model() }
          : {
              revision: 'known-window',
              model: model({ maxTokens: 32_768 }),
              modelExecutionLeaseId: 'lease-known-window',
              endpointFingerprint: 'known-window-endpoint',
              resolvedCapabilities: {
                contextWindowTokens,
                maxOutputTokens: 32_768,
                reasoning: false,
                structuredOutput: true,
                usage: true,
                source: {
                  contextWindowTokens: 'verified-provider-preset',
                  maxOutputTokens: 'verified-provider-preset',
                  featureFlags: 'verified-provider-preset',
                },
              },
            }),
      },
      completionPort: { complete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 16_384,
        maxRequestedOutputTokensPerAttempt: 8_192,
        deadlineMs: 60_000,
      },
    })
    return { harness, complete }
  }

  it('百万 token 窗口：约 47 KB 的「Skill + 模板」提示词不再被误拦', async () => {
    const { harness, complete } = harnessWithContext(1_000_000)
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    const outcome = await harness.openSession().complete(oversizedRefineTask())

    diagnostic.mockRestore()
    expect(complete, '这种规模必须真的发给模型，而不是被字节闸门挡下').toHaveBeenCalledOnce()
    expect(outcome.status).toBe('completed')
    expect(outcome.receipt.promptBudget).toMatchObject({
      limitUtf8Bytes: 512 * 1024,
      contextWindowTokens: 1_000_000,
      errorCode: 'OK',
    })
    expect(outcome.receipt.promptBudget!.sections).toEqual(expect.arrayContaining([
      { sectionName: 'writing-skill', displayName: '去 AI 味写作 Skill', utf8Bytes: 19_200 },
    ]))
  })

  it('窗口未知：仍旧 32 KB 保守兜底（与改动前一致，含「可能误报」的代价）', async () => {
    const { harness, complete } = harnessWithContext(null)
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    let failure: unknown
    try {
      await harness.openSession().complete(oversizedRefineTask())
    } catch (error) {
      failure = error
    } finally {
      diagnostic.mockRestore()
    }

    expect(failure).toMatchObject({
      name: 'PromptBudgetExceededError',
      code: 'PROMPT_BUDGET_EXHAUSTED',
      report: { limitUtf8Bytes: 32 * 1024, contextWindowTokens: null },
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('小窗口不因此放宽：推导值低于 32 KB 时仍取 32 KB', async () => {
    const { harness, complete } = harnessWithContext(8_192)
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    let failure: unknown
    try {
      await harness.openSession().complete(oversizedRefineTask())
    } catch (error) {
      failure = error
    } finally {
      diagnostic.mockRestore()
    }

    expect(failure).toMatchObject({
      code: 'PROMPT_BUDGET_EXHAUSTED',
      report: { limitUtf8Bytes: 32 * 1024, contextWindowTokens: 8_192 },
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('调用方显式给的上限照旧优先（刻意收紧的调用方不被推导值顶掉）', async () => {
    const { harness, complete } = harnessWithContext(1_000_000)
    const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const task = oversizedRefineTask()
    const explicit = {
      ...task,
      promptBudget: { ...task.promptBudget, limitUtf8Bytes: 33_000 },
    }

    let failure: unknown
    try {
      await harness.openSession().complete(explicit)
    } catch (error) {
      failure = error
    } finally {
      diagnostic.mockRestore()
    }

    expect(failure).toMatchObject({
      code: 'PROMPT_BUDGET_EXHAUSTED',
      report: { limitUtf8Bytes: 33_000 },
    })
    expect(complete).not.toHaveBeenCalled()
  })

  it('推导值的四条边界（窗口未知 / 极小 / 常规 / 百万级）', () => {
    expect(deriveDefaultPromptBudgetUtf8Bytes(null), '窗口未知 → 保守缺省').toBe(32 * 1024)
    expect(deriveDefaultPromptBudgetUtf8Bytes(0), '非法窗口 → 保守缺省').toBe(32 * 1024)
    expect(deriveDefaultPromptBudgetUtf8Bytes(8_192), '小窗口 → 不低于 32 KB').toBe(32 * 1024)
    expect(deriveDefaultPromptBudgetUtf8Bytes(128_000), '128K × 3 ÷ 2 = 192 KB').toBe(192_000)
    expect(deriveDefaultPromptBudgetUtf8Bytes(1_000_000), '百万级 → 封顶 512 KB').toBe(512 * 1024)
  })
})
