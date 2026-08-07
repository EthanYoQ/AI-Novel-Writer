import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
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
import {
  parseReleaseSkinSmokeInvocation,
  resolveFileLoadedRendererSkinAssetPath,
  runReleaseSkinSmoke,
} from '../release-skin-smoke'

const temporaryRoots: string[] = []
const smokeToken = 'a'.repeat(64)

function decodedPngSize(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!bytes.subarray(0, signature.length).equals(signature)) {
    throw new Error('The controlled fixture must have a PNG signature')
  }

  let offset = signature.length
  let width: number | undefined
  let height: number | undefined
  const idatChunks: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) throw new Error('The controlled fixture has a truncated PNG chunk')

    const type = bytes.subarray(offset + 4, dataStart).toString('ascii')
    const data = bytes.subarray(dataStart, dataEnd)
    if (type === 'IHDR') {
      if (data.length !== 13) throw new Error('The controlled fixture has an invalid PNG header')
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }

  if (!width || !height || idatChunks.length === 0) {
    throw new Error('The controlled fixture must contain image dimensions and compressed pixels')
  }
  inflateSync(Buffer.concat(idatChunks))
  return { width, height }
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-release-skin-smoke-'))
  temporaryRoots.push(root)
  return root
}

function withSmokeEnvironment<T>(root: string, callback: () => T): T {
  const previous = {
    AI_NOVEL_RELEASE_SKIN_SMOKE: process.env.AI_NOVEL_RELEASE_SKIN_SMOKE,
    AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN: process.env.AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN,
    AI_NOVEL_VELA_HOME: process.env.AI_NOVEL_VELA_HOME,
  }
  process.env.AI_NOVEL_RELEASE_SKIN_SMOKE = '1'
  process.env.AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN = smokeToken
  process.env.AI_NOVEL_VELA_HOME = path.join(root, 'isolated-vela-home')
  try {
    return callback()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function createImageCodec() {
  return {
    createFromBuffer: vi.fn((bytes: Buffer) => {
      const size = decodedPngSize(bytes)
      return {
        isEmpty: () => false,
        getSize: () => size,
        resize: () => {
          throw new Error('The controlled smoke image must not need resizing')
        },
        toPNG: () => Buffer.from(bytes),
        toJPEG: () => {
          throw new Error('The controlled PNG smoke image must not be encoded as JPEG')
        },
      }
    }),
  }
}

afterEach(() => {
  mocks.createFromBuffer.mockReset()
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('packaged skin qualification smoke', () => {
  it('requires a matching one-time command and environment token', () => {
    expect(parseReleaseSkinSmokeInvocation(
      [`--ai-novel-release-skin-smoke=${smokeToken}`],
      {
        AI_NOVEL_RELEASE_SKIN_SMOKE: '1',
        AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN: smokeToken,
      } as unknown as NodeJS.ProcessEnv,
    )).toEqual({ token: smokeToken })
    expect(parseReleaseSkinSmokeInvocation(
      [`--ai-novel-release-skin-smoke=${smokeToken}`],
      {
        AI_NOVEL_RELEASE_SKIN_SMOKE: '1',
        AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN: 'b'.repeat(64),
      } as unknown as NodeJS.ProcessEnv,
    )).toBeUndefined()
  })

  it('resolves the anime asset with the same file:// semantics as BrowserWindow.loadFile', () => {
    const root = temporaryRoot()
    const rendererEntryPath = path.join(root, 'dist', 'index.html')
    const builtInAssetPath = path.join(root, 'dist', 'skins', 'anime-night.webp')
    fs.mkdirSync(path.dirname(builtInAssetPath), { recursive: true })
    fs.writeFileSync(rendererEntryPath, '<!doctype html>')
    fs.writeFileSync(builtInAssetPath, Buffer.from('asset'))

    expect(resolveFileLoadedRendererSkinAssetPath(rendererEntryPath, './skins/anime-night.webp'))
      .toBe(builtInAssetPath)
    expect(() => resolveFileLoadedRendererSkinAssetPath(rendererEntryPath, '/skins/anime-night.webp'))
      .toThrow(/file-loaded renderer/i)
  })

  it('proves that the file-loaded renderer URL resolves the packaged anime asset and an isolated custom skin survives import, read, and restart', () => {
    const root = temporaryRoot()
    const builtInAssetPath = path.join(root, 'dist', 'skins', 'anime-night.webp')
    const rendererEntryPath = path.join(root, 'dist', 'index.html')
    fs.mkdirSync(path.dirname(builtInAssetPath), { recursive: true })
    fs.writeFileSync(rendererEntryPath, '<script type="module" src="./assets/app.js"></script>')
    fs.mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true })
    fs.writeFileSync(path.join(root, 'dist', 'assets', 'app.js'), 'const skin = "./skins/anime-night.webp"')
    fs.writeFileSync(builtInAssetPath, Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]))

    const imageCodec = createImageCodec()
    const skinRoot = path.join(root, 'isolated-vela-home', 'skins')
    const evidence = withSmokeEnvironment(root, () => runReleaseSkinSmoke(smokeToken, {
      rendererEntryPath,
      createSkinService: () => new SkinService({ rootDirectory: skinRoot, imageCodec }),
    }))

    expect(evidence).toEqual({
      schemaVersion: 1,
      kind: 'packaged-skin-smoke',
      builtInAnime: {
        asset: 'skins/anime-night.webp',
        rendererUrl: './skins/anime-night.webp',
        fileLoadable: true,
        present: true,
        format: 'webp',
      },
      customSkin: {
        importSucceeded: true,
        readSucceeded: true,
        stateRestored: true,
        activeSkin: 'custom',
        mime: 'image/png',
        width: 2,
        height: 2,
      },
    })
    expect(JSON.stringify(evidence)).not.toContain(root)
  })
})
