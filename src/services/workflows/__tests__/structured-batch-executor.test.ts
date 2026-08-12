import { describe, expect, it, vi } from 'vitest'

import {
  createStructuredBatchExecutor,
  type StructuredBatchContract,
} from '../structured-batch-executor'
import {
  createGenerationHarness,
  GenerationAttemptError,
  type GenerationOutcome,
  GenerationAttemptReceipt,
  type GenerationSession,
  type GenerationTask,
} from '../../generation/generation-harness'

type Blueprint = {
  chapterNumber: number
  title: string
}

const blueprintContract: StructuredBatchContract<number, Blueprint> = {
  buildTask: ({ items, validatedPrefix }) => ({
    purpose: 'chapter-blueprints',
    output: 'structured-data',
    messages: [{
      role: 'user',
      content: JSON.stringify({ items, validatedPrefix }),
    }],
  }),
  inputKey: chapterNumber => chapterNumber,
  outputKey: blueprint => blueprint.chapterNumber,
  decode: content => (JSON.parse(content) as { blueprints: Blueprint[] }).blueprints,
  validateItem: blueprint => blueprint.title.trim() ? undefined : '标题不能为空',
}

type AttemptRequest = {
  items: readonly number[]
  validatedPrefix: readonly Blueprint[]
}

type AttemptResult =
  | { status: 'completed'; content: string; requestedTokens: number }
  | {
      status: 'incomplete'
      reason: 'output_limit' | 'safety' | 'cancelled' | 'unknown'
      content: string
      requestedTokens: number
    }
  | {
      status: 'failed'
      reason: 'server_error' | 'authentication'
      requestedTokens: number
    }

type AttemptHandler = (request: AttemptRequest) => Promise<AttemptResult>

function taskPayload(task: GenerationTask): AttemptRequest {
  const message = task.messages.find(candidate => candidate.role === 'user')
  if (!message) throw new Error('test task is missing its user message')
  return JSON.parse(message.content) as AttemptRequest
}

function attemptReceipt(
  attempt: number,
  requestedTokens: number,
  cumulativeRequestedTokens: number,
  finishReason: GenerationAttemptReceipt['finishReason'],
): GenerationAttemptReceipt {
  return {
    model: {
      id: 'test-model',
      configurationRevision: 'revision-1',
      endpointFingerprint: 'openai|custom|test|model',
    },
    capabilities: {
      contextWindowTokens: 32_768,
      maxOutputTokens: requestedTokens,
      reasoning: null,
      structuredOutput: true,
      usage: true,
      source: {
        contextWindowTokens: 'verified-provider-preset',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'verified-provider-preset',
      },
    },
    budget: {
      attempt,
      maxAttempts: 20,
      requestedOutputTokens: requestedTokens,
      cumulativeRequestedOutputTokens: cumulativeRequestedTokens,
      maxRequestedOutputTokens: 10_000,
      maxRequestedOutputTokensPerAttempt: requestedTokens,
      deadlineAt: 10_000,
    },
    finishReason,
  }
}

function createSession(handler: AttemptHandler): Pick<GenerationSession, 'complete'> {
  let attempts = 0
  let cumulativeRequestedTokens = 0

  return {
    async complete(task) {
      attempts += 1
      const attempt = await handler(taskPayload(task))
      cumulativeRequestedTokens += attempt.requestedTokens
      if (attempt.status === 'failed') {
        throw new GenerationAttemptError(
          'PROVIDER_REQUEST_FAILED',
          '模型请求失败。',
          attemptReceipt(
            attempts,
            attempt.requestedTokens,
            cumulativeRequestedTokens,
            'error',
          ),
        )
      }
      if (attempt.status === 'incomplete') {
        const finishReason: Exclude<GenerationOutcome['finishReason'], 'stop'> = attempt.reason === 'output_limit'
          ? 'length'
          : attempt.reason === 'safety'
            ? 'content_filter'
            : attempt.reason
        return {
          status: 'incomplete',
          content: attempt.content,
          finishReason,
          receipt: attemptReceipt(
            attempts,
            attempt.requestedTokens,
            cumulativeRequestedTokens,
            finishReason,
          ),
        }
      }
      return {
        status: 'completed',
        content: attempt.content,
        finishReason: 'stop',
        receipt: attemptReceipt(
          attempts,
          attempt.requestedTokens,
          cumulativeRequestedTokens,
          'stop',
        ),
      }
    },
  }
}

function blueprintJson(chapters: readonly number[]): string {
  return JSON.stringify({
    blueprints: chapters.map(chapterNumber => ({
      chapterNumber,
      title: `第${chapterNumber}章`,
    })),
  })
}

describe('StructuredBatchExecutor seam', () => {
  it('uses GenerationSession as the sole billable budget gate before another physical attempt starts', async () => {
    const physicalComplete = vi.fn(async () => ({
      content: '{"blueprints":[',
      finishReason: 'length' as const,
    }))
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({
          revision: 'revision-budget-owner',
          model: {
            id: 'model-budget-owner',
            name: 'Budget owner',
            provider: 'custom',
            protocol: 'openai',
            modelName: 'budget-owner',
            apiKey: 'test-only',
            baseUrl: 'https://example.invalid/v1',
            temperature: 0.7,
            maxTokens: 100,
            purposes: ['generation'],
          },
        }),
      },
      completionPort: { complete: physicalComplete },
      policy: {
        maxAttempts: 2,
        maxRequestedOutputTokens: 200,
        maxRequestedOutputTokensPerAttempt: 100,
        deadlineMs: 60_000,
      },
      now: () => 0,
    })
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: harness.openSession(),
    })

    const result = await executor.execute({
      items: [1, 2, 3, 4, 5],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'limit_exceeded', reason: 'max_calls' },
      receipt: { calls: 2, requestedTokens: 200 },
    })
    expect(physicalComplete).toHaveBeenCalledTimes(2)
  })

  it('partitions a logical range by the contract batch limit and keeps one validated prefix across chunks', async () => {
    const observed: Array<{ items: readonly number[]; prefix: readonly number[] }> = []
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(async request => {
        observed.push({
          items: [...request.items],
          prefix: request.validatedPrefix.map(item => item.chapterNumber),
        })
        return {
          status: 'completed',
          content: blueprintJson(request.items),
          requestedTokens: 100,
        }
      }),
    })

    const result = await executor.execute({
      items: [1, 2, 3, 4, 5, 6, 7],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: true,
      items: [
        { chapterNumber: 1 },
        { chapterNumber: 2 },
        { chapterNumber: 3 },
        { chapterNumber: 4 },
        { chapterNumber: 5 },
        { chapterNumber: 6 },
        { chapterNumber: 7 },
      ],
      receipt: { calls: 2 },
    })
    expect(observed).toEqual([
      { items: [1, 2, 3, 4, 5], prefix: [] },
      { items: [6, 7], prefix: [1, 2, 3, 4, 5] },
    ])
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid semantic batch limit %s without starting generation',
    async maxBatchItems => {
      const generate = vi.fn<AttemptHandler>(async request => ({
        status: 'completed',
        content: blueprintJson(request.items),
        requestedTokens: 100,
      }))
      const executor = createStructuredBatchExecutor({
        contract: blueprintContract,
        session: createSession(generate),
      })

      const result = await executor.execute({
        items: [1],
        limits: { maxBatchItems },
      })

      expect(result).toMatchObject({
        ok: false,
        failure: { code: 'limit_exceeded', reason: 'invalid_limit' },
        receipt: { calls: 0, requestedTokens: 0 },
      })
      expect(generate).not.toHaveBeenCalled()
    },
  )

  it('splits five output-limited items into ordered 2+3 attempts and exposes the validated prefix to the later batch', async () => {
    const observed: Array<{ items: readonly number[]; prefix: readonly number[] }> = []
    const generate = vi.fn<AttemptHandler>(async request => {
      observed.push({
        items: [...request.items],
        prefix: request.validatedPrefix.map(item => item.chapterNumber),
      })

      if (request.items.length === 5) {
        return {
          status: 'incomplete',
          reason: 'output_limit',
          content: '{"blueprints":[',
          requestedTokens: 100,
        }
      }

      return {
        status: 'completed',
        content: blueprintJson(request.items),
        requestedTokens: 100,
      }
    })
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(generate),
    })

    const result = await executor.execute({
      items: [1, 2, 3, 4, 5],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: true,
      items: [
        { chapterNumber: 1, title: '第1章' },
        { chapterNumber: 2, title: '第2章' },
        { chapterNumber: 3, title: '第3章' },
        { chapterNumber: 4, title: '第4章' },
        { chapterNumber: 5, title: '第5章' },
      ],
      receipt: {
        calls: 3,
        splitCount: 1,
        requestedTokens: 300,
        attempts: [
          { finishReason: 'length', budget: { attempt: 1, requestedOutputTokens: 100 } },
          { finishReason: 'stop', budget: { attempt: 2, requestedOutputTokens: 100 } },
          { finishReason: 'stop', budget: { attempt: 3, requestedOutputTokens: 100 } },
        ],
      },
    })
    expect(observed).toEqual([
      { items: [1, 2, 3, 4, 5], prefix: [] },
      { items: [1, 2], prefix: [] },
      { items: [3, 4, 5], prefix: [1, 2] },
    ])
  })

  it('returns no publishable items when an earlier split batch succeeds and a later batch fails', async () => {
    const generate = vi.fn<AttemptHandler>(async request => {
      if (request.items.length === 5) {
        return {
          status: 'incomplete',
          reason: 'output_limit',
          content: '{"blueprints":[',
          requestedTokens: 100,
        }
      }
      if (request.items[0] === 1) {
        return {
          status: 'completed',
          content: blueprintJson(request.items),
          requestedTokens: 100,
        }
      }
      return {
        status: 'failed',
        reason: 'server_error',
        requestedTokens: 100,
      }
    })
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(generate),
    })

    const result = await executor.execute({
      items: [1, 2, 3, 4, 5],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'generation_failed',
        reason: 'server_error',
      },
      receipt: {
        calls: 3,
        splitCount: 1,
        requestedTokens: 300,
      },
    })
    expect(result).not.toHaveProperty('items')
  })

  it('rejects a completed response that omits a requested item', async () => {
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(vi.fn<AttemptHandler>(async () => ({
        status: 'completed',
        content: blueprintJson([1, 2, 4, 5]),
        requestedTokens: 100,
      }))),
    })

    const result = await executor.execute({
      items: [1, 2, 3, 4, 5],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'invalid_output',
        reason: 'missing_item',
      },
    })
    expect(result).not.toHaveProperty('items')
  })

  it('rejects a completed response that duplicates a requested item', async () => {
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(vi.fn<AttemptHandler>(async () => ({
        status: 'completed',
        content: blueprintJson([1, 2, 2, 3]),
        requestedTokens: 100,
      }))),
    })

    const result = await executor.execute({
      items: [1, 2, 3],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'invalid_output',
        reason: 'duplicate_item',
      },
    })
    expect(result).not.toHaveProperty('items')
  })

  it('rejects a completed response containing an item outside the requested batch', async () => {
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(vi.fn<AttemptHandler>(async () => ({
        status: 'completed',
        content: blueprintJson([1, 2, 3, 4]),
        requestedTokens: 100,
      }))),
    })

    const result = await executor.execute({
      items: [1, 2, 3],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'invalid_output',
        reason: 'unexpected_item',
      },
    })
    expect(result).not.toHaveProperty('items')
  })

  it('returns validated items in requested order when a provider reorders them', async () => {
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(vi.fn<AttemptHandler>(async () => ({
        status: 'completed',
        content: blueprintJson([3, 1, 2]),
        requestedTokens: 100,
      }))),
    })

    const result = await executor.execute({
      items: [1, 2, 3],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: true,
      items: [
        { chapterNumber: 1 },
        { chapterNumber: 2 },
        { chapterNumber: 3 },
      ],
    })
  })

  it('rejects a completed response whose required field is empty', async () => {
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(vi.fn<AttemptHandler>(async () => ({
        status: 'completed',
        content: JSON.stringify({ blueprints: [{ chapterNumber: 1, title: '   ' }] }),
        requestedTokens: 100,
      }))),
    })

    const result = await executor.execute({
      items: [1],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'invalid_output',
        reason: 'invalid_item',
      },
    })
    expect(result).not.toHaveProperty('items')
  })

  it('rejects a malformed item when contract validation throws on a missing required field', async () => {
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(vi.fn<AttemptHandler>(async () => ({
        status: 'completed',
        content: JSON.stringify({ blueprints: [{ chapterNumber: 1 }] }),
        requestedTokens: 100,
      }))),
    })

    const result = await executor.execute({
      items: [1],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'invalid_output', reason: 'invalid_item' },
      receipt: { calls: 1, requestedTokens: 100 },
    })
    expect(result).not.toHaveProperty('items')
  })

  it('classifies malformed structured content as invalid output', async () => {
    let attempt = 0
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: {
        complete: vi.fn<GenerationSession['complete']>(async () => {
          attempt += 1
          return {
            status: 'completed',
            content: '{"blueprints":[',
            finishReason: 'stop',
            receipt: attemptReceipt(attempt, 100, attempt * 100, 'stop'),
          }
        }),
      },
    })

    const result = await executor.execute({
      items: [1],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'invalid_output', reason: 'malformed_output' },
      receipt: { calls: 2, requestedTokens: 200 },
    })
    expect(result).not.toHaveProperty('items')
  })

  it('repairs one completed malformed JSON response through the same generation session and accounts for both attempts', async () => {
    const complete = vi.fn<GenerationSession['complete']>(async (task) => {
      if (task.purpose === 'chapter-blueprints') {
        return {
          status: 'completed',
          content: '{"blueprints":[{"chapterNumber":1,"title":"第1章"}',
          finishReason: 'stop',
          receipt: attemptReceipt(1, 100, 100, 'stop'),
        }
      }
      expect(task).toMatchObject({
        purpose: 'chapter-blueprints:structured-syntax-repair',
        output: 'structured-data',
      })
      const repairPrompt = task.messages.map(message => message.content).join('\n')
      expect(repairPrompt).toContain('"items":[1]')
      expect(repairPrompt).toContain('{"blueprints":[{"chapterNumber":1')
      expect(repairPrompt).toContain('完整替代 JSON')
      return {
        status: 'completed',
        content: blueprintJson([1]),
        finishReason: 'stop',
        receipt: attemptReceipt(2, 100, 200, 'stop'),
      }
    })
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: { complete },
    })

    const result = await executor.execute({
      items: [1],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: true,
      items: [{ chapterNumber: 1, title: '第1章' }],
      receipt: {
        calls: 2,
        requestedTokens: 200,
        attempts: [
          { finishReason: 'stop', budget: { attempt: 1 } },
          { finishReason: 'stop', budget: { attempt: 2 } },
        ],
      },
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['missing item', '{"blueprints":[]}', 'missing_item'],
    ['duplicate item', '{"blueprints":[{"chapterNumber":1,"title":"甲"},{"chapterNumber":1,"title":"乙"}]}', 'duplicate_item'],
    ['invalid field', '{"blueprints":[{"chapterNumber":1,"title":""}]}', 'invalid_item'],
  ] as const)('does not syntax-repair parseable JSON with a %s semantic violation', async (_case, content, reason) => {
    const complete = vi.fn<GenerationSession['complete']>(async () => ({
      status: 'completed',
      content,
      finishReason: 'stop',
      receipt: attemptReceipt(1, 100, 100, 'stop'),
    }))
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: { complete },
    })

    const result = await executor.execute({
      items: [1],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'invalid_output', reason },
      receipt: { calls: 1, requestedTokens: 100 },
    })
    expect(result).not.toHaveProperty('items')
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('does not syntax-repair parseable JSON rejected while crossing the contract decode seam', async () => {
    const complete = vi.fn<GenerationSession['complete']>(async () => ({
      status: 'completed',
      content: '{"blueprints":[]}',
      finishReason: 'stop',
      receipt: attemptReceipt(1, 100, 100, 'stop'),
    }))
    const executor = createStructuredBatchExecutor({
      contract: {
        ...blueprintContract,
        decode: (content) => {
          JSON.parse(content)
          throw new Error('domain coverage failed')
        },
      },
      session: { complete },
    })

    const result = await executor.execute({
      items: [1],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'invalid_output', reason: 'invalid_item' },
      receipt: { calls: 1, requestedTokens: 100 },
    })
    expect(result).not.toHaveProperty('items')
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['length', 'length', 'limit_exceeded', 'output_limit'],
    ['safety filter', 'content_filter', 'generation_failed', 'safety'],
    ['provider error outcome', 'error', 'generation_failed', 'server_error'],
  ] as const)('fails closed when the one syntax repair ends with %s', async (_case, finishReason, code, reason) => {
    let attempt = 0
    const complete = vi.fn<GenerationSession['complete']>(async () => {
      attempt += 1
      if (attempt === 1) {
        return {
          status: 'completed',
          content: '{"blueprints":[',
          finishReason: 'stop',
          receipt: attemptReceipt(1, 100, 100, 'stop'),
        }
      }
      return {
        status: 'incomplete',
        content: '',
        finishReason,
        receipt: attemptReceipt(2, 100, 200, finishReason),
      }
    })
    const executor = createStructuredBatchExecutor({ contract: blueprintContract, session: { complete } })

    const result = await executor.execute({ items: [1], limits: { maxBatchItems: 5 } })

    expect(result).toMatchObject({
      ok: false,
      failure: { code, reason },
      receipt: { calls: 2, requestedTokens: 200 },
    })
    expect(result).not.toHaveProperty('items')
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('lets GenerationSession reject syntax repair before a second billable call when the global attempt budget is exhausted', async () => {
    const physicalComplete = vi.fn(async () => ({
      content: '{"blueprints":[',
      finishReason: 'stop' as const,
    }))
    const harness = createGenerationHarness({
      modelSource: {
        snapshotDefaultModel: () => ({
          revision: 'repair-budget-revision',
          model: {
            id: 'repair-budget-model',
            name: 'Repair budget model',
            provider: 'custom',
            protocol: 'openai',
            modelName: 'repair-budget-model',
            apiKey: 'test-only',
            baseUrl: 'https://example.invalid/v1',
            temperature: 0.7,
            maxTokens: 100,
            purposes: ['generation'],
          },
        }),
      },
      completionPort: { complete: physicalComplete },
      policy: {
        maxAttempts: 1,
        maxRequestedOutputTokens: 100,
        maxRequestedOutputTokensPerAttempt: 100,
        deadlineMs: 60_000,
      },
      now: () => 0,
    })
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: harness.openSession(),
    })

    const result = await executor.execute({ items: [1], limits: { maxBatchItems: 5 } })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'limit_exceeded', reason: 'max_calls' },
      receipt: { calls: 1, requestedTokens: 100 },
    })
    expect(result).not.toHaveProperty('items')
    expect(physicalComplete).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['candidate', false],
    ['contract', true],
  ] as const)('refuses syntax repair when the complete %s evidence exceeds its UTF-8 byte limit', async (_case, oversizedContract) => {
    const complete = vi.fn<GenerationSession['complete']>(async () => ({
      status: 'completed',
      content: oversizedContract ? '{"blueprints":[' : `{"blueprints":"${'界'.repeat(11_000)}`,
      finishReason: 'stop',
      receipt: attemptReceipt(1, 100, 100, 'stop'),
    }))
    const contract: StructuredBatchContract<number, Blueprint> = oversizedContract
      ? {
          ...blueprintContract,
          buildTask: ({ items, validatedPrefix }) => ({
            purpose: 'oversized-contract',
            output: 'structured-data',
            messages: [{
              role: 'user',
              content: JSON.stringify({ items, validatedPrefix, contract: '界'.repeat(11_000) }),
            }],
          }),
        }
      : blueprintContract
    const executor = createStructuredBatchExecutor({ contract, session: { complete } })

    const result = await executor.execute({ items: [1], limits: { maxBatchItems: 5 } })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'invalid_output', reason: 'malformed_output' },
      receipt: { calls: 1, requestedTokens: 100 },
    })
    expect(result).not.toHaveProperty('items')
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('allows at most one syntax repair across all batches in one executor run', async () => {
    let attempt = 0
    const complete = vi.fn<GenerationSession['complete']>(async (task) => {
      attempt += 1
      if (attempt === 2) {
        return {
          status: 'completed',
          content: blueprintJson([1]),
          finishReason: 'stop',
          receipt: attemptReceipt(2, 100, 200, 'stop'),
        }
      }
      expect(task.purpose).toBe('chapter-blueprints')
      return {
        status: 'completed',
        content: '{"blueprints":[',
        finishReason: 'stop',
        receipt: attemptReceipt(attempt, 100, attempt * 100, 'stop'),
      }
    })
    const executor = createStructuredBatchExecutor({ contract: blueprintContract, session: { complete } })

    const result = await executor.execute({ items: [1, 2], limits: { maxBatchItems: 1 } })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'invalid_output', reason: 'malformed_output' },
      receipt: { calls: 3, requestedTokens: 300 },
    })
    expect(result).not.toHaveProperty('items')
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('lets the contract decode a complete fenced JSON envelope without spending the syntax repair', async () => {
    const complete = vi.fn<GenerationSession['complete']>(async () => ({
      status: 'completed',
      content: `\`\`\`json\n${blueprintJson([1])}\n\`\`\``,
      finishReason: 'stop',
      receipt: attemptReceipt(1, 100, 100, 'stop'),
    }))
    const executor = createStructuredBatchExecutor({
      contract: {
        ...blueprintContract,
        decode: content => blueprintContract.decode(content.replace(/^```json\s*|\s*```$/gu, '')),
      },
      session: { complete },
    })

    const result = await executor.execute({ items: [1], limits: { maxBatchItems: 5 } })

    expect(result).toMatchObject({
      ok: true,
      items: [{ chapterNumber: 1 }],
      receipt: { calls: 1, requestedTokens: 100 },
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['server_error'],
    ['authentication'],
  ] as const)('does not split a five-item batch after a %s provider failure', async (reason) => {
    const generate = vi.fn<AttemptHandler>(async () => ({
      status: 'failed',
      reason,
      requestedTokens: 100,
    }))
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(generate),
    })

    const result = await executor.execute({
      items: [1, 2, 3, 4, 5],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'generation_failed', reason: 'server_error' },
      receipt: { calls: 1, splitCount: 0, requestedTokens: 100 },
    })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('does not split a five-item batch after a safety-filtered outcome', async () => {
    const generate = vi.fn<AttemptHandler>(async () => ({
      status: 'incomplete',
      reason: 'safety',
      content: '',
      requestedTokens: 100,
    }))
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(generate),
    })

    const result = await executor.execute({
      items: [1, 2, 3, 4, 5],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'generation_failed', reason: 'safety' },
      receipt: { calls: 1, splitCount: 0, requestedTokens: 100 },
    })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('returns a cancelled receipt without starting generation when the caller is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const generate = vi.fn<AttemptHandler>(async request => ({
      status: 'completed',
      content: blueprintJson(request.items),
      requestedTokens: 100,
    }))
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(generate),
    })

    const result = await executor.execute({
      items: [1],
      signal: controller.signal,
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'cancelled',
        reason: 'cancelled',
      },
      receipt: { calls: 0, requestedTokens: 0 },
    })
    expect(generate).not.toHaveBeenCalled()
  })

  it('passes cancellation into an in-flight generation attempt and keeps its spent-token receipt', async () => {
    const controller = new AbortController()
    const complete = vi.fn<GenerationSession['complete']>(async (_task, options) => {
      controller.abort()
      expect(options?.signal).toBe(controller.signal)
      expect(options?.signal?.aborted).toBe(true)
      throw new GenerationAttemptError(
        'CANCELLED',
        '生成请求已取消。',
        attemptReceipt(1, 100, 100, 'cancelled'),
      )
    })
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: { complete },
    })

    const result = await executor.execute({
      items: [1, 2, 3, 4, 5],
      signal: controller.signal,
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'cancelled', reason: 'cancelled' },
      receipt: { calls: 1, splitCount: 0, requestedTokens: 100 },
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('does not expose an unexpected session error message', async () => {
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: {
        complete: vi.fn<GenerationSession['complete']>(async () => {
          throw new Error('Bearer test-secret must not escape')
        }),
      },
    })

    const result = await executor.execute({
      items: [1],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'generation_failed',
        reason: 'server_error',
        message: '结构化生成失败',
      },
    })
    expect(JSON.stringify(result)).not.toContain('test-secret')
  })

  it('fails once when one output-limited item cannot be split any further', async () => {
    const generate = vi.fn<AttemptHandler>(async () => ({
      status: 'incomplete',
      reason: 'output_limit',
      content: '{"blueprints":[',
      requestedTokens: 100,
    }))
    const executor = createStructuredBatchExecutor({
      contract: blueprintContract,
      session: createSession(generate),
    })

    const result = await executor.execute({
      items: [1],
      limits: { maxBatchItems: 5 },
    })

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: 'limit_exceeded',
        reason: 'output_limit',
      },
      receipt: {
        calls: 1,
        splitCount: 0,
        requestedTokens: 100,
      },
    })
    expect(generate).toHaveBeenCalledTimes(1)
  })
})
