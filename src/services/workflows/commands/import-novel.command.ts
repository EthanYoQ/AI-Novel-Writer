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
import { requireIpcSuccess } from '../../ipc-result'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { normalizeCharacterCardsForPersistence } from '../character-card-normalizer'
import { characterRosterEntriesFromCards } from '../../character-roster-client'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { requireWorkflowProjectSession } from '../workflow-project-session'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import type { ChapterBlueprint } from '../directory-workflow'
import { retryDirectoryCharacterSync } from '../directory-character-sync-recovery'
import type { BlueprintRangeCommitReceipt } from '../../../../electron/repositories/blueprint-repository'
import {
  parseBlueprintSemanticResponseText,
  validateBlueprintSemanticItem,
} from '../../../shared/blueprint-semantic-contract'

/** 拆分后的章节数据（从 context.data 中传递） */
export interface ImportedChapter {
  number: number
  title: string
  content: string
  wordCount: number
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

    // 1. 批量创建草稿并标记为 finalized
    for (let i = 0; i < this.chapters.length; i++) {
      this.assertNotCancelled(context)
      const ch = this.chapters[i]

      // 直接调用 DB 写库（来源设为 write）
      const result = await ipc.invokeWithProjectSession(projectSession, 'db:draft-create', {
        chapterNumber: ch.number,
        version: 1,
        content: ch.content,
        wordCount: ch.wordCount,
        source: 'write'
      }, context.projectPath)
      if (!result.success) throw new Error(result.error || `第 ${ch.number} 章导入失败`)

      if (i % 10 === 0) {
        callbacks.setProgress(5 + Math.round((i / this.chapters.length) * 40))
        callbacks.log(`  已导入第 ${ch.number} 章（${ch.wordCount} 字）`)
      }
    }
    callbacks.log(`全部 ${this.chapters.length} 章已作为定稿导入数据库`)
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

    callbacks.log('正在调用 AI 推演全局小说配置...')
    callbacks.setProgress(25)

    const rawResult = await this.callLLM(
      prompt,
      template.systemRole || '你是一位顶级网文主编和资深阅读分析师。',
      callbacks,
      { responseFormat: { type: 'json_object' } },
      context,
    )
    this.assertNotCancelled(context)

    callbacks.setProgress(70)
    callbacks.log('正在解析 AI 返回结果并写入项目...')

    // ===== 解析 JSON 结果 =====
    const inferResult = this.parseJSON<{
      novelConfig: Record<string, string>
      architectureFiles: Record<string, string>
      characterCards: Array<Record<string, unknown>>
    }>(rawResult)

    // ===== 写入小说配置 =====
    if (inferResult.novelConfig) {
      const novelConfig = {
        ...projectSnapshot.novelConfig,
        ...inferResult.novelConfig,
        totalChapters: chapters.length,
        wordsPerChapter: Math.round(chapters.reduce((s, c) => s + c.wordCount, 0) / chapters.length),
      }
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) {
        throw new Error('当前项目已切换，导入配置结果未应用')
      }
      this.assertNotCancelled(context)
      const updatedProject = { ...projectSnapshot, novelConfig }
      const plainData = {
        id: updatedProject.id,
        name: updatedProject.name,
        path: updatedProject.path,
        novelConfig: { ...updatedProject.novelConfig },
        characterStates: updatedProject.characterStates,
        createdAt: updatedProject.createdAt,
        updatedAt: updatedProject.updatedAt,
      }
      const saveResult = await ipc.invokeWithProjectSession(
        projectSession,
        'project:save',
        plainData.id,
        plainData,
        context.projectPath,
      )
      requireIpcSuccess(saveResult, '保存推演后的小说配置')
      this.assertNotCancelled(context)
      if (!sameProjectSessionContext(
        projectSession,
        projectSessionContextFromProject(useProjectStore.getState().currentProject),
      )) {
        throw new Error('当前项目已切换，导入配置结果未应用')
      }
      useProjectStore.setState({ currentProject: updatedProject })
      callbacks.log('小说配置已更新')

      // 生成配置摘要供后续步骤使用
      context.data.novelConfigSummary = `类型: ${novelConfig.genre || '未知'} | 子类型: ${novelConfig.subGenre || '未知'} | 受众: ${novelConfig.targetAudience || '未知'}\n大纲: ${novelConfig.coreOutline || '（无）'}\n世界观: ${novelConfig.worldSetting || '（无）'}\n金手指: ${novelConfig.goldenFinger || '（无）'}\n主角: ${novelConfig.protagonistProfile || '（无）'}`
    }

    // ===== 写入架构信息 =====
    if (inferResult.architectureFiles) {
      this.assertNotCancelled(context)
      const coreResult = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-update', {
        premise: inferResult.architectureFiles.premise,
        worldbuilding: inferResult.architectureFiles.worldbuilding,
        synopsis: inferResult.architectureFiles.synopsis,
      }, context.projectPath)
      if (!coreResult.success) throw new Error(coreResult.error || '故事架构写入失败')
      callbacks.log('非角色架构已持久化到数据库；角色图谱将由结构化角色名单生成')
    }

    // ===== 写入角色卡 =====
    if (inferResult.characterCards && Array.isArray(inferResult.characterCards)) {
      const cardsToSave = normalizeCharacterCardsForPersistence(inferResult.characterCards)
      if (cardsToSave.length > 0) {
        this.assertNotCancelled(context)
        const rosterEntries = characterRosterEntriesFromCards(cardsToSave)
        if (rosterEntries.some(entry => entry.legacyRelationshipNotes)) {
          throw new Error('导入角色卡包含无法验证的自由文本关系；请让模型输出包含目标角色和关系类型的结构化 relationships')
        }
        const roster = await ipc.invokeWithProjectSession(
          projectSession,
          'db:character-roster-read',
          context.projectPath,
        )
        if (roster.status !== 'ready' && roster.status !== 'empty') {
          throw new Error('角色名单当前不可安全导入；请先完成旧项目修复或处理数据不一致状态')
        }
        this.assertNotCancelled(context)
        const saveResult = await ipc.invokeWithProjectSession(
          projectSession,
          'db:character-roster-commit',
          {
            operationId: `novel-import-characters-${context.runId}`,
            expectedRevision: roster.revision,
            schemaVersion: 1,
            intent: 'novel_import',
            entries: rosterEntries,
          },
          context.projectPath,
        )
        if (!saveResult.success || !saveResult.receipt) {
          throw new Error(saveResult.error || '角色卡写入数据库失败')
        }
      }
      callbacks.log(`已生成 ${cardsToSave.length} 张角色卡`)
    }

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
          + `\n\n【结构化批次合同】\n只输出 JSON 对象 {"blueprints":[...]}。必须恰好覆盖章节号：${activeChapterNumbers.join('、')}；`
          + '每项包含 chapterNumber、title、role、purpose、keyEvents、characters、relationshipHints（无关系时为空数组）、suspenseHook。不得缺项、重复或输出范围外章节。'
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
