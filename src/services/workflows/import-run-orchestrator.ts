import type {
  ImportRunChapterSnapshot,
  ImportRunDirectCheckpointStage,
  ImportRunEffectCommitResult,
  ImportRunEffectKind,
  ImportRunEffectReceipt,
  ImportRunExecutionAuthority,
  ImportRunExecutionLease,
  ImportRunSnapshot,
  ImportRunStartResult,
  ImportRunStage,
} from '../../shared/import-run'
import {
  createImportRunChapterBatchCheckpointId,
  IMPORT_RUN_BLUEPRINT_BATCH_SIZE,
  IMPORT_RUN_KNOWLEDGE_BATCH_SIZE,
} from '../../shared/import-run'
import type { StepCallbacks } from '../../stores/workflow-store'

export const IMPORT_CHAPTER_PAGE_SIZE = 100
export const IMPORT_KNOWLEDGE_BATCH_SIZE = IMPORT_RUN_KNOWLEDGE_BATCH_SIZE
export const IMPORT_BLUEPRINT_BATCH_SIZE = IMPORT_RUN_BLUEPRINT_BATCH_SIZE
const IMPORT_RUN_HEARTBEAT_MAX_INTERVAL_MS = 60_000

export interface ImportRunExecutionContext {
  cancelled: boolean
}

interface ImportRunExecutionState {
  current: ImportRunExecutionLease
  lost?: unknown
}

export type ImportRunGeneratedEffectCommitter<T> = (payload: unknown) => Promise<T>

export interface ImportRunOrchestratorDependencies {
  getRun: (runId: string) => Promise<ImportRunSnapshot | null>
  startOrResume: (runId: string, owner: string) => Promise<ImportRunStartResult>
  renewExecution: (runId: string, execution: ImportRunExecutionLease) => Promise<ImportRunExecutionLease>
  getEffectReceipt: (
    runId: string,
    stage: ImportRunStage,
    batchId: string,
  ) => Promise<ImportRunEffectReceipt | null>
  prepareEffectReceipt: (
    request: {
      runId: string
      stage: ImportRunStage
      batchId: string
      effectKey: string
      kind: ImportRunEffectKind
      payload: unknown
    },
    execution: ImportRunExecutionLease,
  ) => Promise<ImportRunEffectReceipt>
  commitEffectReceipt: (
    runId: string,
    stage: ImportRunStage,
    batchId: string,
    execution: ImportRunExecutionLease,
  ) => Promise<ImportRunEffectCommitResult>
  replayCommittedEffect: (receipt: ImportRunEffectReceipt, run: ImportRunSnapshot) => Promise<void>
  listChapters: (
    runId: string,
    afterChapterNumber: number,
    limit: number,
  ) => Promise<ImportRunChapterSnapshot[]>
  importReference: (
    chapter: ImportRunChapterSnapshot,
    run: ImportRunSnapshot,
    executionAuthority: ImportRunExecutionAuthority,
  ) => Promise<void>
  inferGlobal: (
    chapters: ImportRunChapterSnapshot[],
    stats: { totalChapters: number; totalWords: number },
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  analyzeStyle: (
    chapters: ImportRunChapterSnapshot[],
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  inferBlueprints: (
    chapters: ImportRunChapterSnapshot[],
    batchId: string,
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  refresh: (run: ImportRunSnapshot) => Promise<void>
  completeBatch: (
    runId: string,
    stage: ImportRunDirectCheckpointStage,
    batchId: string,
    execution: ImportRunExecutionLease,
  ) => Promise<{ cancelApplied: boolean; run: ImportRunSnapshot }>
  advanceStage: (
    runId: string,
    completedStage: ImportRunStage,
    nextStage: ImportRunStage,
    execution: ImportRunExecutionLease,
  ) => Promise<ImportRunSnapshot>
  fail: (runId: string, stage: ImportRunStage, error: string, execution: ImportRunExecutionLease) => Promise<ImportRunSnapshot>
  cancelAtBoundary: (runId: string, execution: ImportRunExecutionLease) => Promise<ImportRunSnapshot>
  complete: (runId: string, execution: ImportRunExecutionLease) => Promise<ImportRunSnapshot>
}

const STAGES: ImportRunStage[] = ['knowledge', 'global', 'style', 'blueprints', 'refresh', 'completed']

function stageIndex(stage: ImportRunStage): number {
  return STAGES.indexOf(stage)
}

function splitContiguousBatches(
  chapters: ImportRunChapterSnapshot[],
  maxBatchSize: number,
): ImportRunChapterSnapshot[][] {
  const batches: ImportRunChapterSnapshot[][] = []
  let current: ImportRunChapterSnapshot[] = []
  for (const chapter of chapters) {
    const previous = current.at(-1)
    if (current.length >= maxBatchSize || (previous && chapter.number !== previous.number + 1)) {
      batches.push(current)
      current = []
    }
    current.push(chapter)
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export class ImportRunOrchestrator {
  constructor(private readonly dependencies: ImportRunOrchestratorDependencies) {}

  private async withLeaseHeartbeat<T>(
    runId: string,
    execution: ImportRunExecutionState,
    operation: (lease: {
      authority: ImportRunExecutionAuthority
      renew: () => Promise<ImportRunExecutionLease>
    }) => Promise<T>,
  ): Promise<{ value: T; execution: ImportRunExecutionLease }> {
    const initialAuthority = {
      owner: execution.current.owner,
      epoch: execution.current.epoch,
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let heartbeatError: unknown
    let renewalTail = Promise.resolve()

    const renew = (): Promise<ImportRunExecutionLease> => {
      const renewal = renewalTail.then(async () => {
        if (heartbeatError) throw heartbeatError
        try {
          const renewed = await this.dependencies.renewExecution(runId, execution.current)
          if (renewed.owner !== initialAuthority.owner || renewed.epoch !== initialAuthority.epoch) {
            throw new Error('Import execution authority changed during lease renewal.')
          }
          execution.current = renewed
          return execution.current
        } catch (error) {
          heartbeatError = error
          execution.lost = error
          throw error
        }
      })
      renewalTail = renewal.then(() => undefined, () => undefined)
      return renewal
    }

    const schedule = () => {
      if (stopped || heartbeatError) return
      const remaining = Math.max(1, execution.current.expiresAt - Date.now())
      const delay = Math.max(1, Math.min(
        IMPORT_RUN_HEARTBEAT_MAX_INTERVAL_MS,
        Math.floor(remaining / 3),
      ))
      timer = setTimeout(() => {
        if (stopped || heartbeatError) return
        void renew()
          .then(() => {
            schedule()
          })
          .catch(() => undefined)
      }, delay)
    }

    await renew()
    schedule()
    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      outcome = {
        ok: true,
        value: await operation({
          authority: initialAuthority,
          renew,
        }),
      }
    } catch (error) {
      outcome = { ok: false, error }
    } finally {
      stopped = true
      if (timer) clearTimeout(timer)
      await renewalTail
    }
    if (heartbeatError) throw heartbeatError
    if (!outcome.ok) throw outcome.error
    return { value: outcome.value, execution: execution.current }
  }

  async executeStage(
    runId: string,
    requestedStage: Exclude<ImportRunStage, 'completed'>,
    executionOwner: string,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    const existing = await this.dependencies.getRun(runId)
    if (!existing) throw new Error('Import run does not exist.')
    if (existing.status === 'completed' || stageIndex(existing.stage) > stageIndex(requestedStage)) return
    const started = await this.dependencies.startOrResume(runId, executionOwner)
    const run = started.run
    const execution: ImportRunExecutionState = { current: started.execution }
    if (run.status === 'completed' || stageIndex(run.stage) > stageIndex(requestedStage)) return
    if (run.stage !== requestedStage) throw new Error(`Import run is waiting at ${run.stage}, not ${requestedStage}.`)

    try {
      switch (requestedStage) {
        case 'knowledge':
          await this.executeKnowledge(run, execution, context, callbacks)
          return
        case 'global':
          await this.executeGlobal(run, execution, context, callbacks)
          return
        case 'style':
          await this.executeStyle(run, execution, context, callbacks)
          return
        case 'blueprints':
          await this.executeBlueprints(run, execution, context, callbacks)
          return
        case 'refresh':
          await this.executeRefresh(run, execution, context, callbacks)
      }
    } catch (error) {
      if (execution.lost) throw error
      if (context.cancelled) {
        try {
          execution.current = await this.dependencies.renewExecution(runId, execution.current)
          await this.dependencies.cancelAtBoundary(runId, execution.current)
        } catch (leaseError) {
          execution.lost = leaseError
          throw error
        }
      } else {
        try {
          execution.current = await this.dependencies.renewExecution(runId, execution.current)
          await this.dependencies.fail(
            runId,
            requestedStage,
            error instanceof Error ? error.message : String(error),
            execution.current,
          )
        } catch (leaseError) {
          execution.lost = leaseError
          throw error
        }
      }
      throw error
    }
  }

  private async executeKnowledge(
    initialRun: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    let run = initialRun
    let after = 0
    let visited = 0
    let page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (const batch of splitContiguousBatches(page, IMPORT_KNOWLEDGE_BATCH_SIZE)) {
        const checkpoint = createImportRunChapterBatchCheckpointId(batch)
        if (!run.completedBatches.knowledge?.includes(checkpoint)) {
          if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
          for (const chapter of batch) {
            execution.current = await this.dependencies.renewExecution(run.id, execution.current)
            await this.withLeaseHeartbeat(
              run.id,
              execution,
              lease => this.dependencies.importReference(
                chapter,
                run,
                lease.authority,
              ),
            )
          }
          execution.current = await this.dependencies.renewExecution(run.id, execution.current)
          const completed = await this.dependencies.completeBatch(
            run.id, 'knowledge', checkpoint, execution.current,
          )
          run = completed.run
        }
        visited += batch.length
        callbacks.setProgress(Math.min(99, Math.round((visited / run.totalChapters) * 100)))
        if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, 'knowledge', 'global', execution.current)
  }

  private async representativeChapters(runId: string): Promise<ImportRunChapterSnapshot[]> {
    const first: ImportRunChapterSnapshot[] = []
    const last: ImportRunChapterSnapshot[] = []
    let after = 0
    let page = await this.dependencies.listChapters(runId, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (const chapter of page) {
        if (first.length < 3) first.push(chapter)
        last.push(chapter)
        if (last.length > 2) last.shift()
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(runId, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    const selected = new Map<number, ImportRunChapterSnapshot>()
    for (const chapter of [...first, ...last]) selected.set(chapter.number, chapter)
    return [...selected.values()].sort((a, b) => a.number - b.number)
  }

  private async executeDurableEffect(
    run: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    stage: ImportRunStage,
    batchId: string,
    effectKey: string,
    kind: ImportRunEffectKind,
    generate: (commit: ImportRunGeneratedEffectCommitter<unknown>) => Promise<void>,
  ): Promise<{ run: ImportRunSnapshot; execution: ImportRunExecutionLease }> {
    const existing = await this.dependencies.getEffectReceipt(run.id, stage, batchId)
    if (existing) {
      execution.current = await this.dependencies.renewExecution(run.id, execution.current)
      const committed = await this.dependencies.commitEffectReceipt(
        run.id, stage, batchId, execution.current,
      )
      await this.withLeaseHeartbeat(
        run.id,
        execution,
        () => this.dependencies.replayCommittedEffect(committed.receipt, committed.run),
      )
      return { run: committed.run, execution: execution.current }
    }
    const keptAlive = await this.withLeaseHeartbeat(run.id, execution, lease => generate(async payload => {
      execution.current = await lease.renew()
      await this.dependencies.prepareEffectReceipt({
        runId: run.id, stage, batchId, effectKey, kind, payload,
      }, execution.current)
      execution.current = await lease.renew()
      const committed = await this.dependencies.commitEffectReceipt(
        run.id, stage, batchId, execution.current,
      )
      run = committed.run
      return committed.receipt.effectReceipt
    }))
    execution.current = keptAlive.execution
    const committedReceipt = await this.dependencies.getEffectReceipt(run.id, stage, batchId)
    if (!committedReceipt || committedReceipt.state !== 'committed') {
      throw new Error('Generated import effect was not durably committed.')
    }
    return { run, execution: execution.current }
  }

  private async replayCheckpointedEffect(
    run: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    stage: ImportRunStage,
    batchId: string,
  ): Promise<{ run: ImportRunSnapshot; execution: ImportRunExecutionLease }> {
    const existing = await this.dependencies.getEffectReceipt(run.id, stage, batchId)
    if (!existing) {
      throw new Error('A completed import checkpoint is missing its durable effect receipt.')
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    const committed = await this.dependencies.commitEffectReceipt(
      run.id, stage, batchId, execution.current,
    )
    await this.withLeaseHeartbeat(
      run.id,
      execution,
      () => this.dependencies.replayCommittedEffect(committed.receipt, committed.run),
    )
    return { run: committed.run, execution: execution.current }
  }

  private async executeGlobal(run: ImportRunSnapshot, execution: ImportRunExecutionState, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    if (!run.completedBatches.global?.includes('done')) {
      if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      const sample = await this.representativeChapters(run.id)
      const committed = await this.executeDurableEffect(
        run, execution, 'global', 'done', 'global-facts', 'project-global-facts',
        commit => this.dependencies.inferGlobal(sample, {
          totalChapters: run.manifestChapterCount,
          totalWords: run.manifestWordCount,
        }, run, commit),
      )
      run = committed.run
      execution.current = committed.execution
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, 'global', 'style', execution.current)
  }

  private async executeStyle(run: ImportRunSnapshot, execution: ImportRunExecutionState, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    if (!run.completedBatches.style?.includes('done')) {
      if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      const sample = await this.representativeChapters(run.id)
      const committed = await this.executeDurableEffect(
        run, execution, 'style', 'done', 'writing-style', 'project-writing-style',
        commit => this.dependencies.analyzeStyle(sample, run, commit),
      )
      run = committed.run
      execution.current = committed.execution
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, 'style', 'blueprints', execution.current)
  }

  private async executeBlueprints(run: ImportRunSnapshot, execution: ImportRunExecutionState, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    let after = 0
    let visited = 0
    let page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (const batch of splitContiguousBatches(page, IMPORT_BLUEPRINT_BATCH_SIZE)) {
        const checkpoint = createImportRunChapterBatchCheckpointId(batch)
        if (run.completedBatches.blueprints?.includes(checkpoint)) {
          const replayed = await this.replayCheckpointedEffect(
            run,
            execution,
            'blueprints',
            checkpoint,
          )
          run = replayed.run
          execution.current = replayed.execution
        } else {
          if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
          const committed = await this.executeDurableEffect(
            run,
            execution,
            'blueprints',
            checkpoint,
            `blueprints:${checkpoint}`,
            'chapter-blueprint-range',
            commit => this.dependencies.inferBlueprints(batch, checkpoint, run, commit),
          )
          run = committed.run
          execution.current = committed.execution
        }
        visited += batch.length
        callbacks.setProgress(Math.min(99, Math.round((visited / run.totalChapters) * 100)))
        if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.advanceStage(run.id, 'blueprints', 'refresh', execution.current)
  }

  private async executeRefresh(run: ImportRunSnapshot, execution: ImportRunExecutionState, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    if (!run.completedBatches.refresh?.includes('done')) {
      if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      await this.withLeaseHeartbeat(run.id, execution, () => this.dependencies.refresh(run))
      execution.current = await this.dependencies.renewExecution(run.id, execution.current)
      await this.dependencies.completeBatch(run.id, 'refresh', 'done', execution.current)
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    await this.dependencies.complete(run.id, execution.current)
  }
}
