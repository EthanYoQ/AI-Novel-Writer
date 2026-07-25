import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  openExternal: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
  shell: {
    openExternal: mocks.openExternal,
  },
}))

import { registerOfficialHomepageController } from '../official-homepage-controller'

const OFFICIAL_HOMEPAGE_URL = 'https://github.com/EthanYoQ/AI-Novel-Writer'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

describe('official homepage controller', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    registerOfficialHomepageController()
  })

  it('opens only the fixed official repository even when a renderer supplies another URL', async () => {
    mocks.openExternal.mockResolvedValue(undefined)

    await expect(handler('official-homepage:open')(
      {},
      'https://github.com/EthanYoQ/AI-Novel-Writer/issues/25',
    )).resolves.toEqual({ success: true })

    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
    expect(mocks.openExternal).toHaveBeenCalledWith(OFFICIAL_HOMEPAGE_URL)
  })

  it('returns a controlled failure when the system browser cannot open the official repository', async () => {
    mocks.openExternal.mockRejectedValue(new Error('browser unavailable'))

    await expect(handler('official-homepage:open')({})).resolves.toMatchObject({
      success: false,
      error: expect.any(String),
    })
  })
})
