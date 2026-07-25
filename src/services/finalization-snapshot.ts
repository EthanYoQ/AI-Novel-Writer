import type { ProjectSessionContext } from '../shared/ipc-channels'
import {
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../shared/project-session-context'
import type { EditorTab } from '../stores/editor-store'

export type FinalizationPublicationStatus = 'pending' | 'published'

/**
 * 定稿输入在用户确认时冻结：后续异步流程只能消费这里的内容与会话，
 * 不允许回读数据库正文来替换编辑器可见内容。
 */
export interface FinalizationSnapshot {
  tabId: string
  projectPath: string
  projectSession: ProjectSessionContext
  draftId: number
  chapterNumber: number
  chapterTitle: string
  content: string
  contentRevision: number
}

export interface FinalizationCompletion {
  finalizationId: string
  contentHash: string
  contentRevision: number
  draftId: number
  projectPath: string
  projectSession: ProjectSessionContext
  publicationStatus: FinalizationPublicationStatus
}

export function captureFinalizationSnapshot(input: {
  tab: EditorTab
  projectSession: ProjectSessionContext
  chapterTitle: string
}): FinalizationSnapshot {
  const { tab, projectSession, chapterTitle } = input
  if (!tab.projectKey || !sameProjectPathKey(tab.projectKey, projectSession.projectPath)) {
    throw new Error('定稿目标不属于当前项目会话')
  }
  if (!Number.isInteger(tab.draftId) || tab.draftId === undefined) {
    throw new Error('定稿目标缺少草稿身份')
  }
  if (!Number.isInteger(tab.chapterNumber) || tab.chapterNumber === undefined) {
    throw new Error('定稿目标缺少章节身份')
  }

  const frozenSession = Object.freeze({ ...projectSession })
  return Object.freeze({
    tabId: tab.id,
    projectPath: tab.projectKey,
    projectSession: frozenSession,
    draftId: tab.draftId,
    chapterNumber: tab.chapterNumber,
    chapterTitle,
    content: tab.content ?? '',
    contentRevision: tab.contentRevision ?? 0,
  })
}

/**
 * 纯 reconciliation seam：只有仍是同一个项目会话、同一草稿、同一修订且正文未变
 * 的 tab 才能被旧完成事件结算为已定稿。否则保留用户后续输入并记录冲突。
 */
export function reconcileFinalizationCompletion(
  tab: EditorTab,
  snapshot: FinalizationSnapshot,
  completion: FinalizationCompletion,
): EditorTab {
  const sameTarget = (
    tab.id === snapshot.tabId
    && tab.draftId === snapshot.draftId
    && tab.projectSessionLease === snapshot.projectSession.leaseId
    && sameProjectPathKey(tab.projectKey, snapshot.projectPath)
    && sameProjectSessionContext(snapshot.projectSession, completion.projectSession)
    && sameProjectPathKey(completion.projectPath, snapshot.projectPath)
    && completion.draftId === snapshot.draftId
    && completion.contentRevision === snapshot.contentRevision
  )
  if (!sameTarget) return tab

  const snapshotStillCurrent = (
    (tab.contentRevision ?? 0) === snapshot.contentRevision
    && (tab.content ?? '') === snapshot.content
  )
  if (!snapshotStillCurrent) {
    return {
      ...tab,
      dirty: true,
      finalizationId: completion.finalizationId,
      finalizationPublication: completion.publicationStatus,
      finalizationConflict: {
        finalizationId: completion.finalizationId,
        publicationStatus: completion.publicationStatus,
      },
    }
  }

  return {
    ...tab,
    savedContent: snapshot.content,
    dirty: false,
    draftStatus: 'finalized',
    finalizationId: completion.finalizationId,
    finalizationPublication: completion.publicationStatus,
    finalizationConflict: undefined,
  }
}
