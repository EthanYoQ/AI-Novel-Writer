import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { nativeImage } from 'electron'

import type {
  CustomSkin,
  SkinAsset,
  SkinAssetMime,
  SkinErrorCode,
  SkinId,
  SkinState,
} from '../../src/shared/skin-types'
import { VELA_HOME } from '../utils/config-utils'

/** Same on-disk boundary enforced by the native picker and persisted-asset reads. */
export const MAX_SKIN_INPUT_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_EDGE = 4_096
const MAX_IMAGE_PIXELS = 16_000_000

const CLASSIC_STATE: SkinState = {
  activeSkin: 'classic',
  customSkin: null,
}

export interface SkinServiceOptions {
  rootDirectory?: string
  imageCodec?: SkinImageCodec
}

export interface SkinImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality?: 'good' }): SkinImageLike
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
}

export interface SkinImageCodec {
  createFromBuffer(bytes: Buffer): SkinImageLike
}

export type SkinServiceResult =
  | { success: true; state: SkinState }
  | { success: false; state: SkinState; code: SkinErrorCode }

export type SkinServiceAssetResult =
  | { success: true; asset: SkinAsset }
  | { success: false; state: SkinState; code: SkinErrorCode }

class SkinServiceFailure extends Error {
  constructor(readonly code: SkinErrorCode) {
    super(code)
  }
}

interface SkinManifest {
  version: 1
  activeSkin: SkinId
  customSkin?: {
    assetFile: string
    mime: SkinAssetMime
    revision: string
    width: number
    height: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSkinId(value: unknown): value is SkinId {
  return value === 'classic' || value === 'anime' || value === 'custom'
}

function isSkinAssetMime(value: unknown): value is SkinAssetMime {
  return value === 'image/png' || value === 'image/jpeg'
}

function isPositiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isStoredDimension(value: unknown): value is number {
  return isPositiveDimension(value) && value <= MAX_IMAGE_EDGE
}

function isImageSize(value: { width: number; height: number }): boolean {
  return isPositiveDimension(value.width) && isPositiveDimension(value.height)
}

function detectImageMime(bytes: Buffer): SkinAssetMime | undefined {
  const png = bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  if (png) return 'image/png'

  const jpeg = bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  return jpeg ? 'image/jpeg' : undefined
}

function scaledImageSize(size: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(
    1,
    MAX_IMAGE_EDGE / Math.max(size.width, size.height),
    Math.sqrt(MAX_IMAGE_PIXELS / (size.width * size.height)),
  )
  return {
    width: Math.max(1, Math.floor(size.width * scale)),
    height: Math.max(1, Math.floor(size.height * scale)),
  }
}

function needsScaling(size: { width: number; height: number }): boolean {
  return size.width > MAX_IMAGE_EDGE
    || size.height > MAX_IMAGE_EDGE
    || size.width * size.height > MAX_IMAGE_PIXELS
}

function assetFileFor(customSkin: CustomSkin): string {
  return `${customSkin.revision}.${customSkin.mime === 'image/png' ? 'png' : 'jpg'}`
}

function writeFileAtomically(filePath: string, content: string | Buffer): void {
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let descriptor: number | undefined
  fs.mkdirSync(directory, { recursive: true })
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, filePath)
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Preserve the original filesystem failure.
      }
    }
    try {
      fs.unlinkSync(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[Vela Skin] Unable to remove temporary skin file.', error)
      }
    }
  }
}

function customSkinFromManifest(value: unknown): SkinManifest['customSkin'] | undefined {
  if (!isRecord(value)) return undefined
  const { assetFile, mime, revision, width, height } = value
  if (
    typeof assetFile !== 'string'
    || !isSkinAssetMime(mime)
    || typeof revision !== 'string'
    || !/^[a-f0-9]{64}$/.test(revision)
    || !isStoredDimension(width)
    || !isStoredDimension(height)
    || width * height > 16_000_000
  ) {
    return undefined
  }
  const extension = mime === 'image/png' ? 'png' : 'jpg'
  if (assetFile !== `${revision}.${extension}`) return undefined
  return { assetFile, mime, revision, width, height }
}

function parseManifest(value: unknown): SkinManifest | undefined {
  if (!isRecord(value) || value.version !== 1 || !isSkinId(value.activeSkin)) return undefined
  if (value.customSkin === undefined) {
    return value.activeSkin === 'custom'
      ? undefined
      : { version: 1, activeSkin: value.activeSkin }
  }
  const customSkin = customSkinFromManifest(value.customSkin)
  if (!customSkin) return undefined
  return { version: 1, activeSkin: value.activeSkin, customSkin }
}

/**
 * Owns the durable, renderer-safe skin state. File paths are intentionally
 * confined to this service and never enter the shared IPC contract.
 */
export class SkinService {
  private readonly rootDirectory: string
  private readonly imageCodec: SkinImageCodec
  private state: SkinState = CLASSIC_STATE

  constructor(options: SkinServiceOptions = {}) {
    this.rootDirectory = options.rootDirectory ?? path.join(VELA_HOME, 'skins')
    this.imageCodec = options.imageCodec ?? {
      createFromBuffer: bytes => nativeImage.createFromBuffer(bytes) as unknown as SkinImageLike,
    }
  }

  initialize(): SkinState {
    try {
      fs.mkdirSync(path.join(this.rootDirectory, 'assets'), { recursive: true })
      this.state = this.loadPersistedState()
    } catch {
      this.state = CLASSIC_STATE
    }
    return this.getState()
  }

  getState(): SkinState {
    return {
      activeSkin: this.state.activeSkin,
      customSkin: this.state.customSkin ? { ...this.state.customSkin } : null,
    }
  }

  importCustomAsset(input: Uint8Array): SkinServiceResult {
    let createdAssetFile: string | undefined
    let previousAssetFile: string | undefined
    try {
      if (!(input instanceof Uint8Array)) {
        throw new SkinServiceFailure('IMAGE_FORMAT_INVALID')
      }
      const source = Buffer.from(input)
      if (source.byteLength > MAX_SKIN_INPUT_BYTES) {
        throw new SkinServiceFailure('IMAGE_TOO_LARGE')
      }
      const mime = detectImageMime(source)
      if (!mime) throw new SkinServiceFailure('IMAGE_FORMAT_INVALID')

      let image: SkinImageLike
      try {
        image = this.imageCodec.createFromBuffer(source)
      } catch {
        throw new SkinServiceFailure('IMAGE_DECODE_FAILED')
      }
      if (!image || image.isEmpty()) throw new SkinServiceFailure('IMAGE_DECODE_FAILED')

      const decodedSize = image.getSize()
      if (!isImageSize(decodedSize)) throw new SkinServiceFailure('IMAGE_DIMENSIONS_INVALID')
      if (needsScaling(decodedSize)) {
        image = image.resize({ ...scaledImageSize(decodedSize), quality: 'good' })
      }
      const size = image.getSize()
      if (!isImageSize(size) || needsScaling(size)) {
        throw new SkinServiceFailure('IMAGE_DIMENSIONS_INVALID')
      }

      const bytes = mime === 'image/png' ? image.toPNG() : image.toJPEG(90)
      if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
        throw new SkinServiceFailure('IMAGE_DECODE_FAILED')
      }
      const revision = createHash('sha256').update(bytes).digest('hex')
      const extension = mime === 'image/png' ? 'png' : 'jpg'
      const assetFile = `${revision}.${extension}`
      const customSkin: CustomSkin = {
        mime,
        revision,
        width: size.width,
        height: size.height,
      }
      const nextState: SkinState = { activeSkin: 'custom', customSkin }
      previousAssetFile = this.state.customSkin ? assetFileFor(this.state.customSkin) : undefined

      if (this.writeAssetIfMissing(assetFile, bytes)) createdAssetFile = assetFile
      this.writeManifest(nextState)
      this.state = nextState
      if (previousAssetFile && previousAssetFile !== assetFile) {
        this.cleanupAsset(previousAssetFile)
      }
      return { success: true, state: this.getState() }
    } catch (error) {
      // The previous manifest is still authoritative. Only remove an asset
      // proved to be created by this transaction and not referenced by it.
      if (createdAssetFile && createdAssetFile !== previousAssetFile) {
        this.cleanupAsset(createdAssetFile)
      }
      const code = error instanceof SkinServiceFailure ? error.code : 'SKIN_STORAGE_FAILED'
      return { success: false, state: this.getState(), code }
    }
  }

  activate(skinId: SkinId): SkinServiceResult {
    if (!isSkinId(skinId)) {
      return { success: false, state: this.getState(), code: 'INVALID_COMMAND' }
    }
    if (skinId === 'custom' && !this.state.customSkin) {
      return { success: false, state: this.getState(), code: 'CUSTOM_SKIN_UNAVAILABLE' }
    }

    const nextState: SkinState = {
      activeSkin: skinId,
      customSkin: this.state.customSkin ? { ...this.state.customSkin } : null,
    }
    try {
      this.writeManifest(nextState)
      this.state = nextState
      return { success: true, state: this.getState() }
    } catch {
      return { success: false, state: this.getState(), code: 'SKIN_STORAGE_FAILED' }
    }
  }

  removeCustom(): SkinServiceResult {
    const previousCustomSkin = this.state.customSkin
    if (!previousCustomSkin) {
      return { success: false, state: this.getState(), code: 'CUSTOM_SKIN_UNAVAILABLE' }
    }
    const nextState: SkinState = {
      activeSkin: this.state.activeSkin === 'custom' ? 'classic' : this.state.activeSkin,
      customSkin: null,
    }
    try {
      this.writeManifest(nextState)
    } catch {
      return { success: false, state: this.getState(), code: 'SKIN_STORAGE_FAILED' }
    }

    this.state = nextState
    this.cleanupAsset(assetFileFor(previousCustomSkin))
    return { success: true, state: this.getState() }
  }

  readCustomAsset(): SkinServiceAssetResult {
    const customSkin = this.state.customSkin
    if (!customSkin) {
      return { success: false, state: this.getState(), code: 'CUSTOM_ASSET_UNAVAILABLE' }
    }

    try {
      const bytes = this.readStoredAsset(customSkin)
      if (
        createHash('sha256').update(bytes).digest('hex') !== customSkin.revision
        || detectImageMime(bytes) !== customSkin.mime
      ) {
        throw new SkinServiceFailure('CUSTOM_ASSET_UNAVAILABLE')
      }
      const image = this.imageCodec.createFromBuffer(bytes)
      const size = image.getSize()
      if (
        image.isEmpty()
        || !isImageSize(size)
        || size.width !== customSkin.width
        || size.height !== customSkin.height
      ) {
        throw new SkinServiceFailure('CUSTOM_ASSET_UNAVAILABLE')
      }
      return {
        success: true,
        asset: {
          mime: customSkin.mime,
          revision: customSkin.revision,
          bytes: new Uint8Array(bytes),
        },
      }
    } catch {
      return this.degradeCorruptCustomAsset(customSkin)
    }
  }

  private writeAssetIfMissing(assetFile: string, bytes: Buffer): boolean {
    const assetPath = path.join(this.rootDirectory, 'assets', assetFile)
    if (fs.existsSync(assetPath)) {
      if (!fs.statSync(assetPath).isFile()) throw new SkinServiceFailure('SKIN_STORAGE_FAILED')
      return false
    }
    writeFileAtomically(assetPath, bytes)
    return true
  }

  private readStoredAsset(customSkin: CustomSkin): Buffer {
    const assetPath = path.join(this.rootDirectory, 'assets', assetFileFor(customSkin))
    const stat = fs.statSync(assetPath)
    if (
      !stat.isFile()
      || !Number.isSafeInteger(stat.size)
      || stat.size <= 0
      || stat.size > MAX_SKIN_INPUT_BYTES
    ) {
      throw new SkinServiceFailure('CUSTOM_ASSET_UNAVAILABLE')
    }
    const bytes = fs.readFileSync(assetPath)
    if (bytes.byteLength !== stat.size || bytes.byteLength > MAX_SKIN_INPUT_BYTES) {
      throw new SkinServiceFailure('CUSTOM_ASSET_UNAVAILABLE')
    }
    return bytes
  }

  private writeManifest(state: SkinState): void {
    const manifest: SkinManifest = {
      version: 1,
      activeSkin: state.activeSkin,
      ...(state.customSkin ? {
        customSkin: {
          assetFile: assetFileFor(state.customSkin),
          ...state.customSkin,
        },
      } : {}),
    }
    writeFileAtomically(
      path.join(this.rootDirectory, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    )
  }

  private cleanupAsset(assetFile: string): void {
    if (!/^[a-f0-9]{64}\.(?:png|jpg)$/.test(assetFile)) return
    try {
      fs.unlinkSync(path.join(this.rootDirectory, 'assets', assetFile))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[Vela Skin] Unable to clean up a previous skin asset.', error)
      }
    }
  }

  private degradeCorruptCustomAsset(customSkin: CustomSkin): SkinServiceAssetResult {
    const nextState: SkinState = {
      activeSkin: this.state.activeSkin === 'custom' ? 'classic' : this.state.activeSkin,
      customSkin: null,
    }
    try {
      this.writeManifest(nextState)
      this.cleanupAsset(assetFileFor(customSkin))
    } catch {
      // A damaged asset must never keep the renderer in custom mode just
      // because its manifest could not be rewritten.
    }
    this.state = nextState
    return { success: false, state: this.getState(), code: 'CUSTOM_ASSET_UNAVAILABLE' }
  }

  private loadPersistedState(): SkinState {
    const manifestPath = path.join(this.rootDirectory, 'manifest.json')
    if (!fs.existsSync(manifestPath)) return CLASSIC_STATE

    let parsed: SkinManifest | undefined
    try {
      parsed = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
    } catch {
      return CLASSIC_STATE
    }
    if (!parsed) return CLASSIC_STATE

    let customSkin: CustomSkin | null = null
    if (parsed.customSkin) {
      try {
        const bytes = this.readStoredAsset(parsed.customSkin)
        const revision = createHash('sha256').update(bytes).digest('hex')
        const image = this.imageCodec.createFromBuffer(bytes)
        const size = image.getSize()
        if (
          revision === parsed.customSkin.revision
          && detectImageMime(bytes) === parsed.customSkin.mime
          && !image.isEmpty()
          && isImageSize(size)
          && size.width === parsed.customSkin.width
          && size.height === parsed.customSkin.height
        ) {
          customSkin = {
            mime: parsed.customSkin.mime,
            revision,
            width: parsed.customSkin.width,
            height: parsed.customSkin.height,
          }
        }
      } catch {
        customSkin = null
      }
    }

    if (parsed.activeSkin === 'custom' && !customSkin) return CLASSIC_STATE
    return {
      activeSkin: parsed.activeSkin,
      customSkin,
    }
  }
}

/** The single process-local skin store used by IPC registrations. */
export const skinService = new SkinService()
