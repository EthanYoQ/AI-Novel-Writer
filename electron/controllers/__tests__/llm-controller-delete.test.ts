import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  models: [
    { id: 'generation', name: 'Generation' },
    { id: 'embedding', name: 'Embedding' },
  ],
  config: {
    theme: 'dark',
    defaultModelId: 'generation',
    defaultEmbeddingModelId: 'generation',
    autoOpenNextChapterAfterFinalize: false,
    editorFontSize: 16,
    editorFontFamily: 'Noto Serif SC',
    autoSaveInterval: 30,
    proxy: { enabled: false, type: 'http', host: '', port: 7890 },
  },
  writeJsonFile: vi.fn(),
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
  DEFAULT_GLOBAL_CONFIG: mocks.config,
  readJsonFile: vi.fn((filePath: string, fallback: unknown) => (
    filePath === 'models.json' ? mocks.models : (filePath === 'config.json' ? mocks.config : fallback)
  )),
  tryReadJsonFile: vi.fn((filePath: string) => ({
    status: 'ok',
    value: filePath === 'models.json' ? mocks.models : mocks.config,
  })),
  writeJsonFile: mocks.writeJsonFile,
}))

vi.mock('../../llm/llm-factory', () => ({
  LLMFactory: { getProvider: vi.fn() },
}))

import { registerLLMController } from '../llm-controller'

function deleteHandler(): IpcHandler {
  const registered = mocks.handlers.get('llm:delete-model')
  if (!registered) throw new Error('Missing llm:delete-model handler')
  return registered
}

beforeAll(() => {
  registerLLMController()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('llm model deletion consistency', () => {
  it('clears both default references before deleting the referenced model', async () => {
    const writes: Array<{ path: string; value: unknown }> = []
    mocks.writeJsonFile.mockImplementation((path: string, value: unknown) => {
      writes.push({ path, value })
    })

    await expect(deleteHandler()({}, 'generation')).resolves.toMatchObject({
      success: true,
      defaultModelId: null,
      defaultEmbeddingModelId: null,
    })
    expect(writes.map(write => write.path)).toEqual(['config.json', 'models.json'])
    expect(writes[0]?.value).toMatchObject({
      defaultModelId: null,
      defaultEmbeddingModelId: null,
    })
    expect(writes[1]?.value).toEqual([
      expect.objectContaining({ id: 'embedding' }),
    ])
  })

  it('rolls back cleared defaults when the model file cannot be replaced', async () => {
    const writes: Array<{ path: string; value: unknown }> = []
    mocks.writeJsonFile.mockImplementation((path: string, value: unknown) => {
      writes.push({ path, value })
      if (path === 'models.json') throw new Error('models file locked')
    })

    await expect(deleteHandler()({}, 'generation')).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('models file locked'),
    })
    expect(writes.map(write => write.path)).toEqual([
      'config.json',
      'models.json',
      'config.json',
    ])
    expect(writes.at(-1)?.value).toMatchObject({
      defaultModelId: 'generation',
      defaultEmbeddingModelId: 'generation',
    })
  })
})
