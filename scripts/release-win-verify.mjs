/* eslint-env node */

import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { restoreNativeWithIndependentFallback } from './release-native-restore.mjs'

export const releasePreMonitorSteps = [
  'test',
]

export const releaseVerificationSteps = [
  'prepare:native-node',
  'clean:build',
  'build:win:artifacts',
  'verify:win-update-artifacts',
  'verify:win-package',
  'smoke:win-app',
  'smoke:win-installer',
  'smoke:win-v025-upgrade',
]

export const releaseFinalizationSteps = [
  'restore:native-node',
  'verify:native-node',
  'final:quiet',
]

if (process.argv.includes('--print-plan')) {
  process.stdout.write(
    `${JSON.stringify([
      ...releasePreMonitorSteps,
      ...releaseVerificationSteps,
      ...releaseFinalizationSteps,
    ])}\n`,
  )
  process.exit(0)
}

if (process.platform !== 'win32') {
  console.error('The formal Windows release verification gate must run on Windows.')
  process.exit(1)
}

const pnpmCli = process.env.npm_execpath
if (!pnpmCli) {
  console.error('Run the Windows release verification gate through pnpm: pnpm run build:win')
  process.exit(1)
}

const monitorRoot = resolve(
  tmpdir(),
  `ai-novel-release-gate-${process.pid}-${Date.now()}`,
)
const controlPath = join(monitorRoot, 'control.jsonl')
const statusPath = join(monitorRoot, 'status.json')
const evidencePath = join(monitorRoot, 'evidence')
const monitorProcessPath = join(monitorRoot, 'monitor-process.json')
const monitorScript = resolve('scripts/monitor-win-release-gate.ps1')
const launchGateScript = resolve('scripts/release-win-launch-gate.mjs')
let controlSequence = 0
let launchSequence = 0
let gateSucceeded = false
let releaseFinalizationRequired = false
let monitor
let monitorSpawnError
const childSettlements = new WeakMap()

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

function spawnNodeProcess(args) {
  return observeChild(spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
  }))
}

function createLaunchPaths(step) {
  launchSequence += 1
  const safeStep = step.replaceAll(/[^A-Za-z0-9._-]+/g, '_')
  const launchRoot = join(evidencePath, 'launches', `${launchSequence}-${safeStep}`)
  mkdirSync(launchRoot, { recursive: true })
  return {
    armedPath: join(launchRoot, 'armed.json'),
    releasePath: join(launchRoot, 'release-command'),
    resultPath: join(launchRoot, 'result.json'),
  }
}

function spawnArmedNodeProcess(step, args) {
  const paths = createLaunchPaths(step)
  const child = observeChild(spawn(process.execPath, [
    launchGateScript,
    '--armed-path', paths.armedPath,
    '--release-path', paths.releasePath,
    '--result-path', paths.resultPath,
    '--',
    process.execPath,
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AI_NOVEL_RELEASE_GATE: 'release-win-verify',
    },
    stdio: 'inherit',
    windowsHide: true,
  }))
  return { child, ...paths }
}

async function waitForArmedNodeProcess(step, launch, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (existsSync(launch.armedPath)) {
      try {
        const armed = JSON.parse(readFileSync(launch.armedPath, 'utf8'))
        if (armed.state !== 'armed' || armed.processId !== launch.child.pid) {
          throw new Error(`Release launch gate published an invalid armed record for "${step}"`)
        }
        return armed
      } catch (error) {
        if (error instanceof SyntaxError) {
          await delay(20)
          continue
        }
        throw error
      }
    }
    if (launch.child.exitCode !== null || launch.child.signalCode !== null) {
      const result = await waitForChildToSettle(launch.child)
      throw new Error(
        `Release launch gate exited before arming "${step}" with code ${result.code ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`,
      )
    }
    await delay(20)
  }
  throw new Error(`Timed out waiting for release launch gate to arm "${step}"`)
}

async function releaseArmedNodeProcess(step, launch) {
  if (!existsSync(launch.armedPath)) {
    throw new Error(`Refusing to release unarmed Windows release step "${step}"`)
  }
  writeFileSync(launch.releasePath, 'release\n', 'utf8')
}

function readArmedNodeResult(step, launch) {
  if (!existsSync(launch.resultPath)) {
    throw new Error(`Release launch gate did not preserve a result record for "${step}"`)
  }
  try {
    return JSON.parse(readFileSync(launch.resultPath, 'utf8'))
  } catch (error) {
    throw new Error(`Release launch gate wrote an invalid result record for "${step}"`, { cause: error })
  }
}

function stopArmedNodeProcess(launch) {
  if (launch.child.exitCode === null && launch.child.signalCode === null) {
    launch.child.kill()
  }
}

function observeChild(child) {
  if (!childSettlements.has(child)) {
    childSettlements.set(child, new Promise(resolvePromise => {
      let settled = false
      const settle = result => {
        if (settled) return
        settled = true
        resolvePromise(result)
      }
      child.once('error', error => settle({ error, code: null, signal: null }))
      child.once('exit', (code, signal) => settle({ code, signal }))
      if (child.exitCode !== null || child.signalCode !== null) {
        settle({ code: child.exitCode, signal: child.signalCode })
      }
    }))
  }
  return child
}

async function waitForObservedChildToSettleWithin(child, timeoutMilliseconds) {
  observeChild(child)
  let timeout
  try {
    return await Promise.race([
      childSettlements.get(child),
      new Promise((_, rejectPromise) => {
        timeout = setTimeout(
          () => rejectPromise(new Error(`Process ${child.pid ?? 'unknown'} did not settle in time`)),
          timeoutMilliseconds,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function getWindowsProcessStartTimeTicks(processId) {
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `[System.Diagnostics.Process]::GetProcessById(${processId}).StartTime.ToUniversalTime().Ticks`,
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
  if (!/^\d+$/.test(output)) {
    throw new Error(`Invalid Windows process start identity for PID ${processId}: ${output}`)
  }
  // .NET ticks exceed Number.MAX_SAFE_INTEGER; preserve the exact identity as text.
  return output
}

async function registerMonitoredChild(step, child, relatedTargetNames) {
  observeChild(child)
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    await waitForChildToSettle(child)
    throw new Error(`Release verification step "${step}" did not expose a process ID`)
  }
  let rootProcessStartTimeTicks
  try {
    rootProcessStartTimeTicks = getWindowsProcessStartTimeTicks(child.pid)
  } catch (identityError) {
    await waitForChildToSettle(child)
    throw new Error(
      `Could not capture the exact process identity for release step "${step}"`,
      { cause: identityError },
    )
  }
  try {
    sendMonitorControl({
      state: 'running',
      step,
      rootProcessId: child.pid,
      rootProcessStartTimeTicks,
      relatedTargetNames,
    })
  } catch (controlError) {
    await waitForChildToSettle(child)
    throw controlError
  }
}

async function runNodeProcess(args) {
  const child = spawnNodeProcess(args)
  const result = await childSettlements.get(child)
  if (result.error) throw result.error
  if (result.code !== 0) {
    throw new Error(
      `Node restore verification failed with code ${result.code ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`,
    )
  }
}

function readMonitorStatus() {
  if (!existsSync(statusPath)) return undefined
  try {
    return JSON.parse(readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return undefined
  }
}

function preserveGateFailureEvidence(phase, error) {
  try {
    mkdirSync(evidencePath, { recursive: true })
    appendFileSync(
      join(evidencePath, 'orchestrator-failures.jsonl'),
      `${JSON.stringify({
        phase,
        error: error instanceof Error ? error.message : String(error),
        recordedAt: new Date().toISOString(),
        monitorStatus: readMonitorStatus() ?? null,
      })}\n`,
      'utf8',
    )
    if (existsSync(statusPath)) {
      writeFileSync(
        join(evidencePath, 'monitor-status.json'),
        readFileSync(statusPath),
      )
    }
    if (existsSync(controlPath)) {
      copyFileSync(controlPath, join(evidencePath, 'monitor-control-log.jsonl'))
    }
  } catch (evidenceError) {
    console.error(
      `Failed to preserve release-gate evidence: ${
        evidenceError instanceof Error ? evidenceError.message : evidenceError
      }`,
    )
  }
}

function sendMonitorControl(payload) {
  controlSequence += 1
  appendFileSync(
    controlPath,
    `${JSON.stringify({ sequence: controlSequence, ...payload })}\n`,
    'utf8',
  )
}

async function waitForMonitorState(states, timeoutMilliseconds, step = '') {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const status = readMonitorStatus()
    if (status?.state === 'failed') {
      throw new Error(status.failure || `Windows release monitor failed during "${status.step}"`)
    }
    if (status && states.includes(status.state) && (!step || status.step === step)) {
      return status
    }
    if (monitor?.exitCode !== null && monitor?.exitCode !== undefined) {
      throw new Error(`Windows release monitor exited unexpectedly with code ${monitor.exitCode}`)
    }
    if (monitorSpawnError) {
      throw monitorSpawnError
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for Windows release monitor state: ${states.join(', ')}`)
}

async function waitForStep(step, child) {
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      resolvePromise(result)
    }
    const timer = setInterval(() => {
      const status = readMonitorStatus()
      if (status?.state === 'failed' && !settled) {
        settled = true
        clearInterval(timer)
        rejectPromise(new Error(status.failure || `Windows release monitor failed during "${step}"`))
      }
    }, 100)

    observeChild(child)
    childSettlements.get(child).then(result => {
      if (result.error) {
        if (settled) return
        settled = true
        clearInterval(timer)
        rejectPromise(result.error)
        return
      }
      settle({ code: result.code, signal: result.signal })
    })
  })
}

async function waitForChildToSettle(child, timeoutMilliseconds = 120_000) {
  observeChild(child)
  const timer = setTimeout(() => {
    // Do not return until the observed process actually settles: starting ABI
    // restoration concurrently with a still-running packaging step is unsafe.
    child.kill()
  }, timeoutMilliseconds)
  const result = await childSettlements.get(child)
  clearTimeout(timer)
  if (result.error) throw result.error
  return { code: result.code, signal: result.signal }
}

function canUseMonitor() {
  return Boolean(
    monitor
    && !monitorSpawnError
    && monitor.exitCode === null
    && monitor.signalCode === null,
  )
}

async function runMonitoredNodeProcess(step, args) {
  if (!canUseMonitor()) {
    throw new Error(`Windows release monitor is unavailable before "${step}"`)
  }

  const launch = spawnArmedNodeProcess(step, args)
  const child = launch.child
  let result
  try {
    await waitForArmedNodeProcess(step, launch)
    await registerMonitoredChild(step, child, ['node', 'vitest', 'better_sqlite3'])
    await waitForMonitorState(['monitoring'], 10_000, step)
    await releaseArmedNodeProcess(step, launch)
    result = await waitForStep(step, child)
  } catch (error) {
    // A monitor can publish "failed" just before its process exit becomes
    // observable. Do not start the independent idempotent retry while this
    // first native-file operation may still be running.
    stopArmedNodeProcess(launch)
    await waitForChildToSettle(child)
    throw error
  }
  const launchResult = readArmedNodeResult(step, launch)
  if (launchResult.targetSignal) {
    throw new Error(`Node finalization step "${step}" ended with signal ${launchResult.targetSignal}`)
  }
  if (result.code !== 0) {
    sendMonitorControl({ state: 'step-complete', step })
    await waitForMonitorState(['step-completed'], 10_000, step)
    throw new Error(
      `Node finalization step "${step}" exited with code ${result.code ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`,
    )
  }
  if (launchResult.targetExitCode !== 0) {
    throw new Error(
      `Node finalization step "${step}" launch record reported code ${launchResult.targetExitCode ?? 'null'}`,
    )
  }

  sendMonitorControl({ state: 'step-complete', step })
  await waitForMonitorState(['step-completed'], 10_000, step)
}

async function restoreAndVerifyNodeNativeAbi({ monitored }) {
  const runner = monitored ? runMonitoredNodeProcess : async (_step, args) => {
    await runNodeProcess(args)
  }
  await runner('restore:native-node', [
    resolve('scripts/prepare-native-for-node.mjs'),
  ])
  await runner('verify:native-node', [
    resolve('node_modules/vitest/vitest.mjs'),
    'run',
    '--pool=threads',
    'electron/repositories/__tests__/character-repository.test.ts',
  ])
  console.log('Restored and verified better-sqlite3 for the ordinary Node test runtime.')
}

async function waitForFinalQuietPeriod() {
  if (!canUseMonitor()) {
    throw new Error('Windows release monitor is unavailable before the final quiet period')
  }
  const step = 'final:quiet'
  sendMonitorControl({ state: 'quiet', step, quietSeconds: 5 })
  await waitForMonitorState(['monitoring'], 10_000, step)
  await waitForMonitorState(['step-completed'], 10_000, step)
}

async function runPreMonitorSteps() {
  for (const step of releasePreMonitorSteps) {
    await runNodeProcess([pnpmCli, 'run', step])
  }
}

async function startReleaseMonitor() {
  mkdirSync(monitorRoot, { recursive: true })
  monitor = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      monitorScript,
      '-ControlPath',
      controlPath,
      '-StatusPath',
      statusPath,
      '-EvidencePath',
      evidencePath,
    ],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      windowsHide: true,
    },
  )
  observeChild(monitor)
  monitor.once('error', error => {
    monitorSpawnError = error
  })

  const monitorProcessTemporaryPath = `${monitorProcessPath}.${process.pid}.tmp`
  try {
    if (!Number.isInteger(monitor.pid) || monitor.pid <= 0) {
      throw new Error('Windows release monitor did not expose a valid process ID')
    }
    writeFileSync(
      monitorProcessTemporaryPath,
      `${JSON.stringify({
        processId: monitor.pid,
        startedAt: new Date().toISOString(),
      })}\n`,
      'utf8',
    )
    renameSync(monitorProcessTemporaryPath, monitorProcessPath)
  } catch (markerPublicationError) {
    let monitorShutdownError
    try {
      if (
        Number.isInteger(monitor.pid)
        && monitor.pid > 0
        && monitor.exitCode === null
        && monitor.signalCode === null
      ) {
        monitor.kill()
      }
      await waitForObservedChildToSettleWithin(monitor, 5_000)
    } catch (error) {
      monitorShutdownError = error
    }
    rmSync(monitorProcessTemporaryPath, { force: true })
    if (monitorShutdownError) {
      throw new AggregateError(
        [markerPublicationError, monitorShutdownError],
        'Windows release monitor marker publication failed and the monitor did not settle',
      )
    }
    throw markerPublicationError
  }
}

async function main() {
  await runPreMonitorSteps()
  await startReleaseMonitor()
  releaseFinalizationRequired = true

  await waitForMonitorState(['ready'], 10_000)

  for (const step of releaseVerificationSteps) {
    const launch = spawnArmedNodeProcess(step, [pnpmCli, 'run', step])
    const child = launch.child
    let result
    try {
      await waitForArmedNodeProcess(step, launch)
      await registerMonitoredChild(step, child, [
          'node',
          'pnpm',
          'electron',
          'electron-builder',
          'AI小说作家.exe',
          'AI小说作家',
          'ai-novel-writer',
      ])
      await waitForMonitorState(['monitoring'], 10_000, step)
      await releaseArmedNodeProcess(step, launch)
      result = await waitForStep(step, child)
    } catch (error) {
      // Every ordinary step can touch the shared native module. A monitor or
      // handshake failure must not race the ABI restoration in finally.
      stopArmedNodeProcess(launch)
      await waitForChildToSettle(child)
      throw error
    }
    const launchResult = readArmedNodeResult(step, launch)
    if (launchResult.targetSignal) {
      throw new Error(`Release verification step "${step}" ended with signal ${launchResult.targetSignal}`)
    }
    if (result.code !== 0) {
      sendMonitorControl({ state: 'step-complete', step })
      await waitForMonitorState(['step-completed'], 10_000, step)
      throw new Error(
        `Release verification step "${step}" exited with code ${result.code ?? 'null'}${result.signal ? ` (${result.signal})` : ''}`,
      )
    }
    if (launchResult.targetExitCode !== 0) {
      throw new Error(
        `Release verification step "${step}" launch record reported code ${launchResult.targetExitCode ?? 'null'}`,
      )
    }

    sendMonitorControl({ state: 'step-complete', step })
    await waitForMonitorState(['step-completed'], 10_000, step)
  }

  gateSucceeded = true
}

try {
  await main()
} catch (error) {
  preserveGateFailureEvidence('release-steps', error)
  console.error(error instanceof Error ? error.message : error)
  console.error(`Windows release-gate diagnostics preserved at: ${evidencePath}`)
  process.exitCode = 1
} finally {
  if (releaseFinalizationRequired) {
    let nativeRestoreSucceeded = false
    try {
      // Packaging deliberately rebuilds the shared native module for Electron ABI 145.
      // Once monitored release work may start, always return the worktree to Node ABI 141.
      const restoreResult = await restoreNativeWithIndependentFallback({
        restoreMonitored: async () => {
          await restoreAndVerifyNodeNativeAbi({ monitored: true })
        },
        // This fallback is deliberately unconditional. A monitor can publish
        // "failed" before its process exit becomes observable; process liveness
        // must never suppress the independent, idempotent ABI restoration.
        restoreIndependent: async () => {
          await restoreAndVerifyNodeNativeAbi({ monitored: false })
        },
      })
      if (restoreResult.usedIndependentFallback) {
        gateSucceeded = false
        process.exitCode = 1
        preserveGateFailureEvidence(
          'native-restore-validation-monitored',
          restoreResult.monitoredError,
        )
        console.error(
          restoreResult.monitoredError instanceof Error
            ? restoreResult.monitoredError.message
            : restoreResult.monitoredError,
        )
      }
      nativeRestoreSucceeded = true
    } catch (error) {
      gateSucceeded = false
      process.exitCode = 1
      preserveGateFailureEvidence('native-restore-validation-fallback', error)
      console.error(error instanceof Error ? error.message : error)
    }

    let finalQuietSucceeded = false
    if (canUseMonitor()) {
      try {
        await waitForFinalQuietPeriod()
        finalQuietSucceeded = true
      } catch (error) {
        gateSucceeded = false
        process.exitCode = 1
        preserveGateFailureEvidence('final-quiet', error)
        console.error(error instanceof Error ? error.message : error)
      }
    } else {
      gateSucceeded = false
      process.exitCode = 1
      const error = new Error(
        'Windows release monitor was not available for the required final quiet period',
      )
      preserveGateFailureEvidence('final-quiet', error)
      console.error(error.message)
    }

    let monitorStopFailure
    if (canUseMonitor()) {
      sendMonitorControl({ state: 'stop' })
      try {
        await waitForMonitorState(['stopped'], 10_000)
      } catch (error) {
        monitorStopFailure = error
        monitor.kill()
      }
    } else if (monitor && monitor.exitCode !== 0) {
      monitorStopFailure = new Error(
        `Windows release monitor exited with code ${monitor.exitCode}`,
      )
    }
    if (monitorStopFailure) {
      gateSucceeded = false
      process.exitCode = 1
      preserveGateFailureEvidence('monitor-stop', monitorStopFailure)
      console.error(
        monitorStopFailure instanceof Error
          ? monitorStopFailure.message
          : monitorStopFailure,
      )
      console.error(`Windows release-gate diagnostics preserved at: ${evidencePath}`)
    }
    if (!nativeRestoreSucceeded || !finalQuietSucceeded) {
      gateSucceeded = false
      process.exitCode = 1
    }
    if (gateSucceeded) {
      rmSync(monitorRoot, { recursive: true, force: true })
    }
  }
}
