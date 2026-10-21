import { useId, useRef, useState, type ReactNode } from 'react'
import { countDraftUnits } from '../../../shared/draft-units'
import { useLocaleStore } from '../../../stores/locale-store'
import GenerationBudgetDiagnostics from '../../panels/GenerationBudgetDiagnostics'
import { useProjectStore } from '../../../stores/project-store'
import type { WorkflowRun } from '../../../stores/workflow-store'
import { canResumeDraft, isInFlight, type CandidateEntry, type DraftEntry, type RecoveryEntry } from '../../run/run-recovery'
import type { RunRecovery } from '../../run/use-run-recovery'
import { Button } from '../../ui/Button'
import { Check } from '../../ui/Check'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { pluralEn } from '../../../shared/plural-en'

type Text = (zh: string, en: string) => string

/** liveRuns：这部作品进行中的运行，它们推进的工作已经显示为运行卡片，不再列为可恢复。 */
export function RunRecoveryList({ recovery, liveRuns }: { recovery: RunRecovery; liveRuns: readonly WorkflowRun[] }) {
  const text = useLocaleStore(s => s.text)
  const leaseId = useProjectStore(s => s.currentProject?.sessionLease)
  const entries = recovery.entries.filter(entry => !isInFlight(entry, leaseId, liveRuns))
  const errors = [recovery.generationError, recovery.candidateError].filter(Boolean)
  if (!entries.length && !errors.length) return null
  return (
    <section className="run-recovery" aria-label={text('可恢复的内容', 'Recoverable work')}>
      {errors.map(error => <p key={error} className="run-note" data-tone="danger" role="alert">{error}</p>)}
      {entries.map(entry => <RecoveryCard key={`${entry.kind}:${entry.key}`} entry={entry} recovery={recovery} text={text} />)}
    </section>
  )
}

function RecoveryCard({ entry, recovery, text }: { entry: RecoveryEntry; recovery: RunRecovery; text: Text }) {
  const locale = useLocaleStore(s => s.locale)
  const { busy } = recovery
  switch (entry.kind) {
    case 'candidate':
      return <CandidateCard entry={entry} recovery={recovery} text={text} />
    case 'planning':
      return (
        <RecoveryShell title={entry.title} text={text} notes={[entry.note]}
          actions={<Button variant="secondary" size="sm" disabled={busy} onClick={() => recovery.openPlanning(entry)}>{entry.actionLabel}</Button>} />
      )
    case 'editor':
      return (
        <RecoveryShell title={entry.title} text={text} notes={[entry.usage, entry.conflictNote]}
          budget={<GenerationBudgetDiagnostics diagnostics={entry.budget} locale={locale} />}
          actions={<>
            <Button variant="secondary" size="sm" disabled={busy || !entry.canContinue} onClick={() => recovery.continueEditor(entry)}>{entry.labels.continue}</Button>
            <Button variant="text" size="sm" onClick={() => recovery.copy(entry.documentText)}>{entry.labels.copyDocument}</Button>
          </>}>
          <Excerpt text={entry.selectedText} />
          {entry.suggestions.map(item => (
            <Excerpt key={item.id} text={item.text} note={item.incompleteNote} copyLabel={entry.labels.copySuggestion} onCopy={() => recovery.copy(item.text)} />
          ))}
          {entry.tails.map(item => <Excerpt key={item.id} text={item.text} copyLabel={entry.labels.copyTail} onCopy={() => recovery.copy(item.text)} />)}
        </RecoveryShell>
      )
    case 'review':
      return (
        <RecoveryShell title={entry.title} text={text} notes={[entry.usage, ...entry.notes]}
          budget={<GenerationBudgetDiagnostics diagnostics={entry.budget} locale={locale} />}
          actions={<Button variant="secondary" size="sm" disabled={busy || !entry.canAct} onClick={() => recovery.resumeReview(entry)}>{entry.actionLabel}</Button>}>
          {entry.artifacts.map(item => <Excerpt key={item.id} text={item.display} copyLabel={entry.labels.copy} onCopy={() => recovery.copy(item.text)} />)}
          {entry.tails.map(item => <Excerpt key={item.id} text={item.display} copyLabel={entry.labels.copyTail} onCopy={() => recovery.copy(item.text)} />)}
        </RecoveryShell>
      )
    case 'batch':
      return (
        <RecoveryShell title={entry.title} text={text} notes={[entry.staleNote]}
          actions={<Button variant="secondary" size="sm" disabled={busy || !entry.canContinue} onClick={() => recovery.resumeBatch(entry)}>{entry.actionLabel}</Button>} />
      )
    case 'draft':
      return <DraftCard entry={entry} recovery={recovery} text={text} />
  }
}

function RecoveryShell({ title, text, notes = [], budget, actions, children }: {
  title: string
  text: Text
  notes?: (string | undefined)[]
  budget?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  const titleId = useId()
  return (
    <article className="run-card" data-state="recoverable" aria-labelledby={titleId}>
      <header className="run-card-heading">
        <p className="run-card-kicker">{text('可恢复', 'Recoverable')}</p>
        <h3 id={titleId} className="run-card-title">{title}</h3>
      </header>
      {notes.filter(Boolean).map(note => <p key={note} className="run-note">{note}</p>)}
      {children}
      {budget}
      {actions && <div className="run-card-buttons">{actions}</div>}
    </article>
  )
}

function Excerpt({ text, note, copyLabel, onCopy }: { text: string; note?: string; copyLabel?: string; onCopy?: () => void }) {
  return (
    <figure className="run-excerpt">
      <blockquote className="run-excerpt-text">{text}</blockquote>
      {note && <figcaption className="run-note">{note}</figcaption>}
      {onCopy && <Button variant="text" size="sm" className="run-excerpt-copy" onClick={onCopy}>{copyLabel}</Button>}
    </figure>
  )
}

function DraftCard({ entry, recovery, text }: { entry: DraftEntry; recovery: RunRecovery; text: Text }) {
  const locale = useLocaleStore(s => s.locale)
  const picked = recovery.picked(entry)
  return (
    <RecoveryShell title={entry.title} text={text} notes={[entry.usage, entry.note]}
      budget={<GenerationBudgetDiagnostics diagnostics={entry.budget} locale={locale} />}
      actions={<Button variant="secondary" size="sm" disabled={recovery.busy || !canResumeDraft(entry, picked)} onClick={() => recovery.resumeDraft(entry)}>{entry.actionLabel}</Button>}>
      {entry.artifacts.map(item => (
        <figure key={item.id} className="run-excerpt">
          <Check
            checked={picked.includes(item.id)}
            disabled={recovery.busy || !item.selectable}
            onChange={checked => recovery.togglePick(entry, item.id, checked)}
            label={<span className="run-excerpt-text">{item.text}</span>}
          />
          <Button variant="text" size="sm" className="run-excerpt-copy" onClick={() => recovery.copy(item.text)}>{entry.labels.copy}</Button>
        </figure>
      ))}
      {entry.tails.length > 0 && <p className="run-note">{entry.labels.tailLead}</p>}
      {entry.tails.map(item => <Excerpt key={item.id} text={item.text} copyLabel={entry.labels.copy} onCopy={() => recovery.copy(item.text)} />)}
    </RecoveryShell>
  )
}

/** 旧恢复候选：放弃前就地确认，写明放弃的字数无法找回。 */
function CandidateCard({ entry, recovery, text }: { entry: CandidateEntry; recovery: RunRecovery; text: Text }) {
  const [confirming, setConfirming] = useState(false)
  const discardButton = useRef<HTMLButtonElement>(null)
  const units = countDraftUnits(entry.text)
  return (
    <RecoveryShell title={entry.title} text={text} notes={[entry.staleNote]}
      actions={confirming
        ? (
          <InlineConfirm
            message={text(`放弃后这 ${units} 字无法找回。`, `Discarding loses the ${units} ${pluralEn(units, 'word')} for good.`)}
            confirmLabel={text('放弃', 'Discard')}
            cancelLabel={text('保留', 'Keep')}
            onConfirm={() => { setConfirming(false); recovery.discardCandidate(entry) }}
            onCancel={() => setConfirming(false)}
            returnFocusRef={discardButton}
          />
        )
        : <>
          <Button variant="secondary" size="sm" disabled={!entry.canContinue} onClick={() => recovery.continueCandidate(entry)}>{text('继续编辑', 'Continue editing')}</Button>
          <Button variant="text" size="sm" onClick={() => recovery.copyCandidate(entry)}>{text('复制', 'Copy')}</Button>
          <Button ref={discardButton} variant="danger" size="sm" onClick={() => setConfirming(true)}>{text('放弃…', 'Discard…')}</Button>
        </>}>
      <Excerpt text={entry.text} />
    </RecoveryShell>
  )
}
