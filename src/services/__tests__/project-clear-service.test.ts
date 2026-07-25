import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearProjectData } from '../project-clear-service'
import { ipc } from '../ipc-client'
import { useDraftStore } from '../../stores/draft-store'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'

vi.mock('../ipc-client', () => ({
  ipc: {
    invoke: vi.fn(),
    invokeWithProjectSession: vi.fn(),
  },
}))

const projectPath = 'C:/novels/project-a'
const projectSession: ProjectSessionContext = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath,
}

function project(leaseId = projectSession.leaseId, path = projectPath) {
  return {
    id: projectSession.projectId,
    sessionLease: leaseId,
    path,
    name: 'Project A',
    novelConfig: {},
  }
}

const openProject = vi.fn()
const refreshFileTree = vi.fn()
const draftReset = vi.fn()
const loadAllDrafts = vi.fn()
const clearTabs = vi.fn()
const closeTab = vi.fn()
const hasActiveRun = vi.fn()

vi.mock('../../stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({
      currentProject: project(),
      openProject,
      refreshFileTree,
    })),
  },
}))

vi.mock('../../stores/draft-store', () => ({
  useDraftStore: {
    getState: vi.fn(() => ({
      reset: draftReset,
      loadAllDrafts,
    })),
  },
}))

vi.mock('../../stores/editor-store', () => ({
  useEditorStore: {
    getState: vi.fn(() => ({
      tabs: [],
      draftLedgers: {},
      clearTabs,
      closeTab,
    })),
  },
}))

vi.mock('../../stores/workflow-store', () => ({
  useWorkflowStore: {
    getState: vi.fn(() => ({
      hasActiveRun,
    })),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  setActiveProjectSessionContext(projectSession)
  hasActiveRun.mockReturnValue(false)
  vi.mocked(ipc.invokeWithProjectSession).mockResolvedValue({
    success: true,
    cleared: ['generatedText'],
  } as never)
  vi.mocked(useProjectStore.getState).mockReturnValue({
    currentProject: project(),
    openProject,
    refreshFileTree,
  } as never)
  vi.mocked(useDraftStore.getState).mockReturnValue({
    reset: draftReset,
    loadAllDrafts,
  } as never)
  vi.mocked(useEditorStore.getState).mockReturnValue({
    tabs: [],
    draftLedgers: {},
    clearTabs,
    closeTab,
  } as never)
  vi.mocked(useWorkflowStore.getState).mockReturnValue({
    hasActiveRun,
  } as never)
})

afterEach(() => {
  setActiveProjectSessionContext(null)
})

describe('clearProjectData', () => {
  it('clears through the caller-frozen lease and refreshes only that session', async () => {
    await clearProjectData({
      creativeFields: true,
      blueprints: true,
      generatedText: true,
    }, projectSession)

    expect(ipc.invoke).not.toHaveBeenCalled()
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledWith(
      projectSession,
      'db:project-clear-generated-data',
      { creativeFields: true, blueprints: true, generatedText: true },
      projectPath,
    )
    expect(clearTabs).not.toHaveBeenCalled()
    expect(draftReset).toHaveBeenCalledOnce()
    expect(openProject).not.toHaveBeenCalled()
    expect(refreshFileTree).toHaveBeenCalledWith(projectPath, undefined, projectSession)
  })

  it('does not clear draft stores when only architecture fields are selected', async () => {
    await clearProjectData({
      creativeFields: true,
      blueprints: false,
      generatedText: false,
    }, projectSession)

    expect(ipc.invokeWithProjectSession).toHaveBeenCalledOnce()
    expect(draftReset).not.toHaveBeenCalled()
    expect(openProject).not.toHaveBeenCalled()
  })

  it('surfaces failed clear operations', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce({ success: false, error: '数据库忙' } as never)

    await expect(clearProjectData({ generatedText: true }, projectSession)).rejects.toThrow('数据库忙')
    expect(openProject).not.toHaveBeenCalled()
  })

  it('fails closed before mutation if the confirmation lease is no longer active', async () => {
    setActiveProjectSessionContext({ ...projectSession, leaseId: 'lease-b' })

    await expect(clearProjectData({ generatedText: true }, projectSession)).rejects.toThrow('项目会话')
    expect(ipc.invokeWithProjectSession).not.toHaveBeenCalled()
  })

  it('blocks clear while workflows are active', async () => {
    hasActiveRun.mockReturnValue(true)

    await expect(clearProjectData({ generatedText: true }, projectSession)).rejects.toThrow('工作流')
    expect(ipc.invokeWithProjectSession).not.toHaveBeenCalled()
  })

  it('blocks clear when affected tabs have unsaved edits', async () => {
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: [
        { id: 'config', name: '小说配置', type: 'config', projectKey: projectPath, dirty: true },
        { id: 'character-a', name: '角色A', type: 'character', projectKey: projectPath, dirty: true },
      ],
      draftLedgers: {},
      clearTabs,
      closeTab,
    } as never)

    await expect(clearProjectData({ creativeFields: true }, projectSession)).rejects.toThrow('未保存')
    expect(ipc.invokeWithProjectSession).not.toHaveBeenCalled()
  })

  it('blocks destructive clear when an affected draft remains after its tab was closed', async () => {
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: [],
      draftLedgers: {
        config: JSON.stringify({
          version: 1,
          projects: [{ projectKey: projectPath, baseValue: { genre: 'old' }, draftValue: { genre: 'unsaved' } }],
        }),
      },
      clearTabs,
      closeTab,
    } as never)

    await expect(clearProjectData({ creativeFields: true }, projectSession)).rejects.toThrow(/小说配置/)
    expect(ipc.invokeWithProjectSession).not.toHaveBeenCalled()
  })

  it('ignores hidden drafts from other projects or unselected clear scopes', async () => {
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: [],
      draftLedgers: {
        config: JSON.stringify({
          version: 1,
          projects: [{ projectKey: 'C:/novels/project-b', baseValue: {}, draftValue: { genre: 'B' } }],
        }),
        'chapter-card-editor': JSON.stringify({
          version: 1,
          projects: [{ projectKey: projectPath, baseValue: [], draftValue: [{ chapter: 1 }] }],
        }),
      },
      clearTabs,
      closeTab,
    } as never)

    await expect(clearProjectData({ creativeFields: true }, projectSession)).resolves.toEqual({
      cleared: ['generatedText'],
    })
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledOnce()
  })

  it('does not block creative-field clearing for character cards that the repository does not delete', async () => {
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: [],
      draftLedgers: {
        'character-editor-drafts': JSON.stringify({
          version: 1,
          projects: [{ projectKey: projectPath, baseValue: [], draftValue: [{ name: '保留角色' }] }],
        }),
      },
      clearTabs,
      closeTab,
    } as never)

    await expect(clearProjectData({ creativeFields: true }, projectSession)).resolves.toEqual({
      cleared: ['generatedText'],
    })
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledOnce()
  })

  it('closes only affected clean tabs after clear', async () => {
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: [
        { id: 'chapter-card-editor', name: '章节蓝图', type: 'chapter-card', projectKey: projectPath },
        { id: 'character-a', name: '角色A', type: 'character', projectKey: projectPath, dirty: true },
      ],
      draftLedgers: {},
      clearTabs,
      closeTab,
    } as never)

    await clearProjectData({ blueprints: true }, projectSession)

    expect(closeTab).toHaveBeenCalledWith('chapter-card-editor')
    expect(closeTab).not.toHaveBeenCalledWith('character-a')
  })

  it('ignores dirty tabs from another project and closes only current-project tabs', async () => {
    vi.mocked(useEditorStore.getState).mockReturnValue({
      tabs: [
        { id: 'project-a-draft', name: 'A 草稿', type: 'chapter', projectKey: projectPath },
        { id: 'project-b-dirty-draft', name: 'B 未保存草稿', type: 'chapter', projectKey: 'C:/novels/project-b', dirty: true },
      ],
      draftLedgers: {},
      clearTabs,
      closeTab,
    } as never)

    await clearProjectData({ generatedText: true }, projectSession)

    expect(closeTab).toHaveBeenCalledWith('project-a-draft')
    expect(closeTab).not.toHaveBeenCalledWith('project-b-dirty-draft')
  })

  it('does not reset or refresh the new same-path lease when clear completes late', async () => {
    let resolveClear: ((value: { success: boolean; cleared: string[] }) => void) | undefined
    vi.mocked(ipc.invokeWithProjectSession).mockImplementationOnce(() =>
      new Promise((resolve) => { resolveClear = resolve as typeof resolveClear }),
    )

    const clearing = clearProjectData({ generatedText: true }, projectSession)
    await vi.waitFor(() => expect(resolveClear).toBeTypeOf('function'))
    const reopenedSession = { ...projectSession, leaseId: 'lease-b' }
    setActiveProjectSessionContext(reopenedSession)
    vi.mocked(useProjectStore.getState).mockReturnValue({
      currentProject: project('lease-b'),
      openProject,
      refreshFileTree,
    } as never)
    resolveClear!({ success: true, cleared: ['generatedText'] })
    await clearing

    expect(draftReset).not.toHaveBeenCalled()
    expect(openProject).not.toHaveBeenCalled()
    expect(refreshFileTree).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })
})
