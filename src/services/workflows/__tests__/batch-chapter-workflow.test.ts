import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

import {
  createBatchChapterWorkflow,
  MAX_BATCH_CHAPTERS,
  MIN_BATCH_CHAPTERS,
  normalizeBatchChapterCount,
  type BatchChapterWorkflowParams,
} from '../batch-chapter-workflow'
import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useWorkflowStore, type WorkflowContext } from '../../../stores/workflow-store'
import type { GenerationBatchProgress, BeginGenerationBatchRequest } from '../../../shared/generation-owner-contract'

const doubles = vi.hoisted(() => ({
  batch: null as GenerationBatchProgress | null,
  guardChapterWriting: vi.fn(),
  invokeWithProjectSession: vi.fn(),
  generateDraftExecute: vi.fn(),
  finalizeChapterExecute: vi.fn(),
  retryPublication: vi.fn(),
  repairPostProcess: vi.fn(),
  finalizeChapterParams: [] as unknown[],
  generateDraftChapterInfos: [] as Array<{ chapterNumber: number; wordsTarget?: number }>,
  generateDraftOptions: [] as Array<{ selectedCandidateDrafts?: Array<Record<string, unknown>> }>,
}))

vi.mock('../../workflow-guards', () => ({
  guardChapterWriting: doubles.guardChapterWriting,
}))

vi.mock('../../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: async (context: unknown, channel: string, ...args: unknown[]) => {
      if (channel === 'fs:check-exists') return false
      if (channel === 'generation:begin-batch') {
        const input = args[0] as BeginGenerationBatchRequest
        doubles.batch = { ...input, batchId: '合成批次', rootHandle: { projectId: 'test-project', epoch: 'lease-test-project', rootActionId: '合成根', runId: '合成批次' },
          completedChapters: [], nextChapterNumber: input.range.startChapter }
        return structuredClone(doubles.batch)
      }
      if (channel === 'generation:read-batch' || channel === 'generation:confirm-batch-finalization') return structuredClone(doubles.batch)
      if (channel === 'db:draft-get-full') {
        const item = doubles.batch?.completedChapters.find(item => item.draftId === args[0])
        if (item) return { ...item, id: item.draftId, content: 'generated draft' }
      }
      return doubles.invokeWithProjectSession(context, channel, ...args)
    },
  },
}))

vi.mock('../commands/generate-draft.command', () => ({
  previousChapterEnding: (content: string) => content.slice(-1000),
  GenerateDraftCommand: class {
    chapterNumber: number
    constructor(
      chapterInfo: { chapterNumber: number; wordsTarget?: number },
      options: { selectedCandidateDrafts?: Array<Record<string, unknown>> },
    ) {
      this.chapterNumber = chapterInfo.chapterNumber
      doubles.generateDraftChapterInfos.push(chapterInfo)
      doubles.generateDraftOptions.push(options)
    }

    execute = async (params: { context: WorkflowContext }) => {
      const result = await doubles.generateDraftExecute(params)
      const batch = doubles.batch!
      batch.completedChapters.push({ chapterNumber: this.chapterNumber, draftId: Number(params.context.data.draftId),
        version: Number(params.context.data.draftVersion), contentHash: createHash('sha256').update(result).digest('hex'), sourceRunHandle: batch.rootHandle })
      if (batch.mode === 'draft_review') batch.nextChapterNumber = this.chapterNumber === batch.range.endChapter ? null : this.chapterNumber + 1
      return result
    }
  },
}))

vi.mock('../commands/finalize-chapter.command', () => ({
  RunFinalizePostProcessCommand: class {
    execute = async (params: unknown) => {
      await doubles.repairPostProcess(params)
      const batch = doubles.batch!
      const item = batch.completedChapters.find(item => item.chapterNumber === batch.nextChapterNumber)!
      item.finalizationId = item.pendingFinalizationId
      item.pendingFinalizationId = undefined
      item.postProcessComplete = true
      batch.nextChapterNumber = item.chapterNumber === batch.range.endChapter ? null : item.chapterNumber + 1
    }
  },
  FinalizeChapterCommand: class {
    chapterNumber: number
    constructor(params: unknown) {
      this.chapterNumber = (params as { chapterNumber: number }).chapterNumber
      doubles.finalizeChapterParams.push(params)
    }

    execute = async (params: unknown) => {
      const result = await doubles.finalizeChapterExecute(params)
      const batch = doubles.batch!
      const item = batch.completedChapters.find(item => item.chapterNumber === this.chapterNumber)!
      item.finalizationId = `定稿${this.chapterNumber}`
      batch.nextChapterNumber = this.chapterNumber === batch.range.endChapter ? null : this.chapterNumber + 1
      return result
    }
  },
}))
vi.mock('../../finalization-client', () => ({ retryFinalizationPublication: doubles.retryPublication }))

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
  doubles.batch = null
  vi.clearAllMocks()
  doubles.finalizeChapterParams.length = 0
  doubles.generateDraftChapterInfos.length = 0
  doubles.generateDraftOptions.length = 0
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
    context.data.draftId = 100 + doubles.generateDraftExecute.mock.calls.length
    context.data.draftVersion = 1
    return 'generated draft'
  })
  doubles.finalizeChapterExecute.mockResolvedValue(undefined)
  doubles.retryPublication.mockResolvedValue({ success: true })
  doubles.repairPostProcess.mockResolvedValue(undefined)
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
      generationModelId: 'batch-model',
      completionMode: 'auto_finalize',
    })

    expect(workflow.type).toBe('batch_generate')
    expect(workflow.resourceKeys).toEqual(expect.arrayContaining([
      'character-roster',
      'continuity',
      'chapter-summary',
    ]))
    expect(workflow.steps).toHaveLength(MAX_BATCH_CHAPTERS)
    expect(workflow.steps[0]).toMatchObject({ name: '第4章：自动定稿与后处理' })
    expect(workflow.steps[MAX_BATCH_CHAPTERS - 1]).toMatchObject({ name: '第13章：自动定稿与后处理' })
    expect(workflow.steps.every((step) => step.description.includes('后处理失败立即停止'))).toBe(true)
  })
})

describe('batch chapter workflow generation model selection', () => {
  it('freezes one per-chapter target into the definition and every draft command', async () => {
    const input = {
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 2,
      generationModelId: 'grok-selected-model',
      completionMode: 'draft_review' as const,
      chapterWordsTarget: 4200,
    }
    const workflow = createBatchChapterWorkflow(input)

    input.chapterWordsTarget = 9000
    expect(workflow).toMatchObject({
      chapterWordsTarget: 4200,
      resourceKeys: ['chapter:1', 'chapter:2'],
      readResourceKeys: ['novel-config', 'architecture', 'blueprints'],
    })

    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(doubles.generateDraftChapterInfos).toEqual([
      expect.objectContaining({ chapterNumber: 1, wordsTarget: 4200 }),
      expect.objectContaining({ chapterNumber: 2, wordsTarget: 4200 }),
    ])
  })

  it('freezes a selected Grok model into the definition and every draft command context when the default changes mid-run', async () => {
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

    useLLMStore.setState({ defaultModelId: 'default-before-run' })
    doubles.generateDraftExecute.mockImplementationOnce(async ({ context }: { context: WorkflowContext }) => {
      context.data.draftPath = `draft-${context.runId}`
      useLLMStore.setState({ defaultModelId: 'default-changed-mid-run' })
      return 'generated draft'
    })

    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(doubles.generateDraftExecute).toHaveBeenCalledTimes(2)
    expect(doubles.generateDraftExecute.mock.calls.map(([args]) => (
      (args as { context: WorkflowContext }).context.generationModelId
    ))).toEqual(['grok-selected-model', 'grok-selected-model'])
    expect(useLLMStore.getState().defaultModelId).toBe('default-changed-mid-run')
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      generationModelId: 'grok-selected-model',
      status: 'completed',
    })
  })

  it.each([
    ['zh-CN', '批量创作必须冻结一项可用的生成模型。'],
    ['en-US', 'Batch writing requires a frozen generation model.'],
  ] as const)('fails closed for an empty generation model in %s', (locale, expectedError) => {
    expect(() => createBatchChapterWorkflow({
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 1,
      generationModelId: '   ',
      completionMode: 'auto_finalize',
      locale,
    })).toThrow(expectedError)
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
      context.data.draftId = 100 + doubles.generateDraftExecute.mock.calls.length
      context.data.draftVersion = 1
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
      generationModelId: 'grok-selected-model',
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
      generationModelId: 'grok-selected-model',
      completionMode: 'draft_review',
    })

    await useWorkflowStore.getState().startWorkflow(workflow)

    expect(useWorkflowStore.getState().history[0]).toMatchObject({ status: 'completed' })
    expect(doubles.generateDraftExecute).toHaveBeenCalledTimes(2)
    expect(doubles.generateDraftOptions).toEqual([
      { batchId: '合成批次', selectedCandidateDrafts: [] },
      {
        batchId: '合成批次',
        selectedCandidateDrafts: [{
          chapterNumber: 1,
          draftId: 101,
          version: 1,
          content: 'generated draft',
        }],
      },
    ])
    expect(doubles.finalizeChapterExecute).not.toHaveBeenCalled()
  })

  it('第三章只显式选择同批第二章，不把更早候选扩大为前驱', async () => {
    const workflow = createBatchChapterWorkflow({
      projectPath,
      projectSession: projectSession(),
      startChapterNumber: 1,
      chapterCount: 3,
      generationModelId: 'grok-selected-model',
      completionMode: 'draft_review',
    })
    await useWorkflowStore.getState().startWorkflow(workflow)
    expect(useWorkflowStore.getState().history[0]).toMatchObject({ status: 'completed' })
    expect(doubles.generateDraftOptions.map(options => options.selectedCandidateDrafts?.map(candidate => candidate.chapterNumber))).toEqual([[], [1], [2]])
    expect(doubles.finalizeChapterExecute).not.toHaveBeenCalled()
  })

  it('重建工作流读取原批次进度，跳过已保存章并保持同一预算根', async () => {
    const original = doubles.generateDraftExecute.getMockImplementation()!
    doubles.generateDraftExecute.mockImplementationOnce(original).mockRejectedValueOnce(new Error('连接中断'))
    const params: BatchChapterWorkflowParams = { projectPath, projectSession: projectSession(), startChapterNumber: 1,
      chapterCount: 3, generationModelId: '原模型', completionMode: 'draft_review' }
    await useWorkflowStore.getState().startWorkflow(createBatchChapterWorkflow(params))
    expect(useWorkflowStore.getState().history[0].status).toBe('failed')
    const root = structuredClone(doubles.batch!.rootHandle)
    await useWorkflowStore.getState().startWorkflow(createBatchChapterWorkflow({ ...params, resumeBatchId: doubles.batch!.batchId }))
    expect(useWorkflowStore.getState().history[0].status).toBe('completed')
    expect(doubles.generateDraftChapterInfos.map(item => item.chapterNumber)).toEqual([1, 2, 2, 3])
    expect(doubles.batch!.rootHandle).toEqual(root)
    expect(doubles.batch!.completedChapters.map(item => item.chapterNumber)).toEqual([1, 2, 3])
  })

  it('定稿已提交但发布失败时只重试原outbox和后处理，不再生成或再次定稿', async () => {
    const root = { projectId: 'test-project', epoch: '原会话', rootActionId: '原预算根', runId: '原批次' }
    doubles.batch = { batchId: '原批次', modelId: '原模型', rootHandle: root, mode: 'auto_finalize', range: { startChapter: 1, endChapter: 1 },
      targetUnits: 2000, authorInputs: [], nextChapterNumber: 1,
      completedChapters: [{ chapterNumber: 1, draftId: 101, version: 1,
        contentHash: createHash('sha256').update('generated draft').digest('hex'), sourceRunHandle: root,
        pendingFinalizationId: '原定稿', postProcessComplete: false }] }
    const workflow = createBatchChapterWorkflow({ projectPath, projectSession: projectSession(), startChapterNumber: 1,
      chapterCount: 1, chapterWordsTarget: 2000, generationModelId: '原模型', completionMode: 'auto_finalize', resumeBatchId: '原批次' })
    await useWorkflowStore.getState().startWorkflow(workflow)
    expect(useWorkflowStore.getState().history[0].status).toBe('completed')
    expect(doubles.generateDraftExecute).not.toHaveBeenCalled()
    expect(doubles.finalizeChapterExecute).not.toHaveBeenCalled()
    expect(doubles.retryPublication).toHaveBeenCalledExactlyOnceWith('原定稿', projectSession())
    expect(doubles.repairPostProcess).toHaveBeenCalledOnce()
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
      generationModelId: 'grok-selected-model',
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
      generationModelId: 'grok-selected-model',
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
