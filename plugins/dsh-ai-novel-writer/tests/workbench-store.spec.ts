import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  NovelWorkbenchController,
  NovelWorkbenchDisconnectedError,
  type NovelInitializationIdentity,
} from '../src/client/workbench-store.ts'
import type { NovelProjectId, Revision } from '../src/types.ts'

const WORKSPACE_ID = WorkspaceId('workspace-a')
const SESSION_ID = SessionId('session-a')
const IDENTITY: NovelInitializationIdentity = {
  projectId: '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId,
  createdAt: '2026-08-16T02:00:00.000Z',
  updatedAt: '2026-08-16T02:00:00.000Z',
}

describe('novel workbench initialization', () => {
  it('asks the selected model to generate canonical project settings through one approved initialize', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }), readAsset: vi.fn(), prompt,
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, agentPreset: 'ai-novel-writer', approval: 'ask' })
    await controller.open()

    controller.updateInitializationGenerationBrief('玄幻题材，主角林凡，规划 12 章。')
    await controller.generateInitialization()

    expect(prompt).toHaveBeenCalledOnce()
    const text = String(prompt.mock.calls[0]?.[1])
    expect(text).toContain('恰好调用一次 novel_read')
    expect(text).toContain('NOT_INITIALIZED')
    expect(text).toContain('恰好调用一次 novel_apply_change')
    expect(text).toContain('"projectId": "123e4567-e89b-42d3-a456-426614174000"')
    expect(text).toContain('"createdAt": "2026-08-16T02:00:00.000Z"')
    expect(text).toContain('"updatedAt": "2026-08-16T02:00:00.000Z"')
    expect(text).toContain('Harness 原生审批')
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: { generation: { brief: '玄幻题材，主角林凡，规划 12 章。', phase: 'submitted' } },
    })
  })

  it('uses a manually edited initialization form as model guidance without requiring a separate submission', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }), readAsset: vi.fn(), prompt,
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, agentPreset: 'ai-novel-writer', approval: 'ask' })
    await controller.open()
    controller.updateInitialization({ title: '本地手填标题' })
    controller.updateInitializationGenerationBrief('玄幻题材')

    await controller.generateInitialization()

    expect(prompt).toHaveBeenCalledOnce()
    expect(String(prompt.mock.calls[0]?.[1])).toContain('本地手填标题')
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: {
        draft: { title: '本地手填标题' },
        generation: { phase: 'submitted' },
      },
    })
  })

  it('generates initialization from project defaults when the optional brief is empty', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }), readAsset: vi.fn(), prompt,
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, agentPreset: 'ai-novel-writer', approval: 'ask' })
    await controller.open()

    await controller.generateInitialization()

    expect(prompt).toHaveBeenCalledOnce()
    expect(String(prompt.mock.calls[0]?.[1])).toContain('没有额外补充要求')
  })

  it('opens the generated project settings with visible authoritative fields after approval', async () => {
    const revision = 'b'.repeat(64) as Revision
    const projectText = `${JSON.stringify({
      formatVersion: 1,
      kind: 'harness-novel-project',
      ...IDENTITY,
      title: '雾海问道',
      language: 'zh-CN',
      genre: '玄幻',
      plannedChapters: 12,
      targetWordsPerChapter: 2100,
      creativeStrategy: 'consistency-first',
    }, null, 2)}\n`
    const readyProject = {
        status: 'ready',
        project: {
          projectId: IDENTITY.projectId,
          title: '雾海问道', language: 'zh-CN', genre: '玄幻', plannedChapters: 12,
          targetWordsPerChapter: 2100, creativeStrategy: 'consistency-first', updatedAt: IDENTITY.updatedAt,
        },
        progress: { selectedChapter: 1, plannedChapters: 12, status: 'unplanned', draftPresent: false, draftBytes: 0 },
        characters: [], storyBlueprint: null, chapterBlueprint: null, draft: null, omittedSources: [],
      } as const
    const read = vi.fn()
      .mockResolvedValueOnce({ status: 'not-initialized' })
      .mockResolvedValue(readyProject)
    const controller = new NovelWorkbenchController({
      read,
      readAsset: vi.fn().mockResolvedValue({
        target: { kind: 'project' }, revision, text: projectText,
        bytes: new TextEncoder().encode(projectText).byteLength,
      }),
      prompt: vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, agentPreset: 'ai-novel-writer', approval: 'ask' })
    await controller.open()
    await controller.generateInitialization()
    controller.novelApplySettled({
      isError: false,
      code: undefined,
      newRevision: revision,
      attribution: {
        kind: 'initialize',
        requestJson: JSON.stringify({ ...IDENTITY, title: '雾海问道' }),
      },
    })
    controller.generationTurnSettled()

    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'project',
        baseRevision: revision,
        draft: { title: '雾海问道', genre: '玄幻', targetWordsPerChapter: '2100' },
        generation: { phase: 'applied', message: expect.stringContaining('上方字段是磁盘中的最终内容') },
      },
    })
    expect(controller.currentGenerationCorrelationMarker()).toBeUndefined()

    controller.backToAssets()
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', screen: { kind: 'root' } })

    controller.setTarget({
      workspaceId: WorkspaceId('workspace-b'),
      sessionId: SessionId('session-b'),
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await controller.whenIdle()
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', screen: { kind: 'root' } })
  })

  it('locks every manual and generated initialize path while generation awaits reconciliation', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }), readAsset: vi.fn(), prompt,
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, agentPreset: 'ai-novel-writer', approval: 'ask' })
    await controller.open()
    controller.updateInitializationGenerationBrief('玄幻题材')
    await controller.generateInitialization()
    controller.generationTurnSettled()

    controller.updateInitialization({ title: '不得写入' })
    controller.previewInitialization()
    await controller.submitInitialization()
    await controller.generateInitialization()

    expect(prompt).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: { draft: { title: '' }, phase: 'editing', generation: { phase: 'reconciling' } },
    })

    controller.generationPromptLost()
    controller.updateInitialization({ title: '队列删除后可恢复手填' })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: {
        draft: { title: '队列删除后可恢复手填' },
        generation: { phase: 'error', message: expect.stringContaining('会话队列移除') },
      },
    })
  })

  it('submits one deterministic shallow initialization proposal through the current dedicated Session', async () => {
    const read = vi.fn().mockResolvedValue({ status: 'not-initialized' })
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = new NovelWorkbenchController(
      { read, readAsset: vi.fn(), prompt },
      vi.fn(),
      () => IDENTITY,
    )
    controller.setTarget({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await controller.open()

    controller.updateInitialization({
      title: '潮汐来信',
      language: 'zh-CN',
      genre: '悬疑',
      plannedChapters: '24',
      targetWordsPerChapter: '3200',
      creativeStrategy: 'consistency-first',
    })
    controller.previewInitialization()

    expect(prompt).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: {
        phase: 'preview',
        preview: {
          json: expect.stringContaining('"projectId": "123e4567-e89b-42d3-a456-426614174000"'),
        },
      },
    })
    await controller.submitInitialization()

    expect(prompt).toHaveBeenCalledWith(SESSION_ID, `请初始化当前 Harness 小说项目。

先调用 novel_read，确认项目尚未初始化。然后仅调用一次 novel_apply_change，并把以下 JSON 对象作为浅层参数原样传入；不要嵌套 request，不要改写任何值：

{
  "kind": "initialize",
  "projectId": "123e4567-e89b-42d3-a456-426614174000",
  "createdAt": "2026-08-16T02:00:00.000Z",
  "updatedAt": "2026-08-16T02:00:00.000Z",
  "title": "潮汐来信",
  "language": "zh-CN",
  "genre": "悬疑",
  "plannedChapters": 24,
  "targetWordsPerChapter": 3200,
  "creativeStrategy": "consistency-first"
}

这只是提案。必须等待 Harness 原生审批，并且只有收到 CommitReceipt 后才能声明保存成功。`)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: { phase: 'submitted' },
    })
  })

  it('keeps a submitted initialization locked when reread still reports no project', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }),
      readAsset: vi.fn(),
      prompt,
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await controller.open()
    controller.updateInitialization({ title: '潮汐来信', genre: '悬疑' })
    controller.previewInitialization()
    const preview = controller.getSnapshot()
    if (preview.status !== 'not-initialized' || preview.initialization.preview === undefined) {
      throw new Error('missing initialization preview')
    }

    await controller.submitInitialization()
    controller.novelApplySettled({
      isError: true,
      code: 'APPROVAL_REJECTED',
      attribution: {
        kind: 'initialize',
        requestJson: preview.initialization.preview.json.replace('潮汐来信', '旧提案'),
      },
    })
    await controller.refresh()
    await controller.submitInitialization()

    expect(prompt).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: { phase: 'submitted', preview: preview.initialization.preview },
    })
  })

  it.each([
    [
      { agentPreset: 'default', approval: 'ask' as const },
      '当前会话未使用“AI 小说作家”Preset，请新建或切换到该 Preset 会话。',
    ],
    [
      { agentPreset: 'ai-novel-writer', approval: 'never' as const },
      '当前会话已关闭原生审批，请将权限切换为“工作区写入”后再提交。',
    ],
    [
      { agentPreset: 'ai-novel-writer', approval: 'unknown' as const },
      '无法确认当前会话的审批策略，请切换到“工作区写入”后再提交。',
    ],
  ])('refuses submission before prompting when the selected Session cannot approve %#', async (selection, message) => {
    const prompt = vi.fn()
    const controller = new NovelWorkbenchController(
      { read: vi.fn().mockResolvedValue({ status: 'not-initialized' }), readAsset: vi.fn(), prompt },
      vi.fn(),
      () => IDENTITY,
    )
    controller.setTarget({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, ...selection })
    await controller.open()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: { blocker: message },
    })
    controller.updateInitialization({ title: '潮汐来信', genre: '悬疑' })

    await controller.submitInitialization()

    expect(prompt).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: { phase: 'error', message },
    })
  })

  it('inspects while closed and gives explicit loading, completion, and disconnected outcomes', async () => {
    let finish: ((value: { status: 'not-initialized' }) => void) | undefined
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockRejectedValueOnce(new NovelWorkbenchDisconnectedError())
    const controller = new NovelWorkbenchController({ read, readAsset: vi.fn(), prompt: vi.fn() }, vi.fn())
    controller.setTarget({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })

    const inspecting = controller.inspect()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loading', open: false,
      readFeedback: { kind: 'loading', message: '正在读取小说项目状态…' },
    })
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    finish?.({ status: 'not-initialized' })
    await inspecting
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized', open: false,
      readFeedback: { kind: 'success', message: '读取完成：当前工作区尚未初始化小说项目。' },
    })

    await controller.inspect()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'disconnected', open: false,
      readFeedback: { kind: 'disconnected', message: '读取失败：Harness 连接已断开。' },
    })
  })

  it('keeps the initialization draft when Session prompt admission is rejected', async () => {
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }),
      readAsset: vi.fn(),
      prompt: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'agent-busy', message: '当前会话正在运行' },
      }),
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await controller.open()
    controller.updateInitialization({ title: '潮汐来信', genre: '悬疑' })
    controller.previewInitialization()

    await controller.submitInitialization()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: {
        phase: 'error',
        message: '初始化提案未发送：agent-busy: 当前会话正在运行',
        draft: { title: '潮汐来信', genre: '悬疑' },
      },
    })
  })

  it('does not allocate project identity until the editable fields validate', async () => {
    const createIdentity = vi.fn(() => IDENTITY)
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }),
      readAsset: vi.fn(),
      prompt: vi.fn(),
    }, vi.fn(), createIdentity)
    controller.setTarget({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await controller.open()

    controller.previewInitialization()

    expect(createIdentity).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: { phase: 'error', message: '小说标题不能为空' },
    })
  })

  it('waits for the non-cancellable Session prompt to settle during disposal', async () => {
    let finish: (() => void) | undefined
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }),
      readAsset: vi.fn(),
      prompt: vi.fn(() => new Promise<import('../src/client/workbench-store.ts').NovelPromptResult>(resolve => {
        finish = () => { resolve({ ok: true, value: { accepted: true } }) }
      })),
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await controller.open()
    controller.updateInitialization({ title: '潮汐来信', genre: '悬疑' })
    controller.previewInitialization()
    const submitting = controller.submitInitialization()
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })

    let disposed = false
    const disposing = controller.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finish?.()
    await Promise.all([submitting, disposing])
    expect(disposed).toBe(true)
  })

  it('ignores duplicate submission while the non-cancellable Session prompt is in flight', async () => {
    let finish: ((value: import('../src/client/workbench-store.ts').NovelPromptResult) => void) | undefined
    const prompt = vi.fn(() => new Promise<import('../src/client/workbench-store.ts').NovelPromptResult>(resolve => {
      finish = resolve
    }))
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }),
      readAsset: vi.fn(),
      prompt,
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await controller.open()
    controller.updateInitialization({ title: '潮汐来信', genre: '悬疑' })
    controller.previewInitialization()

    const first = controller.submitInitialization()
    const duplicate = controller.submitInitialization()
    await duplicate

    expect(prompt).toHaveBeenCalledOnce()
    finish?.({ ok: true, value: { accepted: true } })
    await first
  })

  it('keeps one authoritative prompt when edits and another submission race disposal', async () => {
    let finish: ((value: import('../src/client/workbench-store.ts').NovelPromptResult) => void) | undefined
    const prompt = vi.fn(() => new Promise<import('../src/client/workbench-store.ts').NovelPromptResult>(resolve => {
      finish = resolve
    }))
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }),
      readAsset: vi.fn(),
      prompt,
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await controller.open()
    controller.updateInitialization({ title: '潮汐来信', genre: '悬疑' })
    controller.previewInitialization()
    const first = controller.submitInitialization()
    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })

    controller.updateInitialization({ title: '被竞态覆盖的标题' })
    controller.previewInitialization()
    const duplicate = controller.submitInitialization()

    expect(prompt).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: { phase: 'submitting', draft: { title: '潮汐来信' } },
    })
    let disposed = false
    const disposing = controller.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finish?.({ ok: true, value: { accepted: true } })
    await Promise.all([first, duplicate, disposing])
    expect(disposed).toBe(true)
  })

  it('does not publish an old prompt result into a newly selected Session', async () => {
    let finish: ((value: import('../src/client/workbench-store.ts').NovelPromptResult) => void) | undefined
    const controller = new NovelWorkbenchController({
      read: vi.fn().mockResolvedValue({ status: 'not-initialized' }),
      readAsset: vi.fn(),
      prompt: vi.fn(() => new Promise<import('../src/client/workbench-store.ts').NovelPromptResult>(resolve => {
        finish = resolve
      })),
    }, vi.fn(), () => IDENTITY)
    controller.setTarget({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await controller.open()
    controller.updateInitialization({ title: '潮汐来信', genre: '悬疑' })
    controller.previewInitialization()
    const first = controller.submitInitialization()
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })

    controller.setTarget({
      workspaceId: WorkspaceId('workspace-b'),
      sessionId: SessionId('session-b'),
      agentPreset: 'ai-novel-writer',
      approval: 'ask',
    })
    await vi.waitFor(() => { expect(controller.getSnapshot().status).toBe('not-initialized') })
    finish?.({ ok: true, value: { accepted: true } })
    await first

    expect(controller.getSnapshot()).toMatchObject({
      status: 'not-initialized',
      initialization: { phase: 'editing' },
    })
  })
})
