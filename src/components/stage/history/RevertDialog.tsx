import { RotateCcw } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { InkDialog } from '../InkDialog'

interface RevertDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chapterNumber: number
  /** 要回退到的那一稿，例如「草稿 v1」。 */
  source: string
  /** 回退后新建的那一稿的版本号。 */
  nextVersion: number
  /** 回退前的当前稿，例如「草稿 v2」。 */
  current: string
  busy: boolean
  onConfirm: () => void
}

/** 回退不删除也不覆盖任何一稿，所以用普通对话框而不是危险确认，写明会新建哪一稿。 */
export default function RevertDialog({ open, onOpenChange, chapterNumber, source, nextVersion, current, busy, onConfirm }: RevertDialogProps) {
  const text = useLocaleStore(s => s.text)
  return (
    <InkDialog
      open={open}
      onOpenChange={onOpenChange}
      title={text(`回退到${source}？`, `Revert to ${source}?`)}
      description={text(
        `会用${source}的内容新建一份草稿 v${nextVersion}，作为第 ${chapterNumber} 章的当前稿。`,
        `This creates draft v${nextVersion} from ${source} and makes it the current draft of chapter ${chapterNumber}.`,
      )}
      footer={(
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{text('取消', 'Cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            <RotateCcw size={14} aria-hidden="true" />{text('新建回滚草稿', 'Create rollback draft')}
          </Button>
        </>
      )}
    >
      <p className="pi-dialog-text">{text(`现在的${current}和所有历史版本都会保留，随时可以再切回去。`, `${current} and every earlier version stay, so you can switch back at any time.`)}</p>
    </InkDialog>
  )
}
