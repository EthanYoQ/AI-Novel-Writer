import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  generate: vi.fn(),
  generateStream: vi.fn(),
  logCall: vi.fn(),
  assertCurrentProjectContext: vi.fn(),
  models: [] as ModelProfile[],
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => ({ webContents: { send: vi.fn() } })) },
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
    getProvider: vi.fn(() => ({ generate: mocks.generate, generateStream: mocks.generateStream })),
  },
}))

vi.mock('../../database', () => ({ getCurrentProjectPath: () => 'C:/projects/A' }))
vi.mock('../../repositories/llm-repository', () => ({
  LLMHistoryRepository: { logCall: mocks.logCall },
}))
vi.mock('../../services/project-access', () => ({
  projectAccess: { assertCurrentProjectContext: mocks.assertCurrentProjectContext },
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

const fixedTemperatureKimiModel: ModelProfile = {
  ...deepSeekModel,
  id: 'kimi-k3',
  name: 'Kimi K3',
  provider: 'custom',
  modelName: 'kimi-k3',
  baseUrl: 'https://api.moonshot.cn/v1',
  temperature: 1,
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
  mocks.models = [deepSeekModel]
  mocks.assertCurrentProjectContext.mockReturnValue({ rootPath: 'C:/projects/A' })
})

describe('llm connection test', () => {
  it('uses the configured profile temperature for a generic connection probe', async () => {
    const genericModel: ModelProfile = {
      ...deepSeekModel,
      temperature: 1,
    }

    await expect(connectionHandler()({}, genericModel)).resolves.toEqual({
      success: true,
      error: undefined,
    })

    expect(mocks.generate).toHaveBeenCalledWith(
      genericModel,
      [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      expect.objectContaining({ temperature: 1 }),
    )
  })

  it('omits temperature for a fixed-temperature Kimi connection probe', async () => {
    await expect(connectionHandler()({}, fixedTemperatureKimiModel)).resolves.toEqual({
      success: true,
      error: undefined,
    })

    expect(mocks.generate).toHaveBeenCalledWith(
      fixedTemperatureKimiModel,
      [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      expect.objectContaining({ temperature: undefined }),
    )
  })

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

  it('does not count a connection probe as a project generation call', async () => {
    await connectionHandler()({}, deepSeekModel)
    expect(mocks.logCall).not.toHaveBeenCalled()
  })
})

describe('llm generation parameter policy controller integration', () => {
  function handler(channel: 'llm:generate' | 'llm:generate-stream' | 'llm:cancel'): IpcHandler {
    const registered = mocks.handlers.get(channel)
    if (!registered) throw new Error(`Missing ${channel} handler`)
    return registered
  }

  it('uses the profile temperature for both regular and streaming generation', async () => {
    const genericModel = { ...deepSeekModel, temperature: 1 }
    mocks.models = [genericModel]

    await handler('llm:generate')({}, {
      modelId: genericModel.id,
      messages: [{ role: 'user', content: 'write' }],
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      thinking: true,
    })

    expect(mocks.generate).toHaveBeenCalledWith(
      genericModel,
      [{ role: 'user', content: 'write' }],
      {
        temperature: 1,
        maxTokens: 512,
        responseFormat: { type: 'json_object' },
        thinking: true,
      },
    )

    mocks.generateStream.mockClear()
    await handler('llm:generate-stream')({ sender: {} }, 'generic-stream', {
      modelId: genericModel.id,
      messages: [{ role: 'user', content: 'write' }],
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      thinking: true,
    })

    expect(mocks.generateStream).toHaveBeenCalledWith(
      genericModel,
      [{ role: 'user', content: 'write' }],
      expect.objectContaining({
        temperature: 1,
        maxTokens: 512,
        responseFormat: { type: 'json_object' },
        thinking: true,
      }),
    )

    await handler('llm:cancel')({}, 'generic-stream')
  })

  it('uses the same fixed-Kimi policy for regular, streaming, and connection requests', async () => {
    mocks.models = [fixedTemperatureKimiModel]

    await handler('llm:generate')({}, {
      modelId: fixedTemperatureKimiModel.id,
      messages: [{ role: 'user', content: 'write' }],
      maxTokens: 512,
      thinking: true,
    })
    expect(mocks.generate).toHaveBeenLastCalledWith(
      fixedTemperatureKimiModel,
      [{ role: 'user', content: 'write' }],
      expect.objectContaining({ temperature: undefined }),
    )
    expect(mocks.generate.mock.calls.at(-1)?.[2]).not.toHaveProperty('thinking')

    mocks.generateStream.mockClear()
    await handler('llm:generate-stream')({ sender: {} }, 'kimi-stream', {
      modelId: fixedTemperatureKimiModel.id,
      messages: [{ role: 'user', content: 'write' }],
      maxTokens: 512,
      thinking: true,
    })
    expect(mocks.generateStream).toHaveBeenCalledWith(
      fixedTemperatureKimiModel,
      [{ role: 'user', content: 'write' }],
      expect.objectContaining({ temperature: undefined }),
    )
    expect(mocks.generateStream.mock.calls[0]?.[2]).not.toHaveProperty('thinking')
    await handler('llm:cancel')({}, 'kimi-stream')

    mocks.generate.mockClear()
    await connectionHandler()({}, fixedTemperatureKimiModel)
    expect(mocks.generate).toHaveBeenCalledWith(
      fixedTemperatureKimiModel,
      [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      expect.objectContaining({ temperature: undefined }),
    )
  })

  it('does not register a stream when parameter resolution rejects the model settings', async () => {
    const invalidKimiModel: ModelProfile = {
      ...fixedTemperatureKimiModel,
      id: 'kimi-future-invalid-temperature',
      modelName: 'kimi-future-preview',
      temperature: 1.1,
    }
    const requestId = 'invalid-kimi-stream'
    mocks.models = [invalidKimiModel]

    await expect(handler('llm:generate-stream')({ sender: {} }, requestId, {
      modelId: invalidKimiModel.id,
      messages: [{ role: 'user', content: 'write' }],
    })).rejects.toThrow('0 到 1')

    expect(mocks.generateStream).not.toHaveBeenCalled()
    await expect(handler('llm:cancel')({}, requestId)).resolves.toEqual({ success: false })
  })
})

describe('llm project statistics', () => {
  const projectSession = {
    projectId: 'project-A',
    projectPath: 'C:/projects/A',
    leaseId: 'lease-A',
  }

  it('records a non-stream provider call once with its frozen project lease', async () => {
    const handler = mocks.handlers.get('llm:generate')
    if (!handler) throw new Error('Missing llm:generate handler')
    mocks.generate.mockResolvedValueOnce({
      success: true,
      content: 'done',
      finishReason: 'stop',
      usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
    })

    await handler({}, {
      modelId: deepSeekModel.id,
      messages: [{ role: 'user', content: 'write' }],
      purpose: 'draft',
      projectSession,
    })

    expect(mocks.assertCurrentProjectContext).toHaveBeenCalledWith(projectSession, 'C:/projects/A')
    expect(mocks.logCall).toHaveBeenCalledTimes(1)
    expect(mocks.logCall).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'draft',
      promptTokens: 4,
      completionTokens: 3,
      totalTokens: 7,
      success: true,
    }))
  })

  it('does not write project statistics without a project lease', async () => {
    const handler = mocks.handlers.get('llm:generate')
    if (!handler) throw new Error('Missing llm:generate handler')
    await handler({}, {
      modelId: deepSeekModel.id,
      messages: [{ role: 'user', content: 'write' }],
    })
    expect(mocks.logCall).not.toHaveBeenCalled()
  })
})
