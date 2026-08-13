/**
 * SidebarShared — sidebar components shared by the project tree.
 *
 * Non-component helpers live in focused `.ts` modules beside this file so
 * Fast Refresh can preserve this component's state during development.
 */

import type { MouseEvent } from 'react'

import { renderIcon } from './sidebar-icons'

interface LeafItemProps {
  iconName: string
  label: string
  desc?: string
  badge?: string
  badgeDone?: boolean
  badgeColor?: string
  onClick?: () => void
  onContextMenu?: (event: MouseEvent) => void
}

/** 叶子节点（无子级，带可选状态徽章） */
export function LeafItem({
  iconName,
  label,
  desc,
  badge,
  badgeDone,
  badgeColor,
  onClick,
  onContextMenu,
}: LeafItemProps) {
  return (
    <div
      className="tree-item gap-1.5 cursor-pointer select-none"
      style={{ paddingLeft: 10 }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={desc}
    >
      <span style={{ width: 12, flexShrink: 0 }} />
      <span className="flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{renderIcon(iconName, 14)}</span>
      <span className="text-sm font-medium flex-1 min-w-0 truncate" style={{ color: 'var(--color-text)' }}>{label}</span>
      {badge && (
        <span
          className="text-[0.7rem] flex-shrink-0 ml-1"
          style={{ color: badgeColor || (badgeDone ? 'var(--color-success-text)' : 'var(--color-text-muted)') }}
        >
          {badge}
        </span>
      )}
    </div>
  )
}
