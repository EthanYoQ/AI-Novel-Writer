import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}))

vi.mock('electron', () => ({
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
  velaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-config-corrupt-'))
  process.env.AI_NOVEL_VELA_HOME = velaHome
  const { registerConfigController } = await import('../config-controller')
  registerConfigController()
})

afterEach(() => {
  delete process.env.AI_NOVEL_VELA_HOME
  fs.rmSync(velaHome, { recursive: true, force: true })
})

describe('global configuration corruption boundary', () => {
  it('refuses to overwrite an existing malformed config file', async () => {
    const configPath = path.join(velaHome, 'config.json')
    const originalBytes = Buffer.from('{BROKEN_CONFIG_SECRET_MARKER', 'utf8')
    fs.writeFileSync(configPath, originalBytes)

    await expect(handler('config:set')({}, { theme: 'light' })).resolves.toMatchObject({
      success: false,
      error: expect.any(String),
    })
    expect(fs.readFileSync(configPath)).toEqual(originalBytes)
  })

  it('creates a missing config from defaults', async () => {
    await expect(handler('config:set')({}, { theme: 'light' })).resolves.toEqual({ success: true })

    expect(JSON.parse(fs.readFileSync(path.join(velaHome, 'config.json'), 'utf8'))).toMatchObject({
      theme: 'light',
      defaultModelId: null,
    })
  })
})
