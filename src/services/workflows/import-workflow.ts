/** Persisted, resumable reference-import workflow. */
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  assertImportRunEffectReceiptMetadata,
  type ImportRunChapterSnapshot,
  type ImportRunSnapshot,
  type ImportRunStage,
  type ImportRunExecutionLease,
} from '../../shared/import-run'
import type { ImportGlobalFactsReceipt } from '../../shared/import-global-facts'
import type { BlueprintRangeCommitReceipt } from '../../../electron/repositories/blueprint-repository'
import type { FinalizedDraftImportReceipt } from '../../shared/finalized-draft-import'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../shared/project-session-context'
import { ipc } from '../ipc-client'
import { useProjectStore } from '../../stores/project-store'
import type { StepCallbacks, WorkflowContext, WorkflowDefinition, WorkflowStep } from '../../stores/workflow-store'
import { ImportRunOrchestrator, type ImportRunOrchestratorDependencies } from './import-run-orchestrator'
import { refreshImportDerivedFileTreeBestEffort } from './import-derived-refresh'
import { promptLanguageText } from '../prompt-language'
import { retryDirectoryCharacterSync } from './directory-character-sync-recovery'
import type { WritingLanguage } from '../../shared/writing-language'
import { countDraftUnits } from '../../shared/draft-units'

export interface ImportWorkflowParams {
  projectPath: string
  projectSession: ProjectSessionContext
  run: ImportRunSnapshot
  /** One frozen renderer execution identity for every step in this workflow. */
  executionOwner: string
}

function textForLocale(locale: ImportRunSnapshot['locale'], zhCNText: string, enUSText: string): string {
  return locale === 'en-US' ? enUSText : zhCNText
}

function required<T>(result: { success: boolean; error?: string } & T, fallback: string): T {
  if (!result.success) throw new Error(result.error || fallback)
  return result
}

function importedChapter(chapter: ImportRunChapterSnapshot) {
  return {
    number: chapter.number,
    title: chapter.title,
    content: chapter.content,
    wordCount: countDraftUnits(chapter.content),
  }
}

function currentNovelConfigSummary(writingLanguage: WritingLanguage): string {
  const config = useProjectStore.getState().currentProject?.novelConfig
  if (!config) return promptLanguageText(
    writingLanguage, '（配置概要不可用）', '(configuration summary unavailable)',
  )
  const none = promptLanguageText(writingLanguage, '（无）', '(none)')
  return promptLanguageText(
    writingLanguage,
    `类型: ${config.genre || none}\n大纲: ${config.coreOutline || none}\n世界观: ${config.worldSetting || none}\n主角: ${config.protagonistProfile || none}`,
    `Genre: ${config.genre || none}\nOutline: ${config.coreOutline || none}\nWorld: ${config.worldSetting || none}\nProtagonist: ${config.protagonistProfile || none}`,
  )
}

function productionDependencies(
  context: WorkflowContext,
  callbacks: StepCallbacks,
): ImportRunOrchestratorDependencies {
  const session = context.projectSession
  const projectPath = context.projectPath
  return {
    getRun: runId => ipc.invokeWithProjectSession(session, 'db:import-run-get', runId, projectPath),
    startOrResume: async (runId, owner) => {
      const start = required(
        await ipc.invokeWithProjectSession(session, 'db:import-run-start-resume', runId, owner, projectPath),
        'Could not start or resume the import run.',
      ).start!
      context.data.importRunExecution = start.execution
      return start
    },
    renewExecution: async (runId, execution) => {
      const renewed = required(
        await ipc.invokeWithProjectSession(
          session, 'db:import-run-renew-execution', runId, execution, projectPath,
        ),
        'Could not renew the import execution lease.',
      ).execution!
      context.data.importRunExecution = renewed
      return renewed
    },
    getEffectReceipt: (runId, stage, checkpoint) => ipc.invokeWithProjectSession(
      session,
      'db:import-run-effect-receipt-get',
      runId,
      stage,
      checkpoint,
      projectPath,
    ),
    prepareEffectReceipt: async (request, execution) => required(
      await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-prepare',
        request,
        execution,
        projectPath,
      ),
      'Could not freeze generated import output.',
    ).receipt!,
    commitEffectReceipt: async (runId, stage, checkpoint, execution) => required(
      await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-commit',
        runId,
        stage,
        checkpoint,
        execution,
        projectPath,
      ),
      'Could not commit the generated import output.',
    ).result!,
    replayCommittedEffect: async (receipt, run) => {
      // Re-read through the main-process repository so replay receives the
      // same canonical rehash and schema checks as get/commit, then reject any
      // renderer-side object that differs from that durable receipt.
      const durableReceipt = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-get',
        run.id,
        receipt.stage,
        receipt.batchId,
        projectPath,
      )
      if (!durableReceipt || JSON.stringify(durableReceipt) !== JSON.stringify(receipt)) {
        throw new Error('Committed import effect receipt does not match durable storage.')
      }
      assertImportRunEffectReceiptMetadata(durableReceipt, run)
      if (durableReceipt.state !== 'committed') throw new Error('Prepared import effects cannot be replayed.')
      if (durableReceipt.kind === 'chapter-blueprint-range') {
        const committed = durableReceipt.effectReceipt as BlueprintRangeCommitReceipt | undefined
        if (!committed?.characterSyncOperation?.operationId) {
          throw new Error('Committed blueprint import receipt is incomplete.')
        }
        await retryDirectoryCharacterSync(
          committed.characterSyncOperation.operationId,
          projectPath,
          session,
        )
        return
      }
      if (durableReceipt.kind === 'author-finalized-batch') {
        const authorReceipt = durableReceipt.effectReceipt as FinalizedDraftImportReceipt | undefined
        if (
          !authorReceipt
          || authorReceipt.operationId !== `author-import:${run.id}`
          || authorReceipt.drafts.length !== run.totalChapters
        ) throw new Error('Committed author-manuscript receipt is incomplete.')
        return
      }
      const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', projectPath)
      const current = useProjectStore.getState().currentProject
      if (!core || !current || !sameProjectSessionContext(
        session,
        projectSessionContextFromProject(current),
      )) throw new Error('The project changed before the committed import effect could be restored.')
      useProjectStore.setState({
        currentProject: {
          ...current,
          novelConfig: {
            ...current.novelConfig,
            genre: core.genre,
            subGenre: core.subGenre,
            targetAudience: core.targetAudience,
            totalChapters: core.totalChapters,
            wordsPerChapter: core.wordsPerChapter,
            plotStructure: core.plotStructure as typeof current.novelConfig.plotStructure,
            narrativePOV: core.narrativePov as typeof current.novelConfig.narrativePOV,
            writingStyle: core.writingStyle,
            globalGuidance: core.globalGuidance,
            goldenFinger: core.goldenFinger,
            coreOutline: core.coreOutline,
            worldSetting: core.worldSetting,
            protagonistProfile: core.protagonistProfile,
          },
        },
      })
      context.data.novelConfigSummary = currentNovelConfigSummary(context.writingLanguage)
    },
    listChapters: (runId, after, limit) => ipc.invokeWithProjectSession(
      session, 'db:import-run-list-chapters', runId, after, limit, projectPath,
    ),
    importReference: async (chapter, run, executionAuthority) => {
      const result = await ipc.invokeWithProjectSession(
        session,
        'kb:import-reference-text',
        chapter.number,
        run.id,
        executionAuthority,
      )
      if (!result.success) throw new Error(result.error || textForLocale(
        run.locale,
        `第 ${chapter.number} 章参照文本未能写入知识库`,
        `Reference Chapter ${chapter.number} could not be written to the knowledge base.`,
      ))
      callbacks.log(textForLocale(
        run.locale,
        `参照章节 ${chapter.number} 已进入知识库${result.idempotent ? '（已存在）' : ''}`,
        `Reference Chapter ${chapter.number} is in the knowledge base${result.idempotent ? ' (already present)' : ''}.`,
      ))
    },
    inferGlobal: async (chapters, stats, _run, commit) => {
      context.data.chapters = chapters.map(importedChapter)
      context.data.importRunTotalChapters = stats.totalChapters
      context.data.importRunTotalWords = stats.totalWords
      const { InferGlobalSettingsCommand } = await import('./commands/import-novel.command')
      await new InferGlobalSettingsCommand(undefined, async request => (
        await commit(request)
      ) as ImportGlobalFactsReceipt).execute({ step: {} as never, context, callbacks })
    },
    analyzeStyle: async (chapters, _run, commit) => {
      const { AnalyzeWritingStyleCommand } = await import('./commands/analyze-style.command')
      const style = await new AnalyzeWritingStyleCommand(
        { chapters: chapters.map(importedChapter) },
        undefined,
        async writingStyle => { await commit({ writingStyle }) },
      )
        .execute({ step: {} as never, context, callbacks })
      if (!style.trim()) throw new Error(textForLocale(
        context.uiLocale,
        '未提取到可用文风，无法继续建立仿写约束',
        'No usable writing style was extracted, so imitation guidance cannot be created.',
      ))
    },
    inferBlueprints: async (chapters, _checkpoint, _run, commit) => {
      context.data.chapters = chapters.map(importedChapter)
      context.data.novelConfigSummary = currentNovelConfigSummary(context.writingLanguage)
      const { InferBlueprintsPerChapterCommand } = await import('./commands/import-novel.command')
      await new InferBlueprintsPerChapterCommand(undefined, async request => (
        await commit(request)
      ) as BlueprintRangeCommitReceipt).execute({ step: {} as never, context, callbacks })
    },
    commitAuthorManuscript: async (run, commit) => {
      if (!run.authorityFingerprint || !run.manifestFingerprint) {
        throw new Error(textForLocale(
          run.locale,
          '作者原稿导入缺少权威状态指纹',
          'The author-manuscript import is missing its authority fingerprint.',
        ))
      }
      await commit({
        operationId: `author-import:${run.id}`,
        runId: run.id,
        authorityFingerprint: run.authorityFingerprint,
        manifestFingerprint: run.manifestFingerprint,
      })
    },
    getAuthorCommitReceipt: async runId => {
      const receipt = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-effect-receipt-get',
        runId,
        'author-commit',
        'done',
        projectPath,
      )
      if (!receipt) return null
      if (receipt.state !== 'committed' || receipt.kind !== 'author-finalized-batch') {
        throw new Error('Author-manuscript finalization has not been durably committed.')
      }
      return receipt.effectReceipt as FinalizedDraftImportReceipt
    },
    publishAuthorChapter: async (chapter, draft, run) => {
      const { retryFinalizationPublication } = await import('../finalization-client')
      const result = await retryFinalizationPublication(draft.finalizationId, session)
      if (!result.success || result.publicationStatus !== 'published') {
        throw new Error(result.error || textForLocale(
          run.locale,
          `第 ${chapter.number} 章实体正文发布失败`,
          `Chapter ${chapter.number} could not be published to the manuscript directory.`,
        ))
      }
      callbacks.log(textForLocale(
        run.locale,
        `第 ${chapter.number} 章实体正文已发布`,
        `Chapter ${chapter.number} was published to the manuscript directory.`,
      ))
    },
    postprocessAuthorChapter: async (chapter, draft, run) => {
      const current = useProjectStore.getState().currentProject
      if (!current || !sameProjectSessionContext(session, projectSessionContextFromProject(current))) {
        throw new Error(textForLocale(
          run.locale,
          '当前项目已切换，无法更新原稿连续性事实',
          'The project changed before manuscript continuity could be updated.',
        ))
      }
      const { RunFinalizePostProcessCommand } = await import('./commands/finalize-chapter.command')
      const status = await new RunFinalizePostProcessCommand({
        project: current,
        chapterNumber: chapter.number,
        chapterTitle: chapter.title,
        draftContent: chapter.content,
        draftId: draft.draftId,
        sourceLabel: textForLocale(
          run.locale,
          `第${chapter.number}章作者原稿定稿`,
          `Author manuscript Chapter ${chapter.number} finalization`,
        ),
        stopOnFailure: true,
        onlyFailed: true,
      }).execute({ step: {} as never, context, callbacks })
      if (!status.allCriticalPassed) {
        throw new Error(textForLocale(
          run.locale,
          `第 ${chapter.number} 章连续性后处理未完成`,
          `Continuity post-processing did not complete for Chapter ${chapter.number}.`,
        ))
      }
    },
    refresh: async run => {
      callbacks.log(textForLocale(run.locale, '正在刷新项目数据...', 'Refreshing project data...'))
      await refreshImportDerivedFileTreeBestEffort(
        () => useProjectStore.getState().refreshFileTree(projectPath, undefined, session),
        callbacks,
        (zhCNText, enUSText) => textForLocale(run.locale, zhCNText, enUSText),
      )
      const [{ useCharacterStore }, { useDraftStore }] = await Promise.all([
        import('../../stores/character-store'),
        import('../../stores/draft-store'),
      ])
      await useCharacterStore.getState().loadCharacters(projectPath, session)
      await useDraftStore.getState().loadAllDrafts(projectPath, session)
    },
    completeBatch: async (runId, stage, checkpoint, execution) => {
      const result = required(
        await ipc.invokeWithProjectSession(
          session, 'db:import-run-complete-batch', runId, stage, checkpoint, execution, projectPath,
        ),
        'Could not save the import checkpoint.',
      )
      return { cancelApplied: result.cancelApplied ?? false, run: result.run! }
    },
    advanceStage: async (runId, completedStage, nextStage, execution) => required(
      await ipc.invokeWithProjectSession(
        session, 'db:import-run-advance-stage', runId, completedStage, nextStage, execution, projectPath,
      ),
      'Could not advance the import checkpoint.',
    ).run!,
    fail: async (runId, stage, error, execution) => required(
      await ipc.invokeWithProjectSession(
        session, 'db:import-run-fail', runId, stage, error, execution, projectPath,
      ),
      'Could not save the import failure.',
    ).run!,
    cancelAtBoundary: async (runId, execution) => required(
      await ipc.invokeWithProjectSession(
        session, 'db:import-run-cancel-at-boundary', runId, execution, projectPath,
      ),
      'Could not save import cancellation.',
    ).run!,
    complete: async (runId, execution) => required(
      await ipc.invokeWithProjectSession(session, 'db:import-run-complete', runId, execution, projectPath),
      'Could not complete the import run.',
    ).run!,
  }
}

function importStep(
  run: ImportRunSnapshot,
  executionOwner: string,
  stage: Exclude<ImportRunStage, 'completed'>,
  name: [string, string],
  description: [string, string],
) {
  return {
    name: textForLocale(run.locale, ...name),
    description: textForLocale(run.locale, ...description),
    executor: async (_step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
      await new ImportRunOrchestrator(productionDependencies(context, callbacks))
        .executeStage(run.id, stage, executionOwner, context, callbacks)
    },
  }
}

export function createImportWorkflow(params: ImportWorkflowParams): WorkflowDefinition {
  const project = useProjectStore.getState().currentProject
  if (!project || !sameProjectSessionContext(params.projectSession, projectSessionContextFromProject(project))) {
    throw new Error(textForLocale(
      params.run.locale,
      '当前项目已切换，无法启动导入工作流',
      'The project changed, so the import workflow cannot start.',
    ))
  }
  const session = Object.freeze({ ...params.projectSession })
  const count = params.run.totalChapters
  const chapterCountEn = `${count} ${count === 1 ? 'chapter' : 'chapters'}`
  const durableCancelHooks: Pick<
    WorkflowDefinition,
    'onCancelRequested' | 'onCancelledAtBoundary'
  > = {
    onCancelRequested: async context => {
      const execution = context.data.importRunExecution as ImportRunExecutionLease | undefined
      if (!execution) return
      const result = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-request-cancel',
        params.run.id,
        execution,
        params.projectPath,
      )
      if (!result.success) throw new Error(result.error || textForLocale(
        params.run.locale,
        '无法保存导入取消请求',
        'Could not persist the import cancellation request.',
      ))
    },
    onCancelledAtBoundary: async context => {
      const durableRun = await ipc.invokeWithProjectSession(
        session, 'db:import-run-get', params.run.id, params.projectPath,
      )
      if (!durableRun || durableRun.status === 'cancelled') return
      const execution = context.data.importRunExecution as ImportRunExecutionLease | undefined
      if (!execution) return
      const renewed = required(
        await ipc.invokeWithProjectSession(
          session,
          'db:import-run-renew-execution',
          params.run.id,
          execution,
          params.projectPath,
        ),
        textForLocale(params.run.locale, '无法续租导入取消边界', 'Could not renew the import cancellation boundary.'),
      ).execution!
      context.data.importRunExecution = renewed
      const result = await ipc.invokeWithProjectSession(
        session,
        'db:import-run-cancel-at-boundary',
        params.run.id,
        renewed,
        params.projectPath,
      )
      if (!result.success) throw new Error(result.error || textForLocale(
        params.run.locale,
        '无法完成导入取消',
        'Could not finalize import cancellation.',
      ))
    },
  }
  if (params.run.purpose === 'author-manuscript') {
    return {
      runId: params.run.id,
      type: 'novel_import',
      title: textForLocale(
        params.run.locale,
        `导入作者原稿（${count} 章）`,
        `Import author manuscript (${chapterCountEn})`,
      ),
      projectPath: params.projectPath,
      projectSession: session,
      uiLocale: params.run.locale,
      ...durableCancelHooks,
      steps: [
        importStep(params.run, params.executionOwner, 'author-commit',
          ['提交权威定稿快照', 'Commit authoritative finalized snapshots'],
          ['以单个 SQLite 事务提交不可变定稿与发布 outbox', 'Atomically commit immutable finalized snapshots and publication outbox records.']),
        importStep(params.run, params.executionOwner, 'author-publish',
          ['发布实体正文', 'Publish manuscript files'],
          ['按持久检查点发布正文文件；失败后可安全重试', 'Publish manuscript files with durable checkpoints and safe retries.']),
        importStep(params.run, params.executionOwner, 'author-postprocess',
          ['更新连续性事实', 'Update continuity facts'],
          ['从权威定稿更新章节事实与角色状态，不导入参照语料', 'Update chapter facts and character state from authoritative text without importing reference prose.']),
        importStep(params.run, params.executionOwner, 'refresh',
          ['刷新项目状态', 'Refresh project state'],
          ['刷新正文树、角色卡与定稿状态', 'Refresh the manuscript tree, character cards, and finalized status.']),
      ],
      onComplete: {
        mode: 'silent',
        message: textForLocale(
          params.run.locale,
          '作者原稿已作为权威定稿导入，可以从下一章继续创作。',
          'The manuscript is now authoritative finalized text. You can continue from the next chapter.',
        ),
      },
    }
  }
  return {
    runId: params.run.id,
    type: 'novel_import',
    title: textForLocale(
      params.run.locale,
      `小说拆解与仿写（${count} 章）`,
      `Novel analysis and style study (${chapterCountEn})`,
    ),
    projectPath: params.projectPath,
    projectSession: session,
    uiLocale: params.run.locale,
    ...durableCancelHooks,
    steps: [
      importStep(params.run, params.executionOwner, 'knowledge',
        ['导入参照文本与构建知识库', 'Import reference text and build the knowledge base'],
        [`按有界批次导入 ${count} 章参照文本，不写入草稿或正文`, `Import ${chapterCountEn} of reference text in bounded batches without creating drafts or manuscript text`]),
      importStep(params.run, params.executionOwner, 'global',
        ['AI 推演全局配置与架构', 'AI infers global configuration and architecture'],
        ['从有界样本推演小说配置、故事架构与角色卡', 'Infer the novel configuration, architecture, and character cards from bounded samples.']),
      importStep(params.run, params.executionOwner, 'style',
        ['AI 拆解文风与仿写指南', 'AI analyzes writing style and imitation guidance'],
        ['从有界样本提取文风与仿写约束', 'Extract a style profile and imitation guidance from bounded samples.']),
      importStep(params.run, params.executionOwner, 'blueprints',
        ['AI 分批推演章节蓝图', 'AI infers chapter blueprints in batches'],
        [`以最多 5 章一批生成 ${count} 章蓝图`, `Infer ${chapterCountEn} of blueprints in batches of at most five.`]),
      importStep(params.run, params.executionOwner, 'refresh',
        ['刷新项目状态', 'Refresh project state'],
        ['刷新项目树、角色卡与蓝图', 'Refresh the project tree, character cards, and blueprints.']),
    ],
    onComplete: {
      mode: 'silent',
      message: textForLocale(
        params.run.locale,
        '小说拆解与仿写准备完成，全部结构化数据已生成，可以开始续写。',
        'Novel analysis and style study is ready. You can start writing.',
      ),
    },
  }
}

export function estimateImportCost(_totalWords: number, chapterCount: number): {
  estimatedTokens: number
  estimatedMinutes: number
  breakdown: string
} {
  const globalInferTokens = 15_000
  const blueprintTokensPerChapter = 4_000
  const totalBlueprintTokens = blueprintTokensPerChapter * chapterCount
  const estimatedTokens = globalInferTokens + totalBlueprintTokens
  const estimatedMinutes = Math.ceil((1 + Math.ceil(chapterCount / 5)) * 12 / 60)
  return {
    estimatedTokens,
    estimatedMinutes,
    breakdown: [
      `· 全局推演：~${(globalInferTokens / 1_000).toFixed(0)}K tokens`,
      `· 蓝图推演：~${(totalBlueprintTokens / 1_000).toFixed(0)}K tokens`,
      `· 总计：~${(estimatedTokens / 1_000).toFixed(0)}K tokens`,
    ].join('\n'),
  }
}
