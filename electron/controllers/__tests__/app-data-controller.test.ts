import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  writeJsonFile: vi.fn(),
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

vi.mock('../../utils/config-utils', () => ({
  VELA_HOME: 'C:\\vela-app-data',
  writeJsonFile: mocks.writeJsonFile,
}))

import { registerAppDataController } from '../app-data-controller'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

describe('fixed app-data IPC boundary', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.writeJsonFile.mockReset()
    registerAppDataController()
  })

  it('passes the template argument after the Electron event and writes only beneath VELA_HOME', async () => {
    await expect(handler('prompt:save-global')(
      { sender: { id: 7 } },
      { key: 'style-guide', content: 'keep this prompt' },
    )).resolves.toEqual({ success: true })

    expect(mocks.writeJsonFile).toHaveBeenCalledWith(
      expect.stringMatching(/vela-app-data[\\/]prompts[\\/]style-guide\.json$/),
      { key: 'style-guide', content: 'keep this prompt' },
    )
  })
})
