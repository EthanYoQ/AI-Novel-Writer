import type { ReopenChapterRequest, ReopenChapterResult } from '../shared/chapter-reopen'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { useWorkflowStore, workflowResourceKey } from '../stores/workflow-store'
import { ipc } from './ipc-client'

/**
 * 渲染端重开已定稿一章的唯一入口（ADR-0024）：「重新打开修改」与定稿章的「回退到此版本」都走这里。
 * 本章还有工作流在写（写稿、审稿、修稿、定稿或后处理）时不重开，等它结束再来。
 */
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
