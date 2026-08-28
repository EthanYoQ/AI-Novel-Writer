import { describe, expect, it, vi } from 'vitest'

import type {
  ImportRunChapterSnapshot,
  ImportRunEffectReceipt,
  ImportRunSnapshot,
  ImportRunStage,
} from '../../../shared/import-run'
import {
  IMPORT_CHAPTER_PAGE_SIZE,
  IMPORT_KNOWLEDGE_BATCH_SIZE,
  ImportRunOrchestrator,
  type ImportRunOrchestratorDependencies,
} from '../import-run-orchestrator'

function runSnapshot(overrides: Partial<ImportRunSnapshot> = {}): ImportRunSnapshot {
  return {
    id: 'run-1', purpose: 'reference', rootRunId: 'run-1', effectNamespace: 'import:reference:run-1',
    sourceFingerprint: 'a'.repeat(64), manifestFingerprint: 'b'.repeat(64),
    sourceDisplay: [{ displayName: 'reference.txt', mediaType: 'text/plain', size: 1 }],
    locale: 'en-US', stage: 'knowledge', status: 'running', completedBatches: {},
    lastError: '', resumable: true, cancelRequested: false, totalChapters: 25,
    totalContentSize: 100, manifestChapterCount: 25, manifestContentSize: 100,
    manifestWordCount: 100, completedChapters: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
    ...overrides,
  }
}

function chapter(number: number): ImportRunChapterSnapshot {
  return {
    number, title: `Chapter ${number}`, content: `reference ${number}`,
    contentFingerprint: number.toString(16).padStart(64, '0'), contentSize: 11,
  }
}

function harness(total = 25, overrides: Partial<ImportRunSnapshot> = {}) {
  let run = runSnapshot({ totalChapters: total, ...overrides })
  const chapters = Array.from({ length: total }, (_, index) => chapter(index + 1))
  const calls: number[] = []
  const limits: number[] = []
  const execution = { owner: 'test-runner', epoch: 1, expiresAt: Number.MAX_SAFE_INTEGER }
  const receipts = new Map<string, ImportRunEffectReceipt>()
  const receiptKey = (stage: ImportRunStage, batchId: string) => `${stage}:${batchId}`
  const deps: ImportRunOrchestratorDependencies = {
    getRun: vi.fn(async () => run),
    startOrResume: vi.fn(async () => ({ run, execution })),
    renewExecution: vi.fn(async () => execution),
    getEffectReceipt: vi.fn(async (_runId, stage, checkpoint) => receipts.get(receiptKey(stage, checkpoint)) ?? null),
    prepareEffectReceipt: vi.fn(async request => {
      const receipt: ImportRunEffectReceipt = {
        runId: request.runId,
        effectNamespace: run.effectNamespace,
        effectKey: request.effectKey,
        stage: request.stage,
        batchId: request.batchId,
        kind: request.kind,
        payloadHash: 'f'.repeat(64),
        state: 'prepared',
        payload: request.payload,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      }
      receipts.set(receiptKey(request.stage, request.batchId), receipt)
      return receipt
    }),
    commitEffectReceipt: vi.fn(async (_runId: string, stage: ImportRunStage, checkpoint: string) => {
      const receipt = receipts.get(receiptKey(stage, checkpoint))!
      const committed = { ...receipt, state: 'committed' as const, effectReceipt: { committed: true } }
      receipts.set(receiptKey(stage, checkpoint), committed)
      const values = run.completedBatches[stage] ?? []
      if (!values.includes(checkpoint)) {
        run = { ...run, completedBatches: { ...run.completedBatches, [stage]: [...values, checkpoint] } }
      }
      return { receipt: committed, run, cancelApplied: false }
    }),
    replayCommittedEffect: vi.fn(),
    listChapters: vi.fn(async (_runId, after, limit) => {
      limits.push(limit)
      return chapters.filter(item => item.number > after).slice(0, limit)
    }),
    importReference: vi.fn(async item => { calls.push(item.number) }),
    inferGlobal: vi.fn(async (_chapters, _stats, _run, commit) => { await commit({ global: true }) }),
    analyzeStyle: vi.fn(async (_chapters, _run, commit) => { await commit({ writingStyle: 'style' }) }),
    inferBlueprints: vi.fn(async (_chapters, _batchId, _run, commit) => { await commit({ blueprints: true }) }),
    refresh: vi.fn(),
    completeBatch: vi.fn(async (_runId: string, stage: ImportRunStage, batchId: string) => {
      const values = run.completedBatches[stage] ?? []
      run = { ...run, completedBatches: { ...run.completedBatches, [stage]: [...values, batchId] } }
      return { cancelApplied: false, run }
    }),
    advanceStage: vi.fn(async (_runId, _stage, nextStage) => {
      run = { ...run, stage: nextStage }
      return run
    }),
    fail: vi.fn(async (_runId, stage, error) => {
      run = { ...run, stage, status: 'failed', lastError: error }
      return run
    }),
    cancelAtBoundary: vi.fn(async () => {
      run = { ...run, status: 'cancelled', cancelRequested: true }
      return run
    }),
    complete: vi.fn(async () => {
      run = { ...run, stage: 'completed', status: 'completed', resumable: false }
      return run
    }),
  }
  return { deps, calls, limits, receipts, getRun: () => run }
}

const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }

describe('ImportRunOrchestrator', () => {
  it('checkpoints bounded knowledge batches and does not replay a committed batch after failure', async () => {
    const { deps, calls, limits, getRun } = harness()
    let failOnce = true
    deps.importReference = vi.fn(async item => {
      calls.push(item.number)
      if (item.number === 11 && failOnce) {
        failOnce = false
        throw new Error('injected KB failure')
      }
    })
    const orchestrator = new ImportRunOrchestrator(deps)
    const context = { cancelled: false }

    await expect(orchestrator.executeStage('run-1', 'knowledge', 'test-runner', context, callbacks))
      .rejects.toThrow('injected KB failure')
    expect(getRun().completedBatches.knowledge).toEqual(['1-10'])

    await orchestrator.executeStage('run-1', 'knowledge', 'test-runner', context, callbacks)
    expect(calls.filter(number => number <= 10)).toHaveLength(10)
    expect(calls.filter(number => number === 11)).toHaveLength(2)
    expect(limits.every(limit => limit <= IMPORT_CHAPTER_PAGE_SIZE)).toBe(true)
    expect(getRun().stage).toBe('global')
  })

  it('finishes the current bounded batch before applying cancellation at its safe boundary', async () => {
    const { deps, calls, limits, getRun } = harness(5_000)
    const context = { cancelled: false }
    deps.importReference = vi.fn(async item => {
      calls.push(item.number)
      if (item.number === 1) context.cancelled = true
    })

    await expect(new ImportRunOrchestrator(deps).executeStage('run-1', 'knowledge', 'test-runner', context, callbacks))
      .rejects.toThrow(/cancel/i)

    expect(calls).toHaveLength(IMPORT_KNOWLEDGE_BATCH_SIZE)
    expect(limits).toEqual([IMPORT_CHAPTER_PAGE_SIZE])
    expect(getRun()).toMatchObject({ status: 'cancelled', stage: 'knowledge', resumable: true })
    expect(deps.inferGlobal).not.toHaveBeenCalled()
  })

  it('does not repeat a globally checkpointed model stage after a crash before stage advance', async () => {
    const { deps, getRun } = harness(5, {
      stage: 'global',
      completedBatches: { global: ['done'] },
    })

    await new ImportRunOrchestrator(deps).executeStage('run-1', 'global', 'test-runner', { cancelled: false }, callbacks)

    expect(deps.inferGlobal).not.toHaveBeenCalled()
    expect(getRun().stage).toBe('style')
  })

  it.each([
    ['global', 'inferGlobal', 'style'],
    ['style', 'analyzeStyle', 'blueprints'],
    ['blueprints', 'inferBlueprints', 'refresh'],
  ] as const)('replays a prepared %s receipt after a commit crash without recalling the provider', async (
    stage,
    modelDependency,
    nextStage,
  ) => {
    const { deps, receipts, getRun } = harness(2, { stage })
    const durableCommit = deps.commitEffectReceipt
    let crashOnce = true
    deps.commitEffectReceipt = vi.fn(async (runId, receiptStage, checkpoint, lease) => {
      if (crashOnce) {
        crashOnce = false
        throw new Error('crash after prepared receipt')
      }
      return durableCommit(runId, receiptStage, checkpoint, lease)
    })
    const orchestrator = new ImportRunOrchestrator(deps)

    await expect(orchestrator.executeStage(
      'run-1', stage, 'test-runner', { cancelled: false }, callbacks,
    )).rejects.toThrow('crash after prepared receipt')
    expect([...receipts.values()]).toEqual([
      expect.objectContaining({ stage, state: 'prepared' }),
    ])
    expect(deps[modelDependency]).toHaveBeenCalledTimes(1)

    await orchestrator.executeStage(
      'run-1', stage, 'test-runner', { cancelled: false }, callbacks,
    )
    expect(deps[modelDependency]).toHaveBeenCalledTimes(1)
    expect([...receipts.values()]).toEqual([
      expect.objectContaining({ stage, state: 'committed' }),
    ])
    expect(getRun().stage).toBe(nextStage)
  })

  it('replays only the safe refresh projection when its checkpoint CAS crashes', async () => {
    const { deps, getRun } = harness(2, { stage: 'refresh' })
    const durableCheckpoint = deps.completeBatch
    let crashOnce = true
    deps.completeBatch = vi.fn(async (runId, stage, checkpoint, lease) => {
      if (stage === 'refresh' && crashOnce) {
        crashOnce = false
        throw new Error('refresh checkpoint crash')
      }
      return durableCheckpoint(runId, stage, checkpoint, lease)
    })
    const orchestrator = new ImportRunOrchestrator(deps)

    await expect(orchestrator.executeStage(
      'run-1', 'refresh', 'test-runner', { cancelled: false }, callbacks,
    )).rejects.toThrow('refresh checkpoint crash')
    expect(deps.refresh).toHaveBeenCalledTimes(1)

    await orchestrator.executeStage(
      'run-1', 'refresh', 'test-runner', { cancelled: false }, callbacks,
    )
    expect(deps.refresh).toHaveBeenCalledTimes(2)
    expect(getRun()).toMatchObject({ stage: 'completed', status: 'completed' })
  })

  it('checkpoints each blueprint batch and skips the committed prefix on retry', async () => {
    const { deps, getRun } = harness(12, { stage: 'blueprints' })
    const generated: number[][] = []
    let failOnce = true
    deps.inferBlueprints = vi.fn(async (chapters: ImportRunChapterSnapshot[], _batchId, _run, commit) => {
      generated.push(chapters.map(chapter => chapter.number))
      if (chapters[0].number === 6 && failOnce) {
        failOnce = false
        throw new Error('injected blueprint failure')
      }
      await commit({ blueprints: chapters.map(chapter => chapter.number) })
    })
    const orchestrator = new ImportRunOrchestrator(deps)

    await expect(orchestrator.executeStage('run-1', 'blueprints', 'test-runner', { cancelled: false }, callbacks))
      .rejects.toThrow('injected blueprint failure')
    expect(getRun().completedBatches.blueprints).toHaveLength(1)

    await orchestrator.executeStage('run-1', 'blueprints', 'test-runner', { cancelled: false }, callbacks)

    expect(generated.filter(numbers => numbers[0] === 1)).toHaveLength(1)
    expect(generated.filter(numbers => numbers[0] === 6)).toHaveLength(2)
    expect(generated.at(-1)).toEqual([11, 12])
    expect(getRun().stage).toBe('refresh')
  })

  it.each([
    ['style', 'analyzeStyle', 'blueprints'],
    ['refresh', 'refresh', 'completed'],
  ] as const)('skips a checkpointed %s side effect', async (stage, dependency, nextStage) => {
    const { deps, getRun } = harness(2, {
      stage,
      completedBatches: { [stage]: ['done'] },
    })

    await new ImportRunOrchestrator(deps).executeStage('run-1', stage, 'test-runner', { cancelled: false }, callbacks)

    expect(deps[dependency]).not.toHaveBeenCalled()
    expect(getRun().stage).toBe(nextStage)
  })
})
