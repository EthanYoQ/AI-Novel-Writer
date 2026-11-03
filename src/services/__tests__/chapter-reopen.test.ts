import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { reopenFinalizedChapter } from '../chapter-reopen'
import { ipc } from '../ipc-client'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useWorkflowStore, type WorkflowRun } from '../../stores/workflow-store'

vi.mock('../ipc-client', () => ({
  ipc: { invokeWithProjectSession: vi.fn() },
}))

const session: ProjectSessionContext = { projectId: 'project-a', leaseId: 'lease-a', projectPath: 'C:/novels/project-a' }

/** 一条正在写 resourceKeys 的工作流；只填冲突判断用到的字段。 */
const runWriting = (projectPath: string, resourceKeys: string[]) => ({ id: `run-${resourceKeys.join(',')}`, projectPath, resourceKeys }) as unknown as WorkflowRun

beforeEach(() => {
  vi.mocked(ipc.invokeWithProjectSession).mockResolvedValue({ success: true, created: true, draftId: 7, version: 2 })
})

afterEach(() => {
  useWorkflowStore.setState({ activeRuns: [] })
  vi.mocked(ipc.invokeWithProjectSession).mockReset()
})

describe('渲染端重开入口', () => {
  it('本章还有工作流在写：不请求主进程，直接报 CHAPTER_REOPEN_BUSY', async () => {
    useWorkflowStore.setState({ activeRuns: [runWriting(session.projectPath, ['chapter:3'])] })

    await expect(reopenFinalizedChapter(session, { chapterNumber: 3 })).resolves.toEqual({ success: false, error: 'CHAPTER_REOPEN_BUSY' })
    expect(ipc.invokeWithProjectSession).not.toHaveBeenCalled()
  })

  it('在写别的章或别的作品：照常请求主进程重开', async () => {
    useWorkflowStore.setState({ activeRuns: [runWriting(session.projectPath, ['chapter:4']), runWriting('C:/novels/project-b', ['chapter:3'])] })

    await expect(reopenFinalizedChapter(session, { chapterNumber: 3 })).resolves.toMatchObject({ success: true, draftId: 7 })
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledWith(session, 'chapter:reopen', { chapterNumber: 3 }, session.projectPath)
  })
})
