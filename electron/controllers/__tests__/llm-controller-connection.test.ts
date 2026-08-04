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
