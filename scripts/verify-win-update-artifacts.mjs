import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const expectedGithubSource = Object.freeze({
  provider: 'github',
  owner: 'EthanYoQ',
  repo: 'AI-Novel-Writer',
  releaseType: 'release',
  channel: 'latest',
  tagNamePrefix: 'v',
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertRecord(value, label) {
  assert(value != null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}

function createElectronBuilderRequire(projectRoot) {
  const packagePath = path.join(projectRoot, 'node_modules', 'electron-builder', 'package.json')
  assert(existsSync(packagePath), `electron-builder is required to verify update artifacts: ${packagePath}`)
  return createRequire(realpathSync(packagePath))
}

function loadYaml(projectRoot, source, label) {
  const electronBuilderRequire = createElectronBuilderRequire(projectRoot)
  const appBuilderPackagePath = electronBuilderRequire.resolve('app-builder-lib/package.json')
  const appBuilderRequire = createRequire(appBuilderPackagePath)
  const { load } = appBuilderRequire('js-yaml')
  const parsed = load(source)
  return assertRecord(parsed, label)
}

function resolveReleaseFile(releaseDir, relativePath, label) {
  assert(typeof relativePath === 'string' && relativePath.length > 0, `${label} must name a release file`)
  const resolvedReleaseDir = path.resolve(releaseDir)
  const resolved = path.resolve(resolvedReleaseDir, relativePath)
  assert(
    resolved.startsWith(`${resolvedReleaseDir}${path.sep}`),
    `${label} must stay inside the release directory: ${relativePath}`,
  )
  return resolved
}

function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

function nonEmptyFile(file, label) {
  assert(existsSync(file), `Missing ${label}: ${file}`)
  assert(statSync(file).isFile(), `${label} must be a file: ${file}`)
  assert(statSync(file).size > 0, `${label} must not be empty: ${file}`)
}

function verifyFormalGithubSource(config, label) {
  const source = assertRecord(config, label)
  for (const [key, expected] of Object.entries(expectedGithubSource)) {
    const requirement = key === 'releaseType'
      ? 'formal GitHub releases (releaseType: release)'
      : `${key}: ${expected}`
    assert(source[key] === expected, `${label} must use ${requirement}`)
  }
  return source
}

function verifyNoPortableZip(releaseDir) {
  const portableArchives = readdirSync(releaseDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
    .map(entry => entry.name)
  assert(
    portableArchives.length === 0,
    `Formal Windows update release must not contain portable ZIP archives: ${portableArchives.join(', ')}`,
  )
}

export function verifyWindowsUpdateArtifacts(releaseDir, projectRoot = repositoryRoot, expectedVersion = null) {
  const resolvedReleaseDir = path.resolve(releaseDir)
  assert(existsSync(resolvedReleaseDir), `Release directory does not exist: ${resolvedReleaseDir}`)
  assert(statSync(resolvedReleaseDir).isDirectory(), `Release path must be a directory: ${resolvedReleaseDir}`)
  verifyNoPortableZip(resolvedReleaseDir)

  const latestMetadata = path.join(resolvedReleaseDir, 'latest.yml')
  nonEmptyFile(latestMetadata, 'latest.yml update metadata')
  const metadata = loadYaml(projectRoot, readFileSync(latestMetadata, 'utf8'), 'latest.yml')
  const version = metadata.version
  assert(
    typeof version === 'string' && /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version),
    'latest.yml must declare a final semantic version',
  )
  if (expectedVersion != null) {
    assert(
      typeof expectedVersion === 'string' && /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(expectedVersion),
      'Expected release version must be a final semantic version',
    )
    assert(version === expectedVersion, `latest.yml version ${version} does not match expected release version ${expectedVersion}`)
  }

  const installerRelativePath = metadata.path
  const installer = resolveReleaseFile(resolvedReleaseDir, installerRelativePath, 'latest.yml path')
  assert(installer.toLowerCase().endsWith('.exe'), 'latest.yml path must point to a Windows installer')
  nonEmptyFile(installer, 'Windows installer')

  const files = metadata.files
  assert(Array.isArray(files) && files.length === 1, 'latest.yml must describe exactly one Windows installer')
  const installerInfo = assertRecord(files[0], 'latest.yml installer entry')
  assert(installerInfo.url === installerRelativePath, 'latest.yml installer entry must resolve to latest.yml path')
  assert(installerInfo.size === statSync(installer).size, 'latest.yml installer size does not match the installer')

  const actualSha512 = sha512Base64(installer)
  assert(installerInfo.sha512 === actualSha512, 'Installer SHA-512 does not match latest.yml')
  assert(metadata.sha512 === actualSha512, 'Top-level installer SHA-512 does not match latest.yml')

  const blockMap = `${installer}.blockmap`
  nonEmptyFile(blockMap, 'Windows differential update blockmap')

  const embeddedUpdateConfig = path.join(resolvedReleaseDir, 'win-unpacked', 'resources', 'app-update.yml')
  nonEmptyFile(embeddedUpdateConfig, 'embedded app-update.yml')
  const updateSource = verifyFormalGithubSource(
    loadYaml(projectRoot, readFileSync(embeddedUpdateConfig, 'utf8'), 'app-update.yml'),
    'app-update.yml',
  )

  return {
    installer,
    latestMetadata,
    blockMap,
    embeddedUpdateConfig,
    version,
    provider: updateSource.provider,
    owner: updateSource.owner,
    repo: updateSource.repo,
    releaseType: updateSource.releaseType,
  }
}

export async function loadElectronBuilderConfig(projectRoot = repositoryRoot) {
  const resolvedProjectRoot = path.resolve(projectRoot)
  const electronBuilderRequire = createElectronBuilderRequire(resolvedProjectRoot)
  const { getConfig } = electronBuilderRequire('app-builder-lib/out/util/config/load')
  const loaded = await getConfig(
    {
      packageKey: 'build',
      configFilename: 'electron-builder',
      projectDir: resolvedProjectRoot,
      packageMetadata: null,
    },
    path.join(resolvedProjectRoot, 'electron-builder.json5'),
  )
  assert(loaded != null, 'electron-builder configuration could not be loaded')
  return assertRecord(loaded.result, 'electron-builder configuration')
}

export function verifyWindowsUpdateBuildConfig(config) {
  const buildConfig = assertRecord(config, 'electron-builder configuration')
  const win = assertRecord(buildConfig.win, 'electron-builder win configuration')
  const nsis = assertRecord(buildConfig.nsis, 'electron-builder NSIS configuration')
  const targets = Array.isArray(win.target) ? win.target : [win.target]
  assert(
    targets.length === 1
      && typeof targets[0] === 'object'
      && targets[0] != null
      && targets[0].target === 'nsis'
      && Array.isArray(targets[0].arch)
      && targets[0].arch.length === 1
      && targets[0].arch[0] === 'x64',
    'electron-builder must target only the x64 Windows NSIS installer',
  )

  const publish = Array.isArray(win.publish) ? win.publish : [win.publish]
  assert(publish.length === 1, 'electron-builder Windows configuration must have one update publisher')
  const updateSource = verifyFormalGithubSource(publish[0], 'electron-builder Windows publish configuration')
  assert(updateSource.publishAutoUpdate === true, 'electron-builder must publish latest.yml update metadata')
  assert(updateSource.tagNamePrefix === 'v', 'electron-builder must use v-prefixed formal release tags')
  assert(
    nsis.artifactName === 'ai-novel-writer-setup-${version}.${ext}',
    'electron-builder NSIS artifactName must match the installer name written to latest.yml',
  )

  return updateSource
}

async function main() {
  const packageMetadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
  const releaseDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repositoryRoot, 'release', packageMetadata.version)
  const config = await loadElectronBuilderConfig(repositoryRoot)
  verifyWindowsUpdateBuildConfig(config)
  const result = verifyWindowsUpdateArtifacts(releaseDir, repositoryRoot, packageMetadata.version)
  console.log(`Verified formal Windows update installer: ${result.installer}`)
  console.log(`Verified latest.yml metadata: ${result.latestMetadata}`)
  console.log(`Verified differential update blockmap: ${result.blockMap}`)
  console.log(`Verified embedded GitHub update source: ${result.owner}/${result.repo}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
