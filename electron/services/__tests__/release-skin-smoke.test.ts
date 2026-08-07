import fs from 'node:fs'
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
import {
  parseReleaseSkinSmokeInvocation,
  runReleaseSkinSmoke,
} from '../release-skin-smoke'

const temporaryRoots: string[] = []
const smokeToken = 'a'.repeat(64)
const controlledPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9p5r8AAAAASUVORK5CYII=', 'base64')

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
    createFromBuffer: vi.fn(() => ({
      isEmpty: () => false,
      getSize: () => ({ width: 1, height: 1 }),
      resize: () => {
        throw new Error('The controlled smoke image must not need resizing')
      },
      toPNG: () => controlledPng,
      toJPEG: () => {
        throw new Error('The controlled PNG smoke image must not be encoded as JPEG')
      },
    })),
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

  it('proves that the packaged anime asset and an isolated custom skin survive import, read, and restart', () => {
    const root = temporaryRoot()
    const builtInAssetPath = path.join(root, 'dist', 'skins', 'anime-night.webp')
    fs.mkdirSync(path.dirname(builtInAssetPath), { recursive: true })
    fs.writeFileSync(builtInAssetPath, Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50,
    ]))

    const imageCodec = createImageCodec()
    const skinRoot = path.join(root, 'isolated-vela-home', 'skins')
    const evidence = withSmokeEnvironment(root, () => runReleaseSkinSmoke(smokeToken, {
      builtInAssetPath,
      createSkinService: () => new SkinService({ rootDirectory: skinRoot, imageCodec }),
    }))

    expect(evidence).toEqual({
      schemaVersion: 1,
      kind: 'packaged-skin-smoke',
      builtInAnime: {
        asset: 'skins/anime-night.webp',
        present: true,
        format: 'webp',
      },
      customSkin: {
        importSucceeded: true,
        readSucceeded: true,
        stateRestored: true,
        activeSkin: 'custom',
        mime: 'image/png',
        width: 1,
        height: 1,
      },
    })
    expect(JSON.stringify(evidence)).not.toContain(root)
  })
})
