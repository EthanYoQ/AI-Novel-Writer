import type { DraftMeta } from '../../../stores/draft-store'
import { useDraftStore } from '../../../stores/draft-store'
import { ipc } from '../../../services/ipc-client'
import { globalEventBus } from '../../../shared/event-bus'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useLocaleStore } from '../../../stores/locale-store'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { toast } from '../../ui/Toast'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../../project-session-gate'
import { deleteFinalizedChapter } from './finalized-chapter-deletion'

/**
 * 删除未定稿的一稿（连同它的审稿、修稿产物）。调用方先请作者确认，删除成功后自己处理打开的标签。
 * 这一稿其实已定稿时转交定稿删除流程（它有自己的确认与投影清理），此时返回 false。
 * 单章视图的章节操作用它。
 */
export async function deleteDraftVersion({ draft, displayName, projectKey, project }: {
  draft: DraftMeta
  displayName: string
  projectKey: string
  project: ProjectData | null
}): Promise<boolean> {
  const text = useLocaleStore.getState().text
  const finalizedDeletion = () => deleteFinalizedChapter({
    project,
    projectPath: projectKey,
    draftId: draft.id,
    chapterNumber: draft.chapterNumber,
    displayName,
    tabFilePath: draft.filePath,
    surface: 'draft',
  })
  const projectSession = captureProjectSession(project)
  if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return false
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-delete',
    draft.id,
    projectKey,
  )
  if (!isProjectSessionCurrent(projectSession)) return false
  if (result.errorCode === 'FINALIZED_DRAFT_DELETE_REQUIRED') {
    await useDraftStore.getState().loadChapterDrafts(
      draft.chapterNumber,
      projectKey,
      projectSession,
    )
    if (!isProjectSessionCurrent(projectSession)) return false
    await finalizedDeletion()
    return false
  }
  if (!result.success) {
    const reason = displayedErrorMessage(useLocaleStore.getState().locale, result.error)
    toast.error(text(`删除失败\n\n${reason}`, `Delete failed\n\n${reason}`))
    return false
  }
  await useDraftStore.getState().loadChapterDrafts(
    draft.chapterNumber,
    projectKey,
    projectSession,
  )
  if (!isProjectSessionCurrent(projectSession)) return false
  globalEventBus.emit('REFRESH_RESOURCE', {
    resources: ['drafts', 'fileTree'],
    projectPath: projectKey,
    projectSession,
  })
  toast.success(text(`已删除 ${displayName}`, `Deleted ${displayName}`))
  return true
}
