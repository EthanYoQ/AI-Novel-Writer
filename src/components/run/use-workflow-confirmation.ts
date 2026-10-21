import { useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import type { CharacterProposalChoices } from '../../services/character-proposal-choices'
import type { CharacterProposalBatch } from '../../shared/character-proposal'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../stores/workflow-store'

export interface CharacterIdentity {
  characterId: string
  name: string
  role?: string
}

type IdentityView = { runId: string; session: ProjectSessionContext } & (
  | { status: 'ready'; values: CharacterIdentity[] }
  | { status: 'failed' }
)

/** 等作者确认才继续的那一步。运行侧页的确认区读它，只负责排版。 */
export interface WorkflowConfirmation {
  nextStepName: string
  /** 这一步要作者为新出现的角色选采用方式；没有时为 undefined。 */
  proposal?: {
    batch: CharacterProposalBatch
    choices: CharacterProposalChoices
    identities: CharacterIdentity[]
    summary: string
    onChange: (choices: CharacterProposalChoices) => void
  }
  /** 还不能确认的原因（换了作品、角色信息没读到或正在读）。 */
  blocked?: string
  ready: boolean
  confirmLabel: string
  confirm: () => void
}

/**
 * 运行停在需要确认的步骤时返回确认区的内容，否则返回 null。
 * 有角色候选时先按这次项目会话读出现有角色供作者对应；确认前再核对一次运行、会话与角色信息仍是同一份。
 */
export function useWorkflowConfirmation(run: WorkflowRun): WorkflowConfirmation | null {
  const t = (zh: string, en: string) => run.uiLocale === 'en-US' ? en : zh
  const waiting = useWorkflowStore(state => state.waitingRuns[run.id])
  const sessionCurrent = useProjectStore(state => sameProjectSessionContext(run.projectSession, projectSessionContextFromProject(state.currentProject)))
  const [identityView, setIdentityView] = useState<IdentityView>()
  const waitingForConfirm = waiting?.waitingForConfirm ?? false

  useEffect(() => {
    if (!waitingForConfirm || !run.characterProposalBatch || !run.projectSession || !sessionCurrent) return
    let disposed = false
    const session = run.projectSession
    void ipc.invokeWithProjectSession(session, 'character-identity:read').then(snapshot => {
      if (disposed || !sameProjectSessionContext(session, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
      setIdentityView({ runId: run.id, session, status: 'ready', values: snapshot.characters.filter(character => !character.retired)
        .map(character => ({ characterId: character.characterId, name: character.fields.name, role: character.fields.role })) })
    }).catch(() => { if (!disposed) setIdentityView({ runId: run.id, session, status: 'failed' }) })
    return () => { disposed = true }
  }, [waitingForConfirm, run.id, run.characterProposalBatch, run.projectSession, sessionCurrent])

  const nextStepName = waiting && run.steps[waiting.waitingAfterStepIndex + 1]?.name
  if (!waitingForConfirm || !nextStepName || run.status !== 'waiting') return null
  const identityCurrent = identityView?.runId === run.id && sameProjectSessionContext(identityView.session, run.projectSession)
  const identities = identityCurrent && identityView.status === 'ready' ? identityView.values : undefined
  const batch = run.characterProposalBatch
  const ready = !batch || (sessionCurrent && !!identities)

  const confirm = () => {
    const store = useWorkflowStore.getState()
    const latestRun = store.activeRuns.find(candidate => candidate.id === run.id)
    if (!latestRun || latestRun.status !== 'waiting' || !store.waitingRuns[run.id]?.waitingForConfirm) return
    if (latestRun.characterProposalBatch && (!ready
      || !sameProjectSessionContext(latestRun.projectSession, identityView?.session)
      || !sameProjectSessionContext(latestRun.projectSession, projectSessionContextFromProject(useProjectStore.getState().currentProject)))) return
    store.confirmContinue(run.id)
  }

  return {
    nextStepName,
    proposal: batch && run.characterProposalChoices ? {
      batch,
      choices: run.characterProposalChoices,
      identities: identities ?? [],
      summary: t(`角色候选 ${batch.items.length} 项 · 查看并选择`, `${batch.items.length} character candidates · Review choices`),
      onChange: choices => { useWorkflowStore.getState().setCharacterProposalChoices(run.id, choices) },
    } : undefined,
    blocked: !batch || ready ? undefined
      : !sessionCurrent ? t('项目会话已变更，无法确认此任务', 'The project session changed. This task cannot be confirmed.')
        : identityCurrent && identityView.status === 'failed' ? t('角色信息读取失败，暂时无法确认', 'Character information could not be loaded. Confirmation is unavailable.')
          : t('正在读取角色信息', 'Loading character information'),
    ready,
    confirmLabel: batch ? t('按当前选择确认', 'Confirm current choices') : t('确认继续', 'Confirm and continue'),
    confirm,
  }
}
