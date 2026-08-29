import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    get isElectron() { return true },
    invoke: mocks.invoke,
    on: vi.fn(() => () => {}),
  },
}))

import { useLLMStore } from '../llm-store'
import type { ModelProfile } from '../../shared/ipc-channels'

describe('llm discovery renderer boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLLMStore.setState({ models: [], loaded: true })
  })

  it('invokes discovery with the unsaved form configuration', async () => {
    const draft: ModelProfile = {
      id: 'unsaved-profile-id',
      name: '',
      provider: 'custom',
      protocol: 'openai',
      modelName: '',
      apiKey: 'secret-used-only-by-main-process',
      baseUrl: 'https://provider.invalid/v1',
      temperature: 0.7,
      maxTokens: 4096,
      purposes: ['generation'],
    }
    mocks.invoke.mockResolvedValue({
      success: true,
      models: [{ id: 'provider/model', name: 'Provider Model', value: 'provider/model' }],
    })

    const request = {
      provider: draft.provider,
      protocol: draft.protocol,
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
    }
    const result = await useLLMStore.getState().discoverModels(request)

    expect(mocks.invoke).toHaveBeenCalledWith('llm:discover-models', request)
    expect(result).toEqual({
      success: true,
      models: [{ id: 'provider/model', name: 'Provider Model', value: 'provider/model' }],
    })
  })
})
