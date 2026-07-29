import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { canonicalPnpmLockfileSha256 } from './canonical-pnpm-lockfile-hash.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function requiredEnvironment(name) {
  const value = process.env[name]
  assert(typeof value === 'string' && value.trim().length > 0, `Missing required environment variable: ${name}`)
  return value.trim()
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function requiredArtifact(releaseDirectory, fileName) {
  const file = path.join(releaseDirectory, fileName)
  assert(existsSync(file), `Missing macOS release artifact: ${file}`)
  const stat = statSync(file)
  assert(stat.isFile() && stat.size > 0, `macOS release artifact must be a non-empty file: ${file}`)
  return {
    file: fileName,
    sizeBytes: stat.size,
    sha256: sha256(file),
  }
}

function requiredEvidence(releaseDirectory, relativePath, expectedKind) {
  const file = path.join(releaseDirectory, ...relativePath.split('/'))
  assert(existsSync(file), `Missing macOS qualification evidence: ${relativePath}`)
  const evidence = JSON.parse(readFileSync(file, 'utf8'))
  assert(evidence?.schemaVersion === 1 && evidence?.kind === expectedKind, `Invalid macOS qualification evidence: ${relativePath}`)
  return relativePath
}

function main() {
  assert(process.platform === 'darwin', 'macOS qualification manifest can only be generated on darwin')
  assert(process.arch === 'arm64', 'macOS qualification manifest requires arm64')
  const packageMetadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
  assert(typeof packageMetadata.version === 'string' && packageMetadata.version.length > 0, 'package.json must declare a version')
  const version = packageMetadata.version
  const releaseDirectory = path.join(repositoryRoot, 'release', version)
  const dmg = `AI小说作家-Mac-${version}-Installer.dmg`
  const artifacts = [requiredArtifact(releaseDirectory, dmg)]
  const evidence = [
    requiredEvidence(releaseDirectory, 'qualification/packaged-vector-smoke.json', 'packaged-vector-smoke'),
    requiredEvidence(releaseDirectory, 'qualification/packaged-official-homepage-smoke.json', 'packaged-official-homepage-smoke'),
    requiredEvidence(releaseDirectory, 'qualification/macos-dmg-smoke.json', 'macos-dmg-smoke'),
  ]
  const manifest = {
    schemaVersion: 1,
    platform: 'darwin',
    arch: 'arm64',
    commit: requiredEnvironment('GITHUB_SHA'),
    lockfileSha256: canonicalPnpmLockfileSha256(path.join(repositoryRoot, 'pnpm-lock.yaml')),
    nodeVersion: process.versions.node,
    pnpmVersion: requiredEnvironment('AI_NOVEL_CLOUD_BUILD_PNPM_VERSION'),
    runnerImage: { os: requiredEnvironment('ImageOS'), version: requiredEnvironment('ImageVersion') },
    gateLevel: 'RUNTIME_VERIFIED',
    releaseCreated: false,
    dmgChecksum: `${dmg}.sha256`,
    artifacts,
    evidence,
  }
  const manifestPath = path.join(releaseDirectory, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(releaseDirectory, manifest.dmgChecksum), `${artifacts[0].sha256}  ${dmg}\n`, 'utf8')
  const checksums = [
    ...artifacts,
    { file: 'manifest.json', sha256: sha256(manifestPath) },
  ]
  writeFileSync(
    path.join(releaseDirectory, 'SHA256SUMS.txt'),
    `${checksums.map(record => `${record.sha256} *${record.file}`).join('\n')}\n`,
    'utf8',
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
