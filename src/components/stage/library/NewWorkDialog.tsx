import { useId } from 'react'
import { FolderOpen } from 'lucide-react'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useNewProjectForm } from '../../dialogs/use-new-project-form'
import { Button } from '../../ui/Button'
import { InkDialog } from '../InkDialog'

/** 新建作品：起名、选保存位置。创建后打开作品，落在设定页。 */
export default function NewWorkDialog() {
  const text = useLocaleStore(s => s.text)
  const open = useLayoutStore(s => s.newProjectOpen)
  const close = useLayoutStore(s => s.closeNewProject)
  const form = useNewProjectForm(open, close)
  const nameId = useId()
  const folderId = useId()
  const reasonId = useId()
  const reason = form.creating ? null
    : !form.path ? text('先选保存位置，作品会建在那个文件夹里。', 'Choose a location first; the book is created in that folder.')
      : !form.name.trim() ? text('先起个作品名。', 'Give the book a title first.') : null

  return (
    <InkDialog
      open={open}
      onOpenChange={next => { if (!next) close() }}
      title={text('新建作品', 'New book')}
      description={text('起个名字，选好保存位置。类型、篇幅这些在下一步的设定里填。', 'Give it a title and choose where to keep it. Genre, length and the rest come next, in setup.')}
      footer={(
        <>
          <Button variant="secondary" onClick={close}>{text('取消', 'Cancel')}</Button>
          <Button variant="primary" disabled={!form.canCreate} aria-describedby={reason ? reasonId : undefined} onClick={() => void form.create()}>
            {form.creating ? text('正在创建…', 'Creating…') : text('创建作品', 'Create book')}
          </Button>
        </>
      )}
    >
      <div className="pi-field">
        <label htmlFor={nameId}>{text('作品名', 'Title')}</label>
        <input
          id={nameId}
          className="pi-input"
          value={form.name}
          autoFocus
          autoComplete="off"
          placeholder={text('如：雨夜列车', 'e.g. The Night Train')}
          onChange={event => form.setName(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && form.canCreate) void form.create()
          }}
        />
      </div>
      <div className="pi-field">
        <label htmlFor={folderId}>{text('保存位置', 'Location')}</label>
        <div className="stage-field-row">
          <input
            id={folderId}
            className="pi-input"
            value={form.path?.displayName ?? ''}
            readOnly
            placeholder={text('选择一个文件夹，作品会建在它里面', 'Choose a folder; the book is created inside it')}
          />
          <Button variant="secondary" onClick={() => void form.selectFolder()}>
            <FolderOpen size={14} aria-hidden="true" />
            {text('选择', 'Choose')}
          </Button>
        </div>
      </div>
      {reason && <p id={reasonId} className="stage-dialog-hint">{reason}</p>}
    </InkDialog>
  )
}
