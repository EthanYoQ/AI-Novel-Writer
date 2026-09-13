import { useLocaleStore } from '../../../stores/locale-store'
import type { WriterAction } from './TitleBarV2'

export interface SpineNavProps {
  items: readonly WriterAction[]
  activeId?: string
}
export default function SpineNav({ items, activeId }: SpineNavProps) {
  const text = useLocaleStore(state => state.text)
  return <nav className="writer-spine" aria-label={text('写作栏目', 'Writing navigation')}>
    {items.map(({ id, label, icon: Icon, onAction, unavailableReason }) => <button type="button" key={id}
      aria-current={id === activeId ? 'page' : undefined} disabled={!onAction}
      title={!onAction ? unavailableReason || text('此栏目尚未接入', 'This section is not connected yet') : label} onClick={onAction}>
      {Icon && <Icon size={19} strokeWidth={1.6} />}<span>{label}</span>
    </button>)}
  </nav>
}
