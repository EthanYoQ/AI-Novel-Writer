import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)),
  },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: { owner: FakeWindow }) => sender.owner),
  },
}))

import { installWindowCloseGuard, registerWindowController } from '../window-controller'

class FakeWindow {
  readonly id = 7
  destroyed = false
  readonly listeners = new Map<string, (event: { preventDefault: () => void }) => void>()
  readonly webContents = {
    isDestroyed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => false),
    send: vi.fn(),
  }
  readonly minimize = vi.fn()
  readonly maximize = vi.fn()
  readonly unmaximize = vi.fn()
  readonly isMaximized = vi.fn(() => false)
  readonly isDestroyed = vi.fn(() => this.destroyed)
  readonly on = vi.fn((event: string, listener: (event: { preventDefault: () => void }) => void) => {
    this.listeners.set(event, listener)
  })
  readonly close = vi.fn(() => {
    let prevented = false
    this.listeners.get('close')?.({ preventDefault: () => { prevented = true } })
    if (!prevented) this.destroyed = true
  })
}

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function requestId(win: FakeWindow): string {
  const [, payload] = win.webContents.send.mock.calls.at(-1) as [string, { requestId: string }]
  return payload.requestId
}

describe('native window close guard', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    vi.clearAllMocks()
    registerWindowController()
  })

  it('routes both system close and the title-bar close action through renderer settlement', async () => {
    const win = new FakeWindow()
    installWindowCloseGuard(win as never)

    win.close()
    expect(win.destroyed).toBe(false)
    expect(win.webContents.send).toHaveBeenCalledWith(
      'window:close-requested',
      expect.objectContaining({ requestId: expect.any(String) }),
    )

    await handler('window:resolve-close')(
      { sender: { owner: win } },
      requestId(win),
      'cancel',
    )
    expect(win.destroyed).toBe(false)

    await handler('window:close')({ sender: { owner: win } })
    const secondRequestId = requestId(win)
    await handler('window:resolve-close')(
      { sender: { owner: win } },
      secondRequestId,
      'proceed',
    )
    expect(win.destroyed).toBe(true)
  })

  it('ignores a stale renderer response from an earlier close request', async () => {
    const win = new FakeWindow()
    installWindowCloseGuard(win as never)

    win.close()
    const first = requestId(win)
    await handler('window:resolve-close')({ sender: { owner: win } }, first, 'cancel')
    win.close()
    const second = requestId(win)

    await expect(handler('window:resolve-close')(
      { sender: { owner: win } },
      first,
      'proceed',
    )).resolves.toEqual({ success: false })
    expect(win.destroyed).toBe(false)

    await handler('window:resolve-close')({ sender: { owner: win } }, second, 'proceed')
    expect(win.destroyed).toBe(true)
  })

  it('allows a clean pre-render window to close without waiting for unavailable renderer state', () => {
    const win = new FakeWindow()
    win.webContents.isLoadingMainFrame.mockReturnValue(true)
    installWindowCloseGuard(win as never)

    win.close()

    expect(win.destroyed).toBe(true)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
