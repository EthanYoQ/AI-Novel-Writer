import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>
type ReadResult = { status: 'ok'; value: unknown } | { status: 'missing' } | { status: 'error'; error: Error }

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  files: new Map<string, unknown>(),
  corrupt: new Set<string>(),
  writeJsonFile: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => { mocks.handlers.set(channel, handler) }) },
}))

vi.mock('../../utils/config-utils', () => ({
  MODELS_CONFIG_PATH: 'models.json',
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: { theme: 'dark', defaultModelId: null, editorFontSize: 16, editorFontFamily: 'serif', autoSaveInterval: 30 },
  readJsonFile: vi.fn((filePath: string, fallback: unknown) => structuredClone(mocks.files.get(filePath) ?? fallback)),
  tryReadJsonFile: vi.fn((filePath: string): ReadResult => {
    if (mocks.corrupt.has(filePath)) return { status: 'error', error: new Error('broken json') }
    return mocks.files.has(filePath) ? { status: 'ok', value: structuredClone(mocks.files.get(filePath)) } : { status: 'missing' }
  }),
  writeJsonFile: mocks.writeJsonFile,
}))

vi.mock('../../llm/llm-factory', () => ({ LLMFactory: { getProvider: vi.fn() } }))

import { registerLLMController } from '../llm-controller'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing ${channel} handler`)
  return registered
}

const writes: Array<{ path: string; value: Record<string, unknown> }> = []

beforeAll(() => registerLLMController())

beforeEach(() => {
  vi.clearAllMocks()
  writes.length = 0
  mocks.corrupt.clear()
  mocks.files.set('models.json', [
    { id: 'writer', name: 'Writer', purposes: ['generation'] },
    { id: 'reviewer', name: 'Reviewer', purposes: ['generation'] },
    { id: 'embedder', name: 'Embedder', purposes: ['embedding'] },
  ])
  mocks.files.set('config.json', { theme: 'dark', defaultModelId: 'writer', proxy: { enabled: false, type: 'http', host: '', port: 7890 } })
  mocks.writeJsonFile.mockImplementation((path: string, value: Record<string, unknown>) => {
    writes.push({ path, value: structuredClone(value) })
    mocks.files.set(path, structuredClone(value))
  })
})

describe('stage model settings', () => {
  it('reads only well-formed stage assignments back', async () => {
    mocks.files.set('config.json', { defaultModelId: 'writer', stageModelIds: { review: 'reviewer', unknown: 'writer', drafting: 3 } })
    await expect(handler('llm:get-stage-models')({})).resolves.toEqual({ review: 'reviewer' })
  })

  it('assigns a generation model to one stage and leaves every other setting as it was', async () => {
    await expect(handler('llm:set-stage-model')({}, { stage: 'review', modelId: 'reviewer' }))
      .resolves.toEqual({ success: true, stageModelIds: { review: 'reviewer' } })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ path: 'config.json', value: {
      theme: 'dark', defaultModelId: 'writer', proxy: { enabled: false, type: 'http', host: '', port: 7890 }, stageModelIds: { review: 'reviewer' },
    } })
  })

  it('stores and returns the model id without surrounding whitespace', async () => {
    await expect(handler('llm:set-stage-model')({}, { stage: 'review', modelId: '  reviewer \n' }))
      .resolves.toEqual({ success: true, stageModelIds: { review: 'reviewer' } })
    expect(writes[0]?.value.stageModelIds).toEqual({ review: 'reviewer' })
  })

  it('returns a stage to the default', async () => {
    mocks.files.set('config.json', { defaultModelId: 'writer', stageModelIds: { review: 'reviewer' } })
    await expect(handler('llm:set-stage-model')({}, { stage: 'review', modelId: null }))
      .resolves.toEqual({ success: true, stageModelIds: {} })
    expect(writes[0]?.value).toEqual({ defaultModelId: 'writer', stageModelIds: {} })
  })

  it.each([
    ['an unknown stage', { stage: 'outline', modelId: 'writer' }, 'LLM_STAGE_MODEL_REQUEST_INVALID'],
    ['a malformed request', 'review', 'LLM_STAGE_MODEL_REQUEST_INVALID'],
    ['an embedding-only model', { stage: 'review', modelId: 'embedder' }, 'LLM_STAGE_MODEL_UNAVAILABLE'],
    ['a model that does not exist', { stage: 'review', modelId: 'gone' }, 'LLM_STAGE_MODEL_UNAVAILABLE'],
  ])('refuses %s without writing', async (_label, request, code) => {
    await expect(handler('llm:set-stage-model')({}, request)).resolves.toEqual({ success: false, error: expect.stringContaining(code) })
    expect(writes).toEqual([])
  })

  it('refuses to overwrite a damaged config file', async () => {
    mocks.corrupt.add('config.json')
    await expect(handler('llm:set-stage-model')({}, { stage: 'review', modelId: 'reviewer' }))
      .resolves.toEqual({ success: false, error: expect.stringContaining('LLM_GLOBAL_CONFIG_CORRUPT') })
    expect(writes).toEqual([])
  })
})

describe('deleting a model that a stage uses', () => {
  it('clears the stage in the same config write that runs before the model is removed', async () => {
    mocks.files.set('config.json', { defaultModelId: 'writer', stageModelIds: { review: 'reviewer', planning: 'writer' } })
    await expect(handler('llm:delete-model')({}, 'reviewer')).resolves.toEqual({
      success: true, defaultModelId: 'writer', defaultEmbeddingModelId: null, stageModelIds: { planning: 'writer' },
    })
    expect(writes.map(write => write.path)).toEqual(['config.json', 'models.json'])
    expect(writes[0]?.value).toEqual({ defaultModelId: 'writer', stageModelIds: { planning: 'writer' } })
  })

  it('restores the stage assignment when the model file cannot be replaced', async () => {
    mocks.files.set('config.json', { defaultModelId: 'writer', stageModelIds: { review: 'reviewer' } })
    mocks.writeJsonFile.mockImplementation((path: string, value: Record<string, unknown>) => {
      writes.push({ path, value: structuredClone(value) })
      if (path === 'models.json') throw new Error('models file locked')
    })
    await expect(handler('llm:delete-model')({}, 'reviewer')).resolves.toEqual({ success: false, error: expect.stringContaining('models file locked') })
    expect(writes.map(write => write.path)).toEqual(['config.json', 'models.json', 'config.json'])
    expect(writes[0]?.value).toEqual({ defaultModelId: 'writer', stageModelIds: {} })
    expect(writes.at(-1)?.value).toEqual({ defaultModelId: 'writer', stageModelIds: { review: 'reviewer' } })
  })

  it('leaves the config file alone when no setting points at the deleted model', async () => {
    mocks.files.set('config.json', { defaultModelId: 'writer', stageModelIds: { planning: 'writer' } })
    await expect(handler('llm:delete-model')({}, 'reviewer')).resolves.toMatchObject({ success: true, stageModelIds: { planning: 'writer' } })
    expect(writes.map(write => write.path)).toEqual(['models.json'])
  })
})
