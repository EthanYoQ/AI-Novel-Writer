import type { ReactNode } from 'react'

/** 纸墨空状态：衬线标题、一句说明、一个动作。 */
interface EmptyStateProps {
  heading: string
  description?: string
  action: ReactNode
  icon?: ReactNode
}

export function EmptyState({ heading, description, action, icon }: EmptyStateProps) {
  return (
    <div className="pi-empty">
      {icon}
      <h3 className="pi-empty-title">{heading}</h3>
      {description && <p className="pi-empty-text">{description}</p>}
      {action}
    </div>
  )
}
