import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReplacementImpact } from '../../../shared/chapter-reopen'
import { globalEventBus } from '../../../shared/event-bus'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { ipc } from '../../../services/ipc-client'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'

/**
 * 替换影响提示点过「知道了」的，只是这台电脑上的显示偏好：按作品记替换者的 finalizationId，沿用运行侧页隐藏候选的记法，
 * 不写进作品库。同一章再替换一次是新的 finalizationId，提示会再出现。存储不可用时什么也不隐藏。
 */
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

/**
 * 本作品还没点「知道了」的替换影响（ADR-0024）。第 N 章顶部的提示与后续章的「写于第 N 章修改之前」读的是同一份，
 * 点了「知道了」两处一起消失。定稿、后处理等改动作品后发出的刷新事件会重读；读不出来时当作没有影响，不挡写作。
 */
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

  useEffect(() => globalEventBus.on('REFRESH_RESOURCE', payload => {
    if (!isProjectSessionPath(payload.projectSession, projectKey) || !isProjectSessionCurrent(payload.projectSession)) return
    void load(payload.projectSession)
  }), [load, projectKey])

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

/** 重开稿定稿前的影响预览：enabled 变为 true（定稿确认框打开）时按这一稿现算一次；读不出来或不是重开稿时为 null。 */
export function useReplacementImpactPreview(draftId: number, enabled: boolean): ReplacementImpact | null {
  const [preview, setPreview] = useState<{ draftId: number; impact: ReplacementImpact | null } | null>(null)
  useEffect(() => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!enabled || !projectSession) return
    let cancelled = false
    void ipc.invokeWithProjectSession(projectSession, 'chapter:replacement-impact-preview', draftId, projectSession.projectPath)
      .catch(() => null)
      .then(result => {
        if (!cancelled && isProjectSessionCurrent(projectSession)) setPreview({ draftId, impact: result?.success ? result.impact : null })
      })
    return () => { cancelled = true }
  }, [draftId, enabled])
  return enabled && preview?.draftId === draftId ? preview.impact : null
}
