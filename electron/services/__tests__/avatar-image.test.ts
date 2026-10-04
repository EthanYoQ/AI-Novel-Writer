import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createFromBuffer: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: mocks.createFromBuffer } }))

import { AVATAR_JPEG_QUALITY, AVATAR_MAX_EDGE, compressAvatarImage } from '../avatar-image'

function image(width: number, height: number, encoded: Buffer) {
  const value = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: vi.fn(() => value),
    toPNG: () => encoded,
    toJPEG: vi.fn(() => encoded),
  }
  return value as unknown as Electron.NativeImage
}

beforeEach(() => mocks.createFromBuffer.mockReset())

describe('compressAvatarImage', () => {
  it('keeps PNG as PNG and scales its longest edge to 256', () => {
    const fake = image(4000, 3000, Buffer.alloc(8))
    mocks.createFromBuffer.mockReturnValue(fake)
    const result = compressAvatarImage(Buffer.alloc(128), 'png')
    expect(fake.resize).toHaveBeenCalledWith({ width: AVATAR_MAX_EDGE, quality: 'good' })
    expect(result.extension).toBe('png')
  })

  it('turns other supported images into JPEG 82', () => {
    const fake = image(3000, 4000, Buffer.alloc(8))
    mocks.createFromBuffer.mockReturnValue(fake)
    expect(compressAvatarImage(Buffer.alloc(128), 'webp').extension).toBe('jpg')
    expect(fake.toJPEG).toHaveBeenCalledWith(AVATAR_JPEG_QUALITY)
  })

  it('keeps the legal original when decoding fails or encoding grows it', () => {
    const original = Buffer.alloc(16)
    mocks.createFromBuffer.mockImplementation(() => { throw new Error('decode') })
    expect(compressAvatarImage(original, 'jpg')).toEqual({ bytes: original, extension: 'jpg' })
    mocks.createFromBuffer.mockReturnValue(image(100, 100, Buffer.alloc(32)))
    expect(compressAvatarImage(original, 'png')).toEqual({ bytes: original, extension: 'png' })
  })
})
