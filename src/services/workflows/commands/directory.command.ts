import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { getPromptTemplate } from '../../prompt-templates'
import { DirectoryPromptBuilder } from '../../prompts/prompt-builder'
import {
  DirectoryWorkflowParams,
  ChapterBlueprint,
  assertBlueprintCoverage,
  parseTextBlueprintsStrict,
  saveAllBlueprints,
  verifyBlueprintsPersisted,
  type DirectoryWorkflowProjectSnapshot,
} from '../directory-workflow'
import { requireWorkflowProjectSession } from '../workflow-project-session'
import { getBlueprintBatchSize } from '../blueprint-batch-policy'
import { syncBlueprintCharacterCandidates } from '../blueprint-character-sync'

function isBlueprintJsonParseError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('蓝图 JSON 解析失败：')
}

function buildBlueprintJsonRepairPrompt(content: string, startChapter: number, endChapter: number): string {
  return `将下面的章节蓝图输出修复为可被 JSON.parse 解析的 JSON 对象。\n\n`
    + `要求：仅输出 JSON；不要 Markdown、解释或 <think> 标签；根对象必须包含 blueprints 数组；保留原有章节信息；数组中的章节号必须覆盖第 ${startChapter} 至第 ${endChapter} 章。\n\n`
    + `待修复输出：\n${content}`
}

export class GenerateDirectoryCommand extends BaseWorkflowCommand<ChapterBlueprint[]> {
  constructor(
    private params: DirectoryWorkflowParams,
    private projectSnapshot: DirectoryWorkflowProjectSnapshot,
  ) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<ChapterBlueprint[]> {
    const projectSession = requireWorkflowProjectSession(context)
    const architecture = context.data.architecture as string
    const existingBlueprints = (context.data.existingBlueprints || []) as ChapterBlueprint[]

    const { expectedProjectPath, novelConfig } = this.projectSnapshot
    const totalChapters = novelConfig.totalChapters
    const globalGuidance = novelConfig.globalGuidance || ''
    const genre = novelConfig.genre || ''

    let startChapter = 1
    let endChapter = totalChapters

    if (this.params.mode === 'append') {
      startChapter = this.params.startChapter || (existingBlueprints.length + 1)
      if (this.params.count && this.params.count > 0) {
        endChapter = startChapter + this.params.count - 1
      }
    } else if (this.params.count && this.params.count > 0) {
      endChapter = Math.min(this.params.count, totalChapters)
    }

    callbacks.log(`生成第 ${startChapter}–${endChapter} 章蓝图...`)

    // 根据当前模型保守收敛物理请求大小；无论模型输出上限多高，每次最多 5 章。
    const llmStore = (await import('../../../stores/llm-store')).useLLMStore.getState()
    const defaultModel = llmStore.models.find(m => m.id === llmStore.defaultModelId)
    const modelMaxTokens = defaultModel?.maxTokens || 4096
    const batchSize = getBlueprintBatchSize(modelMaxTokens)

    const newBlueprints: ChapterBlueprint[] = []
    // 游标只会在已完整保存当前物理批次后推进。
    let cursor = startChapter

    while (cursor <= endChapter) {
      this.assertNotCancelled(context)

      const batchEnd = Math.min(cursor + batchSize - 1, endChapter)
      callbacks.log(`  正在生成第 ${cursor}–${batchEnd} 章...`)

      const template = getPromptTemplate('chapter_blueprint_chunk', projectSession)
      if (!template) throw new Error('模板丢失')
      const prevAll = [...existingBlueprints, ...newBlueprints]
      const chapterList = prevAll.slice(-100).map(c => `第${c.chapterNumber}章 ${c.title}：${c.keyEvents}`).join('\n')
      const prompt = new DirectoryPromptBuilder(template)
        .withNovelArchitecture(architecture)
        .withChapterList(chapterList || '（首批生成，尚无前置章节）')
        .withNumberOfChapters(totalChapters)
        .withN(cursor)
        .withM(batchEnd)
        .withGlobalGuidance(globalGuidance)
        .withGenre(genre)
        .withPacingGuidance((context.data.pacingGuidance as string) || '')
        .build()

      callbacks.setProgress(Math.round(((cursor - startChapter) / (endChapter - startChapter + 1)) * 90))

      // systemRole 由模板定义，不再硬编码
      const systemRole = template.systemRole || '你是一位经验丰富的网文架构师。'
      const jsonOutputOptions = {
        responseFormat: { type: 'json_object' },
        thinking: false,
        maxTokens: Math.min(modelMaxTokens, 4096),
      }
      const resultText = await this.callLLMWithBoundedCompletion(
        prompt,
        systemRole,
        callbacks,
        { mode: 'replace-structured-output', maxContinuations: 2 },
        jsonOutputOptions,
        context,
      )
      this.assertNotCancelled(context)

      // 当前物理请求只能接受当前批次。越界、重复造成的缺章都不能落库或推进游标。
      let parsed: ChapterBlueprint[]
      try {
        parsed = parseTextBlueprintsStrict(resultText, cursor, batchEnd)
      } catch (error) {
        if (!isBlueprintJsonParseError(error)) throw error

        callbacks.log('  蓝图 JSON 格式异常，正在请求模型修复格式...')
        const repairedText = await this.callLLMWithBoundedCompletion(
          buildBlueprintJsonRepairPrompt(resultText, cursor, batchEnd),
          '你是严格的 JSON 格式修复器，只输出有效 JSON。',
          callbacks,
          { mode: 'replace-structured-output', maxContinuations: 2 },
          jsonOutputOptions,
          context,
        )
        this.assertNotCancelled(context)
        parsed = parseTextBlueprintsStrict(repairedText, cursor, batchEnd)
      }
      assertBlueprintCoverage(parsed, cursor, batchEnd)
      newBlueprints.push(...parsed)

      // ==== 批次入库 ====
      if (parsed.length > 0) {
        this.assertNotCancelled(context)
        await saveAllBlueprints(parsed, expectedProjectPath, context.projectSession)
        this.assertNotCancelled(context)
        await verifyBlueprintsPersisted(
          parsed,
          expectedProjectPath,
          { startChapter: cursor, endChapter: batchEnd },
          context.projectSession,
        )
        this.assertNotCancelled(context)
        await syncBlueprintCharacterCandidates(
          parsed,
          expectedProjectPath,
          context.projectSession,
          `blueprint-sync-${context.runId}-${cursor}-${batchEnd}`,
        )
      }

      callbacks.log(`  ✅ 第 ${cursor}–${batchEnd} 章完成（${parsed.length} 章）并已保存入库`)

      cursor = batchEnd + 1
    }

    this.assertNotCancelled(context)
    context.data.newBlueprints = newBlueprints
    context.data.existingBlueprints = existingBlueprints

    callbacks.log(`✅ 共生成 ${newBlueprints.length} 章蓝图`)
    return newBlueprints
  }
}
