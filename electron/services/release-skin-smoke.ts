import fs from 'node:fs'
import path from 'node:path'

import { SkinService } from './skin-service'

const RELEASE_SKIN_SMOKE_ARGUMENT_PREFIX = '--ai-novel-release-skin-smoke='
const CONTROLLED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9p5r8AAAAASUVORK5CYII=',
  'base64',
)

export interface ReleaseSkinSmokeInvocation {
  token: string
}

export interface ReleaseSkinSmokeEvidence {
  schemaVersion: 1
  kind: 'packaged-skin-smoke'
  builtInAnime: {
    asset: 'skins/anime-night.webp'
    present: true
    format: 'webp'
  }
  customSkin: {
    importSucceeded: true
    readSucceeded: true
    stateRestored: true
    activeSkin: 'custom'
    mime: 'image/png'
    width: number
    height: number
  }
}

export interface ReleaseSkinSmokeDependencies {
  builtInAssetPath?: string
  createSkinService?: () => SkinService
}

let claimedToken: string | undefined

export function releaseSkinSmokeWasRequested(args: readonly string[] = process.argv): boolean {
  return args.some(argument => argument.startsWith(RELEASE_SKIN_SMOKE_ARGUMENT_PREFIX))
}

export function parseReleaseSkinSmokeInvocation(
  args: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ReleaseSkinSmokeInvocation | undefined {
  const matches = args.filter(argument => argument.startsWith(RELEASE_SKIN_SMOKE_ARGUMENT_PREFIX))
  if (matches.length !== 1 || env.AI_NOVEL_RELEASE_SKIN_SMOKE !== '1') return undefined
  const token = matches[0].slice(RELEASE_SKIN_SMOKE_ARGUMENT_PREFIX.length)
  if (!/^[a-f0-9]{32,128}$/i.test(token) || env.AI_NOVEL_RELEASE_SKIN_SMOKE_TOKEN !== token) return undefined
  return { token }
}

export function claimReleaseSkinSmokeInvocation(
  args: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ReleaseSkinSmokeInvocation | undefined {
  const invocation = parseReleaseSkinSmokeInvocation(args, env)
  if (!invocation || claimedToken !== undefined) return undefined
  claimedToken = invocation.token
  return invocation
}

function assertSmokeResult(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Packaged skin smoke failed: ${detail}`)
}

function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function defaultBuiltInAssetPath(): string {
  const publicDirectory = process.env.VITE_PUBLIC
  assertSmokeResult(typeof publicDirectory === 'string' && publicDirectory.length > 0, 'packaged public asset directory is unavailable')
  return path.join(publicDirectory, 'skins', 'anime-night.webp')
}

function requireIsolatedVelaHome(): void {
  const home = process.env.AI_NOVEL_VELA_HOME?.trim()
  assertSmokeResult(Boolean(home), 'AI_NOVEL_VELA_HOME must isolate the skin qualification data')
}

/**
 * Runs from the packaged Electron main entry. It has no filesystem CLI
 * arguments: the qualification wrapper supplies an isolated VELA home and
 * this service uses only a fixed, in-memory PNG to exercise the real storage
 * boundary. The evidence intentionally contains no absolute paths or bytes.
 */
export function runReleaseSkinSmoke(
  token: string,
  dependencies: ReleaseSkinSmokeDependencies = {},
): ReleaseSkinSmokeEvidence {
  const invocation = parseReleaseSkinSmokeInvocation(
    [`${RELEASE_SKIN_SMOKE_ARGUMENT_PREFIX}${token}`],
    process.env,
  )
  if (!invocation || invocation.token !== token) {
    throw new Error('Packaged skin smoke requires its environment and one-time CLI token')
  }
  requireIsolatedVelaHome()

  const builtInAssetPath = dependencies.builtInAssetPath ?? defaultBuiltInAssetPath()
  const builtInAsset = fs.readFileSync(builtInAssetPath)
  assertSmokeResult(isWebp(builtInAsset), 'the packaged anime skin asset is missing or is not WebP')

  const createSkinService = dependencies.createSkinService ?? (() => new SkinService())
  const service = createSkinService()
  service.initialize()
  const imported = service.importCustomAsset(CONTROLLED_PNG)
  assertSmokeResult(imported.success, 'controlled custom PNG import did not succeed')
  const importedCustom = imported.state.customSkin
  assertSmokeResult(
    imported.state.activeSkin === 'custom'
      && importedCustom !== null
      && importedCustom.mime === 'image/png',
    'controlled custom PNG was not made active',
  )

  const read = service.readCustomAsset()
  assertSmokeResult(
    read.success
      && read.asset.mime === importedCustom.mime
      && read.asset.revision === importedCustom.revision
      && read.asset.bytes.byteLength > 0,
    'imported custom PNG could not be read through the renderer-safe boundary',
  )

  const restoredService = createSkinService()
  const restored = restoredService.initialize()
  assertSmokeResult(
    restored.activeSkin === 'custom'
      && restored.customSkin !== null
      && restored.customSkin.revision === importedCustom.revision
      && restored.customSkin.mime === importedCustom.mime
      && restored.customSkin.width === importedCustom.width
      && restored.customSkin.height === importedCustom.height,
    'custom skin state was not restored after a fresh service initialization',
  )
  const restoredRead = restoredService.readCustomAsset()
  assertSmokeResult(
    restoredRead.success
      && restoredRead.asset.revision === importedCustom.revision
      && Buffer.from(restoredRead.asset.bytes).equals(Buffer.from(read.asset.bytes)),
    'restored custom skin asset no longer matches the imported asset',
  )

  return {
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
      width: importedCustom.width,
      height: importedCustom.height,
    },
  }
}
