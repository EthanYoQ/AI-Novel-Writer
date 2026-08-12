import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelProfile } from '../../../src/shared/ipc-channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  generate: vi.fn(),
  generateStream: vi.fn(),
  send: vi.fn(),
  logCall: vi.fn(),
  assertCurrentProjectContext: vi.fn(),
  models: [] as ModelProfile[],
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => ({ webContents: { send: mocks.send } })) },
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

  it('uses the profile temperature for regular generation and each initial/continuation stream request', async () => {
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

    await handler('llm:generate-stream')({ sender: {} }, 'generic-continuation', {
      modelId: genericModel.id,
      messages: [{ role: 'user', content: 'continue' }],
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
      thinking: true,
    })
    expect(mocks.generateStream).toHaveBeenCalledTimes(2)
    for (const [, , options] of mocks.generateStream.mock.calls) {
      expect(options).toMatchObject({
        temperature: genericModel.temperature,
        maxTokens: 512,
        responseFormat: { type: 'json_object' },
        thinking: true,
      })
    }

    await handler('llm:cancel')({}, 'generic-stream')
    await handler('llm:cancel')({}, 'generic-continuation')
  })

  it('uses the same fixed-Kimi policy for regular, connection, and each initial/continuation stream request', async () => {
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

    await handler('llm:generate-stream')({ sender: {} }, 'kimi-continuation', {
      modelId: fixedTemperatureKimiModel.id,
      messages: [{ role: 'user', content: 'continue' }],
      maxTokens: 512,
      thinking: true,
    })
    expect(mocks.generateStream).toHaveBeenCalledTimes(2)
    for (const [, , options] of mocks.generateStream.mock.calls) {
      expect(options).toMatchObject({ temperature: undefined, maxTokens: 512 })
      expect(options).not.toHaveProperty('thinking')
    }
    await handler('llm:cancel')({}, 'kimi-stream')
    await handler('llm:cancel')({}, 'kimi-continuation')

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

describe('llm model execution lease controller integration', () => {
  function handler(channel:
    | 'llm:begin-execution-lease'
    | 'llm:close-execution-lease'
    | 'llm:generate'
    | 'llm:generate-stream'
  ): IpcHandler {
    const registered = mocks.handlers.get(channel)
    if (!registered) throw new Error(`Missing ${channel} handler`)
    return registered
  }

  it('uses the frozen main-process snapshot after the same model id is edited', async () => {
    const original: ModelProfile = {
      ...deepSeekModel,
      apiKey: 'lease-controller-original-key',
      baseUrl: 'https://api.deepseek.com',
      temperature: 0.4,
    }
    mocks.models = [original]

    const beginResult = await handler('llm:begin-execution-lease')({}, original.id) as {
      success: boolean
      lease?: { leaseId: string }
    }
    expect(beginResult.success).toBe(true)
    expect(beginResult.lease?.leaseId).toEqual(expect.any(String))
    expect(JSON.stringify(beginResult)).not.toContain(original.apiKey)

    mocks.models = [{
      ...original,
      apiKey: 'lease-controller-edited-key',
      baseUrl: 'https://edited.invalid/v1',
      temperature: 1,
    }]
    await handler('llm:generate')({}, {
      modelId: original.id,
      modelExecutionLeaseId: beginResult.lease?.leaseId,
      messages: [{ role: 'user', content: 'write' }],
      maxTokens: 512,
    })

    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: original.id,
        apiKey: 'lease-controller-original-key',
        baseUrl: 'https://api.deepseek.com',
        temperature: 0.4,
      }),
      [{ role: 'user', content: 'write' }],
      expect.objectContaining({ temperature: 0.4, maxTokens: 512 }),
    )
  })

  it('keeps a stream on its leased model after the configured default changes', async () => {
    const leasedModel: ModelProfile = {
      ...deepSeekModel,
      apiKey: 'lease-stream-original-key',
      temperature: 0.3,
    }
    const newDefaultModel: ModelProfile = {
      ...deepSeekModel,
      id: 'new-default-model',
      modelName: 'new-default-model',
      apiKey: 'lease-stream-new-default-key',
      baseUrl: 'https://new-default.invalid/v1',
      temperature: 1,
    }
    mocks.models = [leasedModel]
    const beginResult = await handler('llm:begin-execution-lease')({}, leasedModel.id) as {
      success: boolean
      lease?: { leaseId: string }
    }
    mocks.models = [newDefaultModel]

    await expect(handler('llm:generate-stream')({ sender: {} }, 'leased-stream', {
      modelId: newDefaultModel.id,
      modelExecutionLeaseId: beginResult.lease?.leaseId,
      messages: [{ role: 'user', content: 'continue' }],
      maxTokens: 512,
    })).resolves.toEqual({ requestId: 'leased-stream', started: true })

    expect(mocks.generateStream).toHaveBeenCalledWith(
      expect.objectContaining({
        id: leasedModel.id,
        apiKey: 'lease-stream-original-key',
        baseUrl: leasedModel.baseUrl,
      }),
      [{ role: 'user', content: 'continue' }],
      expect.objectContaining({ temperature: 0.3, maxTokens: 512 }),
    )
  })

  it('rejects generation after close while making a lost close response safe to retry', async () => {
    mocks.models = [deepSeekModel]
    const beginResult = await handler('llm:begin-execution-lease')({}, deepSeekModel.id) as {
      success: boolean
      lease?: { leaseId: string }
    }
    const leaseId = beginResult.lease?.leaseId
    expect(leaseId).toEqual(expect.any(String))

    await expect(handler('llm:close-execution-lease')({}, leaseId)).resolves.toEqual({ success: true })
    mocks.generate.mockClear()
    await expect(handler('llm:generate')({}, {
      modelId: deepSeekModel.id,
      modelExecutionLeaseId: leaseId,
      messages: [{ role: 'user', content: 'write' }],
    })).resolves.toMatchObject({
      success: false,
      content: '',
      error: expect.stringContaining('模型执行租约无效'),
    })
    expect(mocks.generate).not.toHaveBeenCalled()
    await expect(handler('llm:close-execution-lease')({}, leaseId)).resolves.toEqual({ success: true })

    await expect(handler('llm:close-execution-lease')({}, 'never-issued-lease')).resolves.toEqual({
      success: false,
      error: '模型执行租约无效或已关闭',
    })
  })

  it('fails a stream closed when its lease is unknown instead of falling back to model id', async () => {
    mocks.models = [deepSeekModel]
    mocks.generateStream.mockClear()

    await expect(handler('llm:generate-stream')({ sender: {} }, 'unknown-lease-stream', {
      modelId: deepSeekModel.id,
      modelExecutionLeaseId: 'unknown-model-execution-lease',
      messages: [{ role: 'user', content: 'write' }],
    })).resolves.toEqual({
      requestId: 'unknown-lease-stream',
      started: false,
      error: expect.stringContaining('模型执行租约无效'),
    })
    expect(mocks.generateStream).not.toHaveBeenCalled()
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

  it('normalizes a legacy stream without finish reason to unknown before IPC and statistics', async () => {
    const handler = mocks.handlers.get('llm:generate-stream')
    if (!handler) throw new Error('Missing llm:generate-stream handler')
    mocks.generateStream.mockImplementationOnce((
      _model: ModelProfile,
      _messages: unknown,
      options: { onDone: (fullText: string) => void },
    ) => {
      options.onDone('legacy partial text')
    })

    await expect(handler({ sender: {} }, 'legacy-stream', {
      modelId: deepSeekModel.id,
      messages: [{ role: 'user', content: 'write' }],
      purpose: 'draft',
      projectSession,
    })).resolves.toEqual({ requestId: 'legacy-stream', started: true })

    expect(mocks.send).toHaveBeenCalledWith('llm:stream-done', {
      requestId: 'legacy-stream',
      fullText: 'legacy partial text',
      usage: undefined,
      finishReason: 'unknown',
    })
    expect(mocks.logCall).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorMessage: 'finish:unknown',
    }))
  })
})
