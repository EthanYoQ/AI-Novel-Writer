import { useEffect, useRef, useState } from 'react'

import { ipc } from '../../../services/ipc-client'
import type { ProjectOverview } from '../../../shared/project-overview'
import { sameProjectPathKey } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { confirmRemoveRecentProject } from '../../project-delete-action'

export type ShelfOverview = { state: 'loading' | 'empty' } | ProjectOverview

export interface ShelfBook {
  id: string
  name: string
  path: string
  updatedAt: string
  current: boolean
  onPreview: () => void
  onOpen: () => void
  onRemove: () => void
}

const EMPTY_OVERVIEW: ShelfOverview = { state: 'empty' }

/**
 * 书架与作品概览。当前作品读 `project:overview-current`（带摘录），其他书只用 `project:peek-overview` 预览，不正式打开。
 * 书房用这份数据。
 */
export function useShelfOverview() {
  const currentProject = useProjectStore(state => state.currentProject)
  const recentProjects = useProjectStore(state => state.recentProjects)
  const currentKey = currentProject
    ? `${currentProject.id}\0${currentProject.path}\0${currentProject.sessionLease ?? ''}`
    : ''
  const currentSession = captureProjectSession(currentProject)
  const [selection, setSelection] = useState<{
    currentKey: string
    itemId: string
    requestKey: string
  } | null>(null)
  // 当前作品与预览各占一格：预览别的书不会冲掉当前作品已读到的概览，回到当前作品时直接显示。
  const [currentResult, setCurrentResult] = useState<{ requestKey: string; overview: ProjectOverview } | null>(null)
  const [previewResult, setPreviewResult] = useState<{ requestKey: string; overview: ProjectOverview } | null>(null)
  const currentRequest = useRef(0)
  const previewRequest = useRef(0)

  useEffect(() => {
    try {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index)
        if (key?.startsWith('vela:overview:')) localStorage.removeItem(key)
      }
    } catch {
      // Storage can be disabled. Overview remains IPC-only either way.
    }
  }, [])

  useEffect(() => {
    const requestId = ++currentRequest.current
    if (!currentKey) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    const requestKey = `current:${currentKey}`
    void ipc.invokeWithProjectSession(session, 'project:overview-current').then(result => {
      if (currentRequest.current === requestId && isProjectSessionCurrent(session)) {
        setCurrentResult({ requestKey, overview: result })
      }
    }).catch(() => {
      if (currentRequest.current === requestId && isProjectSessionCurrent(session)) {
        setCurrentResult({ requestKey, overview: { state: 'unavailable' } })
      }
    })
    return () => { currentRequest.current += 1 }
  }, [currentKey])

  // 预览的书被移出最近项目后，选择随之作废，概览回到当前作品。
  const activeSelection = selection?.currentKey === currentKey
    && recentProjects.some(project => (project.previewCapabilityId ?? project.path) === selection.itemId) ? selection : null
  const requestKey = activeSelection?.requestKey ?? (currentKey ? `current:${currentKey}` : '')
  const result = activeSelection ? previewResult : currentResult
  const overview: ShelfOverview = result?.requestKey === requestKey
    ? result.overview
    : activeSelection || currentSession
      ? { state: 'loading' }
      : currentProject
        ? { state: 'unavailable' }
        : EMPTY_OVERVIEW

  const preview = (project: (typeof recentProjects)[number]) => {
    const itemId = project.previewCapabilityId ?? project.path
    if (activeSelection?.itemId === itemId) {
      void useProjectStore.getState().openProject(project.path)
      return
    }

    const requestId = ++previewRequest.current
    const requestKey = `preview:${itemId}`
    setSelection({ currentKey, itemId, requestKey })
    if (!project.previewCapabilityId) {
      setPreviewResult({ requestKey, overview: { state: 'unavailable' } })
      return
    }
    void ipc.invoke('project:peek-overview', project.previewCapabilityId).then((result: ProjectOverview) => {
      if (previewRequest.current === requestId) setPreviewResult({ requestKey, overview: result })
    }).catch(() => {
      if (previewRequest.current === requestId) setPreviewResult({ requestKey, overview: { state: 'unavailable' } })
    })
  }

  return {
    overview,
    /** 正在预览的书；为空时概览显示当前作品。 */
    selectedId: activeSelection?.itemId ?? null,
    clearSelection: () => setSelection(null),
    recentProjects: recentProjects.map((project): ShelfBook => ({
      id: project.previewCapabilityId ?? project.path,
      name: project.name,
      path: project.path,
      updatedAt: project.updatedAt,
      current: Boolean(currentProject && sameProjectPathKey(currentProject.path, project.path)),
      onPreview: () => preview(project),
      onOpen: () => { void useProjectStore.getState().openProject(project.path) },
      onRemove: () => { void confirmRemoveRecentProject(project) },
    })),
    hasCurrentProject: currentProject !== null && !activeSelection,
    deletableCurrentProject: currentProject && !activeSelection ? { name: currentProject.name, path: currentProject.path } : null,
  }
}
