import { useEffect, useId, useRef, type KeyboardEvent, type RefObject } from 'react'
import { Button } from './Button'
import { rememberFocus } from './focus-return'

interface InlineConfirmProps {
  /** 写明后果与能否恢复，例如「清空后无法恢复这 12 条日志」。 */
  message: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  /**
   * 打开确认条的按钮，关掉后焦点回到它。确认条出现时这个按钮常常已经失焦：禁用了（Electron 里禁用的按钮立即失焦），
   * 或者被确认条替换掉了，所以由调用方指给它，不靠确认条出现那一刻的焦点。
   */
  returnFocusRef: RefObject<HTMLElement | null>
}

/**
 * 侧页内影响较小的危险操作用的就地确认条。出现时焦点落在取消上，Esc 取消。
 * 确认条一消失焦点就丢了：还给 returnFocusRef，按钮已不可用（清空后无日志可清）或已移除时落到最近的可聚焦祖先。
 */
export function InlineConfirm({ message, confirmLabel, cancelLabel, onConfirm, onCancel, returnFocusRef }: InlineConfirmProps) {
  const messageId = useId()
  const groupRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const restoreFocus = rememberFocus(groupRef.current, returnFocusRef)
    cancelRef.current?.focus()
    return () => {
      if (!document.activeElement || document.activeElement === document.body) restoreFocus()
    }
  }, [returnFocusRef])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <div ref={groupRef} className="pi-inline-confirm" role="group" aria-labelledby={messageId} onKeyDown={onKeyDown}>
      <p id={messageId} className="pi-inline-confirm-text">{message}</p>
      <Button ref={cancelRef} variant="text" size="sm" onClick={onCancel}>{cancelLabel}</Button>
      <Button variant="danger" size="sm" onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  )
}
