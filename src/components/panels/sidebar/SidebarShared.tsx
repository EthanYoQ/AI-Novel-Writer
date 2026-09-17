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
  /** 先生：只有最重要的几项（小说配置 / 章节蓝图）用略重的字重撑起层级；
   *  伏笔与叙事线索这类次要项保持常规字重，加黑反而显得吵。 */
  emphasize?: boolean
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
  emphasize = false,
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
      {/* 先生：14.5px 仍偏大、有点糙，收到 14px；只有最重要的两项用略重字重撑层级。 */}
      <span
        className="text-[14px] flex-1 min-w-0 truncate"
        style={{ color: 'var(--color-text)', fontWeight: emphasize ? 550 : 400 }}
      >{label}</span>
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
