import type { ProjectSessionContext } from '../shared/ipc-channels'
import { getActiveProjectSessionContext, sameProjectSessionContext } from '../shared/project-session-context'
import { readDraftBody, type DraftMeta } from './draft-store'
import { useEditorStore } from './editor-store'

/**
 * 读出一稿正文，打开它的标签或切到已开的标签。章节列表与导航都走这里。
 * 读取期间项目会话变了，或调用方已不再需要这次打开（stillWanted 返回 false）时放弃，返回 false。
 */
export async function openDraftTab(
  draft: DraftMeta,
  name: string,
  session: ProjectSessionContext,
  stillWanted: () => boolean = () => true,
): Promise<boolean> {
  const content = await readDraftBody(draft.filePath, session.projectPath, session)
  if (!stillWanted() || !sameProjectSessionContext(session, getActiveProjectSessionContext())) return false
  useEditorStore.getState().openFile({
    id: draft.filePath,
    name,
    type: 'chapter',
    filePath: draft.filePath,
    content,
    savedContent: content,
    draftId: draft.id,
    chapterNumber: draft.chapterNumber,
    draftStatus: draft.status,
    projectKey: session.projectPath,
    projectSessionLease: session.leaseId,
  })
  return true
}
