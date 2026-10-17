import { useRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { keepToastStackClickable } from '../ui/ToastStack'
import { usePaperInkRoot } from '../ui/use-paper-ink-root'

interface InkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  /** 底部按钮，主操作放最后。 */
  footer: ReactNode
  /** 点对话框外面不关闭：两步之间高度会变的对话框，双击第二下可能落到外面。Esc 与按钮照常关闭。 */
  keepOnOutsideClick?: boolean
}

/**
 * 不涉及危险的对话框（新建作品、移除书架记录、更新拦截）。危险操作用 ui/DangerConfirm。
 * 与 DangerConfirm 一样 Portal 到最近的 .paper-ink 根，取到纸墨令牌与深色主题。
 */
export function InkDialog({ open, onOpenChange, title, description, children, footer, keepOnOutsideClick = false }: InkDialogProps) {
  const sentinelRef = useRef<HTMLSpanElement>(null)
  const root = usePaperInkRoot(sentinelRef)
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <span ref={sentinelRef} hidden />
      {root !== undefined && (
        <DialogPrimitive.Portal container={root}>
          <DialogPrimitive.Overlay className="pi-scrim" />
          <DialogPrimitive.Content className="pi-dialog stage-dialog" onPointerDownOutside={event => {
            keepToastStackClickable(event)
            if (keepOnOutsideClick) event.preventDefault()
          }} {...(description ? {} : { 'aria-describedby': undefined })}>
            <div className="pi-dialog-head">
              <DialogPrimitive.Title className="pi-dialog-title">{title}</DialogPrimitive.Title>
            </div>
            <div className="pi-dialog-body">
              {description && <DialogPrimitive.Description className="pi-dialog-text">{description}</DialogPrimitive.Description>}
              {children}
            </div>
            <div className="pi-dialog-foot">{footer}</div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  )
}
