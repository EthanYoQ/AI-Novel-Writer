import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import type { BlueprintRangeCommitReceipt } from '../../../../electron/repositories/blueprint-repository'
import { composePromptSystemRole, resolvePromptTemplate } from '../../prompt-templates'
import { DirectoryPromptBuilder } from '../../prompts/prompt-builder'
import type { GenerationTask } from '../../generation/generation-harness'
import {
  createStructuredBatchExecutor,
  type StructuredBatchContract,
  type StructuredBatchFailure,
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
import { structuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import { stripThinkingTags } from '../workflow-utils'
import { promptLanguageText } from '../../prompt-language'
import { retryDirectoryCharacterSync } from '../directory-character-sync-recovery'
export {
  retryDirectoryCharacterSync,
  type DirectoryCharacterSyncReceipt,
} from '../directory-character-sync-recovery'
import {
  MAX_BLUEPRINT_ITEMS_PER_BATCH,
  MAX_BLUEPRINT_CHAPTERS_PER_TASK,
  planBlueprintGenerationCost,
} from '../blueprint-batch-policy'
import { readAuthoritativeNextChapter } from '../../authoritative-chapter-sequence'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import { normalizeChapterWordsTarget } from '../chapter-creation-parameters'

type CreateDirectoryGenerationRuntime = NonNullable<WorkflowGenerationRuntimeDependencies['createRuntime']>

export interface GenerateDirectoryCommandDependencies {
  createRuntime?: CreateDirectoryGenerationRuntime
}

/** A failed run may still have one atomically adopted, fully validated prefix. */
export class DirectoryPartialCommitError extends Error {
  readonly code = 'DIRECTORY_PARTIAL_COMMIT'
  constructor(readonly commitReceipt: BlueprintRangeCommitReceipt, readonly remainingRange: { startChapter: number; endChapter: number }, readonly generationFailure: StructuredBatchFailure, message: string) {
    super(message)
    this.name = 'DirectoryPartialCommitError'
  }
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

export class DirectoryBlueprintContractError extends Error {
  constructor(
    readonly diagnostic: {
      code: string
      path: string
      field: string
      actualCharacters?: number
      maxCharacters?: number
    },
    readonly generationSummary?: string,
    uiLocale: CommandExecuteParams['context']['uiLocale'] = 'zh-CN',
  ) {
    const characterCounts = diagnostic.actualCharacters !== undefined
      && diagnostic.maxCharacters !== undefined
      ? ` actualCharacters=${diagnostic.actualCharacters} maxCharacters=${diagnostic.maxCharacters}`
      : ''
    super(
      uiLocale === 'en-US'
        ? `Structured contract diagnostic code=${diagnostic.code} path=${diagnostic.path} field=${diagnostic.field}${characterCounts}`
          + (generationSummary ? `; ${generationSummary}` : '')
        : `结构化合同诊断 code=${diagnostic.code} path=${diagnostic.path} field=${diagnostic.field}${characterCounts}`
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
const COMPACT_SYSTEM_ROLE_MAX_UTF8_BYTES = 600
const COMPACT_RECENT_BLUEPRINTS = 3

function blueprintCapacityGenerationContract(
  writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>,
  targetWords: number,
): string {
  const lowerBound = Math.round(targetWords * 0.8)
  const upperBound = Math.round(targetWords * 1.2)
  return promptLanguageText(
    writingLanguage,
    `【章节容量合同】\n每章正文目标约 ${targetWords} 字，可接受范围 ${lowerBound}–${upperBound} 字；据此控制情节点容量。作者指定事件与字数目标均为权威事实，不得删除、改写或擅自调整。合并 role、purpose、keyEvents、架构与前章列表中对同一事件的重复表述，只计一个语义事件；不擅自增加独立事件，也不为凑字数补事件。背景设定只作为约束和参考；除非作者指定事件明确要求，不得把全部背景逐项演成场景。JSON 输出合同不变；容量兼容时，keyEvents 只写能在上述范围内完整演绎的推进与结果。若语义去重后仍不兼容，保留作者指定事件，并在现有 keyEvents 字符串中简短指出“容量冲突：…”供作者调整；不新增字段、不代替作者取舍，也不写章节正文。`,
    `[Chapter capacity contract]\nTarget about ${targetWords} words per chapter, with an acceptable range of ${lowerBound}-${upperBound}; size the plot-point load accordingly. Author-specified events and the word target are authoritative facts: do not delete, rewrite, or adjust them. Merge duplicate descriptions of the same event across role, purpose, keyEvents, architecture, and the preceding chapter list, counting them as one semantic event; do not invent independent events or add events to fill space. Background facts are constraints and references, not a requirement to dramatize every fact as a scene unless an author-specified event requires it. Keep the JSON output contract unchanged. When capacity is compatible, keyEvents should state only the progression and outcome that can be fully dramatized within this range. If semantic deduplication still leaves an incompatible load, preserve the author-specified events and briefly state "Capacity conflict: ..." in the existing keyEvents string for the author to adjust; add no field, make no choice for the author, and do not write chapter prose.`,
  )
}

const GENERATED_BLUEPRINT_TEXT_LIMITS = [
  ['title', BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.titleCharacters],
  ['role', BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.roleCharacters],
  ['purpose', BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.purposeCharacters],
  ['keyEvents', BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.keyEventsCharacters],
  ['key_events', BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.keyEventsCharacters],
  ['suspenseHook', BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.suspenseHookCharacters],
  ['suspense_hook', BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.suspenseHookCharacters],
] as const
const GENERATED_BLUEPRINT_RELATION_FIELDS = ['relationships', 'relationshipHints', 'relations'] as const

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

function normalizeGeneratedBlueprintText(content: string): string {
  const trimmed = stripThinkingTags(content).trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  const parsed: unknown = JSON.parse(fenced ? fenced[1].trim() : trimmed)
  const candidates = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'blueprints')
    ? (parsed as Record<string, unknown>).blueprints
    : parsed
  if (!Array.isArray(candidates)) return content
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    for (const [field, maxCharacters] of GENERATED_BLUEPRINT_TEXT_LIMITS) {
      const value = record[field]
      if (typeof value === 'string') {
        record[field] = Array.from(value.trim()).slice(0, maxCharacters).join('')
      }
    }
    for (const field of GENERATED_BLUEPRINT_RELATION_FIELDS) {
      const relationships = record[field]
      if (!Array.isArray(relationships)) continue
      for (const relationship of relationships) {
        if (!relationship || typeof relationship !== 'object' || Array.isArray(relationship)) continue
        const relation = (relationship as Record<string, unknown>).relation
        if (typeof relation === 'string') {
          (relationship as Record<string, unknown>).relation = Array.from(relation.trim())
            .slice(0, BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits.relationshipCharacters)
            .join('')
        }
      }
    }
  }
  return JSON.stringify(parsed)
}

function decodeGeneratedBlueprints(
  content: string,
  startChapter: number,
  endChapter: number,
): ChapterBlueprint[] {
  try {
    return parseTextBlueprintsStrict(content, startChapter, endChapter)
  } catch (error) {
    const diagnostic = structuredContractDiagnostic(error)
    if (
      diagnostic?.code !== 'value_too_long'
      || (
        diagnostic.field !== 'relation'
        && !GENERATED_BLUEPRINT_TEXT_LIMITS.some(([field]) => field === diagnostic.field)
      )
    ) throw error
    return parseTextBlueprintsStrict(
      normalizeGeneratedBlueprintText(content),
      startChapter,
      endChapter,
    )
  }
}

function buildCompactBlueprintTask(input: {
  chapterNumber: number
  architecture: string
  previous: readonly ChapterBlueprint[]
  totalChapters: number
  wordsPerChapter: number
  genre: string
  globalGuidance: string
  pacingGuidance: string
  systemRole: string
  writingLanguage: NonNullable<CommandExecuteParams['context']['writingLanguage']>
  diagnostic?: { code: string; path: string; field: string }
}): GenerationTask {
  const facts = {
    targetChapterNumber: input.chapterNumber,
    totalChapters: input.totalChapters,
    targetWordsPerChapter: input.wordsPerChapter,
    genre: boundedFactText(input.genre, 240),
    architectureExcerpt: boundedFactText(input.architecture, COMPACT_ARCHITECTURE_MAX_UTF8_BYTES),
    recentBlueprints: input.previous.slice(-COMPACT_RECENT_BLUEPRINTS).map(chapter => ({
      chapterNumber: chapter.chapterNumber,
      title: boundedFactText(chapter.title, 240),
      keyEvents: boundedFactText(chapter.keyEvents, 1_200),
      suspenseHook: boundedFactText(chapter.suspenseHook, 480),
    })),
    globalGuidance: input.globalGuidance,
    pacingGuidance: input.pacingGuidance,
  }
  const prompt = [
    promptLanguageText(input.writingLanguage, '仅根据下列有界事实生成该章完整蓝图。', 'Build the complete chapter blueprint from only the bounded facts below.'),
    promptLanguageText(input.writingLanguage, '【有界事实】', '[Bounded facts]'),
    JSON.stringify(facts),
    promptLanguageText(input.writingLanguage, '【输出合同】', '[Output contract]'),
    blueprintSemanticGenerationContract(input.writingLanguage),
    promptLanguageText(
      input.writingLanguage,
      `【精确 JSON 形状】{"blueprints":[{"chapterNumber":${input.chapterNumber},"title":"短标题","role":"简短结构标签","purpose":"一句简洁陈述","keyEvents":"简洁事件摘要","characters":["完整姓名"],"relationships":[],"suspenseHook":"一句简洁陈述"}]}`,
      `[Exact JSON shape] {"blueprints":[{"chapterNumber":${input.chapterNumber},"title":"short title","role":"short structural label","purpose":"one concise sentence","keyEvents":"concise event summary","characters":["full name"],"relationships":[],"suspenseHook":"one concise sentence"}]}`,
    ),
    ...(input.diagnostic
      ? [promptLanguageText(
          input.writingLanguage,
          `【上次合同违规】code=${input.diagnostic.code} path=${input.diagnostic.path} field=${input.diagnostic.field}。丢弃上次输出，按上述合同完整重建。`,
          `[Previous contract violation] code=${input.diagnostic.code} path=${input.diagnostic.path} field=${input.diagnostic.field}. Discard the previous output and rebuild the complete item under the contract above.`,
        )]
      : []),
    promptLanguageText(input.writingLanguage, `必须且只能返回 chapterNumber=${input.chapterNumber} 的一项。`, `Return exactly one item whose chapterNumber is ${input.chapterNumber}.`),
    promptLanguageText(input.writingLanguage, `严格执行字段和列表上限：${JSON.stringify(BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits)}。`, `Enforce these field and list limits exactly: ${JSON.stringify(BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.outputLimits)}.`),
    blueprintCapacityGenerationContract(input.writingLanguage, input.wordsPerChapter),
  ].join('\n')
  const systemRole = composePromptSystemRole({
    systemRole: boundedFactText(input.systemRole, COMPACT_SYSTEM_ROLE_MAX_UTF8_BYTES)
      || promptLanguageText(input.writingLanguage, '你是一位经验丰富的章节架构师。', 'You are an experienced chapter architect.'),
  }, input.writingLanguage)
  const factSection = (sectionName: string, key: keyof typeof facts) => ({
    sectionName,
    messageIndex: 1,
    finalText: JSON.stringify({ [key]: facts[key] }).slice(1, -1),
  })
  return {
    purpose: `chapter-blueprint-directory:compact-single:chapter-${input.chapterNumber}`,
    output: 'structured-data',
    messages: [
      { role: 'system', content: systemRole },
      { role: 'user', content: prompt },
    ],
    promptBudget: {
      limitUtf8Bytes: COMPACT_BLUEPRINT_PROMPT_MAX_UTF8_BYTES,
      sections: [
        { sectionName: 'system-instructions', messageIndex: 0, finalText: systemRole },
        factSection('target-chapter', 'targetChapterNumber'),
        factSection('project-chapter-count', 'totalChapters'),
        factSection('chapter-word-target', 'targetWordsPerChapter'),
        factSection('genre', 'genre'),
        factSection('architecture', 'architectureExcerpt'),
        factSection('previous-blueprints', 'recentBlueprints'),
        factSection('global-guidance', 'globalGuidance'),
        factSection('step-guidance', 'pacingGuidance'),
      ],
    },
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

  constructor(
    private params: DirectoryWorkflowParams,
    private projectSnapshot: DirectoryWorkflowProjectSnapshot,
    dependencies: GenerateDirectoryCommandDependencies = {},
  ) {
    super(dependencies.createRuntime ? { createRuntime: dependencies.createRuntime } : undefined)
  }

  async execute({ context, callbacks, step }: CommandExecuteParams): Promise<ChapterBlueprint[]> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const architecture = context.data.architecture as string
    const existingBlueprints = (context.data.existingBlueprints || []) as ChapterBlueprint[]
    const { expectedProjectPath, novelConfig } = this.projectSnapshot
    const modelFacts = localizeNovelConfigFacts(novelConfig, writingLanguage)
    const totalChapters = novelConfig.totalChapters
    const wordsPerChapter = normalizeChapterWordsTarget(novelConfig.wordsPerChapter)
    const authoritativeNextChapter = await readAuthoritativeNextChapter(
      projectSession,
      writingLanguage,
    )
    let startChapter = 1
    let endChapter = totalChapters
    if (this.params.mode === 'append') {
      startChapter = this.params.startChapter || authoritativeNextChapter
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
    callbacks.log(workflowUiText(
      context,
      `生成第 ${startChapter}–${endChapter} 章蓝图...`,
      `Generating blueprints for chapters ${startChapter}–${endChapter}...`,
    ))
    const chapterCount = endChapter - startChapter + 1
    const costPlan = planBlueprintGenerationCost(chapterCount)
    const chapterNumbers = Array.from(
      { length: chapterCount },
      (_, index) => startChapter + index,
    )
    const template = await resolvePromptTemplate('chapter_blueprint_chunk', projectSession, writingLanguage)
    if (!template) throw new Error('模板丢失')

    let activeRange = { startChapter, endChapter }
    const compactTaskFor = (
      item: number,
      validatedPrefix: readonly ChapterBlueprint[],
      diagnostic?: { code: string; path: string; field: string },
    ) => (
      buildCompactBlueprintTask({
        chapterNumber: item,
        architecture,
        previous: [...existingBlueprints, ...validatedPrefix],
        totalChapters,
        wordsPerChapter,
        genre: modelFacts.genre,
        globalGuidance: novelConfig.globalGuidance || '',
        pacingGuidance: (context.data.pacingGuidance as string) || '',
        systemRole: template.systemRole || promptLanguageText(writingLanguage, '你是一位经验丰富的小说架构师。', 'You are an experienced fiction architect.'),
        writingLanguage,
        diagnostic,
      })
    )
    const contract: StructuredBatchContract<number, ChapterBlueprint> = {
      buildTask: ({ items, validatedPrefix }) => {
        const batchStart = items[0]
        const batchEnd = items.at(-1)
        if (batchStart === undefined || batchEnd === undefined) {
          throw new Error('章节蓝图批次不能为空')
        }
        activeRange = { startChapter: batchStart, endChapter: batchEnd }
        callbacks.log(workflowUiText(
          context,
          `  正在生成第 ${batchStart}–${batchEnd} 章...`,
          `  Generating chapters ${batchStart}–${batchEnd}...`,
        ))
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
          .withGenre(modelFacts.genre)
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .build()
          + `\n\n${blueprintSemanticGenerationContract(writingLanguage)}`
          + `\n\n${blueprintCapacityGenerationContract(writingLanguage, wordsPerChapter)}`

        return {
          purpose: 'chapter-blueprint-directory',
          output: 'structured-data',
          messages: [
            {
              role: 'system',
              content: composePromptSystemRole({
                systemRole: template.systemRole || promptLanguageText(writingLanguage, '你是一位经验丰富的小说架构师。', 'You are an experienced fiction architect.'),
              }, writingLanguage),
            },
            { role: 'user', content: prompt },
          ],
        }
      },
      buildCompactSingleTask: ({ item, validatedPrefix, diagnostic }) => (
        compactTaskFor(item, validatedPrefix, diagnostic)
      ),
      inputKey: chapterNumber => chapterNumber,
      outputKey: blueprint => blueprint.chapterNumber,
      decode: content => decodeGeneratedBlueprints(
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

    return this.executeWithGenerationRuntime('structured', { context, callbacks, step }, async () => {
    const cancellation = observeWorkflowCancellation(context)
    try {
      const batchResult = await (async () => {
        const session = this.requireGenerationExecution().session
        const planningSession = injectWritingSkillIntoSession(session, context, 'planning')
        if (context.writingSkills?.planning) {
          callbacks.log(workflowUiText(
            context,
            `本次 planning 阶段使用已冻结写作 Skill：${context.writingSkills.planning.name}`,
            `Using the workflow-start-frozen writing skill for planning: ${context.writingSkills.planning.name}`,
          ))
        }
        const executor = createStructuredBatchExecutor({
          contract,
          session: planningSession,
          writingLanguage,
          onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
        })
        return executor.execute({
          items: chapterNumbers,
          limits: {
            maxBatchItems: MAX_BLUEPRINT_ITEMS_PER_BATCH,
            maxCompactSingleFallbacks: costPlan.maxCompactSingleFallbacks,
          },
          signal: cancellation.signal,
        })
      })()
      if (!batchResult.ok) {
        this.assertNotCancelled(context)
        const prefix = [...batchResult.validatedItems]
        if (prefix.length) {
          if (prefix.some((item, index) => item.chapterNumber !== startChapter + index)) throw new Error('DIRECTORY_VALIDATED_PREFIX_NOT_CONTIGUOUS')
          const prefixEnd = startChapter + prefix.length - 1
          const receipt = await commitDirectoryBlueprintRange(prefix, expectedProjectPath,
            { mode: 'replace-range', startChapter, endChapter: prefixEnd },
            `directory-${context.runId}-${startChapter}-${prefixEnd}-partial`, context.projectSession, context.mainGenerationRunHandle, { startChapter, endChapter })
          context.data.blueprintCommitReceipt = receipt
          context.data.newBlueprints = [...receipt.snapshot]
          context.data.remainingBlueprintRange = { startChapter: prefixEnd + 1, endChapter }
          if (context.cancelled) throw new DirectoryPostCommitCancellationError(receipt)
          try {
            await retryDirectoryCharacterSync(receipt.characterSyncOperation.operationId, expectedProjectPath, context.projectSession)
          } catch { throw new DirectoryPostCommitSyncError(receipt) }
          throw new DirectoryPartialCommitError(receipt, { startChapter: prefixEnd + 1, endChapter }, batchResult.failure, workflowUiText(context,
            `已保存第 ${startChapter}–${prefixEnd} 章完整蓝图；第 ${prefixEnd + 1}–${endChapter} 章未完成。原运行的候选与失败原因已保留。`,
            `Saved complete blueprints for chapters ${startChapter}–${prefixEnd}; chapters ${prefixEnd + 1}–${endChapter} remain incomplete. The original run retains its candidates and failure reason.`,
          ))
        }
        const generationSummary = directoryGenerationFailureSummary(batchResult.receipt.attempts)
        callbacks.log(workflowUiText(
          context,
          `蓝图生成失败收据：${generationSummary}`,
          `Blueprint generation failure receipt: ${generationSummary}`,
        ))
        if (batchResult.failure.diagnostic) {
          throw new DirectoryBlueprintContractError(
            batchResult.failure.diagnostic,
            generationSummary,
            context.uiLocale,
          )
        }
        throw new Error(context.uiLocale === 'en-US'
          ? `Blueprint generation failed: code=${batchResult.failure.code} reason=${batchResult.failure.reason ?? 'unknown'}; ${generationSummary}`
          : `${batchResult.failure.message}；${generationSummary}`)
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
        context.mainGenerationRunHandle,
        { startChapter, endChapter },
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
      callbacks.log(workflowUiText(
        context,
        `共生成 ${newBlueprints.length} 章蓝图`,
        `Generated ${newBlueprints.length} chapter blueprint${newBlueprints.length === 1 ? '' : 's'}`,
      ))
      return newBlueprints
    } finally {
      cancellation.dispose()
    }
    }, {
      continueDirectoryOperationId: this.params.continueDirectoryOperationId,
      resumeHandle: context.data.directoryResumeHandle as MainGenerationRunHandle | undefined,
      selectedBlueprintChapterNumbers: [...new Set([...chapterNumbers, ...existingBlueprints.map(item => item.chapterNumber)])],
      operation: 'chapter-blueprint-directory', promptKeys: ['chapter_blueprint_chunk'], skillStages: ['planning'], output: 'structured-data',
      authorInputs: [{ id: 'directory:pacing-guidance', text: typeof context.data.pacingGuidance === 'string' ? context.data.pacingGuidance : '' }, { id: 'directory:author-config', text: JSON.stringify(novelConfig) }, { id: 'directory:requested-range', text: JSON.stringify({ mode: this.params.mode, startChapter, endChapter }) }],
    })
  }
}
