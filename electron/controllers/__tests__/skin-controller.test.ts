import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown> | unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

vi.mock('../../i18n', () => ({
  mainText: (_locale: string, zh: string) => zh,
}))

import { registerSkinController } from '../skin-controller'

const classicState = { activeSkin: 'classic' as const, customSkin: null }

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

function liveEvent() {
  return {
    sender: {
      id: 17,
      isDestroyed: () => false,
    },
  }
}

describe('skin IPC boundary', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.showOpenDialog.mockReset()
  })

  it('registers the fixed skin channels and returns only renderer-safe state to a live sender', async () => {
    const service = {
      getState: vi.fn(() => classicState),
      activate: vi.fn(),
      importCustomAsset: vi.fn(),
      removeCustom: vi.fn(),
      readCustomAsset: vi.fn(),
    }

    registerSkinController(service)

    expect([...mocks.handlers.keys()].sort()).toEqual([
      'skin:execute',
      'skin:get-state',
      'skin:read-custom-asset',
    ])
    expect(handler('skin:get-state')(liveEvent())).toEqual(classicState)
    expect(service.getState).toHaveBeenCalledOnce()
  })

  it('rejects renderer-supplied file paths before opening a picker or changing state', async () => {
    const service = {
      getState: vi.fn(() => classicState),
      activate: vi.fn(),
      importCustomAsset: vi.fn(),
      removeCustom: vi.fn(),
      readCustomAsset: vi.fn(),
    }
    registerSkinController(service)
    const untrustedPath = 'C:\\Users\\writer\\private-cover.png'

    const result = await handler('skin:execute')(liveEvent(), {
      type: 'import-custom',
      path: untrustedPath,
    })

    expect(result).toEqual({
      success: false,
      state: classicState,
      error: {
        code: 'INVALID_COMMAND',
        message: '皮肤操作无效，已拒绝执行。',
      },
    })
    expect(mocks.showOpenDialog).not.toHaveBeenCalled()
    expect(service.importCustomAsset).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(untrustedPath)
  })

  it('treats a file-picker cancellation as a successful cancelled import', async () => {
    const service = {
      getState: vi.fn(() => classicState),
      activate: vi.fn(),
      importCustomAsset: vi.fn(),
      removeCustom: vi.fn(),
      readCustomAsset: vi.fn(),
    }
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    registerSkinController(service)

    const result = await handler('skin:execute')(liveEvent(), { type: 'import-custom' })

    expect(result).toEqual({ success: true, cancelled: true, state: classicState })
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      properties: ['openFile'],
      filters: [{ name: 'PNG / JPEG', extensions: ['png', 'jpg', 'jpeg'] }],
    }))
    expect(service.importCustomAsset).not.toHaveBeenCalled()
  })

  it('refuses a destroyed sender with a safe response before dispatching its command', async () => {
    const service = {
      getState: vi.fn(() => classicState),
      activate: vi.fn(),
      importCustomAsset: vi.fn(),
      removeCustom: vi.fn(),
      readCustomAsset: vi.fn(),
    }
    registerSkinController(service)

    const result = await handler('skin:execute')({
      sender: { id: 17, isDestroyed: () => true },
    }, { type: 'activate', skinId: 'anime' })

    expect(result).toEqual({
      success: false,
      state: classicState,
      error: {
        code: 'INVALID_SENDER',
        message: '当前窗口无权执行皮肤操作。',
      },
    })
    expect(service.activate).not.toHaveBeenCalled()
  })

  it('returns a custom asset as MIME, revision, and Uint8Array without a path', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const service = {
      getState: vi.fn(() => classicState),
      activate: vi.fn(),
      importCustomAsset: vi.fn(),
      removeCustom: vi.fn(),
      readCustomAsset: vi.fn(() => ({
        success: true as const,
        asset: {
          mime: 'image/png' as const,
          revision: 'a'.repeat(64),
          bytes,
        },
      })),
    }
    registerSkinController(service)

    const result = handler('skin:read-custom-asset')(liveEvent())

    expect(result).toEqual({
      success: true,
      mime: 'image/png',
      revision: 'a'.repeat(64),
      bytes,
    })
  })

  it('does not leak a picker source path when the main process cannot read it', async () => {
    const service = {
      getState: vi.fn(() => classicState),
      activate: vi.fn(),
      importCustomAsset: vi.fn(),
      removeCustom: vi.fn(),
      readCustomAsset: vi.fn(),
    }
    const selectedPath = 'C:\\Users\\writer\\private-cover.png'
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selectedPath] })
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error(`ENOENT: ${selectedPath}`)
    })
    registerSkinController(service)

    const result = await handler('skin:execute')(liveEvent(), { type: 'import-custom' })
    readSpy.mockRestore()

    expect(result).toEqual({
      success: false,
      state: classicState,
      error: {
        code: 'IMAGE_READ_FAILED',
        message: '无法读取所选图片，请重新选择。',
      },
    })
    expect(JSON.stringify(result)).not.toContain(selectedPath)
  })

  it('converts an unexpected service exception into a renderer-safe failure response', async () => {
    const secretPath = 'C:\\Users\\writer\\skins\\manifest.json'
    const service = {
      getState: vi.fn(() => classicState),
      activate: vi.fn(() => {
        throw new Error(`EACCES: ${secretPath}`)
      }),
      importCustomAsset: vi.fn(),
      removeCustom: vi.fn(),
      readCustomAsset: vi.fn(),
    }
    registerSkinController(service)

    const result = await handler('skin:execute')(liveEvent(), { type: 'activate', skinId: 'anime' })

    expect(result).toEqual({
      success: false,
      state: classicState,
      error: {
        code: 'SKIN_SERVICE_UNAVAILABLE',
        message: '皮肤服务暂不可用。',
      },
    })
    expect(JSON.stringify(result)).not.toContain(secretPath)
  })
})
