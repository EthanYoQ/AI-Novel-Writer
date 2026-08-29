import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectData } from '../../shared/ipc-channels'
import { checkArchStatusWithWordCount, getBlueprintCount } from '../../services/architecture-service'
import { useDraftStore } from '../draft-store'
import { useProjectStore } from '../project-store'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke,
    invokeWithProjectSession: (_context: unknown, channel: string, ...args: unknown[]) => (
      invoke(channel, ...args)
    ),
  },
}))

vi.mock('../../services/project-service', () => ({
  onProjectOpening: vi.fn(),
  onProjectOpened: vi.fn(async () => undefined),
  onProjectClosed: vi.fn(),
}))

function project(key: 'A' | 'B'): ProjectData {
  return {
    id: key,
    name: key,
    path: `C:\\novels\\${key}`,
    sessionLease: `lease-${key}`,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 3,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  invoke.mockReset()
  useProjectStore.setState({
    currentProject: project('A'),
    projectSessionEpoch: 0,
    fileTree: [],
    loading: false,
  })
  useDraftStore.setState({
    draftsByChapter: {},
    loading: false,
    dataProjectKey: null,
    loadingProjectKey: null,
  })
})

describe('project refresh context', () => {
  it('commits only the latest project-open request when IPC replies out of order', async () => {
    const openAResult = deferred<unknown>()
    const openBResult = deferred<unknown>()
    const requestTokens = new Map<string, string>()
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        const [projectPath, requestToken] = args as [string, string]
        requestTokens.set(projectPath, requestToken)
        return projectPath === project('A').path ? openAResult.promise : openBResult.promise
      }
      if (channel === 'project:get-runtime-context') {
        return Promise.resolve({ activeProjectPath: project('B').path, dbReady: true })
      }
      if (channel === 'fs:list-dir') return Promise.resolve([])
      return Promise.resolve([])
    })

    const openingA = useProjectStore.getState().openProject(project('A').path)
    await vi.waitFor(() => {
      expect(requestTokens.get(project('A').path)).toBeTypeOf('string')
    })
    const openingB = useProjectStore.getState().openProject(project('B').path)

    await vi.waitFor(() => {
      expect(requestTokens.get(project('B').path)).toBeTypeOf('string')
    })
    openBResult.resolve({
      success: true,
      project: project('B'),
      requestToken: requestTokens.get(project('B').path),
      activeProjectPath: project('B').path,
      databaseRestored: true,
      dbReady: true,
    })
    await expect(openingB).resolves.toBe(true)
    openAResult.resolve({
      success: false,
      project: null,
      requestToken: requestTokens.get(project('A').path),
      stale: true,
      activeProjectPath: project('B').path,
      databaseRestored: true,
      dbReady: true,
    })
    await expect(openingA).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject?.path).toBe(project('B').path)
    expect(useProjectStore.getState().loading).toBe(false)
    const openCalls = invoke.mock.calls.filter(([channel]) => channel === 'project:open')
    expect(openCalls).toHaveLength(2)
    expect(openCalls[0]?.[3]).toBe(project('A').path)
    expect(openCalls[1]?.[3]).toBe(project('A').path)
  })

  it('does not let a delayed project A file-tree response overwrite project B', async () => {
    const responseA = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    invoke.mockImplementation((channel: string, path: string) => {
      if (channel === 'fs:list-dir' && path === project('A').path) return responseA.promise
      return Promise.resolve([])
    })

    const refreshA = useProjectStore.getState().refreshFileTree(project('A').path)
    useProjectStore.setState({
      currentProject: project('B'),
      fileTree: [{ name: 'B', path: 'B', isDir: true }],
    })
    responseA.resolve([{ name: 'A', path: 'A', isDir: true }])
    await refreshA

    expect(useProjectStore.getState().fileTree).toEqual([
      { name: 'B', path: 'B', isDir: true },
    ])
    expect(invoke).toHaveBeenCalledWith(
      'fs:list-dir',
      project('A').path,
      project('A').path,
    )
  })

  it('does not let a delayed file-tree response overwrite a reopened session of the same project', async () => {
    const responseA = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    invoke.mockImplementation((channel: string, path: string) => {
      if (channel === 'fs:list-dir' && path === project('A').path) return responseA.promise
      return Promise.resolve([])
    })

    const refreshA = useProjectStore.getState().refreshFileTree(project('A').path, 0)
    useProjectStore.setState({
      currentProject: project('A'),
      projectSessionEpoch: 1,
      fileTree: [{ name: 'reopened A', path: 'reopened A', isDir: true }],
    })
    responseA.resolve([{ name: 'stale A', path: 'stale A', isDir: true }])
    await refreshA

    expect(useProjectStore.getState().fileTree).toEqual([
      { name: 'reopened A', path: 'reopened A', isDir: true },
    ])
    expect(invoke).toHaveBeenCalledWith(
      'fs:list-dir',
      project('A').path,
      project('A').path,
    )
  })

  it('does not let a delayed file-tree response overwrite a same-path reopen with a new lease', async () => {
    const responseA = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    invoke.mockImplementation((channel: string, path: string) => {
      if (channel === 'fs:list-dir' && path === project('A').path) return responseA.promise
      return Promise.resolve([])
    })

    const refreshA = useProjectStore.getState().refreshFileTree(project('A').path, 0)
    useProjectStore.setState({
      currentProject: {
        ...project('A'),
        path: 'c:/NOVELS/A/',
        sessionLease: 'lease-A-reopened',
      },
      fileTree: [{ name: 'reopened A', path: 'reopened A', isDir: true }],
    })
    responseA.resolve([{ name: 'stale A', path: 'stale A', isDir: true }])
    await refreshA

    expect(useProjectStore.getState().fileTree).toEqual([
      { name: 'reopened A', path: 'reopened A', isDir: true },
    ])
  })

  it('does not settle a save after a same-path reopen has issued a new lease', async () => {
    const saveA = deferred<{ success: boolean }>()
    invoke.mockImplementation((channel: string) => {
      if (channel === 'project:save') return saveA.promise
      return Promise.resolve([])
    })

    const saving = useProjectStore.getState().saveProject()
    useProjectStore.setState({
      currentProject: {
        ...project('A'),
        path: 'c:/NOVELS/A/',
        sessionLease: 'lease-A-reopened',
      },
    })
    saveA.resolve({ success: true })

    await expect(saving).resolves.toBe(false)
  })

  it('does not let a delayed project A file-tree failure clear project B', async () => {
    const treeA = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    const requestTokens = new Map<string, string>()
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        const [projectPath, requestToken] = args as [string, string]
        requestTokens.set(projectPath, requestToken)
        return Promise.resolve({
          success: true,
          project: projectPath === project('A').path ? project('A') : project('B'),
          requestToken,
          activeProjectPath: projectPath,
        })
      }
      if (channel === 'fs:list-dir' && args[0] === project('A').path) return treeA.promise
      if (channel === 'fs:list-dir' && args[0] === project('B').path) {
        return Promise.resolve([{ name: 'B', path: 'B', isDir: true }])
      }
      return Promise.resolve([])
    })

    const openingA = useProjectStore.getState().openProject(project('A').path)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'fs:list-dir',
      project('A').path,
      project('A').path,
    ))
    const openingB = useProjectStore.getState().openProject(project('B').path)
    await expect(openingB).resolves.toBe(true)
    treeA.reject(new Error('late A tree failure'))
    await expect(openingA).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject?.path).toBe(project('B').path)
    expect(useProjectStore.getState().fileTree).toEqual([
      { name: 'B', path: 'B', isDir: true },
    ])
  })

  it('does not commit delayed project A drafts after switching to project B', async () => {
    const draftsA = deferred<unknown[]>()
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'db:draft-list-all' && args[0] === project('A').path) {
        return draftsA.promise
      }
      return Promise.resolve([])
    })

    const refreshA = useDraftStore.getState().loadAllDrafts(project('A').path)
    useProjectStore.setState({ currentProject: project('B') })
    useDraftStore.setState({ draftsByChapter: { 2: [] } })
    draftsA.resolve([])
    await refreshA

    expect(useDraftStore.getState().draftsByChapter).toEqual({ 2: [] })
    expect(invoke).toHaveBeenCalledWith('db:draft-list-all', project('A').path)
  })

  it('discovers finalized author manuscript chapters even when the project has no blueprints', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'db:draft-list-all') {
        return Promise.resolve([
          {
            id: 1,
            chapterNumber: 1,
            version: 1,
            status: 'finalized',
            source: 'write',
            wordCount: 18,
            createdAt: '2026-08-29T00:00:00.000Z',
          },
          {
            id: 2,
            chapterNumber: 2,
            version: 1,
            status: 'finalized',
            source: 'write',
            wordCount: 18,
            createdAt: '2026-08-29T00:00:00.000Z',
          },
        ])
      }
      return Promise.resolve([])
    })

    await useDraftStore.getState().loadAllDrafts(project('A').path)

    expect(invoke).toHaveBeenCalledWith('db:draft-list-all', project('A').path)
    expect(invoke).not.toHaveBeenCalledWith('db:blueprint-get-all', project('A').path)
    expect(useDraftStore.getState().draftsByChapter).toMatchObject({
      1: [{ id: 1, chapterNumber: 1, status: 'finalized', filePath: 'vela://draft/1' }],
      2: [{ id: 2, chapterNumber: 2, status: 'finalized', filePath: 'vela://draft/2' }],
    })
  })

  it('unbinds project A drafts synchronously and rejects its delayed response', async () => {
    const draftsA = deferred<unknown[]>()
    invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === 'db:draft-list-all' && args[0] === project('A').path) {
        return draftsA.promise
      }
      return Promise.resolve([])
    })
    useDraftStore.setState({
      draftsByChapter: { 1: [] },
      dataProjectKey: project('A').path,
    })

    const refreshA = useDraftStore.getState().loadAllDrafts(project('A').path)
    useDraftStore.getState().beginProjectLoad(project('B').path)

    expect(useDraftStore.getState()).toMatchObject({
      draftsByChapter: {},
      loading: true,
      dataProjectKey: null,
      loadingProjectKey: project('B').path,
    })

    draftsA.resolve([])
    await refreshA
    expect(useDraftStore.getState()).toMatchObject({
      draftsByChapter: {},
      dataProjectKey: null,
      loadingProjectKey: project('B').path,
    })
  })

  it('passes the frozen project path through architecture and blueprint status reads', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'db:project-core-get') {
        return Promise.resolve({
          premise: 'A'.repeat(51),
          charactersArch: '',
          worldbuilding: '',
          synopsis: '',
        })
      }
      if (channel === 'db:character-roster-read') {
        return Promise.resolve({ status: 'empty', renderedMarkdown: '' })
      }
      if (channel === 'db:blueprint-get-all') return Promise.resolve([{ chapterNumber: 1 }])
      return Promise.resolve(null)
    })

    const projectA = project('A')
    const projectSession = {
      projectId: projectA.id,
      leaseId: projectA.sessionLease!,
      projectPath: projectA.path,
    }
    await expect(checkArchStatusWithWordCount(projectSession)).resolves.toMatchObject({
      status: { premise: true },
    })
    await expect(getBlueprintCount(projectSession)).resolves.toBe(1)
    expect(invoke).toHaveBeenCalledWith('db:project-core-get', project('A').path)
    expect(invoke).toHaveBeenCalledWith('db:character-roster-read', project('A').path)
    expect(invoke).toHaveBeenCalledWith('db:blueprint-get-all', project('A').path)
  })
})
