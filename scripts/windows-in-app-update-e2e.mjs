/* eslint-env node */

import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(scriptPath), '..')
const apiBaseUrl = 'https://api.github.com'

/** The release source is deliberately not configurable by workflow inputs or CLI flags. */
export const OFFICIAL_UPDATE_REPOSITORY = Object.freeze({
  owner: 'EthanYoQ',
  repo: 'AI-Novel-Writer',
})

// A cold GitHub Windows runner spends around 15 seconds compiling the monitor's
// native Job Object helper before it can publish `ready`.
export const WINDOWS_RELEASE_MONITOR_READY_TIMEOUT_MS = 60_000
export const WINDOWS_UPDATE_RUNNER_COMMAND = 'pwsh.exe'
const LEGACY_UPDATE_BRIDGE_FIRST_NATIVE_SILENT_SOURCE_TAG = 'v0.7.0'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertRecord(value, label) {
  assert(value != null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha512Base64(bytes) {
  return createHash('sha512').update(bytes).digest('base64')
}

function wait(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

/**
 * Inputs must name a final release only. We normalize an optional historical
 * v-prefix but never accept a ref, a URL, a prerelease, or build metadata.
 */
export function normalizeFinalReleaseTag(value, label) {
  assert(
    typeof value === 'string' && /^(?:v)?\d+\.\d+\.\d+$/.test(value),
    `${label} must be a final semantic version such as v0.6.0`,
  )
  return value.startsWith('v') ? value : `v${value}`
}

function parseVersion(tag) {
  const normalized = normalizeFinalReleaseTag(tag, 'release tag')
  return normalized.slice(1).split('.').map(part => Number.parseInt(part, 10))
}

function compareFinalVersions(left, right) {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

/**
 * The v0.5/v0.6 updater starts an assisted NSIS wizard because it calls
 * quitAndInstall(false, false). This test-only bridge is deliberately
 * unavailable once v0.7.0 is the source: v0.7.0 ships the native silent
 * invocation and must prove that behavior without a harness substitution.
 *
 * All installer metadata is copied from the digest-authenticated release plan;
 * callers cannot select a different repository, asset, or pending path.
 */
export function createLegacyUpdateBridgePlan(plan, { localAppData = process.env.LOCALAPPDATA } = {}) {
  const record = assertRecord(plan, 'release plan')
  const source = assertRecord(record.from, 'release plan from')
  const expected = assertRecord(record.expected, 'release plan expected')
  const sourceTag = normalizeFinalReleaseTag(source.tag, 'release plan from tag')
  normalizeFinalReleaseTag(expected.tag, 'release plan expected tag')
  if (compareFinalVersions(sourceTag, LEGACY_UPDATE_BRIDGE_FIRST_NATIVE_SILENT_SOURCE_TAG) >= 0) return null

  assert(
    typeof localAppData === 'string' && /^[A-Za-z]:[\\/]/.test(localAppData),
    'LOCALAPPDATA must be an absolute Windows path for the legacy update bridge',
  )
  const assets = assertRecord(expected.assets, 'release plan expected assets')
  const installer = assertRecord(assets.installer, 'release plan expected installer')
  assert(
    typeof installer.name === 'string' && installer.name.length > 0 && win32.basename(installer.name) === installer.name,
    'release plan expected installer name is unsafe for the legacy update bridge',
  )
  assert(
    typeof installer.size === 'number' && Number.isSafeInteger(installer.size) && installer.size > 0,
    'release plan expected installer size is invalid for the legacy update bridge',
  )
  assert(
    typeof installer.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(installer.sha256),
    'release plan expected installer SHA-256 is invalid for the legacy update bridge',
  )

  return {
    mode: 'legacy-bridge',
    sourceTag,
    expectedPendingInstallerPath: win32.join(localAppData, 'ai-novel-writer-updater', 'pending', installer.name),
    expectedInstaller: {
      name: installer.name,
      size: installer.size,
      sha256: installer.sha256.toLowerCase(),
    },
  }
}

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN?.trim()
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'AI-Novel-Writer-windows-in-app-update-e2e',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function fetchJson(fetcher, url, label) {
  const response = await fetcher(url, { headers: githubHeaders() })
  assert(response?.ok, `${label} request failed${response ? ` (${response.status})` : ''}`)
  return await response.json()
}

async function fetchBytes(fetcher, url, label) {
  const response = await fetcher(url, { headers: githubHeaders() })
  assert(response?.ok, `${label} download failed${response ? ` (${response.status})` : ''}`)
  return Buffer.from(await response.arrayBuffer())
}

function officialReleaseApiPath(tag) {
  return `${apiBaseUrl}/repos/${OFFICIAL_UPDATE_REPOSITORY.owner}/${OFFICIAL_UPDATE_REPOSITORY.repo}/releases/tags/${encodeURIComponent(tag)}`
}

function assertFormalRelease(release, expectedTag, label) {
  const record = assertRecord(release, `${label} metadata`)
  assert(record.tag_name === expectedTag, `${label} tag ${record.tag_name ?? '(missing)'} does not match ${expectedTag}`)
  assert(record.draft === false, `${label} must not be a draft`)
  assert(record.prerelease === false, `${label} must not be a prerelease`)
  assert(Array.isArray(record.assets), `${label} assets must be an array`)
  return record
}

function assetByName(release, name, label) {
  assert(typeof name === 'string' && basename(name) === name && name.length > 0, `${label} asset name is unsafe: ${name}`)
  const matches = release.assets.filter(asset => asset != null && asset.name === name)
  assert(matches.length === 1, `${label} must contain exactly one asset named ${name}`)
  const asset = assertRecord(matches[0], `${label} ${name} asset`)
  assert(typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0, `${label} ${name} asset must have a positive size`)
  assert(
    typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest),
    `${label} ${name} asset must expose a SHA-256 digest`,
  )
  assert(
    typeof asset.browser_download_url === 'string' && asset.browser_download_url.startsWith('https://'),
    `${label} ${name} asset must expose an HTTPS download URL`,
  )
  return asset
}

function loadYaml(projectRoot, source, label) {
  const packagePath = join(projectRoot, 'node_modules', 'electron-builder', 'package.json')
  assert(existsSync(packagePath), `electron-builder is required to parse ${label}: ${packagePath}`)
  const electronBuilderRequire = createRequire(realpathSync(packagePath))
  const appBuilderPackagePath = electronBuilderRequire.resolve('app-builder-lib/package.json')
  const appBuilderRequire = createRequire(appBuilderPackagePath)
  return assertRecord(appBuilderRequire('js-yaml').load(source), label)
}

function writeBytesAtomically(path, bytes) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, bytes)
  renameSync(temporaryPath, path)
}

async function downloadVerifiedAsset({ fetcher, asset, destination, label }) {
  const bytes = await fetchBytes(fetcher, asset.browser_download_url, label)
  assert(bytes.length === asset.size, `${label} size does not match GitHub metadata`)
  const sha256 = sha256Hex(bytes)
  assert(
    asset.digest.toLowerCase() === `sha256:${sha256}`,
    `${label} SHA-256 digest does not match GitHub metadata`,
  )
  writeBytesAtomically(destination, bytes)
  return {
    name: asset.name,
    size: bytes.length,
    digest: asset.digest.toLowerCase(),
    sha256,
    sourceUrl: asset.browser_download_url,
    downloadedPath: destination,
    bytes,
  }
}

function verifyLatestMetadata(metadata, expectedTag, label) {
  const version = expectedTag.slice(1)
  assert(metadata.version === version, `${label} version ${metadata.version ?? '(missing)'} does not match ${version}`)
  assert(typeof metadata.path === 'string' && basename(metadata.path) === metadata.path, `${label} path must name one local asset`)
  assert(metadata.path.toLowerCase().endsWith('.exe'), `${label} path must point to a Windows installer`)
  assert(typeof metadata.sha512 === 'string' && metadata.sha512.length > 0, `${label} must contain the installer SHA-512`)
  assert(Array.isArray(metadata.files), `${label} files must be an array`)
  const matches = metadata.files.filter(file => file != null && typeof file === 'object' && file.url === metadata.path)
  assert(matches.length === 1, `${label} must describe exactly one installer matching path`)
  const installer = assertRecord(matches[0], `${label} installer entry`)
  assert(installer.sha512 === metadata.sha512, `${label} installer entry SHA-512 must match top-level SHA-512`)
  assert(typeof installer.size === 'number' && Number.isSafeInteger(installer.size) && installer.size > 0, `${label} installer entry must have a positive size`)
  return installer
}

async function verifyOfficialRelease({ tag, release, fetcher, evidenceRoot, label }) {
  const formalRelease = assertFormalRelease(release, tag, label)
  const releaseRoot = join(evidenceRoot, 'official-assets', tag)
  const latestAsset = assetByName(formalRelease, 'latest.yml', label)
  const latest = await downloadVerifiedAsset({
    fetcher,
    asset: latestAsset,
    destination: join(releaseRoot, 'latest.yml'),
    label: `${label} latest.yml`,
  })
  const metadata = loadYaml(repositoryRoot, latest.bytes.toString('utf8'), `${label} latest.yml`)
  const metadataInstaller = verifyLatestMetadata(metadata, tag, `${label} latest.yml`)
  const installerAsset = assetByName(formalRelease, metadata.path, label)
  const installer = await downloadVerifiedAsset({
    fetcher,
    asset: installerAsset,
    destination: join(releaseRoot, metadata.path),
    label: `${label} installer`,
  })
  assert(installer.size === metadataInstaller.size, `${label} latest.yml installer size does not match GitHub asset`)
  assert(sha512Base64(installer.bytes) === metadata.sha512, `${label} latest.yml installer SHA-512 does not match GitHub asset`)
  const blockMapName = `${metadata.path}.blockmap`
  const blockMap = await downloadVerifiedAsset({
    fetcher,
    asset: assetByName(formalRelease, blockMapName, label),
    destination: join(releaseRoot, blockMapName),
    label: `${label} installer blockmap`,
  })

  return {
    tag,
    version: tag.slice(1),
    releaseId: formalRelease.id ?? null,
    assets: {
      latest: { ...latest, bytes: undefined },
      installer: { ...installer, bytes: undefined },
      blockMap: { ...blockMap, bytes: undefined },
    },
  }
}

/**
 * Fetches only the fixed official repository, validates formal Releases and
 * their digest-authenticated update assets, then persists a no-secret plan for
 * the Windows UI runner. `fetcher` is injectable solely for unit tests.
 */
export async function createOfficialUpdatePlan({
  fromTag,
  expectedTag,
  evidenceRoot,
  fetcher = globalThis.fetch,
}) {
  assert(typeof fetcher === 'function', 'A fetch implementation is required for official Release verification')
  const normalizedFromTag = normalizeFinalReleaseTag(fromTag, 'from_tag')
  const normalizedExpectedTag = normalizeFinalReleaseTag(expectedTag, 'expected_tag')
  assert(
    compareFinalVersions(normalizedFromTag, normalizedExpectedTag) < 0,
    'expected_tag must be newer than from_tag for an in-app upgrade',
  )
  assert(typeof evidenceRoot === 'string' && evidenceRoot.length > 0, 'An evidence root is required')
  const resolvedEvidenceRoot = resolve(evidenceRoot)
  mkdirSync(resolvedEvidenceRoot, { recursive: true })

  const latestRelease = assertRecord(
    await fetchJson(
      fetcher,
      `${apiBaseUrl}/repos/${OFFICIAL_UPDATE_REPOSITORY.owner}/${OFFICIAL_UPDATE_REPOSITORY.repo}/releases/latest`,
      'GitHub latest Release metadata',
    ),
    'GitHub latest Release metadata',
  )
  assert(latestRelease.draft === false, 'GitHub latest Release must not be a draft')
  assert(latestRelease.prerelease === false, 'GitHub latest Release must not be a prerelease')
  const latestTag = normalizeFinalReleaseTag(latestRelease.tag_name, 'GitHub latest Release tag')
  assert(
    latestTag === normalizedExpectedTag,
    `expected_tag must equal the current latest formal Release: expected ${normalizedExpectedTag}, got ${latestRelease.tag_name ?? '(missing)'}`,
  )
  assertFormalRelease(latestRelease, normalizedExpectedTag, 'GitHub latest Release')

  const [fromRelease, expectedRelease] = await Promise.all([
    fetchJson(fetcher, officialReleaseApiPath(normalizedFromTag), 'GitHub from_tag Release metadata'),
    fetchJson(fetcher, officialReleaseApiPath(normalizedExpectedTag), 'GitHub expected_tag Release metadata'),
  ])
  const from = await verifyOfficialRelease({
    tag: normalizedFromTag,
    release: fromRelease,
    fetcher,
    evidenceRoot: resolvedEvidenceRoot,
    label: 'from_tag Release',
  })
  const expected = await verifyOfficialRelease({
    tag: normalizedExpectedTag,
    release: expectedRelease,
    fetcher,
    evidenceRoot: resolvedEvidenceRoot,
    label: 'expected_tag Release',
  })

  const plan = {
    schemaVersion: 1,
    kind: 'windows-in-app-update-e2e-release-plan',
    generatedAt: new Date().toISOString(),
    officialRepository: OFFICIAL_UPDATE_REPOSITORY,
    from,
    expected,
    latest: {
      tag: latestRelease.tag_name,
      releaseId: latestRelease.id ?? null,
    },
  }
  writeBytesAtomically(join(resolvedEvidenceRoot, 'release-plan.json'), Buffer.from(`${JSON.stringify(plan, null, 2)}\n`))
  return plan
}

function usage() {
  return [
    'Usage: node scripts/windows-in-app-update-e2e.mjs <prepare|run>',
    '--from-tag <vX.Y.Z> --expected-tag <vX.Y.Z> --evidence-root <path>',
  ].join(' ')
}

/** Public CLI seam: no repository, URL, installer, or version-source override exists. */
export function parseWindowsInAppUpdateE2eCli(argv) {
  const [command, ...options] = argv
  if (command !== 'prepare' && command !== 'run') throw new Error(usage())
  const values = new Map()
  for (let index = 0; index < options.length; index += 2) {
    const key = options[index]
    const value = options[index + 1]
    if (!['--from-tag', '--expected-tag', '--evidence-root'].includes(key) || !value || values.has(key)) {
      throw new Error(usage())
    }
    values.set(key, value)
  }
  const fromTag = values.get('--from-tag')
  const expectedTag = values.get('--expected-tag')
  const evidenceRoot = values.get('--evidence-root')
  if (!fromTag || !expectedTag || !evidenceRoot || values.size !== 3) throw new Error(usage())
  normalizeFinalReleaseTag(fromTag, 'from_tag')
  normalizeFinalReleaseTag(expectedTag, 'expected_tag')
  return { command, fromTag, expectedTag, evidenceRoot }
}

function readJsonWhenAvailable(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

function readLastMonitorControlSequence(controlPath) {
  if (!existsSync(controlPath)) return 0
  const lines = readFileSync(controlPath, 'utf8').split(/\r?\n/).filter(line => line.trim().length > 0)
  let lastSequence = 0
  for (const line of lines) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      throw new Error('Release monitor control file contains malformed JSON')
    }
    assert(
      Number.isSafeInteger(record?.sequence) && record.sequence > lastSequence,
      'Release monitor control sequences must be strictly increasing',
    )
    lastSequence = record.sequence
  }
  return lastSequence
}

export function appendMonitorControl(controlPath, payload) {
  const sequence = readLastMonitorControlSequence(controlPath) + 1
  appendFileSync(controlPath, `${JSON.stringify({ sequence, ...payload })}\n`, 'utf8')
  return sequence
}

async function waitForMonitorState(statusPath, acceptedStates, timeoutMilliseconds, phase) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const status = readJsonWhenAvailable(statusPath)
    if (status?.state === 'failed') {
      throw new Error(`Release monitor failed during ${phase}: ${status.failure ?? 'unknown failure'}`)
    }
    if (acceptedStates.includes(status?.state)) return status
    await wait(100)
  }
  const status = readJsonWhenAvailable(statusPath)
  throw new Error(`Timed out waiting for release monitor ${phase}; last state: ${status?.state ?? 'missing'}`)
}

async function waitForFile(path, timeoutMilliseconds, label) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await wait(25)
  }
  throw new Error(`Timed out waiting for ${label}: ${path}`)
}

function getWindowsProcessStartTimeTicks(processId) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `[System.Diagnostics.Process]::GetProcessById(${processId}).StartTime.ToUniversalTime().Ticks`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.error) throw result.error
  const output = String(result.stdout ?? '').trim()
  assert(result.status === 0 && /^\d+$/.test(output), `Could not capture Windows process identity for PID ${processId}`)
  return output
}

function pipeProcessOutput(child, stdoutPath, stderrPath) {
  const stdout = createWriteStream(stdoutPath, { flags: 'a' })
  const stderr = createWriteStream(stderrPath, { flags: 'a' })
  child.stdout?.pipe(stdout)
  child.stderr?.pipe(stderr)
  return () => {
    stdout.end()
    stderr.end()
  }
}

function waitForChild(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
}

function terminateProcessTree(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return
  const result = spawnSync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error && result.error.code !== 'ESRCH') throw result.error
}

function writeExecutionRecord(path, record) {
  writeBytesAtomically(path, Buffer.from(`${JSON.stringify(record, null, 2)}\n`))
}

async function runWindowsInAppUpdateE2e(plan, evidenceRoot) {
  assert(process.platform === 'win32', 'Windows in-app update E2E can run only on Windows')
  const resolvedEvidenceRoot = resolve(evidenceRoot)
  const monitorRoot = join(resolvedEvidenceRoot, 'release-gate-monitor')
  const controlPath = join(monitorRoot, 'control.jsonl')
  const statusPath = join(monitorRoot, 'status.json')
  const monitorEvidencePath = join(monitorRoot, 'evidence')
  const monitorScript = join(repositoryRoot, 'scripts', 'monitor-win-release-gate.ps1')
  const launchGateScript = join(repositoryRoot, 'scripts', 'release-win-launch-gate.mjs')
  const runnerScript = join(repositoryRoot, 'scripts', 'windows-in-app-update-e2e.ps1')
  const planPath = join(resolvedEvidenceRoot, 'release-plan.json')
  const launchRoot = join(resolvedEvidenceRoot, 'launch-gate')
  const armedPath = join(launchRoot, 'armed.json')
  const releasePath = join(launchRoot, 'release-command')
  const resultPath = join(launchRoot, 'result.json')
  const executionPath = join(resolvedEvidenceRoot, 'execution.json')
  const legacyBridge = createLegacyUpdateBridgePlan(plan)
  const record = {
    schemaVersion: 1,
    kind: 'windows-in-app-update-e2e-execution',
    startedAt: new Date().toISOString(),
    monitor: { controlPath, statusPath, evidencePath: monitorEvidencePath },
    launch: { armedPath, releasePath, resultPath },
    expected: { tag: plan.expected.tag, version: plan.expected.version },
    legacyBridge: legacyBridge
      ? { mode: legacyBridge.mode, sourceTag: legacyBridge.sourceTag, enabled: true }
      : { mode: 'native-silent', sourceTag: plan.from.tag, enabled: false },
  }
  mkdirSync(monitorRoot, { recursive: true })
  mkdirSync(launchRoot, { recursive: true })
  writeExecutionRecord(executionPath, record)

  const monitor = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', monitorScript,
    '-ControlPath', controlPath,
    '-StatusPath', statusPath,
    '-EvidencePath', monitorEvidencePath,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT: resolvedEvidenceRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stopMonitorOutput = pipeProcessOutput(
    monitor,
    join(monitorRoot, 'monitor.stdout.log'),
    join(monitorRoot, 'monitor.stderr.log'),
  )
  let launch
  let stopLaunchOutput
  try {
    await waitForMonitorState(
      statusPath,
      ['ready'],
      WINDOWS_RELEASE_MONITOR_READY_TIMEOUT_MS,
      'ready',
    )
    launch = spawn(process.execPath, [
      launchGateScript,
      '--armed-path', armedPath,
      '--release-path', releasePath,
      '--result-path', resultPath,
      '--',
      WINDOWS_UPDATE_RUNNER_COMMAND,
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', runnerScript,
      '-PlanPath', planPath,
      '-EvidenceRoot', resolvedEvidenceRoot,
      '-MonitorControlPath', controlPath,
      '-MonitorStatusPath', statusPath,
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, AI_NOVEL_RELEASE_GATE: 'windows-in-app-update-e2e' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    stopLaunchOutput = pipeProcessOutput(
      launch,
      join(resolvedEvidenceRoot, 'runner.stdout.log'),
      join(resolvedEvidenceRoot, 'runner.stderr.log'),
    )
    await waitForFile(armedPath, 15_000, 'armed launch-gate record')
    const armed = readJsonWhenAvailable(armedPath)
    assert(armed?.state === 'armed' && armed.processId === launch.pid, 'Launch gate did not publish a valid armed record')
    assert(Number.isInteger(launch.pid) && launch.pid > 0, 'Launch gate did not expose a valid process ID')
    appendMonitorControl(controlPath, {
      state: 'running',
      step: 'windows-in-app-update-e2e',
      rootProcessId: launch.pid,
      rootProcessStartTimeTicks: getWindowsProcessStartTimeTicks(launch.pid),
      relatedTargetNames: [
        plan.from.assets.installer.name,
        plan.expected.assets.installer.name,
        'AI小说作家.exe',
        'AI小说作家',
        'ai-novel-writer',
      ],
      legacyBridge,
    })
    await waitForMonitorState(statusPath, ['monitoring'], 15_000, 'monitoring')
    writeFileSync(releasePath, 'release\n', 'utf8')
    const result = await waitForChild(launch)
    record.launch.exitCode = result.code
    record.launch.signal = result.signal
    record.launch.result = readJsonWhenAvailable(resultPath) ?? null
    appendMonitorControl(controlPath, { state: 'step-complete', step: 'windows-in-app-update-e2e' })
    await waitForMonitorState(statusPath, ['step-completed'], 30_000, 'step completion')
    assert(result.code === 0 && !result.signal, `In-app update runner failed with code ${result.code ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`)
    assert(record.launch.result?.targetExitCode === 0 && !record.launch.result?.targetSignal, 'In-app update target did not complete successfully')
    record.succeeded = true
  } catch (error) {
    record.succeeded = false
    record.failure = error instanceof Error ? error.message : String(error)
    if (launch?.pid && launch.exitCode === null && launch.signalCode === null) {
      try {
        terminateProcessTree(launch.pid)
      } catch (terminateError) {
        record.cleanupFailure = terminateError instanceof Error ? terminateError.message : String(terminateError)
      }
    }
    throw error
  } finally {
    record.finishedAt = new Date().toISOString()
    writeExecutionRecord(executionPath, record)
    try {
      if (monitor.exitCode === null && monitor.signalCode === null) {
        appendMonitorControl(controlPath, { state: 'stop' })
        await waitForMonitorState(statusPath, ['stopped'], 15_000, 'stop')
      }
    } catch (stopError) {
      record.monitorStopFailure = stopError instanceof Error ? stopError.message : String(stopError)
      writeExecutionRecord(executionPath, record)
      if (monitor.pid) terminateProcessTree(monitor.pid)
    } finally {
      stopLaunchOutput?.()
      stopMonitorOutput()
    }
  }
}

async function main() {
  const options = parseWindowsInAppUpdateE2eCli(process.argv.slice(2))
  const plan = await createOfficialUpdatePlan(options)
  process.stdout.write(`${JSON.stringify({
    kind: plan.kind,
    from: plan.from.tag,
    expected: plan.expected.tag,
    evidenceRoot: resolve(options.evidenceRoot),
  })}\n`)
  if (options.command === 'run') {
    await runWindowsInAppUpdateE2e(plan, options.evidenceRoot)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
