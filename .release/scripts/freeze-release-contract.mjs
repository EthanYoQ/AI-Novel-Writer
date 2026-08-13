import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReleaseProfile } from './validate-release-profile.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    assert(key?.startsWith('--') && value !== undefined, `Invalid argument: ${key}`)
    options[key.slice(2)] = value
  }
  return options
}

function strictJson(raw, label) {
  assert(!(raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), `${label} must be UTF-8 without BOM`)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  for (const key of ['repository', 'expected-sha', 'tag', 'version', 'profile', 'output-root', 'platform', 'run-id', 'run-attempt', 'workflow', 'actor', 'event']) assert(options[key], `--${key} is required`)
  assert(/^[a-f0-9]{40}$/.test(options['expected-sha']), 'expected SHA must be lowercase and full length')
  assert(options.tag === `v${options.version}`, 'tag must equal v<version>')
  assert(options.platform === 'windows' || options.platform === 'macos', 'platform must equal windows or macos')
  assert(options.event === 'workflow_dispatch', 'event must equal workflow_dispatch')

  const profilePath = path.resolve(options.profile)
  const profileRaw = readFileSync(profilePath)
  const profile = strictJson(profileRaw, 'release profile')
  const profileValidation = validateReleaseProfile(profile)
  assert(profileValidation.ok, `release profile is invalid: ${profileValidation.errors.join('; ')}`)
  assert(profile.platforms[options.platform].qualificationWorkflow === options.workflow, 'workflow does not match release profile')
  const packageMetadata = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'))
  assert(packageMetadata.version === options.version, 'release version does not match package.json')

  const profileRelative = path.relative(path.resolve('.'), profilePath).replaceAll('\\', '/')
  assert(profileRelative === '.release/release-profile.json', 'release profile must use the committed project path')
  const profileRawBytesSha256 = sha256(profileRaw)
  const contract = {
    schemaVersion: 2,
    stage: 'qualification',
    repository: options.repository,
    frozen: {
      commit: options['expected-sha'],
      tag: options.tag,
      version: options.version,
      profilePath: profileRelative,
      profileRawBytesSha256,
    },
  }
  const outputRoot = path.resolve(options['output-root'])
  mkdirSync(outputRoot, { recursive: true })
  const contractPath = path.join(outputRoot, 'release-contract.json')
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  const contractRawBytesSha256 = sha256(readFileSync(contractPath))
  const ledger = {
    schemaVersion: 2,
    platform: options.platform,
    workflow: options.workflow,
    runId: Number(options['run-id']),
    runAttempt: Number(options['run-attempt']),
    repository: options.repository,
    actor: options.actor,
    event: options.event,
    qualifiedCommit: options['expected-sha'],
    releaseTag: options.tag,
    releaseVersion: options.version,
    releaseCreated: false,
    contractRawBytesSha256,
    profileRawBytesSha256,
  }
  assert(Number.isSafeInteger(ledger.runId) && ledger.runId > 0 && Number.isSafeInteger(ledger.runAttempt) && ledger.runAttempt > 0, 'run identity must use positive integers')
  writeFileSync(path.join(outputRoot, 'run-ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
