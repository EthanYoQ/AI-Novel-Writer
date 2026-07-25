import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalEventBus } from '../../shared/event-bus'
import { useCharacterStore } from '../../stores/character-store'
import { useDraftStore } from '../../stores/draft-store'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import {
  disableProjectBindingsPreservingDrafts,
  disposeProjectService,
  initProjectService,
  onProjectClosed,
  onProjectOpened,
} from '../project-service'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('../ipc-client', () => ({
  ipc: { invoke: mocks.invoke },
}))

const projectAPath = 'C:\\novels\\A'
const projectBPath = 'C:\\novels\\B'

beforeEach(() => {
  mocks.invoke.mockReset()
  useProjectStore.setState({
    currentProject: {
      id: 'B',
      name: 'B',
      path: projectBPath,
      sessionLease: 'lease-B',
      novelConfig: {},
    } as never,
  })
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    draftLedgers: {},
  })
})

afterEach(() => {
  disposeProjectService()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
})

describe('ProjectService REFRESH_RESOURCE project identity', () => {
  it('ignores a delayed same-path refresh after the project lease was replaced', async () => {
    const characterLoad = vi.spyOn(useCharacterStore.getState(), 'load')
      .mockResolvedValue()
    const draftLoad = vi.spyOn(useDraftStore.getState(), 'loadAllDrafts')
      .mockResolvedValue()
    const treeRefresh = vi.spyOn(useProjectStore.getState(), 'refreshFileTree')
      .mockResolvedValue()
    initProjectService()

    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['all'],
      projectPath: projectBPath,
      projectSession: { projectId: 'B', leaseId: 'lease-old', projectPath: projectBPath },
    })
    await Promise.resolve()

    expect(characterLoad).not.toHaveBeenCalled()
    expect(draftLoad).not.toHaveBeenCalled()
    expect(treeRefresh).not.toHaveBeenCalled()

    globalEventBus.emit('REFRESH_RESOURCE', {
      resources: ['all'],
      projectPath: projectBPath,
      projectSession: { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath },
    })
    await vi.waitFor(() => {
      expect(treeRefresh).toHaveBeenCalledWith(projectBPath, undefined, {
        projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath,
      })
    })
    expect(characterLoad).toHaveBeenCalledWith(projectBPath, {
      projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath,
    })
    expect(draftLoad).toHaveBeenCalledWith(projectBPath, {
      projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath,
    })
  })

  it('drops opening results and PROJECT_CHANGED after reopening the same path with a new lease', async () => {
    let resolveCharacterLoad: (() => void) | undefined
    let resolveDraftLoad: (() => void) | undefined
    vi.spyOn(useCharacterStore.getState(), 'load').mockImplementation(() => new Promise<void>((resolve) => {
      resolveCharacterLoad = resolve
    }))
    vi.spyOn(useDraftStore.getState(), 'loadAllDrafts').mockImplementation(() => new Promise<void>((resolve) => {
      resolveDraftLoad = resolve
    }))
    const changed = vi.fn()
    const unsubscribe = globalEventBus.on('PROJECT_CHANGED', changed)
    const oldSession = { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath }

    const opening = onProjectOpened(oldSession)
    await vi.waitFor(() => {
      expect(useCharacterStore.getState().load).toHaveBeenCalledWith(projectBPath, oldSession)
      expect(useDraftStore.getState().loadAllDrafts).toHaveBeenCalledWith(projectBPath, oldSession)
    })

    useProjectStore.setState({
      currentProject: {
        id: 'B',
        name: 'B reopened',
        path: projectBPath,
        sessionLease: 'lease-B-reopened',
        novelConfig: {},
      } as never,
    })
    resolveCharacterLoad?.()
    resolveDraftLoad?.()

    await expect(opening).resolves.toEqual({ warnings: [] })
    expect(changed).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('clears every editable binding when the renderer has no trustworthy project identity', async () => {
    useEditorStore.setState({
      tabs: [{
        id: 'orphan-tab',
        name: 'Orphan',
        type: 'outline',
        projectKey: projectAPath,
        dirty: true,
      }],
      activeTabId: 'orphan-tab',
    })
    const characterReset = vi.spyOn(useCharacterStore.getState(), 'reset')
    const draftReset = vi.spyOn(useDraftStore.getState(), 'reset')

    await onProjectClosed(null)

    expect(useEditorStore.getState().tabs).toEqual([])
    expect(useEditorStore.getState().activeTabId).toBeNull()
    expect(characterReset).toHaveBeenCalledOnce()
    expect(draftReset).toHaveBeenCalledOnce()
  })

  it('preserves tabs and draft ledgers when bindings are disabled after a runtime failure', () => {
    useEditorStore.setState({
      tabs: [{
        id: 'dirty-tab',
        name: '未保存章节',
        type: 'chapter',
        projectKey: projectAPath,
        content: '未保存正文',
        dirty: true,
      }],
      activeTabId: 'dirty-tab',
      draftLedgers: { config: '{"version":1,"projects":[]}' },
    })

    disableProjectBindingsPreservingDrafts(null)

    expect(useEditorStore.getState()).toMatchObject({
      tabs: [expect.objectContaining({ id: 'dirty-tab', dirty: true })],
      activeTabId: 'dirty-tab',
      draftLedgers: { config: '{"version":1,"projects":[]}' },
    })
  })

  it('settles only the matching immutable snapshot without rereading or replacing editor content', async () => {
    vi.spyOn(useDraftStore.getState(), 'loadChapterDrafts').mockResolvedValue()
    vi.spyOn(useCharacterStore.getState(), 'load').mockResolvedValue()
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
    useEditorStore.setState({
      tabs: [{
        id: 'draft-7',
        name: '第二章 v1',
        type: 'chapter',
        filePath: 'vela://draft/7',
        projectKey: projectBPath,
        content: '冻结正文',
        savedContent: '旧正文',
        draftId: 7,
        chapterNumber: 2,
        draftStatus: 'draft',
        contentRevision: 5,
        projectSessionLease: 'lease-B',
      }],
      activeTabId: 'draft-7',
      draftLedgers: {},
    })
    initProjectService()

    globalEventBus.emit('FINALIZE_COMPLETE', {
      tabId: 'draft-7',
      chapterNumber: 2,
      chapterTitle: '第二章',
      projectPath: projectBPath,
      projectSession: { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath },
      draftId: 7,
      finalizationId: 'finalization-7',
      contentHash: 'hash-7',
      contentRevision: 5,
      snapshotContent: '冻结正文',
      publicationStatus: 'published',
    })

    await vi.waitFor(() => {
      expect(useEditorStore.getState().tabs[0]).toMatchObject({
        content: '冻结正文',
        savedContent: '冻结正文',
        draftId: 7,
        chapterNumber: 2,
        draftStatus: 'finalized',
        contentRevision: 5,
        dirty: false,
        finalizationId: 'finalization-7',
        finalizationPublication: 'published',
      })
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('preserves a later editor revision and records a finalization conflict', async () => {
    vi.spyOn(useDraftStore.getState(), 'loadChapterDrafts').mockResolvedValue()
    vi.spyOn(useCharacterStore.getState(), 'load').mockResolvedValue()
    vi.spyOn(useProjectStore.getState(), 'refreshFileTree').mockResolvedValue()
    useEditorStore.setState({
      tabs: [{
        id: 'draft-7',
        name: '第二章 v1',
        type: 'chapter',
        filePath: 'vela://draft/7',
        projectKey: projectBPath,
        content: '用户后续编辑',
        savedContent: '冻结正文',
        dirty: true,
        draftId: 7,
        chapterNumber: 2,
        draftStatus: 'draft',
        contentRevision: 6,
        projectSessionLease: 'lease-B',
      }],
      activeTabId: 'draft-7',
      draftLedgers: {},
    })
    initProjectService()

    globalEventBus.emit('FINALIZE_COMPLETE', {
      tabId: 'draft-7',
      chapterNumber: 2,
      chapterTitle: '第二章',
      projectPath: projectBPath,
      projectSession: { projectId: 'B', leaseId: 'lease-B', projectPath: projectBPath },
      draftId: 7,
      finalizationId: 'finalization-7',
      contentHash: 'hash-7',
      contentRevision: 5,
      snapshotContent: '冻结正文',
      publicationStatus: 'pending',
    })

    await vi.waitFor(() => {
      expect(useEditorStore.getState().tabs[0]).toMatchObject({
        content: '用户后续编辑',
        savedContent: '冻结正文',
        dirty: true,
        draftStatus: 'draft',
        finalizationId: 'finalization-7',
        finalizationPublication: 'pending',
        finalizationConflict: {
          finalizationId: 'finalization-7',
          publicationStatus: 'pending',
        },
      })
    })
  })
})
