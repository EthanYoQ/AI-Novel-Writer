import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createBatchChapterWorkflow,
  MAX_BATCH_CHAPTERS,
  MIN_BATCH_CHAPTERS,
  normalizeBatchChapterCount,
  type BatchChapterWorkflowParams,
} from '../batch-chapter-workflow'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, type WorkflowContext } from '../../../stores/workflow-store'

const doubles = vi.hoisted(() => ({
  guardChapterWriting: vi.fn(),
  invokeWithProjectSession: vi.fn(),
  generateDraftExecute: vi.fn(),
  finalizeChapterExecute: vi.fn(),
  finalizeChapterParams: [] as unknown[],
}))

vi.mock('../../workflow-guards', () => ({
  guardChapterWriting: doubles.guardChapterWriting,
}))

vi.mock('../../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: doubles.invokeWithProjectSession,
  },
}))

vi.mock('../commands/generate-draft.command', () => ({
  GenerateDraftCommand: class {
    execute = doubles.generateDraftExecute
  },
}))

vi.mock('../commands/finalize-chapter.command', () => ({
  FinalizeChapterCommand: class {
    constructor(params: unknown) {
      doubles.finalizeChapterParams.push(params)
    }

    execute = doubles.finalizeChapterExecute
  },
}))

const projectPath = 'C:\\test-project'

function projectSession() {
  return {
    projectId: 'test-project',
    leaseId: 'lease-test-project',
    projectPath,
  }
}

function resetWorkflowState() {
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
  useProjectStore.setState({
    currentProject: {
      id: 'test-project',
      name: 'Test project',
      path: projectPath,
      sessionLease: 'lease-test-project',
      novelConfig: {},
    } as never,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  doubles.finalizeChapterParams.length = 0
  resetWorkflowState()
  doubles.guardChapterWriting.mockResolvedValue({ ok: true })
  doubles.invokeWithProjectSession.mockImplementation(async (
    _session: unknown,
    channel: string,
    ...args: unknown[]
  ) => {
    if (channel === 'db:blueprint-get') {
      const chapterNumber = Number(args[0])
      return {
        chapterNumber,
        title: `Chapter ${chapterNumber}`,
        role: 'development',
      }
    }
    if (channel === 'db:draft-get-latest') return null
    throw new Error(`Unexpected IPC channel in batch workflow test: ${channel}`)
  })
  doubles.generateDraftExecute.mockImplementation(async ({ context }: { context: WorkflowContext }) => {
    context.data.draftPath = `draft-${context.runId}`
    return 'generated draft'
  })
  doubles.finalizeChapterExecute.mockResolvedValue(undefined)
})

describe('batch chapter workflow limits', () => {
  it.each([
    [undefined, MIN_BATCH_CHAPTERS],
    [0, MIN_BATCH_CHAPTERS],
    [-3, MIN_BATCH_CHAPTERS],
    [1, 1],
    ['4', 4],
    [MAX_BATCH_CHAPTERS, MAX_BATCH_CHAPTERS],
    [MAX_BATCH_CHAPTERS + 1, MAX_BATCH_CHAPTERS],
  ])('normalizes %p to the safe chapter count %p', (input, expected) => {
    expect(normalizeBatchChapterCount(input)).toBe(expected)
  })

  it('creates one complete chapter step per requested chapter and caps the count at ten', () => {
    const workflow = createBatchChapterWorkflow({
      projectPath: 'C:\\test-project',
      projectSession: {
        projectId: 'test-project',
        leaseId: 'lease-test-project',
        projectPath: 'C:\\test-project',
      },
      startChapterNumber: 4,
      chapterCount: 99,
      completionMode: 'auto_finalize',
    })

    expect(workflow.type).toBe('batch_generate')
    expect(workflow.steps).toHaveLength(MAX_BATCH_CHAPTERS)
    expect(workflow.steps[0]).toMatchObject({ name: '第4章：自动定稿与后处理' })
    expect(workflow.steps[MAX_BATCH_CHAPTERS - 1]).toMatchObject({ name: '第13章：自动定稿与后处理' })
    expect(workflow.steps.every((step) => step.description.includes('后处理失败立即停止'))).toBe(true)
  })
})

describe('batch chapter workflow generation model selection', () => {
  it('freezes a selected Grok model into the definition and every draft command context', async () => {
    const params = {
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 2,
      generationModelId: '  grok-selected-model  ',
      completionMode: 'auto_finalize',
    } satisfies BatchChapterWorkflowParams
    const workflow = createBatchChapterWorkflow(params)

    expect(workflow.generationModelId).toBe('grok-selected-model')
    params.generationModelId = 'glm-default-model'
    expect(workflow.generationModelId).toBe('grok-selected-model')

    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(doubles.generateDraftExecute).toHaveBeenCalledTimes(2)
    expect(doubles.generateDraftExecute.mock.calls.map(([args]) => (
      (args as { context: WorkflowContext }).context.generationModelId
    ))).toEqual(['grok-selected-model', 'grok-selected-model'])
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      generationModelId: 'grok-selected-model',
      status: 'completed',
    })
  })

  it('leaves the generation model unset so the draft command retains its default-model fallback', async () => {
    const workflow = createBatchChapterWorkflow({
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 1,
      completionMode: 'auto_finalize',
    })

    expect(workflow).not.toHaveProperty('generationModelId')
    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(doubles.generateDraftExecute).toHaveBeenCalledTimes(1)
    expect((doubles.generateDraftExecute.mock.calls[0][0] as { context: WorkflowContext })
      .context.generationModelId).toBeUndefined()
    expect(useWorkflowStore.getState().history[0]).not.toHaveProperty('generationModelId')
  })
})

describe('batch chapter workflow completion mode', () => {
  it('freezes draft-review mode for every chapter when caller settings change mid-run', async () => {
    const callerSettings = {
      completionMode: 'draft_review' as 'draft_review' | 'auto_finalize',
      locale: 'en-US' as 'zh-CN' | 'en-US',
    }
    const workflow = createBatchChapterWorkflow({
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 2,
      generationModelId: 'grok-selected-model',
      completionMode: callerSettings.completionMode,
      locale: callerSettings.locale,
    } satisfies BatchChapterWorkflowParams)

    doubles.generateDraftExecute.mockImplementation(async ({ context }: { context: WorkflowContext }) => {
      context.data.draftPath = `draft-${context.runId}`
      callerSettings.completionMode = 'auto_finalize'
      callerSettings.locale = 'zh-CN'
      return 'generated draft'
    })

    expect(workflow).toMatchObject({
      completionMode: 'draft_review',
      generationModelId: 'grok-selected-model',
    })

    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(doubles.generateDraftExecute).toHaveBeenCalledTimes(2)
    expect(doubles.finalizeChapterParams).toEqual([])
    expect(doubles.finalizeChapterExecute).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      status: 'completed',
      steps: [
        {
          name: 'Chapter 1: generate review draft',
          result: 'Chapter 1 draft was generated and saved for review.',
          logs: [expect.stringContaining('Starting Chapter 1: generate a review draft.')],
        },
        {
          name: 'Chapter 2: generate review draft',
          result: 'Chapter 2 draft was generated and saved for review.',
          logs: [expect.stringContaining('Starting Chapter 2: generate a review draft.')],
        },
      ],
    })
  })

  it('reports workflow guard failures in the frozen English UI locale', async () => {
    doubles.guardChapterWriting.mockResolvedValue({
      ok: false,
      message: '中文门禁详情',
    })
    const workflow = createBatchChapterWorkflow({
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 1,
      completionMode: 'draft_review',
      locale: 'en-US',
    })

    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      status: 'failed',
      error: 'Chapter 1 does not meet the writing prerequisites.',
    })
    expect(doubles.generateDraftExecute).not.toHaveBeenCalled()
  })

  it('continues later review drafts without treating an earlier batch draft as finalized', async () => {
    doubles.guardChapterWriting.mockImplementation(async (chapterNumber?: number) => (
      chapterNumber === 2
        ? { ok: false, message: 'Chapter 1 is not finalized' }
        : { ok: true }
    ))
    const workflow = createBatchChapterWorkflow({
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 2,
      completionMode: 'draft_review',
    })

    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(useWorkflowStore.getState().history[0]).toMatchObject({ status: 'completed' })
    expect(doubles.generateDraftExecute).toHaveBeenCalledTimes(2)
    expect(doubles.finalizeChapterExecute).not.toHaveBeenCalled()
  })

  it('keeps auto-finalize failure-stop semantics and does not start a later chapter', async () => {
    doubles.finalizeChapterExecute
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('post-process failed'))
    const workflow = createBatchChapterWorkflow({
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 3,
      completionMode: 'auto_finalize',
      locale: 'en-US',
    })

    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(doubles.generateDraftExecute).toHaveBeenCalledTimes(2)
    expect(doubles.finalizeChapterExecute).toHaveBeenCalledTimes(2)
    expect(doubles.finalizeChapterParams).toEqual([
      expect.objectContaining({ stopOnPostProcessFailure: true, eventSource: 'batch' }),
      expect.objectContaining({ stopOnPostProcessFailure: true, eventSource: 'batch' }),
    ])
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      status: 'failed',
      error: 'post-process failed',
      steps: [
        expect.objectContaining({ status: 'completed' }),
        expect.objectContaining({ status: 'failed' }),
        expect.objectContaining({ status: 'pending' }),
      ],
    })
  })

  it('stops with an English error if a later blueprint disappears before execution', async () => {
    doubles.invokeWithProjectSession.mockImplementation(async (
      _session: unknown,
      channel: string,
      ...args: unknown[]
    ) => {
      if (channel === 'db:blueprint-get') {
        const chapterNumber = Number(args[0])
        return chapterNumber === 2
          ? null
          : { chapterNumber, title: `Chapter ${chapterNumber}`, role: 'development' }
      }
      if (channel === 'db:draft-get-latest') return null
      throw new Error(`Unexpected IPC channel in batch workflow test: ${channel}`)
    })
    const workflow = createBatchChapterWorkflow({
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 2,
      completionMode: 'draft_review',
      locale: 'en-US',
    })

    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(doubles.generateDraftExecute).toHaveBeenCalledOnce()
    expect(doubles.finalizeChapterExecute).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      status: 'failed',
      error: 'No blueprint was found for Chapter 2. Batch writing stopped.',
    })
  })
})
