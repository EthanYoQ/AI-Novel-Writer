import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { ipc } from '../../services/ipc-client'
import { createLegacyRosterGeneration, canContinueLegacyRoster } from '../../services/legacy-roster-generation'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import type { MainGenerationRunHandle } from '../../services/generation/generation-runtime'
import type { LegacyRosterGenerationRecovery } from '../../shared/legacy-roster-generation'
import { formatCharacterProposalPreview } from '../../services/workflows/character-proposal-preview'

export function LegacyRosterRecoveryPanel({ onRecover, busy }: {
  onRecover(options: { recoveryHandle?: MainGenerationRunHandle; restart?: boolean }): Promise<void>
  busy: boolean
}) {
  const text = useLocaleStore(state => state.text)
  const project = useProjectStore(state => state.currentProject)
  const [shown, setShown] = useState<LegacyRosterGenerationRecovery>()
  const [error, setError] = useState('')
  const [sessionKey, setSessionKey] = useState('')
  const key = `${project?.id}:${project?.sessionLease}:${project?.path}`
  useEffect(() => {
    const session = captureProjectSession(project)
    if (!session) return
    let disposed = false
    const client = createLegacyRosterGeneration(session)
    void (async () => {
      const runs = await ipc.invokeWithProjectSession(session, 'generation:list')
      const run = runs.find(item => item.operation === 'legacy-character-roster-repair')
      const value = run ? await client.open({ handle: run.handle }) : undefined
      if (!disposed && isProjectSessionCurrent(session)) { setShown(value); setSessionKey(key); setError('') }
    })().catch(reason => { if (!disposed && isProjectSessionCurrent(session)) { setShown(undefined); setError(String(reason)); setSessionKey(key) } })
    return () => { disposed = true; client.detach() }
  }, [key, busy, project])
  if (key !== sessionKey || !shown && !error) return null
  if (!shown) return <section className="p-2 text-xs space-y-2" aria-label={text('旧角色修复恢复', 'Legacy roster recovery')} onClick={event => event.stopPropagation()}>
    <p role="alert">{text('原运行暂时无法读取；未开始新的请求。', 'The original run could not be read; no new request was started.')} {error}</p>
    <Button size="sm" disabled={busy} onClick={() => { void onRecover({ restart: true }) }}>{text('明确重新开始', 'Start a new run explicitly')}</Button>
  </section>
  const candidates = shown.view.candidates ?? shown.view.artifacts
  const candidateText = shown.proposal ? formatCharacterProposalPreview(shown.proposal, text) : candidates.map(item => item.text).join('\n\n')
  const canRecover = canContinueLegacyRoster(shown)
  return <section className="p-2 text-xs space-y-2" aria-label={text('旧角色修复恢复', 'Legacy roster recovery')} onClick={event => event.stopPropagation()}>
    <div>{text('已保存旧角色修复运行', 'Saved legacy roster repair')} · {shown.modelId}</div>
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{candidateText || shown.context.source.rawLegacy}</pre>
    <p>{text('当前状态原文仅保留为候选；确认采用不会将其变成定稿状态。', 'Original current state remains a candidate; confirmation does not make it finalized state.')}</p>
    {error && <p role="alert">{error}</p>}
    <Button size="sm" onClick={() => { void navigator.clipboard.writeText([shown.context.source.rawLegacy, candidateText].filter(Boolean).join('\n\n')) }}>{text('复制原文与候选', 'Copy source and candidates')}</Button>
    <Button size="sm" disabled={busy || !canRecover} onClick={() => { void onRecover({ recoveryHandle: shown.view.handle }) }}>{text('恢复原运行并查看提议', 'Resume original run and review proposals')}</Button>
    <Button size="sm" disabled={busy} onClick={() => { void onRecover({ restart: true }) }}>{text('明确重新开始', 'Start a new run explicitly')}</Button>
    <Button size="sm" disabled={shown.view.status === 'cancelled'} onClick={() => {
      const session = captureProjectSession(useProjectStore.getState().currentProject)
      if (!session || key !== `${session.projectId}:${session.leaseId}:${session.projectPath}`) return
      const client = createLegacyRosterGeneration(session)
      void client.open({ handle: shown.view.handle }).then(() => client.cancel()).then(() => client.read()).then(value => {
        if (isProjectSessionCurrent(session)) setShown(value)
      }).catch(reason => { if (isProjectSessionCurrent(session)) setError(String(reason)) }).finally(() => client.detach())
    }}>{text('取消原运行', 'Cancel original run')}</Button>
  </section>
}
