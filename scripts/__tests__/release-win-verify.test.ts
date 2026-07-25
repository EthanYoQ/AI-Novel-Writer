import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  timeoutMilliseconds = 3_000,
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

async function startArmedCommand(root: string, targetSource: string, environment: NodeJS.ProcessEnv = {}): Promise<{
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
      process.execPath,
      '-e',
      targetSource,
    ],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...environment } },
  )
  await waitForFile(armedPath)
  return { armedPath, releasePath, resultPath, child }
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
    await waitForGateStatus(statusPath, 'ready')
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
    await waitForGateStatus(statusPath, 'monitoring')
    writeFileSync(releasePath, 'release', 'utf8')
    await settle(launcher)
    appendFileSync(
      controlPath,
      `${JSON.stringify({ sequence: 2, state: 'step-complete', step: 'short-lived-descendant-fault' })}\n`,
      'utf8',
    )
    const failed = await waitForGateStatus(statusPath, 'failed')
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
  })

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
  })

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
  })

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

  windowsIt('atomically captures a 60ms abnormal descendant on repeated release-gate runs', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await runShortLivedDescendantFaultScenario()
      const events = result.processEvents as Array<Record<string, unknown>>

      expect(result.failure).toContain('exit code 37')
      expect(result.monitorStartedAt).toEqual(expect.any(String))
      expect(result.monitorStoppedAt).toEqual(expect.any(String))
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'process-exit',
          exitCode: 37,
        }),
        expect.objectContaining({
          kind: 'process-tree',
          reason: 'monitor-failure',
        }),
      ]))
    }
  }, 30_000)

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
  })

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
      expect(await settle(gate.child)).toEqual({ code: 0, signal: null })
      const quietStartedAt = Date.now()
      appendFileSync(
        controlPath,
        `${JSON.stringify({ sequence: 2, state: 'step-complete', step: 'normal-gated-command' })}\n`,
        'utf8',
      )
      await waitForGateStatus(statusPath, 'step-completed', 9_000)

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
  }, 15_000)
})
