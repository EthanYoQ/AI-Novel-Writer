import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from './Button'
import { useInkOverlayHost } from './ink-overlay'
import { useDialogFocusReturn } from './focus-return'
import { keepToastStackClickable } from './ToastStack'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

/**
 * 沿用的旧对话框（导入、导出等）的外壳：内容 Portal 进 body 下的纸墨宿主，外壳是 pi-dialog，
 * 头、标题、说明、底栏是纸墨原语；内容区的旧 --color-* 由 stage-legacy-bridge.css 映射到纸墨令牌。
 */
const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onPointerDownOutside, onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
  const text = useLocaleStore(s => s.text)
  const focusReturn = useDialogFocusReturn()
  const host = useInkOverlayHost()
  if (!host) return null
  return (
    <DialogPortal container={host}>
      <DialogPrimitive.Overlay className="pi-scrim" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn('pi-dialog pi-dialog--legacy max-w-lg', className)}
        onPointerDownOutside={event => {
          keepToastStackClickable(event)
          onPointerDownOutside?.(event)
        }}
        onOpenAutoFocus={event => {
          focusReturn.remember()
          onOpenAutoFocus?.(event)
        }}
        onCloseAutoFocus={event => {
          onCloseAutoFocus?.(event)
          if (!event.defaultPrevented) focusReturn.onCloseAutoFocus(event)
        }}
        {...props}
      >
        {children}
        <DialogPrimitive.Close asChild>
          <Button variant="icon" size="sm" className="pi-dialog-close" aria-label={text('关闭', 'Close')}>
            <X aria-hidden />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

/** 对话框头部 */
const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('pi-dialog-head', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

/** 对话框底部 */
const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('pi-dialog-foot justify-between', className)} {...props} />
)
DialogFooter.displayName = 'DialogFooter'

/** 对话框标题 */
const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('pi-dialog-title', className)} {...props} />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

/** 对话框描述 */
const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('pi-dialog-sub', className)} {...props} />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
