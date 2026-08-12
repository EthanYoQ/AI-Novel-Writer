import { ipcMain } from 'electron'
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
import { RevisionRepository } from '../repositories/revision-repository'
import { ReviewRepository } from '../repositories/review-repository'
import { PostProcessRepository } from '../repositories/post-process-repository'

// 沿用的旧表
import { LLMHistoryRepository } from '../repositories/llm-repository'
import { SummaryRepository } from '../repositories/summary-repository'

type ProjectDatabaseHandler = (event: unknown, ...args: never[]) => unknown

const MUTATING_DATABASE_CHANNELS = new Set([
  'db:close',
  'db:project-core-update',
  'db:project-clear-generated-data',
  'db:blueprint-upsert',
  'db:blueprint-upsert-many',
  'db:blueprint-commit-range',
  'db:blueprint-character-sync-complete',
  'db:blueprint-update-notes',
  'db:blueprint-delete',
  'db:blueprint-clear-all',
  'db:character-roster-commit',
  'db:draft-create',
  'db:draft-update-status',
  'db:draft-update-content',
  'db:draft-delete',
  'db:revision-create',
  'db:revision-mark-merged',
  'db:revision-mark-discarded',
  'db:review-create',
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
      BlueprintRepository.updateNotes(chapterNumber, notes)
      return { success: true }
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
