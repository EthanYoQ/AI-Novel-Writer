import { useCallback, useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { createCharacterProposalChoices, type CharacterProposalChoices } from '../../services/character-proposal-choices'
import type { CharacterProposalBatch, PendingFinalizedCharacterProposalSummary } from '../../shared/character-proposal'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useCharacterStore } from '../../stores/character-store'
import { useLocaleStore } from '../../stores/locale-store'
import { appErrorMessage } from '../../i18n/app-errors'
import { isProjectSessionCurrent } from '../project-session-gate'

/** 主进程只回错误码（经 Electron 加上通道前缀）：按界面语言说明，不把原码给作者看。 */
const failureText = (cause: unknown) => appErrorMessage(useLocaleStore.getState().locale, cause)

/** 定稿或导入产生的待处理角色决策：列出、检查、接受、拒绝。 */
export function usePendingCharacterProposals(session: ProjectSessionContext) {
  const characters = useCharacterStore(state => state.characters)
  const rosterRevision = useCharacterStore(state => state.rosterRevision)
  const [summaries, setSummaries] = useState<PendingFinalizedCharacterProposalSummary[]>([])
  const [batch, setBatch] = useState<CharacterProposalBatch | null>(null)
  const [choices, setChoices] = useState<CharacterProposalChoices | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const identities = characters.flatMap(character => character.characterId
    ? [{ characterId: character.characterId, name: character.name, role: character.role }] : [])

  const loadSummaries = useCallback(async (failure = '') => {
    // 换开或重开作品后，旧会话的读请求必然被主进程拒绝；新会话会以新的 session 重新读取。
    if (!isProjectSessionCurrent(session)) return
    try {
      const pending = await ipc.invokeWithProjectSession(session, 'character-proposal:list-pending-finalized')
      if (!isProjectSessionCurrent(session)) return
      setSummaries(pending)
      setError(failure)
    } catch (cause) {
      if (isProjectSessionCurrent(session)) setError(failureText(cause))
    }
  }, [session])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadSummaries() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadSummaries, rosterRevision])

  async function read(summary: PendingFinalizedCharacterProposalSummary) {
    setBusy(true); setError(''); setBatch(null); setChoices(null)
    try {
      const next = await ipc.invokeWithProjectSession(session, 'character-proposal:read-pending-finalized',
        { proposalBatchId: summary.proposalBatchId })
      if (!isProjectSessionCurrent(session)) return
      setBatch(next); setChoices(createCharacterProposalChoices(next))
    } catch (cause) {
      if (isProjectSessionCurrent(session)) setError(failureText(cause))
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
      await loadSummaries(failureText(cause))
    } finally {
      if (isProjectSessionCurrent(session)) setBusy(false)
    }
  }

  return { summaries, batch, choices, setChoices, busy, error, identities, read, decide, reload: loadSummaries }
}
