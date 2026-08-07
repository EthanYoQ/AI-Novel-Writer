import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { SkinService } from './skin-service'

const RELEASE_SKIN_SMOKE_ARGUMENT_PREFIX = '--ai-novel-release-skin-smoke='
const CONTROLLED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAG0lEQVR4nGMQ0bD5H5BS8Z+hZ8GW/yfufPgPAEfAChWpGdTPAAAAAElFTkSuQmCC',
  'base64',
)
const BUNDLED_ANIME_RENDERER_URL = './skins/anime-night.webp'

export interface ReleaseSkinSmokeInvocation {
  token: string
}

export interface ReleaseSkinSmokeEvidence {
  schemaVersion: 1
  kind: 'packaged-skin-smoke'
  builtInAnime: {
    asset: 'skins/anime-night.webp'
    rendererUrl: './skins/anime-night.webp'
    fileLoadable: true
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
  rendererEntryPath?: string
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

function defaultRendererEntryPath(): string {
  const publicDirectory = process.env.VITE_PUBLIC
  assertSmokeResult(typeof publicDirectory === 'string' && publicDirectory.length > 0, 'packaged public asset directory is unavailable')
  return path.join(publicDirectory, 'index.html')
}

function isChildPath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath)
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

/**
 * Mirrors Chromium's resolution of an img src from BrowserWindow.loadFile().
 * Root-relative Vite public URLs would otherwise resolve outside dist/.
 */
export function resolveFileLoadedRendererSkinAssetPath(
  rendererEntryPath: string,
  rendererAssetUrl: string = BUNDLED_ANIME_RENDERER_URL,
): string {
  const rendererDirectory = path.dirname(rendererEntryPath)
  const entryUrl = pathToFileURL(rendererEntryPath)
  const assetUrl = new URL(rendererAssetUrl, entryUrl)
  assertSmokeResult(assetUrl.protocol === 'file:', 'the renderer anime URL is not file-loadable')
  const assetPath = fileURLToPath(assetUrl)
  assertSmokeResult(
    isChildPath(rendererDirectory, assetPath),
    'the renderer anime URL escapes the file-loaded renderer directory',
  )
  return assetPath
}

function assertRendererBundleUsesAnimeUrl(rendererEntryPath: string): void {
  const assetDirectory = path.join(path.dirname(rendererEntryPath), 'assets')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(assetDirectory, { withFileTypes: true })
  } catch {
    throw new Error('Packaged skin smoke failed: renderer asset bundle directory is unavailable')
  }
  const found = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .some(entry => {
      try {
        return fs.readFileSync(path.join(assetDirectory, entry.name), 'utf8')
          .includes(BUNDLED_ANIME_RENDERER_URL)
      } catch {
        return false
      }
    })
  assertSmokeResult(found, 'the packaged renderer does not retain the file-relative anime URL')
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

  const rendererEntryPath = dependencies.rendererEntryPath ?? defaultRendererEntryPath()
  assertRendererBundleUsesAnimeUrl(rendererEntryPath)
  const builtInAssetPath = resolveFileLoadedRendererSkinAssetPath(rendererEntryPath)
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
      rendererUrl: BUNDLED_ANIME_RENDERER_URL,
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
      width: importedCustom.width,
      height: importedCustom.height,
    },
  }
}
