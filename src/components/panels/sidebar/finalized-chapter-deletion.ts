import type { ProjectData, ProjectSessionContext } from '../../../shared/ipc-channels'
import type { ChapterDeletionResult } from '../../../shared/chapter-deletion'
import { globalEventBus } from '../../../shared/event-bus'
import { ipc } from '../../../services/ipc-client'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { confirm } from '../../ui/Confirm'
import { toast } from '../../ui/Toast'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../../project-session-gate'

type SessionProject = Pick<ProjectData, 'id' | 'path' | 'sessionLease'>

interface DeleteFinalizedChapterInput {
  project: SessionProject | null | undefined
  projectPath: string
  draftId: number
  chapterNumber: number
  displayName: string
  tabFilePath: string
  surface: 'draft' | 'manuscript'
  reloadDrafts: 'chapter' | 'all'
  afterCommit?: (
    projectSession: ProjectSessionContext,
    result: ChapterDeletionResult,
  ) => void | Promise<void>
}

/**
 * Shared renderer action for the finalized-chapter lifecycle command.
 * Both sidebar surfaces use the same confirmation, session gate, refresh,
 * partial-cleanup reporting, and tab cleanup behavior.
 */
export async function deleteFinalizedChapter(
  input: DeleteFinalizedChapterInput,
): Promise<ChapterDeletionResult | null> {
  const text = useLocaleStore.getState().text
  const projectSession = captureProjectSession(input.project)
  if (!projectSession || !isProjectSessionPath(projectSession, input.projectPath)) return null

  const fromDraftBox = input.surface === 'draft'
  const ok = await confirm(
    fromDraftBox
      ? text(
          `确认删除 "${input.displayName}"？\n此操作会删除定稿事实，并清理实体稿、知识库和后处理投影；失败的投影清理可在正文章节下重试。`,
          `Delete “${input.displayName}”?\nThis removes the finalized fact and cleans its manuscript, knowledge, and post-processing projections. Failed cleanup can be retried below Manuscript chapters.`,
        )
      : text(
          `确认删除正文「${input.displayName}」？\n此操作会删除定稿事实，并清理实体稿、知识库和后处理投影；蓝图会保留。清理失败时可在正文章节下重试。`,
          `Delete manuscript “${input.displayName}”?\nThis removes the finalized fact and cleans its manuscript file, knowledge document, and post-processing projections. The blueprint is preserved, and failed cleanup can be retried below Manuscript chapters.`,
        ),
    {
      title: fromDraftBox ? text('删除这一稿', 'Delete draft') : text('删除正文', 'Delete manuscript'),
      confirmText: text('删除', 'Delete'),
      danger: true,
    },
  )
  if (!ok || !isProjectSessionCurrent(projectSession)) return null

  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'chapter:delete-finalized',
    { draftId: input.draftId, chapterNumber: input.chapterNumber },
    input.projectPath,
  )
  if (!isProjectSessionCurrent(projectSession)) return null
  if (!result.committed) {
    toast.error(text(
      `删除失败\n\n${result.error ?? '未知错误'}`,
      `Delete failed\n\n${result.error ?? 'Unknown error'}`,
    ))
    return result
  }

  const editor = useEditorStore.getState()
  const tab = editor.tabs.find(candidate =>
    candidate.projectKey === input.projectPath
    && (candidate.id === input.tabFilePath || candidate.filePath === input.tabFilePath)
  )
  if (tab) editor.closeTab(tab.id)

  if (input.reloadDrafts === 'all') {
    await useDraftStore.getState().loadAllDrafts(input.projectPath, projectSession)
  } else {
    await useDraftStore.getState().loadChapterDrafts(
      input.chapterNumber,
      input.projectPath,
      projectSession,
    )
  }
  if (!isProjectSessionCurrent(projectSession)) return null

  globalEventBus.emit('REFRESH_RESOURCE', {
    resources: ['drafts', 'fileTree'],
    projectPath: input.projectPath,
    projectSession,
  })
  await input.afterCommit?.(projectSession, result)
  if (!isProjectSessionCurrent(projectSession)) return null

  if (result.success) {
    toast.success(fromDraftBox
      ? text(`已删除 ${input.displayName}`, `Deleted ${input.displayName}`)
      : text(
          `已删除正文「${input.displayName}」及其派生投影`,
          `Deleted manuscript “${input.displayName}” and its derived projections.`,
        ))
  } else {
    toast.warning(fromDraftBox
      ? text(
          `正文已删除，但派生投影仍待清理：${result.error ?? '未知错误'}。请在正文章节下使用“重试清理”。`,
          `The manuscript fact was deleted, but derived projections still need cleanup: ${result.error ?? 'Unknown error'}. Use “Retry cleanup” below Manuscript chapters.`,
        )
      : text(
          `正文已删除，但派生投影仍待清理：${result.error ?? '未知错误'}。请使用“重试清理”。`,
          `The manuscript fact was deleted, but derived projections still need cleanup: ${result.error ?? 'Unknown error'}. Use “Retry cleanup”.`,
        ), 8000)
  }
  return result
}
