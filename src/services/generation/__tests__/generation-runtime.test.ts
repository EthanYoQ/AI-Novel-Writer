import { describe, expect, it, vi } from 'vitest'

import type { ModelExecutionLeaseReceipt } from '../../../shared/ipc-channels'
import {
  createGenerationRuntime,
  GenerationRuntimeError,
  type GenerationRuntimeEnvironment,
} from '../generation-runtime'
import { PromptBudgetExceededError } from '../generation-harness'

function leaseReceipt(overrides: Partial<ModelExecutionLeaseReceipt> = {}): ModelExecutionLeaseReceipt {
  return {
    leaseId: 'model-execution-lease-a',
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
    ...overrides,
  }
}

function task(purpose: string) {
  return {
    purpose,
    output: 'visible-text' as const,
    messages: [{ role: 'user' as const, content: 'write' }],
  }
}

describe('GenerationRuntime', () => {
  it('freezes an explicitly selected semantic model id without reading the mutable default', async () => {
    const snapshotDefaultModelId = vi.fn(() => 'model-a')
    const beginModelExecution = vi.fn<GenerationRuntimeEnvironment['beginModelExecution']>()
      .mockResolvedValue(leaseReceipt({ modelId: 'model-b', modelName: 'model-b-v1' }))
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: 'selected', finishReason: 'stop' })
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId,
      beginModelExecution,
      completeWithLease,
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }
    const runtime = await createGenerationRuntime({
      modelId: 'model-b',
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    }, environment)

    const content = await runtime.execute(async ({ session }) => (
      (await session.complete(task('explicit-model'))).content
    ))

    expect(content).toBe('selected')
    expect(snapshotDefaultModelId).not.toHaveBeenCalled()
    expect(beginModelExecution).toHaveBeenCalledOnce()
    expect(beginModelExecution).toHaveBeenCalledWith('model-b')
    expect(completeWithLease).toHaveBeenCalledOnce()
    expect(completeWithLease.mock.calls[0]?.[0].leaseId).toBe('model-execution-lease-a')
  })

  it('rejects an oversized protected request before the production provider protocol is called', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
    const closeModelExecution = vi.fn<GenerationRuntimeEnvironment['closeModelExecution']>()
      .mockResolvedValue(undefined)
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
      completeWithLease,
      closeModelExecution,
    }
    const runtime = await createGenerationRuntime({
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    }, environment)
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    try {
      await expect(runtime.execute(({ session }) => session.complete({
        purpose: 'protected-structured-request',
        output: 'structured-data',
        messages: [{ role: 'user', content: 'A中🙂' }],
        promptBudget: {
          limitUtf8Bytes: 7,
          sections: [{ sectionName: 'global-guidance', messageIndex: 0, finalText: 'A中🙂' }],
        },
      }))).rejects.toBeInstanceOf(PromptBudgetExceededError)
    } finally {
      log.mockRestore()
    }

    expect(completeWithLease).not.toHaveBeenCalled()
    expect(closeModelExecution).toHaveBeenCalledOnce()
    expect(closeModelExecution).toHaveBeenCalledWith('model-execution-lease-a')
  })

  it('reports an unknown explicit model before any provider request', async () => {
    const snapshotDefaultModelId = vi.fn(() => 'model-a')
    const beginModelExecution = vi.fn<GenerationRuntimeEnvironment['beginModelExecution']>()
      .mockRejectedValue(new GenerationRuntimeError('MODEL_NOT_FOUND', 'sensitive transport detail'))
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId,
      beginModelExecution,
      completeWithLease,
      closeModelExecution: vi.fn(),
    }

    await expect(createGenerationRuntime({
      modelId: 'deleted-model',
      budget: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 4096,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    }, environment)).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
      message: '指定的生成模型不存在或已被删除。',
    })
    expect(snapshotDefaultModelId).not.toHaveBeenCalled()
    expect(beginModelExecution).toHaveBeenCalledWith('deleted-model')
    expect(completeWithLease).not.toHaveBeenCalled()
  })

  it.each([
    ['attempts', { maxAttempts: 33, maxRequestedOutputTokens: 4096, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 60_000 }],
    ['total requested tokens', { maxAttempts: 1, maxRequestedOutputTokens: 147_457, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 60_000 }],
    ['per-attempt requested tokens', { maxAttempts: 1, maxRequestedOutputTokens: 32_769, maxRequestedOutputTokensPerAttempt: 32_769, deadlineMs: 60_000 }],
    ['deadline', { maxAttempts: 1, maxRequestedOutputTokens: 4096, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 3_600_001 }],
  ])('rejects an oversized %s budget before reading a model or opening a lease', async (_label, budget) => {
    const snapshotDefaultModelId = vi.fn(() => 'model-a')
    const beginModelExecution = vi.fn<GenerationRuntimeEnvironment['beginModelExecution']>()
      .mockResolvedValue(leaseReceipt())
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId,
      beginModelExecution,
      completeWithLease: vi.fn(),
      closeModelExecution: vi.fn(),
    }

    await expect(createGenerationRuntime({ budget }, environment)).rejects.toMatchObject({
      code: 'INVALID_POLICY',
    })
    expect(snapshotDefaultModelId).not.toHaveBeenCalled()
    expect(beginModelExecution).not.toHaveBeenCalled()
  })

  it('uses one main-process model lease across attempts even when the renderer default changes', async () => {
    let defaultModelId: string | null = 'model-a'
    const beginModelExecution = vi.fn<GenerationRuntimeEnvironment['beginModelExecution']>()
      .mockResolvedValue(leaseReceipt())
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: 'first', finishReason: 'stop' })
      .mockResolvedValueOnce({ content: 'second', finishReason: 'stop' })
    const closeModelExecution = vi.fn<GenerationRuntimeEnvironment['closeModelExecution']>()
      .mockResolvedValue(undefined)
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => defaultModelId,
      beginModelExecution,
      completeWithLease,
      closeModelExecution,
    }
    const runtime = await createGenerationRuntime({
      budget: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 8192,
        maxRequestedOutputTokensPerAttempt: 4096,
        deadlineMs: 60_000,
      },
    }, environment)

    defaultModelId = 'model-b'
    const contents = await runtime.execute(async ({ session }) => {
      const first = await session.complete(task('first'))
      const second = await session.complete(task('second'))
      return [first.content, second.content]
    })

    expect(contents).toEqual(['first', 'second'])
    expect(beginModelExecution).toHaveBeenCalledOnce()
    expect(beginModelExecution).toHaveBeenCalledWith('model-a')
    expect(completeWithLease).toHaveBeenCalledTimes(2)
    for (const [request] of completeWithLease.mock.calls) {
      expect(request.leaseId).toBe('model-execution-lease-a')
      expect(request).not.toHaveProperty('model')
      expect(request).not.toHaveProperty('modelId')
      expect(request).not.toHaveProperty('apiKey')
      expect(request).not.toHaveProperty('baseUrl')
    }
    expect(closeModelExecution).toHaveBeenCalledOnce()
    expect(closeModelExecution).toHaveBeenCalledWith('model-execution-lease-a')
  })

  it('exposes only the session whose receipts derive from one immutable budget and deadline', async () => {
    let now = 1000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now++)
    const budget = {
      maxAttempts: 3,
      maxRequestedOutputTokens: 9000,
      maxRequestedOutputTokensPerAttempt: 3000,
      deadlineMs: 60_000,
    }
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
      completeWithLease: vi.fn().mockResolvedValue({ content: 'done', finishReason: 'stop' }),
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }
    const runtime = await createGenerationRuntime({ budget }, environment)

    budget.maxAttempts = 99
    budget.maxRequestedOutputTokens = 99_999
    budget.maxRequestedOutputTokensPerAttempt = 99_999
    budget.deadlineMs = 999_999

    await runtime.execute(async scope => {
      expect(Object.keys(scope)).toEqual(['session'])
      const { session } = scope
      const outcome = await session.complete(task('budget-source'))
      expect(outcome.receipt.budget).toMatchObject({
        maxAttempts: 3,
        maxRequestedOutputTokens: 9000,
        maxRequestedOutputTokensPerAttempt: 3000,
      })
    })
    nowSpy.mockRestore()
  })

  it('rejects alternate harness or structured budget objects at the single creation entry', async () => {
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
      completeWithLease: vi.fn().mockResolvedValue({ content: 'done', finishReason: 'stop' }),
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }
    const duplicated = {
      budget: { maxAttempts: 1, maxRequestedOutputTokens: 4096, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 60_000 },
      policy: { maxAttempts: 999, maxRequestedOutputTokens: 999_999, maxRequestedOutputTokensPerAttempt: 999_999, deadlineMs: 999_999 },
    }

    // @ts-expect-error Callers cannot supply a second physical budget.
    await expect(createGenerationRuntime(duplicated, environment)).rejects.toMatchObject({
      code: 'INVALID_BUDGET_SOURCE',
    })
  })

  it('closes explicitly and idempotently, then rejects execution through the closed runtime', async () => {
    const closeModelExecution = vi.fn<GenerationRuntimeEnvironment['closeModelExecution']>()
      .mockResolvedValue(undefined)
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
      completeWithLease: vi.fn().mockResolvedValue({ content: 'done', finishReason: 'stop' }),
      closeModelExecution,
    }
    const runtime = await createGenerationRuntime({
      budget: { maxAttempts: 1, maxRequestedOutputTokens: 4096, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 60_000 },
    }, environment)

    await runtime.close()
    await runtime.close()

    expect(closeModelExecution).toHaveBeenCalledOnce()
    await expect(runtime.execute(async () => 'not-run')).rejects.toMatchObject({
      code: 'RUNTIME_CLOSED',
    })
  })

  it('closes after an operation error without replacing that error when close also fails', async () => {
    const operationFailure = new Error('domain operation failed')
    const closeModelExecution = vi.fn<GenerationRuntimeEnvironment['closeModelExecution']>()
      .mockRejectedValue(new Error('close transport failed'))
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
      completeWithLease: vi.fn().mockResolvedValue({ content: 'done', finishReason: 'stop' }),
      closeModelExecution,
    }
    const runtime = await createGenerationRuntime({
      budget: { maxAttempts: 1, maxRequestedOutputTokens: 4096, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 60_000 },
    }, environment)

    await expect(runtime.execute(async () => {
      throw operationFailure
    })).rejects.toBe(operationFailure)

    expect(closeModelExecution).toHaveBeenCalledOnce()
  })

  it('closes a lease returned for the wrong frozen model before rejecting it', async () => {
    const closeModelExecution = vi.fn<GenerationRuntimeEnvironment['closeModelExecution']>()
      .mockResolvedValue(undefined)
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt({ modelId: 'model-b' })),
      completeWithLease: vi.fn().mockResolvedValue({ content: 'done', finishReason: 'stop' }),
      closeModelExecution,
    }

    await expect(createGenerationRuntime({
      budget: { maxAttempts: 1, maxRequestedOutputTokens: 4096, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 60_000 },
    }, environment)).rejects.toMatchObject({ code: 'LEASE_IDENTITY_MISMATCH' })
    expect(closeModelExecution).toHaveBeenCalledOnce()
    expect(closeModelExecution).toHaveBeenCalledWith('model-execution-lease-a')
  })

  it('closes and rejects a lease with malformed capability evidence before any request', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
    const closeModelExecution = vi.fn<GenerationRuntimeEnvironment['closeModelExecution']>()
      .mockResolvedValue(undefined)
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt({
        capabilityEvidence: {
          ...leaseReceipt().capabilityEvidence,
          subjectFingerprint: 'forged',
        },
      })),
      completeWithLease,
      closeModelExecution,
    }

    await expect(createGenerationRuntime({
      budget: { maxAttempts: 1, maxRequestedOutputTokens: 4096, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 60_000 },
    }, environment)).rejects.toMatchObject({ code: 'LEASE_CAPABILITY_INVALID' })
    expect(completeWithLease).not.toHaveBeenCalled()
    expect(closeModelExecution).toHaveBeenCalledWith('model-execution-lease-a')
  })

  it('redacts transport details and preserves a completed operation when lease cleanup fails', async () => {
    const secret = 'AQ.test-secret-in-transport'
    const beginFailureEnvironment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockRejectedValue(
        new GenerationRuntimeError('LEASE_BEGIN_FAILED', `https://provider.example?key=${secret}`),
      ),
      completeWithLease: vi.fn(),
      closeModelExecution: vi.fn(),
    }

    let beginFailure: unknown
    try {
      await createGenerationRuntime({
        budget: { maxAttempts: 1, maxRequestedOutputTokens: 4096, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 60_000 },
      }, beginFailureEnvironment)
    } catch (error) {
      beginFailure = error
    }
    expect(beginFailure).toMatchObject({ code: 'LEASE_BEGIN_FAILED' })
    expect(String(beginFailure)).not.toContain(secret)

    const closeModelExecution = vi.fn<GenerationRuntimeEnvironment['closeModelExecution']>()
      .mockRejectedValue(
        new GenerationRuntimeError('LEASE_CLOSE_FAILED', `close failed at ?key=${secret}`),
      )
    const closeFailureEnvironment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
      completeWithLease: vi.fn().mockResolvedValue({ content: 'done', finishReason: 'stop' }),
      closeModelExecution,
    }
    const runtime = await createGenerationRuntime({
      budget: { maxAttempts: 1, maxRequestedOutputTokens: 4096, maxRequestedOutputTokensPerAttempt: 4096, deadlineMs: 60_000 },
    }, closeFailureEnvironment)

    await expect(runtime.execute(async () => 'completed operation'))
      .resolves.toBe('completed operation')
    expect(closeModelExecution).toHaveBeenCalledOnce()
  })
})
