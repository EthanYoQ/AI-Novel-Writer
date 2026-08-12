import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelExecutionLeaseReceipt } from '../../../../shared/ipc-channels'
import { useEditorStore } from '../../../../stores/editor-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import {
  createGenerationRuntime,
  type GenerationRuntimeEnvironment,
} from '../../../generation/generation-runtime'
import { GenerationHarnessError } from '../../../generation/generation-harness'
import { RefineDraftCommand } from '../refine-draft.command'
import { RefineFromReviewCommand } from '../refine-from-review.command'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'

const PROJECT_PATH = 'C:\\novels\\refine'
const PROJECT_SESSION = Object.freeze({
  projectId: 'refine',
  leaseId: 'project-lease-refine',
  projectPath: PROJECT_PATH,
})

function leaseReceipt(): ModelExecutionLeaseReceipt {
  return {
    leaseId: 'model-lease-refine',
    modelId: 'model-a',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'model-a',
    modelRevision: 'a'.repeat(64),
    endpointFingerprint: 'b'.repeat(64),
    capabilityEvidence: {
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown',
      },
      subjectFingerprint: 'c'.repeat(64),
      contextWindowTokens: 32_768,
      maxOutputTokens: 8192,
      reasoning: null,
      structuredOutput: true,
      usage: null,
    },
    createdAt: 1000,
    expiresAt: 61_000,
  }
}

function runtimeDependencies(
  completeWithLease: GenerationRuntimeEnvironment['completeWithLease'],
): WorkflowGenerationRuntimeDependencies {
  return {
    createRuntime: options => createGenerationRuntime(options, {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: async () => leaseReceipt(),
      completeWithLease,
      closeModelExecution: async () => {},
    }),
  }
}

function workflowContext(): WorkflowContext {
  return {
    runId: 'refine-run',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    data: {},
    cancelled: false,
  }
}

function callbacks(): StepCallbacks {
  return {
    log: vi.fn(),
    setProgress: vi.fn(),
    appendText: vi.fn(),
  }
}

function stubIpc(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): void {
  vi.stubGlobal('window', {
    velaAPI: {
      invoke: (channel: string, ...args: unknown[]) => (
        channel === 'prompt:load-global'
          ? Promise.resolve({ templates: [], diagnostics: [] })
          : channel === 'fs:check-exists' && String(args[0]).endsWith('/.vela/prompts')
            ? Promise.resolve(false)
            : invoke(channel, ...args)
      ),
    },
  })
}

function command(
  completeWithLease: GenerationRuntimeEnvironment['completeWithLease'],
  draftContent: string,
): RefineDraftCommand {
  return new RefineDraftCommand({
    draftPath: 'vela://draft/1',
    draftContent,
    chapterNumber: 1,
    chapterInfo: {
      projectPath: PROJECT_PATH,
      chapterNumber: 1,
      title: '第一章',
      role: '开端',
      purpose: '建立冲突',
      keyEvents: '事件',
      characters: [],
    },
  }, runtimeDependencies(completeWithLease))
}

function reviewCommand(
  completeWithLease: GenerationRuntimeEnvironment['completeWithLease'],
  draftContent: string,
): RefineFromReviewCommand {
  return new RefineFromReviewCommand({
    draftPath: 'vela://draft/1',
    draftContent,
    reviewReport: '{"summary":"修复结尾事实冲突"}',
    chapterNumber: 1,
  }, runtimeDependencies(completeWithLease))
}

function successfulRevisionIpc() {
  return vi.fn(async (channel: string, ...args: unknown[]) => {
    void args
    if (channel === 'db:draft-get-meta') {
      return { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write' }
    }
    if (channel === 'db:revision-replace-pending') return { success: true, id: 9, revisionIndex: 2 }
    throw new Error(`unexpected IPC: ${channel}`)
  })
}

beforeEach(() => {
  useProjectStore.setState({
    currentProject: {
      id: 'refine',
      name: 'Refine',
      path: PROJECT_PATH,
      sessionLease: PROJECT_SESSION.leaseId,
      novelConfig: { globalGuidance: '', wordsPerChapter: 3000 },
    } as never,
  })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})

describe('RefineDraftCommand bounded visible completion', () => {
  it('merges an overlap after length and persists one complete revision only after the final stop', async () => {
    const overlap = '重叠句'.repeat(16)
    const first = `第一段修订正文。${overlap}`
    const second = `${overlap}第二段修订正文。`
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: first, finishReason: 'length' })
      .mockResolvedValueOnce({ content: second, finishReason: 'stop' })
    const invoke = successfulRevisionIpc()
    stubIpc(invoke)

    const result = await command(completeWithLease, '原稿内容。').execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })

    const expected = `${first}\n\n第二段修订正文。`
    expect(result).toBe(expected)
    expect(completeWithLease).toHaveBeenCalledTimes(2)
    expect(completeWithLease.mock.calls.map(([request]) => request.leaseId))
      .toEqual(['model-lease-refine', 'model-lease-refine'])
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:revision-replace-pending')).toEqual([
      ['db:revision-replace-pending', expect.objectContaining({ content: expected }), PROJECT_PATH, PROJECT_SESSION],
    ])
    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({ type: 'diff', content: expected }),
    ])
  })

  it('redacts reasoning from continuation context and persisted text', async () => {
    const visible = '可见修订正文'.repeat(20)
    const overlap = '衔接可见句'.repeat(10)
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({
        content: `<think>不要泄露的推理</think>${visible}${overlap}`,
        finishReason: 'length',
      })
      .mockResolvedValueOnce({
        content: `<think>续写推理</think>${overlap}结尾。`,
        finishReason: 'stop',
      })
    const invoke = successfulRevisionIpc()
    stubIpc(invoke)

    await command(completeWithLease, visible).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })

    const continuationPrompt = completeWithLease.mock.calls[1]?.[0].messages.at(-1)?.content ?? ''
    const persisted = invoke.mock.calls.find(([channel]) => channel === 'db:revision-replace-pending')?.[1] as { content: string }
    expect(continuationPrompt).not.toContain('不要泄露的推理')
    expect(persisted.content).not.toContain('推理')
    expect(persisted.content.match(new RegExp(overlap, 'gu'))).toHaveLength(1)
  })

  it('keeps revision storage untouched when a stop continuation contains no visible prose', async () => {
    const partial = '原稿正文。'.repeat(100)
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: partial, finishReason: 'length' })
      .mockResolvedValueOnce({ content: '<think>finished internally</think>', finishReason: 'stop' })
    const invoke = vi.fn()
    stubIpc(invoke)

    await expect(command(completeWithLease, partial).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow('续写未增加新的可见正文')

    expect(completeWithLease).toHaveBeenCalledTimes(2)
    expect(invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toEqual([])
  })

  it.each([
    ['content_filter', 'AI 输出因内容限制而未完成'],
    ['cancelled', 'AI 生成已取消'],
    ['unknown', 'AI 未正常完成生成'],
  ] as const)('keeps revision storage untouched on terminal %s', async (finishReason, message) => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '未完成正文', finishReason })
    const invoke = vi.fn()
    stubIpc(invoke)

    await expect(command(completeWithLease, '原稿正文').execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow(message)

    expect(completeWithLease).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toEqual([])
  })

  it.each([
    ['provider error', new Error('provider unavailable')],
    [
      'budget exhaustion',
      new GenerationHarnessError('REQUESTED_TOKEN_BUDGET_EXHAUSTED', '生成会话已用尽请求 Token 预算。'),
    ],
  ])('keeps revision storage untouched on %s', async (_label, failure) => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockRejectedValue(failure)
    const invoke = vi.fn()
    stubIpc(invoke)

    await expect(command(completeWithLease, '原稿正文').execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow()

    expect(invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toEqual([])
  })

  it('uses at most three continuations and persists nothing when all four calls end at length', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockImplementation(async () => ({
        content: `第 ${completeWithLease.mock.calls.length} 段${'仍未完成正文'.repeat(20)}`,
        finishReason: 'length',
      }))
    const invoke = vi.fn()
    stubIpc(invoke)

    await expect(command(completeWithLease, '原稿正文'.repeat(20)).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow('已自动续写 3 次仍未完成')

    expect(completeWithLease).toHaveBeenCalledTimes(4)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('persists nothing when cancellation happens after the first length result', async () => {
    const runContext = workflowContext()
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockImplementation(async () => {
        runContext.cancelled = true
        return { content: '半截正文', finishReason: 'length' }
      })
    const invoke = vi.fn()
    stubIpc(invoke)

    await expect(command(completeWithLease, '原稿正文').execute({
      step: {},
      context: runContext,
      callbacks: callbacks(),
    })).rejects.toThrow('工作流已取消')

    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects a project-session switch during continuation before any revision IPC', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockImplementation(async () => {
        if (completeWithLease.mock.calls.length === 1) {
          useProjectStore.setState({
            currentProject: {
              id: 'other',
              name: 'Other',
              path: 'C:\\novels\\other',
              sessionLease: 'other-lease',
              novelConfig: { globalGuidance: '', wordsPerChapter: 3000 },
            } as never,
          })
          return { content: '第一段修订正文。'.repeat(20), finishReason: 'length' }
        }
        return { content: '第二段修订正文。'.repeat(20), finishReason: 'stop' }
      })
    const invoke = vi.fn()
    stubIpc(invoke)

    await expect(command(completeWithLease, '原稿正文。'.repeat(20)).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow('当前项目已切换')

    expect(invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toEqual([])
  })

  it('rejects a final stop that is materially shorter than the source before any revision IPC', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '只有摘要', finishReason: 'stop' })
    const invoke = vi.fn()
    stubIpc(invoke)

    await expect(command(completeWithLease, '原稿正文。'.repeat(100)).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow('修稿结果明显短于原稿')

    expect(invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toEqual([])
  })

  it('allows substantial provider-neutral de-duplication above the completeness floor', async () => {
    const source = '原稿文字'.repeat(250)
    const revision = '精修文字'.repeat(175)
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: revision, finishReason: 'stop' })
    const invoke = successfulRevisionIpc()
    stubIpc(invoke)

    await expect(command(completeWithLease, source).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).resolves.toBe(revision)

    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:revision-replace-pending')).toHaveLength(1)
  })
})

describe('RefineFromReviewCommand bounded visible completion', () => {
  it('continues a length-limited public workflow and logs only bounded terminal evidence', async () => {
    const overlap = '审稿修复衔接句'.repeat(8)
    const first = `前半修复正文。${overlap}`
    const second = `${overlap}后半修复正文。`
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: first, finishReason: 'length' })
      .mockResolvedValueOnce({ content: second, finishReason: 'stop' })
    const invoke = successfulRevisionIpc()
    stubIpc(invoke)
    const stepCallbacks = callbacks()

    await expect(reviewCommand(completeWithLease, '原稿正文。').execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks,
    })).resolves.toBe(`${first}\n\n后半修复正文。`)

    expect(completeWithLease).toHaveBeenCalledTimes(2)
    expect(stepCallbacks.log).toHaveBeenCalledWith('  有界生成初始响应：finishReason=length')
    expect(stepCallbacks.log).toHaveBeenCalledWith('  自动续写第 1 轮响应：finishReason=stop')
    expect(stepCallbacks.log).not.toHaveBeenCalledWith(expect.stringContaining(first))
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:revision-replace-pending')).toHaveLength(1)
  })

  it('keeps revision storage untouched when a stop continuation only repeats the partial revision', async () => {
    const partial = '审稿修复正文。'.repeat(100)
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: partial, finishReason: 'length' })
      .mockResolvedValueOnce({ content: partial, finishReason: 'stop' })
    const invoke = vi.fn()
    stubIpc(invoke)

    await expect(reviewCommand(completeWithLease, partial).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow('续写未增加新的可见正文')

    expect(completeWithLease).toHaveBeenCalledTimes(2)
    expect(invoke).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs).toEqual([])
  })
})
