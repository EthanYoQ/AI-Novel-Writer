import { useCallback, useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { createCharacterProposalChoices, type CharacterProposalChoices } from '../../services/character-proposal-choices'
import type { CharacterProposalBatch, PendingFinalizedCharacterProposalSummary } from '../../shared/character-proposal'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useCharacterStore } from '../../stores/character-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import { Button } from '../ui/Button'
import { CharacterProposalSelectionPanel } from './CharacterProposalSelectionPanel'

export function FinalizedCharacterProposalPanel() {
  const project = useProjectStore(state => state.currentProject)
  const session = captureProjectSession(project)
  return session ? <SessionPanel key={`${session.projectId}:${session.leaseId}`} session={session} /> : null
}

function SessionPanel({ session }: { session: ProjectSessionContext }) {
  const text = useLocaleStore(state => state.text)
  const characters = useCharacterStore(state => state.characters)
  const [summaries, setSummaries] = useState<PendingFinalizedCharacterProposalSummary[]>([])
  const [batch, setBatch] = useState<CharacterProposalBatch | null>(null)
  const [choices, setChoices] = useState<CharacterProposalChoices | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const identities = characters.flatMap(character => character.characterId
    ? [{ characterId: character.characterId, name: character.name, role: character.role }] : [])

  const loadSummaries = useCallback(async (failure = '') => {
    try {
      const pending = await ipc.invokeWithProjectSession(session, 'character-proposal:list-pending-finalized')
      if (!isProjectSessionCurrent(session)) return
      setSummaries(pending)
      setError(failure)
    } catch (cause) {
      if (isProjectSessionCurrent(session)) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [session])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadSummaries() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadSummaries])

  async function read(summary: PendingFinalizedCharacterProposalSummary) {
    setBusy(true); setError(''); setBatch(null); setChoices(null)
    try {
      const next = await ipc.invokeWithProjectSession(session, 'character-proposal:read-pending-finalized',
        { proposalBatchId: summary.proposalBatchId })
      if (!isProjectSessionCurrent(session)) return
      setBatch(next); setChoices(createCharacterProposalChoices(next))
    } catch (cause) {
      if (isProjectSessionCurrent(session)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  async function decide(action: 'approve' | 'cancel') {
    if (!batch || !choices || busy) return
    setBusy(true); setError('')
    try {
      if (action === 'approve') await ipc.invokeWithProjectSession(session, 'character-proposal:approve', {
        proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
        operationId: `finalized-character-adoption:${batch.proposalBatchId}`,
        selections: choices.selections, relationships: choices.relationships,
      })
      else await ipc.invokeWithProjectSession(session, 'character-proposal:cancel', {
        proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
      })
      if (!isProjectSessionCurrent(session)) return
      if (action === 'approve') await useCharacterStore.getState().load(session.projectPath, session)
      setBatch(null); setChoices(null)
      await loadSummaries()
    } catch (cause) {
      if (!isProjectSessionCurrent(session)) return
      setBatch(null); setChoices(null)
      await loadSummaries(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  if (!summaries.length && !error) return null
  return <section className="border-b border-[var(--color-border)] p-2 space-y-2" aria-label={text('待处理定稿角色决策', 'Pending finalized character decisions')}>
    {summaries.length > 0 && <>
      <div className="text-xs font-medium">{text(`待处理定稿角色决策（${summaries.length}）`, `Pending finalized character decisions (${summaries.length})`)}</div>
      {!batch && summaries.map(summary => <Button key={summary.proposalBatchId} variant="outline" size="sm" disabled={busy}
        aria-label={text('检查定稿角色决策', 'Review finalized character decision')} onClick={() => void read(summary)}>
        {text('检查定稿角色决策', 'Review finalized character decision')} · {summary.finalizationId}
      </Button>)}
    </>}
    {error && <p role="alert" className="text-xs text-[var(--color-error)] break-all">{error}</p>}
    {batch && choices && <>
      <CharacterProposalSelectionPanel batch={batch} identities={identities} choices={choices} onChange={setChoices} disabled={busy} />
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void decide('cancel')}>{text('拒绝这些决策', 'Reject decisions')}</Button>
        <Button size="sm" disabled={busy} onClick={() => void decide('approve')}>{text('接受这些决策', 'Accept decisions')}</Button>
      </div>
    </>}
  </section>
}
