import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  alertError: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    get isElectron() { return true },
  },
}))

vi.mock('../../components/ui/AlertDialog', () => ({
  alertError: mocks.alertError,
}))

import { useLLMStore } from '../llm-store'

beforeEach(() => {
  vi.clearAllMocks()
  useLLMStore.setState({
    models: [],
    defaultModelId: 'old-model',
    defaultEmbeddingModelId: 'old-embedding',
    activeRequests: new Map(),
    loaded: true,
  })
})

describe('LLM settings mutation boundaries', () => {
  it('keeps the previous default model when persistence fails', async () => {
    mocks.invoke.mockResolvedValue({ success: false, error: 'disk full' })

    await expect(useLLMStore.getState().setDefaultModel('new-model')).resolves.toBe(false)

    expect(useLLMStore.getState().defaultModelId).toBe('old-model')
    expect(mocks.alertError).toHaveBeenCalled()
  })

  it('publishes the default embedding model only after persistence succeeds', async () => {
    mocks.invoke.mockResolvedValue({ success: true })

    await expect(useLLMStore.getState().setDefaultEmbeddingModel('new-embedding')).resolves.toBe(true)

    expect(useLLMStore.getState().defaultEmbeddingModelId).toBe('new-embedding')
  })

  it('uses the atomic delete result without issuing separate default-model writes', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'llm:delete-model') {
        return {
          success: true,
          defaultModelId: null,
          defaultEmbeddingModelId: 'old-embedding',
        }
      }
      if (channel === 'llm:list-models') return []
      throw new Error(`unexpected IPC: ${channel}`)
    })

    await expect(useLLMStore.getState().deleteModel('old-model')).resolves.toBe(true)

    expect(useLLMStore.getState()).toMatchObject({
      models: [],
      defaultModelId: null,
      defaultEmbeddingModelId: 'old-embedding',
    })
    expect(mocks.invoke).not.toHaveBeenCalledWith('llm:set-default-model', null)
    expect(mocks.invoke).not.toHaveBeenCalledWith('llm:set-default-embedding-model', null)
  })
})
