import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc } from '../../../services/ipc-client'
import { countDraftUnits } from '../../../shared/draft-units'
import type { DraftStatus } from '../../../shared/draft-status'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'

/** 版本历史里一稿的类别：时间线节点样式与名字按它取。 */
export type VersionKind = 'draft' | 'refined' | 'final' | 'superseded'

const VERSION_KIND: Record<DraftStatus, VersionKind> = {
  draft: 'draft',
  reviewed: 'draft',
  archived: 'draft',
  revised: 'refined',
  finalized: 'final',
  superseded: 'superseded',
}

/** 版本历史里的一行：这一章的一稿。 */
export interface VersionRecord {
  id: number
  version: number
  type: VersionKind
  word_count: number
  created_at: string
  dependencies_stale: boolean
}

export interface VersionChapter {
  number: number
  title: string
}

/** 一次对比的两边正文。current 为 null 表示读不到当前稿：这一章还没有稿，或最新一稿刚被删掉。 */
export interface VersionComparison {
  older: string
  current: string | null
}

const NO_VERSIONS: VersionRecord[] = []

/** 某一章各稿的读取结果：读到的各稿，或读取失败（稿还在数据库里，只是这次没读出来）。session 为读取时的作品会话。 */
type LoadedVersions = { chapter: number; session: ProjectSessionContext | null } & ({ ok: true; versions: VersionRecord[] } | { ok: false })

/**
 * 版本历史的数据：章节列表、所选章的各稿，以及读取对比两边与回退。版本历史页用它。
 * 回退不覆盖任何一稿，而是用旧稿的正文新建一稿，返回新稿的版本号。
 */
export function useVersionHistory(projectKey: string) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const [chapters, setChapters] = useState<VersionChapter[]>([])
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null)
  // 各稿按章号与会话记下：再点当前章不必清空，换章或重新打开作品后还没读到的就是「正在读取」。
  const [loaded, setLoaded] = useState<LoadedVersions | null>(null)
  const versionRequest = useRef(0)
  const [loading, setLoading] = useState(true)

  const loadChapters = useCallback(async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    setLoading(true)
    try {
      const blueprints = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', projectSession.projectPath)
      if (!isProjectSessionCurrent(projectSession)) return
      setChapters(blueprints.map(blueprint => ({
        number: blueprint.chapterNumber,
        title: blueprint.title || text(`第 ${blueprint.chapterNumber} 章`, `Chapter ${blueprint.chapterNumber}`),
      })))
    } catch {
      if (isProjectSessionCurrent(projectSession)) setChapters([])
    } finally {
      if (isProjectSessionCurrent(projectSession)) setLoading(false)
    }
  }, [currentProject, projectKey, text])

  useEffect(() => {
    let mounted = true
    Promise.resolve().then(() => { if (mounted) void loadChapters() })
    return () => { mounted = false }
  }, [loadChapters])

  /** 读这一章的各稿；只有最后一次读取写进列表，连续点几章时先点那章的结果晚到也不会盖住后点的。 */
  const loadVersions = useCallback(async (chapterNumber: number): Promise<VersionRecord[]> => {
    const project = useProjectStore.getState().currentProject
    const projectSession = captureProjectSession(project)
    const request = ++versionRequest.current
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      setLoaded({ chapter: chapterNumber, session: projectSessionContextFromProject(project), ok: true, versions: [] })
      return []
    }
    const latest = () => request === versionRequest.current && isProjectSessionCurrent(projectSession)
    try {
      const drafts = await ipc.invokeWithProjectSession(projectSession, 'db:draft-list', chapterNumber, projectSession.projectPath)
      if (!isProjectSessionCurrent(projectSession)) return []
      const loaded: VersionRecord[] = drafts.map(draft => ({
        id: draft.id,
        version: draft.version,
        type: VERSION_KIND[draft.status as DraftStatus] ?? 'draft',
        word_count: draft.wordCount || 0,
        created_at: draft.createdAt,
        dependencies_stale: draft.dependenciesStale,
      }))
      if (latest()) setLoaded({ chapter: chapterNumber, session: projectSession, ok: true, versions: loaded })
      return loaded
    } catch {
      if (latest()) setLoaded({ chapter: chapterNumber, session: projectSession, ok: false })
      return []
    }
  }, [projectKey])

  // 同一部作品重新打开（新的会话）时重读：旧会话的读取作废，不重读的话这一章会一直停在「正在读取」。
  const sessionLease = currentProject?.sessionLease
  useEffect(() => {
    if (selectedChapter === null) return
    let mounted = true
    Promise.resolve().then(() => { if (mounted) void loadVersions(selectedChapter) })
    return () => { mounted = false }
  }, [loadVersions, selectedChapter, sessionLease])

  const reloadVersions = useCallback(() => {
    if (selectedChapter === null) return
    setLoaded(null)
    void loadVersions(selectedChapter)
  }, [loadVersions, selectedChapter])


  /** 读出这一稿与这一章最新一稿的正文；这一稿已不存在时返回 'missing'，会话已切换时返回 null，读取出错时抛出。空正文照常对比。 */
  const readComparison = useCallback(async (versionId: number): Promise<VersionComparison | 'missing' | null> => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey) || selectedChapter === null) return null
    const older = (await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', versionId, projectSession.projectPath))?.content
    if (!isProjectSessionCurrent(projectSession)) return null
    if (older === undefined) return 'missing'
    const latest = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-latest', selectedChapter, projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return null
    if (latest?.id === undefined) return { older, current: null }
    if (latest.id === versionId) return { older, current: older }
    const current = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', latest.id, projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return null
    return { older, current: current ? current.content : null }
  }, [projectKey, selectedChapter])

  /**
   * 用这一稿的正文新建一稿（回滚草稿），原有各稿都保留；正文为空的旧稿照样回退成一份空稿。没有新建（会话已切换、旧稿不存在）时返回 null；
   * 已新建时返回数据库分配的版本号，重读列表失败、读不到版本号时 version 为 null。
   */
  const createRollbackDraft = useCallback(async (versionId: number): Promise<{ version: number | null } | null> => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionPath(projectSession, projectKey) || selectedChapter === null) return null
    const content = (await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', versionId, projectSession.projectPath))?.content
    if (!isProjectSessionCurrent(projectSession) || content === undefined) return null
    const nextVersion = await ipc.invokeWithProjectSession(projectSession, 'db:draft-next-version', selectedChapter, projectSession.projectPath)
    if (!isProjectSessionCurrent(projectSession)) return null
    const created = await ipc.invokeWithProjectSession(projectSession, 'db:draft-create', {
      chapterNumber: selectedChapter,
      version: nextVersion,
      source: 'rewrite',
      content,
      wordCount: countDraftUnits(content),
    }, projectSession.projectPath)
    if (!created.success) throw new Error(created.error || text('没有新建回滚草稿', 'the rollback draft was not created'))
    if (!isProjectSessionCurrent(projectSession)) return null
    // 版本号在数据库事务里分配，估算值可能被同时写入的稿占掉，以刷新后的列表为准。
    const refreshed = await loadVersions(selectedChapter)
    return { version: refreshed.find(version => version.id === created.id)?.version ?? null }
  }, [loadVersions, projectKey, selectedChapter, text])

  const currentSession = projectSessionContextFromProject(currentProject)
  const loadedThisSession = loaded !== null && (loaded.session === null
    ? currentSession === null
    : sameProjectSessionContext(loaded.session, currentSession))
  const versionsLoading = selectedChapter !== null && (loaded?.chapter !== selectedChapter || !loadedThisSession)
  const versionsFailed = !versionsLoading && loaded?.ok === false
  const versions = !versionsLoading && loaded?.ok ? loaded.versions : NO_VERSIONS
  return {
    chapters, loading, selectedChapter, selectChapter: setSelectedChapter, versions, versionsLoading, versionsFailed, reloadVersions,
    readComparison, createRollbackDraft,
  }
}
