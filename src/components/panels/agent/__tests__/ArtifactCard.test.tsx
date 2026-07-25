import { beforeEach, describe, expect, it, vi } from 'vitest'

import { openArtifactInEditor } from '../artifact-open'
import { ipc } from '../../../../services/ipc-client'
import { useEditorStore } from '../../../../stores/editor-store'
import { useProjectStore } from '../../../../stores/project-store'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'

const alertError = vi.hoisted(() => vi.fn())

vi.mock('../../../../services/ipc-client', () => ({
  ipc: { invokeWithProjectSession: vi.fn() },
}))
vi.mock('../../../ui/AlertDialog', () => ({ alertError }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({
    currentProject: {
      id: 'A',
      sessionLease: 'lease-A',
      name: 'A',
      path: 'C:/projects/A',
      novelConfig: {} as never,
      characterStates: '',
      createdAt: '',
      updatedAt: '',
    },
    fileTree: [],
    loading: false,
  })
  setActiveProjectSessionContext({
    projectId: 'A',
    leaseId: 'lease-A',
    projectPath: 'C:/projects/A',
  })
})

describe('ArtifactCard project identity', () => {
  it('opens a project-scoped tab with the saved content baseline', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce({
      success: true,
      content: 'saved content',
    } as never)

    await expect(openArtifactInEditor({
      type: 'file_created',
      name: 'chapter.md',
      path: 'C:/projects/A/chapters/chapter.md',
      projectPath: 'C:/projects/A',
      projectSession: {
        projectId: 'A',
        leaseId: 'lease-A',
        projectPath: 'C:/projects/A',
      },
    })).resolves.toBe(true)

    expect(ipc.invokeWithProjectSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'A', leaseId: 'lease-A' }),
      'fs:read-file',
      'C:/projects/A/chapters/chapter.md',
      'C:/projects/A',
    )
    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: expect.stringContaining(encodeURIComponent('C:/projects/A')),
        projectKey: 'C:/projects/A',
        content: 'saved content',
        savedContent: 'saved content',
      }),
    ])
  })

  it('discards a late file read when the active project changes', async () => {
    const read = deferred<{ success: boolean; content: string }>()
    vi.mocked(ipc.invokeWithProjectSession).mockReturnValueOnce(read.promise as never)

    const opening = openArtifactInEditor({
      type: 'file_modified',
      name: 'chapter.md',
      path: 'C:/projects/A/chapters/chapter.md',
      projectPath: 'C:/projects/A',
      projectSession: {
        projectId: 'A',
        leaseId: 'lease-A',
        projectPath: 'C:/projects/A',
      },
    })
    useProjectStore.setState({
      currentProject: {
        ...useProjectStore.getState().currentProject!,
        id: 'B',
        sessionLease: 'lease-B',
        name: 'B',
        path: 'C:/projects/B',
      },
    })
    setActiveProjectSessionContext({
      projectId: 'B',
      leaseId: 'lease-B',
      projectPath: 'C:/projects/B',
    })
    read.resolve({ success: true, content: 'stale A content' })

    await expect(opening).resolves.toBe(false)
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(alertError).toHaveBeenCalledWith(
      expect.stringContaining('项目已切换'),
      expect.any(Object),
    )
  })

  it('does not relabel an old project artifact with the current project', async () => {
    useProjectStore.setState({
      currentProject: {
        ...useProjectStore.getState().currentProject!,
        id: 'B',
        sessionLease: 'lease-B',
        name: 'B',
        path: 'C:/projects/B',
      },
    })
    setActiveProjectSessionContext({
      projectId: 'B',
      leaseId: 'lease-B',
      projectPath: 'C:/projects/B',
    })

    await expect(openArtifactInEditor({
      type: 'file_created',
      name: 'A.md',
      path: 'C:/projects/A/A.md',
      projectPath: 'C:/projects/A',
      projectSession: {
        projectId: 'A',
        leaseId: 'lease-A',
        projectPath: 'C:/projects/A',
      },
    })).resolves.toBe(false)

    expect(ipc.invokeWithProjectSession).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(alertError).toHaveBeenCalledWith(
      expect.stringContaining('另一个项目'),
      expect.any(Object),
    )
  })

  it('shows a visible error and does not open a blank tab when reading fails', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce({
      success: false,
      content: '',
      error: 'file locked',
    } as never)

    await expect(openArtifactInEditor({
      type: 'file_modified',
      name: 'A.md',
      path: 'C:/projects/A/A.md',
      projectPath: 'C:/projects/A',
      projectSession: {
        projectId: 'A',
        leaseId: 'lease-A',
        projectPath: 'C:/projects/A',
      },
    })).resolves.toBe(false)

    expect(useEditorStore.getState().tabs).toEqual([])
    expect(alertError).toHaveBeenCalledWith(
      '发生错误：file locked',
      expect.objectContaining({ title: '无法打开产物' }),
    )
  })
})
