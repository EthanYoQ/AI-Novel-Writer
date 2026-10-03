import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

let fixtureRoot = ''
let velaHome = ''

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

beforeEach(async () => {
  vi.resetModules()
  mocks.handlers.clear()
  velaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-model-config-corrupt-'))
  fixtureRoot = velaHome
    velaHome = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
  const { registerLLMController } = await import('../llm-controller')
  registerLLMController()
})

afterEach(() => {
  delete process.env.AI_NOVEL_VELA_HOME
    delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('model configuration corruption boundary', () => {
  it('persists a numeric thinking mapping across reload and refuses an off value that enables thinking', async () => {
    const profile = { id: 'numeric', protocol: 'openai', reasoningOverride: 'medium', reasoningMapping: {
      adapter: 'openai-thinking-budget', supportedEfforts: ['off', 'medium'], providerValues: { off: 0, medium: 4096 },
    } }
    await expect(handler('llm:save-model')({}, profile)).resolves.toEqual({ success: true })
    const file = path.join(velaHome, 'models.json')
    const before = fs.readFileSync(file)
    vi.resetModules()
    await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
    ;(await import('../llm-controller')).registerLLMController()
    const reloaded = await handler('llm:list-models')({})
    expect(reloaded).toEqual([expect.objectContaining(profile)])
    await expect(handler('llm:save-model')({}, { ...profile, reasoningMapping: {
      ...profile.reasoningMapping, providerValues: { off: 4096, medium: 4096 },
    } })).resolves.toMatchObject({ success: false, error: expect.stringContaining('INVALID_REASONING_MAPPING') })
    expect(fs.readFileSync(file)).toEqual(before)
  })
  it('saves a validated advanced mapping and rejects malformed mappings without changing the file', async () => {
    const profile = { id: 'mapped', protocol: 'openai', reasoningMapping: {
      adapter: 'openai-reasoning-effort', supportedEfforts: ['xhigh'], providerValues: { xhigh: 'Extra' },
    } }
    await expect(handler('llm:save-model')({}, profile)).resolves.toEqual({ success: true })
    const file = path.join(velaHome, 'models.json')
    const before = fs.readFileSync(file)
    expect(JSON.parse(before.toString())[0].reasoningMapping).toEqual(profile.reasoningMapping)
    await expect(handler('llm:save-model')({}, { ...profile, reasoningMapping: {
      ...profile.reasoningMapping, providerValues: { xhigh: 100 },
    } })).resolves.toMatchObject({ success: false, error: expect.stringContaining('INVALID_REASONING_MAPPING') })
    expect(fs.readFileSync(file)).toEqual(before)
  })
  it('refuses to overwrite an existing malformed models file when saving a model', async () => {
    const modelsPath = path.join(velaHome, 'models.json')
    const originalBytes = Buffer.from('{BROKEN_MODELS_SECRET_MARKER', 'utf8')
    fs.writeFileSync(modelsPath, originalBytes)

    await expect(handler('llm:save-model')({}, {
      id: 'model-1',
      name: 'Model 1',
    })).resolves.toMatchObject({ success: false, error: expect.any(String) })
    expect(fs.readFileSync(modelsPath)).toEqual(originalBytes)
  })

  it.each([
    ['llm:set-default-model', 'model-1'],
    ['llm:set-default-embedding-model', 'embedding-1'],
  ])('refuses to overwrite malformed config through %s', async (channel, modelId) => {
    const configPath = path.join(velaHome, 'config.json')
    const originalBytes = Buffer.from('{BROKEN_DEFAULTS_SECRET_MARKER', 'utf8')
    fs.writeFileSync(configPath, originalBytes)

    await expect(handler(channel)({}, modelId)).resolves.toMatchObject({
      success: false,
      error: expect.any(String),
    })
    expect(fs.readFileSync(configPath)).toEqual(originalBytes)
  })

  it('creates missing model and defaults files through the same public handlers', async () => {
    await expect(handler('llm:save-model')({}, {
      id: 'model-1',
      name: 'Model 1',
    })).resolves.toEqual({ success: true })
    await expect(handler('llm:set-default-model')({}, 'model-1')).resolves.toEqual({ success: true })

    expect(JSON.parse(fs.readFileSync(path.join(velaHome, 'models.json'), 'utf8')))
      .toEqual([expect.objectContaining({ id: 'model-1' })])
    expect(JSON.parse(fs.readFileSync(path.join(velaHome, 'config.json'), 'utf8')))
      .toMatchObject({ defaultModelId: 'model-1' })
  })
})
