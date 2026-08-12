import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import type { BlueprintRangeCommitReceipt } from '../../../../electron/repositories/blueprint-repository'
import { resolvePromptTemplate } from '../../prompt-templates'
import { DirectoryPromptBuilder } from '../../prompts/prompt-builder'
import { createGenerationRuntime, type GenerationRuntime } from '../../generation/generation-runtime'
import {
  createStructuredBatchExecutor,
  type StructuredBatchContract,
} from '../structured-batch-executor'
import {
  DirectoryWorkflowParams,
  ChapterBlueprint,
  commitDirectoryBlueprintRange,
  parseTextBlueprintsStrict,
  type DirectoryWorkflowProjectSnapshot,
} from '../directory-workflow'
import { validateBlueprintSemanticItem } from '../../../shared/blueprint-semantic-contract'
import { requireWorkflowProjectSession } from '../workflow-project-session'
import {
  listPendingDirectoryCharacterSyncs,
  retryDirectoryCharacterSync,
} from '../directory-character-sync-recovery'
export {
  retryDirectoryCharacterSync,
  type DirectoryCharacterSyncReceipt,
} from '../directory-character-sync-recovery'
import {
  MAX_BLUEPRINT_ITEMS_PER_BATCH,
  MAX_BLUEPRINT_CHAPTERS_PER_TASK,
  planBlueprintGenerationCost,
} from '../blueprint-batch-policy'

type CreateDirectoryGenerationRuntime = typeof createGenerationRuntime

export interface GenerateDirectoryCommandDependencies {
  createRuntime?: CreateDirectoryGenerationRuntime
}

export class DirectoryPostCommitSyncError extends Error {
  readonly retryOperationId: string

  constructor(readonly commitReceipt: BlueprintRangeCommitReceipt) {
    super(
      `章节蓝图已提交（第 ${commitReceipt.startChapter}–${commitReceipt.endChapter} 章），`
      + '但角色候选同步失败；可安全重试角色同步。',
    )
    this.name = 'DirectoryPostCommitSyncError'
    this.retryOperationId = commitReceipt.characterSyncOperation.operationId
  }
}

export class DirectoryPostCommitCancellationError extends Error {
  readonly retryOperationId: string

  constructor(readonly commitReceipt: BlueprintRangeCommitReceipt) {
    super(
      `章节蓝图已提交（第 ${commitReceipt.startChapter}–${commitReceipt.endChapter} 章），`
      + '随后任务被取消；角色候选同步尚未确认完成。',
    )
    this.name = 'DirectoryPostCommitCancellationError'
    this.retryOperationId = commitReceipt.characterSyncOperation.operationId
  }
}

export class DirectoryCostLimitError extends Error {
  readonly code = 'DIRECTORY_TASK_COST_LIMIT' as const

  constructor(readonly chapterCount: number) {
    super(
      `本次目录范围共 ${chapterCount} 章，超过单次任务 ${MAX_BLUEPRINT_CHAPTERS_PER_TASK} 章的安全成本上限；`
      + `请拆成每段不超过 ${MAX_BLUEPRINT_CHAPTERS_PER_TASK} 章的范围分别生成。`,
    )
    this.name = 'DirectoryCostLimitError'
  }
}

export class DirectoryCharacterSyncPendingError extends Error {
  readonly code = 'DIRECTORY_CHARACTER_SYNC_PENDING' as const

  constructor(readonly operationIds: readonly string[]) {
    super(
      `仍有 ${operationIds.length} 次已提交蓝图的角色同步待修复；`
      + '请先在蓝图生成窗口点击“重试角色同步”，无需重新生成蓝图。',
    )
    this.name = 'DirectoryCharacterSyncPendingError'
  }
}

function observeWorkflowCancellation(context: CommandExecuteParams['context']): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  if (context.cancelled) controller.abort()
  const interval = setInterval(() => {
    if (context.cancelled) controller.abort()
  }, 25)
  return {
    signal: controller.signal,
    dispose: () => clearInterval(interval),
  }
}

export class GenerateDirectoryCommand extends BaseWorkflowCommand<ChapterBlueprint[]> {
  private readonly createRuntime: CreateDirectoryGenerationRuntime

  constructor(
    private params: DirectoryWorkflowParams,
    private projectSnapshot: DirectoryWorkflowProjectSnapshot,
    dependencies: GenerateDirectoryCommandDependencies = {},
  ) {
    super()
    this.createRuntime = dependencies.createRuntime ?? createGenerationRuntime
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<ChapterBlueprint[]> {
    const projectSession = requireWorkflowProjectSession(context)
    const architecture = context.data.architecture as string
    const existingBlueprints = (context.data.existingBlueprints || []) as ChapterBlueprint[]
    const { expectedProjectPath, novelConfig } = this.projectSnapshot
    const totalChapters = novelConfig.totalChapters
    const pendingCharacterSyncs = await listPendingDirectoryCharacterSyncs(
      expectedProjectPath,
      projectSession,
    )
    if (pendingCharacterSyncs.length > 0) {
      throw new DirectoryCharacterSyncPendingError(
        pendingCharacterSyncs.map(operation => operation.operationId),
      )
    }

    let startChapter = 1
    let endChapter = totalChapters
    if (this.params.mode === 'append') {
      startChapter = this.params.startChapter || (existingBlueprints.length + 1)
      if (this.params.count && this.params.count > 0) {
        endChapter = Math.min(totalChapters, startChapter + this.params.count - 1)
      }
    } else if (this.params.count && this.params.count > 0) {
      endChapter = Math.min(this.params.count, totalChapters)
    }
    if (
      !Number.isInteger(startChapter)
      || !Number.isInteger(endChapter)
      || startChapter < 1
      || startChapter > totalChapters
      || endChapter < startChapter
    ) {
      throw new Error(`章节范围无效：第 ${startChapter}–${endChapter} 章`)
    }

    this.assertNotCancelled(context)
    callbacks.log(`生成第 ${startChapter}–${endChapter} 章蓝图...`)
    const chapterCount = endChapter - startChapter + 1
    const costPlan = planBlueprintGenerationCost(chapterCount)
    if (costPlan.exceedsHardLimit) {
      throw new DirectoryCostLimitError(chapterCount)
    }
    const chapterNumbers = Array.from(
      { length: chapterCount },
      (_, index) => startChapter + index,
    )
    const template = await resolvePromptTemplate('chapter_blueprint_chunk', projectSession)
    if (!template) throw new Error('模板丢失')

    let activeRange = { startChapter, endChapter }
    const contract: StructuredBatchContract<number, ChapterBlueprint> = {
      buildTask: ({ items, validatedPrefix }) => {
        const batchStart = items[0]
        const batchEnd = items.at(-1)
        if (batchStart === undefined || batchEnd === undefined) {
          throw new Error('章节蓝图批次不能为空')
        }
        activeRange = { startChapter: batchStart, endChapter: batchEnd }
        callbacks.log(`  正在生成第 ${batchStart}–${batchEnd} 章...`)
        callbacks.setProgress(Math.round(
          ((batchStart - startChapter) / chapterNumbers.length) * 90,
        ))

        const previous = [...existingBlueprints, ...validatedPrefix]
        const chapterList = previous.slice(-100)
          .map(chapter => `第${chapter.chapterNumber}章 ${chapter.title}：${chapter.keyEvents}`)
          .join('\n')
        const prompt = new DirectoryPromptBuilder(template)
          .withNovelArchitecture(architecture)
          .withChapterList(chapterList || '（首批生成，尚无前置章节）')
          .withNumberOfChapters(totalChapters)
          .withN(batchStart)
          .withM(batchEnd)
          .withGlobalGuidance(novelConfig.globalGuidance || '')
          .withGenre(novelConfig.genre || '')
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .build()

        return {
          purpose: 'chapter-blueprint-directory',
          output: 'structured-data',
          messages: [
            {
              role: 'system',
              content: template.systemRole || '你是一位经验丰富的网文架构师。',
            },
            { role: 'user', content: prompt },
          ],
        }
      },
      inputKey: chapterNumber => chapterNumber,
      outputKey: blueprint => blueprint.chapterNumber,
      decode: content => parseTextBlueprintsStrict(
        content,
        activeRange.startChapter,
        activeRange.endChapter,
      ),
      validateItem: validateBlueprintSemanticItem,
    }

    const cancellation = observeWorkflowCancellation(context)
    let runtime: GenerationRuntime | null = null
    try {
      runtime = await this.createRuntime({
        budget: costPlan.runtimeBudget,
      })
      const batchResult = await runtime.execute(async ({ session }) => {
        const executor = createStructuredBatchExecutor({ contract, session })
        return executor.execute({
          items: chapterNumbers,
          limits: { maxBatchItems: MAX_BLUEPRINT_ITEMS_PER_BATCH },
          signal: cancellation.signal,
        })
      })
      if (!batchResult.ok) throw new Error(batchResult.failure.message)

      this.assertNotCancelled(context)
      const generatedBlueprints = [...batchResult.items]
      const commitReceipt = await commitDirectoryBlueprintRange(
        generatedBlueprints,
        expectedProjectPath,
        {
          mode: this.params.mode === 'full' ? 'full' : 'replace-range',
          startChapter,
          endChapter,
        },
        `directory-${context.runId}-${startChapter}-${endChapter}`,
        context.projectSession,
      )
      const newBlueprints = [...commitReceipt.snapshot]
      context.data.blueprintCommitReceipt = commitReceipt

      if (context.cancelled) {
        throw new DirectoryPostCommitCancellationError(commitReceipt)
      }
      try {
        const syncReceipt = await retryDirectoryCharacterSync(
          commitReceipt.characterSyncOperation.operationId,
          expectedProjectPath,
          context.projectSession,
        )
        context.data.blueprintCharacterSyncReceipt = syncReceipt
      } catch {
        throw new DirectoryPostCommitSyncError(commitReceipt)
      }

      context.data.newBlueprints = newBlueprints
      context.data.existingBlueprints = existingBlueprints
      callbacks.log(`共生成 ${newBlueprints.length} 章蓝图`)
      return newBlueprints
    } finally {
      cancellation.dispose()
      await runtime?.close().catch(() => {})
    }
  }
}
