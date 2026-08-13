import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeLegacyReceipt } from './legacy-qualification-adapter.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const record = (file, relativePath, role) => ({ path: relativePath, role, sizeBytes: statSync(file).size, rawBytesSha256: sha256(readFileSync(file)), hashMode: 'raw-bytes-sha256' })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function options(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    assert(argv[index]?.startsWith('--') && argv[index + 1] !== undefined, `Invalid argument: ${argv[index]}`)
    parsed[argv[index].slice(2)] = argv[index + 1]
  }
  return parsed
}

function main() {
  const input = options(process.argv.slice(2))
  for (const key of ['platform', 'legacy-root', 'output-root', 'profile', 'expected-sha', 'version']) assert(input[key], `--${key} is required`)
  const platform = input.platform
  assert(platform === 'windows' || platform === 'macos', 'platform must equal windows or macos')
  const legacyRoot = path.resolve(input['legacy-root'])
  const outputRoot = path.resolve(input['output-root'])
  const profile = readJson(path.resolve(input.profile))
  const contractFile = path.join(outputRoot, 'release-contract.json')
  const ledgerFile = path.join(outputRoot, 'run-ledger.json')
  const contractRaw = readFileSync(contractFile)
  const contract = JSON.parse(contractRaw)
  const profileRaw = readFileSync(path.resolve(input.profile))
  const profileHash = sha256(profileRaw)
  const contractHash = sha256(contractRaw)
  assert(contract.frozen?.commit === input['expected-sha'] && contract.frozen?.version === input.version && contract.frozen?.profileRawBytesSha256 === profileHash, 'common contract/input/profile binding mismatch')

  const bundleRoot = path.join(outputRoot, 'release-bundle')
  const acceptanceRoot = path.join(outputRoot, 'acceptance')
  rmSync(bundleRoot, { recursive: true, force: true })
  rmSync(acceptanceRoot, { recursive: true, force: true })
  mkdirSync(bundleRoot, { recursive: true })
  mkdirSync(acceptanceRoot, { recursive: true })

  const artifacts = profile.releaseAssets.filter(asset => asset.platform === platform).map(asset => {
    const name = asset.name.replaceAll('{version}', input.version)
    assert(path.basename(name) === name, 'release asset name must be flat')
    const source = path.join(legacyRoot, name)
    const destination = path.join(bundleRoot, name)
    cpSync(source, destination)
    return record(destination, `release-bundle/${name}`, asset.role)
  })

  let signing = null
  const acceptance = profile.platforms[platform].acceptanceReceipts.map(relativePath => {
    const sourceRelative = relativePath.replace(/^acceptance\//, 'qualification/acceptance/')
    const source = path.join(legacyRoot, ...sourceRelative.split('/'))
    const destination = path.join(outputRoot, ...relativePath.split('/'))
    const normalized = normalizeLegacyReceipt({ platform, relativePath, rawBytes: readFileSync(source) })
    writeFileSync(destination, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    if (relativePath.endsWith('/signing.json')) signing = {
      status: normalized.status,
      validationResult: normalized.validationResult,
      unsignedDistributionImpact: normalized.unsignedDistributionImpact,
      evidencePath: relativePath,
    }
    return record(destination, relativePath, 'acceptance-evidence')
  })
  assert(signing, 'signing receipt is missing')

  const ledger = readJson(ledgerFile)
  assert(ledger.qualifiedCommit === input['expected-sha'] && ledger.contractRawBytesSha256 === contractHash && ledger.profileRawBytesSha256 === profileHash && ledger.releaseCreated === false, 'common ledger binding mismatch')
  ledger.signing = signing
  writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  const evidence = [record(contractFile, 'release-contract.json', 'release-contract'), record(ledgerFile, 'run-ledger.json', 'run-ledger'), ...acceptance]
  const manifest = { schemaVersion: 2, gateLevel: 'RUNTIME_VERIFIED', releaseCreated: false, commit: input['expected-sha'], contractRawBytesSha256: contractHash, profileRawBytesSha256: profileHash, artifacts, evidence, signing }
  const manifestFile = path.join(outputRoot, 'manifest.json')
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const paths = [...artifacts, ...evidence].map(item => item.path).concat('manifest.json').sort()
  writeFileSync(path.join(outputRoot, 'SHA256SUMS.txt'), `${paths.map(relativePath => `${sha256(readFileSync(path.join(outputRoot, ...relativePath.split('/'))))}  ${relativePath}`).join('\n')}\n`, 'utf8')
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
