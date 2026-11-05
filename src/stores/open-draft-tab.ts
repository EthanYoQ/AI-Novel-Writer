import type { ProjectSessionContext } from '../shared/ipc-channels'
import { getActiveProjectSessionContext, sameProjectSessionContext } from '../shared/project-session-context'
import { readDraftBody, type DraftMeta } from './draft-store'
import { useEditorStore } from './editor-store'

/**
 * 从回收站恢复时实体稿没写出的定稿：会话租约与稿号 → finalizationId。
 * 普通定稿时这两项直接写在标签上；恢复时这一章的标签还没开，先记在这里，打开时交给标签，「重新写入正文」才有可重试的定稿。
 */
const pendingPublications = new Map<string, string>()
const publicationKey = (session: ProjectSessionContext, draftId: number) => `${session.leaseId}\n${draftId}`

export function rememberPendingPublication(session: ProjectSessionContext, draftId: number, finalizationId: string): void {
  pendingPublications.set(publicationKey(session, draftId), finalizationId)
}

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
  const key = publicationKey(session, draft.id)
  const finalizationId = pendingPublications.get(key)
  pendingPublications.delete(key)
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
    ...(finalizationId ? { finalizationId, finalizationPublication: 'pending' as const } : {}),
  })
  return true
}
