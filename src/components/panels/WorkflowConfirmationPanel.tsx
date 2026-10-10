import { useEffect, useState, type ComponentProps } from 'react'
import { Play } from 'lucide-react'
import { ipc } from '../../services/ipc-client'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore, type WorkflowRun } from '../../stores/workflow-store'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { CharacterProposalSelectionPanel } from '../characters/CharacterProposalSelectionPanel'

type IdentityView = { runId: string; session: ProjectSessionContext } & (
  | { status: 'ready'; values: ComponentProps<typeof CharacterProposalSelectionPanel>['identities'] }
  | { status: 'failed' }
)

export function WorkflowConfirmationPanel({ run }: { run: WorkflowRun }) {
  const text = (zh: string, en: string) => run.uiLocale === 'en-US' ? en : zh
  const waiting = useWorkflowStore(state => state.waitingRuns[run.id])
  const currentProject = useProjectStore(state => state.currentProject)
  const proposalSessionCurrent = sameProjectSessionContext(run.projectSession, projectSessionContextFromProject(currentProject))
  const [identityView, setIdentityView] = useState<IdentityView>()
  const waitingForConfirm = waiting?.waitingForConfirm ?? false

  useEffect(() => {
    if (!waitingForConfirm || !run.characterProposalBatch || !run.projectSession || !proposalSessionCurrent) return
    let disposed = false
    const session = run.projectSession
    void ipc.invokeWithProjectSession(session, 'character-identity:read').then(snapshot => {
      if (disposed || !sameProjectSessionContext(session, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
      setIdentityView({ runId: run.id, session, status: 'ready', values: snapshot.characters.filter(character => !character.retired)
        .map(character => ({ characterId: character.characterId, name: character.fields.name, role: character.fields.role })) })
    }).catch(() => { if (!disposed) setIdentityView({ runId: run.id, session, status: 'failed' }) })
    return () => { disposed = true }
  }, [waitingForConfirm, run.id, run.characterProposalBatch, run.projectSession, proposalSessionCurrent])

  const nextStepName = waiting && run.steps[waiting.waitingAfterStepIndex + 1]?.name
  if (!waitingForConfirm || !nextStepName || run.status !== 'waiting') return null
  const identityCurrent = identityView?.runId === run.id && sameProjectSessionContext(identityView.session, run.projectSession)
  const identities = identityCurrent && identityView.status === 'ready' ? identityView.values : undefined
  const ready = !run.characterProposalBatch || (proposalSessionCurrent && !!identities)
  const confirm = () => {
    const store = useWorkflowStore.getState()
    const latestRun = store.activeRuns.find(candidate => candidate.id === run.id)
    if (!latestRun || latestRun.status !== 'waiting' || !store.waitingRuns[run.id]?.waitingForConfirm) return
    if (latestRun.characterProposalBatch && (!ready
      || !sameProjectSessionContext(latestRun.projectSession, identityView?.session)
      || !sameProjectSessionContext(latestRun.projectSession, projectSessionContextFromProject(useProjectStore.getState().currentProject)))) return
    store.confirmContinue(run.id)
  }

  return <div data-testid="workflow-confirmation-panel" className="flex min-h-0 flex-col gap-2 rounded border p-2"
    style={{ backgroundColor: 'rgba(var(--color-accent-rgb), 0.07)', borderColor: 'rgba(var(--color-accent-rgb), 0.25)' }}>
    {run.characterProposalBatch && run.characterProposalChoices && <details className="min-h-5 max-h-48 overflow-y-auto text-xs break-words">
      <summary className="cursor-pointer" style={{ color: 'var(--color-text-secondary)' }}>
        {text(`角色候选 ${run.characterProposalBatch.items.length} 项 · 查看并选择`, `${run.characterProposalBatch.items.length} character candidates · Review choices`)}
      </summary>
      <div className="pt-2 pr-1">
        <CharacterProposalSelectionPanel batch={run.characterProposalBatch} choices={run.characterProposalChoices}
          identities={identities ?? []} disabled={!ready}
          onChange={choices => { useWorkflowStore.getState().setCharacterProposalChoices(run.id, choices) }} />
      </div>
    </details>}
    {run.characterProposalBatch && !ready && <p role="status" className="flex-shrink-0 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
      {!proposalSessionCurrent ? text('项目会话已变更，无法确认此任务', 'The project session changed. This task cannot be confirmed.')
        : identityCurrent && identityView.status === 'failed' ? text('角色信息读取失败，暂时无法确认', 'Character information could not be loaded. Confirmation is unavailable.')
          : text('正在读取角色信息', 'Loading character information')}
    </p>}
    <p className="line-clamp-2 flex-shrink-0 break-words text-xs" style={{ color: 'var(--color-text-secondary)' }} title={nextStepName}>
      {text('下一步：', 'Next: ')}{nextStepName}
    </p>
    <button type="button" data-testid="workflow-confirmation-confirm" disabled={!ready} onClick={confirm}
      className="writer-primary-button flex w-full flex-shrink-0 items-center justify-center gap-1 rounded px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50">
      <Play size={10} className="flex-shrink-0" />
      {run.characterProposalBatch ? text('按当前选择确认', 'Confirm current choices') : text('确认继续', 'Confirm and continue')}
    </button>
  </div>
}
