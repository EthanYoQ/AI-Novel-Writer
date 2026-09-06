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
  process.env.AI_NOVEL_VELA_HOME = velaHome
  const { registerLLMController } = await import('../llm-controller')
  registerLLMController()
})

afterEach(() => {
  delete process.env.AI_NOVEL_VELA_HOME
  fs.rmSync(velaHome, { recursive: true, force: true })
})

describe('model configuration corruption boundary', () => {
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
