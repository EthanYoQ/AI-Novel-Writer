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
  const consequence = '删除后无法恢复，后面的章节可能也要跟着改写。\n只想修改这一章，请取消，点「重新打开修改」或「打开重开稿」。'
  const consequenceEn = 'This cannot be undone, and later chapters may need rewriting too.\nTo change only this chapter, cancel and choose “Reopen to edit” or “Open reopened draft”.'
  const partialFailure = (error: string) => text(
    `这一章已从作品里删除，但项目文件夹里的正文文件或知识库里的这一章还没清理完：${error}。请${retryWhere}点「重试清理」。`,
    `The chapter is removed from the book, but its manuscript file in the project folder or its knowledge base entry is not fully cleaned up: ${error}. Choose “Retry cleanup” ${retryWhereEn}.`,
  )
  const configs: Record<DeletionSurface, DeletionSurfaceConfig> = {
    draft: {
      confirmation: text(
        `确认删除 "${displayName}"？\n${consequence}`,
        `Delete “${displayName}”?\n${consequenceEn}`,
      ),
      confirmationTitle: text('删除这一稿', 'Delete draft'),
      success: text(`已删除 ${displayName}`, `Deleted ${displayName}`),
      partialFailure,
      refreshDrafts: (projectPath, chapterNumber, projectSession) => (
        useDraftStore.getState().loadChapterDrafts(chapterNumber, projectPath, projectSession)
      ),
    },
    manuscript: {
      confirmation: text(
        `确认删除正文「${displayName}」？\n${consequence}`,
        `Delete manuscript “${displayName}”?\n${consequenceEn}`,
      ),
      confirmationTitle: text('删除正文', 'Delete manuscript'),
      success: text(`已删除正文「${displayName}」`, `Deleted manuscript “${displayName}”.`),
      partialFailure,
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
    '这一章是旧版本定稿的，书童认不出知识库里哪份资料属于它，所以那份资料不会替你删，来源不明的参考资料也不会动。书童认得出的这一章的资料，继续删除时会一并删掉。请先到知识库里检查，删掉这一章留下、书童认不出的资料，再点「我已人工核对/清理，继续删除」。',
    'This chapter was finalized by an older version, so Pagekin cannot tell which knowledge base entry belongs to it. Pagekin will not remove that entry for you, and it leaves reference documents of unknown origin alone. Entries it can identify as this chapter’s are removed when you continue. Check the knowledge base and remove what this chapter left there that Pagekin cannot identify, then choose “I have checked; continue deletion”.',
  ), {
    title: text('先检查知识库', 'Check the knowledge base first'),
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
