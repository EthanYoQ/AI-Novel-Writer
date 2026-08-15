import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  NovelContextController,
  NovelContextDisconnectedError,
  type NovelContextReady,
} from '../src/client/context-store.ts'
import type { NovelProjectId } from '../src/types.ts'

const WORKSPACE_A = WorkspaceId('workspace-a')
const WORKSPACE_B = WorkspaceId('workspace-b')
const SESSION_A = SessionId('session-a')
const SESSION_B = SessionId('session-b')

const ready = (chapter: number): NovelContextReady => ({
  status: 'ready',
  project: {
    projectId: '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId, title: '潮汐来信', language: 'zh-CN', genre: '悬疑',
    plannedChapters: 3, targetWordsPerChapter: 2_000, creativeStrategy: 'auto', updatedAt: '2026-08-16T00:00:00.000Z',
  },
  progress: { selectedChapter: chapter, plannedChapters: 3, status: 'planned', draftPresent: false, draftBytes: 0 },
  characters: [], storyBlueprint: null, chapterBlueprint: null, draft: null, omittedSources: [],
})

describe('novel context client state', () => {
  it('loads only while open, follows workspace changes, and selects chapters without polling', async () => {
    const read = vi.fn(async (_workspaceId: typeof WORKSPACE_A, chapter: number) => ready(chapter))
    const controller = new NovelContextController({ read }, vi.fn())

    controller.setTarget({ workspaceId: WORKSPACE_A, sessionId: SESSION_A })
    expect(read).not.toHaveBeenCalled()
    await controller.open()
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', open: true, progress: { selectedChapter: 1 } })
    await controller.selectChapter(2)
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', open: true, progress: { selectedChapter: 2 } })
    controller.setTarget({ workspaceId: WORKSPACE_B, sessionId: SESSION_B })
    await controller.whenIdle()

    expect(read.mock.calls.map(args => args.slice(0, 2))).toEqual([
      ['workspace-a', 1],
      ['workspace-a', 2],
      ['workspace-b', 1],
    ])
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('renders empty, not-initialized, error, and disconnected states', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'not-initialized' })
      .mockRejectedValueOnce(new Error('invalid project'))
      .mockRejectedValueOnce(new NovelContextDisconnectedError())
    const controller = new NovelContextController({ read }, vi.fn())

    await controller.open()
    expect(controller.getSnapshot()).toEqual({ status: 'empty', open: true })
    controller.setTarget({ workspaceId: WORKSPACE_A, sessionId: SESSION_A })
    await controller.whenIdle()
    expect(controller.getSnapshot()).toEqual({ status: 'not-initialized', open: true })
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', open: true, message: 'invalid project' })
    await controller.refresh()
    expect(controller.getSnapshot()).toEqual({ status: 'disconnected', open: true })
  })

  it('aborts superseded reads and reaches quiescence on dispose', async () => {
    let finish: (() => void) | undefined
    let signal: AbortSignal | undefined
    const controller = new NovelContextController({
      read: (_workspaceId, _chapter, requestSignal) => {
        signal = requestSignal
        return new Promise(resolve => { finish = () => { resolve(ready(1)) } })
      },
    }, vi.fn())
    controller.setTarget({ workspaceId: WORKSPACE_A, sessionId: SESSION_A })
    const opening = controller.open()
    await vi.waitFor(() => { expect(signal).toBeDefined() })

    let disposed = false
    const disposing = controller.dispose().then(() => { disposed = true })
    expect(signal?.aborted).toBe(true)
    await Promise.resolve()
    expect(disposed).toBe(false)
    finish?.()
    await Promise.all([opening, disposing])
    expect(disposed).toBe(true)
  })
})
