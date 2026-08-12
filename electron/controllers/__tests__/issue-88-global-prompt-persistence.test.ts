import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../i18n', () => ({
  mainText: (_locale: string, zh: string) => zh,
}))

let velaHome: string

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

describe('global prompt app-data persistence', () => {
  beforeEach(async () => {
    vi.resetModules()
    mocks.handlers.clear()
    velaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-issue-88-'))
    process.env.AI_NOVEL_VELA_HOME = velaHome
    const { registerAppDataController } = await import('../app-data-controller')
    registerAppDataController()
  })

  afterEach(() => {
    delete process.env.AI_NOVEL_VELA_HOME
    fs.rmSync(velaHome, { recursive: true, force: true })
  })

  it('round-trips a globally saved template through the public IPC boundary', async () => {
    const template = {
      key: 'generate_global_config',
      content: 'persisted global prompt',
    }

    await expect(handler('prompt:save-global')({}, template)).resolves.toEqual({ success: true })
    await expect(handler('prompt:load-global')({})).resolves.toEqual({
      templates: [template],
      diagnostics: [],
    })
  })

  it('returns a per-key diagnostic for one corrupt file while retaining unrelated valid prompts', async () => {
    const promptsDirectory = path.join(velaHome, 'prompts')
    fs.mkdirSync(promptsDirectory, { recursive: true })
    fs.writeFileSync(path.join(promptsDirectory, 'broken.json'), '{not json', 'utf8')
    fs.writeFileSync(path.join(promptsDirectory, 'valid.json'), JSON.stringify({
      key: 'valid',
      content: 'still available',
    }), 'utf8')

    await expect(handler('prompt:load-global')({})).resolves.toEqual({
      templates: [{ key: 'valid', content: 'still available' }],
      diagnostics: [{
        key: 'broken',
        path: 'broken.json',
        error: expect.any(String),
      }],
    })
  })
})
