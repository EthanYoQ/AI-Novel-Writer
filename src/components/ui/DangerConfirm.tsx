import { useId, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { OctagonAlert } from 'lucide-react'
import { Button } from './Button'
import { useDialogFocusReturn } from './focus-return'
import { keepToastStackClickable } from './ToastStack'
import { usePaperInkRoot } from './use-paper-ink-root'

interface DangerConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** 后果，例如「将删除全部章节、蓝图与设定」。 */
  consequence: string
  /** 能否恢复，例如「删除后无法恢复，项目备份不受影响」。 */
  recoverability: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  /** 删除整部作品时要求输入作品名，输入一致才可确认。 */
  typeToConfirm?: { expected: string; label: string }
}

/**
 * 不可逆、影响作品数据的操作用的危险确认对话框。
 * Portal 到最近的 .paper-ink 根而不是 body，才能取到纸墨令牌与深色主题；
 * 原地的空 span 只用来找到这个根。
 * 调用方都是受控打开、没有 Dialog.Trigger，Radix 关闭时无处还焦点，所以打开时自己记下焦点、关闭时还回去。
 */
export function DangerConfirm({ open, onOpenChange, title, ...content }: DangerConfirmProps) {
  const sentinelRef = useRef<HTMLSpanElement>(null)
  const root = usePaperInkRoot(sentinelRef)
  const focusReturn = useDialogFocusReturn()

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <span ref={sentinelRef} hidden />
      {root !== undefined && (
        <DialogPrimitive.Portal container={root}>
          <DialogPrimitive.Overlay className="pi-scrim" />
          <DialogPrimitive.Content
            className="pi-dialog pi-dialog--marked"
            onPointerDownOutside={keepToastStackClickable}
            onOpenAutoFocus={focusReturn.remember}
            onCloseAutoFocus={focusReturn.onCloseAutoFocus}
          >
            <div className="pi-dialog-head">
              <span className="pi-dialog-mark" aria-hidden><OctagonAlert /></span>
              <DialogPrimitive.Title className="pi-dialog-title">{title}</DialogPrimitive.Title>
            </div>
            <DangerConfirmBody {...content} onClose={() => onOpenChange(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  )
}

/** 输入框的值放在随对话框挂载的组件里：父组件不经 onOpenChange 直接关闭再打开，也从空白开始。 */
function DangerConfirmBody({ consequence, recoverability, confirmLabel, cancelLabel, onConfirm, typeToConfirm, onClose }:
  Omit<DangerConfirmProps, 'open' | 'onOpenChange' | 'title'> & { onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const confirmable = !typeToConfirm || typed === typeToConfirm.expected

  return (
    <>
      <div className="pi-dialog-body">
        <DialogPrimitive.Description asChild>
          <div className="pi-dialog-consequence">
            <p>{consequence}</p>
            <p className="pi-dialog-recover">{recoverability}</p>
          </div>
        </DialogPrimitive.Description>
        {typeToConfirm && (
          <label className="pi-field" htmlFor={inputId}>
            {typeToConfirm.label}
            <input
              id={inputId}
              className="pi-input"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
        )}
      </div>
      <div className="pi-dialog-foot">
        <DialogPrimitive.Close asChild>
          <Button variant="secondary">{cancelLabel}</Button>
        </DialogPrimitive.Close>
        <Button
          variant="danger-solid"
          disabled={!confirmable}
          onClick={() => {
            onConfirm()
            onClose()
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </>
  )
}
