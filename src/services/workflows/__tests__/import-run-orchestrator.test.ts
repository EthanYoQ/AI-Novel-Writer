import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ImportRunChapterSnapshot,
  ImportRunEffectReceipt,
  ImportRunSnapshot,
  ImportRunStage,
} from '../../../shared/import-run'
import type { FinalizedDraftImportReceipt } from '../../../shared/finalized-draft-import'
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
        schemaVersion: 1,
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

afterEach(() => {
  vi.useRealTimers()
})

describe('ImportRunOrchestrator', () => {
  it('runs author manuscripts through commit, publication, and postprocess without reference analysis', async () => {
    const { deps, getRun } = harness(2, {
      purpose: 'author-manuscript',
      effectNamespace: 'import:author-manuscript:run-1',
      authorityFingerprint: 'c'.repeat(64),
      manifestFingerprint: 'd'.repeat(64),
      stage: 'author-commit',
    })
    const receipt: FinalizedDraftImportReceipt = {
      operationId: 'author-import:run-1',
      payloadHash: 'e'.repeat(64),
      chapterNumbers: [1, 2],
      drafts: [1, 2].map(chapterNumber => ({
        chapterNumber,
        draftId: chapterNumber,
        finalizationId: `final-${chapterNumber}`,
        contentHash: 'f'.repeat(64),
        targetFileName: `Chapter ${chapterNumber}.txt`,
        status: 'finalized' as const,
        publicationStatus: 'pending' as const,
      })),
      idempotent: false,
    }
    deps.commitAuthorManuscript = vi.fn(async (_run, commit) => { await commit({
      operationId: 'author-import:run-1', runId: 'run-1',
      authorityFingerprint: 'c'.repeat(64), manifestFingerprint: 'd'.repeat(64),
    }) })
    deps.getAuthorCommitReceipt = vi.fn(async () => receipt)
    deps.publishAuthorChapter = vi.fn(async () => undefined)
    deps.postprocessAuthorChapter = vi.fn(async () => undefined)
    const orchestrator = new ImportRunOrchestrator(deps)

    await orchestrator.executeStage('run-1', 'author-commit', 'test-runner', { cancelled: false }, callbacks)
    await orchestrator.executeStage('run-1', 'author-publish', 'test-runner', { cancelled: false }, callbacks)
    await orchestrator.executeStage('run-1', 'author-postprocess', 'test-runner', { cancelled: false }, callbacks)
    await orchestrator.executeStage('run-1', 'refresh', 'test-runner', { cancelled: false }, callbacks)

    expect(deps.commitAuthorManuscript).toHaveBeenCalledTimes(1)
    expect(deps.publishAuthorChapter).toHaveBeenCalledTimes(2)
    expect(deps.postprocessAuthorChapter).toHaveBeenCalledTimes(2)
    expect(deps.importReference).not.toHaveBeenCalled()
    expect(deps.inferGlobal).not.toHaveBeenCalled()
    expect(deps.analyzeStyle).not.toHaveBeenCalled()
    expect(deps.inferBlueprints).not.toHaveBeenCalled()
    expect(getRun()).toMatchObject({ stage: 'completed', status: 'completed' })
  })

  it('resumes a partially published author manuscript without publishing a completed chapter twice', async () => {
    const { deps, getRun } = harness(3, {
      purpose: 'author-manuscript',
      effectNamespace: 'import:author-manuscript:run-1',
      authorityFingerprint: 'c'.repeat(64),
      stage: 'author-publish',
    })
    const receipt: FinalizedDraftImportReceipt = {
      operationId: 'author-import:run-1', payloadHash: 'e'.repeat(64), chapterNumbers: [1, 2, 3],
      drafts: [1, 2, 3].map(chapterNumber => ({
        chapterNumber, draftId: chapterNumber, finalizationId: `final-${chapterNumber}`,
        contentHash: 'f'.repeat(64), targetFileName: `Chapter ${chapterNumber}.txt`,
        status: 'finalized' as const, publicationStatus: 'pending' as const,
      })),
      idempotent: false,
    }
    deps.getAuthorCommitReceipt = vi.fn(async () => receipt)
    const published: number[] = []
    let failOnce = true
    deps.publishAuthorChapter = vi.fn(async chapter => {
      published.push(chapter.number)
      if (chapter.number === 2 && failOnce) {
        failOnce = false
        throw new Error('publication unavailable')
      }
    })
    const orchestrator = new ImportRunOrchestrator(deps)

    await expect(orchestrator.executeStage(
      'run-1', 'author-publish', 'test-runner', { cancelled: false }, callbacks,
    )).rejects.toThrow('publication unavailable')
    expect(getRun().completedBatches['author-publish']).toEqual(['chapter:1'])

    await orchestrator.executeStage(
      'run-1', 'author-publish', 'test-runner', { cancelled: false }, callbacks,
    )
    expect(published.filter(number => number === 1)).toHaveLength(1)
    expect(published.filter(number => number === 2)).toHaveLength(2)
    expect(published.filter(number => number === 3)).toHaveLength(1)
    expect(getRun().stage).toBe('author-postprocess')
  })

  it('keeps renewing its lease while one knowledge effect runs longer than the original TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { deps } = harness(1)
    const leaseTtlMs = 15 * 60_000
    const firstExecution = { owner: 'test-runner', epoch: 1, expiresAt: Date.now() + leaseTtlMs }
    let authoritativeExpiresAt = firstExecution.expiresAt
    deps.startOrResume = vi.fn(async () => ({ run: await deps.getRun('run-1') as ImportRunSnapshot, execution: firstExecution }))
    deps.renewExecution = vi.fn(async (_runId, execution) => {
      authoritativeExpiresAt = Date.now() + leaseTtlMs
      return { ...execution, expiresAt: authoritativeExpiresAt }
    })
    let finishImport!: () => void
    deps.importReference = vi.fn(() => new Promise<void>((resolve) => {
      finishImport = resolve
    }))

    const running = new ImportRunOrchestrator(deps).executeStage(
      'run-1', 'knowledge', 'test-runner', { cancelled: false }, callbacks,
    )
    await vi.advanceTimersByTimeAsync(16 * 60_000)

    expect(deps.importReference).toHaveBeenCalledTimes(1)
    expect(deps.renewExecution).toHaveBeenCalled()
    expect(authoritativeExpiresAt).toBeGreaterThan(Date.now())

    finishImport()
    await running
  })

  it('renews before starting a model provider and skips the call after authority is lost', async () => {
    const { deps } = harness(1, { stage: 'global' })
    deps.renewExecution = vi.fn(async () => {
      throw new Error('lease epoch changed')
    })

    await expect(new ImportRunOrchestrator(deps).executeStage(
      'run-1', 'global', 'renderer-a', { cancelled: false }, callbacks,
    )).rejects.toThrow('lease epoch changed')

    expect(deps.inferGlobal).not.toHaveBeenCalled()
    expect(deps.prepareEffectReceipt).not.toHaveBeenCalled()
  })

  it('marks a lost model-stage lease before a late result and never freezes that result', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const { deps } = harness(1, { stage: 'global' })
    const firstExecution = { owner: 'renderer-a', epoch: 1, expiresAt: Date.now() + 90 }
    deps.startOrResume = vi.fn(async () => ({ run: await deps.getRun('run-1') as ImportRunSnapshot, execution: firstExecution }))
    let leaseLost = false
    deps.renewExecution = vi.fn()
      .mockResolvedValueOnce({ ...firstExecution, expiresAt: Date.now() + 90 })
      .mockImplementation(async () => {
        leaseLost = true
        throw new Error('lease epoch changed')
      })
    let finishModel!: () => void
    deps.inferGlobal = vi.fn(async (_chapters, _stats, _run, commit) => {
      await new Promise<void>((resolve) => {
        finishModel = resolve
      })
      await commit({ global: true })
    })

    const running = new ImportRunOrchestrator(deps).executeStage(
      'run-1', 'global', 'renderer-a', { cancelled: false }, callbacks,
    )
    await vi.advanceTimersByTimeAsync(30)

    expect(leaseLost).toBe(true)
    finishModel()
    await expect(running).rejects.toThrow('lease epoch changed')
    expect(deps.prepareEffectReceipt).not.toHaveBeenCalled()
    expect(deps.commitEffectReceipt).not.toHaveBeenCalled()
  })

  it('serializes a model commit behind an in-flight heartbeat renewal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000)
    const { deps } = harness(1, { stage: 'global' })
    const leaseTtlMs = 90
    const firstExecution = { owner: 'renderer-a', epoch: 1, expiresAt: Date.now() + leaseTtlMs }
    let authoritativeExecution = firstExecution
    let releaseHeartbeat!: () => void
    let renewalCount = 0
    deps.startOrResume = vi.fn(async () => ({ run: await deps.getRun('run-1') as ImportRunSnapshot, execution: firstExecution }))
    deps.renewExecution = vi.fn(async (_runId, supplied) => {
      if (supplied.expiresAt !== authoritativeExecution.expiresAt) throw new Error('stale lease renewal')
      authoritativeExecution = { ...supplied, expiresAt: Date.now() + leaseTtlMs }
      renewalCount += 1
      if (renewalCount === 2) {
        await new Promise<void>((resolve) => {
          releaseHeartbeat = resolve
        })
      }
      return authoritativeExecution
    })
    let finishModel!: () => void
    deps.inferGlobal = vi.fn(async (_chapters, _stats, _run, commit) => {
      await new Promise<void>((resolve) => {
        finishModel = resolve
      })
      await commit({ global: true })
    })

    const running = new ImportRunOrchestrator(deps).executeStage(
      'run-1', 'global', 'renderer-a', { cancelled: false }, callbacks,
    )
    await vi.advanceTimersByTimeAsync(30)
    finishModel()
    await Promise.resolve()
    releaseHeartbeat()

    await expect(running).resolves.toBeUndefined()
    expect(deps.prepareEffectReceipt).toHaveBeenCalledTimes(1)
    expect(deps.commitEffectReceipt).toHaveBeenCalledTimes(1)
  })

  it('records a provider failure with the lease most recently returned by heartbeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(4_000)
    const { deps } = harness(1, { stage: 'global' })
    const leaseTtlMs = 90
    const firstExecution = { owner: 'renderer-a', epoch: 1, expiresAt: Date.now() + leaseTtlMs }
    let authoritativeExecution = firstExecution
    deps.startOrResume = vi.fn(async () => ({ run: await deps.getRun('run-1') as ImportRunSnapshot, execution: firstExecution }))
    deps.renewExecution = vi.fn(async (_runId, supplied) => {
      if (supplied.expiresAt !== authoritativeExecution.expiresAt) throw new Error('stale lease renewal')
      authoritativeExecution = { ...supplied, expiresAt: Date.now() + leaseTtlMs }
      return authoritativeExecution
    })
    let failModel!: () => void
    deps.inferGlobal = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        failModel = resolve
      })
      throw new Error('provider unavailable')
    })
    const originalFail = deps.fail
    deps.fail = vi.fn(async (runId, stage, error, supplied) => {
      if (supplied.expiresAt !== authoritativeExecution.expiresAt) throw new Error('stale failure lease')
      return originalFail(runId, stage, error, supplied)
    })

    const running = new ImportRunOrchestrator(deps).executeStage(
      'run-1', 'global', 'renderer-a', { cancelled: false }, callbacks,
    )
    await vi.advanceTimersByTimeAsync(30)
    failModel()

    await expect(running).rejects.toThrow('provider unavailable')
    expect(deps.fail).toHaveBeenCalledWith(
      'run-1', 'global', 'provider unavailable', authoritativeExecution,
    )
  })

  it('keeps the refresh projection leased while its project reads are delayed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const { deps } = harness(1, { stage: 'refresh' })
    const leaseTtlMs = 90
    const firstExecution = { owner: 'renderer-a', epoch: 1, expiresAt: Date.now() + leaseTtlMs }
    let authoritativeExpiresAt = firstExecution.expiresAt
    deps.startOrResume = vi.fn(async () => ({ run: await deps.getRun('run-1') as ImportRunSnapshot, execution: firstExecution }))
    deps.renewExecution = vi.fn(async (_runId, supplied) => {
      authoritativeExpiresAt = Date.now() + leaseTtlMs
      return { ...supplied, expiresAt: authoritativeExpiresAt }
    })
    let finishRefresh!: () => void
    deps.refresh = vi.fn(() => new Promise<void>((resolve) => {
      finishRefresh = resolve
    }))

    const running = new ImportRunOrchestrator(deps).executeStage(
      'run-1', 'refresh', 'renderer-a', { cancelled: false }, callbacks,
    )
    await vi.advanceTimersByTimeAsync(leaseTtlMs * 3)

    expect(authoritativeExpiresAt).toBeGreaterThan(Date.now())
    finishRefresh()
    await running
  })

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
