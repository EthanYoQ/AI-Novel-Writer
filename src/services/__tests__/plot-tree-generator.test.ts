import { describe, expect, it, vi } from 'vitest'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { PlotTreeSourceBundle } from '../../shared/plot-tree'
import type { GenerationRuntime } from '../generation/generation-runtime'
import {
  GenerationHarnessError,
  type GenerationOutcome,
  type GenerationSession,
  type GenerationTask,
} from '../generation/generation-harness'
import {
  generatePlotTree,
  parsePlotTreeSnapshot,
  PLOT_TREE_GENERATION_BUDGET,
  PlotTreeGenerationError,
} from '../plot-tree-generator'

const PROJECT_SESSION = Object.freeze({
  projectId: 'plot-project',
  leaseId: 'plot-lease',
  projectPath: 'C:/novels/plot-project',
}) satisfies ProjectSessionContext

function sources(): PlotTreeSourceBundle {
  const narrativeThread = {
    id: 7,
    title: 'Missing ledger',
    type: 'mystery',
    targetStartChapter: 1,
    targetEndChapter: 5,
    authorIntent: 'Reveal the forger in chapter five.',
    status: 'planted' as const,
    events: [{
      id: 11,
      type: 'planted' as const,
      evidence: 'the ledger was gone',
      reason: 'The finalized chapter plants the mystery.',
      chapterNumber: 1,
    }],
  }
  return {
    writingLanguage: 'en-US',
    synopsis: {
      content: 'A clerk investigates a ledger that vanished from a sealed safe.',
    },
    blueprints: [{
      chapterNumber: 1,
      title: 'The empty safe',
      purpose: 'Launch the investigation',
      keyEvents: 'The clerk discovers the missing ledger.',
    }],
    finalizedChapters: [{
      draftId: 41,
      chapterNumber: 1,
      title: 'The empty safe',
      summary: 'The ledger is missing and the clerk preserves the broken seal.',
    }],
    narrativeThreads: [narrativeThread],
    sourceRevision: '0'.repeat(64),
    snapshot: null,
  }
}

const modelResponse = {
  tracks: [{
    id: 'missing-ledger',
    title: 'Missing ledger investigation',
    role: 'main',
    startChapter: 1,
    endChapter: 5,
    summary: 'The clerk follows the missing ledger to its forger.',
    events: [
      {
        status: 'planned',
        chapterNumber: 1,
        summary: 'The investigation begins.',
        sources: [{ type: 'blueprint', chapterNumber: 1 }],
      },
      {
        status: 'occurred',
        chapterNumber: 1,
        summary: 'The disappearance is confirmed.',
        sources: [{ type: 'finalized-chapter', draftId: 41, chapterNumber: 1 }],
      },
      {
        status: 'occurred',
        chapterNumber: 1,
        summary: 'The mystery thread is planted.',
        sources: [{ type: 'narrative-thread', planId: 7, eventId: 11, chapterNumber: 1 }],
      },
    ],
  }],
}

describe('plot tree AI boundary', () => {
  it('allows one initial request plus one replacement in the ten-minute planning window', () => {
    expect(PLOT_TREE_GENERATION_BUDGET).toMatchObject({
      maxAttempts: 2,
      maxRequestedOutputTokens: 16_384,
      deadlineMs: 10 * 60_000,
    })
  })

  it('parses a complete snapshot and rejects references absent from the supplied facts', () => {
    expect(parsePlotTreeSnapshot(
      JSON.stringify(modelResponse),
      sources(),
      '2026-09-02T03:04:05.000Z',
    )).toMatchObject({
      version: 1,
      generatedAt: '2026-09-02T03:04:05.000Z',
      writingLanguage: 'en-US',
      sourceRevision: '0'.repeat(64),
      tracks: modelResponse.tracks,
    })

    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        events: [{
          status: 'planned', chapterNumber: 2, summary: 'Invented event.',
          sources: [{ type: 'blueprint', chapterNumber: 2 }],
        }],
      }],
    }), sources())).toThrow(/source|来源/u)
  })

  it('accepts one complete JSON fence without searching explanatory prose', () => {
    expect(parsePlotTreeSnapshot(
      `\`\`\`json\n${JSON.stringify(modelResponse)}\n\`\`\``,
      sources(),
      '2026-09-02T03:04:05.000Z',
    ).tracks).toEqual(modelResponse.tracks)

    expect(() => parsePlotTreeSnapshot(
      `Here is the result:\n${JSON.stringify(modelResponse)}`,
      sources(),
    )).toThrow()
  })

  it.each([
    ['occurred event backed only by a blueprint', {
      status: 'occurred', chapterNumber: 1, summary: 'Not yet written.',
      sources: [{ type: 'blueprint', chapterNumber: 1 }],
    }],
    ['event whose source belongs to another chapter', {
      status: 'planned', chapterNumber: 2, summary: 'Wrong chapter.',
      sources: [{ type: 'blueprint', chapterNumber: 1 }],
    }],
    ['planned event disguised as a confirmed narrative event', {
      status: 'planned', chapterNumber: 1, summary: 'Ambiguous source.',
      sources: [{ type: 'narrative-thread', planId: 7, chapterNumber: 1 }],
    }],
  ])('rejects %s', (_label, event) => {
    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{ ...modelResponse.tracks[0], events: [event] }],
    }), sources())).toThrow(/来源|章节/u)
  })

  it('rejects an event when any cited source contradicts its status', () => {
    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        events: [{
          status: 'planned',
          chapterNumber: 1,
          summary: 'Mixed provenance.',
          sources: [
            { type: 'blueprint', chapterNumber: 1 },
            { type: 'finalized-chapter', draftId: 41, chapterNumber: 1 },
          ],
        }],
      }],
    }), sources())).toThrow(/来源|章节/u)
  })

  it('rejects a subplot without a parent main track', () => {
    expect(() => parsePlotTreeSnapshot(JSON.stringify({
      tracks: [{
        ...modelResponse.tracks[0],
        id: 'orphan-subplot',
        role: 'subplot',
      }],
    }), sources())).toThrow(/支线|父轨道/u)
  })

  it('freezes the selected model into one bilingual structured generation call', async () => {
    let task: GenerationTask | undefined
    const runtime = {
      execute: vi.fn(async operation => operation({
        session: {
          budget: {
            maxAttempts: 1,
            maxRequestedOutputTokens: 8192,
            maxRequestedOutputTokensPerAttempt: 8192,
            deadlineAt: Date.now() + 10 * 60_000,
          },
          complete: vi.fn(async (value: GenerationTask) => {
            task = value
            return {
              status: 'completed' as const,
              content: JSON.stringify(modelResponse),
              finishReason: 'stop' as const,
              receipt: {} as never,
            }
          }),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as GenerationRuntime
    const createRuntime = vi.fn().mockResolvedValue(runtime)

    const result = await generatePlotTree({
      modelId: 'grok-frozen',
      projectSession: PROJECT_SESSION,
      sources: sources(),
      signal: new AbortController().signal,
    }, {
      createRuntime,
      now: () => '2026-09-02T03:04:05.000Z',
    })

    expect(createRuntime).toHaveBeenCalledWith({
      budget: PLOT_TREE_GENERATION_BUDGET,
      modelId: 'grok-frozen',
      projectSession: PROJECT_SESSION,
    })
    expect(task).toMatchObject({
      purpose: 'plot-tree-snapshot',
      reasoningStage: 'planning',
      output: 'structured-data',
    })
    expect(task?.messages[0]?.content).not.toMatch(/[\u3400-\u9fff]/u)
    expect(result.generatedAt).toBe('2026-09-02T03:04:05.000Z')
    expect(runtime.close).toHaveBeenCalledOnce()
  })

  it.each(['DEADLINE_EXHAUSTED', 'PROVIDER_REQUEST_FAILED'] as const)(
    'maps %s to a safe plot-tree generation error',
    async (code) => {
      const runtime = {
        execute: vi.fn().mockRejectedValue(
          new GenerationHarnessError(code, 'PRIVATE_PROVIDER_MESSAGE'),
        ),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as GenerationRuntime

      let failure: unknown
      try {
        await generatePlotTree({
          modelId: 'grok-frozen',
          projectSession: PROJECT_SESSION,
          sources: sources(),
          signal: new AbortController().signal,
        }, {
          createRuntime: vi.fn().mockResolvedValue(runtime),
          now: () => '2026-09-02T03:04:05.000Z',
        })
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(PlotTreeGenerationError)
      expect(failure).toMatchObject({ code, message: code })
      expect((failure as Error).message).not.toContain('PRIVATE_PROVIDER_MESSAGE')
      expect(runtime.close).toHaveBeenCalledOnce()
    },
  )

  it('projects oversized project sources into a bounded model input', async () => {
    const oversized = sources()
    oversized.synopsis.content = 'S'.repeat(10_000)
    oversized.blueprints = Array.from({ length: 121 }, (_, index) => ({
      chapterNumber: index + 1,
      title: `Title ${index} ${'T'.repeat(500)}`,
      purpose: 'P'.repeat(1_000),
      keyEvents: 'K'.repeat(1_000),
    }))
    oversized.finalizedChapters = Array.from({ length: 121 }, (_, index) => ({
      draftId: 41 + index,
      chapterNumber: index + 1,
      title: `Final ${index} ${'T'.repeat(500)}`,
      summary: 'F'.repeat(1_000),
    }))
    oversized.narrativeThreads = Array.from({ length: 41 }, (_, index) => ({
      id: 7 + index,
      title: `Thread ${index} ${'T'.repeat(500)}`,
      type: `Type ${index} ${'Y'.repeat(500)}`,
      targetStartChapter: 1,
      targetEndChapter: 5,
      authorIntent: 'A'.repeat(1_000),
      status: 'planted' as const,
      events: Array.from({ length: 13 }, (_, eventIndex) => ({
        id: 11 + eventIndex,
        chapterNumber: 1,
        type: 'planted' as const,
        evidence: 'E'.repeat(1_000),
        reason: 'R'.repeat(1_000),
      })),
    }))
    let task: GenerationTask | undefined
    const runtime = {
      execute: vi.fn(async operation => operation({
        session: {
          budget: {
            maxAttempts: 2,
            maxRequestedOutputTokens: 16_384,
            maxRequestedOutputTokensPerAttempt: 8192,
            deadlineAt: Date.now() + 10 * 60_000,
          },
          complete: vi.fn(async (value: GenerationTask) => {
            task = value
            return {
              status: 'completed' as const,
              content: JSON.stringify(modelResponse),
              finishReason: 'stop' as const,
              receipt: {} as never,
            }
          }),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as GenerationRuntime

    await generatePlotTree({
      modelId: 'grok-frozen',
      projectSession: PROJECT_SESSION,
      sources: oversized,
      signal: new AbortController().signal,
    }, {
      createRuntime: vi.fn().mockResolvedValue(runtime),
      now: () => '2026-09-02T03:04:05.000Z',
    })

    const facts = JSON.parse(task?.messages[1]?.content ?? '{}')
    expect(facts.synopsis).toHaveLength(6_000)
    expect(facts.blueprints).toHaveLength(120)
    expect(facts.finalizedChapters).toHaveLength(120)
    expect(facts.narrativeThreads).toHaveLength(40)
    expect(facts.narrativeThreads[0].events).toHaveLength(12)
    expect(facts.blueprints.at(-1).chapterNumber).toBe(121)
    expect(facts.finalizedChapters.at(-1).chapterNumber).toBe(121)
    expect(facts.narrativeThreads.at(-1).id).toBe(47)
    expect(facts.narrativeThreads[0].events.at(-1).id).toBe(23)
    expect(facts.blueprints[0]).toMatchObject({
      title: expect.stringMatching(/^Title 0/u),
      purpose: expect.stringMatching(/^P+…P+$/u),
      keyEvents: expect.stringMatching(/^K+…K+$/u),
    })
  })

  it.each([
    ['length', {
      status: 'incomplete',
      content: 'PRIVATE_TRUNCATED_OUTPUT',
      finishReason: 'length',
      receipt: {} as never,
    }],
    ['invalid_json', {
      status: 'completed',
      content: 'PRIVATE_MODEL_OUTPUT is not JSON',
      finishReason: 'stop',
      receipt: {} as never,
    }],
    ['invalid_contract', {
      status: 'completed',
      content: JSON.stringify({
        tracks: [{
          ...modelResponse.tracks[0],
          events: [{
            status: 'planned',
            chapterNumber: 1,
            summary: 'PRIVATE_MODEL_OUTPUT',
            sources: [{ type: 'synopsis', chapterNumber: 1 }],
          }],
        }],
      }),
      finishReason: 'stop',
      receipt: {} as never,
    }],
  ] satisfies Array<[string, GenerationOutcome]>)('requests one clean full replacement after %s', async (_reason, firstOutcome) => {
    const complete = vi.fn<GenerationSession['complete']>()
      .mockResolvedValueOnce(firstOutcome)
      .mockResolvedValueOnce({
        status: 'completed',
        content: JSON.stringify(modelResponse),
        finishReason: 'stop',
        receipt: {} as never,
      })
    const runtime = {
      execute: vi.fn(async operation => operation({
        session: {
          budget: {
            maxAttempts: 2,
            maxRequestedOutputTokens: 16_384,
            maxRequestedOutputTokensPerAttempt: 8192,
            deadlineAt: Date.now() + 10 * 60_000,
          },
          complete,
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as GenerationRuntime
    const plotSources = sources()
    plotSources.writingLanguage = 'zh-CN'

    await expect(generatePlotTree({
      modelId: 'grok-frozen',
      projectSession: PROJECT_SESSION,
      sources: plotSources,
      signal: new AbortController().signal,
    }, {
      createRuntime: vi.fn().mockResolvedValue(runtime),
      now: () => '2026-09-02T03:04:05.000Z',
    })).resolves.toMatchObject({ tracks: modelResponse.tracks })

    expect(complete).toHaveBeenCalledTimes(2)
    const initial = complete.mock.calls[0]?.[0]
    const replacement = complete.mock.calls[1]?.[0]
    expect(replacement?.purpose).toBe('plot-tree-snapshot-replacement')
    expect(replacement?.messages.map(message => message.content).join('\n'))
      .toContain('完整替代')
    for (const request of [initial, replacement]) {
      expect(request?.messages.map(message => message.content).join('\n'))
        .toContain('绝不能输出 source.type="synopsis"')
    }
    expect(replacement?.messages.map(message => message.content).join('\n'))
      .not.toMatch(/PRIVATE_(?:TRUNCATED_)?MODEL_OUTPUT|PRIVATE_TRUNCATED_OUTPUT/u)
  })

  it('reports malformed model output as JSON syntax failure without echoing it', async () => {
    const runtime = {
      execute: vi.fn(async operation => operation({
        session: {
          budget: {
            maxAttempts: 1,
            maxRequestedOutputTokens: 8192,
            maxRequestedOutputTokensPerAttempt: 8192,
            deadlineAt: Date.now() + 10 * 60_000,
          },
          complete: vi.fn().mockResolvedValue({
            status: 'completed',
            content: 'PRIVATE_MODEL_OUTPUT is not JSON',
            finishReason: 'stop',
            receipt: {},
          }),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as GenerationRuntime

    try {
      await generatePlotTree({
        modelId: 'grok-frozen',
        projectSession: PROJECT_SESSION,
        sources: sources(),
        signal: new AbortController().signal,
      }, {
        createRuntime: vi.fn().mockResolvedValue(runtime),
        now: () => '2026-09-02T03:04:05.000Z',
      })
      expect.fail('Expected malformed output to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ code: 'invalid_json' })
      expect((error as Error).message).toContain('parseable plot-tree JSON')
      expect((error as Error).message).not.toContain('PRIVATE_MODEL_OUTPUT')
    }
  })

  it('reports a source-contract violation separately from invalid JSON', async () => {
    const runtime = {
      execute: vi.fn(async operation => operation({
        session: {
          budget: {
            maxAttempts: 1,
            maxRequestedOutputTokens: 8192,
            maxRequestedOutputTokensPerAttempt: 8192,
            deadlineAt: Date.now() + 10 * 60_000,
          },
          complete: vi.fn().mockResolvedValue({
            status: 'completed',
            content: JSON.stringify({
              tracks: [{
                ...modelResponse.tracks[0],
                events: [{
                  status: 'planned',
                  chapterNumber: 99,
                  summary: 'PRIVATE_MODEL_OUTPUT',
                  sources: [{ type: 'blueprint', chapterNumber: 99 }],
                }],
              }],
            }),
            finishReason: 'stop',
            receipt: {},
          }),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as GenerationRuntime

    try {
      await generatePlotTree({
        modelId: 'grok-frozen',
        projectSession: PROJECT_SESSION,
        sources: sources(),
        signal: new AbortController().signal,
      }, {
        createRuntime: vi.fn().mockResolvedValue(runtime),
        now: () => '2026-09-02T03:04:05.000Z',
      })
      expect.fail('Expected the source-contract violation to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ code: 'invalid_contract' })
      expect((error as Error).message).toContain('invalid plot-tree structure')
      expect((error as Error).message).not.toContain('PRIVATE_MODEL_OUTPUT')
    }
  })

  it.each([
    ['length', 'maximum output length'],
    ['content_filter', 'content policy'],
    ['cancelled', 'cancelled'],
    ['error', 'did not complete'],
  ] as const)('preserves the %s terminal reason in the user-visible failure', async (finishReason, message) => {
    const runtime = {
      execute: vi.fn(async operation => operation({
        session: {
          budget: {
            maxAttempts: 1,
            maxRequestedOutputTokens: 8192,
            maxRequestedOutputTokensPerAttempt: 8192,
            deadlineAt: Date.now() + 10 * 60_000,
          },
          complete: vi.fn().mockResolvedValue({
            status: 'incomplete',
            content: '{"tracks":[]}',
            finishReason,
            receipt: {},
          }),
        },
      })),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as GenerationRuntime

    await expect(generatePlotTree({
      modelId: 'grok-frozen',
      projectSession: PROJECT_SESSION,
      sources: sources(),
      signal: new AbortController().signal,
    }, {
      createRuntime: vi.fn().mockResolvedValue(runtime),
      now: () => '2026-09-02T03:04:05.000Z',
    })).rejects.toMatchObject({
      finishReason,
      message: expect.stringContaining(message),
    })
    expect(runtime.close).toHaveBeenCalledOnce()
  })
})
