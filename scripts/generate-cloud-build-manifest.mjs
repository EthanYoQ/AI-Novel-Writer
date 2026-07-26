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

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function requiredEnvironment(name) {
  const value = process.env[name]
  assert(typeof value === 'string' && value.trim().length > 0, `Missing required environment variable: ${name}`)
  return value.trim()
}

function nonEmptyFile(file, label) {
  assert(existsSync(file), `Missing ${label}: ${file}`)
  const stat = statSync(file)
  assert(stat.isFile() && stat.size > 0, `${label} must be a non-empty file: ${file}`)
  return stat
}

function releaseDirectoryFromArguments(version) {
  const option = process.argv.findIndex(value => value === '--release-dir')
  if (option < 0) return path.join(repositoryRoot, 'release', version)
  const releaseDir = process.argv[option + 1]
  assert(typeof releaseDir === 'string' && releaseDir.length > 0, '--release-dir requires a path')
  return path.resolve(releaseDir)
}

function artifactRecord(releaseDir, file, label) {
  const stat = nonEmptyFile(file, label)
  return {
    file: path.relative(releaseDir, file).replaceAll(path.sep, '/'),
    sizeBytes: stat.size,
    sha256: sha256(file),
  }
}

function main() {
  const packageMetadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
  assert(typeof packageMetadata.version === 'string' && packageMetadata.version.length > 0, 'package.json must declare a version')

  const releaseDir = releaseDirectoryFromArguments(packageMetadata.version)
  const installer = path.join(releaseDir, `ai-novel-writer-setup-${packageMetadata.version}.exe`)
  const artifacts = [
    artifactRecord(releaseDir, installer, 'Windows installer'),
    artifactRecord(releaseDir, `${installer}.blockmap`, 'Windows installer blockmap'),
    artifactRecord(releaseDir, path.join(releaseDir, 'latest.yml'), 'Windows update metadata'),
  ]

  const manifest = {
    schemaVersion: 1,
    commit: requiredEnvironment('GITHUB_SHA'),
    lockfileSha256: canonicalPnpmLockfileSha256(path.join(repositoryRoot, 'pnpm-lock.yaml')),
    nodeVersion: process.versions.node,
    pnpmVersion: requiredEnvironment('AI_NOVEL_CLOUD_BUILD_PNPM_VERSION'),
    runnerImage: {
      os: requiredEnvironment('ImageOS'),
      version: requiredEnvironment('ImageVersion'),
    },
    gateLevel: 'RUNTIME_VERIFIED',
    releaseCreated: false,
    artifacts,
  }

  const manifestPath = path.join(releaseDir, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const checksums = [
    ...artifacts,
    artifactRecord(releaseDir, manifestPath, 'runtime verification manifest'),
  ].map(artifact => `${artifact.sha256} *${artifact.file}`)
  writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8')

  console.log(`Wrote runtime verification manifest: ${manifestPath}`)
  console.log(`Wrote SHA-256 sums: ${path.join(releaseDir, 'SHA256SUMS.txt')}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
