import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChapterDeletionOperation } from '../../../shared/chapter-deletion'
import { globalEventBus } from '../../../shared/event-bus'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { formatResourceUri } from '../../../shared/project-paths'
import { ipc } from '../../../services/ipc-client'
import { useLocaleStore } from '../../../stores/locale-store'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { useProjectStore } from '../../../stores/project-store'
import { toast } from '../../ui/Toast'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'
import { confirmLegacyKnowledgeAbsentAndContinue } from './finalized-chapter-deletion'

/**
 * 没做完的正文删除（F-070）：派生投影清理失败或待人工核对的操作，可以重试清理或确认人工核对后继续。
 * 删除清理提示（DeletionCleanupNotices）用它，待写视图与这一章其余未定稿的稿都挂着那块提示。
 */
export function useIncompleteDeletions(projectPath: string) {
  const text = useLocaleStore(s => s.text)
  const currentProject = useProjectStore(s => s.currentProject)
  const [state, setState] = useState<{ projectPath: string; operations: ChapterDeletionOperation[] }>({ projectPath: '', operations: [] })
  const loadSequence = useRef(0)
  const operations = state.projectPath === projectPath ? state.operations : []

  const fetchOperations = useCallback(async (projectSession: ProjectSessionContext) => {
    const requestId = ++loadSequence.current
    const result = await ipc.invokeWithProjectSession(projectSession, 'chapter:list-incomplete-deletions', projectPath)
    if (requestId !== loadSequence.current || !isProjectSessionCurrent(projectSession)) return null
    return result.success ? result.operations ?? [] : []
  }, [projectPath])

  const load = useCallback(async (projectSession: ProjectSessionContext) => {
    const next = await fetchOperations(projectSession)
    if (next !== null) setState({ projectPath, operations: next })
  }, [fetchOperations, projectPath])

  useEffect(() => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectPath)) return
    void fetchOperations(projectSession).then(next => {
      if (next !== null) setState({ projectPath, operations: next })
    })
  }, [currentProject, fetchOperations, projectPath])

  useEffect(() => globalEventBus.on('CHAPTER_DELETION_UPDATED', payload => {
    if (!isProjectSessionPath(payload.projectSession, projectPath) || !isProjectSessionCurrent(payload.projectSession)) return
    void load(payload.projectSession)
  }), [load, projectPath])

  const retryDeletion = async (operation: ChapterDeletionOperation) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectPath)) return
    const result = await ipc.invokeWithProjectSession(projectSession, 'chapter:retry-deletion', operation.operationId, projectPath)
    if (!isProjectSessionCurrent(projectSession)) return
    await load(projectSession)
    if (result.success) {
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts', 'fileTree'], projectPath, projectSession })
      toast.success(text(`第${operation.chapterNumber}章派生投影清理完成`, `Chapter ${operation.chapterNumber} projection cleanup completed.`))
    } else {
      const reason = displayedErrorMessage(useLocaleStore.getState().locale, result.error)
      toast.error(text(`重试清理失败\n\n${reason}`, `Cleanup retry failed\n\n${reason}`))
    }
  }

  const confirmLegacyDeletion = async (operation: ChapterDeletionOperation) => {
    const displayName = operation.chapterTitle
      ? text(`第${operation.chapterNumber}章 ${operation.chapterTitle}`, `Chapter ${operation.chapterNumber} ${operation.chapterTitle}`)
      : text(`第${operation.chapterNumber}章`, `Chapter ${operation.chapterNumber}`)
    await confirmLegacyKnowledgeAbsentAndContinue({
      project: currentProject,
      projectPath,
      draftId: operation.draftId,
      chapterNumber: operation.chapterNumber,
      displayName,
      tabFilePath: formatResourceUri({ kind: 'manuscript', id: operation.draftId }),
      surface: 'manuscript',
    }, operation.operationId)
  }

  return { operations, retryDeletion, confirmLegacyDeletion }
}
