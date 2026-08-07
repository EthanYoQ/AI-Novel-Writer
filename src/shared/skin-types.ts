/**
 * 可跨主进程、预加载与渲染进程传递的皮肤契约。
 * 皮肤资源的绝对路径永远不属于此契约。
 */
export type SkinId = 'classic' | 'anime' | 'custom'

export type SkinAssetMime = 'image/png' | 'image/jpeg'

export interface CustomSkin {
  mime: SkinAssetMime
  revision: string
  width: number
  height: number
}

/** `customSkin !== null` 即表示 customAvailable。 */
export interface SkinState {
  activeSkin: SkinId
  customSkin: CustomSkin | null
}

/** All renderer input is declarative; it never contains a file path or bytes. */
export type SkinCommand =
  | { type: 'activate'; skinId: SkinId }
  | { type: 'import-custom' }
  | { type: 'remove-custom' }

/** Stable, renderer-safe classifications. Paths and native decoder errors never cross IPC. */
export type SkinErrorCode =
  | 'INVALID_COMMAND'
  | 'INVALID_SENDER'
  | 'CUSTOM_SKIN_UNAVAILABLE'
  | 'CUSTOM_ASSET_UNAVAILABLE'
  | 'IMAGE_READ_FAILED'
  | 'IMAGE_FORMAT_INVALID'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_DIMENSIONS_INVALID'
  | 'SKIN_STORAGE_FAILED'
  | 'SKIN_SERVICE_UNAVAILABLE'

export interface SkinError {
  code: SkinErrorCode
  message: string
}

export interface SkinOperationSuccess {
  success: true
  state: SkinState
  cancelled?: false
}

/** Cancel is an expected picker outcome, distinct from an import failure. */
export interface SkinOperationCancelled {
  success: true
  cancelled: true
  state: SkinState
}

export interface SkinOperationFailure {
  success: false
  state: SkinState
  error: SkinError
}

export type SkinExecuteResponse = SkinOperationSuccess | SkinOperationCancelled | SkinOperationFailure

/** Normalized custom-image payload; the renderer never receives a local path. */
export interface SkinAsset {
  mime: SkinAssetMime
  revision: string
  bytes: Uint8Array
}

export type SkinReadCustomAssetResponse = ({ success: true } & SkinAsset) | SkinOperationFailure
