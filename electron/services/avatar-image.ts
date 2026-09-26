import { nativeImage } from 'electron'

export const AVATAR_MAX_EDGE = 256
export const AVATAR_JPEG_QUALITY = 82
export type AvatarImageExtension = 'png' | 'jpg' | 'jpeg' | 'webp'

export interface CompressedAvatar {
  bytes: Buffer
  extension: AvatarImageExtension
}

export function detectAvatarExtension(bytes: Uint8Array): AvatarImageExtension | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
    && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 12 && Buffer.from(bytes).toString('ascii', 0, 4) === 'RIFF'
    && Buffer.from(bytes).toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

export function avatarMime(extension: AvatarImageExtension): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  return 'image/jpeg'
}

export function compressAvatarImage(bytes: Buffer, extension: AvatarImageExtension): CompressedAvatar {
  const unchanged = (): CompressedAvatar => ({ bytes, extension })
  try {
    const image = nativeImage.createFromBuffer(bytes)
    if (!image || image.isEmpty()) return unchanged()
    const { width, height } = image.getSize()
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return unchanged()
    const resized = Math.max(width, height) > AVATAR_MAX_EDGE
      ? width >= height ? image.resize({ width: AVATAR_MAX_EDGE, quality: 'good' }) : image.resize({ height: AVATAR_MAX_EDGE, quality: 'good' })
      : image
    const encoded = extension === 'png' ? resized.toPNG() : resized.toJPEG(AVATAR_JPEG_QUALITY)
    return encoded.byteLength > 0 && encoded.byteLength < bytes.byteLength
      ? { bytes: encoded, extension: extension === 'png' ? 'png' : 'jpg' }
      : unchanged()
  } catch {
    return unchanged()
  }
}
