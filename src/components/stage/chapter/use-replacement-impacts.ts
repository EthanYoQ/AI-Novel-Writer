import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReplacementImpact } from '../../../shared/chapter-reopen'
import { globalEventBus } from '../../../shared/event-bus'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { ipc } from '../../../services/ipc-client'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'

const seenKey = (projectId: string) => `pagekin:replacement-impact-seen:${projectId}`
const listeners = new Set<() => void>()
let seenVersion = 0

function readSeen(projectId: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(seenKey(projectId)) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function markSeen(projectId: string, finalizationId: string): void {
  try {
    localStorage.setItem(seenKey(projectId), JSON.stringify([...new Set(readSeen(projectId)).add(finalizationId)]))
  } catch { /* 存不下时提示照旧显示。 */ }
  seenVersion++
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useReplacementImpacts(projectKey: string): {
  impacts: readonly ReplacementImpact[]
  acknowledge: (finalizationId: string) => void
} {
  const currentProject = useProjectStore(s => s.currentProject)
  const session = captureProjectSession(currentProject)
  const current = session && isProjectSessionPath(session, projectKey) ? session : null
  const sessionKey = current ? `${current.projectId}:${current.leaseId}` : ''
  const [loaded, setLoaded] = useState<{ sessionKey: string; impacts: ReplacementImpact[] }>({ sessionKey: '', impacts: [] })
  const loadSequence = useRef(0)
  useSyncExternalStore(subscribe, () => seenVersion)

  const load = useCallback(async (projectSession: ProjectSessionContext) => {
    const request = ++loadSequence.current
    const result = await ipc.invokeWithProjectSession(projectSession, 'chapter:replacement-impacts', projectSession.projectPath).catch(() => null)
    if (request !== loadSequence.current || !isProjectSessionCurrent(projectSession)) return
    setLoaded({ sessionKey: `${projectSession.projectId}:${projectSession.leaseId}`, impacts: result?.success ? result.impacts : [] })
  }, [])

  useEffect(() => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (projectSession && isProjectSessionPath(projectSession, projectKey)) void load(projectSession)
  }, [load, projectKey, sessionKey])

  useEffect(() => {
    const reload = ({ projectSession }: { projectSession: ProjectSessionContext }) => {
      if (!isProjectSessionPath(projectSession, projectKey) || !isProjectSessionCurrent(projectSession)) return
      void load(projectSession)
    }
    const offRefresh = globalEventBus.on('REFRESH_RESOURCE', reload)
    const offFinalize = globalEventBus.on('FINALIZE_COMPLETE', reload)
    return () => { offRefresh(); offFinalize() }
  }, [load, projectKey])

  const seen = current ? readSeen(current.projectId) : new Set<string>()
  const impacts = loaded.sessionKey === sessionKey && current
    ? loaded.impacts.filter(impact => impact.finalizationId !== null && !seen.has(impact.finalizationId))
    : []
  const projectId = current?.projectId
  const acknowledge = useCallback((finalizationId: string) => {
    if (projectId) markSeen(projectId, finalizationId)
  }, [projectId])
  return { impacts, acknowledge }
}

export function useReplacementImpactPreview(draftId: number, content: string, enabled: boolean): { impact: ReplacementImpact | null; pending: boolean } {
  const [preview, setPreview] = useState<{ draftId: number; content: string; impact: ReplacementImpact | null } | null>(null)
  const hasSession = captureProjectSession(useProjectStore(s => s.currentProject)) !== null
  useEffect(() => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!enabled || !projectSession) return
    let cancelled = false
    void ipc.invokeWithProjectSession(projectSession, 'chapter:replacement-impact-preview', draftId, content, projectSession.projectPath)
      .catch(() => null)
      .then(result => {
        if (!cancelled && isProjectSessionCurrent(projectSession)) setPreview({ draftId, content, impact: result?.success ? result.impact : null })
      })
    return () => {
      cancelled = true
      setPreview(null)
    }
  }, [draftId, content, enabled])
  const settled = preview?.draftId === draftId && preview.content === content
  return { impact: enabled && settled ? preview.impact : null, pending: enabled && hasSession && !settled }
}
