import { useLocaleStore } from '../../stores/locale-store'

export type SaveOutcome = 'idle' | 'saved' | 'failed'

export function SaveFeedback({
  dirty,
  saving,
  outcome,
}: {
  dirty: boolean
  saving: boolean
  outcome: SaveOutcome
}) {
  const text = useLocaleStore(state => state.text)
  const label = saving
    ? text('保存中...', 'Saving...')
    : outcome === 'failed'
      ? text('保存失败', 'Save failed')
      : dirty
        ? text('未保存', 'Unsaved')
        : outcome === 'saved'
          ? text('已保存', 'Saved')
          : null
  if (!label) return null

  return (
    <span
      role={outcome === 'failed' ? 'alert' : 'status'}
      className="text-xs"
      style={{
        color: outcome === 'failed'
          ? 'var(--color-error-text)'
          : dirty
            ? 'var(--color-warning)'
            : 'var(--color-text-muted)',
      }}
    >
      {label}
    </span>
  )
}
