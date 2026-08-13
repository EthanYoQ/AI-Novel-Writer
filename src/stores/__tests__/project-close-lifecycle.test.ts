import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectData } from '../../shared/ipc-channels'
import { useEditorStore } from '../editor-store'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { useWorkflowStore } from '../workflow-store'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  alertError: vi.fn(),
  onProjectOpening: vi.fn(),
  onProjectOpened: vi.fn(async (): Promise<{ warnings: string[] } | undefined> => undefined),
  disableProjectBindingsPreservingDrafts: vi.fn(),
  onProjectClosed: vi.fn(async (projectPath: string | null) => {
    const { useEditorStore } = await import('../editor-store')
    if (projectPath) useEditorStore.getState().clearProjectTabs(projectPath)
    else useEditorStore.getState().clearTabs()
  }),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    invokeWithProjectSession: (_context: unknown, channel: string, ...args: unknown[]) => (
      mocks.invoke(channel, ...args)
    ),
  },
}))

vi.mock('../../components/ui/AlertDialog', () => ({
  alertError: mocks.alertError,
}))

vi.mock('../../services/project-service', () => ({
  disableProjectBindingsPreservingDrafts: mocks.disableProjectBindingsPreservingDrafts,
  onProjectOpening: mocks.onProjectOpening,
  onProjectOpened: mocks.onProjectOpened,
  onProjectClosed: mocks.onProjectClosed,
}))

function project(key: 'A' | 'B' | 'C'): ProjectData {
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

/**
 * Opening work must receive the same immutable identity that later IPC and
 * event handlers use.  A matching path alone would allow a same-directory
 * reopen with a newer lease to accept stale work.
 */
function projectSession(key: 'A' | 'B' | 'C') {
  const value = project(key)
  return {
    projectId: value.id,
    leaseId: value.sessionLease!,
    projectPath: value.path,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({
    currentProject: project('A'),
    fileTree: [{ name: 'A', path: 'A', isDir: true }],
    loading: false,
    projectSessionEpoch: 0,
  })
  useEditorStore.setState({
    tabs: [{
      id: 'a-tab',
      name: 'A',
      type: 'outline',
      projectKey: project('A').path,
      dirty: true,
    }],
    activeTabId: 'a-tab',
    draftLedgers: {},
  })
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
})

describe('project close lifecycle', () => {
  it('increments the project session epoch for every successful open, including the same path', async () => {
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        return {
          success: true,
          project: project('A'),
          requestToken: args[1],
          activeProjectPath: project('A').path,
          databaseRestored: true,
          dbReady: true,
        }
      }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useProjectStore.getState().openProject(project('A').path)).resolves.toBe(true)
    expect(useProjectStore.getState().projectSessionEpoch).toBe(1)
    await expect(useProjectStore.getState().openProject(project('A').path)).resolves.toBe(true)
    expect(useProjectStore.getState().projectSessionEpoch).toBe(2)
  })

  it('waits for a cancelled project workflow to really exit before closing the database', async () => {
    const executor = deferred<void>()
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:close') return { success: true }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    const workflow = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'A background task',
      projectPath: project('A').path,
      projectSession: projectSession('A'),
      steps: [{
        name: 'blocked',
        description: 'blocked',
        executor: async () => executor.promise,
      }],
    })
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns).toHaveLength(1))

    const closing = useProjectStore.getState().closeProject()
    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('cancelling')
    })
    expect(mocks.invoke).not.toHaveBeenCalledWith('db:close', project('A').path)
    expect(useProjectStore.getState().currentProject?.path).toBe(project('A').path)

    executor.resolve()
    await workflow
    await expect(closing).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('db:close', project('A').path)
    expect(mocks.onProjectClosed).toHaveBeenCalledWith(project('A').path)
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(useProjectStore.getState().currentProject).toBeNull()
  })

  it('keeps other projects tabs and draft ledgers when closing the current project', async () => {
    const aPath = project('A').path
    const bPath = project('B').path
    useEditorStore.setState({
      tabs: [
        { id: 'a-tab', name: 'A', type: 'config', projectKey: aPath, dirty: true },
        { id: 'b-tab', name: 'B', type: 'config', projectKey: bPath, dirty: true },
      ],
      activeTabId: 'a-tab',
      draftLedgers: {
        config: JSON.stringify({
          version: 1,
          projects: [
            { projectKey: aPath, baseValue: {}, draftValue: { genre: 'A' } },
            { projectKey: bPath, baseValue: {}, draftValue: { genre: 'B' } },
          ],
        }),
      },
    })
    mocks.invoke.mockResolvedValue({ success: true })

    await expect(useProjectStore.getState().closeProject()).resolves.toBe(true)

    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({ id: 'b-tab', projectKey: bPath, dirty: true }),
    ])
    expect(JSON.parse(useEditorStore.getState().draftLedgers.config).projects).toEqual([
      expect.objectContaining({ projectKey: bPath }),
    ])
    expect(useEditorStore.getState().activeTabId).toBe('b-tab')
  })

  it('treats database close as committed even when renderer cleanup fails', async () => {
    mocks.invoke.mockResolvedValue({ success: true })
    mocks.onProjectClosed.mockRejectedValueOnce(new Error('renderer cleanup failed'))

    await expect(useProjectStore.getState().closeProject()).resolves.toBe(true)

    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(useProjectStore.getState().fileTree).toEqual([])
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('renderer cleanup failed'),
      expect.objectContaining({ title: '项目已关闭，界面清理未完成' }),
    )
  })

  it('keeps project state and tabs when database close reports a business failure', async () => {
    mocks.invoke.mockResolvedValue({ success: false, error: 'database busy' })

    await expect(useProjectStore.getState().closeProject()).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject?.path).toBe(project('A').path)
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(mocks.onProjectClosed).not.toHaveBeenCalled()
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('database busy'),
      expect.objectContaining({ title: '关闭项目失败' }),
    )
  })

  it('quiesces project A workflows before switching the main-process database to B', async () => {
    const executor = deferred<void>()
    let openCalled = false
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        openCalled = true
        return {
          success: true,
          project: project('B'),
          requestToken: args[1],
          activeProjectPath: project('B').path,
        }
      }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })
    const workflow = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'A background task',
      projectPath: project('A').path,
      projectSession: projectSession('A'),
      steps: [{
        name: 'blocked',
        description: 'blocked',
        executor: async () => executor.promise,
      }],
    })
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns).toHaveLength(1))

    const opening = useProjectStore.getState().openProject(project('B').path)
    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('cancelling')
    })
    expect(openCalled).toBe(false)

    executor.resolve()
    await workflow
    await expect(opening).resolves.toBe(true)
    expect(openCalled).toBe(true)
    expect(useWorkflowStore.getState().activeRuns).toEqual([])
    expect(useProjectStore.getState().currentProject?.path).toBe(project('B').path)
  })

  it('quiesces the current project before asking the main process to create a new database', async () => {
    const executor = deferred<void>()
    let createCalled = false
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:create') {
        createCalled = true
        return {
          success: true,
          projectId: 'B',
          projectPath: project('B').path,
          requestToken: args[1],
          activeProjectPath: project('A').path,
        }
      }
      if (channel === 'project:open') {
        return {
          success: true,
          project: project('B'),
          requestToken: args[1],
          activeProjectPath: project('B').path,
        }
      }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })
    const workflow = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'A background task',
      projectPath: project('A').path,
      projectSession: projectSession('A'),
      steps: [{
        name: 'blocked',
        description: 'blocked',
        executor: async () => executor.promise,
      }],
    })
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns).toHaveLength(1))

    const creating = useProjectStore.getState().createProject({
      name: 'B',
      path: 'C:\\novels',
      genre: '玄幻',
      targetAudience: '全龄',
    })
    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('cancelling')
    })
    expect(createCalled).toBe(false)

    executor.resolve()
    await workflow
    await expect(creating).resolves.toBe(true)
    expect(createCalled).toBe(true)
    expect(useProjectStore.getState().currentProject?.path).toBe(project('B').path)
  })

  it('does not create from a stale project snapshot when a newer open wins during quiescence', async () => {
    const executor = deferred<void>()
    const pendingOpen = deferred<{
      success: boolean
      project: ProjectData
      requestToken: string
      activeProjectPath: string
      databaseRestored: boolean
      dbReady: boolean
    }>()
    let createCalled = false
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:create') {
        createCalled = true
        throw new Error('stale create must not reach the main process')
      }
      if (channel === 'project:open') {
        return pendingOpen.promise.then(result => ({
          ...result,
          requestToken: args[1] as string,
        }))
      }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })
    const workflow = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'A background task',
      projectPath: project('A').path,
      projectSession: projectSession('A'),
      steps: [{
        name: 'blocked',
        description: 'blocked',
        executor: async () => executor.promise,
      }],
    })
    await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns).toHaveLength(1))

    const creating = useProjectStore.getState().createProject({
      name: 'C',
      path: 'C:\\novels',
      genre: '玄幻',
      targetAudience: '全龄',
    })
    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('cancelling')
    })
    const opening = useProjectStore.getState().openProject(project('B').path)

    executor.resolve()
    await workflow
    await expect(creating).resolves.toBe(false)
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'project:open',
      project('B').path,
      expect.any(String),
      project('A').path,
    ))
    expect(useProjectStore.getState().loading).toBe(true)
    expect(mocks.alertError).not.toHaveBeenCalled()
    expect(createCalled).toBe(false)

    pendingOpen.resolve({
      success: true,
      project: project('B'),
      requestToken: '',
      activeProjectPath: project('B').path,
      databaseRestored: true,
      dbReady: true,
    })
    await expect(opening).resolves.toBe(true)
    expect(useProjectStore.getState().loading).toBe(false)
    expect(useProjectStore.getState().currentProject?.path).toBe(project('B').path)
  })

  it('detaches when an old open switched the main database but the newer open failed before IPC', async () => {
    const oldOpenResult = deferred<{
      success: boolean
      project: ProjectData
      requestToken: string
      activeProjectPath: string
      databaseRestored: boolean
      dbReady: boolean
    }>()
    const cancelSpy = vi.spyOn(
      useWorkflowStore.getState(),
      'cancelProjectWorkflowsAndWait',
    )
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('cancel timeout'))
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open' && args[0] === project('B').path) {
        return oldOpenResult.promise.then(result => ({
          ...result,
          requestToken: args[1] as string,
        }))
      }
      if (channel === 'project:open') {
        throw new Error('new open must fail before IPC')
      }
      if (channel === 'project:get-runtime-context') {
        return { activeProjectPath: project('B').path, dbReady: true }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    try {
      const openingB = useProjectStore.getState().openProject(project('B').path)
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
        'project:open',
        project('B').path,
        expect.any(String),
        project('A').path,
      ))

      const openingC = useProjectStore.getState().openProject(project('C').path)
      await expect(openingC).resolves.toBe(false)
      expect(useProjectStore.getState().currentProject?.path).toBe(project('A').path)

      oldOpenResult.resolve({
        success: true,
        project: project('B'),
        requestToken: '',
        activeProjectPath: project('B').path,
        databaseRestored: true,
        dbReady: true,
      })
      await expect(openingB).resolves.toBe(false)

      expect(useProjectStore.getState().currentProject).toBeNull()
      expect(useProjectStore.getState().fileTree).toEqual([])
      expect(useEditorStore.getState().tabs).toHaveLength(1)
      expect(mocks.disableProjectBindingsPreservingDrafts).toHaveBeenCalledWith(project('A').path)
      expect(mocks.onProjectClosed).not.toHaveBeenCalled()
      expect(mocks.alertError).toHaveBeenCalledWith(
        expect.stringContaining('过期的项目打开结果'),
        expect.objectContaining({ title: '项目数据库状态不一致，已停用项目' }),
      )
    } finally {
      cancelSpy.mockRestore()
    }
  })

  it('detaches when an accepted open becomes stale while renderer project opening is pending', async () => {
    const rendererOpening = deferred<void>()
    mocks.onProjectOpening.mockImplementationOnce(async () => rendererOpening.promise)
    const cancelSpy = vi.spyOn(
      useWorkflowStore.getState(),
      'cancelProjectWorkflowsAndWait',
    )
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('cancel timeout'))
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open' && args[0] === project('B').path) {
        return {
          success: true,
          project: project('B'),
          requestToken: args[1],
          activeProjectPath: project('B').path,
          databaseRestored: true,
          dbReady: true,
        }
      }
      if (channel === 'project:open') {
        throw new Error('new open must fail before IPC')
      }
      if (channel === 'project:get-runtime-context') {
        return { activeProjectPath: project('B').path, dbReady: true }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    try {
      const openingB = useProjectStore.getState().openProject(project('B').path)
      await vi.waitFor(() => expect(mocks.onProjectOpening).toHaveBeenCalledWith(
        projectSession('B'),
      ))

      const openingC = useProjectStore.getState().openProject(project('C').path)
      await expect(openingC).resolves.toBe(false)
      expect(useProjectStore.getState().currentProject?.path).toBe(project('A').path)

      rendererOpening.resolve()
      await expect(openingB).resolves.toBe(false)

      expect(useProjectStore.getState().currentProject).toBeNull()
      expect(useProjectStore.getState().fileTree).toEqual([])
      expect(useEditorStore.getState().tabs).toHaveLength(1)
      expect(mocks.disableProjectBindingsPreservingDrafts).toHaveBeenCalledWith(project('A').path)
      expect(mocks.onProjectClosed).not.toHaveBeenCalled()
      expect(mocks.alertError).toHaveBeenCalledWith(
        expect.stringContaining('过期的项目打开结果'),
        expect.objectContaining({ title: '项目数据库状态不一致，已停用项目' }),
      )
    } finally {
      cancelSpy.mockRestore()
    }
  })

  it('keeps a newer successful project bound when an accepted older open resumes', async () => {
    const rendererOpening = deferred<void>()
    mocks.onProjectOpening.mockImplementationOnce(async () => rendererOpening.promise)
    const cancelSpy = vi.spyOn(
      useWorkflowStore.getState(),
      'cancelProjectWorkflowsAndWait',
    ).mockResolvedValue()
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open' && args[0] === project('B').path) {
        return {
          success: true,
          project: project('B'),
          requestToken: args[1],
          activeProjectPath: project('B').path,
          databaseRestored: true,
          dbReady: true,
        }
      }
      if (channel === 'project:open' && args[0] === project('C').path) {
        return {
          success: true,
          project: project('C'),
          requestToken: args[1],
          activeProjectPath: project('C').path,
          databaseRestored: true,
          dbReady: true,
        }
      }
      if (channel === 'project:get-runtime-context') {
        return { activeProjectPath: project('C').path, dbReady: true }
      }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    try {
      const openingB = useProjectStore.getState().openProject(project('B').path)
      await vi.waitFor(() => expect(mocks.onProjectOpening).toHaveBeenCalledWith(
        projectSession('B'),
      ))

      const openingC = useProjectStore.getState().openProject(project('C').path)
      await expect(openingC).resolves.toBe(true)
      expect(useProjectStore.getState().currentProject?.path).toBe(project('C').path)

      rendererOpening.resolve()
      await expect(openingB).resolves.toBe(false)

      expect(useProjectStore.getState().currentProject?.path).toBe(project('C').path)
      expect(mocks.onProjectClosed).not.toHaveBeenCalled()
      expect(mocks.alertError).not.toHaveBeenCalled()
      expect(mocks.invoke).toHaveBeenCalledWith('project:get-runtime-context')
    } finally {
      cancelSpy.mockRestore()
    }
  })

  it('uses the current renderer identity when the live-context query resolves', async () => {
    const rendererOpening = deferred<void>()
    const openingCResult = deferred<{
      success: boolean
      project: ProjectData
      requestToken: string
      activeProjectPath: string
      databaseRestored: boolean
      dbReady: boolean
    }>()
    const runtimeContext = deferred<{
      activeProjectPath: string
      dbReady: boolean
    }>()
    mocks.onProjectOpening.mockImplementationOnce(async () => rendererOpening.promise)
    const cancelSpy = vi.spyOn(
      useWorkflowStore.getState(),
      'cancelProjectWorkflowsAndWait',
    ).mockResolvedValue()
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open' && args[0] === project('B').path) {
        return {
          success: true,
          project: project('B'),
          requestToken: args[1],
          activeProjectPath: project('B').path,
          databaseRestored: true,
          dbReady: true,
        }
      }
      if (channel === 'project:open' && args[0] === project('C').path) {
        return openingCResult.promise.then(result => ({
          ...result,
          requestToken: args[1] as string,
        }))
      }
      if (channel === 'project:get-runtime-context') return runtimeContext.promise
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    try {
      const openingB = useProjectStore.getState().openProject(project('B').path)
      await vi.waitFor(() => expect(mocks.onProjectOpening).toHaveBeenCalledWith(
        projectSession('B'),
      ))
      const openingC = useProjectStore.getState().openProject(project('C').path)
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
        'project:open',
        project('C').path,
        expect.any(String),
        project('A').path,
      ))

      rendererOpening.resolve()
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
        'project:get-runtime-context',
      ))
      openingCResult.resolve({
        success: true,
        project: project('C'),
        requestToken: '',
        activeProjectPath: project('C').path,
        databaseRestored: true,
        dbReady: true,
      })
      await expect(openingC).resolves.toBe(true)

      runtimeContext.resolve({
        activeProjectPath: project('C').path,
        dbReady: true,
      })
      await expect(openingB).resolves.toBe(false)

      expect(useProjectStore.getState().currentProject?.path).toBe(project('C').path)
      expect(mocks.onProjectClosed).not.toHaveBeenCalled()
      expect(mocks.alertError).not.toHaveBeenCalled()
    } finally {
      cancelSpy.mockRestore()
    }
  })

  it('detaches conservatively when the live project context cannot be queried', async () => {
    const oldOpenResult = deferred<{
      success: boolean
      project: ProjectData
      requestToken: string
      activeProjectPath: string
      databaseRestored: boolean
      dbReady: boolean
    }>()
    const cancelSpy = vi.spyOn(
      useWorkflowStore.getState(),
      'cancelProjectWorkflowsAndWait',
    )
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('cancel timeout'))
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open' && args[0] === project('B').path) {
        return oldOpenResult.promise.then(result => ({
          ...result,
          requestToken: args[1] as string,
        }))
      }
      if (channel === 'project:open') {
        throw new Error('new open must fail before IPC')
      }
      if (channel === 'project:get-runtime-context') {
        throw new Error('runtime context unavailable')
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    useEditorStore.setState({
      tabs: [
        {
          id: 'config-a',
          name: '小说配置',
          type: 'config',
          projectKey: project('A').path,
          dirty: true,
        },
        {
          id: 'characters-a',
          name: '角色卡',
          type: 'character',
          projectKey: project('A').path,
          dirty: true,
        },
        {
          id: 'chapter-a',
          name: '第一章',
          type: 'chapter',
          projectKey: project('A').path,
          content: '未保存正文',
          savedContent: '旧正文',
          dirty: true,
        },
      ],
      activeTabId: 'chapter-a',
      draftLedgers: {
        config: JSON.stringify({
          version: 1,
          projects: [{ projectKey: project('A').path, draftValue: { genre: '未保存配置' } }],
        }),
        'character-editor-drafts': JSON.stringify({
          version: 1,
          projects: [{ projectKey: project('A').path, draftValue: [{ name: '未保存角色' }] }],
        }),
      },
    })

    try {
      const openingB = useProjectStore.getState().openProject(project('B').path)
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
        'project:open',
        project('B').path,
        expect.any(String),
        project('A').path,
      ))

      const openingC = useProjectStore.getState().openProject(project('C').path)
      await expect(openingC).resolves.toBe(false)
      oldOpenResult.resolve({
        success: true,
        project: project('B'),
        requestToken: '',
        activeProjectPath: project('B').path,
        databaseRestored: true,
        dbReady: true,
      })
      await expect(openingB).resolves.toBe(false)

      expect(useProjectStore.getState().currentProject).toBeNull()
      expect(useEditorStore.getState().tabs).toHaveLength(3)
      expect(useEditorStore.getState().tabs.every(tab => tab.dirty)).toBe(true)
      expect(useEditorStore.getState().draftLedgers).toHaveProperty('config')
      expect(useEditorStore.getState().draftLedgers).toHaveProperty('character-editor-drafts')
      expect(mocks.disableProjectBindingsPreservingDrafts).toHaveBeenCalledWith(project('A').path)
      expect(mocks.onProjectClosed).not.toHaveBeenCalled()
      expect(mocks.alertError).toHaveBeenCalledWith(
        expect.stringContaining('runtime context unavailable'),
        expect.objectContaining({ title: '无法确认项目数据库状态，已停用项目' }),
      )
    } finally {
      cancelSpy.mockRestore()
    }
  })

  it('detaches when an old create cannot roll back and the newer open failed before IPC', async () => {
    const createResult = deferred<{
      success: boolean
      projectId: string
      requestToken: string
      activeProjectPath: string
      databaseRestored: boolean
      dbReady: boolean
      error: string
    }>()
    const cancelSpy = vi.spyOn(
      useWorkflowStore.getState(),
      'cancelProjectWorkflowsAndWait',
    )
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('cancel timeout'))
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:create') {
        return createResult.promise.then(result => ({
          ...result,
          requestToken: args[1] as string,
        }))
      }
      if (channel === 'project:open') {
        throw new Error('new open must fail before IPC')
      }
      if (channel === 'project:get-runtime-context') {
        return { activeProjectPath: project('C').path, dbReady: true }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    try {
      const creating = useProjectStore.getState().createProject({
        name: 'C',
        path: 'C:\\novels',
        genre: '玄幻',
        targetAudience: '全龄',
      })
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
        'project:create',
        expect.objectContaining({ name: 'C' }),
        expect.any(String),
        project('A').path,
      ))

      const openingB = useProjectStore.getState().openProject(project('B').path)
      await expect(openingB).resolves.toBe(false)
      expect(useProjectStore.getState().currentProject?.path).toBe(project('A').path)

      createResult.resolve({
        success: false,
        projectId: '',
        requestToken: '',
        activeProjectPath: project('C').path,
        databaseRestored: false,
        dbReady: false,
        error: 'create failed; rollback failed',
      })
      await expect(creating).resolves.toBe(false)

      expect(useProjectStore.getState().currentProject).toBeNull()
      expect(useProjectStore.getState().fileTree).toEqual([])
      expect(useEditorStore.getState().tabs).toHaveLength(1)
      expect(mocks.disableProjectBindingsPreservingDrafts).toHaveBeenCalledWith(project('A').path)
      expect(mocks.onProjectClosed).not.toHaveBeenCalled()
      expect(mocks.alertError).toHaveBeenCalledWith(
        expect.stringContaining('过期的项目创建结果'),
        expect.objectContaining({ title: '项目数据库状态不一致，已停用项目' }),
      )
    } finally {
      cancelSpy.mockRestore()
    }
  })

  it('keeps the old renderer project bound when project creation fails', async () => {
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:create') {
        return {
          success: false,
          projectId: '',
          requestToken: args[1],
          activeProjectPath: project('A').path,
          databaseRestored: true,
          dbReady: true,
          error: 'cannot initialize new database',
        }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useProjectStore.getState().createProject({
      name: 'B',
      path: 'C:\\novels',
      genre: '玄幻',
      targetAudience: '全龄',
    })).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject?.path).toBe(project('A').path)
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(mocks.onProjectOpening).not.toHaveBeenCalled()
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('cannot initialize'),
      expect.objectContaining({ title: '创建项目失败' }),
    )
  })

  it('shows the actionable localized storage-path error returned by project creation', async () => {
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:create') {
        return {
          success: false,
          projectId: '',
          requestToken: args[1],
          activeProjectPath: project('A').path,
          databaseRestored: true,
          dbReady: true,
          errorCode: 'PROJECT_STORAGE_PATH_UNSUPPORTED',
          error: 'native storage detail',
        }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useProjectStore.getState().createProject({
      name: 'B',
      path: 'C:\\novels',
      genre: '玄幻',
      targetAudience: '全龄',
    })).resolves.toBe(false)

    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('请将整个项目文件夹移动到更靠近磁盘根目录的位置'),
      expect.objectContaining({ title: '创建项目失败' }),
    )
  })

  it('detaches the renderer when project creation cannot restore the old database', async () => {
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:create') {
        return {
          success: false,
          projectId: '',
          requestToken: args[1],
          activeProjectPath: project('B').path,
          databaseRestored: false,
          dbReady: false,
          error: 'create failed; rollback failed',
        }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useProjectStore.getState().createProject({
      name: 'B',
      path: 'C:\\novels',
      genre: '玄幻',
      targetAudience: '全龄',
    })).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(useProjectStore.getState().fileTree).toEqual([])
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(mocks.disableProjectBindingsPreservingDrafts).toHaveBeenCalledWith(project('A').path)
    expect(mocks.onProjectClosed).not.toHaveBeenCalled()
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('已解除项目界面的可编辑状态'),
      expect.objectContaining({ title: '创建失败，项目数据库不可用' }),
    )
  })

  it('detaches the renderer when project open cannot restore the old database', async () => {
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        return {
          success: false,
          project: null,
          requestToken: args[1],
          activeProjectPath: project('B').path,
          databaseRestored: false,
          dbReady: false,
          error: 'open failed; rollback failed',
        }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useProjectStore.getState().openProject(project('B').path)).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(useProjectStore.getState().fileTree).toEqual([])
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(mocks.disableProjectBindingsPreservingDrafts).toHaveBeenCalledWith(project('A').path)
    expect(mocks.onProjectClosed).not.toHaveBeenCalled()
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('已解除项目界面的可编辑状态'),
      expect.objectContaining({ title: '打开失败，项目数据库不可用' }),
    )
  })

  it('keeps the old renderer project bound when project open fails but rollback succeeds', async () => {
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        return {
          success: false,
          project: null,
          requestToken: args[1],
          activeProjectPath: project('A').path,
          databaseRestored: true,
          dbReady: true,
          error: 'target project is invalid',
        }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useProjectStore.getState().openProject(project('B').path)).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject?.path).toBe(project('A').path)
    expect(useProjectStore.getState().fileTree).toEqual([
      { name: 'A', path: 'A', isDir: true },
    ])
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(mocks.onProjectClosed).not.toHaveBeenCalled()
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('target project is invalid'),
      expect.objectContaining({ title: '打开项目失败' }),
    )
  })

  it('reports a visible partial-load warning but returns success after the core project is opened', async () => {
    mocks.onProjectOpened.mockRejectedValueOnce(new Error('draft index unavailable'))
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        return {
          success: true,
          project: project('B'),
          requestToken: args[1],
          activeProjectPath: project('B').path,
        }
      }
      if (channel === 'fs:list-dir') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useProjectStore.getState().openProject(project('B').path)).resolves.toBe(true)

    expect(useProjectStore.getState().currentProject?.path).toBe(project('B').path)
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('draft index unavailable'),
      expect.objectContaining({ title: '项目已打开，部分数据加载失败' }),
    )
  })

  it('keeps the committed project open and continues Layer 2 when file-tree refresh fails', async () => {
    mocks.onProjectOpened.mockResolvedValueOnce({ warnings: ['角色卡加载失败'] })
    mocks.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'project:open') {
        return {
          success: true,
          project: project('B'),
          requestToken: args[1],
          activeProjectPath: project('B').path,
        }
      }
      if (channel === 'fs:list-dir') throw new Error('tree unavailable')
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useProjectStore.getState().openProject(project('B').path)).resolves.toBe(true)

    expect(useProjectStore.getState().currentProject?.path).toBe(project('B').path)
    expect(useProjectStore.getState().fileTree).toEqual([])
    expect(mocks.onProjectOpened).toHaveBeenCalledOnce()
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringMatching(/tree unavailable[\s\S]*角色卡加载失败/),
      expect.objectContaining({ title: '项目已打开，部分数据加载失败' }),
    )
  })

  it('detaches the renderer when failed deletion cannot restore the active database', async () => {
    mocks.invoke.mockResolvedValueOnce({
      success: false,
      directoryDeleted: false,
      databaseRestored: false,
      error: 'directory locked; database restore failed',
    })

    await expect(useProjectStore.getState().deleteProject(project('A').path)).resolves.toBe(false)

    expect(useProjectStore.getState().currentProject).toBeNull()
    expect(useProjectStore.getState().fileTree).toEqual([])
    expect(mocks.onProjectClosed).toHaveBeenCalledWith(project('A').path)
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('已关闭当前项目'),
      expect.objectContaining({ title: '删除失败，项目已停用' }),
    )
  })
})

describe('project character-state persistence boundary', () => {
  it('does not publish character states in memory when persistence fails', async () => {
    mocks.invoke.mockResolvedValue({ success: false, error: 'disk full' })

    await useProjectStore.getState().updateCharacterStates('uncommitted')

    expect(useProjectStore.getState().currentProject?.characterStates).toBe('')
    expect(mocks.alertError).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
      expect.objectContaining({ title: '保存角色状态失败' }),
    )
  })

  it('publishes character states only after the matching project is persisted', async () => {
    const saving = deferred<{ success: boolean }>()
    mocks.invoke.mockReturnValue(saving.promise)

    const update = useProjectStore.getState().updateCharacterStates('persisted')
    expect(useProjectStore.getState().currentProject?.characterStates).toBe('')

    saving.resolve({ success: true })
    await update
    expect(useProjectStore.getState().currentProject?.characterStates).toBe('persisted')
  })
})
