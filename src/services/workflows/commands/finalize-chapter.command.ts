import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { PostProcessPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { commitFinalizationSnapshot } from '../../finalization-client'
import type { FinalizationSnapshot } from '../../finalization-snapshot'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../../shared/project-session-context'

import {
  runPostProcessPipeline,
  getChapterFinalizeScope,
  type PostProcessStep,
  type PostProcessStatus,
} from '../workflow-utils'
import type { ChapterInfo } from '../chapter-workflow'
import type {
  FinalizedContinuityFact,
  FinalizedContinuityFactCategory,
} from '../../../shared/finalized-continuity'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import { requireWorkflowProjectSession, workflowWritingLanguage } from '../workflow-project-session'
import type { CharacterRosterEntry, CharacterRosterRole } from '../../../shared/character-roster'
import { writingLanguageText } from '../../../shared/writing-language'

export interface FinalizeChapterParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  chapterInfo: ChapterInfo
  /** 批量任务中任一后处理失败即停止，不再继续后续章节 */
  stopOnPostProcessFailure?: boolean
  /** 标记定稿来源，避免批量任务触发单章的自动打开下一章对话框 */
  eventSource?: 'manual' | 'batch'
  /** 手动定稿由 DraftEditor 在确认时冻结；batch 则在 workflow session 内构造同等快照。 */
  snapshot?: FinalizationSnapshot
}

export interface FinalizePostProcessGeneration {
  complete(
    builder: { build: () => string; getSystemRole: () => string },
    callbacks: StepCallbacks,
    output: 'visible-text' | 'structured-data',
    context: WorkflowContext,
  ): Promise<string>
}

/** 容错 JSON 解析（剥离 Markdown 代码块 + 自动截取有效 JSON 边界） */
function parseJSON<T>(text: string): T {
  let cleanText = text.replace(/```json?\n?/gi, '').replace(/```\n?/gi, '').trim()
  const firstBrace = cleanText.indexOf('{')
  const lastBrace = cleanText.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleanText = cleanText.substring(firstBrace, lastBrace + 1)
  }
  return JSON.parse(cleanText) as T
}

const CONTINUITY_FACT_LIMIT = 12
const CONTINUITY_STATEMENT_LIMIT = 280
const CONTINUITY_EVIDENCE_LIMIT = 240

function factCategory(statement: string): FinalizedContinuityFactCategory {
  if (/(?:角色|状态|持有|受伤|位于|死亡|身亡|牺牲|去世|character|holds?|injur|location|dead|died|deceased)/iu.test(statement)) return 'character-state'
  if (/(?:时间|当日|翌日|多年|之前|之后|timeline|before|after|years?)/iu.test(statement)) return 'timeline'
  if (/(?:伏笔|悬念|承诺|未解|线索|promise|unresolved|clue|mystery)/iu.test(statement)) return 'open-thread'
  return 'plot'
}

function textBigrams(value: string): Set<string> {
  const groups = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(groups.flatMap((group) => {
    const characters = [...group]
    return characters.length < 2
      ? characters
      : characters.slice(0, -1).map((character, index) => character + characters[index + 1])
  }))
}

function evidenceExcerpt(content: string, statement: string, entities: readonly string[]): string {
  const sentences = content
    .split(/(?<=[。！？.!?])|\n+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
  const factEntities = entities.filter(entity => statement.includes(entity))
  const statementWithoutEntities = [...factEntities]
    .sort((left, right) => right.length - left.length)
    .reduce((text, entity) => text.split(entity).join(' '), statement)
  const signals = textBigrams(statementWithoutEntities)
  const signalList = [...signals]
  const candidates = factEntities.length > 0
    ? sentences.filter(sentence => factEntities.some(entity => sentence.includes(entity)))
    : sentences
  const ranked = candidates
    .map((sentence) => {
      const sentenceSignals = textBigrams(sentence)
      const matchedIndexes = signalList
        .map((signal, index) => sentenceSignals.has(signal) ? index : -1)
        .filter(index => index >= 0)
      const independentlySupported = matchedIndexes.some((index, matchIndex) => (
        matchIndex > 0 && index - matchedIndexes[matchIndex - 1] > 1
      ))
      return {
        sentence,
        score: matchedIndexes.length,
        supported: matchedIndexes.length === signalList.length || independentlySupported,
      }
    })
    .sort((left, right) => right.score - left.score)
  const minimumScore = factEntities.length > 0 ? 1 : 2
  const matched = ranked.find(candidate => candidate.score >= minimumScore && candidate.supported)?.sentence
  return (matched ?? '').slice(0, CONTINUITY_EVIDENCE_LIMIT).trim()
}

export function buildFinalizedContinuityFacts(
  chapterNumber: number,
  chapterNotes: string,
  finalizedContent: string,
  chapterEntities: readonly string[] = [],
): FinalizedContinuityFact[] {
  const entities = [...new Set(chapterEntities.map(entity => entity.trim()).filter(Boolean))].slice(0, 8)
  const statements = chapterNotes
    .split(/\n+|(?<=[。！？.!?])\s*/u)
    .map(statement => statement.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '').trim())
    .filter(Boolean)
    .slice(0, CONTINUITY_FACT_LIMIT)
  return statements.flatMap(statement => {
    const factEntities = entities.filter(entity => statement.includes(entity))
    const evidence = evidenceExcerpt(finalizedContent, statement, factEntities)
    return evidence
      ? [{
          category: factCategory(statement),
          entities: factEntities,
          statement: statement.slice(0, CONTINUITY_STATEMENT_LIMIT),
          sourceChapter: chapterNumber,
          evidence,
        }]
      : []
  })
}

// ===== 后处理步骤构建器 =====

/**
 * 构建章节定稿后处理步骤列表
 *
 * 每个步骤都是独立的 PostProcessStep，由 runPostProcessPipeline
 * 统一调度执行、持久化状态、支持单步重试。
 * 导出供 createRepairFinalizeWorkflow 复用。
 *
 * @param project       当前项目信息
 * @param chapterNumber 章节号
 * @param chapterTitle  章节标题
 * @param draftContent  定稿正文内容
 */
export function buildFinalizePostProcessSteps(
  _project: { path: string },
  chapterNumber: number,
  chapterTitle: string,
  draftContent: string,
  generation: FinalizePostProcessGeneration,
  finalizedDraftId?: number,
  chapterEntities: readonly string[] = [],
): PostProcessStep[] {
  const steps: PostProcessStep[] = []

  // ─── 步骤 1: 导入知识库 ───────────────────────────────────────────
  steps.push({
    key: 'kb_import',
    label: '导入知识库',
    critical: true,
    executor: async (callbacks, context) => {
      if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
      if (context.cancelled) throw new Error('工作流已取消')
      const projectSession = requireWorkflowProjectSession(context)
      const writingLanguage = workflowWritingLanguage(context)
      const contentFileName = chapterTitle
        ? writingLanguageText(
            writingLanguage,
            `第${chapterNumber}章 ${chapterTitle}.txt`,
            `Chapter ${chapterNumber} ${chapterTitle}.txt`,
          )
        : `chapter_${chapterNumber}.txt`
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'kb:import-text',
        draftContent,
        contentFileName,
        _project.path,
      ) as { success: boolean; error?: string; chunkCount?: number; docId?: string }
      requireIpcSuccess(result, '导入知识库')
      if (finalizedDraftId !== undefined) {
        if (!result.docId) throw new Error('知识库导入成功但缺少文档身份收据')
        const linked = await ipc.invokeWithProjectSession(
          projectSession,
          'db:finalization-link-knowledge-document',
          finalizedDraftId,
          result.docId,
          _project.path,
        )
        requireIpcSuccess(linked, '登记定稿知识文档身份')
      }
      callbacks.log(`正文章节已导入知识库（${result.chunkCount} 块）`)
    },
  })

  // ─── 步骤 2: 本章剧情要点提取 ─────────────────────────────────────
  steps.push({
      key: 'chapter_notes',
      label: '章节剧情要点',
      critical: true,
      executor: async (callbacks, context) => {
        if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
        if (context.cancelled) throw new Error('工作流已取消')
        const projectSession = requireWorkflowProjectSession(context)
        const writingLanguage = workflowWritingLanguage(context)
        const notesTemplate = await resolvePromptTemplate('generate_chapter_notes', projectSession, writingLanguage)
        if (!notesTemplate) throw new Error('未找到章节要点模板')
        const notesBuilder = new PostProcessPromptBuilder(notesTemplate, writingLanguage)
          .withChapterContent(draftContent)
          .withChapterNumber(chapterNumber)
          .withChapterTitle(chapterTitle)

        const cleanNotes = await generation.complete(notesBuilder, callbacks, 'visible-text', context)
        if (context?.cancelled) throw new Error('工作流已取消')

        if (finalizedDraftId !== undefined) {
          const facts = buildFinalizedContinuityFacts(
            chapterNumber,
            cleanNotes,
            draftContent,
            chapterEntities,
          )
          const continuityResult = await ipc.invokeWithProjectSession(
            projectSession,
            'db:continuity-save-finalized',
            {
              draftId: finalizedDraftId,
              chapterNumber,
              chapterNotes: cleanNotes,
              facts,
            },
            _project.path,
          )
          requireIpcSuccess(continuityResult, '保存定稿连续性事实')
          callbacks.log(`已投影连续性事实：${facts.length} 条`)
        }

        // 兼容已有蓝图项目；作者原稿无蓝图时，权威事实仍已由定稿投影保存。
        if (context?.cancelled) throw new Error('工作流已取消')
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'db:blueprint-update-notes',
          chapterNumber,
          cleanNotes,
          _project.path,
        )
        requireIpcSuccess(result, '写入章节剧情要点')
        callbacks.log(
          result.updated === false
            ? '本章剧情要点提取完成（已保存定稿连续性事实）'
            : '本章剧情要点提取完成（已写入蓝图）',
        )
      },
    })

  // ─── 步骤 3: 角色状态更新 ────────────────────────────────────────
  steps.push({
      key: 'character_cards',
      label: '角色状态更新',
      critical: false,
      executor: async (callbacks, context) => {
        if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
        if (context.cancelled) throw new Error('工作流已取消')
        const projectSession = requireWorkflowProjectSession(context)
        const writingLanguage = workflowWritingLanguage(context)
        const cardTemplate = await resolvePromptTemplate('update_character_cards', projectSession, writingLanguage)
        if (!cardTemplate) throw new Error('未找到角色状态模板')
        // 章节定稿只读取并提交结构化角色名单。状态、新角色、图谱投影和
        // revision 由同一个 roster receipt 结算，绝不逐张卡片部分成功。
        const roster = await ipc.invokeWithProjectSession(
          projectSession,
          'db:character-roster-read',
          _project.path,
        )
        if (roster.status !== 'ready' && roster.status !== 'empty') {
          throw new Error('角色名单当前不可安全更新；请先完成旧项目修复或处理数据不一致状态')
        }
        const allChars = roster.entries
        if (context?.cancelled) throw new Error('工作流已取消')
        const simpleCards = allChars.map((c) => ({ name: c.name, role: c.role }))

        const cardBuilder = new PostProcessPromptBuilder(cardTemplate, writingLanguage)
          .withChapterContent(draftContent.slice(0, 5000))
          .withChapterNumber(chapterNumber)
          .withExistingCardsJson(simpleCards)

        const cardsResult = await generation.complete(
          cardBuilder,
          callbacks,
          'structured-data',
          context,
        )
        if (context?.cancelled) throw new Error('工作流已取消')
        type LLMUpdateState = {
          location?: string
          powerLevel?: string
          physicalState?: string
          mentalState?: string
          keyItems?: string
          recentEvents?: string
        }

        const cardUpdates = parseJSON<{
          updates?: Array<{ name: string; currentState: LLMUpdateState }>
          newCharacters?: Array<{ name: string; role: string; currentState: LLMUpdateState }>
        }>(cardsResult)

        const updatesByName = new Map(
          Array.isArray(cardUpdates.updates)
            ? cardUpdates.updates
                .filter(update => typeof update.name === 'string' && update.name.trim() && update.currentState)
                .map(update => [update.name.trim(), update.currentState])
            : [],
        )
        let updatedCount = 0
        const changedEntries: CharacterRosterEntry[] = []
        for (const character of allChars) {
          const patch = updatesByName.get(character.name)
          if (!patch) continue
          updatedCount += 1
          const currentState = character.currentState
          const structuredCharacter = { ...character }
          delete structuredCharacter.legacyRelationshipNotes
          changedEntries.push({
            ...structuredCharacter,
            currentState: {
              location: patch.location || currentState?.location || '',
              powerLevel: patch.powerLevel || currentState?.powerLevel || '',
              physicalState: patch.physicalState || currentState?.physicalState || '',
              mentalState: patch.mentalState || currentState?.mentalState || '',
              keyItems: patch.keyItems || currentState?.keyItems || '',
              recentEvents: patch.recentEvents || currentState?.recentEvents || '',
              updatedAtChapter: chapterNumber,
            },
          })
        }

        let newCharCount = 0
        const existingNames = new Set(allChars.map(character => character.name))
        if (Array.isArray(cardUpdates.newCharacters)) {
          for (const newChar of cardUpdates.newCharacters) {
            if (context?.cancelled) throw new Error('工作流已取消')
            if (typeof newChar.name !== 'string' || !newChar.name.trim()) continue
            const name = newChar.name.trim()
            if (existingNames.has(name)) continue
            const cs = newChar.currentState || {}
            const role: CharacterRosterRole = (
              newChar.role === 'protagonist'
              || newChar.role === 'antagonist'
              || newChar.role === 'supporting'
              || newChar.role === 'minor'
            ) ? newChar.role : 'supporting'
            changedEntries.push({
              name,
              role,
              gender: '', age: '', appearance: '', personality: '', background: '',
              abilities: '', motivation: '', relationships: [], arc: '', notes: '',
              currentState: {
                location: cs.location || '',
                powerLevel: cs.powerLevel || '',
                physicalState: cs.physicalState || '',
                mentalState: cs.mentalState || '',
                keyItems: cs.keyItems || '',
                recentEvents: cs.recentEvents || '',
                updatedAtChapter: chapterNumber,
              },
            })
            existingNames.add(name)
            newCharCount += 1
          }
        }

        if (updatedCount > 0 || newCharCount > 0) {
          if (context?.cancelled) throw new Error('工作流已取消')
          const result = await ipc.invokeWithProjectSession(
            projectSession,
            'db:character-roster-commit',
            {
              operationId: `chapter-progress-${context.runId}-${chapterNumber}`,
              expectedRevision: roster.revision,
              schemaVersion: 1,
              intent: 'chapter_progress',
              // incremental intent only carries changed state/new cards. It
              // never echoes untouched legacy free-text relationship notes.
              entries: changedEntries,
            },
            _project.path,
          )
          if (!result.success || !result.receipt) {
            throw new Error(result.error || '角色状态与新角色登记未能原子提交')
          }
          if (updatedCount > 0) callbacks.log(`更新角色动态状态: ${updatedCount} 名`)
          if (newCharCount > 0) callbacks.log(`自动提取并登记 ${newCharCount} 名新出场角色`)
        }
      },
    })

  // ─── 步骤 4: 文风自动学习（每5章触发一次）─────────────────────────
  if (chapterNumber % 5 === 0) {
    steps.push({
      key: 'style_analysis',
      label: '文风自动学习',
      critical: false,
      executor: async (callbacks, context) => {
        if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
        if (context.cancelled) throw new Error('工作流已取消')
        callbacks.log('触发文风自动学习（每5章一次）...')
        const { AnalyzeWritingStyleCommand } = await import('./analyze-style.command')
        await new AnalyzeWritingStyleCommand().execute({
          step: {} as unknown,
          context,
          callbacks,
        })
        callbacks.log('文风分析完成，已更新配置')
      },
    })
  }

  return steps
}

export interface RunFinalizePostProcessParams {
  project: { path: string }
  chapterNumber: number
  chapterTitle: string
  draftContent: string
  draftId: number
  sourceLabel: string
  stopOnFailure?: boolean
  onlyFailed?: boolean
  chapterEntities?: readonly string[]
}

/** One post-process run freezes one model and one budget across notes/cards. */
export class RunFinalizePostProcessCommand extends BaseWorkflowCommand<PostProcessStatus> {
  constructor(private readonly params: RunFinalizePostProcessParams) {
    super()
  }

  async execute(params: CommandExecuteParams): Promise<PostProcessStatus> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<PostProcessStatus> {
    const projectSession = requireWorkflowProjectSession(context)
    const generation: FinalizePostProcessGeneration = {
      complete: async (builder, stepCallbacks, output, generationContext) => this.callLLM(
        builder.build(),
        builder.getSystemRole(),
        stepCallbacks,
        {
          ...(output === 'structured-data' ? { responseFormat: { type: 'json_object' } } : {}),
          purpose: 'post-process',
          reasoningStage: 'review',
        },
        generationContext,
      ),
    }
    const steps = buildFinalizePostProcessSteps(
      this.params.project,
      this.params.chapterNumber,
      this.params.chapterTitle,
      this.params.draftContent,
      generation,
      this.params.draftId,
      this.params.chapterEntities,
    )
    return runPostProcessPipeline(
      this.params.project.path,
      getChapterFinalizeScope(this.params.chapterNumber),
      this.params.sourceLabel,
      steps,
      callbacks,
      {
        stopOnFailure: this.params.stopOnFailure,
        onlyFailed: this.params.onlyFailed,
        cancellation: context,
        projectSession,
      },
    )
  }
}

// ===== 定稿命令 =====

export class FinalizeChapterCommand extends BaseWorkflowCommand<void> {
  constructor(private params: FinalizeChapterParams) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) {
      throw new Error('项目已切换，已停止对原项目的定稿操作')
    }

    callbacks.log('\n===== 开始定稿与后处理分析 =====')

    const snapshot = this.params.snapshot ?? await this.createBatchSnapshot(context, project.path)
    if (snapshot.projectPath !== project.path) {
      throw new Error('定稿快照属于已切换的项目会话')
    }
    const refinedDraftText = snapshot.content
    if (!refinedDraftText) throw new Error('没有定稿内容')

    // SQLite 正文、状态和 publication outbox 由主进程在一个事务内提交。这里绝不
    // 再读取旧数据库正文，也不以 renderer 路径写实体稿。
    this.assertNotCancelled(context)
    const commit = await commitFinalizationSnapshot(snapshot)
    if (!commit.committed || !commit.finalizationId || !commit.contentHash || commit.draftId === undefined) {
      throw new Error(commit.error || '定稿事务未提交')
    }

    // 事实已提交就立即通知 reconciliation；即使实体稿或后处理随后失败，也绝不
    // 将数据库定稿回滚为 draft，更不能让旧完成结果覆盖后续编辑。
    const { globalEventBus } = await import('../../../shared/event-bus')
    globalEventBus.emit('FINALIZE_COMPLETE', {
      tabId: snapshot.tabId,
      chapterNumber: snapshot.chapterNumber,
      chapterTitle: snapshot.chapterTitle,
      projectPath: snapshot.projectPath,
      projectSession: snapshot.projectSession,
      draftId: commit.draftId,
      finalizationId: commit.finalizationId,
      contentHash: commit.contentHash,
      contentRevision: commit.contentRevision ?? snapshot.contentRevision,
      snapshotContent: snapshot.content,
      publicationStatus: commit.publicationStatus ?? 'pending',
      source: this.params.eventSource ?? 'manual',
    })
    if (!commit.success) {
      callbacks.log(commit.error || '定稿已提交、实体稿待发布')
      throw new Error(commit.error || '定稿已提交、实体稿待发布')
    }
    callbacks.log(`定稿内容已提交到 SQLite 并发布实体稿（第${snapshot.chapterNumber}章）`)

    // 3. 通过 PostProcessPipeline 执行后处理（状态持久化 + 支持重试）
    callbacks.log('正在启动后台大模型推演系统更新全书状态...')

    const sourceLabel = `第${snapshot.chapterNumber}章定稿`
    const chapterEntities = this.params.chapterInfo.characters.length > 0
      ? this.params.chapterInfo.characters
      : (await ipc.invokeWithProjectSession(
          projectSession,
          'db:blueprint-get',
          snapshot.chapterNumber,
          project.path,
        ))?.characters ?? []
    const postProcessStatus = await new RunFinalizePostProcessCommand({
      project,
      chapterNumber: snapshot.chapterNumber,
      chapterTitle: snapshot.chapterTitle,
      draftContent: refinedDraftText,
      draftId: commit.draftId,
      sourceLabel,
      stopOnFailure: this.params.stopOnPostProcessFailure,
      chapterEntities,
    }).execute({ step: {}, context, callbacks })
    this.assertNotCancelled(context)

    if (this.params.stopOnPostProcessFailure) {
      const failedLabels = Object.values(postProcessStatus.steps)
        .filter((step) => !step.ok)
        .map((step) => step.label)
      if (failedLabels.length > 0) {
        throw new Error(`后处理失败，批量创作已停止：${failedLabels.join('、')}`)
      }
    }

    callbacks.log('\n第' + snapshot.chapterNumber + '章创作全流程彻底完成')
    this.assertNotCancelled(context)
    await useProjectStore.getState().refreshFileTree(project.path, undefined, projectSession)
  }

  private async createBatchSnapshot(
    context: WorkflowContext,
    projectPath: string,
  ): Promise<FinalizationSnapshot> {
    const projectSession = requireWorkflowProjectSession(context)
    const dbDraft = await readWorkflowDraftMeta(this.params.draftPath, projectPath, projectSession)
    this.assertNotCancelled(context)
    if (!dbDraft) throw new Error('内部状态流转异常：无法定位待定稿草稿')
    return Object.freeze({
      tabId: `batch:${context.runId}:${dbDraft.id}`,
      projectPath,
      projectSession: Object.freeze({ ...projectSession }),
      draftId: dbDraft.id,
      chapterNumber: this.params.chapterNumber,
      chapterTitle: this.params.chapterInfo.title,
      content: this.params.draftContent,
      contentRevision: 0,
    })
  }
}
