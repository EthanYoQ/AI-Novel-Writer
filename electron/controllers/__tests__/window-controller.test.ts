import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  appListeners: new Map<string, Set<() => void>>(),
  windows: [] as Array<{ close: () => void; destroyed: boolean }>,
  appExits: 0,
}))

vi.mock('electron', () => ({
  app: {
    on: vi.fn((event: string, listener: () => void) => {
      const listeners = mocks.appListeners.get(event) ?? new Set<() => void>()
      listeners.add(listener)
      mocks.appListeners.set(event, listeners)
    }),
    off: vi.fn((event: string, listener: () => void) => {
      mocks.appListeners.get(event)?.delete(listener)
    }),
    quit: vi.fn(() => {
      for (const listener of mocks.appListeners.get('before-quit') ?? []) listener()
      for (const win of mocks.windows) if (!win.destroyed) win.close()
      if (mocks.windows.every(win => win.destroyed)) mocks.appExits += 1
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)),
  },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: { owner: FakeWindow }) => sender.owner),
  },
}))

import { app } from 'electron'
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
    if (!prevented) {
      this.destroyed = true
      this.listeners.get('closed')?.({ preventDefault: () => {} })
    }
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
    mocks.appListeners.clear()
    mocks.windows.length = 0
    mocks.appExits = 0
    vi.clearAllMocks()
    registerWindowController()
  })

  it('finishes an app quit after the renderer asynchronously approves the intercepted close', async () => {
    const win = new FakeWindow()
    mocks.windows.push(win)
    installWindowCloseGuard(win as never)

    app.quit()
    expect(win.destroyed).toBe(false)
    expect(mocks.appExits).toBe(0)
    expect(win.webContents.send).toHaveBeenCalledWith(
      'window:close-requested',
      expect.objectContaining({ requestId: expect.any(String) }),
    )

    await Promise.resolve()
    await handler('window:resolve-close')({ sender: { owner: win } }, requestId(win), 'proceed')

    expect(win.destroyed).toBe(true)
    expect(mocks.appExits).toBe(1)
    expect(app.quit).toHaveBeenCalledTimes(2)
  })

  it('keeps a normal macOS window close separate from app quit', async () => {
    const win = new FakeWindow()
    installWindowCloseGuard(win as never)

    win.close()
    await handler('window:resolve-close')({ sender: { owner: win } }, requestId(win), 'proceed')

    expect(win.destroyed).toBe(true)
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('clears app quit intent when the renderer cancels', async () => {
    const win = new FakeWindow()
    mocks.windows.push(win)
    installWindowCloseGuard(win as never)

    app.quit()
    await handler('window:resolve-close')({ sender: { owner: win } }, requestId(win), 'cancel')
    expect(win.destroyed).toBe(false)

    win.close()
    await handler('window:resolve-close')({ sender: { owner: win } }, requestId(win), 'proceed')

    expect(win.destroyed).toBe(true)
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(mocks.appExits).toBe(0)
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
