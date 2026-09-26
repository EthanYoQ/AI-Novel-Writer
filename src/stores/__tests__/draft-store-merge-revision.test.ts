import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  invokeWithProjectSession,
  refreshFileTree,
  syncTabContent,
  markTabSaved,
  settleMergedRevision,
  startWorkflow,
  editorTabs,
} = vi.hoisted(() => ({
  invokeWithProjectSession: vi.fn(),
  refreshFileTree: vi.fn(),
  syncTabContent: vi.fn(),
  markTabSaved: vi.fn(),
  settleMergedRevision: vi.fn(),
  startWorkflow: vi.fn(),
  editorTabs: [] as Array<{
    id: string
    filePath: string
    projectKey: string
    content: string
    contentRevision: number
    dirty: boolean
  }>,
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
      tabs: editorTabs,
      syncTabContent,
      markTabSaved,
      settleMergedRevision,
    }),
  },
}))

vi.mock('../workflow-store', () => ({
  useWorkflowStore: { getState: () => ({ startWorkflow }) },
  workflowResourceKey: (...parts: unknown[]) => parts.join(':'),
}))

vi.mock('../locale-store', () => ({
  useLocaleStore: { getState: () => ({ locale: 'zh-CN' }) },
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
    settleMergedRevision.mockReset()
    startWorkflow.mockReset()
    editorTabs.splice(0)
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
      if (channel === 'db:revision-merge') {
        return {
          success: true,
          receipt: {
            revisionId: 1,
            targetDraftId: 11,
            status: 'revised',
            wordCount: 9,
            idempotent: false,
          },
        }
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
      'ai-novel://draft/ch1',
      1,
      'ai-novel://draft/11',
      'ai-novel://revision/1',
      '已人工合并的修订稿',
      '原稿',
      projectPath,
      projectSession,
    )

    expect(result).toMatchObject({ success: true, receipt: { revisionId: 1, targetDraftId: 11 } })
    expect(invokeWithProjectSession).toHaveBeenCalledWith(
      projectSession,
      'db:revision-merge',
      {
        revisionId: 1,
        targetDraftId: 11,
        expectedDraftContent: '原稿',
        mergedContent: '已人工合并的修订稿',
        wordCount: 9,
      },
      projectPath,
    )
    expect(invokeWithProjectSession).not.toHaveBeenCalledWith(
      projectSession,
      'db:draft-update-content',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      projectPath,
    )
    expect(refreshFileTree).not.toHaveBeenCalled()
  })

  it('freezes the editor snapshot before awaiting the merge receipt', async () => {
    let releaseMerge!: () => void
    const mergePending = new Promise<void>(resolve => { releaseMerge = resolve })
    editorTabs.push({
      id: 'draft-11',
      filePath: 'ai-novel://draft/11',
      projectKey: projectPath,
      content: '原稿',
      contentRevision: 3,
      dirty: false,
    })
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-merge') {
        await mergePending
        return { success: true, receipt: { idempotent: false } }
      }
      if (channel === 'db:draft-list') return []
      return { success: true }
    })

    const merging = useDraftStore.getState().applyMergedRevision(
      'ai-novel://draft/ch1',
      1,
      'ai-novel://draft/11',
      'ai-novel://revision/1',
      '合并正文',
      '原稿',
      projectPath,
      projectSession,
    )
    editorTabs[0].content = '提交等待期间继续输入 C'
    editorTabs[0].contentRevision = 4
    editorTabs[0].dirty = true
    releaseMerge()

    await expect(merging).resolves.toMatchObject({ success: true, receipt: { idempotent: false } })
    expect(settleMergedRevision).toHaveBeenCalledWith(
      'draft-11',
      { content: '原稿', contentRevision: 3 },
      '合并正文',
    )
  })

  it('starts exactly one targeted recheck only when the merge receipt requires it', async () => {
    editorTabs.push({ id: 'draft-11', filePath: 'ai-novel://draft/11', projectKey: projectPath,
      content: '原稿', contentRevision: 2, dirty: false })
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-merge') return { success: true, receipt: { revisionId: 1, targetDraftId: 11,
        status: 'revised', wordCount: 4, idempotent: false, chapterNumber: 1, version: 1,
        reviewCycle: { cycleId: 'cycle-1', mergedHash: 'a'.repeat(64), disposition: 'required' } } }
      if (channel === 'db:draft-list') return []
      return { success: true }
    })
    const result = await useDraftStore.getState().applyMergedRevision('ai-novel://draft/ch1', 1,
      'ai-novel://draft/11', 'ai-novel://revision/1', '合并正文', '原稿', projectPath, projectSession)
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ success: true, receipt: { reviewCycle: { disposition: 'required' } } })
    expect(startWorkflow).toHaveBeenCalledTimes(1)
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({ projectPath, steps: [{ name: expect.any(String) }] })
    expect(startWorkflow.mock.calls[0]?.[1]).toBe(false)
  })

  it('reports a post-commit recheck launch failure without claiming the durable merge failed', async () => {
    editorTabs.push({ id: 'draft-11', filePath: 'ai-novel://draft/11', projectKey: projectPath,
      content: '原稿', contentRevision: 2, dirty: false })
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-merge') return { success: true, receipt: { revisionId: 1, targetDraftId: 11,
        status: 'revised', wordCount: 4, idempotent: false, chapterNumber: 1, version: 1,
        reviewCycle: { cycleId: 'cycle-1', mergedHash: 'a'.repeat(64), disposition: 'required' } } }
      if (channel === 'db:draft-list') return []
      return { success: true }
    })
    startWorkflow.mockImplementation(() => { throw new Error('synthetic recheck launch failure') })

    await expect(useDraftStore.getState().applyMergedRevision('ai-novel://draft/ch1', 1,
      'ai-novel://draft/11', 'ai-novel://revision/1', '合并正文', '原稿', projectPath, projectSession))
      .resolves.toMatchObject({ success: true, receipt: { reviewCycle: { disposition: 'required' } },
        postCommitError: 'Error: synthetic recheck launch failure' })
  })
})
