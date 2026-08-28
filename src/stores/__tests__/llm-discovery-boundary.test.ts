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

describe('llm discovery renderer boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLLMStore.setState({ models: [], loaded: true })
  })

  it('invokes discovery with only the saved profile id', async () => {
    mocks.invoke.mockResolvedValue({
      success: true,
      models: [{ id: 'provider/model', name: 'Provider Model', value: 'provider/model' }],
    })

    const result = await useLLMStore.getState().discoverModels('saved-profile-id')

    expect(mocks.invoke).toHaveBeenCalledWith('llm:discover-models', 'saved-profile-id')
    expect(mocks.invoke.mock.calls[0]).toEqual(['llm:discover-models', 'saved-profile-id'])
    expect(result).toEqual({
      success: true,
      models: [{ id: 'provider/model', name: 'Provider Model', value: 'provider/model' }],
    })
  })
})
