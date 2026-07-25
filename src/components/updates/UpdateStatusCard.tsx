import { AlertCircle, CheckCircle2, Clock3, Download, LoaderCircle, RotateCcw, X } from 'lucide-react'

import type { UpdateErrorCode, UpdatePresentation, UpdateState } from '../../services/update-presentation'
import { getUpdateCardCopy, type UpdateText } from './update-card-copy'

interface UpdateStatusCardProps {
  presentation: UpdatePresentation
  state: UpdateState
  text: UpdateText
  manualActionError?: UpdateErrorCode
  isDeferring: boolean
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
    {includeSevenDays && <button type="button" onClick={() => onDefer(7)} disabled={isDeferring} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}>
      <Clock3 size={14} />{text('7 天后提醒', 'Remind me in 7 days')}
    </button>}
    <button type="button" onClick={() => onDefer(30)} disabled={isDeferring} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}>
      <Clock3 size={14} />{text('30 天后提醒', 'Remind me in 30 days')}
    </button>
  </>
}

function UpdateActions({ presentation, isDeferring, onCheck, onDefer, onInstall, text }: Pick<UpdateStatusCardProps, 'presentation' | 'isDeferring' | 'onCheck' | 'onDefer' | 'onInstall' | 'text'>) {
  return <div className="mt-3 flex flex-wrap items-center gap-2">
    {presentation.kind === 'manual-error' && <button type="button" onClick={presentation.canInstall ? onInstall : onCheck} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}><RotateCcw size={14} />{presentation.canInstall ? text('再次尝试重启更新', 'Try restarting the update again') : text('重试检查', 'Retry check')}</button>}
    {presentation.kind === 'available' && <button type="button" onClick={onCheck} disabled={!presentation.canCheck} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}><Download size={14} />{text('继续准备更新', 'Continue preparing update')}</button>}
    {presentation.canInstall && <button type="button" onClick={onInstall} className="writer-primary-button inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"><Download size={14} />{text('立即重启更新', 'Restart and update now')}</button>}
    {presentation.canInstall && presentation.canDefer && <button type="button" onClick={() => onDefer(7)} disabled={isDeferring} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text)' }}><Clock3 size={14} />{text('稍后（7天后提醒）', 'Later (remind me in 7 days)')}</button>}
    {presentation.canDefer && <ReminderActions isDeferring={isDeferring} onDefer={onDefer} text={text} includeSevenDays={!presentation.canInstall} />}
  </div>
}

/** 已发现更新后的非阻断状态卡。 */
export function UpdateStatusCard(props: UpdateStatusCardProps) {
  const { presentation, state, text, manualActionError, isDeferring, onCheck, onDefer, onInstall } = props
  const cardCopy = getUpdateCardCopy(presentation, state, text, manualActionError)
  const progress = Math.round(state.downloadProgress?.percent ?? 0)

  return <div className="writer-panel-card relative mt-3 overflow-hidden p-4" role={presentation.kind === 'manual-error' ? 'alert' : 'status'} aria-live="polite">
    {presentation.canDefer && <button type="button" onClick={() => onDefer(7)} disabled={isDeferring} className="absolute right-3 top-3 rounded-md p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-hover)] disabled:cursor-not-allowed disabled:opacity-50" title={text('关闭并在 7 天后提醒', 'Close and remind me in 7 days')} aria-label={text('关闭并在 7 天后提醒', 'Close and remind me in 7 days')}><X size={16} /></button>}
    <div className="flex items-start gap-3 pr-8">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-accent)' }}><UpdateStatusIcon kind={presentation.kind} /></div>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{cardCopy.title}</h2>
        <p className="mt-1 text-xs leading-5" style={{ color: 'var(--color-text-secondary)' }}>{cardCopy.description}</p>
        {presentation.showProgress && <div className="mt-3"><div className="mb-1 flex items-center justify-between text-xs" style={{ color: 'var(--color-text-muted)' }}><span>{text('下载进度', 'Download progress')}</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--color-hover)' }}><div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.min(100, Math.max(0, progress))}%`, backgroundColor: 'var(--color-accent)' }} /></div></div>}
        <UpdateActions presentation={presentation} isDeferring={isDeferring} onCheck={onCheck} onDefer={onDefer} onInstall={onInstall} text={text} />
      </div>
    </div>
  </div>
}
