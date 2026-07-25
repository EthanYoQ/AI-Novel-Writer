import type { MouseEvent } from 'react'

import type { ContextMenuEntry } from '../../ui/ContextMenu'

export interface SidebarMenuState {
  items: ContextMenuEntry[]
  position: { x: number; y: number }
}

/** 全局单例右键菜单状态 setter（同一时刻只展示一个） */
let sidebarMenuSetter: ((value: SidebarMenuState | null) => void) | null = null

/** 注册 setter（由 Sidebar 容器调用） */
export function registerMenuSetter(setter: (value: SidebarMenuState | null) => void): void {
  sidebarMenuSetter = setter
}

/** 注销 setter */
export function unregisterMenuSetter(): void {
  sidebarMenuSetter = null
}

/** 展示右键菜单 */
export function showSidebarMenu(items: ContextMenuEntry[], event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  sidebarMenuSetter?.({ items, position: { x: event.clientX, y: event.clientY } })
}
