import { useRef, type RefObject } from 'react'

/**
 * 记下此刻的焦点，返回把焦点放回去的函数。打开它的元素已被移除或已禁用时，
 * 落到 container 最近的、仍在文档里的可聚焦祖先（带 tabindex 的侧页、内容区等），不让焦点掉到 body。
 * 给了 openerRef 时还给它在那一刻指着的元素，不看记下时的焦点。
 */
export function rememberFocus(container: Element | null, openerRef?: RefObject<HTMLElement | null>): () => void {
  const active = document.activeElement
  const opener = active instanceof HTMLElement && active !== document.body ? active : null
  const fallbacks: HTMLElement[] = []
  for (let node = container?.parentElement; node; node = node.parentElement) {
    if (node.hasAttribute('tabindex')) fallbacks.push(node)
  }
  return () => {
    for (const target of [openerRef ? openerRef.current : opener, ...fallbacks]) {
      if (!target?.isConnected) continue
      target.focus()
      if (document.activeElement === target) return
    }
  }
}

/**
 * 受控打开、没有 Dialog.Trigger 的 Radix 对话框用：Radix 关闭时只把焦点还给 Trigger，没有就落到 body。
 * remember 在 onOpenAutoFocus 里调（此时焦点还在打开它的按钮上），onCloseAutoFocus 直接交给 Content。
 * Radix 卸载后隔一个 setTimeout(0) 才调 onCloseAutoFocus：这期间确认动作可能已经把焦点交给别处（自动弹出的写作弹层），
 * 只有焦点还在对话框里或掉到了 body 时才还。
 */
export function useDialogFocusReturn() {
  const restore = useRef<() => void>(() => {})
  return {
    remember: () => { restore.current = rememberFocus(document.activeElement) },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      const active = document.activeElement
      const dialog = event.currentTarget
      if (!active || active === document.body || (dialog instanceof Node && dialog.contains(active))) restore.current()
    },
  }
}
