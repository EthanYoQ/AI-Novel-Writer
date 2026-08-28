import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import type { BlueprintRangeCommitReceipt } from '../../../../electron/repositories/blueprint-repository'
import { resolvePromptTemplate } from '../../prompt-templates'
import { DirectoryPromptBuilder } from '../../prompts/prompt-builder'
import { createGenerationRuntime, type GenerationRuntime } from '../../generation/generation-runtime'
import type { GenerationTask } from '../../generation/generation-harness'
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
import {
  BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST,
  blueprintSemanticGenerationContract,
  validateBlueprintSemanticItem,
} from '../../../shared/blueprint-semantic-contract'
import { requireWorkflowProjectSession, workflowWritingLanguage } from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
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

export class DirectoryBlueprintContractError extends Error {
  constructor(
    readonly diagnostic: { code: string; path: string; field: string },
    readonly generationSummary?: string,
  ) {
    super(
      `结构化合同诊断 code=${diagnostic.code} path=${diagnostic.path} field=${diagnostic.field}`
      + (generationSummary ? `；${generationSummary}` : ''),
    )
    this.name = 'DirectoryBlueprintContractError'
  }
}

function directoryGenerationFailureSummary(
  attempts: readonly { purpose?: string; finishReason: string; budget: { requestedOutputTokens: number } }[],
): string {
  if (attempts.length === 0) return 'generationAttempts=none'
  return attempts.map((attempt, index) => (
    `attempt=${index + 1} purpose=${attempt.purpose ?? 'unknown'} `
    + `finishReason=${attempt.finishReason} requestedTokens=${attempt.budget.requestedOutputTokens}`
  )).join('; ')
}

const COMPACT_BLUEPRINT_PROMPT_MAX_UTF8_BYTES = 16_384
const COMPACT_ARCHITECTURE_MAX_UTF8_BYTES = 4_800
const COMPACT_GUIDANCE_MAX_UTF8_BYTES = 1_200
const COMPACT_SYSTEM_ROLE_MAX_UTF8_BYTES = 600
const COMPACT_RECENT_BLUEPRINTS = 3

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function boundedFactText(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value.trim()
  let bytes = 0
  let bounded = ''
  for (const character of value) {
    const characterBytes = utf8Bytes(character)
    if (bytes + characterBytes > maxBytes) break
    bounded += character
    bytes += characterBytes
  }
  const boundary = Math.max(
    bounded.lastIndexOf('\n'),
    bounded.lastIndexOf('。'),
    bounded.lastIndexOf('！'),
    bounded.lastIndexOf('？'),
  )
  return (boundary >= Math.floor(bounded.length * 0.6)
    ? bounded.slice(0, boundary + 1)
    : bounded).trim()
}

function buildCompactBlueprintTask(input: {
  chapterNumber: number
  architecture: string
  previous: readonly ChapterBlueprint[]
  totalChapters: number
  genre: string
  globalGuidance: string
  pacingGuidance: string
  systemRole: string
  writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>
}): GenerationTask {
  const facts = {
    targetChapterNumber: input.chapterNumber,
    totalChapters: input.totalChapters,
    genre: boundedFactText(input.genre, 240),
    architectureExcerpt: boundedFactText(input.architecture, COMPACT_ARCHITECTURE_MAX_UTF8_BYTES),
    recentBlueprints: input.previous.slice(-COMPACT_RECENT_BLUEPRINTS).map(chapter => ({
      chapterNumber: chapter.chapterNumber,
      title: boundedFactText(chapter.title, 240),
      keyEvents: boundedFactText(chapter.keyEvents, 1_200),
      suspenseHook: boundedFactText(chapter.suspenseHook, 480),
    })),
    globalGuidance: boundedFactText(input.globalGuidance, COMPACT_GUIDANCE_MAX_UTF8_BYTES),
    pacingGuidance: boundedFactText(input.pacingGuidance, COMPACT_GUIDANCE_MAX_UTF8_BYTES),
  }
  const prompt = [
    promptLanguageText(input.writingLanguage, '上一次单章蓝图达到输出上限，其内容已丢弃。仅根据下列有界事实重建该章完整蓝图。', 'The previous single-chapter blueprint reached the output limit and was discarded. Rebuild the complete chapter blueprint from only the bounded facts below.'),
    promptLanguageText(input.writingLanguage, '【有界事实】', '[Bounded facts]'),
    JSON.stringify(facts),
    promptLanguageText(input.writingLanguage, '【输出合同】', '[Output contract]'),
    blueprintSemanticGenerationContract(input.writingLanguage),
    promptLanguageText(input.writingLanguage, `必须且只能返回 chapterNumber=${input.chapterNumber} 的一项。`, `Return exactly one item whose chapterNumber is ${input.chapterNumber}.`),
    promptLanguageText(input.writingLanguage, `严格执行字段和列表上限：${JSON.stringify(BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits)}。`, `Enforce these field and list limits exactly: ${JSON.stringify(BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits)}.`),
  ].join('\n')
  const systemRole = boundedFactText(input.systemRole, COMPACT_SYSTEM_ROLE_MAX_UTF8_BYTES)
    || promptLanguageText(input.writingLanguage, '你是一位经验丰富的网文架构师。', 'You are an experienced web-fiction architect.')
  if (utf8Bytes(prompt) + utf8Bytes(systemRole) > COMPACT_BLUEPRINT_PROMPT_MAX_UTF8_BYTES) {
    throw new Error('紧凑单章蓝图任务超过安全字节上限')
  }
  return {
    purpose: `chapter-blueprint-directory:compact-single:chapter-${input.chapterNumber}`,
    output: 'structured-data',
    messages: [
      { role: 'system', content: systemRole },
      { role: 'user', content: prompt },
    ],
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
    const writingLanguage = workflowWritingLanguage(context)
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
    const template = await resolvePromptTemplate('chapter_blueprint_chunk', projectSession, writingLanguage)
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
          .map(chapter => promptLanguageText(
            writingLanguage,
            `第${chapter.chapterNumber}章 ${chapter.title}：${chapter.keyEvents}`,
            `Chapter ${chapter.chapterNumber} — ${chapter.title}: ${chapter.keyEvents}`,
          ))
          .join('\n')
        const prompt = new DirectoryPromptBuilder(template, writingLanguage)
          .withNovelArchitecture(architecture)
          .withChapterList(chapterList || promptLanguageText(writingLanguage, '（首批生成，尚无前置章节）', '(first batch; no preceding chapters)'))
          .withNumberOfChapters(totalChapters)
          .withN(batchStart)
          .withM(batchEnd)
          .withGlobalGuidance(novelConfig.globalGuidance || '')
          .withGenre(novelConfig.genre || '')
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .build()
          + `\n\n${blueprintSemanticGenerationContract(writingLanguage)}`

        return {
          purpose: 'chapter-blueprint-directory',
          output: 'structured-data',
          messages: [
            {
              role: 'system',
              content: template.systemRole || promptLanguageText(writingLanguage, '你是一位经验丰富的网文架构师。', 'You are an experienced web-fiction architect.'),
            },
            { role: 'user', content: prompt },
          ],
        }
      },
      buildCompactSingleTask: ({ item, validatedPrefix }) => buildCompactBlueprintTask({
        chapterNumber: item,
        architecture,
        previous: [...existingBlueprints, ...validatedPrefix],
        totalChapters,
        genre: novelConfig.genre || '',
        globalGuidance: novelConfig.globalGuidance || '',
        pacingGuidance: (context.data.pacingGuidance as string) || '',
        systemRole: template.systemRole || promptLanguageText(writingLanguage, '你是一位经验丰富的网文架构师。', 'You are an experienced web-fiction architect.'),
        writingLanguage,
      }),
      inputKey: chapterNumber => chapterNumber,
      outputKey: blueprint => blueprint.chapterNumber,
      decode: content => parseTextBlueprintsStrict(
        content,
        activeRange.startChapter,
        activeRange.endChapter,
      ),
      validateItem: validateBlueprintSemanticItem,
      syntaxRepairContract: ({ items }) => (
        `${blueprintSemanticGenerationContract(writingLanguage)}\n`
        + promptLanguageText(
          writingLanguage,
          `本次必须且只能完整返回以下 chapterNumber：${items.join('、')}。`,
          `Return complete items for exactly these chapterNumber values: ${items.join(', ')}.`,
        )
      ),
    }

    const cancellation = observeWorkflowCancellation(context)
    let runtime: GenerationRuntime | null = null
    try {
      runtime = await this.createRuntime({
        budget: costPlan.runtimeBudget,
      })
      const batchResult = await runtime.execute(async ({ session }) => {
        const executor = createStructuredBatchExecutor({ contract, session, writingLanguage })
        return executor.execute({
          items: chapterNumbers,
          limits: {
            maxBatchItems: MAX_BLUEPRINT_ITEMS_PER_BATCH,
            maxCompactSingleFallbacks: costPlan.maxCompactSingleFallbacks,
          },
          signal: cancellation.signal,
        })
      })
      if (!batchResult.ok) {
        const generationSummary = directoryGenerationFailureSummary(batchResult.receipt.attempts)
        callbacks.log(`蓝图生成失败收据：${generationSummary}`)
        if (batchResult.failure.diagnostic) {
          throw new DirectoryBlueprintContractError(batchResult.failure.diagnostic, generationSummary)
        }
        throw new Error(`${batchResult.failure.message}；${generationSummary}`)
      }

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
