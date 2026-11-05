import type { RestoreTrashedChapterResult, TrashedChapter } from '../../../shared/chapter-deletion'
import { globalEventBus } from '../../../shared/event-bus'
import type { ProjectData, ProjectSessionContext } from '../../../shared/ipc-channels'
import { formatResourceUri } from '../../../shared/project-paths'
import { ipc } from '../../../services/ipc-client'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { useDraftStore } from '../../../stores/draft-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { confirmLegacyKnowledgeAbsentAndContinue } from '../../panels/sidebar/finalized-chapter-deletion'
import { toast } from '../../ui/Toast'
import { announceTrashChanged } from './use-chapter-trash'

type Text = (zh: string, en: string) => string
type Restored = Exclude<RestoreTrashedChapterResult, { success: false }>

export function trashEntryName(entry: Pick<TrashedChapter, 'chapterNumber' | 'chapterTitle'>, text: Text): string {
  return entry.chapterTitle
    ? text(`第 ${entry.chapterNumber} 章「${entry.chapterTitle}」`, `Chapter ${entry.chapterNumber} “${entry.chapterTitle}”`)
    : text(`第 ${entry.chapterNumber} 章`, `Chapter ${entry.chapterNumber}`)
}

/**
 * 恢复成功后的说明。放回原位时，删除那会儿作者在软件外改过的 txt 是留着的（ADR-0025 第 8 条），
 * 重发的实体稿换了文件名；主进程不告诉界面这次有没有发生，所以按条件说。
 */
export function restoredMessage(result: Restored, text: Text): string {
  const n = result.chapterNumber
  switch (result.outcome) {
    case 'restored': {
      const lines = [
        text(`已恢复第 ${n} 章，正文和全部版本都回来了。知识库里的这一章要重新收进去：打开这一章，在「定稿后处理」里点「重试」。`,
          `Chapter ${n} is restored, with its text and every version. Its knowledge base entry needs adding again: open the chapter and choose “Retry” under After finalization.`),
      ]
      if (result.publicationError) {
        lines.push(text('实体稿 txt 这次没写出来，在同一处点「重新写入正文」。',
          'Its manuscript file was not written this time. Choose “Write again” in the same place.'))
      }
      lines.push(text('如果删除前你在软件外改过这一章的 txt，那份文件当时留着没删；恢复的正文写进了另一个带编号的文件名，两份都在项目文件夹里，不需要的那份请自己删掉。',
        'If you edited this chapter’s manuscript file outside Pagekin before deleting it, that file was kept. The restored text went into a file with a numbered name, so both are in the project folder; delete the one you do not need.'))
      return lines.join('\n')
    }
    case 'restored-as-history':
      return text(`第 ${n} 章已经重写过。回收站里的版本已作为旧版本放回这一章。想换回它，在「版本历史」里选中它，点「回退到此版本…」。`,
        `Chapter ${n} has been rewritten. The version from the trash is back as an older version of this chapter. To switch back to it, select it in Version history and choose “Revert to this version…”.`)
    case 'reopened-as-draft':
      return result.created
        ? text(`已用回收站里的第 ${n} 章开了一份新草稿，正文和删除前一样。这份作品是从别处导入的，旧定稿不能直接复原，请检查后点「定稿」。`,
            `A new draft of chapter ${n} was opened from the trash, with the same text as before it was deleted. This book was imported from elsewhere, so the old final version cannot be put back directly. Check it, then choose “Finalize”.`)
        : text(`第 ${n} 章已有一份和回收站里正文相同的草稿，没有再开新的。请打开这一章检查后点「定稿」。`,
            `Chapter ${n} already has a draft with the same text as the one in the trash, so no new draft was opened. Open the chapter, check it, then choose “Finalize”.`)
    case 'already-restored':
      return text(`第 ${n} 章已经恢复过了，回收站里没有这一项了。`, `Chapter ${n} was already restored and is no longer in the trash.`)
  }
}

function refreshAfterTrashChange(session: ProjectSessionContext): void {
  announceTrashChanged(session)
  void useDraftStore.getState().loadAllDrafts(session.projectPath, session)
  globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts', 'fileTree', 'blueprints'], projectPath: session.projectPath, projectSession: session })
}

function currentSession(): ProjectSessionContext | null {
  return captureProjectSession(useProjectStore.getState().currentProject)
}

const reasonOf = (error: string | undefined) => displayedErrorMessage(useLocaleStore.getState().locale, error)

/** 按列表给的恢复方式恢复回收站里的一项。返回是否恢复成功。 */
export async function restoreTrashedChapter(entry: TrashedChapter): Promise<boolean> {
  const text = useLocaleStore.getState().text
  const session = currentSession()
  if (!session) return false
  const result = await ipc.invokeWithProjectSession(session, 'chapter:trash-restore',
    { deletionId: entry.deletionId, draftId: entry.draftId, expectedMode: entry.restoreMode }, session.projectPath)
  if (!isProjectSessionCurrent(session)) return false
  refreshAfterTrashChange(session)
  if (!result.success) {
    toast.error(text(`${trashEntryName(entry, text)}没有恢复\n\n${reasonOf(result.error)}`,
      `${trashEntryName(entry, text)} was not restored\n\n${reasonOf(result.error)}`), 10000)
    return false
  }
  const message = restoredMessage(result, text)
  if (result.outcome === 'restored' && result.publicationError) toast.warning(message, 12000)
  else toast.success(message, result.outcome === 'already-restored' ? 4000 : 12000)
  return true
}

/** 彻底删除指定的项，或清空回收站。确认由调用方先做。 */
export async function purgeTrash(target: TrashedChapter | { deletionId: string } | 'all'): Promise<boolean> {
  const text = useLocaleStore.getState().text
  const session = currentSession()
  if (!session) return false
  const request = target === 'all' ? { all: true as const } : { deletionIds: [target.deletionId] }
  const result = await ipc.invokeWithProjectSession(session, 'chapter:trash-purge', request, session.projectPath)
  if (!isProjectSessionCurrent(session)) return false
  refreshAfterTrashChange(session)
  if (!result.success) {
    toast.error(text(`彻底删除没有完成\n\n${reasonOf(result.error)}`, `Permanent deletion did not finish\n\n${reasonOf(result.error)}`))
    return false
  }
  toast.success(target === 'all'
    ? text('已清空回收站。', 'The trash is empty.')
    : 'chapterNumber' in target
      ? text(`已彻底删除${trashEntryName(target, text)}。`, `${trashEntryName(target, text)} was deleted permanently.`)
      : text('已彻底删除这一项。', 'The item was deleted permanently.'))
  return true
}

/** 续跑这次删除没做完的实体稿与知识库清理；旧版定稿要先确认人工核对过知识库。 */
export async function retryTrashCleanup(entry: TrashedChapter): Promise<void> {
  const text = useLocaleStore.getState().text
  const project: ProjectData | null = useProjectStore.getState().currentProject
  const session = currentSession()
  if (!project || !session) return
  if (entry.cleanup === 'authorization_required') {
    await confirmLegacyKnowledgeAbsentAndContinue({
      project, projectPath: session.projectPath, draftId: entry.draftId, chapterNumber: entry.chapterNumber,
      displayName: trashEntryName(entry, text), tabFilePath: formatResourceUri({ kind: 'manuscript', id: entry.draftId }), surface: 'manuscript',
    }, entry.deletionId)
    if (isProjectSessionCurrent(session)) announceTrashChanged(session)
    return
  }
  const result = await ipc.invokeWithProjectSession(session, 'chapter:retry-deletion', entry.deletionId, session.projectPath)
  if (!isProjectSessionCurrent(session)) return
  refreshAfterTrashChange(session)
  if (result.success) {
    toast.success(text(`${trashEntryName(entry, text)}的清理完成了，现在可以恢复。`, `Cleanup for ${trashEntryName(entry, text)} is done. It can be restored now.`))
  } else {
    toast.error(text(`重试清理没有完成\n\n${reasonOf(result.error)}`, `Cleanup retry did not finish\n\n${reasonOf(result.error)}`))
  }
}
