import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
  locale: 'en-US',
}))

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.locale },
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

const xaiReasoningModel: ModelProfile = {
  ...deepSeekModel,
  id: 'grok-4.5',
  name: 'Grok 4.5',
  provider: 'xai',
  modelName: 'grok-4.5',
  baseUrl: 'https://api.x.ai/v1',
  reasoningOverride: 'medium',
}

const legacyDeepSeekV4Model: ModelProfile = {
  ...deepSeekModel,
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  modelName: 'deepseek-v4-flash',
  capabilities: {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    reasoning: false,
    structuredOutput: true,
    usage: true,
  },
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

  it('uses one verified reasoning policy for normal, streaming, and connection-test requests', async () => {
    mocks.models = [xaiReasoningModel]

    await handler('llm:generate')({}, {
      modelId: xaiReasoningModel.id,
      messages: [{ role: 'user', content: 'write' }],
      purpose: 'chapter-draft',
      creativeStrategy: 'fluent-drafting',
      reasoningStage: 'drafting',
    })
    await handler('llm:generate-stream')({ sender: {} }, 'xai-stream', {
      modelId: xaiReasoningModel.id,
      messages: [{ role: 'user', content: 'write' }],
      purpose: 'chapter-draft',
      creativeStrategy: 'fluent-drafting',
      reasoningStage: 'drafting',
    })
    await connectionHandler()({}, xaiReasoningModel, 'deep-planning')

    expect(mocks.generate.mock.calls[0]?.[2]).toMatchObject({
      reasoning: { adapter: 'openai-reasoning-effort', reasoningEffort: 'medium' },
    })
    expect(mocks.generateStream.mock.calls[0]?.[2]).toMatchObject({
      reasoning: { adapter: 'openai-reasoning-effort', reasoningEffort: 'medium' },
    })
    expect(mocks.generate.mock.calls.at(-1)?.[2]).toMatchObject({
      reasoning: { adapter: 'openai-reasoning-effort', reasoningEffort: 'medium' },
    })
    await handler('llm:cancel')({}, 'xai-stream')
  })

  it('uses the verified DeepSeek V4 policy for normal, streaming, and connection-test requests', async () => {
    mocks.models = [legacyDeepSeekV4Model]

    await handler('llm:generate')({}, {
      modelId: legacyDeepSeekV4Model.id,
      messages: [{ role: 'user', content: 'write fluently' }],
      creativeStrategy: 'fluent-drafting',
      reasoningStage: 'drafting',
    })
    await handler('llm:generate-stream')({ sender: {} }, 'deepseek-v4-stream', {
      modelId: legacyDeepSeekV4Model.id,
      messages: [{ role: 'user', content: 'write automatically' }],
      creativeStrategy: 'auto',
      reasoningStage: 'drafting',
    })
    await connectionHandler()({}, legacyDeepSeekV4Model, 'auto')

    expect(mocks.generate.mock.calls[0]?.[2]).toMatchObject({
      reasoning: { adapter: 'deepseek-v4-thinking', thinking: 'disabled' },
    })
    expect(mocks.generateStream.mock.calls[0]?.[2]).toMatchObject({
      reasoning: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'low',
      },
    })
    expect(mocks.generate.mock.calls.at(-1)?.[2]).toMatchObject({
      reasoning: {
        adapter: 'deepseek-v4-thinking',
        thinking: 'enabled',
        reasoningEffort: 'low',
      },
    })
    await handler('llm:cancel')({}, 'deepseek-v4-stream')
  })

  it('uses the profile temperature for regular generation and each initial/continuation stream request', async () => {
    const genericModel = { ...deepSeekModel, temperature: 1 }
    mocks.models = [genericModel]

    await handler('llm:generate')({}, {
      modelId: genericModel.id,
      messages: [{ role: 'user', content: 'write' }],
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
    })

    expect(mocks.generate).toHaveBeenCalledWith(
      genericModel,
      [{ role: 'user', content: 'write' }],
      {
        temperature: 1,
        maxTokens: 512,
        responseFormat: { type: 'json_object' },
      },
    )

    mocks.generateStream.mockClear()
    await handler('llm:generate-stream')({ sender: {} }, 'generic-stream', {
      modelId: genericModel.id,
      messages: [{ role: 'user', content: 'write' }],
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
    })

    expect(mocks.generateStream).toHaveBeenCalledWith(
      genericModel,
      [{ role: 'user', content: 'write' }],
      expect.objectContaining({
        temperature: 1,
        maxTokens: 512,
        responseFormat: { type: 'json_object' },
      }),
    )

    await handler('llm:generate-stream')({ sender: {} }, 'generic-continuation', {
      modelId: genericModel.id,
      messages: [{ role: 'user', content: 'continue' }],
      maxTokens: 512,
      responseFormat: { type: 'json_object' },
    })
    expect(mocks.generateStream).toHaveBeenCalledTimes(2)
    for (const [, , options] of mocks.generateStream.mock.calls) {
      expect(options).toMatchObject({
        temperature: genericModel.temperature,
        maxTokens: 512,
        responseFormat: { type: 'json_object' },
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
    })).rejects.toThrow('GENERATION_KIMI_TEMPERATURE_INVALID')

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
      error: expect.stringContaining('MODEL_EXECUTION_LEASE_INVALID'),
    })
    expect(mocks.generate).not.toHaveBeenCalled()
    await expect(handler('llm:close-execution-lease')({}, leaseId)).resolves.toEqual({ success: true })

    await expect(handler('llm:close-execution-lease')({}, 'never-issued-lease')).resolves.toEqual({
      success: false,
      error: 'MODEL_EXECUTION_LEASE_INVALID',
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
      error: expect.stringContaining('MODEL_EXECUTION_LEASE_INVALID'),
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

  it('records a non-stream terminal reason as the repository structured finish code', async () => {
    const handler = mocks.handlers.get('llm:generate')
    if (!handler) throw new Error('Missing llm:generate handler')
    mocks.generate.mockResolvedValueOnce({
      success: false,
      content: '',
      finishReason: 'content_filter',
      error: 'Human-readable provider policy message',
    })

    await expect(handler({}, {
      modelId: deepSeekModel.id,
      messages: [{ role: 'user', content: 'write' }],
      purpose: 'draft',
      projectSession,
    })).resolves.toMatchObject({
      success: false,
      finishReason: 'content_filter',
      error: 'Human-readable provider policy message',
    })

    expect(mocks.logCall).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorMessage: 'finish:content_filter',
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

  it('forwards a damaged stream candidate as an incomplete terminal result', async () => {
    const handler = mocks.handlers.get('llm:generate-stream')
    if (!handler) throw new Error('Missing llm:generate-stream handler')
    mocks.generateStream.mockImplementationOnce((
      _model: ModelProfile,
      _messages: unknown,
      options: {
        onError: (error: string, content?: string, usage?: unknown) => void
      },
    ) => {
      options.onError('LLM_STREAM_INVALID', 'HEAD', {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      })
    })

    await expect(handler({ sender: {} }, 'damaged-stream', {
      modelId: deepSeekModel.id,
      messages: [{ role: 'user', content: 'write' }],
      purpose: 'draft',
      projectSession,
    })).resolves.toEqual({ requestId: 'damaged-stream', started: true })

    expect(mocks.send).toHaveBeenCalledWith('llm:stream-done', {
      requestId: 'damaged-stream',
      fullText: 'HEAD',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      finishReason: 'error',
    })
    expect(mocks.send).not.toHaveBeenCalledWith('llm:stream-error', expect.anything())
    expect(mocks.logCall).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorMessage: 'LLM_STREAM_INVALID',
    }))
  })
})

describe('llm conversation scoping for gateway session affinity', () => {
  function conversationHandler(channel: 'llm:generate' | 'llm:generate-stream'): IpcHandler {
    const registered = mocks.handlers.get(channel)
    if (!registered) throw new Error(`Missing ${channel} handler`)
    return registered
  }

  it('forwards the execution lease id as the conversation scope of normal and streaming generation', async () => {
    const begin = mocks.handlers.get('llm:begin-execution-lease')
    if (!begin) throw new Error('Missing llm:begin-execution-lease handler')
    const beginResult = await begin({}, deepSeekModel.id) as { success: boolean; lease?: { leaseId: string } }
    if (!beginResult.success || !beginResult.lease) throw new Error('Failed to begin execution lease')
    const request = {
      modelId: deepSeekModel.id,
      modelExecutionLeaseId: beginResult.lease.leaseId,
      messages: [{ role: 'user' as const, content: 'write' }],
      purpose: 'chapter-draft',
    }

    await conversationHandler('llm:generate')({}, request)
    await conversationHandler('llm:generate-stream')({ sender: {} }, 'lease-stream-1', request)

    expect(mocks.generate.mock.calls[0]?.[2]).toMatchObject({ conversationId: beginResult.lease.leaseId })
    expect(mocks.generateStream.mock.calls[0]?.[2]).toMatchObject({ conversationId: beginResult.lease.leaseId })
  })

  it('leaves generation without an execution lease on the provider single-request fallback', async () => {
    const request = {
      modelId: deepSeekModel.id,
      messages: [{ role: 'user' as const, content: 'write' }],
      purpose: 'chapter-draft',
    }

    await conversationHandler('llm:generate')({}, request)
    await conversationHandler('llm:generate-stream')({ sender: {} }, 'unleased-stream-1', request)

    const generateOptions = mocks.generate.mock.calls[0]?.[2] as { conversationId?: string }
    const streamOptions = mocks.generateStream.mock.calls[0]?.[2] as { conversationId?: string }
    expect(generateOptions.conversationId).toBeUndefined()
    expect(streamOptions.conversationId).toBeUndefined()
  })

  it('does not give the connection probe a creative conversation scope', async () => {
    await connectionHandler()({}, deepSeekModel)

    const options = mocks.generate.mock.calls[0]?.[2] as { conversationId?: string }
    expect(options.conversationId).toBeUndefined()
  })
})

// 检索模型的连接测试：embedding 只交错误码（#474 B3），这里按系统语言换回可读说明，HTTP 状态与建议地址留着。
describe('retrieval model connection test', () => {
  const retrievalModel: ModelProfile = { ...deepSeekModel, id: 'bge', modelName: 'bge-m3', baseUrl: 'https://embedding.example/v1', purposes: ['embedding'] }

  it.each([
    ['en-US', 'Retrieval model request failed (HTTP 401)'],
    ['zh-CN', '检索模型请求失败（HTTP 401）'],
  ])('explains an HTTP failure in %s', async (locale, expected) => {
    mocks.locale = locale
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })))
    try {
      const result = await mocks.handlers.get('llm:test-connection')!({}, retrievalModel) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain(expected)
      expect(result.error).not.toMatch(/EMBEDDING_|Error:/u)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    ['en-US', 'returned an unusable result', /\p{Script=Han}|EMBEDDING_|Error:/u],
    ['zh-CN', '检索模型返回的结果不合格', /EMBEDDING_|Error:/u],
  ])('explains an unusable embedding response in %s', async (locale, expected, forbidden) => {
    mocks.locale = locale
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })))
    try {
      const result = await mocks.handlers.get('llm:test-connection')!({}, retrievalModel) as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain(expected)
      expect(result.error).not.toMatch(forbidden)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the suggested OpenAI-compatible Ollama address', async () => {
    mocks.locale = 'en-US'
    const result = await mocks.handlers.get('llm:test-connection')!({}, { ...retrievalModel, baseUrl: 'http://localhost:11434/api' }) as { success: boolean; error: string }
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('http://localhost:11434/v1')
    expect(result.error).not.toMatch(/EMBEDDING_|\p{Script=Han}/u)
  })
})

// 模型表单原样显示连接测试的 error（#474 B6）：provider 只交码，主进程按界面语言写成说明，HTTP 状态与服务返回留着。
describe('generation model connection test failures', () => {
  it.each([
    ['en-US', 'Model request failed (HTTP 401)', /\p{Script=Han}|LLM_/u],
    ['zh-CN', '模型请求失败（HTTP 401）', /LLM_/u],
  ])('explains an HTTP failure in %s with the service response', async (locale, expected, forbidden) => {
    mocks.locale = locale
    mocks.generate.mockResolvedValueOnce({
      success: false, content: '', finishReason: 'error', error: 'LLM_REQUEST_FAILED',
      httpFailure: { status: 401, body: '{"error":"invalid api key"}' },
    })
    const result = await connectionHandler()({}, deepSeekModel) as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toContain(expected)
    expect(result.error).toContain('invalid api key')
    expect(result.error.replace('{"error":"invalid api key"}', '')).not.toMatch(forbidden)
  })

  it('names the finish reason when the probe reply was cut short', async () => {
    mocks.locale = 'en-US'
    mocks.generate.mockResolvedValueOnce({ success: false, content: '', finishReason: 'length', error: 'LLM_RESPONSE_INCOMPLETE' })
    await expect(connectionHandler()({}, deepSeekModel)).resolves.toEqual({
      success: false,
      error: 'The model did not finish its reply (finish reason: length).',
    })
  })

  it.each([
    ['en-US', 'only accepts a temperature from 0 to 1'],
    ['zh-CN', '温度必须在 0 到 1 之间'],
  ])('explains an out-of-range Kimi temperature in %s before any request', async (locale, expected) => {
    mocks.locale = locale
    const result = await connectionHandler()({}, { ...fixedTemperatureKimiModel, modelName: 'kimi-future-preview', temperature: 1.1 }) as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toContain(expected)
    expect(result.error).not.toContain('GENERATION_')
    expect(mocks.generate).not.toHaveBeenCalled()
  })
})

describe('connection test timeout', () => {
  const retrievalModel: ModelProfile = { ...deepSeekModel, id: 'bge', modelName: 'bge-m3', baseUrl: 'https://embedding.example/v1', purposes: ['embedding'] }
  const hangUntilAborted = (signal: AbortSignal | undefined) => new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([
    ['en-US', 'did not finish within 30 seconds', /\p{Script=Han}|LLM_|AbortError/u],
    ['zh-CN', '连接测试 30 秒内没有完成', /LLM_|AbortError/u],
  ])('cancels a hanging generation probe after 30 seconds and explains it in %s', async (locale, expected, forbidden) => {
    mocks.locale = locale
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let signal: AbortSignal | undefined
    mocks.generate.mockImplementationOnce(async (_model: ModelProfile, _messages: unknown, options: { signal?: AbortSignal }) => {
      signal = options.signal
      try {
        return await hangUntilAborted(options.signal)
      } catch (error) {
        return { success: false, content: '', finishReason: 'error', error: String(error) }
      }
    })
    const pending = connectionHandler()({}, deepSeekModel) as Promise<{ success: boolean; error: string }>
    await vi.advanceTimersByTimeAsync(29_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const result = await pending
    expect(signal?.aborted).toBe(true)
    expect(result.success).toBe(false)
    expect(result.error).toContain(expected)
    expect(result.error).not.toMatch(forbidden)
  })

  it.each([
    ['localhost', { baseUrl: 'http://localhost:1234/v1' }],
    ['127.0.0.1', { baseUrl: 'http://127.0.0.1:8080/v1' }],
    ['[::1]', { baseUrl: 'http://[::1]:11434/v1' }],
    ['the Ollama provider', { provider: 'ollama', baseUrl: 'http://gpu-box.lan:11434/v1' }],
  ] as const)('gives %s 120 seconds before cancelling the probe', async (_label, endpoint) => {
    mocks.locale = 'zh-CN'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let signal: AbortSignal | undefined
    mocks.generate.mockImplementationOnce(async (_model: ModelProfile, _messages: unknown, options: { signal?: AbortSignal }) => {
      signal = options.signal
      return hangUntilAborted(options.signal).catch(error => ({ success: false, content: '', finishReason: 'error', error: String(error) }))
    })
    const pending = connectionHandler()({}, { ...deepSeekModel, ...endpoint }) as Promise<{ success: boolean; error: string }>
    await vi.advanceTimersByTimeAsync(119_999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const result = await pending
    expect(signal?.aborted).toBe(true)
    expect(result).toEqual({ success: false, error: '连接测试 120 秒内没有完成，已停止等待。请检查网络或代理设置后重试。' })
  })

  it('cancels a hanging retrieval probe request after 30 seconds', async () => {
    mocks.locale = 'en-US'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined
      return hangUntilAborted(requestSignal)
    }))
    const pending = connectionHandler()({}, retrievalModel) as Promise<{ success: boolean; error: string }>
    await vi.advanceTimersByTimeAsync(30_000)

    const result = await pending
    expect(requestSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('did not finish within 30 seconds')
  })

  it('keeps regular generation free of the connection-test deadline', async () => {
    mocks.generate.mockResolvedValueOnce({ success: true, content: 'ok', finishReason: 'stop' })
    await mocks.handlers.get('llm:generate')!({}, { modelId: deepSeekModel.id, messages: [{ role: 'user', content: 'hi' }] })
    expect(mocks.generate.mock.calls[0]?.[2]).not.toHaveProperty('signal')
  })
})

describe('generation model connection test with an empty error body', () => {
  it('ends the explanation without a dangling service response', async () => {
    mocks.locale = 'en-US'
    mocks.generate.mockResolvedValueOnce({
      success: false, content: '', finishReason: 'error', error: 'LLM_REQUEST_FAILED', httpFailure: { status: 403, body: '' },
    })
    await expect(connectionHandler()({}, deepSeekModel)).resolves.toEqual({
      success: false,
      error: 'Model request failed (HTTP 403). Check the Base URL, API key, and model name.',
    })
  })
})
