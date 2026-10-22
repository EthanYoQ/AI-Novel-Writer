import { useCallback, useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import type { PendingFinalizedCharacterStateCandidate, PendingFinalizedCharacterStateCandidateSummary } from '../../shared/finalized-continuity'
import type { CharacterStateTextField } from '../../shared/character-roster'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useCharacterStore } from '../../stores/character-store'
import { useLocaleStore } from '../../stores/locale-store'
import { appErrorMessage } from '../../i18n/app-errors'
import { isProjectSessionCurrent } from '../project-session-gate'

/** 主进程只回错误码（经 Electron 加上通道前缀）：按界面语言说明，不把原码给作者看。 */
const failureText = (cause: unknown) => appErrorMessage(useLocaleStore.getState().locale, cause)

export const STATE_FIELD_LABELS: Record<CharacterStateTextField, [string, string]> = {
  location: ['位置', 'Location'], powerLevel: ['能力等级', 'Power level'], physicalState: ['身体状态', 'Physical state'],
  mentalState: ['心理状态', 'Mental state'], keyItems: ['关键物品', 'Key items'], recentEvents: ['近期事件', 'Recent events'],
}

/** 定稿产生的待处理角色状态建议：列出、检查、接受、拒绝。 */
export function usePendingStateCandidates(session: ProjectSessionContext) {
  const characters = useCharacterStore(state => state.characters)
  const [summaries, setSummaries] = useState<PendingFinalizedCharacterStateCandidateSummary[]>([])
  const [candidate, setCandidate] = useState<PendingFinalizedCharacterStateCandidate | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadSummaries = useCallback(async (failure = '') => {
    // 换开或重开作品后，旧会话的读请求必然被主进程拒绝；新会话会以新的 session 重新读取。
    if (!isProjectSessionCurrent(session)) return
    try {
      const pending = await ipc.invokeWithProjectSession(session, 'finalized-character:list-state-candidates')
      if (!isProjectSessionCurrent(session)) return
      setSummaries(pending); setError(failure)
    } catch (cause) {
      if (isProjectSessionCurrent(session)) setError(failureText(cause))
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
      if (isProjectSessionCurrent(session)) setError(failureText(cause))
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
      await loadSummaries(failureText(cause))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  const current = candidate && characters.find(character => character.characterId === candidate.characterId)?.currentState?.[candidate.field]
  return { summaries, candidate, current, busy, error, read, decide, reload: loadSummaries }
}
