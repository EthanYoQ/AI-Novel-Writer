import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createHumanConfirmedReviewSnapshot,
  parseHumanConfirmedReviewSnapshot,
  renderHumanConfirmedReviewBrief,
  serializeHumanConfirmedReviewSnapshot,
  type HumanConfirmedReviewSnapshotInput,
} from '../../../../shared/human-confirmed-review'
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
import { ReviewChapterCommand } from '../review-chapter.command'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'

const PROJECT_PATH = 'C:\\novels\\refine'
const PROJECT_SESSION = Object.freeze({
  projectId: 'refine',
  leaseId: 'project-lease-refine',
  projectPath: PROJECT_PATH,
})

const CONFIRMATION_REVIEW_ID = 91

function confirmedReviewContent(
  overrides: Partial<HumanConfirmedReviewSnapshotInput> = {},
): string {
  const snapshot = createHumanConfirmedReviewSnapshot({
    sourceReviewId: 41,
    summary: '原始 AI 总结不能直接作为修稿提示。',
    authorGuidance: '保留开头的悬念。',
    items: [
      {
        category: '连续性',
        severity: 'error',
        description: '角色位置前后矛盾。',
        decision: 'apply',
        origin: 'ai',
      },
    ],
    ...overrides,
  })
  if (!snapshot) throw new Error('test fixture must form a valid confirmation snapshot')
  return serializeHumanConfirmedReviewSnapshot(snapshot)
}

const DEFAULT_CONFIRMED_REVIEW_CONTENT = confirmedReviewContent()
const RAW_AI_REVIEW_JSON = JSON.stringify({
  summary: '原始 AI JSON 不是人工确认快照。',
  items: [{ category: '连续性', severity: 'error', description: '未经确认的原始问题。' }],
})

function leaseReceipt(modelId = 'model-a'): ModelExecutionLeaseReceipt {
  return {
    leaseId: 'model-lease-refine',
    modelId,
    provider: 'custom',
    protocol: 'openai',
    modelName: modelId,
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

function workflowContext(options: { generationModelId?: string } = {}): WorkflowContext {
  return {
    runId: 'refine-run',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    ...(options.generationModelId ? { generationModelId: options.generationModelId } : {}),
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
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
  overrides: Partial<ConstructorParameters<typeof RefineFromReviewCommand>[0]> = {},
): RefineFromReviewCommand {
  return new RefineFromReviewCommand({
    draftPath: 'vela://draft/1',
    draftContent,
    confirmedReviewContent: DEFAULT_CONFIRMED_REVIEW_CONTENT,
    reviewSourceId: CONFIRMATION_REVIEW_ID,
    chapterNumber: 1,
    ...overrides,
  }, runtimeDependencies(completeWithLease))
}

function chapterReviewCommand(
  completeWithLease: GenerationRuntimeEnvironment['completeWithLease'],
): ReviewChapterCommand {
  return new ReviewChapterCommand({
    draftPath: 'vela://draft/1',
    draftContent: '待审章节正文。',
    chapterNumber: 1,
  }, runtimeDependencies(completeWithLease))
}

function successfulRevisionIpc(options: {
  reviewContent?: string
  reviewId?: number
  reviewBaseDraftId?: number
} = {}) {
  const reviewContent = options.reviewContent ?? DEFAULT_CONFIRMED_REVIEW_CONTENT
  const reviewId = options.reviewId ?? CONFIRMATION_REVIEW_ID
  const reviewBaseDraftId = options.reviewBaseDraftId ?? 1
  return vi.fn(async (channel: string, ...args: unknown[]) => {
    void args
    if (channel === 'db:draft-get-meta') {
      return { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write' }
    }
    if (channel === 'db:review-get-full') {
      return {
        id: reviewId,
        baseDraftId: reviewBaseDraftId,
        reviewIndex: 2,
        contentId: 7,
        createdAt: '2026-08-22T00:00:00.000Z',
        content: reviewContent,
      }
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
  it('uses the frozen English UI locale for visible refinement logs and the diff tab independently of Chinese writing', async () => {
    const source = 'Original chapter. '.repeat(120)
    const revision = 'Revised chapter. '.repeat(120)
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: revision, finishReason: 'stop' })
    stubIpc(successfulRevisionIpc())
    const stepCallbacks = callbacks()
    const context = {
      ...workflowContext(),
      writingLanguage: 'zh-CN' as const,
      uiLocale: 'en-US' as const,
    } as WorkflowContext & { uiLocale: 'en-US' }

    await command(completeWithLease, source).execute({ step: {}, context, callbacks: stepCallbacks })

    expect(stepCallbacks.log).toHaveBeenCalledWith('Refining the chapter...')
    expect(stepCallbacks.log).toHaveBeenCalledWith(expect.stringContaining('Revision complete'))
    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({
        name: 'Revision merge: Chapter 1',
        type: 'diff',
        revisionPath: 'vela://revision/9',
      }),
    ])
  })

  it('sends English built-in instructions for direct refinement, review, and confirmed-review refinement', async () => {
    useProjectStore.setState((state) => ({
      currentProject: state.currentProject
        ? {
            ...state.currentProject,
            novelConfig: {
              ...state.currentProject.novelConfig,
              writingLanguage: 'en-US',
            },
          }
        : null,
    }))
    const observed = new Map<string, string>()
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>(async request => {
      observed.set(request.purpose, request.messages.map(message => message.content).join('\n'))
      throw new Error('captured request')
    })
    stubIpc(vi.fn(async (channel: string) => {
      if (channel === 'db:draft-get-meta') {
        return { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write' }
      }
      if (channel === 'db:review-get-full') {
        return {
          id: CONFIRMATION_REVIEW_ID,
          baseDraftId: 1,
          reviewIndex: 2,
          contentId: 7,
          createdAt: '2026-08-22T00:00:00.000Z',
          content: DEFAULT_CONFIRMED_REVIEW_CONTENT,
        }
      }
      if (channel === 'kb:search' || channel === 'db:character-get-all') return []
      if (channel === 'db:project-core-get') return {}
      throw new Error(`unexpected IPC: ${channel}`)
    }))
    const context = { ...workflowContext(), writingLanguage: 'en-US' as const }
    const commands = [
      command(completeWithLease, 'Original café sign: “夜航 Café”.'),
      chapterReviewCommand(completeWithLease),
      reviewCommand(completeWithLease, 'Original café sign: “夜航 Café”.'),
    ]
    for (const target of commands) {
      await expect(target.execute({ step: {}, context, callbacks: callbacks() })).rejects.toThrow()
    }

    expect(observed.get('refine-draft')).toContain('Revise the chapter manuscript')
    expect(observed.get('review-chapter')).toContain('Review the chapter for objective continuity')
    expect(observed.get('refine-from-review')).toContain('Revise the chapter using only the confirmed review checklist')
    for (const request of observed.values()) {
      expect(request).not.toContain('你是一位功力深厚的文学编辑')
      expect(request).not.toContain('你是一位严谨的小说质量监督编辑')
      expect(request).not.toContain('你是一位严谨的小说编辑')
    }
  })

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
  it('uses the frozen English UI locale for visible confirmed-review logs and the diff tab', async () => {
    const source = 'Original reviewed chapter. '.repeat(100)
    const revision = 'Corrected reviewed chapter. '.repeat(100)
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: revision, finishReason: 'stop' })
    stubIpc(successfulRevisionIpc())
    const stepCallbacks = callbacks()
    const context = {
      ...workflowContext(),
      writingLanguage: 'zh-CN' as const,
      uiLocale: 'en-US' as const,
    } as WorkflowContext & { uiLocale: 'en-US' }

    await reviewCommand(completeWithLease, source).execute({ step: {}, context, callbacks: stepCallbacks })

    expect(stepCallbacks.log).toHaveBeenCalledWith('Revising from the confirmed review checklist...')
    expect(stepCallbacks.log).toHaveBeenCalledWith(expect.stringContaining('Review-based revision complete'))
    const visibleLogs = vi.mocked(stepCallbacks.log).mock.calls.map(([message]) => message).join('\n')
    expect(['✅', '⚠️', '❌'].some(icon => visibleLogs.includes(icon))).toBe(false)
    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({
        name: 'Review fix: Chapter 1',
        type: 'diff',
        revisionPath: 'vela://revision/9',
      }),
    ])
  })

  it('uses the frozen English UI locale for a pre-generation confirmation error', async () => {
    const createRuntime = vi.fn<WorkflowGenerationRuntimeDependencies['createRuntime']>()
    const target = new RefineFromReviewCommand({
      draftPath: 'vela://draft/1',
      draftContent: 'Original chapter.',
      chapterNumber: 1,
    }, { createRuntime })
    const context = {
      ...workflowContext(),
      writingLanguage: 'zh-CN' as const,
      uiLocale: 'en-US' as const,
    } as WorkflowContext & { uiLocale: 'en-US' }

    await expect(target.execute({ step: {}, context, callbacks: callbacks() }))
      .rejects.toThrow('Review-based revision requires a saved human-confirmed review snapshot')
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it('sends the same English confirmed-review brief shown by the project-language preview', async () => {
    const persistedConfirmation = confirmedReviewContent({
      authorGuidance: 'Preserve the opening suspense.',
      items: [{
        category: 'continuity',
        severity: 'error',
        description: 'Keep the character at the harbor until departure.',
        quote: 'She waited beside the harbor light.',
        decision: 'apply',
        origin: 'author',
      }],
    })
    const confirmedSnapshot = parseHumanConfirmedReviewSnapshot(persistedConfirmation)
    if (!confirmedSnapshot) throw new Error('Expected a valid confirmed-review fixture')
    const previewBrief = renderHumanConfirmedReviewBrief(confirmedSnapshot, 'en-US')
    const source = 'Original reviewed chapter. '.repeat(100)
    const revision = 'Corrected reviewed chapter. '.repeat(100)
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: revision, finishReason: 'stop' })
    stubIpc(successfulRevisionIpc({ reviewContent: persistedConfirmation }))

    await reviewCommand(completeWithLease, source, {
      confirmedReviewContent: persistedConfirmation,
    }).execute({
      step: {},
      context: { ...workflowContext(), writingLanguage: 'en-US' },
      callbacks: callbacks(),
    })

    const prompt = completeWithLease.mock.calls[0]?.[0].messages
      .map(message => message.content)
      .join('\n') ?? ''
    expect(previewBrief).toContain('[Confirmed review items included in this revision]')
    expect(previewBrief).toContain('[Confirmed author guidance]')
    expect(prompt).toContain(previewBrief)
    expect(prompt).not.toContain('【已确认纳入本次修稿的审稿项】')
    expect(prompt).not.toContain('【作者补充修稿指导】')
  })

  it('uses the persisted confirmation row as the only refinement input, records that row on the pending revision, and preserves the draft before merge', async () => {
    const persistedConfirmation = confirmedReviewContent({
      sourceReviewId: 41,
      summary: '原始 AI 总结绝不能进入修稿提示。',
      authorGuidance: '保留开头的悬念。',
      items: [
        {
          category: '连续性',
          severity: 'error',
          description: '只修复这个已确认的问题。',
          decision: 'apply',
          origin: 'ai',
        },
        {
          category: '节奏',
          severity: 'warning',
          description: '这个被作者忽略，不能送入模型。',
          decision: 'ignore',
          origin: 'ai',
        },
      ],
    })
    const sourceDraft = '原稿正文。'.repeat(250)
    const revision = '修订正文。'.repeat(250)
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: revision, finishReason: 'stop' })
    const invoke = successfulRevisionIpc({ reviewContent: persistedConfirmation })
    stubIpc(invoke)

    const begunModelIds: string[] = []
    const createRuntime = vi.fn<WorkflowGenerationRuntimeDependencies['createRuntime']>(options => (
      createGenerationRuntime(options, {
        snapshotDefaultModelId: () => 'glm-global-default',
        beginModelExecution: async modelId => {
          begunModelIds.push(modelId)
          return leaseReceipt(modelId)
        },
        completeWithLease,
        closeModelExecution: async () => {},
      })
    ))
    const command = new RefineFromReviewCommand({
      draftPath: 'vela://draft/1',
      draftContent: sourceDraft,
      confirmedReviewContent: persistedConfirmation,
      reviewSourceId: CONFIRMATION_REVIEW_ID,
      reviewReport: '{"summary":"原始 AI 报告也不能进入模型"}',
      userRefinePrompt: '瞬态 UI 提示不得绕过确认快照。',
      chapterNumber: 1,
    }, { createRuntime })

    await expect(command.execute({
      step: {},
      context: workflowContext({ generationModelId: 'grok-selected-model' }),
      callbacks: callbacks(),
    })).resolves.toBe(revision)

    expect(invoke).toHaveBeenCalledWith(
      'db:review-get-full',
      CONFIRMATION_REVIEW_ID,
      PROJECT_PATH,
      PROJECT_SESSION,
    )
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'grok-selected-model' }))
    expect(begunModelIds).toEqual(['grok-selected-model'])
    const prompt = completeWithLease.mock.calls[0]?.[0].messages.map(message => message.content).join('\n') ?? ''
    expect(prompt).toContain('只修复这个已确认的问题。')
    expect(prompt).toContain('保留开头的悬念。')
    expect(prompt).not.toContain('这个被作者忽略，不能送入模型。')
    expect(prompt).not.toContain('原始 AI 总结绝不能进入修稿提示。')
    expect(prompt).not.toContain('瞬态 UI 提示不得绕过确认快照。')

    const pendingRevision = invoke.mock.calls.find(([channel]) => channel === 'db:revision-replace-pending')?.[1]
    expect(pendingRevision).toMatchObject({
      baseDraftId: 1,
      revisionType: 'review-fix',
      reviewSourceId: CONFIRMATION_REVIEW_ID,
      userPrompt: '保留开头的悬念。',
      content: revision,
    })
    expect(invoke.mock.calls.some(([channel]) => (
      channel === 'db:draft-create' || channel === 'db:draft-update-content'
    ))).toBe(false)
  })

  const allIgnoredConfirmationContent = () => confirmedReviewContent({
    authorGuidance: '这条补充说明不能单独触发模型。',
    items: [{
      category: '连续性',
      severity: 'error',
      description: '作者选择忽略的问题。',
      decision: 'ignore',
      origin: 'ai',
    }],
  })

  it.each([
    ['the confirmation row is missing', () => null, () => DEFAULT_CONFIRMED_REVIEW_CONTENT],
    ['the confirmation row contains raw AI JSON', () => ({
      id: CONFIRMATION_REVIEW_ID,
      baseDraftId: 1,
      reviewIndex: 2,
      contentId: 7,
      createdAt: '2026-08-22T00:00:00.000Z',
      content: RAW_AI_REVIEW_JSON,
    }), () => DEFAULT_CONFIRMED_REVIEW_CONTENT],
    ['all review items are ignored even when author guidance is non-empty', () => ({
      id: CONFIRMATION_REVIEW_ID,
      baseDraftId: 1,
      reviewIndex: 2,
      contentId: 7,
      createdAt: '2026-08-22T00:00:00.000Z',
      content: allIgnoredConfirmationContent(),
    }), allIgnoredConfirmationContent],
    ['the stored confirmation belongs to a different base draft', () => ({
      id: CONFIRMATION_REVIEW_ID,
      baseDraftId: 999,
      reviewIndex: 2,
      contentId: 7,
      createdAt: '2026-08-22T00:00:00.000Z',
      content: DEFAULT_CONFIRMED_REVIEW_CONTENT,
    }), () => DEFAULT_CONFIRMED_REVIEW_CONTENT],
    ['the renderer snapshot differs from the persisted confirmation row', () => ({
      id: CONFIRMATION_REVIEW_ID,
      baseDraftId: 1,
      reviewIndex: 2,
      contentId: 7,
      createdAt: '2026-08-22T00:00:00.000Z',
      content: DEFAULT_CONFIRMED_REVIEW_CONTENT,
    }), () => confirmedReviewContent({
      items: [{
        category: '伪造输入',
        severity: 'error',
        description: '前端传来的伪造修稿项。',
        decision: 'apply',
        origin: 'author',
      }],
      authorGuidance: '前端临时指导。',
    })],
  ])('does not open a generation runtime when %s', async (_case, storedReview, rendererContent) => {
    const createRuntime = vi.fn<WorkflowGenerationRuntimeDependencies['createRuntime']>()
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:draft-get-meta') {
        return { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write' }
      }
      if (channel === 'db:review-get-full') return storedReview()
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubIpc(invoke)
    const command = new RefineFromReviewCommand({
      draftPath: 'vela://draft/1',
      draftContent: '原稿正文。'.repeat(100),
      confirmedReviewContent: rendererContent(),
      reviewSourceId: CONFIRMATION_REVIEW_ID,
      chapterNumber: 1,
    }, { createRuntime })

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow()

    expect(createRuntime).not.toHaveBeenCalled()
    expect(completeWithLease).not.toHaveBeenCalled()
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:revision-replace-pending')).toBe(false)
  })

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
    expect(completeWithLease.mock.calls.map(([request]) => request.reasoningStage))
      .toEqual(['review', 'review'])
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
    const invoke = successfulRevisionIpc()
    stubIpc(invoke)

    await expect(reviewCommand(completeWithLease, partial).execute({
      step: {},
      context: workflowContext(),
      callbacks: callbacks(),
    })).rejects.toThrow('续写未增加新的可见正文')

    expect(completeWithLease).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:revision-replace-pending')).toHaveLength(0)
    expect(useEditorStore.getState().tabs).toEqual([])
  })
})

describe('ReviewChapterCommand reasoning stage', () => {
  it('maps current deterministic findings into the persisted review for human confirmation', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '{"summary":"ok","items":[]}', finishReason: 'stop' })
    const createParams: Array<{ content: string }> = []
    stubIpc(vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'kb:search' || channel === 'db:character-get-all') return []
      if (channel === 'db:project-core-get') return {}
      if (channel === 'db:draft-get-meta') return { id: 1, chapterNumber: 2, version: 1, status: 'draft', source: 'write' }
      if (channel === 'db:review-next-index') return 1
      if (channel === 'db:blueprint-get') return {
        chapterNumber: 2, title: '重逢', role: '发展', purpose: '顾舟归来', keyEvents: '顾舟敲门',
        characters: ['顾舟'], suspenseHook: '他为何归来', userGuidance: '', notes: '', notesUpdatedAt: '',
      }
      if (channel === 'db:consistency-exemption-list') return []
      if (channel === 'db:continuity-list-before') return [{
        draftId: 9, chapterNumber: 1, chapterTitle: '终局', chapterNotes: '顾舟死亡',
        facts: [{ category: 'character-state', entities: ['顾舟'], statement: '顾舟已经死亡。', sourceChapter: 1, evidence: '顾舟停止了呼吸。' }],
      }]
      if (channel === 'db:review-create') {
        createParams.push(args[0] as { content: string })
        return { success: true, id: 77 }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    }))

    await chapterReviewCommand(completeWithLease).execute({ step: {}, context: workflowContext(), callbacks: callbacks() })

    expect(JSON.parse(createParams[0]!.content).items).toEqual([
      expect.objectContaining({ category: '确定性一致性预检', stableFactKey: expect.stringMatching(/^fact:[0-9a-f]{16}$/u) }),
    ])
  })

  it('preserves the AI review when deterministic continuity evidence cannot be read', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '{"summary":"AI review","items":[]}', finishReason: 'stop' })
    const createParams: Array<{ content: string }> = []
    stubIpc(vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'kb:search' || channel === 'db:character-get-all') return []
      if (channel === 'db:project-core-get') return {}
      if (channel === 'db:draft-get-meta') return { id: 1, chapterNumber: 2, version: 1, status: 'draft', source: 'write' }
      if (channel === 'db:review-next-index') return 1
      if (channel === 'db:blueprint-get') return {
        chapterNumber: 2, title: '重逢', role: '发展', purpose: '顾舟归来', keyEvents: '顾舟敲门',
        characters: ['顾舟'], suspenseHook: '他为何归来', userGuidance: '', notes: '', notesUpdatedAt: '',
      }
      if (channel === 'db:consistency-exemption-list') return []
      if (channel === 'db:continuity-list-before') throw new Error('projection unavailable')
      if (channel === 'db:review-create') {
        createParams.push(args[0] as { content: string })
        return { success: true, id: 77 }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    }))
    const stepCallbacks = callbacks()

    await expect(chapterReviewCommand(completeWithLease).execute({
      step: {}, context: workflowContext(), callbacks: stepCallbacks,
    })).resolves.toContain('AI review')

    expect(JSON.parse(createParams[0]!.content)).toEqual({ summary: 'AI review', items: [] })
    expect(stepCallbacks.log).toHaveBeenCalledWith('一致性证据暂时不可用；AI 审稿仍会继续。')
  })

  it('uses the frozen English UI locale for visible review logs and the report tab independently of Chinese writing', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '{"summary":"ok","items":[]}', finishReason: 'stop' })
    stubIpc(vi.fn(async (channel: string) => {
      if (channel === 'kb:search' || channel === 'db:character-get-all') return []
      if (channel === 'db:project-core-get') return {}
      if (channel === 'db:draft-get-meta') {
        return { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write' }
      }
      if (channel === 'db:review-next-index') return 1
      if (channel === 'db:review-create') return { success: true, id: 77 }
      if (channel === 'db:blueprint-get') return null
      throw new Error(`unexpected IPC: ${channel}`)
    }))
    const stepCallbacks = callbacks()
    const context = {
      ...workflowContext(),
      writingLanguage: 'zh-CN' as const,
      uiLocale: 'en-US' as const,
    } as WorkflowContext & { uiLocale: 'en-US' }

    await chapterReviewCommand(completeWithLease).execute({ step: {}, context, callbacks: stepCallbacks })

    expect(stepCallbacks.log).toHaveBeenCalledWith('Preparing the continuity review...')
    expect(stepCallbacks.log).toHaveBeenCalledWith(expect.stringContaining('Review complete'))
    expect(useEditorStore.getState().tabs).toEqual([
      expect.objectContaining({ name: 'Review report: Chapter 1', type: 'review-report' }),
    ])
  })

  it('routes the public review workflow through the review stage', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '{"summary":"ok","items":[]}', finishReason: 'stop' })
    stubIpc(vi.fn(async (channel: string) => {
      if (channel === 'kb:search') return []
      if (channel === 'db:character-get-all') return []
      if (channel === 'db:project-core-get') return {}
      if (channel === 'db:draft-get-meta') {
        return { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write' }
      }
      if (channel === 'db:review-next-index') return 1
      if (channel === 'db:review-create') return { success: true }
      if (channel === 'db:blueprint-get') return null
      throw new Error(`unexpected IPC: ${channel}`)
    }))

    const context = {
      ...workflowContext(),
      writingSkills: Object.freeze({
        review: Object.freeze({
          skillId: 'user:review-craft', name: 'Review craft', stage: 'review' as const,
          source: 'user' as const, writingLanguage: 'zh-CN' as const,
          content: '检查角色动机与因果连续性。', utf8Bytes: 39,
        }),
      }),
    }
    await chapterReviewCommand(completeWithLease).execute({
      step: {},
      context,
      callbacks: callbacks(),
    })

    expect(completeWithLease).toHaveBeenCalledOnce()
    expect(completeWithLease.mock.calls[0]?.[0].reasoningStage).toBe('review')
    expect(completeWithLease.mock.calls[0]?.[0].messages[1]?.content)
      .toContain('【补充写作 Skill：Review craft】')
  })
})
