import { useLocaleStore } from '../../../stores/locale-store'
import type { ReactNode } from 'react'
import { BookOpen, type LucideIcon } from 'lucide-react'

export interface WriterAction {
  id: string
  label: string
  icon?: LucideIcon
  onAction?: () => void
  unavailableReason?: string
}
export interface TitleBarV2Props {
  projectName?: string
  documentName?: string
  status: ReactNode
  actions: readonly WriterAction[]
  onHome: () => void
  stages?: ReactNode
  model?: ReactNode
  extraControls?: ReactNode
  windowControls?: ReactNode
}

export default function TitleBarV2({ projectName, documentName, status, actions, onHome, stages,
  model, extraControls, windowControls }: TitleBarV2Props) {
  const text = useLocaleStore(state => state.text)
  return <header className="writer-titlebar">
    <button type="button" className="writer-brand" onClick={onHome} aria-label={text('返回书架', 'Back to shelf')}><BookOpen size={23} /></button>
    <div className="writer-book-title"><strong>{projectName || text('写作书房', 'Writing room')}</strong><span>{documentName || text('让故事从这里开始', 'Begin your story here')}</span></div>
    <div className="writer-save-status" aria-live="polite">{status}</div>
    {stages && <div className="writer-stages-host">{stages}</div>}
    {model}
    <details className="writer-file-menu" onKeyDown={event => {
      if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() }
    }}>
      <summary>{text('文件与项目', 'Files and projects')}</summary>
      <div className="writer-file-actions">
        {actions.map(({ id, label, icon: Icon, onAction, unavailableReason }) => <button key={id} type="button"
          disabled={!onAction} title={!onAction ? unavailableReason || text('此操作尚未接入', 'This action is not connected yet') : undefined}
          onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onAction?.() }}>
          {Icon && <Icon size={16} />}<span>{label}</span>{!onAction && <small>{unavailableReason || text('尚未接入', 'Not connected')}</small>}
        </button>)}
      </div>
    </details>
    <div className="writer-extra-controls">{extraControls}</div>
    <div className="writer-window-controls">{windowControls}</div>
  </header>
}
