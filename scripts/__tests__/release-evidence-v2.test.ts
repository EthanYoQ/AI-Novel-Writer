import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPnpmLockfileSha256 } from '../canonical-pnpm-lockfile-hash.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const evidenceScript = path.join(repositoryRoot, 'scripts', 'release-evidence-v2.mjs')
const fixtures: string[] = []
const WINDOWS_COMMAND_STEPS = [
  'install-locked-dependencies',
  'install-playwright-chromium',
  'renderer-browser-tests',
  'complete-windows-release-gate',
]

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-release-evidence-v2-'))
  fixtures.push(root)
  return root
}

function sha256(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function validWindowsReceipt(name: string, releaseRoot: string) {
  const base = { schemaVersion: 2, accepted: true, observations: [`direct ${name} observation`] }
  const reference = (kind: string, file: string) => ({
    kind,
    evidencePath: `qualification/${file}`,
    sha256: sha256(path.join(releaseRoot, 'qualification', file)),
  })
  const receipts: Record<string, unknown> = {
    install: { ...base, kind: 'windows-install', direct: { installerExitCode: 0, installedExecutable: 'C:/AI/AI小说作家.exe', installedExecutableExists: true } },
    launch: { ...base, kind: 'windows-launch', expectedVersion: '0.8.2', direct: { executablePath: 'C:/AI/AI小说作家.exe', productVersion: '0.8.2.0', processId: 101, processStartTimeTicks: '12345', visibleMainWindowCount: 1 } },
    'quiet-window': { ...base, kind: 'windows-final-quiet-window', direct: { monitorState: 'step-completed', monitorStep: 'final:quiet', quietWindowSeconds: 5, completedAt: '2026-08-10T14:57:30.3051843Z' } },
    'error-dialogs': { ...base, kind: 'windows-error-dialogs', direct: { monitorState: 'step-completed', monitorStep: 'final:quiet', newProductErrorDialogCount: 0, observedThrough: '2026-08-10T14:57:30.3051843Z' } },
    uninstall: { ...base, kind: 'windows-uninstall', direct: { installedExecutableExists: false, installDirectoryState: 'absent', allowedSystemResiduals: [] } },
    'upgrade-data': { ...base, kind: 'windows-upgrade-data', direct: { previousVersion: '0.2.5', legacyTableCount: 11, preservedAssetCount: 1, vectorDimension: 768, queryResultCount: 1 } },
    'native-abi': { ...base, kind: 'windows-native-abi', direct: { restoreMode: 'monitored', nodeModuleAbi: '127', verificationTest: 'electron/repositories/__tests__/character-repository.test.ts' } },
    'packaged-smoke': { ...base, kind: 'windows-packaged-smoke-summary', direct: { evidenceCount: 3, evidenceKinds: ['packaged-vector-smoke', 'packaged-official-homepage-smoke', 'packaged-skin-smoke'] }, evidence: [
      reference('packaged-vector-smoke', 'packaged-vector-smoke.json'),
      reference('packaged-official-homepage-smoke', 'packaged-official-homepage-smoke.json'),
      reference('packaged-skin-smoke', 'packaged-skin-smoke.json'),
    ] },
    signing: { ...base, kind: 'windows-signing', direct: { authenticodeStatus: 'NotSigned', installerSha256: sha256(path.join(releaseRoot, 'ai-novel-writer-setup-0.8.2.exe')) }, status: 'unsigned', validationResult: 'NotSigned', unsignedDistributionImpact: 'Windows may display an unknown-publisher warning.' },
  }
  return receipts[name]
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('release evidence v2 CLI', () => {
  it('freezes a Windows qualification contract before build work and binds the ledger to its raw hash', () => {
    const evidenceRoot = fixture()
    const commit = 'a'.repeat(40)

    const result = spawnSync(process.execPath, [
      evidenceScript,
      'init',
      '--platform', 'windows',
      '--evidence-root', evidenceRoot,
      '--repository', 'EthanYoQ/AI-Novel-Writer',
      '--commit', commit,
      '--run-id', '101',
      '--run-attempt', '2',
      '--runner-label', 'windows-2022',
      '--image-os', 'win22',
      '--image-version', '20260726.1',
      '--expected-node-version', process.versions.node,
      '--expected-pnpm-version', '11.11.0',
      '--workflow-path', '.github/workflows/windows-cloud-build-test.yml',
      '--workflow-name', 'Windows cloud package qualification',
      '--actor', 'release-operator',
      '--event', 'workflow_dispatch',
      '--dispatch-inputs-json', '{}',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)

    const contractPath = path.join(evidenceRoot, 'release-contract.json')
    const ledgerPath = path.join(evidenceRoot, 'run-ledger.json')
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))

    expect(contract).toMatchObject({
      schemaVersion: 2,
      stage: 'qualification',
      repository: 'EthanYoQ/AI-Novel-Writer',
      frozen: {
        commit,
        tag: 'v0.8.2',
        version: '0.8.2',
        platform: 'windows',
        workflow: {
          path: '.github/workflows/windows-cloud-build-test.yml',
          name: 'Windows cloud package qualification',
          actor: 'release-operator',
          event: 'workflow_dispatch',
          dispatchInputs: {},
        },
        run: {
          id: '101',
          attempt: '2',
        },
        runner: {
          expectedLabel: 'windows-2022',
          actualImageOS: 'win22',
          actualImageVersion: '20260726.1',
        },
      },
    })
    expect(contract.frozen.acceptance.evidenceFiles).toEqual([
      'qualification/acceptance/install.json',
      'qualification/acceptance/launch.json',
      'qualification/acceptance/quiet-window.json',
      'qualification/acceptance/error-dialogs.json',
      'qualification/acceptance/uninstall.json',
      'qualification/acceptance/upgrade-data.json',
      'qualification/acceptance/native-abi.json',
      'qualification/acceptance/packaged-smoke.json',
      'qualification/acceptance/signing.json',
    ])
    expect(contract.frozen.appToolchain).toMatchObject({
      expectedNodeVersion: process.versions.node,
      actualNodeVersion: process.versions.node,
      expectedPackageManagerVersion: '11.11.0',
      actualPackageManagerVersion: '11.11.0',
      source: {
        expectedNodeVersion: 'qualification workflow init --expected-node-version',
        actualPackageManagerVersion: 'pnpm --version',
      },
    })
    expect(ledger).toMatchObject({
      schemaVersion: 2,
      contractSha256: sha256(contractPath),
      run: {
        id: '101',
        attempt: '2',
        commit,
        workflow: {
          path: '.github/workflows/windows-cloud-build-test.yml',
          name: 'Windows cloud package qualification',
          actor: 'release-operator',
          event: 'workflow_dispatch',
          dispatchInputs: {},
        },
      },
      commands: [],
    })
  })

  it('records a bounded command result without persisting its arguments', () => {
    const evidenceRoot = fixture()
    const init = spawnSync(process.execPath, [
      evidenceScript,
      'init',
      '--platform', 'macos',
      '--evidence-root', evidenceRoot,
      '--repository', 'EthanYoQ/AI-Novel-Writer',
      '--commit', 'b'.repeat(40),
      '--run-id', '202',
      '--run-attempt', '1',
      '--runner-label', 'macos-14',
      '--image-os', 'macos14',
      '--image-version', '20260726.1',
      '--expected-node-version', process.versions.node,
      '--expected-pnpm-version', '11.11.0',
      '--workflow-path', '.github/workflows/macos-arm64-cloud-build.yml',
      '--workflow-name', 'macOS ARM64 cloud package qualification',
      '--actor', 'release-operator',
      '--event', 'workflow_dispatch',
      '--dispatch-inputs-json', '{}',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    expect(init.status, init.stderr).toBe(0)

    const result = spawnSync(process.execPath, [
      evidenceScript,
      'record',
      '--evidence-root', evidenceRoot,
      '--step', 'locked-dependencies',
      '--',
      process.execPath,
      '-e',
      'process.stdout.write("not-for-ledger")',
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    const ledgerText = readFileSync(path.join(evidenceRoot, 'run-ledger.json'), 'utf8')
    expect(ledgerText).not.toContain('not-for-ledger')
    expect(JSON.parse(ledgerText).commands).toEqual([
      expect.objectContaining({
        step: 'locked-dependencies',
        command: { executable: path.basename(process.execPath), argumentCount: 2 },
        exitCode: 0,
        timedOut: false,
      }),
    ])
  })

  it('rejects empty command evidence and placeholder receipts before finalizing a semantic Windows bundle', () => {
    const evidenceRoot = fixture()
    const releaseRoot = fixture()
    const version = '0.8.2'
    const init = spawnSync(process.execPath, [
      evidenceScript,
      'init',
      '--platform', 'windows',
      '--evidence-root', evidenceRoot,
      '--repository', 'EthanYoQ/AI-Novel-Writer',
      '--commit', 'c'.repeat(40),
      '--run-id', '303',
      '--run-attempt', '1',
      '--runner-label', 'windows-2022',
      '--image-os', 'win22',
      '--image-version', '20260726.1',
      '--expected-node-version', process.versions.node,
      '--expected-pnpm-version', '11.11.0',
      '--workflow-path', '.github/workflows/windows-cloud-build-test.yml',
      '--workflow-name', 'Windows cloud package qualification',
      '--actor', 'release-operator',
      '--event', 'workflow_dispatch',
      '--dispatch-inputs-json', '{}',
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(init.status, init.stderr).toBe(0)

    const installer = `ai-novel-writer-setup-${version}.exe`
    writeFileSync(path.join(releaseRoot, installer), 'installer', 'utf8')
    writeFileSync(path.join(releaseRoot, `${installer}.blockmap`), 'blockmap', 'utf8')
    writeFileSync(path.join(releaseRoot, 'latest.yml'), `version: ${version}\n`, 'utf8')
    writeJson(path.join(releaseRoot, 'qualification', 'packaged-vector-smoke.json'), {
      schemaVersion: 1, kind: 'packaged-vector-smoke', direct: { packaged: true },
    })
    writeJson(path.join(releaseRoot, 'qualification', 'packaged-official-homepage-smoke.json'), {
      schemaVersion: 1, kind: 'packaged-official-homepage-smoke', direct: { packaged: true },
    })
    writeJson(path.join(releaseRoot, 'qualification', 'packaged-skin-smoke.json'), {
      schemaVersion: 1, kind: 'packaged-skin-smoke', direct: { packaged: true },
    })
    for (const receipt of [
      'install', 'launch', 'quiet-window', 'error-dialogs', 'uninstall', 'upgrade-data', 'native-abi', 'packaged-smoke',
    ]) {
      writeJson(path.join(evidenceRoot, 'acceptance', `${receipt}.json`), {
        schemaVersion: 2,
        kind: `windows-${receipt}`,
        accepted: true,
        observations: ['direct qualification observation'],
        direct: { receipt },
      })
    }
    writeJson(path.join(evidenceRoot, 'acceptance', 'signing.json'), {
      schemaVersion: 2,
      kind: 'windows-signing',
      accepted: true,
      observations: ['actual Authenticode inspection completed'],
      direct: { authenticodeStatus: 'NotSigned' },
      status: 'unsigned',
      validationResult: { tool: 'Get-AuthenticodeSignature', status: 'NotSigned' },
      unsignedDistributionImpact: 'Windows may show SmartScreen or enterprise-policy warnings.',
    })

    const rejected = spawnSync(process.execPath, [
      evidenceScript,
      'finalize',
      '--platform', 'windows',
      '--evidence-root', evidenceRoot,
      '--release-root', releaseRoot,
    ], { cwd: repositoryRoot, encoding: 'utf8' })

    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('Release evidence command set is not exact')

    for (const step of WINDOWS_COMMAND_STEPS) {
      const recorded = spawnSync(process.execPath, [
        evidenceScript,
        'record',
        '--evidence-root', evidenceRoot,
        '--step', step,
        '--', process.execPath, '-e', '',
      ], { cwd: repositoryRoot, encoding: 'utf8' })
      expect(recorded.status, recorded.stderr).toBe(0)
    }
    type LaunchReceipt = { expectedVersion?: unknown, direct: Record<string, unknown> }
    const writeSemanticReceipts = (timestamp?: string, mutateLaunch?: (receipt: LaunchReceipt) => void) => {
      for (const receipt of [
        'install', 'launch', 'quiet-window', 'error-dialogs', 'uninstall', 'upgrade-data', 'native-abi', 'packaged-smoke', 'signing',
      ]) {
        const value = validWindowsReceipt(receipt, releaseRoot) as LaunchReceipt
        if (timestamp !== undefined && receipt === 'quiet-window') value.direct.completedAt = timestamp
        if (timestamp !== undefined && receipt === 'error-dialogs') value.direct.observedThrough = timestamp
        if (receipt === 'launch') mutateLaunch?.(value)
        writeJson(path.join(evidenceRoot, 'acceptance', `${receipt}.json`), value)
      }
    }
    for (const invalidTimestamp of [
      '2026-08-10T14:57:30.3051843+00:00',
      'not-a-timestamp',
      '2026-02-30T14:57:30Z',
      '2026-08-10T24:00:00Z',
      '2026-08-10T14:57:30.1234567890Z',
    ]) {
      writeSemanticReceipts(invalidTimestamp)
      const invalidTimestampResult = spawnSync(process.execPath, [
        evidenceScript,
        'finalize',
        '--platform', 'windows',
        '--evidence-root', evidenceRoot,
        '--release-root', releaseRoot,
      ], { cwd: repositoryRoot, encoding: 'utf8' })
      expect(invalidTimestampResult.status).not.toBe(0)
      expect(invalidTimestampResult.stderr).toContain('Windows error-dialog receipt facts are invalid')
    }
    for (const mutateLaunch of [
      (receipt: LaunchReceipt) => { receipt.direct.productVersion = '0.8.2.1' },
      (receipt: LaunchReceipt) => { receipt.direct.productVersion = '0.8.2-beta.1' },
      (receipt: LaunchReceipt) => { receipt.direct.productVersion = 'garbage' },
      (receipt: LaunchReceipt) => { delete receipt.direct.productVersion },
      (receipt: LaunchReceipt) => { receipt.expectedVersion = '0.8.0' },
      (receipt: LaunchReceipt) => { delete receipt.expectedVersion },
    ]) {
      writeSemanticReceipts(undefined, mutateLaunch)
      const invalidLaunchResult = spawnSync(process.execPath, [
        evidenceScript,
        'finalize',
        '--platform', 'windows',
        '--evidence-root', evidenceRoot,
        '--release-root', releaseRoot,
      ], { cwd: repositoryRoot, encoding: 'utf8' })
      expect(invalidLaunchResult.status).not.toBe(0)
      expect(invalidLaunchResult.stderr).toContain('Windows launch receipt facts are invalid')
    }
    writeSemanticReceipts()

    const result = spawnSync(process.execPath, [
      evidenceScript,
      'finalize',
      '--platform', 'windows',
      '--evidence-root', evidenceRoot,
      '--release-root', releaseRoot,
    ], { cwd: repositoryRoot, encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(path.join(releaseRoot, 'qualification', 'release-contract.json'))).toBe(true)
    expect(existsSync(path.join(releaseRoot, 'qualification', 'acceptance', 'signing.json'))).toBe(true)
    const manifest = JSON.parse(readFileSync(path.join(releaseRoot, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      platform: 'windows',
      version,
      contractSha256: sha256(path.join(releaseRoot, 'qualification', 'release-contract.json')),
      artifacts: [
        expect.objectContaining({ file: installer }),
        expect.objectContaining({ file: `${installer}.blockmap` }),
        expect.objectContaining({ file: 'latest.yml' }),
      ],
    })
    expect(manifest.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'qualification/release-contract.json' }),
      expect.objectContaining({ file: 'qualification/run-ledger.json' }),
      expect.objectContaining({ file: 'qualification/acceptance/install.json' }),
      expect.objectContaining({ file: 'qualification/acceptance/signing.json' }),
      expect.objectContaining({ file: 'qualification/packaged-vector-smoke.json' }),
    ]))
    const sums = readFileSync(path.join(releaseRoot, 'SHA256SUMS.txt'), 'utf8')
    expect(sums).toContain(`${sha256(path.join(releaseRoot, 'qualification', 'acceptance', 'signing.json'))} *qualification/acceptance/signing.json`)
    expect(sums).toContain(`${sha256(path.join(releaseRoot, 'manifest.json'))} *manifest.json`)

    const verifyArguments = [
      evidenceScript,
      'verify-bundle',
      '--platform', 'windows',
      '--bundle-root', releaseRoot,
      '--expected-commit', 'c'.repeat(40),
      '--expected-lockfile-sha256', canonicalPnpmLockfileSha256(path.join(repositoryRoot, 'pnpm-lock.yaml')),
      '--version', version,
    ]
    const missingRunAttempt = spawnSync(process.execPath, verifyArguments, { cwd: repositoryRoot, encoding: 'utf8' })
    expect(missingRunAttempt.status).not.toBe(0)
    expect(missingRunAttempt.stderr).toContain('Missing required option: --run-attempt')

    const verified = spawnSync(process.execPath, [
      ...verifyArguments,
      '--run-attempt', '1',
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(verified.status, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({
      platform: 'windows',
      releaseFiles: [installer, `${installer}.blockmap`, 'latest.yml'],
    })
  }, 15_000)

  it('requires externally frozen expected toolchain versions and rejects a runtime mismatch', () => {
    const evidenceRoot = fixture()
    const baseArguments = [
      evidenceScript,
      'init',
      '--platform', 'windows',
      '--evidence-root', evidenceRoot,
      '--repository', 'EthanYoQ/AI-Novel-Writer',
      '--commit', 'd'.repeat(40),
      '--run-id', '404',
      '--run-attempt', '1',
      '--runner-label', 'windows-2022',
      '--image-os', 'win22',
      '--image-version', '20260726.1',
    ]

    const missingExpected = spawnSync(process.execPath, baseArguments, { cwd: repositoryRoot, encoding: 'utf8' })
    expect(missingExpected.status).not.toBe(0)
    expect(missingExpected.stderr).toContain('Missing required option: --expected-node-version')

    const mismatch = spawnSync(process.execPath, [
      ...baseArguments,
      '--expected-node-version', '0.0.0',
      '--expected-pnpm-version', '11.11.0',
      '--workflow-path', '.github/workflows/windows-cloud-build-test.yml',
      '--workflow-name', 'Windows cloud package qualification',
      '--actor', 'release-operator',
      '--event', 'workflow_dispatch',
      '--dispatch-inputs-json', '{}',
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(mismatch.status).not.toBe(0)
    expect(mismatch.stderr).toContain('Installed Node version')
    expect(existsSync(path.join(evidenceRoot, 'release-contract.json'))).toBe(false)
  })
})
