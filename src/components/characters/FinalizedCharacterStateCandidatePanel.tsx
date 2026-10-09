import { useCallback, useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import type { PendingFinalizedCharacterStateCandidate, PendingFinalizedCharacterStateCandidateSummary } from '../../shared/finalized-continuity'
import type { CharacterStateTextField } from '../../shared/character-roster'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useCharacterStore } from '../../stores/character-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import { Button } from '../ui/Button'

const labels: Record<CharacterStateTextField, [string, string]> = {
  location: ['位置', 'Location'], powerLevel: ['能力等级', 'Power level'], physicalState: ['身体状态', 'Physical state'],
  mentalState: ['心理状态', 'Mental state'], keyItems: ['关键物品', 'Key items'], recentEvents: ['近期事件', 'Recent events'],
}

export function FinalizedCharacterStateCandidatePanel() {
  const project = useProjectStore(state => state.currentProject)
  const session = captureProjectSession(project)
  return session ? <SessionPanel key={`${session.projectId}:${session.leaseId}`} session={session} /> : null
}

function SessionPanel({ session }: { session: ProjectSessionContext }) {
  const text = useLocaleStore(state => state.text)
  const characters = useCharacterStore(state => state.characters)
  const [summaries, setSummaries] = useState<PendingFinalizedCharacterStateCandidateSummary[]>([])
  const [candidate, setCandidate] = useState<PendingFinalizedCharacterStateCandidate | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadSummaries = useCallback(async (failure = '') => {
    try {
      const pending = await ipc.invokeWithProjectSession(session, 'finalized-character:list-state-candidates')
      if (!isProjectSessionCurrent(session)) return
      setSummaries(pending); setError(failure)
    } catch (cause) {
      if (isProjectSessionCurrent(session)) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [session])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadSummaries() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadSummaries])

  async function read(summary: PendingFinalizedCharacterStateCandidateSummary) {
    setBusy(true); setError(''); setCandidate(null)
    try {
      const next = await ipc.invokeWithProjectSession(session, 'finalized-character:read-state-candidate', {
        draftId: summary.draftId, candidateKey: summary.candidateKey,
      })
      if (isProjectSessionCurrent(session)) setCandidate(next)
    } catch (cause) {
      if (isProjectSessionCurrent(session)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  async function decide(decision: 'accept' | 'decline') {
    if (!candidate || busy) return
    setBusy(true); setError('')
    try {
      await ipc.invokeWithProjectSession(session, 'finalized-character:decide-state-candidate', {
        draftId: candidate.source.draftId, candidateKey: candidate.candidateKey, characterId: candidate.characterId,
        field: candidate.field, expectedFieldRevision: candidate.expectedFieldRevision,
        expectedFieldValueHash: candidate.expectedFieldValueHash,
        operationId: `finalized-character-state:${decision}:${candidate.candidateKey}`, decision,
      })
      if (!isProjectSessionCurrent(session)) return
      if (decision === 'accept') await useCharacterStore.getState().load(session.projectPath, session)
      setCandidate(null)
      await loadSummaries()
    } catch (cause) {
      if (!isProjectSessionCurrent(session)) return
      setCandidate(null)
      await loadSummaries(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  if (!summaries.length && !error) return null
  const current = candidate && characters.find(character => character.characterId === candidate.characterId)?.currentState?.[candidate.field]
  return <section className="border-b border-[var(--color-border)] p-2 space-y-2"
    aria-label={text('待处理角色状态建议', 'Pending state suggestions')}>
    {summaries.length > 0 && <>
      <div className="text-xs font-medium">{text(`待处理角色状态建议（${summaries.length}）`, `Pending state suggestions (${summaries.length})`)}</div>
      {!candidate && summaries.map(summary => <Button key={summary.candidateKey} variant="outline" size="sm" disabled={busy}
        aria-label={text('检查定稿状态建议', 'Review finalized state suggestion')} onClick={() => void read(summary)}>
        {summary.characterName} · {text(...labels[summary.field])}
      </Button>)}
    </>}
    {error && <p role="alert" className="text-xs text-[var(--color-error)] break-all">{error}</p>}
    {candidate && <>
      <div className="text-xs space-y-1">
        <div className="font-medium">{candidate.characterName} · {text(...labels[candidate.field])}</div>
        <div>{text('当前：', 'Current: ')}{current || text('空', 'Empty')}</div>
        <div>{text('建议：', 'Suggested: ')}{candidate.value}</div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void decide('decline')}>
          {text('拒绝状态建议', 'Reject state suggestion')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void decide('accept')}>
          {text('接受状态建议', 'Accept state suggestion')}
        </Button>
      </div>
    </>}
  </section>
}
