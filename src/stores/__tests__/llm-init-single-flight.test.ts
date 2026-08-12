import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    get isElectron() { return true },
  },
}))

vi.mock('../../components/ui/AlertDialog', () => ({
  alertError: vi.fn(),
}))

import { useLLMStore } from '../llm-store'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const models = [
  { id: 'generation-model', name: 'Generation' },
  { id: 'embedding-model', name: 'Embedding' },
]

beforeEach(() => {
  vi.clearAllMocks()
  useLLMStore.setState({
    models: [],
    defaultModelId: null,
    defaultEmbeddingModelId: null,
    activeRequests: new Map(),
    loaded: false,
  })
})

describe('LLM store initialization seam', () => {
  it('shares one complete initialization flight across concurrent callers', async () => {
    const modelRead = deferred<unknown[]>()
    const defaultRead = deferred<string>()
    const embeddingRead = deferred<string>()
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'llm:list-models') return modelRead.promise
      if (channel === 'llm:get-default-model') return defaultRead.promise
      if (channel === 'llm:get-default-embedding-model') return embeddingRead.promise
      throw new Error(`unexpected IPC ${channel}`)
    })

    const first = useLLMStore.getState().init()
    const second = useLLMStore.getState().init()

    expect(mocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'llm:list-models',
      'llm:get-default-model',
      'llm:get-default-embedding-model',
    ])

    modelRead.resolve(models)
    defaultRead.resolve('generation-model')
    embeddingRead.resolve('embedding-model')
    await Promise.all([first, second])

    expect(useLLMStore.getState()).toMatchObject({
      models,
      defaultModelId: 'generation-model',
      defaultEmbeddingModelId: 'embedding-model',
      loaded: true,
    })
  })

  it('publishes loaded only after models and both defaults are available', async () => {
    const defaultRead = deferred<string>()
    const embeddingRead = deferred<string>()
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'llm:list-models') return Promise.resolve(models)
      if (channel === 'llm:get-default-model') return defaultRead.promise
      if (channel === 'llm:get-default-embedding-model') return embeddingRead.promise
      throw new Error(`unexpected IPC ${channel}`)
    })
    const observed = Array<ReturnType<typeof useLLMStore.getState>>()
    const unsubscribe = useLLMStore.subscribe(state => observed.push(state))

    const initializing = useLLMStore.getState().init()
    await Promise.resolve()
    expect(useLLMStore.getState()).toMatchObject({ loaded: false, defaultModelId: null })
    expect(observed.some(state => state.loaded)).toBe(false)

    defaultRead.resolve('generation-model')
    await Promise.resolve()
    expect(observed.some(state => state.loaded)).toBe(false)

    embeddingRead.resolve('embedding-model')
    await initializing
    unsubscribe()

    const firstLoaded = observed.find(state => state.loaded)
    expect(firstLoaded).toMatchObject({
      models,
      defaultModelId: 'generation-model',
      defaultEmbeddingModelId: 'embedding-model',
    })
  })

  it('does not let an independent model refresh masquerade as complete initialization', async () => {
    mocks.invoke.mockResolvedValue(models)

    await useLLMStore.getState().loadModels()

    expect(useLLMStore.getState()).toMatchObject({ models, loaded: false })
  })

  it('clears a rejected initialization flight so the next caller can retry', async () => {
    mocks.invoke.mockImplementationOnce(() => Promise.reject(new Error('disk busy')))
      .mockResolvedValueOnce('generation-model')
      .mockResolvedValueOnce('embedding-model')

    await expect(useLLMStore.getState().init()).rejects.toThrow('disk busy')
    expect(useLLMStore.getState().loaded).toBe(false)

    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'llm:list-models') return Promise.resolve(models)
      if (channel === 'llm:get-default-model') return Promise.resolve('generation-model')
      if (channel === 'llm:get-default-embedding-model') return Promise.resolve('embedding-model')
      throw new Error(`unexpected IPC ${channel}`)
    })

    await expect(useLLMStore.getState().init()).resolves.toBeUndefined()
    expect(useLLMStore.getState()).toMatchObject({
      models,
      defaultModelId: 'generation-model',
      defaultEmbeddingModelId: 'embedding-model',
      loaded: true,
    })
    expect(mocks.invoke.mock.calls.filter(([channel]) => channel === 'llm:list-models')).toHaveLength(2)
  })
})
