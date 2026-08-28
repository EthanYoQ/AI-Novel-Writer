import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ModelDiscoveryResult,
  ModelProfile,
} from '../../../src/shared/ipc-channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  models: [] as ModelProfile[],
  discoverModels: vi.fn<(profileId: string) => Promise<ModelDiscoveryResult>>(),
  discoveryLoadModel: undefined as undefined | ((profileId: string) => ModelProfile | null),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../utils/config-utils', () => ({
  MODELS_CONFIG_PATH: 'models.json',
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: { proxy: { enabled: false } },
  readJsonFile: vi.fn((filePath: string, fallback: unknown) => filePath === 'models.json' ? mocks.models : fallback),
  tryReadJsonFile: vi.fn(() => ({ status: 'missing' })),
  writeJsonFile: vi.fn(),
}))

vi.mock('../../llm/llm-factory', () => ({
  LLMFactory: {
    getProvider: vi.fn(() => ({ generate: vi.fn(), generateStream: vi.fn() })),
  },
}))

vi.mock('../../database', () => ({ getCurrentProjectPath: () => null }))
vi.mock('../../repositories/llm-repository', () => ({
  LLMHistoryRepository: { logCall: vi.fn() },
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: { assertCurrentProjectContext: vi.fn() },
}))
vi.mock('../../services/model-discovery-service', () => ({
  ModelDiscoveryService: class {
    constructor(dependencies: { loadModel: (profileId: string) => ModelProfile | null }) {
      mocks.discoveryLoadModel = dependencies.loadModel
    }

    discoverModels(profileId: string) {
      return mocks.discoverModels(profileId)
    }
  },
}))

import { registerLLMController } from '../llm-controller'

const savedProfile: ModelProfile = {
  id: 'saved-profile-id',
  name: 'Saved profile',
  provider: 'custom',
  protocol: 'openai',
  modelName: 'manual-model',
  apiKey: `credential-${crypto.randomUUID()}`,
  baseUrl: 'https://provider.invalid/v1',
  temperature: 0.7,
  maxTokens: 4096,
  purposes: ['generation'],
}

beforeAll(() => {
  registerLLMController()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.models = [savedProfile]
  mocks.discoverModels.mockResolvedValue({
    success: true,
    models: [{ id: 'provider-model', name: 'Provider Model', value: 'provider-model' }],
  })
})

describe('llm model discovery controller boundary', () => {
  it('uses only the renderer profile id while the service can load the saved credential', async () => {
    const handler = mocks.handlers.get('llm:discover-models')
    if (!handler) throw new Error('Missing llm:discover-models handler')

    const result = await handler({}, savedProfile.id)

    expect(mocks.discoverModels).toHaveBeenCalledWith(savedProfile.id)
    expect(mocks.discoverModels.mock.calls[0]).toEqual([savedProfile.id])
    expect(mocks.discoveryLoadModel?.(savedProfile.id)).toEqual(savedProfile)
    expect(JSON.stringify(mocks.discoverModels.mock.calls)).not.toContain(savedProfile.apiKey)
    expect(JSON.stringify(result)).not.toContain(savedProfile.apiKey)
  })
})
