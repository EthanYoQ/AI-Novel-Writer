import { Fragment, useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Button, type InkButtonSize } from './Button'
import { useAnchoredLayer } from './use-anchored-layer'

export interface MenuItemSpec {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
}

export interface MenuGroupSpec {
  id: string
  label?: string
  /** 危险分组放在最后，与普通分组之间有分隔线，项目为危险色。 */
  tone?: 'danger'
  items: readonly MenuItemSpec[]
}

interface MenuProps {
  /** 触发按钮的可访问名称；只给图标时也作为 aria-label。 */
  label: string
  icon?: ReactNode
  /** 文字触发按钮的内容与样式，例如顶栏的作品名加下拉箭头；label 仍作为可访问名称。 */
  trigger?: { content: ReactNode; className?: string; size?: InkButtonSize }
  groups: readonly MenuGroupSpec[]
  align?: 'start' | 'end'
}

const enabledItems = (menu: HTMLElement | null) =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])

export function Menu({ label, icon, trigger, groups, align = 'start' }: MenuProps) {
  const { open, layerId, anchorRef, triggerRef, layerRef: menuRef, renderLayer, show, toggle, close } = useAnchoredLayer(align)
  const focusFirstOnOpen = useRef(false)

  const items = () => enabledItems(menuRef.current)

  useEffect(() => {
    if (open && focusFirstOnOpen.current) enabledItems(menuRef.current)[0]?.focus()
  }, [open, menuRef])

  const openWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusFirstOnOpen.current = true
      if (open) items()[0]?.focus()
      else show()
    }
  }

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const target = {
      ArrowDown: list[(index + 1) % list.length],
      ArrowUp: list[(index - 1 + list.length) % list.length],
      Home: list[0],
      End: list[list.length - 1],
    }[event.key]
    if (target) {
      event.preventDefault()
      target.focus()
    }
  }

  const select = (item: MenuItemSpec) => {
    close(true)
    item.onSelect()
  }

  const triggerProps = {
    ref: triggerRef,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? layerId : undefined,
    // 键盘触发的 click（Enter、空格）detail 为 0，此时打开后把焦点移到第一项。
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      focusFirstOnOpen.current = event.detail === 0
      toggle()
    },
    onKeyDown: openWithKeyboard,
  }

  return (
    <div className="pi-anchor" ref={anchorRef}>
      {trigger
        ? <Button variant="text" size={trigger.size} className={trigger.className} aria-label={label} {...triggerProps}>{trigger.content}</Button>
        : icon
          ? <Button variant="icon" aria-label={label} {...triggerProps}>{icon}</Button>
          : <Button variant="secondary" {...triggerProps}>{label}</Button>}
      {open && renderLayer(
        <div
          id={layerId}
          ref={menuRef}
          role="menu"
          aria-label={label}
          className="pi-menu"
          onKeyDown={moveFocus}
        >
          {groups.map((group, index) => (
            <Fragment key={group.id}>
              {index > 0 && <div role="separator" className="pi-menu-sep" />}
              <div role="group" aria-label={group.label}>
                {group.label && <div className="pi-menu-label" aria-hidden>{group.label}</div>}
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="pi-menu-item"
                    data-tone={group.tone}
                    disabled={item.disabled}
                    onClick={() => select(item)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
