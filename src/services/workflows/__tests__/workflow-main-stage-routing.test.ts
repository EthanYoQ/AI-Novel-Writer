import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainGenerationRunView } from '../../generation/generation-runtime'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { WorkflowContext, WorkflowRun } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { createWorkflowMainGenerationRuntime, type WorkflowMainGenerationSelection } from '../workflow-main-generation'
import type { createMainGenerationTransport } from '../../generation/main-generation-transport'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../ipc-client', () => ({ ipc: { invokeWithProjectSession: mocks.invoke } }))

const session: ProjectSessionContext = { projectId: 'novel', leaseId: 'lease', projectPath: 'C:/novel' }
const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
const view: MainGenerationRunView = { handle, budget: { maxAttempts: 1, maxRequestedOutputTokens: 100, maxRequestedOutputTokensPerAttempt: 100, deadlineAt: 1000 }, status: 'running', nonReplayable: false, artifacts: [] }
const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
const review: WorkflowMainGenerationSelection = { operation: 'review-chapter', chapterNumber: 1, promptKeys: [], skillStages: [], output: 'structured-data' }
const originalLLM = useLLMStore.getState()
const originalWorkflow = useWorkflowStore.getState()

function transport(overrides: Record<string, unknown> = {}) {
  const begin = vi.fn<(session: ProjectSessionContext, request: { modelId: string }) => Promise<MainGenerationRunView>>(async () => view)
  return { begin, value: { begin, pause: vi.fn(async () => view), read: vi.fn(async () => view), subscribe: vi.fn(() => () => {}), ...overrides } as unknown as ReturnType<typeof createMainGenerationTransport> }
}

function context(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return { runId: 'workflow', projectPath: session.projectPath, projectSession: session, writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false, ...overrides }
}

function run(): WorkflowRun | undefined {
  return useWorkflowStore.getState().activeRuns.find(candidate => candidate.id === 'workflow')
}

async function open(workflowContext: WorkflowContext, selection: WorkflowMainGenerationSelection, mainTransport: ReturnType<typeof transport>['value']) {
  const runtime = await createWorkflowMainGenerationRuntime({ context: workflowContext, callbacks, selection }, mainTransport)
  await runtime.close()
}

beforeEach(() => {
  useLLMStore.setState({
    models: [
      { id: 'writer', name: 'Writer', purposes: ['generation'] },
      { id: 'reviewer', name: 'Reviewer', purposes: ['generation'] },
      { id: 'embedder', name: 'Embedder', purposes: ['embedding'] },
    ] as never,
    defaultModelId: 'writer',
    stageModelIds: { review: 'reviewer', planning: 'reviewer' },
  })
  useWorkflowStore.setState({ activeRuns: [{ id: 'workflow', status: 'running' } as WorkflowRun] })
})

afterEach(() => {
  vi.restoreAllMocks()
  useLLMStore.setState(originalLLM, true)
  useWorkflowStore.setState(originalWorkflow, true)
})

describe('stage routing at the workflow generation seam', () => {
  it('begins a workflow without an explicit model on its stage model and records it on the run', async () => {
    const main = transport()
    const workflowContext = context()
    await open(workflowContext, review, main.value)
    expect(main.begin.mock.calls[0]?.[1].modelId).toBe('reviewer')
    expect(workflowContext.generationModelId).toBe('reviewer')
    expect(run()?.generationModelId).toBe('reviewer')
  })

  it('routes planning operations to the planning model', async () => {
    const main = transport()
    await open(context(), { operation: 'chapter-blueprint-directory', promptKeys: [], skillStages: [], output: 'structured-data' }, main.value)
    expect(main.begin.mock.calls[0]?.[1].modelId).toBe('reviewer')
  })

  it('keeps a model the author or a same-model rule already chose', async () => {
    const main = transport()
    await open(context({ generationModelId: 'writer' }), review, main.value)
    expect(main.begin.mock.calls[0]?.[1].modelId).toBe('writer')
  })

  it('keeps later steps of the same workflow on the pinned model after the mapping changes', async () => {
    const main = transport()
    const workflowContext = context()
    const runtime = await createWorkflowMainGenerationRuntime({ context: workflowContext, callbacks, selection: review }, main.value)
    useLLMStore.setState({ stageModelIds: { review: 'writer' } })
    await runtime.advance({ ...review, chapterNumber: 2 })
    await runtime.close()
    await open(workflowContext, { ...review, chapterNumber: 3 }, main.value)
    expect(main.begin.mock.calls.map(([, request]) => request.modelId)).toEqual(['reviewer', 'reviewer', 'reviewer'])
  })

  it('resumes a stored run on the model main froze for it and records that model, not the mapping', async () => {
    useLLMStore.setState({ stageModelIds: { review: 'writer' } })
    mocks.invoke.mockImplementation(async (_session: unknown, channel: string) => channel === 'generation:read-context' ? { modelId: 'reviewer' } : undefined)
    const main = transport({ read: vi.fn(async () => ({ ...view, nonReplayable: true })), resume: vi.fn(async () => view) })
    const workflowContext = context()
    await open(workflowContext, { ...review, resumeHandle: handle }, main.value)
    expect(main.begin).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith(session, 'generation:read-context', { handle })
    expect(workflowContext.generationModelId).toBe('reviewer')
    expect(run()?.generationModelId).toBe('reviewer')
  })

  it('keeps a later step of a resumed runtime on the resumed model instead of the mapping', async () => {
    useLLMStore.setState({ stageModelIds: { review: 'writer' } })
    mocks.invoke.mockImplementation(async (_session: unknown, channel: string) => channel === 'generation:read-context' ? { modelId: 'reviewer' } : undefined)
    const main = transport({ read: vi.fn(async () => ({ ...view, nonReplayable: true })), resume: vi.fn(async () => view) })
    const runtime = await createWorkflowMainGenerationRuntime({ context: context(), callbacks, selection: { ...review, resumeHandle: handle } }, main.value)
    await runtime.advance({ ...review, chapterNumber: 2 })
    await runtime.close()
    expect(main.begin.mock.calls.map(([, request]) => request.modelId)).toEqual(['reviewer'])
  })

  it('reopens a replayable stored run on its stored model, records it, and does not resume it', async () => {
    useLLMStore.setState({ stageModelIds: { review: 'writer' } })
    mocks.invoke.mockImplementation(async (_session: unknown, channel: string) => channel === 'generation:read-context' ? { modelId: 'reviewer' } : undefined)
    const resume = vi.fn(async () => view)
    const main = transport({ resume })
    const workflowContext = context()
    const runtime = await createWorkflowMainGenerationRuntime({ context: workflowContext, callbacks, selection: { ...review, resumeHandle: handle } }, main.value)
    await runtime.advance({ ...review, chapterNumber: 2 })
    await runtime.close()
    expect(resume).not.toHaveBeenCalled()
    expect(run()?.generationModelId).toBe('reviewer')
    expect(main.begin.mock.calls.map(([, request]) => request.modelId)).toEqual(['reviewer'])
  })

  it.each(['begin', 'navigation'] as const)('leaves nothing pinned when %s fails, so a retry routes again', async failure => {
    const main = transport(failure === 'begin' ? { begin: vi.fn(async () => { throw new Error('main refused') }) } : {})
    const workflowContext = context()
    await expect(createWorkflowMainGenerationRuntime({ context: workflowContext, callbacks,
      selection: { ...review, onRunOpened: async () => { throw new Error('navigation failed') } } }, main.value)).rejects.toThrow()
    expect(workflowContext.generationModelId).toBeUndefined()
    expect(run()?.generationModelId).toBeUndefined()
  })

  it.each([
    ['an embedding-only model', 'embedder'],
    ['a deleted model', 'gone'],
  ])('never sends the request to %s left in the mapping', async (_label, assigned) => {
    useLLMStore.setState({ stageModelIds: { review: assigned } })
    const main = transport()
    await open(context(), review, main.value)
    expect(main.begin.mock.calls[0]?.[1].modelId).toBe('writer')
  })

  it('refuses to start instead of picking some other model when neither the stage nor the default model is usable', async () => {
    useLLMStore.setState({ defaultModelId: 'gone', stageModelIds: { review: 'embedder' } })
    const main = transport()
    await expect(createWorkflowMainGenerationRuntime({ context: context(), callbacks, selection: review }, main.value)).rejects.toThrow('GENERATION_MODEL_REQUIRED')
    expect(main.begin).not.toHaveBeenCalled()
  })
})

describe('recording the pinned model on the run', () => {
  it('shows the model the run is using now when a later stage switches models', () => {
    useWorkflowStore.getState().recordRunGenerationModel('workflow', 'writer')
    useWorkflowStore.getState().recordRunGenerationModel('workflow', 'reviewer')
    expect(run()?.generationModelId).toBe('reviewer')
  })
})
