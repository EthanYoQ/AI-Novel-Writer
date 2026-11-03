import type { ReopenChapterRequest, ReopenChapterResult } from '../shared/chapter-reopen'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { useWorkflowStore, workflowResourceKey } from '../stores/workflow-store'
import { ipc } from './ipc-client'

export async function reopenFinalizedChapter(
  session: ProjectSessionContext,
  request: ReopenChapterRequest,
): Promise<ReopenChapterResult> {
  const busy = useWorkflowStore.getState().getResourceConflict({
    projectPath: session.projectPath,
    readResourceKeys: [workflowResourceKey('chapter', request.chapterNumber)],
  })
  if (busy) return { success: false, error: 'CHAPTER_REOPEN_BUSY' }
  return ipc.invokeWithProjectSession(session, 'chapter:reopen', request, session.projectPath)
}
