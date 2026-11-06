import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { TrashedChapter } from '../../../shared/chapter-deletion'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { pluralEn } from '../../../shared/plural-en'
import { sqliteTime } from '../../../shared/sqlite-time'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { InkDialog } from '../InkDialog'
import { purgeTrash, restoreTrashedChapter, retryTrashCleanup, trashEntryName } from './trash-actions'
import type { ChapterTrash } from './use-chapter-trash'
import './trash.css'

type Text = (zh: string, en: string) => string
type PurgeTarget = { kind: 'one'; entry: TrashedChapter } | { kind: 'damaged'; deletionId: string } | { kind: 'all'; deletionIds: readonly string[] }
/** 确认框描述的是弹出那一刻的作品和回收站，确认时只对这些生效。 */
type PurgeAsk = PurgeTarget & { session: ProjectSessionContext }

function modeHint(entry: TrashedChapter, text: Text): string | null {
  if (entry.restoreMode === 'as-history') return text('这一章重写过，恢复后作为旧版本放回。', 'Rewritten since; restores as an older version.')
  if (entry.restoreMode === 'reopen-as-draft') return text('导入的作品，恢复会开一份新草稿。', 'Imported book; restoring opens a new draft.')
  return null
}

function TrashItem({ entry, busy, onRun, onPurge }: {
  entry: TrashedChapter
  busy: boolean
  onRun: (work: () => Promise<unknown>) => void
  onPurge: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const deletedAt = sqliteTime(entry.deletedAt)
  const when = Number.isNaN(deletedAt.getTime()) ? entry.deletedAt : deletedAt.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const words = entry.wordCount.toLocaleString(locale)
  const cleanupUnfinished = entry.cleanup !== 'completed'
  const hint = modeHint(entry, text)
  return (
    <li className="stage-trash-item">
      <div className="stage-trash-main">
        <p className="stage-trash-name">
          <span className="stage-trash-no">{text(`第 ${entry.chapterNumber} 章`, `Chapter ${entry.chapterNumber}`)}</span>
          {entry.chapterTitle && <span className="stage-trash-title">{entry.chapterTitle}</span>}
        </p>
        <p className="stage-trash-meta">
          {text(`删除于 ${when} · ${words} 字 · ${entry.versionCount} 个版本`,
            `Deleted ${when} · ${words} ${pluralEn(entry.wordCount, 'word')} · ${entry.versionCount} ${pluralEn(entry.versionCount, 'version')}`)}
        </p>
        {cleanupUnfinished && <p className="stage-trash-cleanup">{text('实体稿或知识库还没清理完', 'Manuscript file or knowledge base not cleaned up yet')}</p>}
        {hint && <p className="stage-trash-hint">{hint}</p>}
      </div>
      <div className="stage-trash-actions">
        {cleanupUnfinished && (
          <Button variant="text" size="sm" disabled={busy} onClick={() => onRun(() => retryTrashCleanup(entry))}>
            {text('重试清理', 'Retry cleanup')}
          </Button>
        )}
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRun(() => restoreTrashedChapter(entry))}>
          <RotateCcw size={13} aria-hidden />{text('恢复', 'Restore')}
        </Button>
        <Button variant="danger" size="sm" disabled={busy} onClick={onPurge}>{text('彻底删除…', 'Delete permanently…')}</Button>
      </div>
    </li>
  )
}

/** 回收站：每次删除一项，可恢复、重试清理、彻底删除；读不全的项单独列出，不挡其余各项。 */
export default function TrashDialog({ open, onOpenChange, trash }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trash: ChapterTrash
}) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<PurgeAsk | null>(null)
  const total = trash.entries.length + trash.damaged.length
  const askPurge = (target: PurgeTarget) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (session) setAsk({ ...target, session })
  }

  const run = (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    void work().finally(() => setBusy(false))
  }

  const purgeTitle = ask?.kind === 'all'
    ? text('清空回收站？', 'Empty the trash?')
    : ask?.kind === 'one'
      ? text(`彻底删除${trashEntryName(ask.entry, text)}？`, `Delete ${trashEntryName(ask.entry, text)} permanently?`)
      : text('彻底删除这一项？', 'Delete this item permanently?')
  const emptying = new Set(ask?.kind === 'all' ? ask.deletionIds : [])
  const unfinished = trash.entries.filter(entry => emptying.has(entry.deletionId) && entry.cleanup !== 'completed').length
  const purgeConsequence = ask?.kind === 'all'
    ? text(`回收站里的 ${emptying.size} 项会彻底删除，其他章节不受影响。`,
        `All ${emptying.size} ${pluralEn(emptying.size, 'item')} in the trash will be deleted permanently. Other chapters are not affected.`)
      + (unfinished === 0 ? '' : text(`其中 ${unfinished} 项清理没做完，项目文件夹或知识库里可能还有残留，需要时请手动删掉。`,
        ` ${unfinished} of them didn’t finish cleanup, so leftovers may remain in the project folder or knowledge base. Remove them yourself if needed.`))
    : ask?.kind === 'one'
      ? text(`第 ${ask.entry.chapterNumber} 章的正文和版本会彻底删除，其他章节不受影响。`,
          `Chapter ${ask.entry.chapterNumber}’s text and versions will be deleted permanently. Other chapters are not affected.`)
        + (ask.entry.cleanup === 'completed' ? '' : text('它的清理没做完，项目文件夹或知识库里可能还有残留，需要时请手动删掉。',
          ' Its cleanup didn’t finish, so leftovers may remain in the project folder or knowledge base. Remove them yourself if needed.'))
      : text('这一项会彻底删除，其他章节不受影响。', 'This item will be deleted permanently. Other chapters are not affected.')

  const confirmPurge = () => {
    const target = ask
    setAsk(null)
    if (!target) return
    run(() => purgeTrash(target.kind === 'all' ? { emptying: target.deletionIds } : target.kind === 'one' ? target.entry : { deletionId: target.deletionId }, target.session))
  }

  return (
      <InkDialog
        open={open}
        onOpenChange={onOpenChange}
        title={text(`回收站（${total}）`, `Trash (${total})`)}
        description={text('回收站里的章节会随备份和导出一起带走。', 'Chapters in the trash are included in backups and exports.')}
        footer={(
          <>
            <Button variant="danger" disabled={busy || total === 0} onClick={() => askPurge({ kind: 'all', deletionIds: [...trash.entries, ...trash.damaged].map(item => item.deletionId) })}>{text('清空回收站…', 'Empty trash…')}</Button>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>{text('关闭', 'Close')}</Button>
          </>
        )}
      >
        {total === 0
          ? <p className="stage-trash-empty">{text('回收站是空的。删除的章节会放在这里。', 'The trash is empty. Deleted chapters land here.')}</p>
          : (
            <ul className="stage-trash-list" aria-label={text('回收站里的章节', 'Chapters in the trash')}>
              {trash.entries.map(entry => (
                <TrashItem key={entry.deletionId} entry={entry} busy={busy} onRun={run} onPurge={() => askPurge({ kind: 'one', entry })} />
              ))}
              {trash.damaged.map(item => (
                <li key={item.deletionId} className="stage-trash-item" data-damaged="true">
                  <div className="stage-trash-main">
                    <p className="stage-trash-name">{text('有一项读不全', 'An item could not be read')}</p>
                    <p className="stage-trash-meta">{displayedErrorMessage(locale, item.error)}</p>
                  </div>
                  <div className="stage-trash-actions">
                    <Button variant="danger" size="sm" disabled={busy} onClick={() => askPurge({ kind: 'damaged', deletionId: item.deletionId })}>
                      {text('彻底删除…', 'Delete permanently…')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        {/* 放在回收站对话框里面：Radix 只把 React 树里嵌套的对话框当作上一层，平级的会被外层挡住点击。 */}
        <DangerConfirm
          open={ask !== null}
          onOpenChange={next => { if (!next) setAsk(null) }}
          title={purgeTitle}
          consequence={purgeConsequence}
          recoverability={text('这一步无法撤销。', 'This cannot be undone.')}
          confirmLabel={ask?.kind === 'all' ? text('清空回收站', 'Empty trash') : text('彻底删除', 'Delete permanently')}
          cancelLabel={text('取消', 'Cancel')}
          onConfirm={confirmPurge}
        />
      </InkDialog>
  )
}
