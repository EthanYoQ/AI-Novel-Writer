/**
 * 角色头像的落盘前压缩。
 *
 * 先生：长篇小说后期角色可能上千个 —— 原图直接存会让项目目录涨到 GB 级，
 * 关系图谱一次性读全员头像时更是会把渲染层直接拖垮。所以头像在落盘前统一
 * 压到最长边 256px：图谱里最大的圈是 104px，2 倍屏也只要 208px，256 足够清晰。
 *
 * 为什么不用新依赖：Electron 主进程自带 nativeImage，解码 / 等比缩放 / 转码都是现成的。
 * 为什么不做成「失败就报错」：上传头像失败比存一张大图糟糕得多 ——
 * 任何一步出岔子都原样返回原图（于是它至少还是能用的）。
 *
 * 输出格式：
 *   · 原始是 PNG → 存 PNG（保住透明通道，插画头像不会被压成黑底）
 *   · 其余（JPEG / WebP）→ 转 JPEG，质量 82（照片类头像通常能降到 15–30 KB）
 *   · 压完反而更大（原图本来就是小图）→ 保留原图
 */

import { nativeImage } from 'electron'

/** 头像最长边上限（px）。 */
export const AVATAR_MAX_EDGE = 256
/** 转 JPEG 时的质量。 */
export const AVATAR_JPEG_QUALITY = 82

/** 头像允许的落盘扩展名；与 character-avatar-controller 的白名单是同一组。 */
export type AvatarImageExtension = 'png' | 'jpg' | 'jpeg' | 'webp'

export interface CompressedAvatar {
  bytes: Buffer
  /** 落盘用的扩展名；压缩失败时就是原来的那个。 */
  extension: AvatarImageExtension
}

function unchanged(bytes: Buffer, extension: AvatarImageExtension): CompressedAvatar {
  return { bytes, extension }
}

/**
 * 把一张头像压到最长边 256px。
 *
 * @param bytes     已通过魔数校验的原图字节
 * @param extension 原图扩展名（png / jpg / jpeg / webp）
 */
export function compressAvatarImage(
  bytes: Buffer,
  extension: AvatarImageExtension,
): CompressedAvatar {
  let image: Electron.NativeImage
  try {
    image = nativeImage.createFromBuffer(bytes)
  } catch {
    // 解不出来（例如 WebP 这类 nativeImage 不认的输入）就原样存。
    return unchanged(bytes, extension)
  }
  if (!image || image.isEmpty()) return unchanged(bytes, extension)

  try {
    const { width, height } = image.getSize()
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return unchanged(bytes, extension)
    }

    // 只给一个维度，另一个按比例走 —— 头像不会被拉变形。
    const resized = Math.max(width, height) > AVATAR_MAX_EDGE
      ? (width >= height
        ? image.resize({ width: AVATAR_MAX_EDGE, quality: 'good' })
        : image.resize({ height: AVATAR_MAX_EDGE, quality: 'good' }))
      : image

    if (extension === 'png') {
      const encoded = resized.toPNG()
      return encoded.byteLength > 0 && encoded.byteLength < bytes.byteLength
        ? { bytes: encoded, extension: 'png' }
        : unchanged(bytes, extension)
    }

    const encoded = resized.toJPEG(AVATAR_JPEG_QUALITY)
    return encoded.byteLength > 0 && encoded.byteLength < bytes.byteLength
      ? { bytes: encoded, extension: 'jpg' }
      : unchanged(bytes, extension)
  } catch {
    return unchanged(bytes, extension)
  }
}
