import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  invokeWithProjectSession,
  refreshFileTree,
  syncTabContent,
  markTabSaved,
} = vi.hoisted(() => ({
  invokeWithProjectSession: vi.fn(),
  refreshFileTree: vi.fn(),
  syncTabContent: vi.fn(),
  markTabSaved: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invokeWithProjectSession },
}))

vi.mock('../project-store', () => ({
  useProjectStore: {
    getState: () => ({
      currentProject: {
        id: 'project-a',
        name: '隔离测试项目',
        path: 'C:\\novels\\project-a',
        sessionLease: 'lease-a',
      },
      refreshFileTree,
    }),
  },
}))

vi.mock('../editor-store', () => ({
  useEditorStore: {
    getState: () => ({
      tabs: [],
      syncTabContent,
      markTabSaved,
    }),
  },
}))

import { useDraftStore } from '../draft-store'

const projectPath = 'C:\\novels\\project-a'
const projectSession = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath,
}

describe('draft-store merged revision persistence', () => {
  beforeEach(() => {
    invokeWithProjectSession.mockReset()
    refreshFileTree.mockReset()
    syncTabContent.mockReset()
    markTabSaved.mockReset()
    refreshFileTree.mockResolvedValue(undefined)

    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:draft-list') {
        return [{
          id: 11,
          chapterNumber: 1,
          version: 1,
          status: 'draft',
          wordCount: 0,
          source: 'write',
          createdAt: '2026-08-22T00:00:00.000Z',
        }]
      }
      return { success: true }
    })

    useDraftStore.setState({
      draftsByChapter: {},
      loading: false,
      dataProjectKey: null,
      dataProjectSession: null,
      loadingProjectKey: null,
      loadingProjectSession: null,
    })
  })

  it('marks the direct vela revision URI as merged after its target draft is updated', async () => {
    const result = await useDraftStore.getState().applyMergedRevision(
      'vela://draft/ch1',
      1,
      'vela://draft/11',
      'vela://revision/1',
      '已人工合并的修订稿',
      projectPath,
      projectSession,
    )

    expect(result).toEqual({ success: true })
    expect(invokeWithProjectSession).toHaveBeenCalledWith(
      projectSession,
      'db:revision-mark-merged',
      1,
      11,
      projectPath,
    )
    expect(refreshFileTree).not.toHaveBeenCalled()
  })
})
