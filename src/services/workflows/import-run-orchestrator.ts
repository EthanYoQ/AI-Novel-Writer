import type {
  ImportRunChapterSnapshot,
  ImportRunEffectCommitResult,
  ImportRunEffectKind,
  ImportRunEffectReceipt,
  ImportRunExecutionLease,
  ImportRunSnapshot,
  ImportRunStartResult,
  ImportRunStage,
} from '../../shared/import-run'
import type { StepCallbacks } from '../../stores/workflow-store'

export const IMPORT_CHAPTER_PAGE_SIZE = 100
export const IMPORT_KNOWLEDGE_BATCH_SIZE = 10
export const IMPORT_BLUEPRINT_BATCH_SIZE = 5

export interface ImportRunExecutionContext {
  cancelled: boolean
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
    idempotencyKey: string,
    run: ImportRunSnapshot,
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
    stage: ImportRunStage,
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

function batchId(chapters: ImportRunChapterSnapshot[]): string {
  const first = chapters[0]!
  const last = chapters.at(-1)!
  return `${first.number}-${last.number}-${chapters.map(chapter => chapter.contentFingerprint.slice(0, 8)).join('.')}`
}

function splitContiguousBatches(chapters: ImportRunChapterSnapshot[]): ImportRunChapterSnapshot[][] {
  const batches: ImportRunChapterSnapshot[][] = []
  let current: ImportRunChapterSnapshot[] = []
  for (const chapter of chapters) {
    const previous = current.at(-1)
    if (current.length >= IMPORT_BLUEPRINT_BATCH_SIZE || (previous && chapter.number !== previous.number + 1)) {
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
    let execution = started.execution
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
      if (context.cancelled) {
        execution = await this.dependencies.renewExecution(runId, execution)
        await this.dependencies.cancelAtBoundary(runId, execution)
      } else {
        execution = await this.dependencies.renewExecution(runId, execution)
        await this.dependencies.fail(runId, requestedStage, error instanceof Error ? error.message : String(error), execution)
      }
      throw error
    }
  }

  private async executeKnowledge(
    initialRun: ImportRunSnapshot,
    initialExecution: ImportRunExecutionLease,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    let run = initialRun
    let execution = initialExecution
    let after = 0
    let visited = 0
    let page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (let offset = 0; offset < page.length; offset += IMPORT_KNOWLEDGE_BATCH_SIZE) {
        const batch = page.slice(offset, offset + IMPORT_KNOWLEDGE_BATCH_SIZE)
        const checkpoint = `${batch[0].number}-${batch.at(-1)!.number}`
        if (!run.completedBatches.knowledge?.includes(checkpoint)) {
          if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
          for (const chapter of batch) {
            execution = await this.dependencies.renewExecution(run.id, execution)
            await this.dependencies.importReference(
              chapter,
              `${run.purpose}:${run.sourceFingerprint}:${chapter.number}:${chapter.contentFingerprint}`,
              run,
            )
          }
          execution = await this.dependencies.renewExecution(run.id, execution)
          const completed = await this.dependencies.completeBatch(run.id, 'knowledge', checkpoint, execution)
          run = completed.run
        }
        visited += batch.length
        callbacks.setProgress(Math.min(99, Math.round((visited / run.totalChapters) * 100)))
        if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution = await this.dependencies.renewExecution(run.id, execution)
    await this.dependencies.advanceStage(run.id, 'knowledge', 'global', execution)
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
    execution: ImportRunExecutionLease,
    stage: ImportRunStage,
    batchId: string,
    effectKey: string,
    kind: ImportRunEffectKind,
    generate: (commit: ImportRunGeneratedEffectCommitter<unknown>) => Promise<void>,
  ): Promise<{ run: ImportRunSnapshot; execution: ImportRunExecutionLease }> {
    const existing = await this.dependencies.getEffectReceipt(run.id, stage, batchId)
    if (existing) {
      execution = await this.dependencies.renewExecution(run.id, execution)
      const committed = await this.dependencies.commitEffectReceipt(run.id, stage, batchId, execution)
      await this.dependencies.replayCommittedEffect(committed.receipt, committed.run)
      return { run: committed.run, execution }
    }
    await generate(async payload => {
      execution = await this.dependencies.renewExecution(run.id, execution)
      await this.dependencies.prepareEffectReceipt({
        runId: run.id, stage, batchId, effectKey, kind, payload,
      }, execution)
      execution = await this.dependencies.renewExecution(run.id, execution)
      const committed = await this.dependencies.commitEffectReceipt(run.id, stage, batchId, execution)
      run = committed.run
      return committed.receipt.effectReceipt
    })
    const committedReceipt = await this.dependencies.getEffectReceipt(run.id, stage, batchId)
    if (!committedReceipt || committedReceipt.state !== 'committed') {
      throw new Error('Generated import effect was not durably committed.')
    }
    return { run, execution }
  }

  private async executeGlobal(run: ImportRunSnapshot, initialExecution: ImportRunExecutionLease, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    let execution = initialExecution
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
      execution = committed.execution
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution = await this.dependencies.renewExecution(run.id, execution)
    await this.dependencies.advanceStage(run.id, 'global', 'style', execution)
  }

  private async executeStyle(run: ImportRunSnapshot, initialExecution: ImportRunExecutionLease, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    let execution = initialExecution
    if (!run.completedBatches.style?.includes('done')) {
      if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      const sample = await this.representativeChapters(run.id)
      const committed = await this.executeDurableEffect(
        run, execution, 'style', 'done', 'writing-style', 'project-writing-style',
        commit => this.dependencies.analyzeStyle(sample, run, commit),
      )
      run = committed.run
      execution = committed.execution
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution = await this.dependencies.renewExecution(run.id, execution)
    await this.dependencies.advanceStage(run.id, 'style', 'blueprints', execution)
  }

  private async executeBlueprints(run: ImportRunSnapshot, initialExecution: ImportRunExecutionLease, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    let execution = initialExecution
    let after = 0
    let visited = 0
    let page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (const batch of splitContiguousBatches(page)) {
        const checkpoint = batchId(batch)
        if (!run.completedBatches.blueprints?.includes(checkpoint)) {
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
          execution = committed.execution
        }
        visited += batch.length
        callbacks.setProgress(Math.min(99, Math.round((visited / run.totalChapters) * 100)))
        if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution = await this.dependencies.renewExecution(run.id, execution)
    await this.dependencies.advanceStage(run.id, 'blueprints', 'refresh', execution)
  }

  private async executeRefresh(run: ImportRunSnapshot, initialExecution: ImportRunExecutionLease, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    let execution = initialExecution
    if (!run.completedBatches.refresh?.includes('done')) {
      if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
      await this.dependencies.refresh(run)
      execution = await this.dependencies.renewExecution(run.id, execution)
      await this.dependencies.completeBatch(run.id, 'refresh', 'done', execution)
    }
    callbacks.setProgress(100)
    if (context.cancelled) throw new Error('Import cancelled at a safe boundary.')
    execution = await this.dependencies.renewExecution(run.id, execution)
    await this.dependencies.complete(run.id, execution)
  }
}
