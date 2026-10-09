import { runFinalizationGeneration } from '../../finalization-generation'
import { useLLMStore } from '../../../stores/llm-store'
import type { FinalizationGenerationEffect } from '../../../shared/finalization-generation'
import { buildFinalizedContinuityFacts } from '../../../shared/finalized-continuity-facts'
export { buildFinalizedContinuityFacts } from '../../../shared/finalized-continuity-facts'
import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { PostProcessPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { commitFinalizationSnapshot } from '../../finalization-client'
import { finalizationContentRevision, type FinalizationSnapshot } from '../../finalization-snapshot'
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
import {
  finalizedCharacterPromptCards,
  type FinalizedCharacterContext,
  type FinalizedSourceIdentity,
} from '../../../shared/finalized-continuity'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import {
  requireWorkflowProjectSession,
  workflowUiLocale,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { writingLanguageText } from '../../../shared/writing-language'
import { localize } from '../../../i18n/core'
import type { Locale } from '../../../i18n/types'
import type { FinalizedCharacterGenerationReceipt } from '../../../shared/finalized-character-generation'

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
  finalizedStage?(stepKey: 'chapter_notes' | 'character_cards', context: WorkflowContext): Promise<FinalizationGenerationEffect>
  complete(
    builder: { build: () => string; getSystemRole: () => string },
    callbacks: StepCallbacks,
    output: 'visible-text' | 'structured-data',
    context: WorkflowContext,
  ): Promise<string>
  characterStates?(
    builder: { build: () => string; getSystemRole: () => string },
    callbacks: StepCallbacks,
    context: WorkflowContext,
    prepared: { contextId: string; context: FinalizedCharacterContext },
  ): Promise<FinalizedCharacterGenerationReceipt>
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
  uiLocale: Locale = 'zh-CN',
  finalizedSource?: FinalizedSourceIdentity,
  projectionGeneration?: number,
  identityContext?: FinalizedCharacterContext,
): PostProcessStep[] {
  const steps: PostProcessStep[] = []
  const text = (zhCNText: string, enUSText: string) => localize(uiLocale, zhCNText, enUSText)
  let generatedChapterNotes: string | undefined

  // ─── 步骤 1: 导入知识库 ───────────────────────────────────────────
  steps.push({
    key: 'kb_import',
    label: text('导入知识库', 'Import into knowledge base'),
    critical: true,
    executor: async (callbacks, context) => {
      if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
      if (context.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
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
      requireIpcSuccess(result, text('导入知识库', 'Import into knowledge base'))
      if (finalizedDraftId !== undefined) {
        if (!result.docId) throw new Error(workflowUiText(
          context,
          '知识库导入成功但缺少文档身份收据',
          'The knowledge-base import succeeded but returned no document identity receipt.',
        ))
        const linked = await ipc.invokeWithProjectSession(
          projectSession,
          'db:finalization-link-knowledge-document',
          finalizedDraftId,
          result.docId,
          _project.path,
        )
        requireIpcSuccess(linked, text(
          '登记定稿知识文档身份',
          'Link finalized knowledge document identity',
        ))
      }
      callbacks.log(workflowUiText(
        context,
        `正文章节已导入知识库（${result.chunkCount} 块）`,
        `Manuscript chapter imported into the knowledge base (${result.chunkCount} chunks)`,
      ))
    },
  })

  // ─── 步骤 2: 本章剧情要点提取 ─────────────────────────────────────
  steps.push({
      key: 'chapter_notes',
      label: text('章节剧情要点', 'Chapter plot notes'),
      critical: true,
      executor: async (callbacks, context) => {
        if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
        if (context.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
        if (
          finalizedDraftId !== undefined
          && (
            !finalizedSource
            || finalizedSource.draftId !== finalizedDraftId
            || !Number.isSafeInteger(projectionGeneration)
            || projectionGeneration! < 0
          )
        ) {
          throw new Error(workflowUiText(
            context,
            '定稿连续性投影缺少模型调用前冻结的来源水位',
            'The finalized continuity projection is missing the source watermark frozen before the model call.',
          ))
        }
        if (generation.finalizedStage) {
          const effect = await generation.finalizedStage('chapter_notes', context)
          if (effect.stepKey !== 'chapter_notes') throw new Error('FINALIZATION_GENERATION_EFFECT_MISMATCH')
          callbacks.log(workflowUiText(context, `已投影连续性事实：${effect.factCount} 条`, `Projected continuity facts: ${effect.factCount}`))
          return
        }
        const projectSession = requireWorkflowProjectSession(context)
        const writingLanguage = workflowWritingLanguage(context)
        const notesTemplate = await resolvePromptTemplate('generate_chapter_notes', projectSession, writingLanguage)
        if (!notesTemplate) throw new Error(workflowUiText(
          context,
          '未找到章节要点模板',
          'Chapter-notes template not found.',
        ))
        const notesBuilder = new PostProcessPromptBuilder(notesTemplate, writingLanguage)
          .withChapterContent(draftContent)
          .withChapterNumber(chapterNumber)
          .withChapterTitle(chapterTitle)

        generatedChapterNotes ??= await generation.complete(notesBuilder, callbacks, 'visible-text', context)
        const cleanNotes = generatedChapterNotes
        if (context?.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))

        if (finalizedDraftId !== undefined) {
          const facts = buildFinalizedContinuityFacts(
            chapterNumber,
            cleanNotes,
            draftContent,
            chapterEntities,
            identityContext,
          )
          const continuityResult = await ipc.invokeWithProjectSession(
            projectSession,
            'db:continuity-save-finalized',
            {
              draftId: finalizedDraftId,
              chapterNumber,
              chapterNotes: cleanNotes,
              facts,
              projectionGeneration: projectionGeneration!,
              source: finalizedSource!,
            },
            _project.path,
          )
          requireIpcSuccess(continuityResult, text(
            '保存定稿连续性事实',
            'Save finalized continuity facts',
          ))
          callbacks.log(workflowUiText(
            context,
            `已投影连续性事实：${facts.length} 条`,
            `Projected continuity facts: ${facts.length}`,
          ))
        }

        // 兼容已有蓝图项目；作者原稿无蓝图时，权威事实仍已由定稿投影保存。
        if (context?.cancelled) throw new Error(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'db:blueprint-update-notes',
          chapterNumber,
          cleanNotes,
          _project.path,
        )
        requireIpcSuccess(result, text('写入章节剧情要点', 'Write chapter plot notes'))
        callbacks.log(
          result.updated === false
            ? workflowUiText(
                context,
                '本章剧情要点提取完成（已保存定稿连续性事实）',
                'Chapter plot-note extraction completed; finalized continuity facts were saved.',
              )
            : workflowUiText(
                context,
                '本章剧情要点提取完成（已写入蓝图）',
                'Chapter plot-note extraction completed and was written to the blueprint.',
              ),
        )
      },
    })

  // Model IDs refer only to the identity snapshot frozen by the original finalization.
  steps.push({
    key: 'character_cards',
    label: text('角色状态更新', 'Update character state'),
    critical: false,
    executor: async (callbacks, context) => {
      if (!context || context.cancelled) throw new Error('GENERATION_WORKFLOW_CANCELLED')
      if (generation.finalizedStage) {
        const effect = await generation.finalizedStage('character_cards', context)
        if (effect.stepKey !== 'character_cards') throw new Error('FINALIZATION_GENERATION_EFFECT_MISMATCH')
        if (effect.proposalBatchId) context.data.characterProposalBatchId = effect.proposalBatchId
        callbacks.log(text('角色状态主进程回执已确认', 'The main-process character-state receipt was confirmed.'))
        return
      }
      if (finalizedDraftId === undefined || !finalizedSource || !generation.characterStates) throw new Error('FINALIZED_CHARACTER_MAIN_REQUIRED')
      const projectSession = requireWorkflowProjectSession(context)
      const prepared = await ipc.invokeWithProjectSession(projectSession, 'finalized-character:read-context', { draftId: finalizedDraftId })
      if (prepared.context.source.finalizationId !== finalizedSource.finalizationId || prepared.context.source.contentHash !== finalizedSource.contentHash
        || prepared.context.source.chapterNumber !== chapterNumber || prepared.context.content !== draftContent) throw new Error('FINALIZED_CHARACTER_SOURCE_CHANGED')
      const writingLanguage = workflowWritingLanguage(context)
      const template = await resolvePromptTemplate('update_character_cards', projectSession, writingLanguage)
      if (!template) throw new Error('FINALIZED_CHARACTER_TEMPLATE_REQUIRED')
      const cards = finalizedCharacterPromptCards(prepared.context, prepared.originProjectId)
      const base = new PostProcessPromptBuilder(template, writingLanguage)
        .withChapterContent(prepared.context.content).withChapterNumber(chapterNumber).withExistingCardsJson(cards)
      const contract = writingLanguage === 'en-US'
        ? '[Final output contract: this overrides the [JSON output contract] above] Do not copy that example: its newCharacters list and full-field layout do not apply. A person with an existing character card must use that card\'s exact characterId, and every update must include evidence. Every update must include recentEvents (this character\'s latest state at the end of the chapter, within 50 words). The recentEvents of each update states the latest state of this character at the end of the chapter: when later prose corrects, withdraws, or postpones an earlier plan, follow the last correction and prioritize that correction and its current conditions over a more prominent earlier event; do not write the superseded plan or describe a still-pending plan as executed. Without a correction, retain this character\'s relevant event or still-pending plan. Do not apply another character\'s change of plan to this character; evidence quotes the one sentence that directly supports that latest state. List other fields only when the value differs from the existing card and matches the field (location is only the place the chapter prose explicitly states the character is currently in, never an event or progress; when the prose only states a plan, a decision, or an intention to go somewhere, the character is still where they were and must not be written as en route or arrived; when the prose states no clear change of place, do not list location). Return one JSON object: {"updates":[{"characterId":"exact ID from the frozen list","currentState":{"recentEvents":"this chapter\'s event","location":"new place"},"evidence":{"text":"exact source quote"}}]}. Copy a quote that occurs exactly once in the unmodified chapter; its offsets will be calculated. If you supply start/end, they must be exact JS UTF-16 offsets. evidence.text must be one contiguous, verbatim span of the frozen chapter that occurs exactly once; never join sentences across paragraphs or blank lines, and do not alter punctuation or whitespace. If unsure of the position, omit start/end and let the program calculate them. Only supplied dynamic fields are proposed. Do not infer identity from a name. Unknown or ambiguous people use name without characterId and remain proposals. Do not return static character facts or author provenance.'
        : '【最终输出合同，覆盖上文【输出格式（JSON）】】不得照抄上文示例：其中的 newCharacters 与全字段写法不适用；现有角色卡中的人物必须使用其精确 characterId，每个 update 都必须含 evidence；每个 update 必须填写 recentEvents（本章结束时该角色的最新状态，50字以内）；每个 update 的 recentEvents 写本章结束时该角色的最新状态：正文后文更正、撤回或推迟了前文安排时，以最后的更正为准，优先保留该更正及当前条件，不得被更显著的旧事件挤掉；不写已被更正的旧安排，也不把仍待执行的计划写成已执行。没有更正时，保留该角色有关事件或仍待执行的安排；不得将其他角色的安排变化套到该角色；evidence 引用直接支持该最新状态的一句。其余字段只在值与现有角色卡不同且名实相符时列出（location 只写正文明确写出的人物当前所在地点，不写事件或进度；正文只写了计划、决定或打算前往某处时，人物仍在原处，不得写成“前往途中”“已到达”；正文没有明确写出地点变化时不要列出 location）。只返回一个 JSON 对象：{"updates":[{"characterId":"冻结名单中的精确ID","currentState":{"recentEvents":"本章事件","location":"新地点"},"evidence":{"text":"原文精确引用"}}]}。引用必须在未改写正文中仅出现一次，位置由程序精确计算；若提供 start/end，必须是准确的 JS UTF-16 位置。evidence.text 必须是冻结正文中单一连续、逐字、只出现一次的片段；不得跨段落或空行拼接多句，不得删改标点或空白；不确定位置时省略 start/end，由程序计算。只提议明确返回的动态字段；不可凭名字推断身份。未知或歧义人物只返回 name、不填 characterId，保留为待确认提议。不得输出静态角色事实或作者来源。'
      const builder = { build: () => base.build() + '\n\n' + contract, getSystemRole: () => base.getSystemRole() }
      const receipt = await generation.characterStates(builder, callbacks, context, prepared)
      if (receipt.proposalBatchId) context.data.characterProposalBatchId = receipt.proposalBatchId
      callbacks.log(text(
        '角色状态已按身份核验：更新 ' + receipt.applied + ' 个字段，待确认 ' + (receipt.candidates.length + receipt.unresolved.length) + ' 项。',
        'Character identities verified: ' + receipt.applied + ' fields updated; ' + (receipt.candidates.length + receipt.unresolved.length) + ' items await confirmation.',
      ))
    },
  })

  return steps
}

export interface RunFinalizePostProcessParams {
  project: { path: string }
  chapterNumber: number
  chapterTitle: string
  draftContent: string
  draftId: number
  sourceLabel: string
  finalizedSource: FinalizedSourceIdentity
  stopOnFailure?: boolean
  onlyFailed?: boolean
  stepKey?: string
  chapterEntities?: readonly string[]
}

/** One post-process run freezes one model and one budget across notes/cards. */
export class RunFinalizePostProcessCommand extends BaseWorkflowCommand<PostProcessStatus> {
  constructor(
    private readonly params: RunFinalizePostProcessParams,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<PostProcessStatus> {
    return this.executeWithinGeneration(params)
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<PostProcessStatus> {
    const projectSession = requireWorkflowProjectSession(context)
    const finalizedSource = await ipc.invokeWithProjectSession(
      projectSession,
      'db:continuity-read-source',
      this.params.draftId,
      this.params.project.path,
    )
    const frozen = finalizedSource.status === 'valid' ? finalizedSource.snapshot : null
    if (
      !frozen
      || frozen.source.draftId !== this.params.finalizedSource.draftId
      || frozen.source.finalizationId !== this.params.finalizedSource.finalizationId
      || frozen.source.chapterNumber !== this.params.finalizedSource.chapterNumber
      || frozen.source.contentHash !== this.params.finalizedSource.contentHash
    ) {
      throw new Error(workflowUiText(
        context,
        '定稿正文来源收据已失效，后处理未启动',
        'The finalized manuscript source receipt is stale, so post-processing was not started.',
      ))
    }
    const generation: FinalizePostProcessGeneration = {
      finalizedStage: (stepKey, generationContext) => runFinalizationGeneration({
        session: projectSession, slot: { source: this.params.finalizedSource, stepKey },
        modelId: () => generationContext.generationModelId ?? useLLMStore.getState().defaultModelId ?? '',
        ...(generationContext.data.generationBatchId && generationContext.mainGenerationRootHandle
          ? { parentRootActionId: generationContext.mainGenerationRootHandle.rootActionId } : {}),
        cancelled: () => generationContext.cancelled,
        onHandle: handle => { generationContext.mainGenerationRunHandle = Object.freeze({ ...handle }) },
      }),
      complete: async () => { throw new Error('FINALIZATION_GENERATION_MAIN_REQUIRED') },
    }
    const allSteps = buildFinalizePostProcessSteps(
      this.params.project,
      this.params.chapterNumber,
      this.params.chapterTitle,
      frozen.content,
      generation,
      this.params.draftId,
      this.params.chapterEntities,
      workflowUiLocale(context),
      this.params.finalizedSource,
      frozen.projectionGeneration,
      undefined,
    )
    const steps = this.params.stepKey
      ? allSteps.filter(step => step.key === this.params.stepKey)
      : allSteps
    if (this.params.stepKey && steps.length === 0) {
      throw new Error(workflowUiText(
        context,
        `未知的后处理步骤：${this.params.stepKey}`,
        `Unknown post-processing step: ${this.params.stepKey}`,
      ))
    }
    return runPostProcessPipeline(
      this.params.project.path,
      getChapterFinalizeScope(this.params.chapterNumber),
      this.params.sourceLabel,
      steps,
      callbacks,
      {
        stopOnFailure: this.params.stopOnFailure,
        onlyFailed: this.params.onlyFailed,
        finalizedSource: this.params.finalizedSource,
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
    const uiText = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(uiText('未打开项目', 'No project is open.'))
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) {
      throw new Error(uiText(
        '项目已切换，已停止对原项目的定稿操作',
        'The project changed, so finalization of the previous project was stopped.',
      ))
    }

    callbacks.log(uiText(
      '\n===== 开始定稿与后处理分析 =====',
      '\n===== Starting finalization and post-processing analysis =====',
    ))

    const snapshot = this.params.snapshot ?? await this.createBatchSnapshot(context, project.path)
    if (snapshot.projectPath !== project.path) {
      throw new Error(uiText(
        '定稿快照属于已切换的项目会话',
        'The finalization snapshot belongs to a project session that is no longer active.',
      ))
    }
    const refinedDraftText = snapshot.content
    if (!refinedDraftText) throw new Error(uiText('没有定稿内容', 'There is no content to finalize.'))

    // SQLite 正文、状态和 publication outbox 由主进程在一个事务内提交。这里绝不
    // 再读取旧数据库正文，也不以 renderer 路径写实体稿。
    this.assertNotCancelled(context)
    const commit = await commitFinalizationSnapshot(snapshot)
    if (!commit.committed || !commit.finalizationId || !commit.contentHash || commit.draftId === undefined) {
      throw new Error(commit.error || uiText(
        '定稿事务未提交',
        'The finalization transaction was not committed.',
      ))
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
      const publicationError = commit.error || uiText(
        '定稿已提交、实体稿待发布',
        'Finalization was committed, but manuscript publication is still pending.',
      )
      callbacks.log(publicationError)
      throw new Error(publicationError)
    }
    callbacks.log(uiText(
      `定稿内容已提交到 SQLite 并发布实体稿（第${snapshot.chapterNumber}章）`,
      `Finalized content committed to SQLite and published as a manuscript (Chapter ${snapshot.chapterNumber})`,
    ))

    // 3. 通过 PostProcessPipeline 执行后处理（状态持久化 + 支持重试）
    callbacks.log(uiText(
      '正在启动后台大模型推演系统更新全书状态...',
      'Starting background AI post-processing to update the novel state...',
    ))

    const sourceLabel = uiText(
      `第${snapshot.chapterNumber}章定稿`,
      `Chapter ${snapshot.chapterNumber} finalization`,
    )
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
      finalizedSource: {
        draftId: commit.draftId,
        finalizationId: commit.finalizationId,
        chapterNumber: snapshot.chapterNumber,
        contentHash: commit.contentHash,
      },
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
        throw new Error(uiText(
          `后处理失败，批量创作已停止：${failedLabels.join('、')}`,
          `Post-processing failed, so batch creation was stopped: ${failedLabels.join(', ')}`,
        ))
      }
    }

    callbacks.log(uiText(
      `\n第${snapshot.chapterNumber}章创作全流程彻底完成`,
      `\nChapter ${snapshot.chapterNumber} creation workflow fully completed`,
    ))
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
      contentRevision: finalizationContentRevision(undefined),
    })
  }
}
