import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { ipc } from '../../services/ipc-client'
import { requireIpcSuccess } from '../../services/ipc-result'
import { useEditorStore } from '../../stores/editor-store'
import { clearChapterTitleCache } from './sidebar/manuscript-title-cache'
import { isProjectSessionCurrent } from '../project-session-gate'

interface PhysicalChapterSaveRequest {
  tabId: string
  filePath: string
  content: string
  projectSession: ProjectSessionContext
}

/**
 * Persist a physical manuscript file only for the lease that initiated the save.
 * The settled snapshot leaves subsequent editor changes dirty instead of falsely
 * marking a newer edit as saved.
 */
export async function savePhysicalChapterForSession(
  request: PhysicalChapterSaveRequest,
): Promise<boolean> {
  const { tabId, filePath, content, projectSession } = request
  if (!isProjectSessionCurrent(projectSession)) return false

  const tab = useEditorStore.getState().tabs.find(candidate => candidate.id === tabId)
  if (!tab || tab.projectKey !== projectSession.projectPath) return false
  const snapshot = {
    content,
    contentRevision: tab.contentRevision ?? 0,
  }

  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:write-file',
    filePath,
    content,
    projectSession.projectPath,
  )
  requireIpcSuccess(result, '保存章节文件')

  if (!isProjectSessionCurrent(projectSession)) return false
  useEditorStore.getState().settleTabSave(tabId, snapshot)
  clearChapterTitleCache(filePath)
  return true
}
