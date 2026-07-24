import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  loadElectronBuilderConfig,
  verifyWindowsUpdateArtifacts,
  verifyWindowsUpdateBuildConfig,
} from './verify-win-update-artifacts.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const defaultRepository = Object.freeze({
  owner: 'EthanYoQ',
  repo: 'AI-Novel-Writer',
})
const defaultApiBaseUrl = 'https://api.github.com'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256Hex(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function ensureFile(file, label) {
  assert(typeof file === 'string' && existsSync(file), `Missing local ${label}: ${file}`)
  assert(statSync(file).isFile() && statSync(file).size > 0, `Local ${label} must be a non-empty file: ${file}`)
}

function verifyGithubAssetDigest(asset, localFile, name) {
  assert(
    typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest),
    `GitHub ${name} asset must expose a SHA-256 digest`,
  )
  assert(
    asset.digest.toLowerCase() === `sha256:${sha256Hex(localFile)}`,
    `GitHub ${name} SHA-256 digest does not match the local artifact`,
  )
}

async function fetchJson(fetcher, url, label) {
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AI-Novel-Writer-release-verifier',
    },
  })
  assert(response?.ok, `${label} request failed${response ? ` (${response.status})` : ''}`)
  return response.json()
}

async function fetchBytes(fetcher, url, label) {
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'AI-Novel-Writer-release-verifier',
    },
  })
  assert(response?.ok, `${label} download failed${response ? ` (${response.status})` : ''}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Validates the public GitHub Release after upload. It deliberately verifies the
 * small latest.yml byte-for-byte. GitHub's SHA-256 asset digests authenticate
 * the installer, metadata, and blockmap against the locally verified build.
 */
export async function verifyGithubWindowsUpdateRelease({
  tag,
  localArtifacts,
  fetcher = globalThis.fetch,
  apiBaseUrl = defaultApiBaseUrl,
  repository = defaultRepository,
}) {
  assert(typeof fetcher === 'function', 'A fetch implementation is required to verify the GitHub Release')
  assert(typeof tag === 'string' && /^v\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(tag), 'Release tag must be a final v-prefixed semantic version')
  assert(repository && typeof repository.owner === 'string' && typeof repository.repo === 'string', 'GitHub repository must be configured')
  assert(localArtifacts && typeof localArtifacts === 'object', 'Verified local update artifacts are required')

  const { installer, latestMetadata, blockMap, version } = localArtifacts
  ensureFile(installer, 'Windows installer')
  ensureFile(latestMetadata, 'latest.yml')
  ensureFile(blockMap, 'installer blockmap')
  assert(version === tag.slice(1), `Local artifact version ${version} does not match release tag ${tag}`)

  const encodedTag = encodeURIComponent(tag)
  const apiBase = apiBaseUrl.replace(/\/$/, '')
  const release = await fetchJson(
    fetcher,
    `${apiBase}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/releases/tags/${encodedTag}`,
    'GitHub Release metadata',
  )
  assert(release != null && typeof release === 'object', 'GitHub Release metadata must be an object')
  assert(release.tag_name === tag, `GitHub Release tag ${release.tag_name ?? '(missing)'} does not match ${tag}`)
  assert(release.draft === false, 'GitHub Release must not be a draft')
  assert(release.prerelease === false, 'GitHub Release must not be a prerelease')
  assert(Array.isArray(release.assets), 'GitHub Release assets must be an array')

  const expectedAssets = new Map([
    [path.basename(installer), installer],
    [path.basename(latestMetadata), latestMetadata],
    [path.basename(blockMap), blockMap],
  ])
  const remoteAssets = new Map()
  for (const asset of release.assets) {
    if (asset && typeof asset.name === 'string') remoteAssets.set(asset.name, asset)
  }

  const portableAssets = [...remoteAssets.keys()].filter(name => name.toLowerCase().endsWith('.zip'))
  assert(portableAssets.length === 0, `GitHub Release must not contain portable ZIP archives: ${portableAssets.join(', ')}`)

  for (const [name, localFile] of expectedAssets) {
    const asset = remoteAssets.get(name)
    assert(asset != null && typeof asset === 'object', `GitHub Release is missing required update asset: ${name}`)
    assert(asset.size === statSync(localFile).size, `GitHub asset size does not match local ${name}`)
    verifyGithubAssetDigest(asset, localFile, name)
  }

  const latestAsset = remoteAssets.get(path.basename(latestMetadata))
  assert(typeof latestAsset.browser_download_url === 'string' && latestAsset.browser_download_url.length > 0, 'GitHub latest.yml asset must expose a download URL')
  const remoteLatestMetadata = await fetchBytes(fetcher, latestAsset.browser_download_url, 'GitHub latest.yml')
  const localLatestMetadata = readFileSync(latestMetadata)
  assert(
    Buffer.compare(remoteLatestMetadata, localLatestMetadata) === 0,
    'Public latest.yml differs from the locally verified update metadata',
  )

  return {
    tag,
    releaseId: release.id,
    installer: path.basename(installer),
    latestMetadata: path.basename(latestMetadata),
    blockMap: path.basename(blockMap),
    installerSha256: sha256Hex(installer),
  }
}

async function main() {
  const packageMetadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
  const tag = process.argv[2] ?? `v${packageMetadata.version}`
  const releaseDir = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(repositoryRoot, 'release', packageMetadata.version)
  const config = await loadElectronBuilderConfig(repositoryRoot)
  verifyWindowsUpdateBuildConfig(config)
  const localArtifacts = verifyWindowsUpdateArtifacts(releaseDir, repositoryRoot, packageMetadata.version)
  const result = await verifyGithubWindowsUpdateRelease({ tag, localArtifacts })
  console.log(`Verified public formal GitHub Release: ${result.tag}`)
  console.log(`Verified installer asset: ${result.installer}`)
  console.log(`Verified public latest.yml: ${result.latestMetadata}`)
  console.log(`Verified installer SHA-256: ${result.installerSha256}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
