import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { TrashedChapter } from '../../../shared/chapter-deletion'
import { displayedErrorMessage } from '../../../i18n/app-errors'
import { pluralEn } from '../../../shared/plural-en'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { InkDialog } from '../InkDialog'
import { purgeTrash, restoreTrashedChapter, retryTrashCleanup, trashEntryName } from './trash-actions'
import type { ChapterTrash } from './use-chapter-trash'
import './trash.css'

type Text = (zh: string, en: string) => string
type PurgeAsk = { kind: 'one'; entry: TrashedChapter } | { kind: 'damaged'; deletionId: string } | { kind: 'all' }

const CLEANUP_TEXT: Record<Exclude<TrashedChapter['cleanup'], 'completed'>, [string, string]> = {
  pending: ['实体稿或知识库还没清理完', 'Manuscript file or knowledge base not cleaned up yet'],
  failed: ['实体稿或知识库还没清理完', 'Manuscript file or knowledge base not cleaned up yet'],
  authorization_required: ['等你核对知识库后才能清理', 'Waiting for you to check the knowledge base'],
}

function modeHint(entry: TrashedChapter, text: Text): string | null {
  if (entry.restoreMode === 'as-history') return text('这一章已经重写过，恢复后作为旧版本放回。', 'This chapter has been rewritten; restoring puts this back as an older version.')
  if (entry.restoreMode === 'reopen-as-draft') return text('这份作品是导入的，恢复会用它的正文开一份新草稿。', 'This book was imported; restoring opens a new draft with this text.')
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
  const deletedAt = new Date(entry.deletedAt)
  const when = Number.isNaN(deletedAt.getTime()) ? entry.deletedAt : deletedAt.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const words = entry.wordCount.toLocaleString(locale)
  const cleanup = entry.cleanup === 'completed' ? null : CLEANUP_TEXT[entry.cleanup]
  const hint = modeHint(entry, text)
  return (
    <li className="stage-trash-item" data-cleanup={entry.cleanup}>
      <div className="stage-trash-main">
        <p className="stage-trash-name">
          <span className="stage-trash-no">{text(`第 ${entry.chapterNumber} 章`, `Chapter ${entry.chapterNumber}`)}</span>
          {entry.chapterTitle && <span className="stage-trash-title">{entry.chapterTitle}</span>}
        </p>
        <p className="stage-trash-meta">
          {text(`删除于 ${when} · ${words} 字 · ${entry.versionCount} 个版本`,
            `Deleted ${when} · ${words} ${pluralEn(entry.wordCount, 'word')} · ${entry.versionCount} ${pluralEn(entry.versionCount, 'version')}`)}
        </p>
        {cleanup && <p className="stage-trash-cleanup">{text(...cleanup)}</p>}
        {hint && <p className="stage-trash-hint">{hint}</p>}
      </div>
      <div className="stage-trash-actions">
        {cleanup && (
          <Button variant="text" size="sm" disabled={busy} onClick={() => onRun(() => retryTrashCleanup(entry))}>
            {entry.cleanup === 'authorization_required' ? text('确认人工核对并继续', 'Confirm and continue') : text('重试清理', 'Retry cleanup')}
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
  const purgeConsequence = ask?.kind === 'all'
    ? text(`回收站里 ${total} 项的正文和版本都会彻底删除，无法再恢复。其他章节不受影响。`,
        `The text and versions of all ${total} ${pluralEn(total, 'item')} in the trash will be deleted permanently and cannot be restored. Other chapters are not affected.`)
    : ask?.kind === 'one'
      ? text(`彻底删除后，回收站里第 ${ask.entry.chapterNumber} 章的正文和版本无法再恢复。其他章节不受影响。`,
          `After this, the text and versions of chapter ${ask.entry.chapterNumber} in the trash cannot be restored. Other chapters are not affected.`)
        + (ask.entry.cleanup === 'completed' ? '' : text('这一项的清理还没完成，项目文件夹或知识库里可能还留着它，需要的话请自己删掉。',
          ' Its cleanup has not finished, so a copy may remain in the project folder or the knowledge base; remove it yourself if needed.'))
      : text('彻底删除后，这一项无法再恢复。其他章节不受影响。', 'After this, the item cannot be restored. Other chapters are not affected.')

  const confirmPurge = () => {
    const target = ask
    setAsk(null)
    if (!target) return
    run(() => purgeTrash(target.kind === 'all' ? 'all' : target.kind === 'one' ? target.entry : { deletionId: target.deletionId }))
  }

  return (
      <InkDialog
        open={open}
        onOpenChange={onOpenChange}
        title={text(`回收站（${total}）`, `Trash (${total})`)}
        description={text('回收站里的章节会随作品备份和导出一起带走，彻底删除后才不再保留。',
          'Chapters in the trash travel with project backups and exports. They are gone only after you delete them permanently.')}
        footer={(
          <>
            <Button variant="danger" disabled={busy || total === 0} onClick={() => setAsk({ kind: 'all' })}>{text('清空回收站…', 'Empty trash…')}</Button>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>{text('关闭', 'Close')}</Button>
          </>
        )}
      >
        {total === 0
          ? <p className="stage-trash-empty">{text('回收站是空的。删除的章节会先放在这里，可以随时恢复。', 'The trash is empty. Deleted chapters land here first and can be restored any time.')}</p>
          : (
            <ul className="stage-trash-list" aria-label={text('回收站里的章节', 'Chapters in the trash')}>
              {trash.entries.map(entry => (
                <TrashItem key={entry.deletionId} entry={entry} busy={busy} onRun={run} onPurge={() => setAsk({ kind: 'one', entry })} />
              ))}
              {trash.damaged.map(item => (
                <li key={item.deletionId} className="stage-trash-item" data-damaged="true">
                  <div className="stage-trash-main">
                    <p className="stage-trash-name">{text('有一项读不全', 'An item could not be read')}</p>
                    <p className="stage-trash-meta">{displayedErrorMessage(locale, item.error)}</p>
                  </div>
                  <div className="stage-trash-actions">
                    <Button variant="danger" size="sm" disabled={busy} onClick={() => setAsk({ kind: 'damaged', deletionId: item.deletionId })}>
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
