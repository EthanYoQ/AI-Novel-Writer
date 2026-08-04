import { AlertCircle, CheckCircle2, Clock3, Download, LoaderCircle, RotateCcw, X } from 'lucide-react'

import type { UpdateError, UpdatePresentation, UpdateState } from '../../services/update-presentation'
import { Button } from '../ui/Button'
import { IconBtn } from '../ui/IconBtn'
import { getUpdateCardCopy, type UpdateText } from './update-card-copy'
import { getUpdateRetryAction } from './update-retry-action'

interface UpdateStatusCardProps {
  presentation: UpdatePresentation
  state: UpdateState
  text: UpdateText
  manualActionError?: UpdateError
  isDeferring: boolean
  lastReminderDays: 7 | 30
  onCheck(): void
  onDefer(days: 7 | 30): void
  onInstall(): void
}

function UpdateStatusIcon({ kind }: Pick<UpdatePresentation, 'kind'>) {
  if (kind === 'manual-error') return <AlertCircle size={19} />
  if (kind === 'not-available' || kind === 'downloaded') return <CheckCircle2 size={19} />
  if (kind === 'checking' || kind === 'downloading') return <LoaderCircle size={19} className="animate-spin" />
  return <Download size={19} />
}

function ReminderActions({ isDeferring, onDefer, text, includeSevenDays }: Pick<UpdateStatusCardProps, 'isDeferring' | 'onDefer' | 'text'> & { includeSevenDays: boolean }) {
  return <>
    {includeSevenDays && <Button type="button" variant="ghost" size="sm" onClick={() => onDefer(7)} disabled={isDeferring}>
      <Clock3 size={14} />{text('7 天后提醒', 'Remind me in 7 days')}
    </Button>}
    <Button type="button" variant="ghost" size="sm" onClick={() => onDefer(30)} disabled={isDeferring}>
      <Clock3 size={14} />{text('30 天后提醒', 'Remind me in 30 days')}
    </Button>
  </>
}

function UpdateActions({ presentation, manualActionError, isDeferring, lastReminderDays, onCheck, onDefer, onInstall, text }: Pick<UpdateStatusCardProps, 'presentation' | 'manualActionError' | 'isDeferring' | 'lastReminderDays' | 'onCheck' | 'onDefer' | 'onInstall' | 'text'>) {
  if (presentation.kind === 'manual-error') {
    if (manualActionError && !manualActionError.retryable) return null
    const retryAction = getUpdateRetryAction(manualActionError?.code)
    if (retryAction === 'install') {
      return <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onInstall}><RotateCcw size={14} />{text('再次尝试重启更新', 'Try restarting the update again')}</Button>
      </div>
    }
    if (retryAction === 'defer') {
      return <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => onDefer(lastReminderDays)} disabled={isDeferring}><RotateCcw size={14} />{text('重试保存提醒时间', 'Retry saving the reminder')}</Button>
      </div>
    }
    return <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onCheck}><RotateCcw size={14} />{text('重试检查', 'Retry check')}</Button>
    </div>
  }

  return <div className="mt-3 flex flex-wrap items-center gap-2">
    {presentation.kind === 'available' && <Button type="button" variant="ghost" size="sm" onClick={onCheck} disabled={!presentation.canCheck}><Download size={14} />{text('继续准备更新', 'Continue preparing update')}</Button>}
    {presentation.canInstall && <Button type="button" size="sm" onClick={onInstall}><Download size={14} />{text('立即重启更新', 'Restart and update now')}</Button>}
    {presentation.canInstall && presentation.canDefer && <Button type="button" variant="ghost" size="sm" onClick={() => onDefer(7)} disabled={isDeferring}><Clock3 size={14} />{text('稍后（7天后提醒）', 'Later (remind me in 7 days)')}</Button>}
    {presentation.canDefer && <ReminderActions isDeferring={isDeferring} onDefer={onDefer} text={text} includeSevenDays={!presentation.canInstall} />}
  </div>
}

/** 已发现更新后的非阻断状态卡。 */
export function UpdateStatusCard(props: UpdateStatusCardProps) {
  const { presentation, state, text, manualActionError, isDeferring, lastReminderDays, onCheck, onDefer, onInstall } = props
  const cardCopy = getUpdateCardCopy(presentation, state, text, manualActionError)
  const error = manualActionError ?? state.error
  const progress = Math.round(state.downloadProgress?.percent ?? 0)

  return <div className="writer-panel-card relative mt-3 overflow-hidden p-4" role={presentation.kind === 'manual-error' ? 'alert' : 'status'} aria-live="polite">
    {presentation.kind !== 'manual-error' && presentation.canDefer && <div className="absolute right-3 top-3"><IconBtn onClick={() => onDefer(7)} disabled={isDeferring} size={18} title={text('关闭并在 7 天后提醒', 'Close and remind me in 7 days')}><X size={16} /></IconBtn></div>}
    <div className="flex items-start gap-3 pr-8">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-accent)' }}><UpdateStatusIcon kind={presentation.kind} /></div>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{cardCopy.title}</h2>
        <p className="mt-1 text-xs leading-5" style={{ color: 'var(--color-text-secondary)' }}>{cardCopy.description}</p>
        {presentation.showProgress && <div className="mt-3"><div className="mb-1 flex items-center justify-between text-xs" style={{ color: 'var(--color-text-muted)' }}><span>{text('下载进度', 'Download progress')}</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--color-hover)' }}><div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.min(100, Math.max(0, progress))}%`, backgroundColor: 'var(--color-accent)' }} /></div></div>}
        <UpdateActions presentation={presentation} manualActionError={error} isDeferring={isDeferring} lastReminderDays={lastReminderDays} onCheck={onCheck} onDefer={onDefer} onInstall={onInstall} text={text} />
      </div>
    </div>
  </div>
}
