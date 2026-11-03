import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  alertError: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invoke: mocks.invoke, get isElectron() { return true } },
}))

vi.mock('../../components/ui/AlertDialog', () => ({ alertError: mocks.alertError }))

import { useLLMStore } from '../llm-store'

const models = [
  { id: 'writer', name: 'Writer', purposes: ['generation'] },
  { id: 'reviewer', name: 'Reviewer', purposes: ['generation'] },
] as unknown as ReturnType<typeof useLLMStore.getState>['models']

beforeEach(() => {
  vi.clearAllMocks()
  useLLMStore.setState({ models: [], defaultModelId: null, defaultEmbeddingModelId: null, stageModelIds: {}, activeRequests: new Map(), loaded: false })
})

describe('stage model assignments in the model store', () => {
  it('loads the saved assignments together with the models and defaults', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => ({
      'llm:list-models': models,
      'llm:get-default-model': 'writer',
      'llm:get-default-embedding-model': null,
      'llm:get-stage-models': { review: 'reviewer' },
    })[channel])

    await useLLMStore.getState().init()

    expect(useLLMStore.getState()).toMatchObject({ loaded: true, defaultModelId: 'writer', stageModelIds: { review: 'reviewer' } })
  })

  it('keeps what main saved after a successful assignment', async () => {
    mocks.invoke.mockResolvedValue({ success: true, stageModelIds: { review: 'reviewer' } })

    await expect(useLLMStore.getState().setStageModel('review', 'reviewer')).resolves.toBe(true)

    expect(mocks.invoke).toHaveBeenCalledWith('llm:set-stage-model', { stage: 'review', modelId: 'reviewer' })
    expect(useLLMStore.getState().stageModelIds).toEqual({ review: 'reviewer' })
  })

  it('keeps the previous assignment and explains the failure when main refuses', async () => {
    useLLMStore.setState({ stageModelIds: { review: 'writer' } })
    mocks.invoke.mockResolvedValue({ success: false, error: 'Error: LLM_STAGE_MODEL_UNAVAILABLE' })

    await expect(useLLMStore.getState().setStageModel('review', 'reviewer')).resolves.toBe(false)

    expect(useLLMStore.getState().stageModelIds).toEqual({ review: 'writer' })
    expect(mocks.alertError).toHaveBeenCalledWith(expect.stringContaining('不能用于文本生成'), expect.anything())
  })

  it('takes the default and stage assignments that main cleared when a model is deleted', async () => {
    useLLMStore.setState({ models, defaultModelId: 'reviewer', stageModelIds: { review: 'reviewer', planning: 'writer' } })
    mocks.invoke.mockImplementation(async (channel: string) => channel === 'llm:list-models'
      ? [models[0]]
      : { success: true, defaultModelId: null, defaultEmbeddingModelId: null, stageModelIds: { planning: 'writer' } })

    await expect(useLLMStore.getState().deleteModel('reviewer')).resolves.toBe(true)

    expect(useLLMStore.getState()).toMatchObject({ models: [models[0]], defaultModelId: null, stageModelIds: { planning: 'writer' } })
  })

  it('keeps an assignment saved while the deletion was reloading the model list', async () => {
    useLLMStore.setState({ models, defaultModelId: 'writer', stageModelIds: { review: 'reviewer' } })
    let releaseList!: () => void
    const listHeld = new Promise<void>(resolve => { releaseList = resolve })
    mocks.invoke.mockImplementation(async (channel: string, request: unknown) => {
      if (channel === 'llm:delete-model') return { success: true, defaultModelId: 'writer', defaultEmbeddingModelId: null, stageModelIds: {} }
      if (channel === 'llm:list-models') { await listHeld; return [models[0]] }
      if (channel === 'llm:set-stage-model') return { success: true, stageModelIds: { planning: (request as { modelId: string }).modelId } }
    })

    const deletion = useLLMStore.getState().deleteModel('reviewer')
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('llm:list-models'))
    await expect(useLLMStore.getState().setStageModel('planning', 'writer')).resolves.toBe(true)
    releaseList()
    await expect(deletion).resolves.toBe(true)

    expect(useLLMStore.getState().stageModelIds).toEqual({ planning: 'writer' })
  })
})
