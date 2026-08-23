import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { observeNovelContextSources } from '../src/client/context-observer.ts'
import { NovelWorkbenchController } from '../src/client/workbench-store.ts'
import type { NovelContextReady } from '../src/context-types.ts'
import type { NovelProjectId } from '../src/types.ts'

const SESSION_1 = SessionId('session-1')
const SESSION_2 = SessionId('session-2')
const WORKSPACE_1 = WorkspaceId('workspace-1')
const WORKSPACE_2 = WorkspaceId('workspace-2')

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    set: (next: T) => { value = next; for (const listener of listeners) listener() },
  }
}

const ready: NovelContextReady = {
  status: 'ready',
  project: {
    projectId: '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId, title: '小说', language: 'zh-CN', genre: '悬疑', plannedChapters: 2,
    targetWordsPerChapter: 2_000, creativeStrategy: 'auto', updatedAt: '2026-08-16T00:00:00.000Z',
  },
  progress: { selectedChapter: 1, plannedChapters: 2, status: 'planned', draftPresent: false, draftBytes: 0 },
  characters: [], storyBlueprint: null, chapterBlueprint: null, draft: null, omittedSources: [],
}

describe('novel context shell observer', () => {
  it('routes only the explicit V1 Preset into the V1 controller and leaves other sessions inactive', () => {
    const sessionList = source({
      current: SESSION_1 as SessionId | undefined,
      byId: { [SESSION_1]: { agentPreset: 'default' } },
    })
    const workspaceList = source({ items: [{ workspaceId: WORKSPACE_1, sessionIds: [SESSION_1] }] })
    const conversation = source({ nodes: [] as Array<{ kind: 'tool-result'; seq: number; call: null }> })
    const controller = new NovelWorkbenchController({ read: vi.fn(), readAsset: vi.fn(), prompt: vi.fn() }, vi.fn())
    const setTarget = vi.spyOn(controller, 'setTarget')
    const dispose = observeNovelContextSources({
      sessions: { list: sessionList, binding: () => ({ session: conversation }) }, workspaces: { list: workspaceList },
    }, controller)

    expect(setTarget).toHaveBeenLastCalledWith(undefined)
    sessionList.set({ current: SESSION_1, byId: { [SESSION_1]: { agentPreset: 'ai-novel-writer' } } })
    expect(setTarget).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: SESSION_1, workspaceId: WORKSPACE_1 }))
    sessionList.set({ current: SESSION_1, byId: { [SESSION_1]: { agentPreset: 'ai-novel-writer-v2' } } })
    expect(setTarget).toHaveBeenLastCalledWith(undefined)
    sessionList.set({ current: SESSION_1, byId: {} })
    expect(setTarget).toHaveBeenLastCalledWith(undefined)
    dispose()
  })

  it('projects the selected Preset and known approval mode into pre-submit recovery guidance', async () => {
    const sessionList = source({
      current: SESSION_1 as SessionId | undefined,
      byId: {
        [SESSION_1]: { agentPreset: 'ai-novel-writer', projectionValues: { permissions: { currentValue: 'danger-full-access' } } },
      },
    })
    const workspaceList = source({ items: [{ workspaceId: WORKSPACE_1, sessionIds: [SESSION_1] }] })
    const conversation = source({ nodes: [] as Array<{ kind: 'tool-result'; seq: number; call: null }> })
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }),
      readAsset: vi.fn(),
      prompt: vi.fn(),
    }, vi.fn())
    const dispose = observeNovelContextSources({
      sessions: { list: sessionList, binding: () => ({ session: conversation }) },
      workspaces: { list: workspaceList },
    }, controller)
    await controller.open()
    expect(controller.getSnapshot()).toMatchObject({
      initialization: { blocker: expect.stringContaining('已关闭原生审批') },
    })

    sessionList.set({
      current: SESSION_1,
      byId: {
        [SESSION_1]: {
          agentPreset: 'ai-novel-writer',
          projectionValues: { permissions: { currentValue: 'danger-full-access' } },
        },
      },
    })
    await controller.whenIdle()
    expect(controller.getSnapshot()).toMatchObject({
      initialization: { blocker: expect.stringContaining('已关闭原生审批') },
    })

    sessionList.set({
      current: SESSION_1,
      byId: {
        [SESSION_1]: {
          agentPreset: 'ai-novel-writer',
          projectionValues: { permissions: { currentValue: 'workspace-write' } },
        },
      },
    })
    await controller.whenIdle()
    expect(controller.getSnapshot()).toMatchObject({ initialization: { phase: 'editing' } })
    const snapshot = controller.getSnapshot()
    expect(snapshot.status === 'not-initialized' ? snapshot.initialization.blocker : 'wrong state').toBeUndefined()
    dispose()
  })

  it('follows selection and refreshes only for a completed novel mutation result', async () => {
    const sessionList = source({ current: SESSION_1 as SessionId | undefined, byId: {
      [SESSION_1]: { agentPreset: 'ai-novel-writer' }, [SESSION_2]: { agentPreset: 'ai-novel-writer' },
    } })
    const workspaceList = source({ items: [{ workspaceId: WORKSPACE_1, sessionIds: [SESSION_1] }] })
    const conversations = new Map([
      [SESSION_1, source({ nodes: [] as Array<{
        kind: 'tool-result'; seq: number; call: { name: string; argsRaw?: string } | null; isError?: boolean
        content?: readonly { type: string; text?: string }[]; meta?: unknown
      }> })],
      [SESSION_2, source({ nodes: [] as Array<{
        kind: 'tool-result'; seq: number; call: { name: string; argsRaw?: string } | null; isError?: boolean
      }> })],
    ])
    const read = vi.fn(async () => ready)
    const controller = new NovelWorkbenchController({ read, readAsset: vi.fn(), prompt: vi.fn() }, vi.fn())
    const settled = vi.spyOn(controller, 'novelApplySettled')
    const dispose = observeNovelContextSources({
      sessions: {
        list: sessionList,
        binding: id => {
          const session = conversations.get(id)
          return session === undefined ? undefined : { session }
        },
      },
      workspaces: { list: workspaceList },
    }, controller)

    await controller.open()
    expect(read).toHaveBeenCalledTimes(1)
    conversations.get(SESSION_1)!.set({
      nodes: [{ kind: 'tool-result', seq: 1, call: { name: 'novel_read' } }],
    })
    await controller.whenIdle()
    expect(read).toHaveBeenCalledTimes(1)
    conversations.get(SESSION_1)!.set({
      nodes: [
        { kind: 'tool-result', seq: 1, call: { name: 'novel_read' } },
        {
          kind: 'tool-result', seq: 2,
          call: {
            name: 'novel_apply_change',
            argsRaw: JSON.stringify({
              kind: 'initialize',
              projectId: '123e4567-e89b-42d3-a456-426614174000',
              createdAt: '2026-08-16T02:00:00.000Z',
              updatedAt: '2026-08-16T02:00:00.000Z',
              title: '潮汐来信',
              language: 'zh-CN',
              genre: '悬疑',
              plannedChapters: 24,
              targetWordsPerChapter: 3200,
              creativeStrategy: 'consistency-first',
            }),
          },
          content: [{ type: 'text', text: 'model-facing prose is not revision metadata' }],
          meta: { newRevision: 'b'.repeat(64) },
        },
      ],
    })
    await controller.whenIdle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(settled).toHaveBeenLastCalledWith({
      isError: false,
      code: undefined,
      newRevision: 'b'.repeat(64),
      attribution: {
        kind: 'initialize',
        requestJson: JSON.stringify({
          kind: 'initialize',
          projectId: '123e4567-e89b-42d3-a456-426614174000',
          createdAt: '2026-08-16T02:00:00.000Z',
          updatedAt: '2026-08-16T02:00:00.000Z',
          title: '潮汐来信',
          language: 'zh-CN',
          genre: '悬疑',
          plannedChapters: 24,
          targetWordsPerChapter: 3200,
          creativeStrategy: 'consistency-first',
        }, null, 2),
      },
    })
    conversations.get(SESSION_1)!.set({
      nodes: [
        { kind: 'tool-result', seq: 2, call: { name: 'novel_apply_change' } },
        {
          kind: 'tool-result', seq: 3, isError: true,
          call: {
            name: 'novel_apply_change',
            argsRaw: JSON.stringify({
              kind: 'replace', targetKind: 'chapter-draft', chapter: 2,
              baseRevision: 'a'.repeat(64), replacement: '# 第二章',
            }),
          },
        },
      ],
    })
    await controller.whenIdle()
    expect(read).toHaveBeenCalledTimes(3)
    expect(settled).toHaveBeenLastCalledWith({
      isError: true,
      code: undefined,
      attribution: {
        kind: 'replace', targetKind: 'chapter-draft', chapter: 2,
        baseRevision: 'a'.repeat(64), replacement: '# 第二章',
      },
    })

    conversations.get(SESSION_1)!.set({
      nodes: [{
        kind: 'tool-result', seq: 4, call: { name: 'novel_apply_change' },
        meta: { newRevision: 'malformed' },
        content: [{ type: 'text', text: JSON.stringify({ newRevision: 'c'.repeat(64) }) }],
      }],
    })
    await controller.whenIdle()
    expect(settled).toHaveBeenLastCalledWith({
      isError: false,
      code: undefined,
      attribution: undefined,
    })

    conversations.get(SESSION_1)!.set({
      nodes: [{
        kind: 'tool-result', seq: 5, call: { name: 'novel_apply_change' },
        content: [{ type: 'text', text: JSON.stringify({ newRevision: 'd'.repeat(64) }) }],
      }],
    })
    await controller.whenIdle()
    expect(settled).toHaveBeenLastCalledWith({
      isError: false,
      code: undefined,
      attribution: undefined,
    })

    workspaceList.set({ items: [{ workspaceId: WORKSPACE_2, sessionIds: [SESSION_2] }] })
    sessionList.set({ current: SESSION_2, byId: {
      [SESSION_1]: { agentPreset: 'ai-novel-writer' }, [SESSION_2]: { agentPreset: 'ai-novel-writer' },
    } })
    await controller.whenIdle()
    expect(read.mock.calls.at(-1)?.slice(0, 2)).toEqual(['workspace-2', 1])

    dispose()
    conversations.get(SESSION_2)!.set({
      nodes: [{ kind: 'tool-result', seq: 3, call: { name: 'novel_apply_change' } }],
    })
    await controller.whenIdle()
    expect(read).toHaveBeenCalledTimes(6)
  })

  it('retries binding when the selected Session materializes after the list row', async () => {
    const sessionList = source({ current: SESSION_1 as SessionId | undefined, byId: { [SESSION_1]: { agentPreset: 'ai-novel-writer' } } })
    const workspaceList = source({ items: [{ workspaceId: WORKSPACE_1, sessionIds: [SESSION_1] }] })
    const conversation = source({
      nodes: [] as Array<{
        kind: string
        seq: number
        call: { name: string } | null
        content?: readonly { type: string; text?: string }[]
      }>,
    })
    let materialized = false
    const read = vi.fn(async () => ready)
    const controller = new NovelWorkbenchController({ read, readAsset: vi.fn(), prompt: vi.fn() }, vi.fn())
    const dispose = observeNovelContextSources({
      sessions: {
        list: sessionList,
        binding: () => materialized ? { session: conversation } : undefined,
      },
      workspaces: { list: workspaceList },
    }, controller)
    await controller.open()
    materialized = true
    sessionList.set({ current: SESSION_1, byId: { [SESSION_1]: { agentPreset: 'ai-novel-writer' } } })
    conversation.set({ nodes: [{ kind: 'tool-result', seq: 1, call: { name: 'novel_apply_change' } }] })
    await controller.whenIdle()

    expect(read).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('settles only the turn whose durable user message contains the active generation marker', async () => {
    const sessionList = source({ current: SESSION_1 as SessionId | undefined, byId: { [SESSION_1]: { agentPreset: 'ai-novel-writer' } } })
    const workspaceList = source({ items: [{ workspaceId: WORKSPACE_1, sessionIds: [SESSION_1] }] })
    const conversation = source({
      nodes: [] as Array<{
        kind: string
        seq: number
        call: { name: string } | null
        content?: readonly { type: string; text?: string }[]
      }>,
      turnEnds: new Map<number, number>(),
    })
    const read = vi.fn(async () => ready)
    const controller = new NovelWorkbenchController({ read, readAsset: vi.fn(), prompt: vi.fn() }, vi.fn())
    const turnSettled = vi.spyOn(controller, 'generationTurnSettled')
    vi.spyOn(controller, 'currentGenerationCorrelationMarker').mockReturnValue('marker-116-e')
    const dispose = observeNovelContextSources({
      sessions: { list: sessionList, binding: () => ({ session: conversation }) },
      workspaces: { list: workspaceList },
    }, controller)
    await controller.open()

    conversation.set({ nodes: [], turnEnds: new Map([[1, 7]]) })
    await controller.whenIdle()
    expect(turnSettled).not.toHaveBeenCalled()

    conversation.set({
      nodes: [{ kind: 'user', seq: 8, call: null, content: [{ type: 'text', text: 'queued [AI_NOVEL_UI_CORRELATION:marker-116-e]' }] }],
      turnEnds: new Map([[1, 7]]),
    })
    await controller.whenIdle()
    expect(turnSettled).not.toHaveBeenCalled()

    conversation.set({
      nodes: [{ kind: 'user', seq: 8, call: null, content: [{ type: 'text', text: 'queued [AI_NOVEL_UI_CORRELATION:marker-116-e]' }] }],
      turnEnds: new Map([[1, 7], [2, 12]]),
    })
    await controller.whenIdle()

    expect(turnSettled).toHaveBeenCalledOnce()
    const readsAfterTurn = read.mock.calls.length
    dispose()
    conversation.set({ nodes: [], turnEnds: new Map([[1, 7], [2, 12], [3, 15]]) })
    await controller.whenIdle()
    expect(turnSettled).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledTimes(readsAfterTurn)
  })

  it('fails a generation closed when its observed queued prompt disappears before becoming durable', async () => {
    const sessionList = source({ current: SESSION_1 as SessionId | undefined, byId: { [SESSION_1]: { agentPreset: 'ai-novel-writer' } } })
    const workspaceList = source({ items: [{ workspaceId: WORKSPACE_1, sessionIds: [SESSION_1] }] })
    const conversation = source({
      nodes: [] as Array<{ kind: string; seq: number; content?: readonly { type: string; text?: string }[] }>,
      turnEnds: new Map<number, number>(),
      queue: [{ text: '[AI_NOVEL_UI_CORRELATION:marker-deleted]', content: [] }] as Array<{
        text: string | null
        content: readonly { type: string; text?: string }[]
      }>,
      running: true,
    })
    const controller = new NovelWorkbenchController({
      read: vi.fn(async () => ready), readAsset: vi.fn(), prompt: vi.fn(),
    }, vi.fn())
    vi.spyOn(controller, 'currentGenerationCorrelationMarker').mockReturnValue('marker-deleted')
    const lost = vi.spyOn(controller, 'generationPromptLost')
    const dispose = observeNovelContextSources({
      sessions: { list: sessionList, binding: () => ({ session: conversation }) },
      workspaces: { list: workspaceList },
    }, controller)

    conversation.set({ nodes: [], turnEnds: new Map(), queue: [], running: false })
    await controller.whenIdle()

    expect(lost).toHaveBeenCalledOnce()
    dispose()
  })
})
