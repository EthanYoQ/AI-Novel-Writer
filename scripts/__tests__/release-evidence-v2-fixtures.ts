import path from 'node:path'
import process from 'node:process'
import { MACOS_FORMAL_DISTRIBUTION_POLICY, recordReleaseCommand, sha256File } from '../release-evidence-v2.mjs'

export const WINDOWS_COMMAND_STEPS = [
  'install-locked-dependencies',
  'install-playwright-chromium',
  'renderer-browser-tests',
  'complete-windows-release-gate',
]

export const MACOS_COMMAND_STEPS = [
  'install-locked-dependencies',
  'install-playwright-chromium',
  'renderer-browser-tests',
  'build-native-secure-helper',
  'test-suite',
  'build-macos-arm64-package',
  'mounted-dmg-smoke',
]

export function recordQualificationCommands(evidenceRoot: string, platform: 'windows' | 'macos', cwd: string) {
  const steps = platform === 'windows' ? WINDOWS_COMMAND_STEPS : MACOS_COMMAND_STEPS
  for (const step of steps) {
    recordReleaseCommand({ evidenceRoot, step, command: [process.execPath, '-e', ''], cwd })
  }
}

function base(name: string) {
  return { schemaVersion: 2, accepted: true, observations: [`direct ${name} observation`] }
}

function reference(releaseRoot: string, kind: string, file: string) {
  return {
    kind,
    evidencePath: `qualification/${file}`,
    path: `qualification/${file}`,
    sha256: sha256File(path.join(releaseRoot, 'qualification', file)),
  }
}

export function windowsV025CopyProof() {
  const before = { id: 71, content: 'fixture author body', updatedAt: '2026-01-02 03:04:05' }
  return {
    upgradePolicyRevision: 'v025-roster-refusal-v2', oldAppSaved: true, legacyRecentPreserved: true,
    sourceUnchangedSinceOldSave: true, legacyGlobalBytesPreservedSinceOldSave: true,
    oldSaveProof: { verifiedBy: 'legacy-renderer-cdp-v025-save', draft: {
      before, after: { ...before, updatedAt: '2026-09-26 03:04:05' },
    } },
    copyDriverSha256: 'd'.repeat(64), copyTestedSha: 'c'.repeat(40),
    copyPackageHashes: { exe: 'e'.repeat(64), asar: 'f'.repeat(64) },
    copyImport: { revision: 'v025-roster-refusal-v2', expectedCode: 'LEGACY_IMPORT_ROSTER_UNAVAILABLE',
      source: 'C:/fixture/source', importSource: 'C:/scratch/s', target: 'C:/scratch/copy', sourceFileCount: 12,
      sourceInventorySha256: 'a'.repeat(64), sourceAfterSha256: 'a'.repeat(64),
      legacyGlobalsBeforeSha256: 'b'.repeat(64), legacyGlobalsAfterSha256: 'b'.repeat(64),
      sourceUnchanged: true, legacyGlobalsUnchanged: true, targetPublished: false,
      targetRecentRegistered: false, stagingRetained: true,
      modelRequests: { mainFetchCalls: 0, rendererRequests: 0 },
    },
    copySteps: [{ stepId: 'v0.2.5-roster-rejected', outcome: 'PASS',
      expectedCode: 'LEGACY_IMPORT_ROSTER_UNAVAILABLE', requests: { mainFetchCalls: 0, rendererRequests: 0 } }],
    installedV110: { previousVersion: '1.1.0', previousSource: 'official-installed-setup',
      previousInstallerSha256: '1'.repeat(64), oldAppOpenedProject: true, currentAppLaunched: true,
      sourceUnchanged: true, globalConfigUnchanged: true, recentProjectsUnchanged: true,
      officialSources: ['v1.0.0', 'v1.1.0'].map(sourceVersion => ({
        sourceVersion, testedSha: 'c'.repeat(40), officialProofSha256: '2'.repeat(64),
        sourceManifestSha256: '3'.repeat(64), driverSha256: 'd'.repeat(64),
        executableSha256: 'e'.repeat(64), asarSha256: 'f'.repeat(64), receiptSha256: '4'.repeat(64),
        sourceInventorySha256: '5'.repeat(64), targetInventorySha256: '6'.repeat(64),
        sourceProjectId: 'old-id', targetProjectId: 'new-id',
        sourceBodySha256: '7'.repeat(64), savedBodySha256: '8'.repeat(64), reopenedBodySha256: '8'.repeat(64), modelCallRows: 0,
        importAndSaveRequests: { mainFetchCalls: 0, rendererRequests: 0 },
        reopenRequests: { mainFetchCalls: 0, rendererRequests: 0 },
        steps: ['import-open', 'target-edit-save', 'target-edit-reopen'].map(step => ({
          stepId: `${sourceVersion}-${step}`, outcome: 'PASS',
        })),
      })),
    },
  }
}

export function windowsAcceptanceReceipt(releaseRoot: string, version: string, name: string) {
  const sha256 = sha256File(path.join(releaseRoot, `ai-novel-writer-setup-${version}.exe`))
  const receipts: Record<string, unknown> = {
    install: { ...base(name), kind: 'windows-install', direct: { installerExitCode: 0, installedExecutable: 'C:/AI/AI小说作家.exe', installedExecutableExists: true } },
    launch: { ...base(name), kind: 'windows-launch', expectedVersion: version, direct: { executablePath: 'C:/AI/AI小说作家.exe', productVersion: version, processId: 101, processStartTimeTicks: '12345', visibleMainWindowCount: 1 } },
    'quiet-window': { ...base(name), kind: 'windows-final-quiet-window', direct: { monitorState: 'step-completed', monitorStep: 'final:quiet', quietWindowSeconds: 5, completedAt: '2026-08-10T12:00:00.000Z' } },
    'error-dialogs': { ...base(name), kind: 'windows-error-dialogs', direct: { monitorState: 'step-completed', monitorStep: 'final:quiet', newProductErrorDialogCount: 0, observedThrough: '2026-08-10T12:00:00.000Z' } },
    uninstall: { ...base(name), kind: 'windows-uninstall', direct: { installedExecutableExists: false, installDirectoryState: 'absent', allowedSystemResiduals: [] } },
    'upgrade-data': { ...base(name), kind: 'windows-upgrade-data', direct: { previousVersion: '0.2.5', legacyTableCount: 11, preservedAssetCount: 1, vectorDimension: 768, queryResultCount: 1, ...windowsV025CopyProof() } },
    'native-abi': { ...base(name), kind: 'windows-native-abi', direct: { restoreMode: 'monitored', nodeModuleAbi: '127', verificationTest: 'electron/repositories/__tests__/character-repository.test.ts' } },
    'packaged-smoke': { ...base(name), kind: 'windows-packaged-smoke-summary', direct: { evidenceCount: 3, evidenceKinds: ['packaged-vector-smoke', 'packaged-official-homepage-smoke', 'packaged-skin-smoke'] }, evidence: [
      reference(releaseRoot, 'packaged-vector-smoke', 'packaged-vector-smoke.json'),
      reference(releaseRoot, 'packaged-official-homepage-smoke', 'packaged-official-homepage-smoke.json'),
      reference(releaseRoot, 'packaged-skin-smoke', 'packaged-skin-smoke.json'),
    ] },
    signing: { ...base(name), kind: 'windows-signing', direct: { authenticodeStatus: 'NotSigned', installerSha256: sha256 }, status: 'unsigned', validationResult: 'NotSigned', unsignedDistributionImpact: 'Windows may display an unknown-publisher warning.' },
  }
  return receipts[name]
}

export function macosAcceptanceReceipt(releaseRoot: string, version: string, name: string) {
  const dmg = `ai-novel-writer-mac-arm64-${version}-installer.dmg`
  const dmgSha256 = sha256File(path.join(releaseRoot, dmg))
  const outputSha256 = 'b'.repeat(64)
  const receipts: Record<string, unknown> = {
    'dmg-mount': {
      ...base(name), kind: 'dmg-mount', platform: 'darwin', arch: 'arm64',
      direct: {
        dmg: { path: `/tmp/${dmg}`, filename: dmg }, app: { path: '/Volumes/AI/AI小说作家.app', bundleName: 'AI小说作家.app' },
        executable: { path: '/Volumes/AI/AI小说作家.app/Contents/MacOS/AI小说作家', present: true },
        helper: { path: '/Volumes/AI/AI小说作家.app/Contents/Resources/security/darwin-safe-file-system', present: true },
        hash: { algorithm: 'sha256', value: dmgSha256 }, mount: { path: '/Volumes/AI', attached: true, command: 'hdiutil attach -readonly -nobrowse -mountpoint' },
        unmount: { attempted: true, succeeded: true, command: 'hdiutil detach -force -quiet' },
      },
    },
    'packaged-smoke': {
      ...base(name), kind: 'packaged-smoke', platform: 'darwin', arch: 'arm64',
      direct: { mountedApplication: 'AI小说作家.app', secureFileSystemHelper: 'security/darwin-safe-file-system', secureFileSystemSmoke: true, dmgSha256, vectorSmoke: true, officialHomepageSmoke: true, skinSmoke: true },
      references: {
        vector: reference(releaseRoot, 'packaged-vector-smoke', 'packaged-vector-smoke.json'),
        officialHomepage: reference(releaseRoot, 'packaged-official-homepage-smoke', 'packaged-official-homepage-smoke.json'),
        skin: reference(releaseRoot, 'packaged-skin-smoke', 'packaged-skin-smoke.json'),
        macosDmgSmoke: reference(releaseRoot, 'macos-dmg-smoke', 'macos-dmg-smoke.json'),
      },
    },
    signing: {
      ...base(name), kind: 'signing', platform: 'darwin', arch: 'arm64', status: MACOS_FORMAL_DISTRIBUTION_POLICY.codeSigning,
      validationResult: 'Observed an ad-hoc signature without a Developer ID identity; notarization and Gatekeeper are recorded separately.',
      unsignedDistributionImpact: 'macOS Gatekeeper may require a manual Allow action.',
      gatekeeperImpact: 'macOS Gatekeeper may require a manual Allow action.',
      direct: {
        codeSigning: {
          expected: MACOS_FORMAL_DISTRIBUTION_POLICY.codeSigning,
          observed: 'ad_hoc',
          signature: 'adhoc',
          teamIdentifier: 'not set',
          authorities: [],
          hasDeveloperIdIdentity: false,
          details: { command: 'codesign -dv --verbose=4', exitCode: 0, outputSha256 },
          verification: { command: 'codesign --verify --deep --strict --verbose=2', exitCode: 0, outputSha256 },
        },
        notarization: {
          expected: MACOS_FORMAL_DISTRIBUTION_POLICY.notarization,
          observed: MACOS_FORMAL_DISTRIBUTION_POLICY.notarization,
          basis: 'The formal release has no Apple notarization stage.',
        },
        gatekeeper: {
          assessment: { command: 'spctl --assess --type execute --verbose=4', exitCode: 1, outputSha256 },
          observed: 'manual-confirmation-may-be-required',
        },
      },
    },
  }
  return receipts[name]
}
