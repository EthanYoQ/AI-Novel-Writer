import type { ReactNode } from 'react'
import { CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react'

export type NoticeTone = 'info' | 'ok' | 'warn' | 'danger'

const toneIcons: Record<NoticeTone, LucideIcon> = {
  info: Info,
  ok: CircleCheck,
  warn: TriangleAlert,
  danger: OctagonAlert,
}

interface NoticeProps {
  tone?: NoticeTone
  title: string
  children?: ReactNode
  /** 提示条文字下方的动作，通常是一个次按钮或文字按钮。 */
  actions?: ReactNode
}

/** 页面内的提示条（继续上次、可恢复的草稿、建议等），不打断当前操作。 */
export function Notice({ tone = 'info', title, children, actions }: NoticeProps) {
  const Icon = toneIcons[tone]
  return (
    <div className="pi-notice" role="status" data-tone={tone}>
      <Icon aria-hidden />
      <div className="pi-notice-body">
        <p className="pi-notice-title">{title}</p>
        {children && <div className="pi-notice-text">{children}</div>}
      </div>
      {actions && <div className="pi-notice-actions">{actions}</div>}
    </div>
  )
}
