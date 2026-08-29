import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import {
  buildFinalizePostProcessSteps,
  FinalizeChapterCommand,
  type FinalizePostProcessGeneration,
} from '../finalize-chapter.command'
import { RefineDraftCommand as RuntimeRefineDraftCommand } from '../refine-draft.command'
import { RefineFromReviewCommand as RuntimeRefineFromReviewCommand } from '../refine-from-review.command'
import { ReviewChapterCommand as RuntimeReviewChapterCommand } from '../review-chapter.command'
import { savePartialData } from '../architecture.command'
import { runPostProcessPipeline } from '../../workflow-utils'
import { createBoundedCompletionError } from '../../bounded-completion'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'

class RefineDraftCommand extends RuntimeRefineDraftCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeRefineDraftCommand>) {
    super(args[0], workflowRuntimeDependencies)
  }
}

class RefineFromReviewCommand extends RuntimeRefineFromReviewCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeRefineFromReviewCommand>) {
    super(args[0], workflowRuntimeDependencies)
  }
}

class ReviewChapterCommand extends RuntimeReviewChapterCommand {
  constructor(...args: ConstructorParameters<typeof RuntimeReviewChapterCommand>) {
    super(args[0], workflowRuntimeDependencies)
  }
}

const finalizationClient = vi.hoisted(() => ({
  commitFinalizationSnapshot: vi.fn(),
}))

vi.mock('../../../finalization-client', () => finalizationClient)

const PROJECT_PATH = 'C:\\novels\\A'
const CONFIRMED_REVIEW_CONTENT = JSON.stringify({
  kind: 'human-confirmed-review',
  schemaVersion: 1,
  sourceReviewId: 7,
  summary: '需要修复连续性问题。',
  authorGuidance: '',
  items: [{
    category: '连续性',
    severity: 'error',
    description: '修复角色位置矛盾。',
    decision: 'apply',
    origin: 'ai',
  }],
})

function callbacks(): StepCallbacks {
  return {
    log: vi.fn(),
    setProgress: vi.fn(),
    appendText: vi.fn(),
  }
}

function testPostProcessGeneration(): FinalizePostProcessGeneration {
  return {
    complete(builder, stepCallbacks) {
      const llmStore = useLLMStore.getState()
      return new Promise<string>((resolve, reject) => {
        llmStore.generateStream(
          [
            { role: 'system', content: builder.getSystemRole() },
            { role: 'user', content: builder.build() },
          ],
          {
            onChunk: chunk => stepCallbacks.appendText(chunk),
            onDone: (content, _usage, finishReason) => {
              const terminalReason = finishReason ?? 'unknown'
              if (terminalReason !== 'stop') {
                reject(createBoundedCompletionError(terminalReason))
                return
              }
              resolve(content)
            },
            onError: error => reject(new Error(error)),
          },
        ).catch(reject)
      })
    },
  }
}

function context(): WorkflowContext {
  return {
    runId: 'mutation-boundary',
    projectPath: PROJECT_PATH,
    projectSession: { projectId: 'A', leaseId: 'lease-A', projectPath: PROJECT_PATH },
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    data: {},
    cancelled: false,
  }
}

function chapterInfo() {
  return {
    projectPath: PROJECT_PATH,
    chapterNumber: 1,
    title: '第一章',
    role: '开端',
    purpose: '建立冲突',
    keyEvents: '事件',
    characters: [],
  }
}

function stubLlm(command: object, response: string): void {
  const target = command as {
    callLLMWithBuilder: () => Promise<string>
    callLLMWithBoundedCompletion?: () => Promise<string>
  }
  vi.spyOn(target, 'callLLMWithBuilder').mockResolvedValue(response)
  if (typeof target.callLLMWithBoundedCompletion === 'function') {
    vi.spyOn(target as Required<typeof target>, 'callLLMWithBoundedCompletion').mockResolvedValue(response)
  }
}

function stubVelaIpc(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): void {
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

beforeEach(() => {
  finalizationClient.commitFinalizationSnapshot.mockReset()
  useProjectStore.setState({
    currentProject: {
      id: 'A',
      name: 'A',
      path: PROJECT_PATH,
      sessionLease: 'lease-A',
      novelConfig: {
        globalGuidance: '',
        wordsPerChapter: 3000,
      },
    } as never,
  })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ defaultModelId: null })
})

describe('workflow mutation failure boundaries', () => {
  it('sends both finalization post-process requests in the frozen English writing language', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:blueprint-update-notes') return { success: true }
      if (channel === 'db:character-roster-read') {
        return { status: 'empty', revision: 0, entries: [] }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    const observedMessages: Array<Array<{ role: string; content: string }>> = []
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream: vi.fn(async (messages, streamCallbacks) => {
        observedMessages.push(messages)
        streamCallbacks.onDone?.(
          observedMessages.length === 2
            ? '{"updates":[],"newCharacters":[]}'
            : '# Chapter 1 Notes\n\n## Plot Events\n- [Trigger] The café opens.',
          undefined,
          'stop',
        )
        return `request-${observedMessages.length}`
      }),
    })
    const steps = buildFinalizePostProcessSteps(
      { path: PROJECT_PATH },
      1,
      'Night Café 夜航',
      'The sign reads “夜航 Café”.',
      testPostProcessGeneration(),
    )
    const workflowContext = { ...context(), writingLanguage: 'en-US' as const }

    await steps.find(step => step.key === 'chapter_notes')!.executor(callbacks(), workflowContext)
    await steps.find(step => step.key === 'character_cards')!.executor(callbacks(), workflowContext)

    expect(observedMessages).toHaveLength(2)
    expect(observedMessages[0]?.[0]?.content).toContain('You are a professional fiction structure analyst')
    expect(observedMessages[0]?.[1]?.content).toContain('Generate precise structured chapter notes')
    expect(observedMessages[0]?.[1]?.content).toContain('The sign reads “夜航 Café”.')
    expect(observedMessages[1]?.[0]?.content).toContain('You maintain rigorous character records')
    expect(observedMessages[1]?.[1]?.content).toContain('Existing character records')
    expect(observedMessages[1]?.[1]?.content).not.toContain('【任务要求】')
  })

  it('treats committed-but-pending manuscript publication as a failed finalization step', async () => {
    finalizationClient.commitFinalizationSnapshot.mockResolvedValue({
      success: false,
      committed: true,
      finalizationId: 'finalization-1',
      contentHash: 'snapshot-hash',
      contentRevision: 8,
      draftId: 1,
      publicationStatus: 'pending',
      error: '定稿已提交、实体稿待发布：disk unavailable',
    })
    const command = new FinalizeChapterCommand({
      draftPath: 'vela://draft/1',
      draftContent: '旧参数正文不得被读取',
      chapterNumber: 1,
      chapterInfo: chapterInfo(),
      snapshot: Object.freeze({
        tabId: 'draft-1',
        projectPath: PROJECT_PATH,
        projectSession: Object.freeze({
          projectId: 'A',
          leaseId: 'lease-A',
          projectPath: PROJECT_PATH,
        }),
        draftId: 1,
        chapterNumber: 1,
        chapterTitle: '第一章',
        content: '编辑器冻结正文',
        contentRevision: 8,
      }),
    })

    await expect(command.execute({
      step: {},
      context: context(),
      callbacks: callbacks(),
    })).rejects.toThrow('实体稿待发布')
    expect(finalizationClient.commitFinalizationSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ content: '编辑器冻结正文', contentRevision: 8 }),
    )
  })

  it('rejects an architecture checkpoint write reported as success=false', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'fs:write-json') return { success: false, error: 'checkpoint rejected' }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)

    await expect(savePartialData(
      PROJECT_PATH,
      { premise_result: 'premise' },
      context().projectSession!,
      '保存架构生成检查点',
    ))
      .rejects.toThrow('checkpoint rejected')
  })

  it.each([
    ['保存架构生成检查点', '保存架构生成检查点失败'],
    ['Save architecture-generation checkpoint', 'Failed to save the architecture-generation checkpoint.'],
  ])('uses the explicit architecture checkpoint fallback when IPC omits an error: %s', async (operationLabel, fallbackMessage) => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'fs:write-json') return { success: false }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)

    await expect(savePartialData(
      PROJECT_PATH,
      { premise_result: 'premise' },
      context().projectSession!,
      operationLabel,
      fallbackMessage,
    )).rejects.toThrow(fallbackMessage)
  })

  it('stops finalization when the atomic SQLite commit reports success=false', async () => {
    finalizationClient.commitFinalizationSnapshot.mockResolvedValue({
      success: false,
      committed: false,
      error: 'atomic finalization rejected',
    })
    const command = new FinalizeChapterCommand({
      draftPath: 'vela://draft/1',
      draftContent: '旧参数正文不得被读取',
      chapterNumber: 1,
      chapterInfo: chapterInfo(),
      snapshot: Object.freeze({
        tabId: 'draft-1',
        projectPath: PROJECT_PATH,
        projectSession: Object.freeze({
          projectId: 'A',
          leaseId: 'lease-A',
          projectPath: PROJECT_PATH,
        }),
        draftId: 1,
        chapterNumber: 1,
        chapterTitle: '第一章',
        content: '编辑器冻结正文',
        contentRevision: 8,
      }),
    })
    const stepCallbacks = callbacks()

    await expect(command.execute({
      step: {},
      context: context(),
      callbacks: stepCallbacks,
    })).rejects.toThrow('atomic finalization rejected')
    expect(finalizationClient.commitFinalizationSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ content: '编辑器冻结正文', contentRevision: 8 }),
    )
    expect(stepCallbacks.log).not.toHaveBeenCalledWith(expect.stringContaining('发布实体稿'))
  })

  it('stops the chapter-notes post-process step when blueprint persistence fails', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:blueprint-update-notes') {
        return { success: false, error: 'notes rejected' }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.('章节要点', undefined, 'stop')
        return 'request-1'
      }),
    })
    const step = buildFinalizePostProcessSteps(
      { path: PROJECT_PATH },
      1,
      '第一章',
      '正文',
      testPostProcessGeneration(),
    ).find(candidate => candidate.key === 'chapter_notes')
    expect(step).toBeDefined()
    const stepCallbacks = callbacks()

    await expect(step!.executor(stepCallbacks, context()))
      .rejects.toThrow('notes rejected')
    expect(stepCallbacks.log).not.toHaveBeenCalledWith(expect.stringContaining('剧情要点提取完成'))
  })

  it('persists finalized continuity when the author chapter has no blueprint', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:continuity-save-finalized') return { success: true }
      if (channel === 'db:blueprint-update-notes') return { success: true, updated: false }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.('作者原稿的连续性事实', undefined, 'stop')
        return 'request-1'
      }),
    })
    const step = buildFinalizePostProcessSteps(
      { path: PROJECT_PATH },
      1,
      '第一章',
      '作者正文',
      testPostProcessGeneration(),
      41,
    ).find(candidate => candidate.key === 'chapter_notes')

    const stepCallbacks = callbacks()
    await expect(step!.executor(stepCallbacks, context())).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith(
      'db:continuity-save-finalized',
      {
        draftId: 41,
        chapterNumber: 1,
        chapterNotes: '作者原稿的连续性事实',
        facts: [{
          category: 'plot',
          entities: [],
          statement: '作者原稿的连续性事实',
          sourceChapter: 1,
          evidence: '作者正文',
        }],
      },
      PROJECT_PATH,
      expect.objectContaining({ projectId: 'A', leaseId: 'lease-A' }),
    )
    expect(stepCallbacks.log).toHaveBeenCalledWith('已投影连续性事实：1 条')
  })

  it('records the finalized knowledge document identity before marking import complete', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'kb:import-text') {
        return { success: true, docId: 'knowledge-document-41', chunkCount: 1 }
      }
      if (channel === 'db:finalization-link-knowledge-document') {
        return { success: true, finalization: { knowledgeDocumentId: 'knowledge-document-41' } }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    const step = buildFinalizePostProcessSteps(
      { path: PROJECT_PATH },
      1,
      '第一章',
      '正文',
      testPostProcessGeneration(),
      41,
    ).find(candidate => candidate.key === 'kb_import')

    await expect(step!.executor(callbacks(), context())).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith(
      'db:finalization-link-knowledge-document',
      41,
      'knowledge-document-41',
      PROJECT_PATH,
      expect.objectContaining({ projectId: 'A', leaseId: 'lease-A' }),
    )
  })

  it('uses an English knowledge-document prefix without rewriting mixed UTF-8 chapter facts', async () => {
    const chapterTitle = 'Night Café 夜航'
    const draftContent = 'The sign reads “夜航 Café” — déjà vu.'
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'kb:import-text') {
        return { success: true, docId: 'knowledge-document-utf8', chunkCount: 1 }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    const step = buildFinalizePostProcessSteps(
      { path: PROJECT_PATH },
      1,
      chapterTitle,
      draftContent,
      testPostProcessGeneration(),
    ).find(candidate => candidate.key === 'kb_import')

    await expect(step!.executor(callbacks(), {
      ...context(),
      writingLanguage: 'en-US',
    })).resolves.toBeUndefined()

    expect(invoke).toHaveBeenCalledWith(
      'kb:import-text',
      draftContent,
      `Chapter 1 ${chapterTitle}.txt`,
      PROJECT_PATH,
      expect.objectContaining({ projectId: 'A', leaseId: 'lease-A' }),
    )
  })

  it('records a length-limited chapter-notes step as failed with zero writes, then retries it successfully', async () => {
    let runCreated = false
    let stepState: 'new' | 'failed' | 'ok' = 'new'
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'db:post-process-get-latest-run':
          return runCreated
            ? {
                id: 'run-1',
                sourceLabel: '第1章定稿',
                allCriticalPassed: stepState === 'ok',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              }
            : null
        case 'db:post-process-create-run':
          runCreated = true
          return { success: true, id: 'run-1' }
        case 'db:post-process-get-steps':
          if (stepState === 'new') return []
          return [{
            id: 1,
            runId: 'run-1',
            stepKey: 'chapter_notes',
            label: '章节剧情要点',
            critical: true,
            ok: stepState === 'ok',
            errorMsg: stepState === 'failed' ? 'AI 输出达到模型最大长度，结果不完整。' : '',
            attemptCount: stepState === 'ok' ? 2 : 1,
            completedAt: stepState === 'ok' ? '2026-01-01T00:00:00.000Z' : '',
            lastAttemptAt: '2026-01-01T00:00:00.000Z',
          }]
        case 'db:post-process-mark-step-failed':
          stepState = 'failed'
          return { success: true }
        case 'db:post-process-mark-step-ok':
          stepState = 'ok'
          return { success: true }
        case 'db:blueprint-update-notes':
          return { success: true }
        default:
          throw new Error(`unexpected IPC: ${channel}`)
      }
    })
    stubVelaIpc(invoke)
    const generateStream = vi.fn(async (
      _messages: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[0],
      streamCallbacks: Parameters<ReturnType<typeof useLLMStore.getState>['generateStream']>[1],
    ) => {
      const isFirstAttempt = generateStream.mock.calls.length === 1
      streamCallbacks.onDone?.(
        isFirstAttempt ? '半截章节要点' : '完整章节要点',
        undefined,
        isFirstAttempt ? 'length' : 'stop',
      )
      return `request-${generateStream.mock.calls.length}`
    })
    useLLMStore.setState({ defaultModelId: 'model', generateStream })
    const chapterNotes = buildFinalizePostProcessSteps(
      { path: PROJECT_PATH },
      1,
      '第一章',
      '正文',
      testPostProcessGeneration(),
    ).find(candidate => candidate.key === 'chapter_notes')
    expect(chapterNotes).toBeDefined()
    const stepCallbacks = callbacks()
    const workflowContext = context()
    const options = {
      retryCount: 0,
      stopOnFailure: true,
      cancellation: workflowContext,
      projectSession: workflowContext.projectSession,
    }

    await expect(runPostProcessPipeline(
      PROJECT_PATH,
      'chapter_1_finalize',
      '第1章定稿',
      [chapterNotes!],
      stepCallbacks,
      options,
    )).rejects.toThrow('后处理步骤失败：章节剧情要点')

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-update-notes')
    expect(invoke).toHaveBeenCalledWith(
      'db:post-process-mark-step-failed',
      'run-1',
      'chapter_notes',
      expect.stringContaining('输出达到模型最大长度'),
      PROJECT_PATH,
      workflowContext.projectSession,
    )

    await expect(runPostProcessPipeline(
      PROJECT_PATH,
      'chapter_1_finalize',
      '第1章定稿',
      [chapterNotes!],
      stepCallbacks,
      { ...options, onlyFailed: true },
    )).resolves.toMatchObject({ allCriticalPassed: true })

    expect(generateStream).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-update-notes')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith(
      'db:post-process-mark-step-ok',
      'run-1',
      'chapter_notes',
      PROJECT_PATH,
      workflowContext.projectSession,
    )
  })

  it('does not commit character-state changes when the post-process stream is length-truncated', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:character-roster-read') {
        return {
          status: 'ready',
          revision: 4,
          entries: [{ name: '林岚', role: 'protagonist', currentState: {} }],
        }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.('{"updates":[', undefined, 'length')
        return 'request-1'
      }),
    })
    const step = buildFinalizePostProcessSteps(
      { path: PROJECT_PATH },
      1,
      '第一章',
      '正文',
      testPostProcessGeneration(),
    ).find(candidate => candidate.key === 'character_cards')
    expect(step).toBeDefined()

    await expect(step!.executor(callbacks(), context()))
      .rejects.toThrow('AI 输出达到模型最大长度')
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['db:character-roster-read'])
  })

  it('stops character-card post-processing when its one roster receipt reports failure', async () => {
    const allCharacters = [{ name: '林岚', role: 'protagonist', currentState: {} }]
    const llmResponse = JSON.stringify({
      updates: [{ name: '林岚', currentState: { location: '车站' } }],
      newCharacters: [],
    })
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:character-roster-read') {
        return { status: 'ready', revision: 4, entries: allCharacters }
      }
      if (channel === 'db:character-roster-commit') {
        return { success: false, error: 'roster receipt rejected' }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        streamCallbacks.onDone?.(llmResponse, undefined, 'stop')
        return 'request-1'
      }),
    })
    const step = buildFinalizePostProcessSteps(
      { path: PROJECT_PATH },
      1,
      '第一章',
      '正文',
      testPostProcessGeneration(),
    ).find(candidate => candidate.key === 'character_cards')
    expect(step).toBeDefined()
    const stepCallbacks = callbacks()

    await expect(step!.executor(stepCallbacks, context()))
      .rejects.toThrow('roster receipt rejected')
    expect(stepCallbacks.log).not.toHaveBeenCalledWith(expect.stringContaining('自动提取并登记'))
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'db:character-roster-read',
      'db:character-roster-commit',
    ])
  })

  it('does not persist post-process output when the stream omits terminal evidence', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:blueprint-update-notes') return { success: true }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    useLLMStore.setState({
      defaultModelId: 'model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        const legacyOnDone = streamCallbacks.onDone as ((text: string) => void) | undefined
        legacyOnDone?.('看似完整但无终止证据')
        return 'request-1'
      }),
    })
    const step = buildFinalizePostProcessSteps(
      { path: PROJECT_PATH },
      1,
      '第一章',
      '正文',
      testPostProcessGeneration(),
    ).find(candidate => candidate.key === 'chapter_notes')

    await expect(step!.executor(callbacks(), context()))
      .rejects.toThrow('AI 未正常完成生成')
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['ordinary refinement', () => new RefineDraftCommand({
      draftPath: 'vela://draft/1',
      draftContent: '原稿',
      chapterNumber: 1,
      chapterInfo: chapterInfo(),
    })],
    ['review refinement', () => new RefineFromReviewCommand({
      draftPath: 'vela://draft/1',
      draftContent: '原稿',
      confirmedReviewContent: CONFIRMED_REVIEW_CONTENT,
      reviewSourceId: 7,
      chapterNumber: 1,
    })],
  ])('does not open a diff when %s revision creation fails', async (_label, makeCommand) => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:draft-get-meta') {
        return { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write' }
      }
      if (channel === 'db:review-get-full') {
        return { id: 7, baseDraftId: 1, content: CONFIRMED_REVIEW_CONTENT }
      }
      if (channel === 'db:revision-get-pending') return []
      if (channel === 'db:revision-create' || channel === 'db:revision-replace-pending') {
        return { success: false, error: 'revision rejected' }
      }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    const command = makeCommand()
    stubLlm(command, '修订正文')

    await expect(command.execute({
      step: {},
      context: context(),
      callbacks: callbacks(),
    })).rejects.toThrow('revision rejected')
    expect(useEditorStore.getState().tabs).toEqual([])
  })

  it('does not open a review report when review persistence fails', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'kb:search') return []
      if (channel === 'db:character-get-all') return []
      if (channel === 'db:project-core-get') return {}
      if (channel === 'db:draft-get-meta') {
        return { id: 1, chapterNumber: 1, version: 1, status: 'draft', source: 'write' }
      }
      if (channel === 'db:review-next-index') return 1
      if (channel === 'db:review-create') return { success: false, error: 'review rejected' }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    stubVelaIpc(invoke)
    const command = new ReviewChapterCommand({
      draftPath: 'vela://draft/1',
      draftContent: '待审正文',
      chapterNumber: 1,
    })
    stubLlm(command, '{"summary":"ok","items":[]}')

    await expect(command.execute({
      step: {},
      context: context(),
      callbacks: callbacks(),
    })).rejects.toThrow('review rejected')
    expect(useEditorStore.getState().tabs).toEqual([])
  })
})
