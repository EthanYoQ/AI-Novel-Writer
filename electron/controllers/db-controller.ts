import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import { closeProjectDatabase, getCurrentProjectPath } from '../database'
import { projectAccess } from '../services/project-access'
import { assertRequiredExpectedProjectPath } from '../utils/project-context'

// 导入所有 Repository
import { ProjectCoreRepository, ProjectCoreData } from '../repositories/project-core-repository'
import { ProjectClearRepository, ProjectClearOptions } from '../repositories/project-clear-repository'
import {
  BlueprintRepository,
  BlueprintData,
  type BlueprintRangeCommitRequest,
} from '../repositories/blueprint-repository'
import { CharacterRepository } from '../repositories/character-repository'
import { CharacterRosterRepository } from '../repositories/character-roster-repository'
import type { CharacterRosterCommitRequest } from '../../src/shared/character-roster'
import { DraftRepository } from '../repositories/draft-repository'
import { FinalizedDraftImportRepository } from '../repositories/finalized-draft-import-repository'
import { FinalizationRepository } from '../repositories/finalization-repository'
import type { FinalizedDraftImportRequest } from '../../src/shared/finalized-draft-import'
import { ImportGlobalFactsRepository } from '../repositories/import-global-facts-repository'
import type { ImportGlobalFactsRequest } from '../../src/shared/import-global-facts'
import { ImportRunRepository } from '../repositories/import-run-repository'
import type {
  ImportRunExecutionLease,
  ImportRunPrepareEffectReceiptRequest,
  ImportRunPrepareFromInspectionRequest,
  ImportRunStage,
} from '../../src/shared/import-run'
import {
  AUTHOR_IMPORT_PREVIEW_STALE,
  isAuthorImportPreviewStaleError,
  isImportRunDirectCheckpointStage,
} from '../../src/shared/import-run'
import { ImportSourceIdentityRepository } from '../repositories/import-source-identity-repository'
import { importInspectionStore } from '../services/import-inspection-store'
import { loadApplicationImportSourceSecret } from '../services/import-source-identity-secret'
import { RevisionRepository } from '../repositories/revision-repository'
import { ReviewRepository } from '../repositories/review-repository'
import { PostProcessRepository } from '../repositories/post-process-repository'

// 沿用的旧表
import { LLMHistoryRepository } from '../repositories/llm-repository'
import { SummaryRepository } from '../repositories/summary-repository'
import { ConsistencyExemptionRepository } from '../repositories/consistency-exemption-repository'

type ProjectDatabaseHandler = (event: unknown, ...args: never[]) => unknown

const MUTATING_DATABASE_CHANNELS = new Set([
  'db:close',
  'db:project-core-update',
  'db:import-global-facts-commit',
  'db:project-clear-generated-data',
  'db:import-run-prepare-inspection',
  'db:import-run-finalize-parsing',
  'db:import-run-start-resume',
  'db:import-run-effect-receipt-prepare',
  'db:import-run-effect-receipt-commit',
  'db:import-run-renew-execution',
  'db:import-run-restart',
  'db:import-run-request-cancel',
  'db:import-run-cancel-at-boundary',
  'db:import-run-complete-batch',
  'db:import-run-advance-stage',
  'db:import-run-fail',
  'db:import-run-complete',
  'db:blueprint-upsert',
  'db:blueprint-upsert-many',
  'db:blueprint-commit-range',
  'db:blueprint-character-sync-complete',
  'db:blueprint-update-notes',
  'db:blueprint-delete',
  'db:blueprint-clear-all',
  'db:character-roster-commit',
  'db:draft-import-finalized-batch',
  'db:draft-create',
  'db:draft-update-status',
  'db:draft-update-content',
  'db:draft-delete',
  'db:finalization-link-knowledge-document',
  'db:revision-create',
  'db:revision-replace-pending',
  'db:revision-mark-merged',
  'db:revision-mark-discarded',
  'db:review-create',
  'db:consistency-exemption-save',
  'db:consistency-exemption-revoke',
  'db:post-process-create-run',
  'db:post-process-mark-step-ok',
  'db:post-process-mark-step-failed',
  'db:log-llm-call',
  'db:save-summary-snapshot',
])

function registerProjectDatabaseHandler(channel: string, handler: ProjectDatabaseHandler): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const candidate = args.at(-1)
    const context = isProjectSessionContext(candidate) ? candidate : undefined
    if (context) args.pop()
    try {
      projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
      return await (handler as (event: unknown, ...handlerArgs: unknown[]) => unknown)(event, ...args)
    } catch (error) {
      if (MUTATING_DATABASE_CHANNELS.has(channel)) {
        return { success: false, error: String(error) }
      }
      throw error
    }
  })
}

export function registerDatabaseController() {
  // 所有 db:* 都通过同一会话门禁；下面现有 handler 保留业务参数与错误语义。
  const ipcMain = { handle: registerProjectDatabaseHandler }
  ipcMain.handle('db:close', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    closeProjectDatabase()
    projectAccess.invalidateCurrentSession()
    return { success: true }
  })

  // ============================================================
  // 1. project_core — 项目主台账
  // ============================================================
  ipcMain.handle('db:project-core-get', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ProjectCoreRepository.get()
  })

  ipcMain.handle('db:project-core-update', async (
    _event,
    data: Partial<ProjectCoreData>,
    expectedProjectPath: string,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      ProjectCoreRepository.update(data)
      return { success: true }
    } catch (err) {
      console.error('[db:project-core-update] 失败:', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:import-global-facts-commit', async (
    _event,
    request: ImportGlobalFactsRequest,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, receipt: ImportGlobalFactsRepository.commit(request) }
  })

  ipcMain.handle('db:project-clear-generated-data', async (
    _event,
    options: ProjectClearOptions,
    expectedProjectPath: string,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      const result = ProjectClearRepository.clearGeneratedData(options)
      return { success: true, ...result }
    } catch (err) {
      console.error('[db:project-clear-generated-data] 失败:', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:import-run-prepare-inspection', async (
    event,
    request: ImportRunPrepareFromInspectionRequest,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    const webContentsId = (event as IpcMainInvokeEvent).sender.id
    const inspected = importInspectionStore.peek(request.inspectionId, webContentsId, request.purpose)
    if (request.purpose === 'author-manuscript') {
      const preview = FinalizedDraftImportRepository.preview(inspected.chapters.map(chapter => ({
        chapterNumber: chapter.number,
        title: chapter.title,
        content: chapter.content,
        wordCount: chapter.wordCount,
      })))
      if (
        preview.authorityFingerprint !== request.authorityFingerprint
        || preview.manifestFingerprint !== request.manifestFingerprint
      ) return { success: false as const, errorCode: AUTHOR_IMPORT_PREVIEW_STALE }
    }
    const inspection = importInspectionStore.consume(request.inspectionId, webContentsId)
    const sourceIdentity = ImportSourceIdentityRepository.resolveEncodedSources(
      inspection.sources.map(source => ({
        locationAliasDigest: source.locationAliasDigest,
        fileAliasDigest: source.fileAliasDigest,
      })),
      request.purpose,
      loadApplicationImportSourceSecret(),
    )
    const sourceDisplay = inspection.sources.map(source => ({
      displayName: source.displayName,
      mediaType: source.mediaType,
      size: source.size,
    }))
    if (request.purpose === 'author-manuscript') {
      try {
        return {
          success: true as const,
          preparation: ImportRunRepository.prepare({
            runId: request.runId,
            purpose: request.purpose,
            sourceFingerprint: sourceIdentity.sourceFingerprint,
            sourceIds: sourceIdentity.sourceIds,
            sourceFingerprints: sourceIdentity.sourceFingerprints,
            sourceDisplay,
            locale: request.locale,
            authorityFingerprint: request.authorityFingerprint,
            expectedManifestFingerprint: request.manifestFingerprint,
            chapters: inspection.chapters,
          }),
        }
      } catch (error) {
        if (isAuthorImportPreviewStaleError(error)) {
          return { success: false as const, errorCode: AUTHOR_IMPORT_PREVIEW_STALE }
        }
        throw error
      }
    }
    const parsingRun = ImportRunRepository.beginParsing({
      runId: request.runId,
      purpose: request.purpose,
      sourceFingerprint: sourceIdentity.sourceFingerprint,
      sourceIds: sourceIdentity.sourceIds,
      sourceFingerprints: sourceIdentity.sourceFingerprints,
      legacySourceFingerprints: sourceIdentity.legacySourceFingerprints,
      legacyCollectionFingerprint: sourceIdentity.legacyCollectionFingerprint,
      sourceDisplay,
      locale: request.locale,
    })
    for (let sourceIndex = 0; sourceIndex < sourceIdentity.sourceIds.length; sourceIndex++) {
      const sourceId = sourceIdentity.sourceIds[sourceIndex]!
      const chapters = inspection.chapters
        .filter(chapter => chapter.sourceIndex === sourceIndex)
        .map(chapter => ({
          number: chapter.sourceChapterNumber,
          sourceChapterNumber: chapter.sourceChapterNumber,
          title: chapter.title,
          content: chapter.content,
          contentFingerprint: chapter.contentFingerprint,
          contentSize: chapter.contentSize,
        }))
      try {
        ImportRunRepository.commitParsedSource(parsingRun.id, sourceId, chapters)
      } catch (error) {
        ImportRunRepository.failParsedSource(
          parsingRun.id,
          sourceId,
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }
    }
    return { success: true, preparation: ImportRunRepository.finalizeParsing(parsingRun.id) }
  })

  ipcMain.handle('db:import-run-finalize-parsing', async (
    _event,
    runId: string,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, preparation: ImportRunRepository.finalizeParsing(runId) }
  })

  ipcMain.handle('db:import-run-author-preview', async (
    event,
    inspectionId: string,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    const inspection = importInspectionStore.peek(
      inspectionId,
      (event as IpcMainInvokeEvent).sender.id,
      'author-manuscript',
    )
    return FinalizedDraftImportRepository.preview(inspection.chapters.map(chapter => ({
      chapterNumber: chapter.number,
      title: chapter.title,
      content: chapter.content,
      wordCount: chapter.wordCount,
    })))
  })

  ipcMain.handle('db:import-run-get', async (_event, runId: string, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ImportRunRepository.get(runId)
  })

  ipcMain.handle('db:import-run-list-resumable', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ImportRunRepository.listResumable()
  })

  ipcMain.handle('db:import-run-list-chapters', async (
    _event,
    runId: string,
    afterChapterNumber: number,
    limit: number,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ImportRunRepository.listChapterBatch(runId, { afterChapterNumber, limit })
  })

  ipcMain.handle('db:import-run-effect-receipt-get', async (
    _event,
    runId: string,
    stage: ImportRunStage,
    batchId: string,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ImportRunRepository.getEffectReceipt(runId, stage, batchId)
  })

  ipcMain.handle('db:import-run-effect-receipt-prepare', async (
    _event,
    request: ImportRunPrepareEffectReceiptRequest,
    execution: ImportRunExecutionLease,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, receipt: ImportRunRepository.prepareEffectReceipt(request, execution) }
  })

  ipcMain.handle('db:import-run-effect-receipt-commit', async (
    _event,
    runId: string,
    stage: ImportRunStage,
    batchId: string,
    execution: ImportRunExecutionLease,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, result: ImportRunRepository.commitEffectReceipt(runId, stage, batchId, execution) }
  })

  ipcMain.handle('db:import-run-start-resume', async (
    _event,
    runId: string,
    owner: string,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, start: ImportRunRepository.startOrResume(runId, owner) }
  })

  ipcMain.handle('db:import-run-renew-execution', async (
    _event,
    runId: string,
    execution: ImportRunExecutionLease,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, execution: ImportRunRepository.renewExecution(runId, execution) }
  })

  ipcMain.handle('db:import-run-restart', async (
    _event,
    runId: string,
    nextRunId: string,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, run: ImportRunRepository.restart(runId, nextRunId) }
  })

  ipcMain.handle('db:import-run-request-cancel', async (
    _event,
    runId: string,
    execution: ImportRunExecutionLease,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, run: ImportRunRepository.requestCancel(runId, execution) }
  })

  ipcMain.handle('db:import-run-cancel-at-boundary', async (
    _event,
    runId: string,
    execution: ImportRunExecutionLease,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, run: ImportRunRepository.cancelAtBoundary(runId, execution) }
  })

  ipcMain.handle('db:import-run-complete-batch', async (
    _event,
    runId: string,
    stage: ImportRunStage,
    batchId: string,
    execution: ImportRunExecutionLease,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    if (!isImportRunDirectCheckpointStage(stage)) throw new Error('该导入阶段不接受直接 checkpoint')
    return { success: true, ...ImportRunRepository.completeBatch(runId, stage, batchId, execution) }
  })

  ipcMain.handle('db:import-run-advance-stage', async (
    _event,
    runId: string,
    completedStage: ImportRunStage,
    nextStage: ImportRunStage,
    execution: ImportRunExecutionLease,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, run: ImportRunRepository.advanceStage(runId, completedStage, nextStage, execution) }
  })

  ipcMain.handle('db:import-run-fail', async (
    _event,
    runId: string,
    stage: ImportRunStage,
    errorMessage: string,
    execution: ImportRunExecutionLease,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, run: ImportRunRepository.fail(runId, stage, errorMessage, execution) }
  })

  ipcMain.handle('db:import-run-complete', async (
    _event,
    runId: string,
    execution: ImportRunExecutionLease,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return { success: true, run: ImportRunRepository.complete(runId, execution) }
  })

  // ============================================================
  // 2. blueprints — 章节蓝图
  // ============================================================
  ipcMain.handle('db:blueprint-get-all', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return BlueprintRepository.getAll()
  })

  ipcMain.handle('db:blueprint-get', async (_event, chapterNumber: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return BlueprintRepository.getByChapter(chapterNumber)
  })

  ipcMain.handle('db:blueprint-upsert', async (_event, data: BlueprintData, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      BlueprintRepository.upsert(data)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-upsert-many', async (_event, items: BlueprintData[], expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      BlueprintRepository.upsertMany(items)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-commit-range', async (
    _event,
    request: BlueprintRangeCommitRequest,
    expectedProjectPath: string,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      return { success: true, receipt: BlueprintRepository.commitRange(request) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-character-sync-list-pending', async (
    _event,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return BlueprintRepository.listPendingCharacterSyncOperations()
  })

  ipcMain.handle('db:blueprint-character-sync-get', async (
    _event,
    operationId: string,
    expectedProjectPath: string,
  ) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return BlueprintRepository.getCharacterSyncOperation(operationId)
  })

  ipcMain.handle('db:blueprint-character-sync-complete', async (
    _event,
    operationId: string,
    expectedProjectPath: string,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      return {
        success: true,
        operation: BlueprintRepository.completeCharacterSyncOperation(operationId),
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-update-notes', async (_event, chapterNumber: number, notes: string, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      const updated = BlueprintRepository.updateNotes(chapterNumber, notes)
      return { success: true, updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-delete', async (_event, chapterNumber: number, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      BlueprintRepository.delete(chapterNumber)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-clear-all', async (_event, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      BlueprintRepository.clearAll()
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ============================================================
  // 3. characters — 角色卡
  // ============================================================
  ipcMain.handle('db:character-get-all', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return CharacterRepository.getAll()
  })

  ipcMain.handle('db:character-roster-read', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return CharacterRosterRepository.read()
  })

  ipcMain.handle('db:character-roster-commit', async (
    _event,
    request: CharacterRosterCommitRequest,
    expectedProjectPath: string,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      return { success: true, receipt: CharacterRosterRepository.commit(request) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ============================================================
  // 4. drafts — 草稿
  // ============================================================
  ipcMain.handle('db:draft-import-finalized-batch', async (
    _event,
    request: FinalizedDraftImportRequest,
    expectedProjectPath: string,
  ) => {
    const currentProjectPath = getCurrentProjectPath()
    assertRequiredExpectedProjectPath(currentProjectPath, expectedProjectPath)
    if (!currentProjectPath) throw new Error('项目数据库未打开')
    return {
      success: true,
      receipt: FinalizedDraftImportRepository.commit(currentProjectPath, request),
    }
  })

  ipcMain.handle('db:draft-create', async (_event, params: {
    chapterNumber: number
    version: number
    source: 'write' | 'rewrite'
    content: string
    wordCount: number
  }, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      const id = DraftRepository.create(params)
      return { success: true, id }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:draft-list', async (_event, chapterNumber: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return DraftRepository.listByChapter(chapterNumber)
  })

  ipcMain.handle('db:draft-list-all', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return DraftRepository.listAll()
  })

  ipcMain.handle('db:draft-get-meta', async (_event, id: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return DraftRepository.getMeta(id)
  })

  ipcMain.handle('db:draft-get-full', async (_event, id: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return DraftRepository.getFull(id)
  })

  ipcMain.handle('db:draft-get-latest', async (_event, chapterNumber: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return DraftRepository.getLatestByChapter(chapterNumber)
  })

  ipcMain.handle('db:draft-get-finalized', async (_event, chapterNumber: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return DraftRepository.getFinalizedByChapter(chapterNumber)
  })

  ipcMain.handle('db:draft-get-max-finalized-chapter', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return DraftRepository.getMaxFinalizedChapter()
  })

  ipcMain.handle('db:draft-authority-sequence', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return FinalizedDraftImportRepository.authoritySequence()
  })

  ipcMain.handle('db:continuity-save-finalized', async (_event, request, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      SummaryRepository.saveFinalizedContinuity(request)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:continuity-list-before', async (_event, chapterNumber: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return SummaryRepository.listFinalizedContinuityBefore(chapterNumber)
  })

  ipcMain.handle('db:consistency-exemption-list', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ConsistencyExemptionRepository.list()
  })

  ipcMain.handle('db:consistency-exemption-save', async (_event, stableFactKey: string, reason: string, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      ConsistencyExemptionRepository.save(stableFactKey, reason)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('db:consistency-exemption-revoke', async (_event, stableFactKey: string, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      ConsistencyExemptionRepository.revoke(stableFactKey)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('db:draft-next-version', async (_event, chapterNumber: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return DraftRepository.getNextVersion(chapterNumber)
  })

  ipcMain.handle('db:draft-update-status', async (_event, id: number, status: string, wordCount: number | undefined, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      DraftRepository.updateStatus(id, status, wordCount)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:draft-update-content', async (_event, id: number, content: string, wordCount: number, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      const draft = DraftRepository.getMeta(id)
      if (!draft) throw new Error(`草稿不存在：${id}`)
      if (draft.status === 'finalized') {
        throw new Error('已定稿正文为只读内容，不能再修改')
      }
      DraftRepository.updateContent(id, content, wordCount)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:draft-delete', async (_event, id: number, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      DraftRepository.delete(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:finalization-link-knowledge-document', async (
    _event,
    draftId: number,
    documentId: string,
    expectedProjectPath: string,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      return {
        success: true,
        finalization: FinalizationRepository.linkKnowledgeDocument(draftId, documentId),
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ============================================================
  // 5. revisions — 修稿
  // ============================================================
ipcMain.handle('db:revision-create', async (_event, params: {
    baseDraftId: number
    revisionType: 'refine' | 'review-fix'
    userPrompt?: string
    reviewSourceId?: number
    content: string
    wordCount: number
  }, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      const created = RevisionRepository.create(params)
      return { success: true, id: created.id, revisionIndex: created.revisionIndex }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:revision-replace-pending', async (_event, params: {
    baseDraftId: number
    revisionType: 'refine' | 'review-fix'
    userPrompt?: string
    reviewSourceId?: number
    content: string
    wordCount: number
  }, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      const created = RevisionRepository.replacePending(params)
      return { success: true, id: created.id, revisionIndex: created.revisionIndex }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:revision-list', async (_event, baseDraftId: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return RevisionRepository.listByDraft(baseDraftId)
  })

  ipcMain.handle('db:revision-get-pending', async (_event, baseDraftId: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return RevisionRepository.getPending(baseDraftId)
  })

  ipcMain.handle('db:revision-get-full', async (_event, id: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return RevisionRepository.getFull(id)
  })

  ipcMain.handle('db:revision-next-index', async (_event, baseDraftId: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return RevisionRepository.getNextIndex(baseDraftId)
  })

  ipcMain.handle('db:revision-mark-merged', async (_event, id: number, mergedToDraftId: number, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      RevisionRepository.markMerged(id, mergedToDraftId)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:revision-mark-discarded', async (_event, id: number, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      RevisionRepository.markDiscarded(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ============================================================
  // 6. reviews — 审稿
  // ============================================================
  ipcMain.handle('db:review-create', async (_event, params: {
    baseDraftId: number
    reviewIndex: number
    content: string
  }, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      const id = ReviewRepository.create(params)
      return { success: true, id }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:review-list', async (_event, baseDraftId: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ReviewRepository.listByDraft(baseDraftId)
  })

  ipcMain.handle('db:review-get-latest', async (_event, baseDraftId: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ReviewRepository.getLatestByDraft(baseDraftId)
  })

  ipcMain.handle('db:review-get-full', async (_event, id: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ReviewRepository.getFull(id)
  })

  ipcMain.handle('db:review-next-index', async (_event, baseDraftId: number, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return ReviewRepository.getNextIndex(baseDraftId)
  })

  // ============================================================
  // 7. post_process — 后处理跑批
  // ============================================================
  ipcMain.handle('db:post-process-create-run', async (
    _event,
    params: {
      triggerSourceType: string
      triggerSourceId: string
      sourceLabel: string
      steps: Array<{ key: string; label: string; critical: boolean }>
    },
    expectedProjectPath: string,
  ) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      const id = PostProcessRepository.createRun(params)
      return { success: true, id }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:post-process-get-latest-run', async (_event, sourceType: string, sourceId: string, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return PostProcessRepository.getLatestRun(sourceType, sourceId)
  })

  ipcMain.handle('db:post-process-get-steps', async (_event, runId: string, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return PostProcessRepository.getSteps(runId)
  })

  ipcMain.handle('db:post-process-mark-step-ok', async (_event, runId: string, stepKey: string, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      PostProcessRepository.markStepOk(runId, stepKey)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:post-process-mark-step-failed', async (_event, runId: string, stepKey: string, errorMsg: string, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      PostProcessRepository.markStepFailed(runId, stepKey, errorMsg)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:post-process-is-all-passed', async (_event, sourceType: string, sourceId: string, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return PostProcessRepository.isAllCriticalPassed(sourceType, sourceId)
  })

  // ============================================================
  // 沿用旧表
  // ============================================================
  ipcMain.handle('db:log-llm-call', async (_event, call, expectedProjectPath: string) => {
    try {
      assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
      LLMHistoryRepository.logCall(call)
      return { success: true }
    } catch (error) {
      console.error('[db:log-llm-call] Error:', error)
      return { success: false }
    }
  })

  ipcMain.handle('db:get-llm-stats', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return LLMHistoryRepository.getStats()
  })

  ipcMain.handle('db:get-llm-history', async (_event, limit: number | undefined, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return LLMHistoryRepository.getHistory(limit ?? 50)
  })

  ipcMain.handle('db:save-summary-snapshot', async (_event, chapterNumber: number, characterStates: string, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    SummaryRepository.saveSnapshot(chapterNumber, characterStates)
    return { success: true }
  })

  ipcMain.handle('db:get-latest-summary', async (_event, expectedProjectPath: string) => {
    assertRequiredExpectedProjectPath(getCurrentProjectPath(), expectedProjectPath)
    return SummaryRepository.getLatestSnapshot()
  })
}
