import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  generate: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
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
  readJsonFile: vi.fn((_filePath: string, fallback: unknown) => fallback),
  tryReadJsonFile: vi.fn(() => ({ status: 'missing' })),
  writeJsonFile: vi.fn(),
}))

vi.mock('../../llm/llm-factory', () => ({
  LLMFactory: {
    getProvider: vi.fn(() => ({ generate: mocks.generate })),
  },
}))

import { registerLLMController } from '../llm-controller'

const deepSeekModel: ModelProfile = {
  id: 'deepseek-reasoner',
  name: 'DeepSeek Reasoner',
  provider: 'deepseek',
  protocol: 'openai',
  modelName: 'deepseek-reasoner',
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com',
  temperature: 0.7,
  maxTokens: 8192,
  purposes: ['generation'],
}

function connectionHandler(): IpcHandler {
  const handler = mocks.handlers.get('llm:test-connection')
  if (!handler) throw new Error('Missing llm:test-connection handler')
  return handler
}

beforeAll(() => {
  registerLLMController()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.generate.mockImplementation(async (
    _model: ModelProfile,
    _messages: unknown,
    options: { maxTokens: number },
  ) => options.maxTokens <= 10
    ? { success: false, content: '', finishReason: 'length', error: 'API 返回的文本未正常完成' }
    : { success: true, content: 'hello', finishReason: 'stop' })
})

describe('llm connection test', () => {
  it('gives reasoning models enough output budget to complete the probe', async () => {
    await expect(connectionHandler()({}, deepSeekModel)).resolves.toEqual({
      success: true,
      error: undefined,
    })

    expect(mocks.generate).toHaveBeenCalledWith(
      deepSeekModel,
      [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      expect.objectContaining({ maxTokens: expect.any(Number) }),
    )
    const options = mocks.generate.mock.calls[0]?.[2] as { maxTokens: number }
    expect(options.maxTokens).toBeGreaterThanOrEqual(256)
  })
})
