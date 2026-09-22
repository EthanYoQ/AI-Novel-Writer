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

import { registerExternalAiAuditController } from '../external-ai-audit-controller'

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

describe('external AI audit controller', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    registerExternalAiAuditController()
  })

  it('opens the author supplied address in the system browser', async () => {
    mocks.openExternal.mockResolvedValue(undefined)

    await expect(handler('external-ai-audit:open')(
      {},
      'https://chat.deepseek.com/',
    )).resolves.toEqual({ success: true })

    expect(mocks.openExternal).toHaveBeenCalledTimes(1)
    expect(mocks.openExternal).toHaveBeenCalledWith('https://chat.deepseek.com/')
  })

  it('repairs a bare host before handing it to the browser', async () => {
    mocks.openExternal.mockResolvedValue(undefined)

    await expect(handler('external-ai-audit:open')({}, 'www.kimi.com'))
      .resolves.toEqual({ success: true })

    expect(mocks.openExternal).toHaveBeenCalledWith('https://www.kimi.com/')
  })

  it('re-checks the renderer input and refuses non-http protocols', async () => {
    for (const hostile of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      await expect(handler('external-ai-audit:open')({}, hostile)).resolves.toMatchObject({
        success: false,
        error: expect.any(String),
      })
    }

    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('refuses a non-string payload instead of coercing it', async () => {
    await expect(handler('external-ai-audit:open')({}, { url: 'https://chat.deepseek.com/' }))
      .resolves.toMatchObject({ success: false })

    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('returns a controlled failure when the system browser cannot open the page', async () => {
    mocks.openExternal.mockRejectedValue(new Error('browser unavailable'))

    await expect(handler('external-ai-audit:open')({}, 'https://chat.deepseek.com/')).resolves.toMatchObject({
      success: false,
      error: expect.any(String),
    })
  })
})
