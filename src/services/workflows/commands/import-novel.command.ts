/**
 * 导入小说 — Command 集合
 *
 * 三个独立 Command 组成逆向推演全链路：
 * 1. ImportInitializeCommand — 写入正文 + 构建知识库
 * 2. InferGlobalSettingsCommand — 向量采样 + AI 推演全局配置/架构/角色
 * 3. InferBlueprintsPerChapterCommand — 按章逐一推演精准蓝图 + 蓝图入向量库 + 拼装轻量全局摘要
 */

import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ImportPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { requireWorkflowProjectSession } from '../workflow-project-session'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import type { ChapterBlueprint } from '../directory-workflow'
import { retryDirectoryCharacterSync } from '../directory-character-sync-recovery'
import type { BlueprintRangeCommitReceipt } from '../../../../electron/repositories/blueprint-repository'
import {
  blueprintSemanticGenerationContract,
  parseBlueprintSemanticResponseText,
  validateBlueprintSemanticItem,
} from '../../../shared/blueprint-semantic-contract'
import {
  IMPORT_INFERENCE_JSON_CONTRACT,
  decodeImportInferenceJson,
} from './import-inference-contract'
import type {
  FinalizedDraftImportDraftReceipt,
  FinalizedDraftImportReceipt,
} from '../../../shared/finalized-draft-import'
import type { ImportGlobalFactsReceipt } from '../../../shared/import-global-facts'
import {
  buildStructuredSyntaxRepairTask,
  isRepairableDirectJsonSyntaxFailure,
  MAX_STRUCTURED_REPAIR_CANDIDATE_UTF8_BYTES,
  MAX_STRUCTURED_REPAIR_CONTRACT_UTF8_BYTES,
  preservesStructuredJsonEvidence,
  structuredRepairUtf8Bytes,
} from '../structured-syntax-repair'

/** 拆分后的章节数据（从 context.data 中传递） */
export interface ImportedChapter {
  number: number
  title: string
  content: string
  wordCount: number
}

const SHA256_HEX = /^[a-f0-9]{64}$/u

function requireFinalizedDraftImportReceipt(
  candidate: FinalizedDraftImportReceipt | undefined,
  operationId: string,
  expectedChapterNumbers: number[],
): FinalizedDraftImportReceipt {
  const chapterNumbers = [...expectedChapterNumbers].sort((left, right) => left - right)
  if (
    !candidate
    || candidate.operationId !== operationId
    || !SHA256_HEX.test(candidate.payloadHash)
    || typeof candidate.idempotent !== 'boolean'
    || !Array.isArray(candidate.chapterNumbers)
    || !Array.isArray(candidate.drafts)
    || candidate.chapterNumbers.length !== chapterNumbers.length
    || candidate.drafts.length !== chapterNumbers.length
    || candidate.chapterNumbers.some((number, index) => number !== chapterNumbers[index])
  ) {
    throw new Error('批量定稿导入收据无效或章节覆盖不完整')
  }
  const seenDraftIds = new Set<number>()
  const seenFinalizationIds = new Set<string>()
  for (const [index, draft] of candidate.drafts.entries()) {
    const expectedChapterNumber = chapterNumbers[index]
    const validDraft = draft as FinalizedDraftImportDraftReceipt
    if (
      validDraft.chapterNumber !== expectedChapterNumber
      || !Number.isInteger(validDraft.draftId)
      || validDraft.draftId < 1
      || seenDraftIds.has(validDraft.draftId)
      || typeof validDraft.finalizationId !== 'string'
      || validDraft.finalizationId.length === 0
      || seenFinalizationIds.has(validDraft.finalizationId)
      || !SHA256_HEX.test(validDraft.contentHash)
      || typeof validDraft.targetFileName !== 'string'
      || validDraft.targetFileName.length === 0
      || validDraft.status !== 'finalized'
      || validDraft.publicationStatus !== 'pending'
    ) {
      throw new Error('批量定稿导入收据缺少可信的定稿事实')
    }
    seenDraftIds.add(validDraft.draftId)
    seenFinalizationIds.add(validDraft.finalizationId)
  }
  return candidate
}

function requireImportGlobalFactsReceipt(
  candidate: ImportGlobalFactsReceipt | undefined,
  operationId: string,
  expectedCharacterCount: number,
): ImportGlobalFactsReceipt {
  if (
    !candidate
    || candidate.operationId !== operationId
    || !SHA256_HEX.test(candidate.payloadHash)
    || typeof candidate.idempotent !== 'boolean'
    || !candidate.core
    || !candidate.roster?.snapshot
    || candidate.roster.snapshot.status !== 'ready'
    || candidate.roster.snapshot.entries.length !== expectedCharacterCount
  ) throw new Error('导入全局事实提交收据无效或覆盖不完整')
  return candidate
}

export class ImportBlueprintPostCommitSyncError extends Error {
  readonly retryOperationId: string

  constructor(readonly commitReceipt: BlueprintRangeCommitReceipt) {
    super(
      `导入蓝图已提交（第 ${commitReceipt.startChapter}–${commitReceipt.endChapter} 章），`
      + '但角色候选同步失败；可使用同步操作回执安全重试，无需重新生成蓝图。',
    )
    this.name = 'ImportBlueprintPostCommitSyncError'
    this.retryOperationId = commitReceipt.characterSyncOperation.operationId
  }
}

// =================================================================
// 1. 初始化：写入正文 + 构建知识库
// =================================================================

export class ImportInitializeCommand extends BaseWorkflowCommand<void> {
  constructor(private chapters: ImportedChapter[]) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error('当前项目已切换，导入已停止')

    callbacks.log(`开始作为定稿导入 ${this.chapters.length} 章正文到数据库...`)
    callbacks.setProgress(5)

    // 1. 正文、finalized 状态与发布 outbox 由主进程在一个 SQLite transaction
    // 中提交。渲染进程只接受覆盖全部章节的权威回读收据，不能逐章伪造成功。
    this.assertNotCancelled(context)
    const operationId = `novel-import-finalized-${context.runId}`
    const result = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-import-finalized-batch',
      {
        operationId,
        chapters: this.chapters.map(chapter => ({
          chapterNumber: chapter.number,
          title: chapter.title,
          content: chapter.content,
          wordCount: chapter.wordCount,
        })),
      },
      context.projectPath,
    )
    if (!result.success) throw new Error(result.error || '批量定稿导入失败')
    const importReceipt = requireFinalizedDraftImportReceipt(
      result.receipt,
      operationId,
      this.chapters.map(chapter => chapter.number),
    )
    context.data.finalizedDraftImportReceipt = importReceipt
    callbacks.log(
      `全部 ${this.chapters.length} 章的数据库定稿事实已提交；`
      + `${importReceipt.drafts.length} 个实体稿发布记录已进入待发布队列`,
    )
    callbacks.setProgress(45)

    // 2. 逐章导入知识库（向量化）
    callbacks.log('开始构建向量知识库...')
    let successCount = 0
    let failCount = 0
    for (let i = 0; i < this.chapters.length; i++) {
      this.assertNotCancelled(context)
      const ch = this.chapters[i]
      try {
        const fileName = ch.title
          ? `第${ch.number}章 ${ch.title}.txt`
          : `chapter_${ch.number}.txt`
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'kb:import-text',
          ch.content,
          fileName,
          context.projectPath,
        ) as { success: boolean; error?: string }
        if (result.success) {
          successCount++
        } else {
          callbacks.log(`导入 ${fileName} 失败: ${result.error}`)
          failCount++
        }
      } catch {
        failCount++
      }
      if (i % 10 === 0) {
        callbacks.setProgress(45 + Math.round((i / this.chapters.length) * 45))
      }
    }
    callbacks.log(`知识库构建完成（成功 ${successCount} 章，失败 ${failCount} 章）`)
    if (failCount > 0) {
      callbacks.log('数据库定稿事实不受知识库失败影响；可依据导入收据重试待完成步骤。')
    }
    callbacks.setProgress(90)

    // 将章节数据存入 context 供后续步骤使用
    this.assertNotCancelled(context)
    context.data.chapters = this.chapters
    context.data.totalChapters = this.chapters.length

    // 刷新文件树
    await useProjectStore.getState().refreshFileTree(context.projectPath, undefined, projectSession)
  }
}

// =================================================================
// 2. 向量采样 + AI 推演全局配置/架构/角色
// =================================================================

export class InferGlobalSettingsCommand extends BaseWorkflowCommand<void> {
  constructor(generationDependencies?: WorkflowGenerationRuntimeDependencies) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<void> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error('当前项目已切换，导入推演已停止')
    const projectSnapshot = Object.freeze({ ...project, novelConfig: Object.freeze({ ...project.novelConfig }) })

    const chapters = context.data.chapters as ImportedChapter[]
    if (!chapters || chapters.length === 0) throw new Error('无章节数据')

    callbacks.log('通过向量知识库检索关键片段...')
    callbacks.setProgress(5)

    // ===== 向量检索采样 =====
    const searchTopics = [
      { key: 'worldview', query: '世界观 力量体系 修炼等级 境界', label: '世界观与力量体系' },
      { key: 'protagonist', query: '主角 金手指 核心能力 天赋 系统', label: '主角设定与金手指' },
      { key: 'conflict', query: '敌人 反派 阴谋 危机 矛盾 对手', label: '核心矛盾与敌对势力' },
      { key: 'style', query: '视角 叙述 描写 风格 节奏', label: '写作风格与叙事视角' },
    ]

    const sampledContent: Record<string, string> = {}
    for (const topic of searchTopics) {
      this.assertNotCancelled(context)
      try {
        const results = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(
          projectSession,
          'kb:search',
          topic.query,
          5,
          context.projectPath,
        ))
        this.assertNotCancelled(context)
        if (results.length > 0) {
          sampledContent[topic.key] = results
            .map((r: { text: string; score: number; fileName: string }, i: number) =>
              `[${i + 1}] (${r.fileName}, 相关度 ${(r.score * 100).toFixed(0)}%)\n${r.text}`
            ).join('\n\n')
        } else {
          sampledContent[topic.key] = '（未检索到相关内容）'
        }
        callbacks.log(`  已检索「${topic.label}」— ${results.length} 条结果`)
      } catch {
        sampledContent[topic.key] = '（向量检索不可用）'
        callbacks.log(`  「${topic.label}」检索失败，将使用降级策略`)
      }
    }
    callbacks.setProgress(20)

    // ===== 构建 Prompt =====
    // 优先使用向量增强版 Prompt
    const template = await resolvePromptTemplate('infer_novel_config_with_vectors', projectSession)
      || await resolvePromptTemplate('infer_novel_config', projectSession)
    if (!template) throw new Error('未找到推演 Prompt 模板')

    const firstChapter = chapters[0]?.content?.slice(0, 3000) || '（第一章内容不可用）'
    const latestChapter = chapters[chapters.length - 1]?.content?.slice(0, 3000) || '（最新章节不可用）'

    const prompt = new ImportPromptBuilder(template)
      .withSampledWorldview(sampledContent.worldview || '')
      .withSampledProtagonist(sampledContent.protagonist || '')
      .withSampledConflict(sampledContent.conflict || '')
      .withSampledStyle(sampledContent.style || '')
      .withFirstChapter(firstChapter)
      .withLatestChapter(latestChapter)
      .withTotalChapters(chapters.length)
      // 兼容旧版 Prompt 的 sample_content 变量
      .withSampleContent(`【第1章片段】\n${firstChapter}\n\n【最新章节片段】\n${latestChapter}`)
      .build()
      + `\n\n${IMPORT_INFERENCE_JSON_CONTRACT}`

    callbacks.log('正在调用 AI 推演全局小说配置...')
    callbacks.setProgress(25)

    const initial = await this.callLLMResult(
      prompt,
      template.systemRole || '你是一位顶级网文主编和资深阅读分析师。',
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'import-inference',
        reasoningStage: 'planning',
      },
      context,
    )
    if (initial.finishReason !== 'stop') throw this.createIncompleteCompletionError(initial.finishReason)
    let rawResult = initial.content
    if (isRepairableDirectJsonSyntaxFailure(rawResult)) {
      if (
        structuredRepairUtf8Bytes(IMPORT_INFERENCE_JSON_CONTRACT) > MAX_STRUCTURED_REPAIR_CONTRACT_UTF8_BYTES
        || structuredRepairUtf8Bytes(rawResult) > MAX_STRUCTURED_REPAIR_CANDIDATE_UTF8_BYTES
      ) throw new Error('导入推演 JSON 语法修复证据超过安全字节上限')
      callbacks.log('导入推演 JSON 存在词法错误，正在执行唯一一次完整替代语法修复...')
      const repairTask = buildStructuredSyntaxRepairTask({
        purpose: 'import-inference',
        output: 'structured-data',
        messages: [],
      }, IMPORT_INFERENCE_JSON_CONTRACT, rawResult)
      const repair = await this.callLLMResult(
        repairTask.messages[1].content,
        repairTask.messages[0].content,
        callbacks,
        {
          responseFormat: { type: 'json_object' },
          purpose: repairTask.purpose,
          reasoningStage: 'planning',
        },
        context,
      )
      if (repair.finishReason !== 'stop') throw this.createIncompleteCompletionError(repair.finishReason)
      if (!preservesStructuredJsonEvidence(rawResult, repair.content)) {
        throw new Error('导入推演 JSON 语法修复改变了候选事实，已拒绝写入')
      }
      rawResult = repair.content
    }
    this.assertNotCancelled(context)

    callbacks.setProgress(70)
    callbacks.log('正在解析 AI 返回结果并写入项目...')

    // ===== 解析 JSON 结果 =====
    const inferResult = decodeImportInferenceJson(rawResult)

    const roster = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      context.projectPath,
    )
    if (roster.status !== 'ready' && roster.status !== 'empty') {
      throw new Error('角色名单当前不可安全导入；请先完成旧项目修复或处理数据不一致状态')
    }

    const novelConfig = {
      ...projectSnapshot.novelConfig,
      ...inferResult.novelConfig,
      totalChapters: chapters.length,
      wordsPerChapter: Math.round(chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0) / chapters.length),
    }
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error('当前项目已切换，导入配置结果未应用')
    this.assertNotCancelled(context)

    const operationId = `novel-import-global-${context.runId}`
    const commitResult = await ipc.invokeWithProjectSession(
      projectSession,
      'db:import-global-facts-commit',
      {
        operationId,
        expectedRosterRevision: roster.revision,
        core: {
          genre: novelConfig.genre,
          subGenre: novelConfig.subGenre,
          targetAudience: novelConfig.targetAudience,
          totalChapters: novelConfig.totalChapters,
          wordsPerChapter: novelConfig.wordsPerChapter,
          plotStructure: novelConfig.plotStructure,
          narrativePov: novelConfig.narrativePOV,
          goldenFinger: novelConfig.goldenFinger,
          globalGuidance: novelConfig.globalGuidance,
          coreOutline: novelConfig.coreOutline,
          worldSetting: novelConfig.worldSetting,
          protagonistProfile: novelConfig.protagonistProfile,
          premise: inferResult.architectureFiles.premise,
          worldbuilding: inferResult.architectureFiles.worldbuilding,
          synopsis: inferResult.architectureFiles.synopsis,
        },
        characterEntries: inferResult.characterCards,
      },
      context.projectPath,
    )
    if (!commitResult.success) throw new Error(commitResult.error || '导入全局事实原子提交失败')
    const commitReceipt = requireImportGlobalFactsReceipt(
      commitResult.receipt,
      operationId,
      inferResult.characterCards.length,
    )
    context.data.importGlobalFactsReceipt = commitReceipt

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error('当前项目已切换，导入配置结果未应用')
    const authoritativeNovelConfig = {
      ...projectSnapshot.novelConfig,
      genre: commitReceipt.core.genre,
      subGenre: commitReceipt.core.subGenre,
      targetAudience: commitReceipt.core.targetAudience,
      totalChapters: commitReceipt.core.totalChapters,
      wordsPerChapter: commitReceipt.core.wordsPerChapter,
      plotStructure: commitReceipt.core.plotStructure,
      narrativePOV: commitReceipt.core.narrativePov,
      goldenFinger: commitReceipt.core.goldenFinger,
      globalGuidance: commitReceipt.core.globalGuidance,
      coreOutline: commitReceipt.core.coreOutline,
      worldSetting: commitReceipt.core.worldSetting,
      protagonistProfile: commitReceipt.core.protagonistProfile,
    }
    useProjectStore.setState({ currentProject: { ...projectSnapshot, novelConfig: authoritativeNovelConfig } })
    context.data.novelConfigSummary = `类型: ${authoritativeNovelConfig.genre || '未知'} | 子类型: ${authoritativeNovelConfig.subGenre || '未知'} | 受众: ${authoritativeNovelConfig.targetAudience || '未知'}\n大纲: ${authoritativeNovelConfig.coreOutline || '（无）'}\n世界观: ${authoritativeNovelConfig.worldSetting || '（无）'}\n金手指: ${authoritativeNovelConfig.goldenFinger || '（无）'}\n主角: ${authoritativeNovelConfig.protagonistProfile || '（无）'}`
    callbacks.log(`小说配置、非角色架构与 ${commitReceipt.roster.snapshot.entries.length} 张角色卡已原子提交`)

    callbacks.setProgress(90)
    this.notifyRefresh(['fileTree', 'characterCards'], context.projectPath, requireWorkflowProjectSession(context))
  }
}


// =================================================================
// 3. 按章逐一推演精准蓝图（限流并发）
// =================================================================

export class InferBlueprintsPerChapterCommand extends BaseWorkflowCommand<void> {
  private static readonly MAX_CHAPTERS_PER_OPERATION = 50
  private static readonly MAX_ITEMS_PER_BATCH = 5

  constructor(generationDependencies?: WorkflowGenerationRuntimeDependencies) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<void> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error('当前项目已切换，蓝图推演已停止')

    const chapters = context.data.chapters as ImportedChapter[]
    const configSummary = (context.data.novelConfigSummary as string) || '（配置概要不可用）'
    if (!chapters || chapters.length === 0) throw new Error('无章节数据')

    const template = await resolvePromptTemplate('infer_single_chapter_blueprint', projectSession)
    if (!template) throw new Error('未找到单章蓝图推演 Prompt 模板')

    if (chapters.length > InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION) {
      throw new Error(
        `本次导入需推演 ${chapters.length} 章蓝图，超过单次 ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} 章的安全成本上限；`
        + `请按连续章节分段，每段不超过 ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} 章。`,
      )
    }
    const orderedChapters = [...chapters].sort((left, right) => left.number - right.number)
    const startChapter = orderedChapters[0]?.number
    const endChapter = orderedChapters.at(-1)?.number
    if (
      startChapter === undefined
      || endChapter === undefined
      || orderedChapters.some((chapter, index) => chapter.number !== startChapter + index)
    ) {
      throw new Error('导入蓝图只能按连续章节范围生成；请先补齐缺失章节或拆分为连续范围。')
    }

    callbacks.log(
      `开始分批推演蓝图（共 ${chapters.length} 章，预计至多 ${Math.ceil(chapters.length / InferBlueprintsPerChapterCommand.MAX_ITEMS_PER_BATCH)} 次调用）...`,
    )
    callbacks.setProgress(5)

    let activeChapterNumbers: number[] = []
    const contract: StructuredBatchContract<ImportedChapter, ChapterBlueprint> = {
      buildTask: ({ items, validatedPrefix }) => {
        activeChapterNumbers = items.map(item => item.number)
        const source = items.map(chapter => (
          `【第${chapter.number}章 ${chapter.title || '无标题'}】\n${chapter.content.slice(0, 6000)}`
        )).join('\n\n')
        const prior = validatedPrefix.slice(-10)
          .map(item => `第${item.chapterNumber}章 ${item.title}：${item.keyEvents}`)
          .join('\n') || '（无）'
        const prompt = new ImportPromptBuilder(template)
          .withChapterContent(source)
          .withChapterNumber(items[0]?.number ?? 1)
          .withChapterTitle(items.map(item => item.title).filter(Boolean).join('、'))
          .withNovelConfigSummary(`${configSummary}\n\n【已验证前缀】\n${prior}`)
          .build()
          + '\n\n【最终不可变输出合同】\n'
          + '本合同取代上述模板中的任何旧 JSON 示例或字段名，不得沿用缺少字段的旧示例。\n'
          + `${blueprintSemanticGenerationContract()}\n`
          + `本批必须且只能完整返回以下 chapterNumber：${activeChapterNumbers.join('、')}。`
        callbacks.log(`  正在推演第 ${activeChapterNumbers[0]}–${activeChapterNumbers.at(-1)} 章...`)
        callbacks.setProgress(5 + Math.round((validatedPrefix.length / orderedChapters.length) * 80))
        return {
          purpose: 'import-chapter-blueprints',
          output: 'structured-data',
          messages: [
            { role: 'system', content: template.systemRole || '你是一位专业的网文结构分析师。' },
            { role: 'user', content: prompt },
          ],
        }
      },
      inputKey: chapter => chapter.number,
      outputKey: blueprint => blueprint.chapterNumber,
      decode: content => parseBlueprintSemanticResponseText(content, activeChapterNumbers)
        .map(blueprint => ({
          ...blueprint,
          userGuidance: '',
          notes: '',
          notesUpdatedAt: '',
        })),
      validateItem: validateBlueprintSemanticItem,
    }

    const execution = this.requireGenerationExecution()
    const batch = await createStructuredBatchExecutor({
      contract,
      session: execution.session,
    }).execute({
      items: orderedChapters,
      limits: { maxBatchItems: InferBlueprintsPerChapterCommand.MAX_ITEMS_PER_BATCH },
      signal: execution.signal,
    })
    if (!batch.ok) throw new Error(batch.failure.message)

    this.assertNotCancelled(context)
    const commit = await ipc.invokeWithProjectSession(
      projectSession,
      'db:blueprint-commit-range',
      {
        mode: 'replace-range',
        operationId: `import-blueprints-${context.runId}-${startChapter}-${endChapter}`,
        startChapter,
        endChapter,
        blueprints: [...batch.items],
      },
      context.projectPath,
    )
    if (!commit.success || !commit.receipt || commit.receipt.snapshot.length !== orderedChapters.length) {
      throw new Error(commit.error || '导入蓝图未能作为完整范围一次提交并回读。')
    }

    const commitReceipt = commit.receipt
    context.data.blueprintCommitReceipt = commitReceipt
    try {
      const syncReceipt = await retryDirectoryCharacterSync(
        commitReceipt.characterSyncOperation.operationId,
        context.projectPath,
        projectSession,
      )
      context.data.blueprintCharacterSyncReceipt = syncReceipt
    } catch {
      throw new ImportBlueprintPostCommitSyncError(commitReceipt)
    }

    callbacks.log(`蓝图推演完成：${commitReceipt.snapshot.length} 章已一次提交`)
    callbacks.setProgress(100)
    this.notifyRefresh(['fileTree', 'blueprints'], context.projectPath, projectSession)
  }
}
