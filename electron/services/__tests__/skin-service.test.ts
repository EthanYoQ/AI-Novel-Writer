import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFromBuffer: vi.fn(),
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: mocks.createFromBuffer,
  },
}))

import { SkinService } from '../skin-service'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-skins-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  mocks.createFromBuffer.mockReset()
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('SkinService', () => {
  it('initializes an empty skin store as the safe classic state', () => {
    const rootDirectory = temporaryRoot()
    const service = new SkinService({ rootDirectory })

    expect(service.initialize()).toEqual({
      activeSkin: 'classic',
      customSkin: null,
    })
    expect(fs.existsSync(path.join(rootDirectory, 'assets'))).toBe(true)
  })

  it('restores a verified persisted custom skin without exposing its asset path', () => {
    const rootDirectory = temporaryRoot()
    const assetsDirectory = path.join(rootDirectory, 'assets')
    const asset = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    const revision = createHash('sha256').update(asset).digest('hex')
    const assetFile = `${revision}.png`
    fs.mkdirSync(assetsDirectory, { recursive: true })
    fs.writeFileSync(path.join(assetsDirectory, assetFile), asset)
    fs.writeFileSync(path.join(rootDirectory, 'manifest.json'), JSON.stringify({
      version: 1,
      activeSkin: 'custom',
      customSkin: {
        assetFile,
        mime: 'image/png',
        revision,
        width: 1440,
        height: 900,
      },
    }))
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1440, height: 900 }),
      resize: vi.fn(),
      toPNG: vi.fn(),
      toJPEG: vi.fn(),
    })

    const state = new SkinService({ rootDirectory }).initialize()

    expect(state).toEqual({
      activeSkin: 'custom',
      customSkin: {
        mime: 'image/png',
        revision,
        width: 1440,
        height: 900,
      },
    })
    expect(JSON.stringify(state)).not.toContain(rootDirectory)
    expect(JSON.stringify(state)).not.toContain(assetFile)
  })

  it('degrades a manifest with a corrupt custom asset to classic during startup', () => {
    const rootDirectory = temporaryRoot()
    const assetsDirectory = path.join(rootDirectory, 'assets')
    const asset = Buffer.from('not an image')
    const revision = createHash('sha256').update(asset).digest('hex')
    const assetFile = `${revision}.png`
    fs.mkdirSync(assetsDirectory, { recursive: true })
    fs.writeFileSync(path.join(assetsDirectory, assetFile), asset)
    fs.writeFileSync(path.join(rootDirectory, 'manifest.json'), JSON.stringify({
      version: 1,
      activeSkin: 'custom',
      customSkin: {
        assetFile,
        mime: 'image/png',
        revision,
        width: 1440,
        height: 900,
      },
    }))
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => true,
      getSize: () => ({ width: 1440, height: 900 }),
      resize: vi.fn(),
      toPNG: vi.fn(),
      toJPEG: vi.fn(),
    })

    expect(new SkinService({ rootDirectory }).initialize()).toEqual({
      activeSkin: 'classic',
      customSkin: null,
    })
  })

  it('rejects an oversized persisted custom asset before reading bytes or decoding it at startup', () => {
    const rootDirectory = temporaryRoot()
    const assetsDirectory = path.join(rootDirectory, 'assets')
    const revision = 'a'.repeat(64)
    const assetPath = path.join(assetsDirectory, `${revision}.png`)
    fs.mkdirSync(assetsDirectory, { recursive: true })
    fs.writeFileSync(assetPath, Buffer.alloc(0))
    fs.truncateSync(assetPath, 20 * 1024 * 1024 + 1)
    fs.writeFileSync(path.join(rootDirectory, 'manifest.json'), JSON.stringify({
      version: 1,
      activeSkin: 'custom',
      customSkin: {
        assetFile: `${revision}.png`,
        mime: 'image/png',
        revision,
        width: 1440,
        height: 900,
      },
    }))
    const originalReadFileSync = fs.readFileSync
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
      if (String(filePath) === assetPath) throw new Error('oversized asset bytes must not be read')
      return originalReadFileSync(filePath, ...args)
    })

    expect(new SkinService({ rootDirectory }).initialize()).toEqual({
      activeSkin: 'classic',
      customSkin: null,
    })
    expect(readSpy.mock.calls.some(([filePath]) => String(filePath) === assetPath)).toBe(false)
    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
    readSpy.mockRestore()
  })

  it('normalizes a verified PNG into the skin store and activates it', () => {
    const rootDirectory = temporaryRoot()
    const normalized = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    const revision = createHash('sha256').update(normalized).digest('hex')
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 1440, height: 900 }),
      resize: vi.fn(),
      toPNG: () => normalized,
      toJPEG: vi.fn(),
    }
    mocks.createFromBuffer.mockReturnValue(image)
    const service = new SkinService({ rootDirectory })
    service.initialize()

    const result = service.importCustomAsset(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99,
    ]))

    expect(result).toEqual({
      success: true,
      state: {
        activeSkin: 'custom',
        customSkin: {
          mime: 'image/png',
          revision,
          width: 1440,
          height: 900,
        },
      },
    })
    expect(fs.readFileSync(path.join(rootDirectory, 'assets', `${revision}.png`))).toEqual(normalized)
    expect(JSON.parse(fs.readFileSync(path.join(rootDirectory, 'manifest.json'), 'utf8'))).toEqual({
      version: 1,
      activeSkin: 'custom',
      customSkin: {
        assetFile: `${revision}.png`,
        mime: 'image/png',
        revision,
        width: 1440,
        height: 900,
      },
    })
  })

  it('activates an installed built-in skin and persists that choice', () => {
    const rootDirectory = temporaryRoot()
    const service = new SkinService({ rootDirectory })
    service.initialize()

    expect(service.activate('anime')).toEqual({
      success: true,
      state: {
        activeSkin: 'anime',
        customSkin: null,
      },
    })
    expect(JSON.parse(fs.readFileSync(path.join(rootDirectory, 'manifest.json'), 'utf8'))).toEqual({
      version: 1,
      activeSkin: 'anime',
    })
  })

  it('removes a custom skin only after changing the durable active state to classic', () => {
    const rootDirectory = temporaryRoot()
    const normalized = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02])
    const revision = createHash('sha256').update(normalized).digest('hex')
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1440, height: 900 }),
      resize: vi.fn(),
      toPNG: () => normalized,
      toJPEG: vi.fn(),
    })
    const service = new SkinService({ rootDirectory })
    service.initialize()
    expect(service.importCustomAsset(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99,
    ]))).toMatchObject({ success: true })

    expect(service.removeCustom()).toEqual({
      success: true,
      state: {
        activeSkin: 'classic',
        customSkin: null,
      },
    })
    expect(fs.existsSync(path.join(rootDirectory, 'assets', `${revision}.png`))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(rootDirectory, 'manifest.json'), 'utf8'))).toEqual({
      version: 1,
      activeSkin: 'classic',
    })
  })

  it('reads the normalized custom asset as renderer-safe bytes with its revision', () => {
    const rootDirectory = temporaryRoot()
    const normalized = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03])
    const revision = createHash('sha256').update(normalized).digest('hex')
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1440, height: 900 }),
      resize: vi.fn(),
      toPNG: () => normalized,
      toJPEG: vi.fn(),
    })
    const service = new SkinService({ rootDirectory })
    service.initialize()
    expect(service.importCustomAsset(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99,
    ]))).toMatchObject({ success: true })

    const result = service.readCustomAsset()

    expect(result).toEqual({
      success: true,
      asset: {
        mime: 'image/png',
        revision,
        bytes: new Uint8Array(normalized),
      },
    })
    expect(JSON.stringify(result)).not.toContain(rootDirectory)
  })

  it('degrades an active custom skin to classic when its stored asset is later corrupted', () => {
    const rootDirectory = temporaryRoot()
    const normalized = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0a])
    const revision = createHash('sha256').update(normalized).digest('hex')
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1440, height: 900 }),
      resize: vi.fn(),
      toPNG: () => normalized,
      toJPEG: vi.fn(),
    })
    const service = new SkinService({ rootDirectory })
    service.initialize()
    expect(service.importCustomAsset(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99,
    ]))).toMatchObject({ success: true })
    fs.writeFileSync(path.join(rootDirectory, 'assets', `${revision}.png`), Buffer.from('corrupt'))

    expect(service.readCustomAsset()).toEqual({
      success: false,
      code: 'CUSTOM_ASSET_UNAVAILABLE',
      state: {
        activeSkin: 'classic',
        customSkin: null,
      },
    })
    expect(JSON.parse(fs.readFileSync(path.join(rootDirectory, 'manifest.json'), 'utf8'))).toEqual({
      version: 1,
      activeSkin: 'classic',
    })
  })

  it('replaces a custom asset only after the new manifest is durable, then cleans the old asset', () => {
    const rootDirectory = temporaryRoot()
    let normalized = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x04])
    const firstRevision = createHash('sha256').update(normalized).digest('hex')
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1440, height: 900 }),
      resize: vi.fn(),
      toPNG: () => normalized,
      toJPEG: vi.fn(),
    })
    const service = new SkinService({ rootDirectory })
    service.initialize()
    expect(service.importCustomAsset(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99,
    ]))).toMatchObject({ success: true })

    normalized = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x05])
    const secondRevision = createHash('sha256').update(normalized).digest('hex')
    expect(service.importCustomAsset(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x98,
    ]))).toMatchObject({ success: true })

    expect(fs.existsSync(path.join(rootDirectory, 'assets', `${firstRevision}.png`))).toBe(false)
    expect(fs.existsSync(path.join(rootDirectory, 'assets', `${secondRevision}.png`))).toBe(true)
    expect(service.getState()).toMatchObject({
      activeSkin: 'custom',
      customSkin: { revision: secondRevision },
    })
  })

  it('keeps the previous skin active when writing a replacement manifest fails', () => {
    const rootDirectory = temporaryRoot()
    let normalized = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x06])
    const firstRevision = createHash('sha256').update(normalized).digest('hex')
    mocks.createFromBuffer.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1440, height: 900 }),
      resize: vi.fn(),
      toPNG: () => normalized,
      toJPEG: vi.fn(),
    })
    const service = new SkinService({ rootDirectory })
    service.initialize()
    expect(service.importCustomAsset(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99,
    ]))).toMatchObject({ success: true })
    const previousState = service.getState()
    const manifestPath = path.join(rootDirectory, 'manifest.json')
    const previousManifest = fs.readFileSync(manifestPath, 'utf8')

    normalized = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x07])
    const secondRevision = createHash('sha256').update(normalized).digest('hex')
    const originalRenameSync = fs.renameSync
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === manifestPath) {
        const error = new Error('manifest is locked') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return originalRenameSync(from, to)
    })

    const result = service.importCustomAsset(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x98,
    ]))
    renameSpy.mockRestore()

    expect(result).toEqual({
      success: false,
      code: 'SKIN_STORAGE_FAILED',
      state: previousState,
    })
    expect(service.getState()).toEqual(previousState)
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(previousManifest)
    expect(fs.existsSync(path.join(rootDirectory, 'assets', `${firstRevision}.png`))).toBe(true)
    expect(fs.existsSync(path.join(rootDirectory, 'assets', `${secondRevision}.png`))).toBe(false)
    expect(JSON.stringify(result)).not.toContain(rootDirectory)
  })

  it('downscales decoded images above the edge or pixel ceiling before persisting them', () => {
    const rootDirectory = temporaryRoot()
    const normalized = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x08])
    const resized = {
      isEmpty: () => false,
      getSize: () => ({ width: 4096, height: 3072 }),
      resize: vi.fn(),
      toPNG: () => normalized,
      toJPEG: vi.fn(),
    }
    const source = {
      isEmpty: () => false,
      getSize: () => ({ width: 5000, height: 3750 }),
      resize: vi.fn(() => resized),
      toPNG: vi.fn(),
      toJPEG: vi.fn(),
    }
    mocks.createFromBuffer.mockReturnValue(source)
    const service = new SkinService({ rootDirectory })
    service.initialize()

    expect(service.importCustomAsset(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99,
    ]))).toMatchObject({
      success: true,
      state: {
        customSkin: {
          width: 4096,
          height: 3072,
        },
      },
    })
    expect(source.resize).toHaveBeenCalledWith({ width: 4096, height: 3072, quality: 'good' })
  })

  it('rejects images above 20MB before handing bytes to the native decoder', () => {
    const rootDirectory = temporaryRoot()
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1)
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const service = new SkinService({ rootDirectory })
    service.initialize()

    expect(service.importCustomAsset(oversized)).toEqual({
      success: false,
      code: 'IMAGE_TOO_LARGE',
      state: {
        activeSkin: 'classic',
        customSkin: null,
      },
    })
    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
  })
})
