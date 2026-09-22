import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
}))

vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: mocks.createFromBuffer },
}))

import {
  AVATAR_JPEG_QUALITY,
  AVATAR_MAX_EDGE,
  compressAvatarImage,
} from '../avatar-image'

interface FakeImageOptions {
  width?: number
  height?: number
  empty?: boolean
  pngBytes?: number
  jpegBytes?: number
  failEncode?: boolean
}

interface FakeImage {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  resize: ReturnType<typeof vi.fn>
  toPNG: () => Buffer
  toJPEG: (quality: number) => Buffer
}

/** 记录每次 resize / toJPEG 的调用参数，用来断言「按哪一边缩、用什么质量转」。 */
const resizeCalls: Array<{ width?: number; height?: number }> = []
const jpegQualities: number[] = []

function fakeImage(options: FakeImageOptions = {}): FakeImage {
  const width = options.width ?? 4000
  const height = options.height ?? 3000
  return {
    isEmpty: () => options.empty === true,
    getSize: () => ({ width, height }),
    resize: vi.fn((patch: { width?: number; height?: number }) => {
      resizeCalls.push({ width: patch.width, height: patch.height })
      return fakeImage({ ...options, width: patch.width ?? width, height: patch.height ?? height })
    }),
    toPNG: () => {
      if (options.failEncode) throw new Error('png encode failed')
      return Buffer.alloc(options.pngBytes ?? 16, 0x11)
    },
    toJPEG: (quality: number) => {
      jpegQualities.push(quality)
      if (options.failEncode) throw new Error('jpeg encode failed')
      return Buffer.alloc(options.jpegBytes ?? 12, 0x22)
    },
  }
}

function image(fake: FakeImage): Electron.NativeImage {
  return fake as unknown as Electron.NativeImage
}

/** 一张足够大的原图，保证压缩结果一定比它小。 */
function originalBytes(size = 4096): Buffer {
  return Buffer.alloc(size, 0x33)
}

beforeEach(() => {
  resizeCalls.length = 0
  jpegQualities.length = 0
  mocks.createFromBuffer.mockReset()
})

describe('头像落盘前压缩', () => {
  it('横图按宽度缩到 256，PNG 仍存 PNG（保住透明通道）', () => {
    mocks.createFromBuffer.mockReturnValue(image(fakeImage({ width: 4000, height: 3000 })))

    const result = compressAvatarImage(originalBytes(), 'png')

    expect(resizeCalls).toEqual([{ width: AVATAR_MAX_EDGE, height: undefined }])
    expect(result.extension).toBe('png')
    expect(result.bytes).toEqual(Buffer.alloc(16, 0x11))
  })

  it('竖图按高度缩到 256，JPEG 质量 82', () => {
    mocks.createFromBuffer.mockReturnValue(image(fakeImage({ width: 3000, height: 4000 })))

    const result = compressAvatarImage(originalBytes(), 'jpeg')

    expect(resizeCalls).toEqual([{ width: undefined, height: AVATAR_MAX_EDGE }])
    expect(jpegQualities).toEqual([AVATAR_JPEG_QUALITY])
    expect(result.extension).toBe('jpg')
  })

  it('WebP 输入统一转成 JPEG 落盘', () => {
    mocks.createFromBuffer.mockReturnValue(image(fakeImage({ width: 1200, height: 1200 })))

    const result = compressAvatarImage(originalBytes(), 'webp')

    expect(result.extension).toBe('jpg')
    expect(jpegQualities).toEqual([AVATAR_JPEG_QUALITY])
  })

  it('本来就不超过 256 的图不再缩放，只在转码确实更小时才替换', () => {
    mocks.createFromBuffer.mockReturnValue(image(fakeImage({
      width: 200,
      height: 200,
      jpegBytes: 4,
    })))

    const result = compressAvatarImage(originalBytes(64), 'jpg')

    expect(resizeCalls).toEqual([])
    expect(result.bytes.byteLength).toBe(4)
  })

  it('转码后反而更大时保留原图', () => {
    mocks.createFromBuffer.mockReturnValue(image(fakeImage({
      width: 200,
      height: 200,
      jpegBytes: 8192,
    })))
    const original = originalBytes(64)

    const result = compressAvatarImage(original, 'jpg')

    expect(result.bytes).toBe(original)
    expect(result.extension).toBe('jpg')
  })

  it('nativeImage 解不出来时（例如它不认的输入）原样返回', () => {
    mocks.createFromBuffer.mockImplementation(() => {
      throw new Error('unsupported')
    })
    const original = originalBytes()

    expect(compressAvatarImage(original, 'webp')).toEqual({ bytes: original, extension: 'webp' })
  })

  it('空图或尺寸异常时原样返回', () => {
    const original = originalBytes()
    mocks.createFromBuffer.mockReturnValue(image(fakeImage({ empty: true })))
    expect(compressAvatarImage(original, 'png').bytes).toBe(original)

    mocks.createFromBuffer.mockReturnValue(image(fakeImage({ width: 0, height: 0 })))
    expect(compressAvatarImage(original, 'png').bytes).toBe(original)
  })

  it('编码抛错时原样返回 —— 宁可存大图，也不能让上传失败', () => {
    mocks.createFromBuffer.mockReturnValue(image(fakeImage({ failEncode: true })))
    const original = originalBytes()

    const result = compressAvatarImage(original, 'png')

    expect(result.bytes).toBe(original)
    expect(result.extension).toBe('png')
  })
})
