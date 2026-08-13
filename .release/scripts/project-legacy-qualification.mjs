import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const packagedEvidence = {
  macos: [
    'qualification/packaged-vector-smoke.json',
    'qualification/packaged-official-homepage-smoke.json',
    'qualification/packaged-skin-smoke.json',
    'qualification/macos-dmg-smoke.json',
  ],
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    assert(argv[index]?.startsWith('--') && argv[index + 1] !== undefined, `Invalid argument: ${argv[index]}`)
    options[argv[index].slice(2)] = argv[index + 1]
  }
  return options
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function safeRelativePath(value, label) {
  assert(typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.startsWith('/'), `${label} is unsafe`)
  const parts = value.split('/')
  assert(parts.every(part => part && part !== '.' && part !== '..' && !part.includes(':')), `${label} is unsafe`)
  return value
}

function within(root, relativePath, label) {
  const safePath = safeRelativePath(relativePath, label)
  const resolvedRoot = path.resolve(root)
  const file = path.resolve(resolvedRoot, ...safePath.split('/'))
  assert(file.startsWith(`${resolvedRoot}${path.sep}`), `${label} escapes its root`)
  return file
}

function regularSource(root, relativePath) {
  const file = within(root, relativePath, 'Projection source')
  let stat
  try { stat = lstatSync(file) } catch { throw new Error(`Projection source must be a non-empty regular file: ${relativePath}`) }
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, `Projection source must be a non-empty regular file: ${relativePath}`)
  return file
}

function copyExact(sourceRoot, destinationRoot, relativePath) {
  const source = regularSource(sourceRoot, relativePath)
  const destination = within(destinationRoot, relativePath, 'Projection destination')
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(source, destination, { dereference: false, errorOnExist: true })
  assert(sha256(destination) === sha256(source), `Projection changed source bytes: ${relativePath}`)
}

export function projectLegacyQualificationBundle({ platform, version, sourceRoot, outputRoot, profilePath }) {
  assert(platform === 'macos', 'legacy qualification projection currently supports macos only')
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), 'version is invalid')
  const resolvedSourceRoot = path.resolve(sourceRoot)
  const resolvedOutputRoot = path.resolve(outputRoot)
  assert(resolvedSourceRoot !== resolvedOutputRoot, 'projection source and output roots must differ')
  const profile = JSON.parse(readFileSync(path.resolve(profilePath), 'utf8'))
  const releaseAssets = profile.releaseAssets
    .filter(asset => asset.platform === platform)
    .map(asset => asset.name.replaceAll('{version}', version))
  const acceptance = profile.platforms[platform].acceptanceReceipts.map(relativePath => `qualification/${safeRelativePath(relativePath, 'Acceptance receipt')}`)
  const evidence = ['qualification/release-contract.json', 'qualification/run-ledger.json', ...acceptance, ...packagedEvidence[platform]]
  const manifestFile = regularSource(resolvedSourceRoot, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const manifestArtifacts = manifest.artifacts?.map(record => record?.file)
  const manifestEvidence = manifest.evidence?.map(record => record?.file)
  assert(JSON.stringify([...manifestArtifacts].sort()) === JSON.stringify([...releaseAssets].sort()), 'legacy manifest asset set does not match release profile')
  assert(JSON.stringify([...manifestEvidence].sort()) === JSON.stringify([...evidence].sort()), 'legacy manifest evidence set does not match release profile')

  const files = [...releaseAssets, ...evidence, 'manifest.json', 'SHA256SUMS.txt']
  const stageRoot = path.join(path.dirname(resolvedOutputRoot), `.${path.basename(resolvedOutputRoot)}-${process.pid}-${Date.now()}`)
  rmSync(stageRoot, { recursive: true, force: true })
  try {
    mkdirSync(stageRoot, { recursive: false })
    for (const relativePath of files) copyExact(resolvedSourceRoot, stageRoot, relativePath)
    const checksumLines = readFileSync(path.join(stageRoot, 'SHA256SUMS.txt'), 'utf8').trimEnd().split(/\r?\n/)
    const checksums = new Map(checksumLines.map(line => {
      const match = /^([a-f0-9]{64}) \*([^\r\n]+)$/.exec(line)
      assert(match, 'legacy checksum table is invalid')
      return [match[2], match[1]]
    }))
    assert(JSON.stringify([...checksums.keys()].sort()) === JSON.stringify([...files.filter(file => file !== 'SHA256SUMS.txt')].sort()), 'legacy checksum set does not match projected files')
    for (const [relativePath, digest] of checksums) assert(sha256(within(stageRoot, relativePath, 'Projected checksum file')) === digest, `Projected checksum mismatch: ${relativePath}`)
    rmSync(resolvedOutputRoot, { recursive: true, force: true })
    renameSync(stageRoot, resolvedOutputRoot)
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true })
    throw error
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  for (const required of ['platform', 'version', 'source-root', 'output-root', 'profile']) assert(options[required], `--${required} is required`)
  projectLegacyQualificationBundle({
    platform: options.platform,
    version: options.version,
    sourceRoot: options['source-root'],
    outputRoot: options['output-root'],
    profilePath: options.profile,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
