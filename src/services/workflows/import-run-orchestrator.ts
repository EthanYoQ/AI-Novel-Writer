import type {
  ImportRunChapterSnapshot,
  ImportRunDirectCheckpointStage,
  ImportRunEffectCommitResult,
  ImportRunEffectKind,
  ImportRunEffectReceipt,
  ImportRunExecutionAuthority,
  ImportRunExecutionLease,
  ImportRunLocale,
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
import type { FinalizedDraftImportDraftReceipt, FinalizedDraftImportReceipt } from '../../shared/finalized-draft-import'
import { appErrorMessage } from '../../i18n/app-errors'
import { localize } from '../../i18n/core'

export const IMPORT_CHAPTER_PAGE_SIZE = 100
export const IMPORT_KNOWLEDGE_BATCH_SIZE = IMPORT_RUN_KNOWLEDGE_BATCH_SIZE
export const IMPORT_BLUEPRINT_BATCH_SIZE = IMPORT_RUN_BLUEPRINT_BATCH_SIZE
const IMPORT_RUN_HEARTBEAT_MAX_INTERVAL_MS = 60_000

export interface ImportRunExecutionContext {
  cancelled: boolean
  cancelRequested?: boolean
  cancellationRequest?: Promise<void>
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
  commitAuthorManuscript?: (
    run: ImportRunSnapshot,
    commit: ImportRunGeneratedEffectCommitter<unknown>,
  ) => Promise<void>
  getAuthorCommitReceipt?: (runId: string) => Promise<FinalizedDraftImportReceipt | null>
  publishAuthorChapter?: (
    chapter: ImportRunChapterSnapshot,
    draft: FinalizedDraftImportDraftReceipt,
    run: ImportRunSnapshot,
  ) => Promise<void>
  postprocessAuthorChapter?: (
    chapter: ImportRunChapterSnapshot,
    draft: FinalizedDraftImportDraftReceipt,
    run: ImportRunSnapshot,
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

const REFERENCE_STAGES: ImportRunStage[] = ['knowledge', 'global', 'style', 'blueprints', 'refresh', 'completed']
const AUTHOR_STAGES: ImportRunStage[] = [
  'author-commit', 'author-publish', 'author-postprocess', 'refresh', 'completed',
]

function stagesFor(run: Pick<ImportRunSnapshot, 'purpose'>): ImportRunStage[] {
  return run.purpose === 'author-manuscript' ? AUTHOR_STAGES : REFERENCE_STAGES
}

function stageIndex(run: Pick<ImportRunSnapshot, 'purpose'>, stage: ImportRunStage): number {
  return stagesFor(run).indexOf(stage)
}

function requiredAuthorDependency<T>(value: T | undefined, name: string): T {
  // i18n-exempt: 生产依赖（import-workflow.ts 的 productionDependencies）总会提供作者原稿的四个依赖，缺了是接线错误
  if (!value) throw new Error(`Author-manuscript import dependency is unavailable: ${name}.`)
  return value
}

function cancellationRequested(context: ImportRunExecutionContext): boolean {
  return context.cancelled || context.cancelRequested === true
}

/** 取消在安全边界生效：这句进运行卡片的步骤详情与日志，按导入运行的语言写。 */
function stopIfCancelled(context: ImportRunExecutionContext, locale: ImportRunLocale): void {
  if (cancellationRequested(context)) {
    throw new Error(localize(locale, '导入已取消，停在了已保存的进度处。', 'Import cancelled at a safe boundary.'))
  }
}

/** 收据或检查点与持久化记录对不上：作者照做不了什么，只能从导入对话框继续或重新导入，说明里留下是哪一项。 */
export function importRecordError(locale: ImportRunLocale, zhCNText: string, enUSText: string): Error {
  return new Error(localize(
    locale,
    `${zhCNText}请在导入对话框里继续这次导入；如果仍然出现，请重新导入并把这段说明反馈给我们。`,
    `${enUSText} Resume the import from the import dialog; if this keeps happening, start the import again and send us this message.`,
  ))
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
    run: Pick<ImportRunSnapshot, 'id' | 'locale'>,
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
          const renewed = await this.dependencies.renewExecution(run.id, execution.current)
          if (renewed.owner !== initialAuthority.owner || renewed.epoch !== initialAuthority.epoch) {
            // 续租拿回的执行身份变了，与主进程判定的执行代号过期是同一件事，用同一句说明。
            throw new Error(appErrorMessage(run.locale, 'IMPORT_RUN_EXECUTION_STALE'))
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
    // i18n-exempt: 导入运行只在 parsing 阶段被删（import-run-repository 的两处 DELETE），工作流从解析之后的阶段起步，执行中没有删除路径
    if (!existing) throw new Error('Import run does not exist.')
    const requestedIndex = stageIndex(existing, requestedStage)
    if (requestedIndex < 0) {
      // i18n-exempt: createImportWorkflow 按运行的 purpose 排步骤，阶段不属于这个 purpose 只会是接线错误
      throw new Error(`Import stage ${requestedStage} does not belong to ${existing.purpose}.`)
    }
    if (existing.status === 'completed' || stageIndex(existing, existing.stage) > requestedIndex) return
    const started = await this.dependencies.startOrResume(runId, executionOwner)
    const run = started.run
    const execution: ImportRunExecutionState = { current: started.execution }
    if (run.status === 'completed' || stageIndex(run, run.stage) > stageIndex(run, requestedStage)) return
    // i18n-exempt: 步骤按阶段顺序执行，前一步不推进阶段就会抛错停下工作流，阶段只进不退，到不了这里
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
        case 'author-commit':
          await this.executeAuthorCommit(run, execution, context, callbacks)
          return
        case 'author-publish':
          await this.executeAuthorProjection(
            run, execution, context, callbacks, 'author-publish', 'author-postprocess',
          )
          return
        case 'author-postprocess':
          await this.executeAuthorProjection(
            run, execution, context, callbacks, 'author-postprocess', 'refresh',
          )
          return
        case 'refresh':
          await this.executeRefresh(run, execution, context, callbacks)
      }
    } catch (error) {
      if (execution.lost) throw error
      if (cancellationRequested(context)) {
        await context.cancellationRequest?.catch(() => undefined)
        try {
          const durableRun = await this.dependencies.getRun(runId)
          if (durableRun?.status !== 'cancelled') {
            execution.current = await this.dependencies.renewExecution(runId, execution.current)
            await this.dependencies.cancelAtBoundary(runId, execution.current)
          }
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
          stopIfCancelled(context, run.locale)
          for (const chapter of batch) {
            execution.current = await this.dependencies.renewExecution(run.id, execution.current)
            await this.withLeaseHeartbeat(
              run,
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
        stopIfCancelled(context, run.locale)
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    stopIfCancelled(context, run.locale)
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
        run,
        execution,
        () => this.dependencies.replayCommittedEffect(committed.receipt, committed.run),
      )
      return { run: committed.run, execution: execution.current }
    }
    const keptAlive = await this.withLeaseHeartbeat(run, execution, lease => generate(async payload => {
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
      throw importRecordError(
        run.locale,
        '这一步生成的结果没有保存下来。',
        'The result generated in this step was not saved.',
      )
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
      throw importRecordError(
        run.locale,
        '已完成的导入批次缺少保存记录，无法按原结果恢复。',
        'A completed import batch is missing its saved record, so its result cannot be restored.',
      )
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    const committed = await this.dependencies.commitEffectReceipt(
      run.id, stage, batchId, execution.current,
    )
    await this.withLeaseHeartbeat(
      run,
      execution,
      () => this.dependencies.replayCommittedEffect(committed.receipt, committed.run),
    )
    return { run: committed.run, execution: execution.current }
  }

  private async executeGlobal(run: ImportRunSnapshot, execution: ImportRunExecutionState, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    if (!run.completedBatches.global?.includes('done')) {
      stopIfCancelled(context, run.locale)
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
    stopIfCancelled(context, run.locale)
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    stopIfCancelled(context, run.locale)
    await this.dependencies.advanceStage(run.id, 'global', 'style', execution.current)
  }

  private async executeStyle(run: ImportRunSnapshot, execution: ImportRunExecutionState, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    if (!run.completedBatches.style?.includes('done')) {
      stopIfCancelled(context, run.locale)
      const sample = await this.representativeChapters(run.id)
      const committed = await this.executeDurableEffect(
        run, execution, 'style', 'done', 'writing-style', 'project-writing-style',
        commit => this.dependencies.analyzeStyle(sample, run, commit),
      )
      run = committed.run
      execution.current = committed.execution
    }
    callbacks.setProgress(100)
    stopIfCancelled(context, run.locale)
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    stopIfCancelled(context, run.locale)
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
          stopIfCancelled(context, run.locale)
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
        stopIfCancelled(context, run.locale)
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    stopIfCancelled(context, run.locale)
    await this.dependencies.advanceStage(run.id, 'blueprints', 'refresh', execution.current)
  }

  private async executeAuthorCommit(
    initialRun: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
  ): Promise<void> {
    let run = initialRun
    if (!run.completedBatches['author-commit']?.includes('done')) {
      stopIfCancelled(context, run.locale)
      const commitAuthorManuscript = requiredAuthorDependency(
        this.dependencies.commitAuthorManuscript,
        'commitAuthorManuscript',
      )
      const committed = await this.executeDurableEffect(
        run,
        execution,
        'author-commit',
        'done',
        'author-finalized-batch',
        'author-finalized-batch',
        commit => commitAuthorManuscript(run, commit),
      )
      run = committed.run
      execution.current = committed.execution
    }
    callbacks.setProgress(100)
    stopIfCancelled(context, run.locale)
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    stopIfCancelled(context, run.locale)
    await this.dependencies.advanceStage(run.id, 'author-commit', 'author-publish', execution.current)
  }

  private async executeAuthorProjection(
    initialRun: ImportRunSnapshot,
    execution: ImportRunExecutionState,
    context: ImportRunExecutionContext,
    callbacks: StepCallbacks,
    stage: 'author-publish' | 'author-postprocess',
    nextStage: 'author-postprocess' | 'refresh',
  ): Promise<void> {
    let run = initialRun
    const getReceipt = requiredAuthorDependency(
      this.dependencies.getAuthorCommitReceipt,
      'getAuthorCommitReceipt',
    )
    const projectChapter = stage === 'author-publish'
      ? requiredAuthorDependency(this.dependencies.publishAuthorChapter, 'publishAuthorChapter')
      : requiredAuthorDependency(this.dependencies.postprocessAuthorChapter, 'postprocessAuthorChapter')
    const receipt = await getReceipt(run.id)
    if (!receipt) {
      throw importRecordError(
        run.locale,
        '读不到已保存的作者原稿记录。',
        'The saved author-manuscript record could not be read.',
      )
    }
    const draftsByChapter = new Map(receipt.drafts.map(draft => [draft.chapterNumber, draft]))
    let after = 0
    let visited = 0
    let page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    while (page.length > 0) {
      for (const chapter of page) {
        const checkpoint = `chapter:${chapter.number}`
        if (!run.completedBatches[stage]?.includes(checkpoint)) {
          stopIfCancelled(context, run.locale)
          const draft = draftsByChapter.get(chapter.number)
          if (!draft) {
            throw importRecordError(
              run.locale,
              `已保存的作者原稿记录里缺少第 ${chapter.number} 章。`,
              `The saved author-manuscript record is missing Chapter ${chapter.number}.`,
            )
          }
          execution.current = await this.dependencies.renewExecution(run.id, execution.current)
          await this.withLeaseHeartbeat(
            run,
            execution,
            () => projectChapter(chapter, draft, run),
          )
          execution.current = await this.dependencies.renewExecution(run.id, execution.current)
          const completed = await this.dependencies.completeBatch(
            run.id,
            stage,
            checkpoint,
            execution.current,
          )
          run = completed.run
        }
        visited += 1
        callbacks.setProgress(Math.min(99, Math.round((visited / run.totalChapters) * 100)))
        stopIfCancelled(context, run.locale)
      }
      after = page.at(-1)!.number
      page = await this.dependencies.listChapters(run.id, after, IMPORT_CHAPTER_PAGE_SIZE)
    }
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    stopIfCancelled(context, run.locale)
    await this.dependencies.advanceStage(run.id, stage, nextStage, execution.current)
  }

  private async executeRefresh(run: ImportRunSnapshot, execution: ImportRunExecutionState, context: ImportRunExecutionContext, callbacks: StepCallbacks) {
    if (!run.completedBatches.refresh?.includes('done')) {
      stopIfCancelled(context, run.locale)
      await this.withLeaseHeartbeat(run, execution, () => this.dependencies.refresh(run))
      execution.current = await this.dependencies.renewExecution(run.id, execution.current)
      await this.dependencies.completeBatch(run.id, 'refresh', 'done', execution.current)
    }
    callbacks.setProgress(100)
    stopIfCancelled(context, run.locale)
    execution.current = await this.dependencies.renewExecution(run.id, execution.current)
    stopIfCancelled(context, run.locale)
    await this.dependencies.complete(run.id, execution.current)
  }
}
