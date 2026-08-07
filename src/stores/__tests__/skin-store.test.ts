import { describe, expect, it, vi } from 'vitest'

import { createSkinStore, type SkinTransport } from '../skin-store'

const customSkinState = (revision = 'revision-1') => ({
  activeSkin: 'custom',
  customSkin: {
    mime: 'image/png',
    revision,
    width: 1600,
    height: 1000,
  },
})

function createHarness(options: {
  state?: ReturnType<typeof customSkinState> | { activeSkin: 'classic'; customSkin: null }
  asset?: unknown
  execute?: unknown
} = {}) {
  const invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case 'skin:get-state':
        return options.state ?? customSkinState()
      case 'skin:read-custom-asset':
        return options.asset ?? {
          success: true,
          mime: 'image/png',
          revision: options.state?.customSkin?.revision ?? 'revision-1',
          bytes: new Uint8Array([137, 80, 78, 71]),
        }
      case 'skin:execute':
        return options.execute ?? {
          success: true,
          state: options.state ?? customSkinState(),
        }
      default:
        throw new Error(`Unexpected channel: ${channel}`)
    }
  })
  const createObjectURL = vi.fn((blob: Blob) => `blob:skin-${blob.size}-${createObjectURL.mock.calls.length}`)
  const revokeObjectURL = vi.fn()
  const store = createSkinStore({
    transport: { invoke } as unknown as SkinTransport,
    createObjectURL,
    revokeObjectURL,
  })

  return { invoke, createObjectURL, revokeObjectURL, store }
}

describe('renderer skin store public seam', () => {
  it('loads a persisted custom skin through IPC and exposes a Blob URL to the renderer', async () => {
    const { store, invoke, createObjectURL } = createHarness()

    await store.getState().init()

    expect(invoke).toHaveBeenCalledWith('skin:get-state')
    expect(invoke).toHaveBeenCalledWith('skin:read-custom-asset')
    expect(store.getState().skinState).toEqual(customSkinState())
    expect(store.getState().backgroundUrl).toMatch(/^blob:skin-/)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('falls back to classic and gives a bilingual non-blocking notice when a custom asset cannot be read', async () => {
    const { store, createObjectURL } = createHarness({
      asset: {
        success: false,
        state: customSkinState(),
        error: { code: 'IMAGE_DECODE_FAILED', message: 'file is corrupted' },
      },
    })

    await store.getState().init()

    expect(store.getState().skinState).toEqual({
      ...customSkinState(),
      activeSkin: 'classic',
    })
    expect(store.getState().backgroundUrl).toBeNull()
    expect(store.getState().notice).toMatchObject({
      zh: expect.stringMatching(/经典/),
      en: expect.stringMatching(/Classic/),
    })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('treats a cancelled import as a successful no-op', async () => {
    const { store, invoke, revokeObjectURL } = createHarness({
      execute: { success: true, cancelled: true, state: customSkinState() },
    })

    await store.getState().init()
    const before = store.getState().backgroundUrl
    await store.getState().importCustomSkin()

    expect(invoke).toHaveBeenCalledWith('skin:execute', { type: 'import-custom' })
    expect(store.getState().backgroundUrl).toBe(before)
    expect(store.getState().notice).toBeNull()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('replaces and disposes Blob URLs when the custom skin changes or the renderer unmounts', async () => {
    let assetRead = 0
    const { store, revokeObjectURL, invoke } = createHarness({
      state: customSkinState('revision-1'),
      asset: undefined,
      execute: { success: true, state: customSkinState('revision-2') },
    })

    invoke.mockImplementation(async (channel: string) => {
      switch (channel) {
        case 'skin:get-state':
          return customSkinState('revision-1')
        case 'skin:read-custom-asset':
          assetRead += 1
          return {
            success: true,
            mime: 'image/png',
            revision: assetRead === 1 ? 'revision-1' : 'revision-2',
            bytes: new Uint8Array(assetRead === 1 ? [1] : [2, 3]),
          }
        case 'skin:execute':
          return { success: true, state: customSkinState('revision-2') }
        default:
          throw new Error(`Unexpected channel: ${channel}`)
      }
    })

    await store.getState().init()
    const firstUrl = store.getState().backgroundUrl
    await store.getState().importCustomSkin()
    const secondUrl = store.getState().backgroundUrl

    expect(secondUrl).not.toBe(firstUrl)
    expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl)

    store.getState().dispose()
    expect(revokeObjectURL).toHaveBeenLastCalledWith(secondUrl)
    expect(store.getState().backgroundUrl).toBeNull()
  })

  it('recovers to classic with a non-blocking notice when the renderer reports an image loading failure', async () => {
    const classicState = { activeSkin: 'classic' as const, customSkin: null }
    const { store, invoke, revokeObjectURL } = createHarness({
      execute: { success: true, state: classicState },
    })

    await store.getState().init()
    const customUrl = store.getState().backgroundUrl
    await store.getState().recoverFromImageFailure()

    expect(invoke).toHaveBeenCalledWith('skin:execute', { type: 'activate', skinId: 'classic' })
    expect(store.getState().skinState).toEqual(classicState)
    expect(store.getState().notice).toMatchObject({
      zh: expect.stringMatching(/经典/),
      en: expect.stringMatching(/Classic/),
    })
    expect(revokeObjectURL).toHaveBeenCalledWith(customUrl)
  })
})
