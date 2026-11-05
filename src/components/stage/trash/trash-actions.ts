import type { RestoreTrashedChapterResult, TrashedChapter } from '../../../shared/chapter-deletion'
import { globalEventBus } from '../../../shared/event-bus'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { ipc } from '../../../services/ipc-client'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { pluralEn } from '../../../shared/plural-en'
import { useDraftStore } from '../../../stores/draft-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
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
        text(`已恢复第 ${n} 章的正文和全部版本。要重新收进知识库，请打开这一章，在「定稿后处理」点「重试」。`,
          `Chapter ${n} is restored with every version. To add it back to the knowledge base, open it and choose “Retry” under After finalization.`),
      ]
      if (result.publicationError) {
        lines.push(text('实体稿 txt 没写出来，在同一处点「重新写入正文」。',
          'Its manuscript file was not written. Choose “Write again” in the same place.'))
      }
      lines.push(text('如果删除前在软件外改过它的 txt，项目文件夹里会多一份，删掉不要的那份即可。',
        'If you edited its manuscript file outside Pagekin before deleting it, the project folder now has an extra copy. Delete the one you don’t need.'))
      return lines.join('\n')
    }
    case 'restored-as-history':
      return text(`第 ${n} 章已经重写过，回收站里的版本作为旧版本放回了。想换回它，在「版本历史」里选中它，点「回退到此版本…」。`,
        `Chapter ${n} was rewritten, so the version from the trash is back as an older version. To switch to it, select it in Version history and choose “Revert to this version…”.`)
    case 'reopened-as-draft':
      return result.created
        ? text(`已用回收站里的第 ${n} 章开了一份新草稿。导入的作品不能直接复原定稿，请检查后点「定稿」。`,
            `Opened a new draft of chapter ${n} from the trash. An imported book can’t get its old final version back directly. Check it, then choose “Finalize”.`)
        : text(`第 ${n} 章已有一份相同的草稿，没有再开新的。请检查后点「定稿」。`,
            `Chapter ${n} already has the same draft, so no new one was opened. Check it, then choose “Finalize”.`)
    case 'already-restored':
      return text(`第 ${n} 章已经恢复过了。`, `Chapter ${n} was already restored.`)
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

const INTERRUPTED = 'interrupted'

/** IPC 调用 reject（主进程没回话）时当作一次失败，原文可能带本机路径，不给作者看。 */
async function settled<T>(call: Promise<T>): Promise<T | { success: false; error: typeof INTERRUPTED }> {
  try {
    return await call
  } catch {
    return { success: false, error: INTERRUPTED }
  }
}

const reasonOf = (error: string | undefined) => {
  const { locale, text } = useLocaleStore.getState()
  return error === INTERRUPTED
    ? text('操作中断了，回收站已刷新，请看清现状后再试。', 'The action was interrupted. The trash was reloaded; check it and try again.')
    : displayedErrorMessage(locale, error)
}

/** 按列表给的恢复方式恢复回收站里的一项。返回是否恢复成功。 */
export async function restoreTrashedChapter(entry: TrashedChapter): Promise<boolean> {
  const text = useLocaleStore.getState().text
  const session = currentSession()
  if (!session) return false
  const result = await settled(ipc.invokeWithProjectSession(session, 'chapter:trash-restore',
    { deletionId: entry.deletionId, draftId: entry.draftId, expectedMode: entry.restoreMode }, session.projectPath))
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

/**
 * 彻底删除指定的项，或清空回收站。确认由调用方先做；session 与 emptying 都取自弹出确认框那一刻：
 * 之后换了作品就不删，之后才进回收站的项也不删。
 */
export async function purgeTrash(
  target: TrashedChapter | { deletionId: string } | { emptying: readonly string[] },
  session: ProjectSessionContext,
): Promise<boolean> {
  const text = useLocaleStore.getState().text
  if (!isProjectSessionCurrent(session)) return false
  const request = { deletionIds: 'emptying' in target ? [...target.emptying] : [target.deletionId] }
  const result = await settled(ipc.invokeWithProjectSession(session, 'chapter:trash-purge', request, session.projectPath))
  if (!isProjectSessionCurrent(session)) return false
  refreshAfterTrashChange(session)
  if (!result.success) {
    toast.error(text(`彻底删除没有完成\n\n${reasonOf(result.error)}`, `Permanent deletion did not finish\n\n${reasonOf(result.error)}`))
    return false
  }
  if ('emptying' in target) {
    const message = await emptiedMessage(session, result.purged.length, text)
    if (isProjectSessionCurrent(session)) toast.success(message)
    return true
  }
  toast.success('chapterNumber' in target
    ? text(`已彻底删除${trashEntryName(target, text)}。`, `${trashEntryName(target, text)} was deleted permanently.`)
    : text('已彻底删除这一项。', 'The item was deleted permanently.'))
  return true
}

/** 只删了确认时的那几项，确认之后又进来的还在，所以重读一次，真空了才说已清空。 */
async function emptiedMessage(session: ProjectSessionContext, purged: number, text: Text): Promise<string> {
  const left = await settled(ipc.invokeWithProjectSession(session, 'chapter:trash-list', session.projectPath))
  return left.success && left.entries.length + left.damaged.length === 0
    ? text('已清空回收站。', 'The trash is empty.')
    : text(`已彻底删除 ${purged} 项。`, `Deleted ${purged} ${pluralEn(purged, 'item')} permanently.`)
}

/**
 * 续跑这次删除没做完的实体稿与知识库清理。等待核对旧定稿知识库的删除还没进回收站
 * （chapter-deletion-repository 的 begin 与 confirmLegacyKnowledgeAbsent），这里不会遇到。
 */
export async function retryTrashCleanup(entry: TrashedChapter): Promise<void> {
  const text = useLocaleStore.getState().text
  const session = currentSession()
  if (!session) return
  const result = await settled(ipc.invokeWithProjectSession(session, 'chapter:retry-deletion', entry.deletionId, session.projectPath))
  if (!isProjectSessionCurrent(session)) return
  refreshAfterTrashChange(session)
  if (result.success) {
    toast.success(text(`${trashEntryName(entry, text)}的清理完成了，现在可以恢复。`, `Cleanup for ${trashEntryName(entry, text)} is done. It can be restored now.`))
  } else {
    toast.error(text(`重试清理没有完成\n\n${reasonOf(result.error)}`, `Cleanup retry did not finish\n\n${reasonOf(result.error)}`))
  }
}
