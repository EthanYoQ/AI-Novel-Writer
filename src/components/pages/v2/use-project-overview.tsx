import { useEffect, useRef, useState } from 'react'
import { Archive } from 'lucide-react'

import { ipc } from '../../../services/ipc-client'
import type { ProjectOverview } from '../../../shared/project-overview'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { confirmDeleteCurrentProject } from '../../project-delete-action'
import { UpdateSection } from '../../updates/UpdateSection'
import WelcomePageV2, { type WriterOverview } from './WelcomePageV2'

const EMPTY_OVERVIEW: WriterOverview = { state: 'empty' }

function useProjectOverview() {
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
  const [result, setResult] = useState<{ requestKey: string; overview: ProjectOverview } | null>(null)
  const request = useRef(0)

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
    const requestId = ++request.current
    if (!currentKey) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    const requestKey = `current:${currentKey}`
    void ipc.invokeWithProjectSession(session, 'project:overview-current').then(result => {
      if (request.current === requestId && isProjectSessionCurrent(session)) {
        setResult({ requestKey, overview: result })
      }
    }).catch(() => {
      if (request.current === requestId && isProjectSessionCurrent(session)) {
        setResult({ requestKey, overview: { state: 'unavailable' } })
      }
    })
    return () => { request.current += 1 }
  }, [currentKey])

  const activeSelection = selection?.currentKey === currentKey ? selection : null
  const requestKey = activeSelection?.requestKey ?? (currentKey ? `current:${currentKey}` : '')
  const overview: WriterOverview = result?.requestKey === requestKey
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

    const requestId = ++request.current
    const requestKey = `preview:${itemId}`
    setSelection({ currentKey, itemId, requestKey })
    if (!project.previewCapabilityId) {
      setResult({ requestKey, overview: { state: 'unavailable' } })
      return
    }
    void ipc.invoke('project:peek-overview', project.previewCapabilityId).then((result: ProjectOverview) => {
      if (request.current === requestId) setResult({ requestKey, overview: result })
    }).catch(() => {
      if (request.current === requestId) setResult({ requestKey, overview: { state: 'unavailable' } })
    })
  }

  return {
    overview,
    recentProjects: recentProjects.map(project => ({
      id: project.previewCapabilityId ?? project.path,
      name: project.name,
      onPreview: () => preview(project),
      onOpen: () => { void useProjectStore.getState().openProject(project.path) },
    })),
    hasCurrentProject: currentProject !== null,
    deletableCurrentProject: currentProject && !activeSelection ? { name: currentProject.name, path: currentProject.path } : null,
  }
}

export function WriterWelcomePage({ onNewProject }: { onNewProject: () => void }) {
  const { overview, recentProjects, hasCurrentProject, deletableCurrentProject } = useProjectOverview()
  const text = useLocaleStore(state => state.text)
  const [legacyImportNotice, setLegacyImportNotice] = useState('')
  const [legacyImportBusy, setLegacyImportBusy] = useState(false)
  const importLegacyProject = async () => {
    if (legacyImportBusy) return
    setLegacyImportNotice('')
    setLegacyImportBusy(true)
    try {
      const sourceRoot = await ipc.invoke('dialog:select-legacy-project')
      if (!sourceRoot) return
      const sourceName = sourceRoot.split(/[\\/]/).filter(Boolean).at(-1) || '旧项目'
      const targetRoot = await ipc.invoke('dialog:select-project-restore-target', `${sourceName}-新版副本`)
      if (!targetRoot) return
      const result = await ipc.invoke('project:import-legacy-copy', sourceRoot, targetRoot)
      if (result.state === 'cancelled') return
      if (result.state === 'blocked') {
        setLegacyImportNotice(text(`导入未完成，旧项目保持原样。原因：${result.code}`, `Import did not complete; the original project is unchanged. Reason: ${result.code}`))
        return
      }
      const opened = await useProjectStore.getState().openProject(result.targetRoot).catch(() => false)
      setLegacyImportNotice(opened
        ? text('旧项目已导入为独立副本。两份项目的后续修改不会自动同步。', 'Legacy project imported as an independent copy. Future changes do not sync between the two projects.')
        : text(`副本已建立，但未能自动打开。请用“打开作品”选择：${result.targetRoot}`, `The copy was created but could not be opened. Use Open project to select: ${result.targetRoot}`))
    } catch (error) {
      setLegacyImportNotice(text(`导入未完成：${String(error)}`, `Import did not complete: ${String(error)}`))
    } finally {
      setLegacyImportBusy(false)
    }
  }
  return <WelcomePageV2
    overview={overview}
    recentProjects={recentProjects}
    onNewProject={onNewProject}
    onOpenProject={() => {
      void ipc.invoke('dialog:select-folder').then(folder => {
        if (folder) void useProjectStore.getState().openProject(folder)
      })
    }}
    onImportLegacyProject={() => { void importLegacyProject() }}
    legacyImportNotice={legacyImportNotice}
    legacyImportBusy={legacyImportBusy}
    onImportNovel={() => useLayoutStore.getState().openImportNovel()}
    onContinue={hasCurrentProject ? () => useLayoutStore.getState().setSidebarView('project') : undefined}
    onDeleteCurrentProject={deletableCurrentProject ? () => void confirmDeleteCurrentProject(deletableCurrentProject) : undefined}
    backup={<button type="button" onClick={() => useLayoutStore.getState().openSettings('backup')}>
      <Archive size={17} />
      {text('项目备份', 'Project backup')}
    </button>}
    updates={<UpdateSection />}
  />
}
