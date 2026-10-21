import type { ProjectData, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { ChapterDeletionResult } from '../../../shared/chapter-deletion'
import { globalEventBus } from '../../../shared/event-bus'
import { ipc } from '../../../services/ipc-client'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { confirm } from '../../ui/Confirm'
import { toast } from '../../ui/Toast'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../../project-session-gate'

type SessionProject = Pick<ProjectData, 'id' | 'path' | 'sessionLease'>
type DeletionSurface = 'draft' | 'manuscript'
type Localize = (chinese: string, english: string) => string

interface DeleteFinalizedChapterInput {
  project: SessionProject | null | undefined
  projectPath: string
  draftId: number
  chapterNumber: number
  displayName: string
  tabFilePath: string
  surface: DeletionSurface
}

interface DeletionSurfaceConfig {
  confirmation: string
  confirmationTitle: string
  success: string
  partialFailure: (error: string) => string
  refreshDrafts: (
    projectPath: string,
    chapterNumber: number,
    projectSession: ProjectSessionContext,
  ) => Promise<void>
}

function deletionSurfaceConfig(
  surface: DeletionSurface,
  displayName: string,
  text: Localize,
): DeletionSurfaceConfig {
  // 清理没做完时，在这一章的单章视图里提示重试。
  const retryWhere = '在这一章的页面里'
  const retryWhereEn = 'on this chapter’s page'
  const configs: Record<DeletionSurface, DeletionSurfaceConfig> = {
    draft: {
      confirmation: text(
        `确认删除 "${displayName}"？\n此操作会删除定稿事实，并清理实体稿、知识库和后处理投影；失败的投影清理可${retryWhere}重试。`,
        `Delete “${displayName}”?\nThis removes the finalized fact and cleans its manuscript, knowledge, and post-processing projections. Failed cleanup can be retried ${retryWhereEn}.`,
      ),
      confirmationTitle: text('删除这一稿', 'Delete draft'),
      success: text(`已删除 ${displayName}`, `Deleted ${displayName}`),
      partialFailure: error => text(
        `正文已删除，但派生投影仍待清理：${error}。请${retryWhere}使用“重试清理”。`,
        `The manuscript fact was deleted, but derived projections still need cleanup: ${error}. Use “Retry cleanup” ${retryWhereEn}.`,
      ),
      refreshDrafts: (projectPath, chapterNumber, projectSession) => (
        useDraftStore.getState().loadChapterDrafts(chapterNumber, projectPath, projectSession)
      ),
    },
    manuscript: {
      confirmation: text(
        `确认删除正文「${displayName}」？\n此操作会删除定稿事实，并清理实体稿、知识库和后处理投影；蓝图会保留。清理失败时可${retryWhere}重试。`,
        `Delete manuscript “${displayName}”?\nThis removes the finalized fact and cleans its manuscript file, knowledge document, and post-processing projections. The blueprint is preserved, and failed cleanup can be retried ${retryWhereEn}.`,
      ),
      confirmationTitle: text('删除正文', 'Delete manuscript'),
      success: text(
        `已删除正文「${displayName}」及其派生投影`,
        `Deleted manuscript “${displayName}” and its derived projections.`,
      ),
      partialFailure: error => text(
        `正文已删除，但派生投影仍待清理：${error}。请${retryWhere}使用“重试清理”。`,
        `The manuscript fact was deleted, but derived projections still need cleanup: ${error}. Use “Retry cleanup” ${retryWhereEn}.`,
      ),
      refreshDrafts: (projectPath, _chapterNumber, projectSession) => (
        useDraftStore.getState().loadAllDrafts(projectPath, projectSession)
      ),
    },
  }
  return configs[surface]
}

function emitDeletionStatusUpdated(
  projectPath: string,
  projectSession: ProjectSessionContext,
): void {
  globalEventBus.emit('CHAPTER_DELETION_UPDATED', { projectPath, projectSession })
}

function showUncommittedError(result: ChapterDeletionResult, text: Localize): void {
  const reason = displayedErrorMessage(useLocaleStore.getState().locale, result.error)
  toast.error(text(`删除失败\n\n${reason}`, `Delete failed\n\n${reason}`))
}

async function finishCommittedDeletion(
  input: DeleteFinalizedChapterInput,
  projectSession: ProjectSessionContext,
  result: ChapterDeletionResult,
  config: DeletionSurfaceConfig,
): Promise<ChapterDeletionResult | null> {
  const editor = useEditorStore.getState()
  const tab = editor.tabs.find(candidate =>
    candidate.projectKey === input.projectPath
    && (candidate.id === input.tabFilePath || candidate.filePath === input.tabFilePath)
  )
  if (tab) editor.closeTab(tab.id)

  await config.refreshDrafts(input.projectPath, input.chapterNumber, projectSession)
  if (!isProjectSessionCurrent(projectSession)) return null
  globalEventBus.emit('REFRESH_RESOURCE', {
    resources: ['drafts', 'fileTree'],
    projectPath: input.projectPath,
    projectSession,
  })

  if (result.success) {
    toast.success(config.success)
  } else {
    toast.warning(config.partialFailure(displayedErrorMessage(useLocaleStore.getState().locale, result.error)), 8000)
  }
  return result
}

async function confirmLegacyKnowledgeAbsent(
  input: DeleteFinalizedChapterInput,
  operationId: string,
  projectSession: ProjectSessionContext,
  config: DeletionSurfaceConfig,
  text: Localize,
): Promise<ChapterDeletionResult | null> {
  const confirmed = await confirm(text(
    '此旧定稿没有可验证的知识文档 ID。只有在我已人工核对/清理，并确认该定稿没有需要应用自动删除的知识投影时，才能继续；应用不会删除来源不明的 reference 文档。',
    'This legacy finalization has no verifiable knowledge document ID. Continue only if I have manually checked or cleaned the knowledge base and confirm there is no knowledge projection for the app to remove; the app will not delete reference documents of unknown provenance.',
  ), {
    title: text('确认旧定稿知识投影状态', 'Confirm legacy knowledge projection'),
    confirmText: text('我已人工核对/清理，继续删除', 'I have checked; continue deletion'),
    danger: true,
  })
  if (!confirmed || !isProjectSessionCurrent(projectSession)) return null

  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'chapter:confirm-legacy-knowledge-absent',
    operationId,
    input.projectPath,
  )
  if (!isProjectSessionCurrent(projectSession)) return null
  emitDeletionStatusUpdated(input.projectPath, projectSession)
  if (!result.committed) {
    showUncommittedError(result, text)
    return result
  }
  return finishCommittedDeletion(input, projectSession, result, config)
}

/** 删除已定稿的这一章：单章视图的章节操作直接调用，删除这一稿（draft-deletion）删到定稿时也走这里。 */
export async function deleteFinalizedChapter(
  input: DeleteFinalizedChapterInput,
): Promise<ChapterDeletionResult | null> {
  const text = useLocaleStore.getState().text
  const config = deletionSurfaceConfig(input.surface, input.displayName, text)
  const projectSession = captureProjectSession(input.project)
  if (!projectSession || !isProjectSessionPath(projectSession, input.projectPath)) return null

  const confirmed = await confirm(config.confirmation, {
    title: config.confirmationTitle,
    confirmText: text('删除', 'Delete'),
    danger: true,
  })
  if (!confirmed || !isProjectSessionCurrent(projectSession)) return null

  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'chapter:delete-finalized',
    { draftId: input.draftId, chapterNumber: input.chapterNumber },
    input.projectPath,
  )
  if (!isProjectSessionCurrent(projectSession)) return null
  emitDeletionStatusUpdated(input.projectPath, projectSession)
  if (result.operation?.legacyKnowledgeAuthorization === 'required') {
    return confirmLegacyKnowledgeAbsent(
      input,
      result.operation.operationId,
      projectSession,
      config,
      text,
    )
  }
  if (!result.committed) {
    showUncommittedError(result, text)
    return result
  }
  return finishCommittedDeletion(input, projectSession, result, config)
}

/** Resume a persisted legacy-provenance receipt from the Manuscript status row. */
export async function confirmLegacyKnowledgeAbsentAndContinue(
  input: DeleteFinalizedChapterInput,
  operationId: string,
): Promise<ChapterDeletionResult | null> {
  const text = useLocaleStore.getState().text
  const config = deletionSurfaceConfig(input.surface, input.displayName, text)
  const projectSession = captureProjectSession(input.project)
  if (!projectSession || !isProjectSessionPath(projectSession, input.projectPath)) return null
  return confirmLegacyKnowledgeAbsent(input, operationId, projectSession, config, text)
}
