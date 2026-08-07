import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const releaseScript = resolve('scripts/release-win-verify.mjs')
const releaseMonitorScript = resolve('scripts/monitor-win-release-gate.ps1')
const releaseLaunchGateScript = resolve('scripts/release-win-launch-gate.mjs')
const windowsIt = process.platform === 'win32' ? it : it.skip

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sameWindowsPath(left: unknown, right: string): boolean {
  return typeof left === 'string'
    && left.replaceAll('/', '\\').toLowerCase() === right.replaceAll('/', '\\').toLowerCase()
}

const windowsShortPathFixtureSource = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AiNovelTestShortPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetShortPathName(
    string longPath,
    StringBuilder shortPath,
    uint cchBuffer
  );

  public static string Get(string path) {
    if (String.IsNullOrWhiteSpace(path)) return null;
    uint required = GetShortPathName(path, null, 0);
    if (required == 0) return null;
    StringBuilder buffer = new StringBuilder(unchecked((int)required + 1));
    uint written = GetShortPathName(path, buffer, unchecked((uint)buffer.Capacity));
    if (written == 0 || written >= buffer.Capacity) return null;
    return buffer.ToString();
  }
}
`

function windowsShortPath(path: string): string | undefined {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Add-Type -TypeDefinition ${quotePowerShell(windowsShortPathFixtureSource)}; [AiNovelTestShortPath]::Get(${quotePowerShell(path)})`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim()
    return output || undefined
  } catch {
    return undefined
  }
}

function windowsProcessStartTimeTicks(processId: number): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `[System.Diagnostics.Process]::GetProcessById(${processId}).StartTime.ToUniversalTime().Ticks`,
    ],
    { encoding: 'utf8' },
  ).trim()
}

function readJsonWhenAvailable(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function waitForGateStatus(
  statusPath: string,
  expectedState: string,
  timeoutMilliseconds = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const status = readJsonWhenAvailable(statusPath)
    if (status?.state === expectedState) return status
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  throw new Error(`Timed out waiting for release gate state ${expectedState}: ${JSON.stringify(readJsonWhenAvailable(statusPath))}`)
}

async function waitForFile(path: string, timeoutMilliseconds = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  throw new Error(`Timed out waiting for file ${path}`)
}

function releaseGateRoots(tempRoot: string): string[] {
  if (!existsSync(tempRoot)) return []
  return readdirSync(tempRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('ai-novel-release-gate-'))
    .map(entry => join(tempRoot, entry.name))
}

function readMonitorProcessId(processMarkerPath: string): number | undefined {
  if (!existsSync(processMarkerPath)) return undefined
  const marker = JSON.parse(readFileSync(processMarkerPath, 'utf8')) as {
    processId?: unknown
    startedAt?: unknown
  }
  if (
    !Number.isInteger(marker.processId)
    || Number(marker.processId) <= 0
    || typeof marker.startedAt !== 'string'
    || Number.isNaN(Date.parse(marker.startedAt))
  ) {
    throw new Error(`Invalid release monitor process marker: ${processMarkerPath}`)
  }
  return Number(marker.processId)
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForMonitorStoppedOrExited(
  statusPath: string,
  processId: number,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (readJsonWhenAvailable(statusPath)?.state === 'stopped' || !isProcessRunning(processId)) {
      return true
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  return readJsonWhenAvailable(statusPath)?.state === 'stopped' || !isProcessRunning(processId)
}

async function forceStopMonitorProcess(
  processId: number,
  statusPath: string,
  timeoutMilliseconds: number,
): Promise<void> {
  try {
    process.kill(processId)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  if (await waitForMonitorStoppedOrExited(statusPath, processId, 500)) return

  const taskkill = spawnSync(
    'taskkill.exe',
    ['/PID', String(processId), '/T', '/F'],
    { encoding: 'utf8', windowsHide: true },
  )
  if (taskkill.error && isProcessRunning(processId)) throw taskkill.error
  if (!await waitForMonitorStoppedOrExited(statusPath, processId, timeoutMilliseconds)) {
    throw new Error(`Release monitor process ${processId} did not stop`)
  }
}

async function waitForUnmarkedMonitorTerminalState(
  statusPath: string,
  timeoutMilliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const state = readJsonWhenAvailable(statusPath)?.state
    if (state === 'stopped' || state === 'failed') return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
  const state = readJsonWhenAvailable(statusPath)?.state
  return state === 'stopped' || state === 'failed'
}

async function stopUnexpectedReleaseMonitors(releaseRoots: string[]): Promise<string[]> {
  const unresolvedRoots: string[] = []
  for (const releaseRoot of releaseRoots) {
    const controlPath = join(releaseRoot, 'control.jsonl')
    const statusPath = join(releaseRoot, 'status.json')
    const processId = readMonitorProcessId(join(releaseRoot, 'monitor-process.json'))
    const status = readJsonWhenAvailable(statusPath)
    if (processId === undefined && (status?.state === 'stopped' || status?.state === 'failed')) {
      continue
    }
    if (processId === undefined && !existsSync(controlPath) && !existsSync(statusPath)) continue
    appendFileSync(
      controlPath,
      `${JSON.stringify({ sequence: 2_000_000_000, state: 'stop' })}\n`,
      'utf8',
    )
    if (processId === undefined) {
      if (!await waitForUnmarkedMonitorTerminalState(statusPath, 500)) {
        unresolvedRoots.push(releaseRoot)
      }
      continue
    }
    if (await waitForMonitorStoppedOrExited(statusPath, processId, 5_000)) continue
    await forceStopMonitorProcess(processId, statusPath, 5_000)
  }
  return unresolvedRoots
}

async function cleanupReleaseFixture(
  fixtureRoot: string,
  releaseRoots: string[],
): Promise<void> {
  const unresolvedRoots = await stopUnexpectedReleaseMonitors(releaseRoots)
  if (unresolvedRoots.length > 0) {
    throw new Error(`Unresolved release monitor roots: ${unresolvedRoots.join(', ')}`)
  }
  rmSync(fixtureRoot, { recursive: true, force: true })
}

async function settle(child: ReturnType<typeof spawn>): Promise<{ code: number | null, signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
}

async function settleWithin(
  child: ReturnType<typeof spawn>,
  timeoutMilliseconds = 3_000,
): Promise<{ code: number | null, signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      settle(child),
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(`Process ${child.pid ?? 'unknown'} did not settle in time`)), timeoutMilliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function stopGateMonitor(controlPath: string, monitor: ReturnType<typeof spawn>): Promise<void> {
  try {
    appendFileSync(controlPath, `${JSON.stringify({ sequence: 99, state: 'stop' })}\n`, 'utf8')
  } catch {
    // A monitor that already failed may have closed its control channel.
  }
  try {
    await settleWithin(monitor)
  } catch {
    monitor.kill()
    await settleWithin(monitor).catch(() => undefined)
  }
}

async function startArmedExecutable(
  root: string,
  targetExecutable: string,
  targetArguments: string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<{
  armedPath: string
  releasePath: string
  resultPath: string
  child: ReturnType<typeof spawn>
}> {
  const armedPath = join(root, 'armed.json')
  const releasePath = join(root, 'release-command')
  const resultPath = join(root, 'result.json')
  const child = spawn(
    process.execPath,
    [
      releaseLaunchGateScript,
      '--armed-path', armedPath,
      '--release-path', releasePath,
      '--result-path', resultPath,
      '--',
      targetExecutable,
      ...targetArguments,
    ],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...environment } },
  )
  await waitForFile(armedPath)
  return { armedPath, releasePath, resultPath, child }
}

async function startArmedCommand(root: string, targetSource: string, environment: NodeJS.ProcessEnv = {}) {
  return await startArmedExecutable(root, process.execPath, ['-e', targetSource], environment)
}

async function runShortLivedDescendantFaultScenario(): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-gate-short-child-'))
  const controlPath = join(root, 'control.jsonl')
  const statusPath = join(root, 'status.json')
  const evidencePath = join(root, 'evidence')
  const releasePath = join(root, 'release-child')
  const monitor = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      releaseMonitorScript,
      '-ControlPath',
      controlPath,
      '-StatusPath',
      statusPath,
      '-EvidencePath',
      evidencePath,
    ],
    { windowsHide: true, stdio: 'ignore' },
  )

  try {
    await waitForGateStatus(statusPath, 'ready', 10_000)
    const launcher = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `while (-not (Test-Path -LiteralPath ${quotePowerShell(releasePath)})) { Start-Sleep -Milliseconds 5 }
Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Milliseconds 60; exit 37') | Out-Null
Start-Sleep -Milliseconds 180`,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    if (launcher.pid == null) throw new Error('The controlled launcher did not expose a PID')
    appendFileSync(
      controlPath,
      `${JSON.stringify({
        sequence: 1,
        state: 'running',
        step: 'short-lived-descendant-fault',
        rootProcessId: launcher.pid,
        rootProcessStartTimeTicks: windowsProcessStartTimeTicks(launcher.pid),
        relatedTargetNames: ['powershell'],
      })}\n`,
      'utf8',
    )
    await waitForGateStatus(statusPath, 'monitoring', 10_000)
    writeFileSync(releasePath, 'release', 'utf8')
    await settle(launcher)
    appendFileSync(
      controlPath,
      `${JSON.stringify({ sequence: 2, state: 'step-complete', step: 'short-lived-descendant-fault' })}\n`,
      'utf8',
    )
    const failed = await waitForGateStatus(statusPath, 'failed', 30_000)
    const eventPath = join(evidencePath, 'process-events.jsonl')
    return {
      ...failed,
      processEvents: existsSync(eventPath)
        ? readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        : [],
    }
  } finally {
    await stopGateMonitor(controlPath, monitor)
    rmSync(root, { recursive: true, force: true })
  }
}

describe('Windows release verification orchestration', () => {
  it('keeps monitoring through native restoration, validation, and the final quiet period', () => {
    const plan = JSON.parse(
      execFileSync(process.execPath, [releaseScript, '--print-plan'], {
        encoding: 'utf8',
      }),
    ) as string[]
    expect(plan.slice(-3)).toEqual([
      'restore:native-node',
      'verify:native-node',
      'final:quiet',
    ])

    const script = readFileSync(releaseScript, 'utf8')
    const restoreCall = script.lastIndexOf(
      'const restoreResult = await restoreNativeWithIndependentFallback',
    )
    const quietCall = script.lastIndexOf('await waitForFinalQuietPeriod()')
    const stopControl = script.lastIndexOf(
      "sendMonitorControl({ state: 'stop' })",
    )

    expect(restoreCall).toBeGreaterThan(0)
    expect(quietCall).toBeGreaterThan(restoreCall)
    expect(stopControl).toBeGreaterThan(quietCall)
    expect(script).toContain("state: 'quiet', step, quietSeconds: 5")
    expect(script).toContain(
      'await restoreAndVerifyNodeNativeAbi({ monitored: false })',
    )

    const nativeVerifyCall = script.lastIndexOf("await runner('verify:native-node', [")
    const nativeVerifyCallEnd = script.indexOf('  ])', nativeVerifyCall)
    const nativeVerifyArguments = script.slice(nativeVerifyCall, nativeVerifyCallEnd)
    expect(nativeVerifyCall).toBeGreaterThan(0)
    expect(nativeVerifyCallEnd).toBeGreaterThan(nativeVerifyCall)
    expect(nativeVerifyArguments).toContain("'--pool=threads'")
    expect(script.match(/'--pool=threads'/g) ?? []).toHaveLength(1)
  })

  windowsIt('stops a marker-only release monitor before status and control initialization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-monitor-cleanup-'))
    const controlPath = join(root, 'control.jsonl')
    const processMarkerPath = join(root, 'monitor-process.json')
    const readyPath = join(root, 'child-ready')
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          'const { existsSync, readFileSync, writeFileSync } = require("node:fs")',
          'const [controlPath, readyPath] = process.argv.slice(1)',
          'writeFileSync(readyPath, "ready", "utf8")',
          'const deadline = setTimeout(() => process.exit(12), 10_000)',
          'const poll = setInterval(() => {',
          '  if (!existsSync(controlPath)) return',
          `  if (!readFileSync(controlPath, "utf8").includes('"state":"stop"')) return`,
          '  clearInterval(poll)',
          '  clearTimeout(deadline)',
          '  process.exit(0)',
          '}, 10)',
        ].join('\n'),
        controlPath,
        readyPath,
      ],
      { stdio: 'ignore', windowsHide: true },
    )

    try {
      const childProcessId = child.pid
      expect(Number.isInteger(childProcessId) && Number(childProcessId) > 0).toBe(true)
      await waitForFile(readyPath)
      writeFileSync(
        processMarkerPath,
        `${JSON.stringify({ processId: childProcessId, startedAt: new Date().toISOString() })}\n`,
        'utf8',
      )

      await stopUnexpectedReleaseMonitors([root])

      expect(existsSync(controlPath)).toBe(true)
      const controlRecords = readFileSync(controlPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as { sequence: number, state: string })
      expect(controlRecords.at(-1)).toEqual({ sequence: 2_000_000_000, state: 'stop' })
      expect(await settleWithin(child)).toEqual({ code: 0, signal: null })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await settleWithin(child).catch(() => undefined)
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('accepts a failed no-marker monitor root without waiting for a stopped state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-monitor-failed-'))
    const statusPath = join(root, 'status.json')
    const controlPath = join(root, 'control.jsonl')
    writeFileSync(
      statusPath,
      `${JSON.stringify({ state: 'failed', failure: 'synthetic terminal failure' })}\n`,
      'utf8',
    )

    const startedAt = Date.now()
    try {
      await stopUnexpectedReleaseMonitors([root])
      expect(Date.now() - startedAt).toBeLessThan(500)
      expect(existsSync(controlPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 7_000)

  it('marks a control-only no-marker root unresolved and preserves its fixture', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'ai-novel-release-monitor-unresolved-'))
    const releaseRoot = join(fixtureRoot, 'temp', 'ai-novel-release-gate-control-only')
    const controlPath = join(releaseRoot, 'control.jsonl')
    mkdirSync(releaseRoot, { recursive: true })
    writeFileSync(
      controlPath,
      `${JSON.stringify({ sequence: 1, state: 'ready' })}\n`,
      'utf8',
    )

    const startedAt = Date.now()
    try {
      let cleanupError: Error | undefined
      try {
        await cleanupReleaseFixture(fixtureRoot, [releaseRoot])
      } catch (error) {
        cleanupError = error as Error
      }
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(cleanupError?.message).toContain('Unresolved release monitor roots')
      expect(cleanupError?.message).toContain(releaseRoot)
      expect(existsSync(fixtureRoot)).toBe(true)
      const controls = readFileSync(controlPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as { sequence: number, state: string })
      expect(controls.at(-1)).toEqual({ sequence: 2_000_000_000, state: 'stop' })
    } finally {
      // The fixture has no process by construction; remove it only after proving
      // the production-style cleanup path preserved the unresolved control root.
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }, 7_000)

  windowsIt('stops after a failed full test preflight without starting release or finalization work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-premonitor-failure-'))
    const isolatedTemp = join(root, 'temp')
    const fakePnpmCli = join(root, 'fake-pnpm.cjs')
    const processObserver = join(root, 'observe-node-entrypoints.cjs')
    const stepMarker = join(root, 'pnpm-steps.txt')
    const entrypointMarker = join(root, 'node-entrypoints.jsonl')
    mkdirSync(isolatedTemp)
    writeFileSync(
      fakePnpmCli,
      [
        'const { appendFileSync } = require("node:fs")',
        'const [command, step] = process.argv.slice(2)',
        'appendFileSync(process.env.AI_NOVEL_RELEASE_STEP_MARKER, `${command} ${step}\\n`, "utf8")',
        'process.exitCode = step === "test" ? 1 : 0',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      processObserver,
      [
        'const { appendFileSync } = require("node:fs")',
        'const marker = process.env.AI_NOVEL_RELEASE_ENTRYPOINT_MARKER',
        'if (marker) appendFileSync(marker, `${JSON.stringify(process.argv.slice(1))}\\n`, "utf8")',
        'if (process.argv.some(argument => argument.includes("prepare-native-for-node.mjs"))) process.exit(97)',
      ].join('\n'),
      'utf8',
    )

    const startedAt = Date.now()
    let observedReleaseRoots: string[] = []
    try {
      const overriddenEnvironmentKeys = new Set([
        'npm_execpath',
        'node_options',
        'temp',
        'tmp',
      ])
      const isolatedEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !overriddenEnvironmentKeys.has(key.toLowerCase())),
      ) as NodeJS.ProcessEnv
      const release = spawnSync(process.execPath, [releaseScript], {
        cwd: process.cwd(),
        env: {
          ...isolatedEnvironment,
          npm_execpath: fakePnpmCli,
          AI_NOVEL_RELEASE_STEP_MARKER: stepMarker,
          AI_NOVEL_RELEASE_ENTRYPOINT_MARKER: entrypointMarker,
          NODE_OPTIONS: `--require=${processObserver}`,
          TEMP: isolatedTemp,
          TMP: isolatedTemp,
        },
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      })

      expect(release.error, release.error?.message).toBeUndefined()
      expect(release.status).toBe(1)
      expect(release.signal).toBeNull()
      expect(Date.now() - startedAt).toBeLessThan(5_000)

      observedReleaseRoots = releaseGateRoots(isolatedTemp)
      expect(observedReleaseRoots).toHaveLength(1)
      const releaseRoot = observedReleaseRoots[0]!
      const evidencePath = join(releaseRoot, 'evidence')
      const orchestratorFailuresPath = join(evidencePath, 'orchestrator-failures.jsonl')
      expect(existsSync(orchestratorFailuresPath)).toBe(true)
      const orchestratorFailures = readFileSync(orchestratorFailuresPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as {
          phase: string
          error: string
          monitorStatus: unknown
        })
      expect(orchestratorFailures).toHaveLength(1)
      expect(orchestratorFailures[0]).toMatchObject({
        phase: 'release-steps',
        monitorStatus: null,
        error: expect.stringContaining('code 1'),
      })
      expect(existsSync(join(releaseRoot, 'monitor-process.json'))).toBe(false)
      expect(existsSync(join(releaseRoot, 'status.json'))).toBe(false)
      expect(existsSync(join(releaseRoot, 'control.jsonl'))).toBe(false)
      expect(existsSync(join(evidencePath, 'monitor-status.json'))).toBe(false)
      expect(existsSync(join(evidencePath, 'monitor-control-log.jsonl'))).toBe(false)

      const steps = readFileSync(stepMarker, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      expect(steps).toEqual(['run test'])
      expect(steps.join('\n')).not.toMatch(
        /prepare:native-node|build:win:artifacts|restore:native-node|verify:native-node/,
      )

      const entrypoints = readFileSync(entrypointMarker, 'utf8')
      expect(entrypoints).not.toContain('prepare-native-for-node.mjs')
      expect(entrypoints).not.toContain('node_modules/vitest/vitest.mjs')
      expect(entrypoints).not.toContain('release-win-launch-gate.mjs')
    } finally {
      const releaseRoots = [...new Set([
        ...observedReleaseRoots,
        ...releaseGateRoots(isolatedTemp),
      ])]
      await cleanupReleaseFixture(root, releaseRoots)
    }
  }, 10_000)

  windowsIt('stops after monitor marker rename failure without running release finalization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-marker-failure-'))
    const isolatedTemp = join(root, 'temp')
    const fakePnpmCli = join(root, 'fake-pnpm.cjs')
    const fileSystemPreload = join(root, 'fail-monitor-marker-rename.cjs')
    const stepMarker = join(root, 'pnpm-steps.txt')
    const entrypointMarker = join(root, 'node-entrypoints.jsonl')
    const monitorCapture = join(root, 'monitor-process-capture.json')
    mkdirSync(isolatedTemp)
    writeFileSync(
      fakePnpmCli,
      [
        'const { appendFileSync } = require("node:fs")',
        'const [command, step] = process.argv.slice(2)',
        'appendFileSync(process.env.AI_NOVEL_RELEASE_STEP_MARKER, `${command} ${step}\\n`, "utf8")',
        'process.exitCode = step === "test" ? 0 : 98',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      fileSystemPreload,
      [
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        'const { syncBuiltinESMExports } = require("node:module")',
        'const originalRenameSync = fs.renameSync.bind(fs)',
        'fs.renameSync = (source, destination) => {',
        '  const target = String(destination)',
        '  if (path.basename(target).toLowerCase() === "monitor-process.json" && target.includes("ai-novel-release-gate-")) {',
        '    const marker = JSON.parse(fs.readFileSync(source, "utf8"))',
        '    fs.writeFileSync(process.env.AI_NOVEL_RELEASE_MONITOR_CAPTURE, `${JSON.stringify(marker)}\\n`, "utf8")',
        '    const error = new Error("synthetic monitor marker rename failure")',
        '    error.code = "EACCES"',
        '    throw error',
        '  }',
        '  return originalRenameSync(source, destination)',
        '}',
        'syncBuiltinESMExports()',
        'const entrypointMarker = process.env.AI_NOVEL_RELEASE_ENTRYPOINT_MARKER',
        'if (entrypointMarker) fs.appendFileSync(entrypointMarker, `${JSON.stringify(process.argv.slice(1))}\\n`, "utf8")',
        'if (process.argv.some(argument => argument.includes("prepare-native-for-node.mjs"))) process.exit(97)',
      ].join('\n'),
      'utf8',
    )

    const startedAt = Date.now()
    let observedReleaseRoots: string[] = []
    let monitorProcessId: number | undefined
    let cleanupFailure: unknown
    try {
      const overriddenEnvironmentKeys = new Set([
        'npm_execpath',
        'node_options',
        'temp',
        'tmp',
      ])
      const isolatedEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !overriddenEnvironmentKeys.has(key.toLowerCase())),
      ) as NodeJS.ProcessEnv
      const release = spawnSync(process.execPath, [releaseScript], {
        cwd: process.cwd(),
        env: {
          ...isolatedEnvironment,
          npm_execpath: fakePnpmCli,
          AI_NOVEL_RELEASE_STEP_MARKER: stepMarker,
          AI_NOVEL_RELEASE_ENTRYPOINT_MARKER: entrypointMarker,
          AI_NOVEL_RELEASE_MONITOR_CAPTURE: monitorCapture,
          NODE_OPTIONS: `--require=${fileSystemPreload}`,
          TEMP: isolatedTemp,
          TMP: isolatedTemp,
        },
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      })

      expect(release.error, release.error?.message).toBeUndefined()
      expect(release.status).toBe(1)
      expect(release.signal).toBeNull()
      expect(Date.now() - startedAt).toBeLessThan(5_000)

      observedReleaseRoots = releaseGateRoots(isolatedTemp)
      expect(observedReleaseRoots).toHaveLength(1)
      const releaseRoot = observedReleaseRoots[0]!
      expect(existsSync(monitorCapture)).toBe(true)
      const capturedMonitor = JSON.parse(readFileSync(monitorCapture, 'utf8')) as {
        processId: number
        startedAt: string
      }
      monitorProcessId = capturedMonitor.processId
      expect(Number.isInteger(monitorProcessId) && monitorProcessId > 0).toBe(true)
      expect(isProcessRunning(monitorProcessId)).toBe(false)
      expect(existsSync(join(releaseRoot, 'monitor-process.json'))).toBe(false)
      expect(
        readdirSync(releaseRoot).filter(name => name.startsWith('monitor-process.json.') && name.endsWith('.tmp')),
      ).toEqual([])

      const failures = readFileSync(
        join(releaseRoot, 'evidence', 'orchestrator-failures.jsonl'),
        'utf8',
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as { phase: string, error: string })
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatchObject({
        phase: 'release-steps',
        error: 'synthetic monitor marker rename failure',
      })

      const steps = readFileSync(stepMarker, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      expect(steps).toEqual(['run test'])
      const entrypoints = readFileSync(entrypointMarker, 'utf8')
      expect(entrypoints).not.toMatch(
        /prepare-native-for-node\.mjs|node_modules[\\/]vitest[\\/]vitest\.mjs|release-win-launch-gate\.mjs/,
      )
    } finally {
      if (monitorProcessId === undefined && existsSync(monitorCapture)) {
        monitorProcessId = (JSON.parse(readFileSync(monitorCapture, 'utf8')) as { processId: number }).processId
      }
      const releaseRoots = [...new Set([
        ...observedReleaseRoots,
        ...releaseGateRoots(isolatedTemp),
      ])]
      try {
        await cleanupReleaseFixture(root, releaseRoots)
      } catch (cleanupError) {
        if (monitorProcessId !== undefined && !isProcessRunning(monitorProcessId)) {
          rmSync(root, { recursive: true, force: true })
        } else {
          cleanupFailure = cleanupError
        }
      }
    }
    if (cleanupFailure) throw cleanupFailure
  }, 10_000)

  it('preserves orchestrator and monitor evidence on every finalization failure path', () => {
    const script = readFileSync(releaseScript, 'utf8')

    expect(script).toContain('orchestrator-failures.jsonl')
    expect(script).toContain('monitor-status.json')
    expect(script).toContain('monitor-control-log.jsonl')
    expect(script).toContain(
      "'native-restore-validation-monitored'",
    )
    expect(script).toContain(
      "preserveGateFailureEvidence('native-restore-validation-fallback', error)",
    )
    expect(script).toContain(
      "preserveGateFailureEvidence('final-quiet', error)",
    )
    expect(script).toContain(
      "preserveGateFailureEvidence('monitor-stop', monitorStopFailure)",
    )
    expect(script).toContain('if (gateSucceeded) {')
    expect(script).toContain('rmSync(monitorRoot, { recursive: true, force: true })')
  })

  it('sends exact launch identities and settles ordinary children before ABI restoration', () => {
    const script = readFileSync(releaseScript, 'utf8')
    const ordinaryLoop = script.indexOf('for (const step of releaseVerificationSteps)')
    const ordinaryCatch = script.indexOf('await waitForChildToSettle(child)', ordinaryLoop)
    const restoreCall = script.lastIndexOf(
      'const restoreResult = await restoreNativeWithIndependentFallback',
    )

    expect(script).toContain('rootProcessStartTimeTicks')
    expect(script).toContain('getWindowsProcessStartTimeTicks(child.pid)')
    expect(script).toContain('await registerMonitoredChild(step, child')
    expect(ordinaryCatch).toBeGreaterThan(ordinaryLoop)
    expect(ordinaryCatch).toBeLessThan(restoreCall)
  })

  it('holds every formal release command behind the atomic monitor acknowledgement', () => {
    const script = readFileSync(releaseScript, 'utf8')
    const armedLaunch = script.indexOf('spawnArmedNodeProcess')
    const monitorAcknowledgement = script.indexOf("await waitForMonitorState(['monitoring']", armedLaunch)
    const release = script.indexOf('await releaseArmedNodeProcess', monitorAcknowledgement)

    expect(script).toContain("resolve('scripts/release-win-launch-gate.mjs')")
    expect(armedLaunch).toBeGreaterThan(0)
    expect(monitorAcknowledgement).toBeGreaterThan(armedLaunch)
    expect(release).toBeGreaterThan(monitorAcknowledgement)
  })

  it('implements the final quiet gate as a continuously monitored five-second interval', () => {
    const monitor = readFileSync(
      'scripts/monitor-win-release-gate.ps1',
      'utf8',
    )
    const errorWindowCheck = monitor.indexOf('Get-AiNovelNewErrorWindows')
    const quietCompletion = monitor.indexOf(
      "Write-AiNovelGateStatus -State 'step-completed' -Step $activeStep",
      errorWindowCheck,
    )

    expect(monitor).toContain("elseif ([string]$control.state -eq 'quiet')")
    expect(monitor).toContain('$quietDeadline = New-AiNovelGateQuietDeadline')
    expect(monitor).toContain('-QuietSeconds ([int]$control.quietSeconds)')
    expect(monitor).toContain('Test-AiNovelGateQuietPeriodComplete')
    expect(quietCompletion).toBeGreaterThan(errorWindowCheck)
    expect(monitor).toContain('including this final desktop snapshot')
  })

  it('keeps each completed step historical identities through a five-second post-exit quiet period', () => {
    const monitor = readFileSync(releaseMonitorScript, 'utf8')
    const installer = readFileSync('scripts/smoke-win-installer.ps1', 'utf8')

    expect(monitor).toContain('$completionDecision = Get-AiNovelStepCompletionDecision')
    expect(monitor).toContain('$completionQuietDeadline = $completionDecision.PostExitQuietDeadline')
    expect(monitor).toContain('-QuietSeconds 5')
    expect(monitor).toContain('$completionQuietDeadline = $null')
    expect(monitor.indexOf('$completionQuietDeadline = New-AiNovelGateQuietDeadline'))
      .toBeLessThan(monitor.indexOf("Write-AiNovelGateStatus -State 'step-completed' -Step $activeStep"))
    expect(installer).toContain('-TargetProcessIds $operationProcessIds')
    expect(installer).not.toContain('-TargetProcessIds $liveOperationProcessIds')
  })

  windowsIt('enforces at least five seconds of quiet before completion', () => {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `. ${quotePowerShell(releaseMonitorScript)} -LoadMonitorLibrary
$start = [DateTime]'2026-01-01T00:00:00Z'
$minimum = New-AiNovelGateQuietDeadline -NowUtc $start -QuietSeconds 1
$longer = New-AiNovelGateQuietDeadline -NowUtc $start -QuietSeconds 8
$first = Get-AiNovelStepCompletionDecision -NowUtc $start -AliveProcessCount 0 -ProcessExitDeadline $start.AddSeconds(5)
$before = Get-AiNovelStepCompletionDecision -NowUtc $start.AddSeconds(4.999) -AliveProcessCount 0 -ProcessExitDeadline $start.AddSeconds(5) -PostExitQuietDeadline $first.PostExitQuietDeadline
$at = Get-AiNovelStepCompletionDecision -NowUtc $start.AddSeconds(5) -AliveProcessCount 0 -ProcessExitDeadline $start.AddSeconds(5) -PostExitQuietDeadline $first.PostExitQuietDeadline
[pscustomobject]@{
  MinimumSeconds = ($minimum - $start).TotalSeconds
  LongerSeconds = ($longer - $start).TotalSeconds
  BeforeMinimum = Test-AiNovelGateQuietPeriodComplete -NowUtc $start.AddSeconds(4.999) -QuietDeadline $minimum
  AtMinimum = Test-AiNovelGateQuietPeriodComplete -NowUtc $start.AddSeconds(5) -QuietDeadline $minimum
  FirstState = $first.State
  BeforeState = $before.State
  AtState = $at.State
} | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8' },
    )
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? '{}')

    expect(result).toEqual({
      MinimumSeconds: 5,
      LongerSeconds: 8,
      BeforeMinimum: false,
      AtMinimum: true,
      FirstState: 'waiting-for-quiet',
      BeforeState: 'waiting-for-quiet',
      AtState: 'complete',
    })
  // The assertions use a fixed clock and do not shorten the production five-second
  // quiet contract. This budget only covers a cold Windows PowerShell process and
  // monitor-library parsing while the full Vitest suite is contending for CPU.
  }, 30_000)

  windowsIt('strictly rejects a missing, exited, or reused launcher identity', () => {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `. ${quotePowerShell(releaseMonitorScript)} -LoadMonitorLibrary
$ids = [System.Collections.Generic.HashSet[int]]::new()
$starts = @{}
$current = [System.Diagnostics.Process]::GetCurrentProcess()
$ticks = $current.StartTime.ToUniversalTime().Ticks
$accepted = Initialize-AiNovelGateRootIdentity -RootProcessId $PID -RootProcessStartTimeTicks $ticks -ProcessIds $ids -ProcessStartTimeTicks $starts
$reused = Initialize-AiNovelGateRootIdentity -RootProcessId $PID -RootProcessStartTimeTicks ($ticks - 1) -ProcessIds ([System.Collections.Generic.HashSet[int]]::new()) -ProcessStartTimeTicks @{}
$missing = Initialize-AiNovelGateRootIdentity -RootProcessId 2147483646 -RootProcessStartTimeTicks 1 -ProcessIds ([System.Collections.Generic.HashSet[int]]::new()) -ProcessStartTimeTicks @{}
[pscustomobject]@{
  Accepted = $accepted
  Reused = $reused
  Missing = $missing
  Stored = [long]$starts[$PID]
} | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8' },
    )
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? '{}')

    expect(result).toMatchObject({
      Accepted: true,
      Reused: false,
      Missing: false,
    })
    expect(Number(result.Stored)).toBeGreaterThan(0)
  }, 15_000)

  windowsIt('keeps cross-process window events on the dedicated WinEventHook message loop', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-gate-window-event-'))
    const evidencePath = join(root, 'evidence')
    const eventEvidencePath = join(evidencePath, 'window-events.jsonl')
    try {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `. ${quotePowerShell(releaseMonitorScript)} -LoadMonitorLibrary
New-Item -ItemType Directory -Path ${quotePowerShell(evidencePath)} -Force | Out-Null
$windowMonitor = [AiNovelReleaseGate.WindowEventMonitor]::new()
try {
  $child = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Milliseconds 350') -PassThru
  $child.WaitForExit()
  Start-Sleep -Milliseconds 150
  $windowMonitor.ThrowIfUnhealthy()
  $events = @($windowMonitor.Drain())
  $matchedEvents = @($events | Where-Object { $_.ProcessId -eq $child.Id })
  if ($matchedEvents.Count -gt 0) {
    Write-AiNovelGateWindowEventEvidence -Path ${quotePowerShell(evidencePath)} -Step 'hidden-child-message-loop' -Event $matchedEvents[0]
  }
  [pscustomobject]@{
    ChildProcessId = $child.Id
    ChildExitCode = $child.ExitCode
    MatchedCount = $matchedEvents.Count
    EventTypes = @($matchedEvents | ForEach-Object { $_.EventType })
  } | ConvertTo-Json -Compress
}
finally {
  $windowMonitor.Dispose()
}`,
        ],
        { encoding: 'utf8' },
      )
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? '{}') as Record<string, unknown>
      const eventTypes = Array.isArray(result.EventTypes)
        ? result.EventTypes.map(Number)
        : [Number(result.EventTypes)]
      const eventEvidence = JSON.parse(
        readFileSync(eventEvidencePath, 'utf8').trim().split(/\r?\n/).at(-1) ?? '{}',
      ) as Record<string, unknown>

      expect(result.ChildExitCode).toBe(0)
      expect(Number(result.MatchedCount)).toBeGreaterThanOrEqual(1)
      expect(eventTypes.some(eventType => [16, 32768, 32770, 32780].includes(eventType))).toBe(true)
      expect(eventEvidence).toMatchObject({
        kind: 'window-event',
        step: 'hidden-child-message-loop',
        processId: result.ChildProcessId,
        recordedAt: expect.any(String),
        monitorStartedAt: '',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  windowsIt('fails closed when a 60ms descendant exits nonzero after its root launcher succeeds', async () => {
    const result = await runShortLivedDescendantFaultScenario()
    const events = result.processEvents as Array<Record<string, unknown>>

    expect(result.state).toBe('failed')
    expect(result.failure).toContain('nonzero exit code 37')
    expect(result.monitorStartedAt).toEqual(expect.any(String))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'process-exit',
        exitCode: 37,
      }),
      expect.objectContaining({
        kind: 'process-tree',
        reason: 'deferred-process-failure',
      }),
    ]))
  }, 60_000)

  windowsIt('preserves an armed launch result before failing closed for a nonzero PowerShell descendant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-gate-preserve-result-'))
    const controlPath = join(root, 'control.jsonl')
    const statusPath = join(root, 'status.json')
    const evidencePath = join(root, 'evidence')
    const monitor = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        releaseMonitorScript,
        '-ControlPath',
        controlPath,
        '-StatusPath',
        statusPath,
        '-EvidencePath',
        evidencePath,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    let gate: Awaited<ReturnType<typeof startArmedCommand>> | undefined

    try {
      await waitForGateStatus(statusPath, 'ready')
      gate = await startArmedCommand(
        root,
        "const { spawnSync } = require('node:child_process'); const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 1; exit 37'], { stdio: 'ignore' }); process.exit(result.status ?? 1)",
      )
      if (gate.child.pid == null) throw new Error('The armed gate did not expose a PID')
      appendFileSync(
        controlPath,
        `${JSON.stringify({
          sequence: 1,
          state: 'running',
          step: 'preserve-launch-result-after-powershell-failure',
          rootProcessId: gate.child.pid,
          rootProcessStartTimeTicks: windowsProcessStartTimeTicks(gate.child.pid),
          relatedTargetNames: ['node', 'powershell'],
        })}\n`,
        'utf8',
      )
      await waitForGateStatus(statusPath, 'monitoring')
      writeFileSync(gate.releasePath, 'release', 'utf8')

      expect(await settleWithin(gate.child, 15_000)).toEqual({ code: 37, signal: null })
      expect(readJsonWhenAvailable(gate.resultPath)).toMatchObject({
        state: 'completed',
        targetExitCode: 37,
        targetSignal: null,
      })

      appendFileSync(
        controlPath,
        `${JSON.stringify({
          sequence: 2,
          state: 'step-complete',
          step: 'preserve-launch-result-after-powershell-failure',
        })}\n`,
        'utf8',
      )
      const failed = await waitForGateStatus(statusPath, 'failed', 15_000)
      const events = readFileSync(join(evidencePath, 'process-events.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>)
      const powerShellFailure = events.find(event => {
        const identity = event.processIdentity as Record<string, unknown> | null
        return event.kind === 'process-exit'
          && event.exitCode === 37
          && identity?.processName === 'powershell'
      })

      expect(failed.failure).toContain('nonzero exit code 37')
      expect(readFileSync(join(evidencePath, 'process-events.jsonl'), 'utf8')).not.toContain('exit 37')
      expect(powerShellFailure).toEqual(expect.objectContaining({
        step: 'preserve-launch-result-after-powershell-failure',
        processIdentity: expect.objectContaining({
          identityCaptured: true,
          commandLineCaptured: true,
          commandLineRedacted: true,
        }),
      }))
      expect((powerShellFailure?.processIdentity as Record<string, unknown>)).not.toHaveProperty('commandLine')
    } catch (error) {
      const eventPath = join(evidencePath, 'process-events.jsonl')
      const diagnostics = existsSync(eventPath)
        ? readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).slice(-20).join('\n')
        : 'process-events.jsonl was not created'
      throw new Error(`${String(error)}\nRecent redacted process events:\n${diagnostics}`)
    } finally {
      if (gate) {
        gate.child.kill()
        await settleWithin(gate.child).catch(() => undefined)
      }
      await stopGateMonitor(controlPath, monitor)
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)

  windowsIt('accepts the exact electron-builder process-check chain from one captured installer instance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-gate-nsis-probes-'))
    const controlPath = join(root, 'control.jsonl')
    const statusPath = join(root, 'status.json')
    const evidencePath = join(root, 'evidence')
    const sourcePath = join(root, 'ExactNsisProbeParent.cs')
    const installerPath = join(root, 'ai-novel-writer-setup-0.4.0.exe')
    const probeResultPath = join(root, 'probe-results.txt')
    const systemPowerShell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const systemCmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    writeFileSync(sourcePath, String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class ExactNsisProbeParent {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct StartupInfo {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInformation {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcess(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private static int RunCommand(string executablePath, string commandLineValue) {
    StartupInfo startupInfo = new StartupInfo();
    startupInfo.cb = Marshal.SizeOf(startupInfo);
    ProcessInformation processInformation;
    StringBuilder commandLine = new StringBuilder(commandLineValue);
    if (!CreateProcess(
      executablePath,
      commandLine,
      IntPtr.Zero,
      IntPtr.Zero,
      false,
      0x08000000,
      IntPtr.Zero,
      null,
      ref startupInfo,
      out processInformation
    )) return -Marshal.GetLastWin32Error();
    try {
      if (WaitForSingleObject(processInformation.hProcess, 30000) != 0) return -9001;
      uint exitCode;
      if (!GetExitCodeProcess(processInformation.hProcess, out exitCode)) return -Marshal.GetLastWin32Error();
      return unchecked((int)exitCode);
    }
    finally {
      CloseHandle(processInformation.hThread);
      CloseHandle(processInformation.hProcess);
    }
  }

  private static int RunProbe(string powerShellPath, string payload, bool quoteImage) {
    string argvZero = quoteImage ? "\"" + powerShellPath + "\"" : powerShellPath;
    return RunCommand(powerShellPath, argvZero + " -C \"" + payload + "\"");
  }

  private static int RunCmdProcessCheck(string cmdPath) {
    string findPath = Path.Combine(Path.GetDirectoryName(cmdPath), "find.exe");
    string commandLine =
      "\"" + cmdPath + "\" /C tasklist /FI \"USERNAME eq %USERNAME%\" /FI \"IMAGENAME eq AI\u5c0f\u8bf4\u4f5c\u5bb6.exe\" /FO CSV | \"" +
      findPath +
      "\" \"AI\u5c0f\u8bf4\u4f5c\u5bb6.exe\"";
    return RunCommand(cmdPath, commandLine);
  }

  public static int Main(string[] args) {
    string[] payloads = new[] {
      "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }",
      "if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }",
      "if ((Get-CimInstance -ClassName Win32_Process | ? {$_.Path -and $_.Path.StartsWith('C:\\ai-novel-release-probe-empty', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"
    };
    int[] results = new int[payloads.Length + 1];
    for (int index = 0; index < payloads.Length; index++) {
      results[index] = RunProbe(args[0], payloads[index], index != 1);
    }
    results[3] = RunCmdProcessCheck(args[1]);
    File.WriteAllText(args[2], String.Join(",", results));
    return 0;
  }
}
`, 'utf8')
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Add-Type -Path ${quotePowerShell(sourcePath)} -OutputAssembly ${quotePowerShell(installerPath)} -OutputType ConsoleApplication`,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    const monitor = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        releaseMonitorScript,
        '-ControlPath',
        controlPath,
        '-StatusPath',
        statusPath,
        '-EvidencePath',
        evidencePath,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    let gate: Awaited<ReturnType<typeof startArmedExecutable>> | undefined

    try {
      await waitForGateStatus(statusPath, 'ready')
      gate = await startArmedExecutable(root, installerPath, [systemPowerShell, systemCmd, probeResultPath])
      if (gate.child.pid == null) throw new Error('The armed gate did not expose a PID')
      appendFileSync(
        controlPath,
        `${JSON.stringify({
          sequence: 1,
          state: 'running',
          step: 'smoke:win-installer',
          rootProcessId: gate.child.pid,
          rootProcessStartTimeTicks: windowsProcessStartTimeTicks(gate.child.pid),
          relatedTargetNames: ['ai-novel-writer-setup-0.4.0', 'powershell'],
        })}\n`,
        'utf8',
      )
      await waitForGateStatus(statusPath, 'monitoring')
      writeFileSync(gate.releasePath, 'release', 'utf8')
      expect(await settleWithin(gate.child, 30_000)).toEqual({ code: 0, signal: null })
      const probeResults = readFileSync(probeResultPath, 'utf8').split(',').map(Number)
      expect(probeResults).toHaveLength(4)
      expect(probeResults.every(exitCode => exitCode === 0 || exitCode === 1)).toBe(true)
      expect(probeResults.at(2)).toBe(1)
      expect(probeResults.at(3)).toBe(1)

      appendFileSync(
        controlPath,
        `${JSON.stringify({ sequence: 2, state: 'step-complete', step: 'smoke:win-installer' })}\n`,
        'utf8',
      )
      await waitForGateStatus(statusPath, 'step-completed', 30_000)
      const rawEvidence = readFileSync(join(evidencePath, 'process-events.jsonl'), 'utf8')
      const events = rawEvidence.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      const powerShellExits = events.filter(event => {
        const identity = event.processIdentity as Record<string, unknown> | undefined
        return event.kind === 'process-exit' && identity?.processName === 'powershell'
      })
      const cmdExit = events.find(event => {
        const identity = event.processIdentity as Record<string, unknown> | undefined
        return event.kind === 'process-exit'
          && event.exitCode === 1
          && identity?.processName === 'cmd'
          && identity?.parentExecutablePath === installerPath
      })
      const findExit = events.find(event => {
        const identity = event.processIdentity as Record<string, unknown> | undefined
        return event.kind === 'process-exit'
          && event.exitCode === 1
          && identity?.processName === 'find'
      })

      expect(powerShellExits).toHaveLength(3)
      expect(powerShellExits.map(event => event.exitClassification)).toEqual(
        probeResults.slice(0, 3).map(exitCode => exitCode === 0 ? 'succeeded' : 'expected-nsis-powershell-probe'),
      )
      for (const event of powerShellExits) {
        const identity = event.processIdentity as Record<string, unknown>
        expect(identity).toMatchObject({
          parentExecutablePath: installerPath,
          commandLineCaptured: true,
          commandLineRedacted: true,
        })
        expect(identity.parentProcessStartTimeTicks).toEqual(expect.any(String))
        expect(identity).not.toHaveProperty('commandLine')
      }
      expect(cmdExit).toMatchObject({ exitClassification: 'expected-nsis-cmd-process-check' })
      expect(findExit).toMatchObject({ exitClassification: 'expected-nsis-find-no-match' })
      expect((cmdExit?.processIdentity as Record<string, unknown>)).not.toHaveProperty('commandLine')
      expect((findExit?.processIdentity as Record<string, unknown>)).not.toHaveProperty('commandLine')
      expect(rawEvidence).not.toContain('Get-CimInstance')
      expect(rawEvidence).not.toContain('tasklist /FI')
    } catch (error) {
      const eventPath = join(evidencePath, 'process-events.jsonl')
      const diagnostics = existsSync(eventPath)
        ? readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).slice(-20).join('\n')
        : 'process-events.jsonl was not created'
      throw new Error(`${String(error)}\nRecent redacted process events:\n${diagnostics}`)
    } finally {
      if (gate) {
        gate.child.kill()
        await settleWithin(gate.child).catch(() => undefined)
      }
      await stopGateMonitor(controlPath, monitor)
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  windowsIt('accepts the real 8.3-path NSIS uninstaller helper process-check chain only after its identity-bound TEMP host is observed', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-gate-nsis-uninstaller-'))
    const controlPath = join(root, 'control.jsonl')
    const statusPath = join(root, 'status.json')
    const evidencePath = join(root, 'evidence')
    const tempRoot = tmpdir()
    const helperDirectoryName = `~nsuA9${Date.now().toString(36)}${process.pid.toString(36)}.tmp`
    const helperDirectory = join(tempRoot, helperDirectoryName)
    const helperPath = join(helperDirectory, 'Un_A9.exe')
    const installRoot = join(root, 'installed-app')
    const uninstallerPath = join(installRoot, 'Uninstall AI小说作家.exe')
    const sourcePath = join(root, 'ExactNsisUninstallerHelper.cs')
    const probeResultPath = join(root, 'probe-results.txt')
    const systemPowerShell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const systemCmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    mkdirSync(helperDirectory, { recursive: true })
    mkdirSync(installRoot, { recursive: true })
    writeFileSync(sourcePath, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class ExactNsisUninstallerHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct StartupInfo {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessInformation {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcess(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private static int RunCommand(string executablePath, string commandLineValue) {
    StartupInfo startupInfo = new StartupInfo();
    startupInfo.cb = Marshal.SizeOf(startupInfo);
    ProcessInformation processInformation;
    StringBuilder commandLine = new StringBuilder(commandLineValue);
    if (!CreateProcess(
      executablePath,
      commandLine,
      IntPtr.Zero,
      IntPtr.Zero,
      false,
      0x08000000,
      IntPtr.Zero,
      null,
      ref startupInfo,
      out processInformation
    )) return -Marshal.GetLastWin32Error();
    try {
      if (WaitForSingleObject(processInformation.hProcess, 30000) != 0) return -9001;
      uint exitCode;
      if (!GetExitCodeProcess(processInformation.hProcess, out exitCode)) return -Marshal.GetLastWin32Error();
      return unchecked((int)exitCode);
    }
    finally {
      CloseHandle(processInformation.hThread);
      CloseHandle(processInformation.hProcess);
    }
  }

  private static string QuoteArgument(string value) {
    return "\"" + value + "\"";
  }

  private static int RunHost(string helperPath, string powerShellPath, string cmdPath, string outputPath) {
    ProcessStartInfo startInfo = new ProcessStartInfo();
    startInfo.FileName = helperPath;
    startInfo.Arguments = QuoteArgument(powerShellPath) + " " + QuoteArgument(cmdPath) + " " + QuoteArgument(outputPath);
    startInfo.UseShellExecute = false;
    startInfo.CreateNoWindow = true;
    using (Process helper = Process.Start(startInfo)) {
      helper.WaitForExit();
      return helper.ExitCode;
    }
  }

  private static int RunHelper(string powerShellPath, string cmdPath, string outputPath) {
    string probePayload = "if ((Get-CimInstance -ClassName Win32_Process | ? {$_.Path -and $_.Path.StartsWith('C:\\ai-novel-release-probe-empty', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }";
    string powerShellCommand = "\"" + powerShellPath + "\" -C \"" + probePayload + "\"";
    string findPath = Path.Combine(Path.GetDirectoryName(cmdPath), "find.exe");
    string cmdCommand =
      "\"" + cmdPath + "\" /C tasklist /FI \"USERNAME eq %USERNAME%\" /FI \"IMAGENAME eq AI小说作家.exe\" /FO CSV | \"" +
      findPath +
      "\" \"AI小说作家.exe\"";
    int powerShellExit = RunCommand(powerShellPath, powerShellCommand);
    int cmdExit = RunCommand(cmdPath, cmdCommand);
    File.WriteAllText(outputPath, powerShellExit + "," + cmdExit);
    return 0;
  }

  public static int Main(string[] args) {
    if (args.Length == 5 && String.Equals(args[0], "--host", StringComparison.Ordinal)) {
      return RunHost(args[1], args[2], args[3], args[4]);
    }
    if (args.Length == 3) return RunHelper(args[0], args[1], args[2]);
    return 64;
  }
}
`, 'utf8')
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Add-Type -Path ${quotePowerShell(sourcePath)} -OutputAssembly ${quotePowerShell(helperPath)} -OutputType ConsoleApplication`,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    copyFileSync(helperPath, uninstallerPath)
    const shortTempRoot = windowsShortPath(tempRoot)
    if (
      !shortTempRoot
      || shortTempRoot.toLowerCase() === tempRoot.toLowerCase()
      || !shortTempRoot.includes('~')
    ) {
      rmSync(helperDirectory, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
      context.skip('This TEMP root does not expose a distinct 8.3 ancestor path; the 8.3-specific chain test is not applicable.')
      return
    }
    const helperLaunchPath = join(shortTempRoot, helperDirectoryName, 'Un_A9.exe')
    const wrapperEncodedCommand = Buffer.from(
      [
        `& ${quotePowerShell(uninstallerPath)} '--host' ${quotePowerShell(helperLaunchPath)} ${quotePowerShell(systemPowerShell)} ${quotePowerShell(systemCmd)} ${quotePowerShell(probeResultPath)}`,
        'exit $LASTEXITCODE',
      ].join('\r\n'),
      'utf16le',
    ).toString('base64')
    const monitor = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        releaseMonitorScript,
        '-ControlPath',
        controlPath,
        '-StatusPath',
        statusPath,
        '-EvidencePath',
        evidencePath,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    let gate: Awaited<ReturnType<typeof startArmedExecutable>> | undefined

    try {
      await waitForGateStatus(statusPath, 'ready')
      gate = await startArmedExecutable(
        root,
        systemCmd,
        [
          '/D',
          '/C',
          `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${wrapperEncodedCommand}`,
        ],
      )
      if (gate.child.pid == null) throw new Error('The armed uninstaller gate did not expose a PID')
      appendFileSync(
        controlPath,
        `${JSON.stringify({
          sequence: 1,
          state: 'running',
          step: 'smoke:win-installer',
          rootProcessId: gate.child.pid,
          rootProcessStartTimeTicks: windowsProcessStartTimeTicks(gate.child.pid),
          relatedTargetNames: ['Uninstall AI小说作家', 'Un_A9', 'powershell'],
        })}\n`,
        'utf8',
      )
      await waitForGateStatus(statusPath, 'monitoring')
      writeFileSync(gate.releasePath, 'release', 'utf8')
      expect(await settleWithin(gate.child, 30_000)).toEqual({ code: 0, signal: null })
      expect(readFileSync(probeResultPath, 'utf8').split(',').map(Number)).toEqual([1, 1])

      appendFileSync(
        controlPath,
        `${JSON.stringify({ sequence: 2, state: 'step-complete', step: 'smoke:win-installer' })}\n`,
        'utf8',
      )
      await waitForGateStatus(statusPath, 'step-completed', 30_000)
      const rawEvidence = readFileSync(join(evidencePath, 'process-events.jsonl'), 'utf8')
      const events = rawEvidence.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      const expectedPowerShell = events.find(event => event.kind === 'process-exit'
        && event.exitClassification === 'expected-nsis-powershell-probe')
      const expectedCmd = events.find(event => event.kind === 'process-exit'
        && event.exitClassification === 'expected-nsis-cmd-process-check')
      const expectedFind = events.find(event => event.kind === 'process-exit'
        && event.exitClassification === 'expected-nsis-find-no-match')
      const helperStart = events.find(event => {
        const identity = event.processIdentity as Record<string, unknown> | undefined
        return event.kind === 'process-start' && identity?.processName === 'Un_A9'
      })
      const uninstallerStart = events.find(event => {
        const identity = event.processIdentity as Record<string, unknown> | undefined
        return event.kind === 'process-start' && identity?.processName === 'Uninstall AI小说作家'
      })
      const wrapperCmdStart = events.find(event => {
        const identity = event.processIdentity as Record<string, unknown> | undefined
        return event.kind === 'process-start'
          && sameWindowsPath(identity?.executablePath, systemCmd)
          && identity?.parentProcessId === gate?.child.pid
      })
      const wrapperCmdIdentity = wrapperCmdStart?.processIdentity as Record<string, unknown> | undefined
      const wrapperPowerShellStart = events.find(event => {
        const identity = event.processIdentity as Record<string, unknown> | undefined
        return event.kind === 'process-start'
          && sameWindowsPath(identity?.executablePath, systemPowerShell)
          && identity?.parentProcessId === wrapperCmdIdentity?.processId
      })
      const wrapperPowerShellIdentity = wrapperPowerShellStart?.processIdentity as Record<string, unknown> | undefined
      const uninstallerIdentity = uninstallerStart?.processIdentity as Record<string, unknown> | undefined

      expect(expectedPowerShell).toMatchObject({ exitCode: 1 })
      expect(expectedCmd).toMatchObject({ exitCode: 1 })
      expect(expectedFind).toMatchObject({ exitCode: 1 })
      expect(wrapperCmdStart).toBeDefined()
      expect(wrapperPowerShellStart).toBeDefined()
      expect(helperStart).toBeDefined()
      expect(uninstallerStart).toBeDefined()
      expect(uninstallerIdentity?.parentProcessId).toBe(wrapperPowerShellIdentity?.processId)
      expect(events.some(event => event.kind === 'process-exit' && event.exitClassification === 'failure')).toBe(false)
      expect(rawEvidence).not.toContain('tasklist /FI')
      expect(rawEvidence).not.toContain('Get-CimInstance')
    } catch (error) {
      const eventPath = join(evidencePath, 'process-events.jsonl')
      const diagnostics = existsSync(eventPath)
        ? readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).slice(-30).join('\n')
        : 'process-events.jsonl was not created'
      throw new Error(`${String(error)}\nRecent redacted process events:\n${diagnostics}`)
    } finally {
      if (gate) {
        gate.child.kill()
        await settleWithin(gate.child).catch(() => undefined)
      }
      await stopGateMonitor(controlPath, monitor)
      rmSync(helperDirectory, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('persists a minimal capture-failure event before failing closed', () => {
    const monitor = readFileSync(releaseMonitorScript, 'utf8')
    const captureGuard = monitor.indexOf('if (-not [bool]$processEvent.CaptureEstablished)')
    const evidenceWrite = monitor.indexOf('Write-AiNovelGateProcessEventEvidence', captureGuard)
    const captureClassification = monitor.indexOf("-ExitClassification 'capture-failure'", captureGuard)
    const failClosed = monitor.indexOf('throw "Release gate could not retain a process handle', captureGuard)

    expect(captureGuard).toBeGreaterThanOrEqual(0)
    expect(evidenceWrite).toBeGreaterThan(captureGuard)
    expect(captureClassification).toBeGreaterThan(evidenceWrite)
    expect(failClosed).toBeGreaterThan(captureClassification)
  })

  windowsIt('keeps a real command dormant when the monitor acknowledgement fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-gate-no-ack-'))
    const controlPath = join(root, 'control.jsonl')
    const statusPath = join(root, 'status.json')
    const evidencePath = join(root, 'evidence')
    const markerPath = join(root, 'real-command-started')
    const monitor = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        releaseMonitorScript,
        '-ControlPath',
        controlPath,
        '-StatusPath',
        statusPath,
        '-EvidencePath',
        evidencePath,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    let gate: Awaited<ReturnType<typeof startArmedCommand>> | undefined

    try {
      await waitForGateStatus(statusPath, 'ready')
      gate = await startArmedCommand(
        root,
        "require('node:fs').writeFileSync(process.env.AI_NOVEL_GATE_TEST_MARKER, 'started')",
        { AI_NOVEL_GATE_TEST_MARKER: markerPath },
      )
      expect(existsSync(markerPath)).toBe(false)
      appendFileSync(
        controlPath,
        `${JSON.stringify({
          sequence: 1,
          state: 'running',
          step: 'monitor-ack-must-fail-closed',
          rootProcessId: 2147483646,
          rootProcessStartTimeTicks: '1',
          relatedTargetNames: ['node'],
        })}\n`,
        'utf8',
      )
      await waitForGateStatus(statusPath, 'failed')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
      expect(existsSync(markerPath)).toBe(false)
    } finally {
      if (gate) {
        gate.child.kill()
        await settleWithin(gate.child).catch(() => undefined)
      }
      await stopGateMonitor(controlPath, monitor)
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  windowsIt('releases an armed real command once and transparently returns its nonzero exit code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-gate-exit-code-'))
    const markerPath = join(root, 'real-command-started')
    try {
      const gate = await startArmedCommand(
        root,
        "require('node:fs').writeFileSync(process.env.AI_NOVEL_GATE_TEST_MARKER, 'started'); process.exit(37)",
        { AI_NOVEL_GATE_TEST_MARKER: markerPath },
      )
      expect(existsSync(markerPath)).toBe(false)
      writeFileSync(gate.releasePath, 'release', 'utf8')
      expect(await settle(gate.child)).toEqual({ code: 37, signal: null })
      const result = readJsonWhenAvailable(gate.resultPath)

      expect(existsSync(markerPath)).toBe(true)
      expect(result).toMatchObject({
        targetExitCode: 37,
        targetSignal: null,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  windowsIt('passes a gated normal command only after the five-second monitored quiet interval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-novel-release-gate-normal-'))
    const controlPath = join(root, 'control.jsonl')
    const statusPath = join(root, 'status.json')
    const evidencePath = join(root, 'evidence')
    const markerPath = join(root, 'real-command-started')
    const targetExitPath = join(root, 'allow-normal-command-exit')
    const monitor = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        releaseMonitorScript,
        '-ControlPath',
        controlPath,
        '-StatusPath',
        statusPath,
        '-EvidencePath',
        evidencePath,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    let gate: Awaited<ReturnType<typeof startArmedCommand>> | undefined

    try {
      await waitForGateStatus(statusPath, 'ready')
      gate = await startArmedCommand(
        root,
        [
          "const { existsSync, writeFileSync } = require('node:fs')",
          "writeFileSync(process.env.AI_NOVEL_GATE_TEST_MARKER, String(process.pid), 'utf8')",
          'const deadline = Date.now() + 15_000',
          'const waitForTestRelease = () => {',
          '  if (existsSync(process.env.AI_NOVEL_GATE_TEST_EXIT)) process.exit(0)',
          '  if (Date.now() >= deadline) process.exit(42)',
          '  setTimeout(waitForTestRelease, 10)',
          '}',
          'waitForTestRelease()',
        ].join('\n'),
        {
          AI_NOVEL_GATE_TEST_MARKER: markerPath,
          AI_NOVEL_GATE_TEST_EXIT: targetExitPath,
        },
      )
      if (gate.child.pid == null) throw new Error('The armed gate did not expose a PID')
      appendFileSync(
        controlPath,
        `${JSON.stringify({
          sequence: 1,
          state: 'running',
          step: 'normal-gated-command',
          rootProcessId: gate.child.pid,
          rootProcessStartTimeTicks: windowsProcessStartTimeTicks(gate.child.pid),
          relatedTargetNames: ['node'],
        })}\n`,
        'utf8',
      )
      await waitForGateStatus(statusPath, 'monitoring')
      writeFileSync(gate.releasePath, 'release', 'utf8')
      await waitForFile(markerPath, 10_000)
      const targetProcessId = Number(readFileSync(markerPath, 'utf8'))
      expect(Number.isInteger(targetProcessId)).toBe(true)
      const targetCaptureDeadline = Date.now() + 10_000
      let targetCaptured = false
      while (Date.now() < targetCaptureDeadline) {
        const eventPath = join(evidencePath, 'process-events.jsonl')
        if (existsSync(eventPath)) {
          const capturedStart = readFileSync(eventPath, 'utf8')
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line) as Record<string, unknown>)
            .find(event => event.kind === 'process-start' && event.processId === targetProcessId)
          if (capturedStart?.captureEstablished === true) {
            targetCaptured = true
            break
          }
          if (capturedStart?.captureEstablished === false) {
            throw new Error(`Normal gated command ${targetProcessId} was not captured by the release monitor`)
          }
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
      }
      expect(targetCaptured).toBe(true)
      writeFileSync(targetExitPath, 'exit', 'utf8')
      expect(await settle(gate.child)).toEqual({ code: 0, signal: null })
      const quietStartedAt = Date.now()
      appendFileSync(
        controlPath,
        `${JSON.stringify({ sequence: 2, state: 'step-complete', step: 'normal-gated-command' })}\n`,
        'utf8',
      )
      await waitForGateStatus(statusPath, 'step-completed', 30_000)

      expect(Date.now() - quietStartedAt).toBeGreaterThanOrEqual(4_900)
      expect(existsSync(markerPath)).toBe(true)
      expect(readJsonWhenAvailable(gate.resultPath)).toMatchObject({
        targetExitCode: 0,
        targetSignal: null,
      })
    } finally {
      if (gate) {
        gate.child.kill()
        await settleWithin(gate.child).catch(() => undefined)
      }
      await stopGateMonitor(controlPath, monitor)
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)
})
