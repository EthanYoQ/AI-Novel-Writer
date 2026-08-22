import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPnpmLockfileSha256 } from '../canonical-pnpm-lockfile-hash.mjs'
import {
  classifyMacosCodeSigning,
  COMMAND_PROFILES,
  MACOS_FORMAL_DISTRIBUTION_POLICY,
} from '../release-evidence-v2.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const smokeScriptPath = path.join(repositoryRoot, 'scripts', 'smoke-macos-dmg.sh')
const evidenceScript = path.join(repositoryRoot, 'scripts', 'release-evidence-v2.mjs')
const fixtures: string[] = []
const RECEIPT_FINALIZE_TIMEOUT_MS = 15_000

function readRequired(file: string) {
  expect(existsSync(file), `Missing macOS DMG smoke contract: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-macos-acceptance-'))
  fixtures.push(root)
  return root
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('macOS DMG acceptance receipt contract', () => {
  it('classifies an exit-zero ad-hoc signature as lacking a Developer ID distribution identity', () => {
    const observation = classifyMacosCodeSigning({
      detailsExitCode: 0,
      verificationExitCode: 0,
      detailsOutput: [
        'Executable=/Volumes/AI/AI小说作家.app/Contents/MacOS/AI小说作家',
        'Identifier=com.ethanyoq.ai-novel-writer',
        'Format=app bundle with Mach-O thin (arm64)',
        'Signature=adhoc',
        'TeamIdentifier=not set',
      ].join('\n'),
    })

    expect(observation).toEqual({
      observed: 'ad_hoc',
      signature: 'adhoc',
      teamIdentifier: 'not set',
      authorities: [],
      hasDeveloperIdIdentity: false,
    })
  })

  it('classifies a Developer ID identity separately so formal unsigned distribution can reject it', () => {
    const observation = classifyMacosCodeSigning({
      detailsExitCode: 0,
      verificationExitCode: 0,
      detailsOutput: [
        'Executable=/Volumes/AI/AI小说作家.app/Contents/MacOS/AI小说作家',
        'Identifier=com.ethanyoq.ai-novel-writer',
        'Format=app bundle with Mach-O thin (arm64)',
        'Signature size=8993',
        'Authority=Developer ID Application: Example Developer (ABCDE12345)',
        'Authority=Developer ID Certification Authority',
        'Authority=Apple Root CA',
        'TeamIdentifier=ABCDE12345',
      ].join('\n'),
    })

    expect(observation).toMatchObject({
      observed: 'developer_id_signed',
      teamIdentifier: 'ABCDE12345',
      authorities: [
        'Developer ID Application: Example Developer (ABCDE12345)',
        'Developer ID Certification Authority',
        'Apple Root CA',
      ],
      hasDeveloperIdIdentity: true,
    })
  })

  it('classifies a bundle with no signature as unsigned', () => {
    expect(classifyMacosCodeSigning({
      detailsExitCode: 1,
      verificationExitCode: 1,
      detailsOutput: '/Volumes/AI/AI小说作家.app: code object is not signed at all',
    })).toEqual({
      observed: 'unsigned',
      signature: null,
      teamIdentifier: null,
      authorities: [],
      hasDeveloperIdIdentity: false,
    })
  })

  it('records macOS-only mounted-DMG, packaged smoke, and signing facts from observed tools', () => {
    const script = readRequired(smokeScriptPath)

    expect(MACOS_FORMAL_DISTRIBUTION_POLICY.codeSigning).toBe('ad_hoc_or_unsigned')
    expect(script).toContain('evidence_root="${AI_NOVEL_RELEASE_EVIDENCE_ROOT:-$qualification_directory}"')
    expect(script).toContain('acceptance_directory="$evidence_root/acceptance"')
    expect(script).toContain('AI_NOVEL_RELEASE_TARGET_ARCH')
    expect(script).toContain("expected_runner_machine_arch='x86_64'")
    expect(script).toContain('runner_machine_arch="$(uname -m)"')
    expect(script).toContain('dmg-mount.json')
    expect(script).toContain('packaged-smoke.json')
    expect(script).toContain('signing.json')
    expect(script).toContain('hdiutil attach')
    expect(script).toContain('hdiutil detach')
    expect(script).toContain('codesign -dv')
    expect(script).toContain('codesign --verify')
    expect(script).toContain('spctl --assess')
    expect(script).toContain('validationResult')
    expect(script).toContain('unsignedDistributionImpact')
    expect(script).toContain('gatekeeperImpact')
    expect(script).toContain('codeSigning')
    expect(script).toContain('notarization')
    expect(script).toContain('gatekeeper')
    expect(script).toContain('classifyMacosCodeSigning')
    expect(script).toContain('MACOS_FORMAL_DISTRIBUTION_POLICY')
    expect(script).toContain('status: MACOS_FORMAL_DISTRIBUTION_POLICY.codeSigning')
    expect(script).toContain('observed: MACOS_FORMAL_DISTRIBUTION_POLICY.notarization')
    expect(script).not.toContain('unexpected-signed')
    expect(script).toContain('observations: [')
    expect(script).toContain('const direct = {')
    expect(script).toContain('direct,')

    for (const directFact of ['dmg:', 'app:', 'executable:', 'helper:', 'hash:', 'mount:', 'unmount:']) {
      expect(script).toContain(directFact)
    }
    for (const priorFact of [
      'packaged-vector-smoke.json',
      'packaged-official-homepage-smoke.json',
      'packaged-skin-smoke.json',
      'macos-dmg-smoke.json',
    ]) {
      expect(script).toContain(priorFact)
    }

    expect(script).not.toMatch(/(?:\.exe|latest\.yml|win-unpacked|NSIS|Start-Process)/i)
  })

  it('accepts the fixed Intel LanceDB binding step and rejects an unknown Intel macOS command step', () => {
    expect(COMMAND_PROFILES['macos-x64']).toEqual([
      'install-locked-dependencies',
      'verify-lancedb-darwin-x64-binding',
      'install-playwright-chromium',
      'renderer-browser-tests',
      'build-native-secure-helper',
      'test-suite',
      'build-macos-x64-package',
      'mounted-dmg-smoke',
    ])
    expect(COMMAND_PROFILES['macos-arm64']).not.toContain('verify-lancedb-darwin-x64-binding')
    expect(COMMAND_PROFILES.windows).not.toContain('verify-lancedb-darwin-x64-binding')

    const evidenceRoot = fixture()
    const releaseRoot = fixture()
    const init = spawnSync(process.execPath, [
      evidenceScript,
      'init',
      '--platform', 'macos-x64',
      '--evidence-root', evidenceRoot,
      '--repository', 'EthanYoQ/AI-Novel-Writer',
      '--commit', 'e'.repeat(40),
      '--run-id', '405',
      '--run-attempt', '1',
      '--runner-label', 'macos-15-intel',
      '--image-os', 'macos-15-intel',
      '--image-version', '20260726.1',
      '--expected-node-version', process.versions.node,
      '--expected-pnpm-version', '11.11.0',
      '--workflow-path', '.github/workflows/macos-x64-cloud-build.yml',
      '--workflow-name', 'macOS Intel x64 cloud package qualification',
      '--actor', 'release-operator',
      '--event', 'workflow_dispatch',
      '--dispatch-inputs-json', '{}',
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(init.status, init.stderr).toBe(0)
    for (const step of COMMAND_PROFILES['macos-x64']) {
      const recorded = spawnSync(process.execPath, [
        evidenceScript,
        'record',
        '--evidence-root', evidenceRoot,
        '--step', step,
        '--', process.execPath, '-e', '',
      ], { cwd: repositoryRoot, encoding: 'utf8' })
      expect(recorded.status, recorded.stderr).toBe(0)
    }
    const unknown = spawnSync(process.execPath, [
      evidenceScript,
      'record',
      '--evidence-root', evidenceRoot,
      '--step', 'unexpected-intel-macos-command',
      '--', process.execPath, '-e', '',
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(unknown.status, unknown.stderr).toBe(0)

    const rejected = spawnSync(process.execPath, [
      evidenceScript,
      'finalize',
      '--platform', 'macos-x64',
      '--evidence-root', evidenceRoot,
      '--release-root', releaseRoot,
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toContain('Release evidence command set is not exact for macos-x64')
  })

  it.each([
    {
      platform: 'macos-arm64',
      architecture: 'arm64',
      runnerMachine: 'arm64',
      runnerLabel: 'macos-14',
      imageOs: 'macos-14',
      workflowPath: '.github/workflows/macos-arm64-cloud-build.yml',
      workflowName: 'macOS ARM64 cloud package qualification',
    },
    {
      platform: 'macos-x64',
      architecture: 'x64',
      runnerMachine: 'x86_64',
      runnerLabel: 'macos-15-intel',
      imageOs: 'macos-15-intel',
      workflowPath: '.github/workflows/macos-x64-cloud-build.yml',
      workflowName: 'macOS Intel x64 cloud package qualification',
    },
  ] as const)('finalizes exactly the three macOS receipts for $platform into the release acceptance directory', ({
    platform,
    architecture,
    runnerMachine,
    runnerLabel,
    imageOs,
    workflowPath,
    workflowName,
  }) => {
    const evidenceRoot = fixture()
    const releaseRoot = fixture()
    const version = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version as string
    const init = spawnSync(process.execPath, [
      evidenceScript,
      'init',
      '--platform', platform,
      '--evidence-root', evidenceRoot,
      '--repository', 'EthanYoQ/AI-Novel-Writer',
      '--commit', 'd'.repeat(40),
      '--run-id', '404',
      '--run-attempt', '1',
      '--runner-label', runnerLabel,
      '--image-os', imageOs,
      '--image-version', '20260726.1',
      '--expected-node-version', process.versions.node,
      '--expected-pnpm-version', '11.11.0',
      '--workflow-path', workflowPath,
      '--workflow-name', workflowName,
      '--actor', 'release-operator',
      '--event', 'workflow_dispatch',
      '--dispatch-inputs-json', '{}',
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(init.status, init.stderr).toBe(0)
    for (const step of COMMAND_PROFILES[platform]) {
      const recorded = spawnSync(process.execPath, [
        evidenceScript,
        'record',
        '--evidence-root', evidenceRoot,
        '--step', step,
        '--', process.execPath, '-e', '',
      ], { cwd: repositoryRoot, encoding: 'utf8' })
      expect(recorded.status, recorded.stderr).toBe(0)
    }

    const dmg = `ai-novel-writer-mac-${architecture}-${version}-installer.dmg`
    writeFileSync(path.join(releaseRoot, dmg), 'macOS DMG', 'utf8')
    const dmgSha256 = createHash('sha256').update('macOS DMG').digest('hex')
    const commandOutputSha256 = 'b'.repeat(64)
    const architectureEvidence = { target: architecture, runnerMachine }
    for (const [file, kind] of [
      ['packaged-vector-smoke.json', 'packaged-vector-smoke'],
      ['packaged-official-homepage-smoke.json', 'packaged-official-homepage-smoke'],
      ['packaged-skin-smoke.json', 'packaged-skin-smoke'],
      ['macos-dmg-smoke.json', 'macos-dmg-smoke'],
    ] as const) {
      writeJson(path.join(releaseRoot, 'qualification', file), { schemaVersion: 1, kind, direct: { packaged: true } })
    }
    const qualificationEvidenceSha256 = (file: string) => createHash('sha256')
      .update(readFileSync(path.join(releaseRoot, 'qualification', file)))
      .digest('hex')
    writeJson(path.join(evidenceRoot, 'acceptance', 'dmg-mount.json'), {
      schemaVersion: 2,
      kind: 'dmg-mount',
      platform: 'darwin',
      arch: architecture,
      accepted: true,
      observations: ['Mounted the observed DMG before app validation.'],
      direct: {
        architecture: architectureEvidence,
        dmg: { path: '/tmp/AI Novel.dmg' },
        app: { path: '/Volumes/AI Novel/AI Novel.app' },
        executable: { path: '/Volumes/AI Novel/AI Novel.app/Contents/MacOS/AI Novel', present: true },
        helper: { path: '/Volumes/AI Novel/AI Novel.app/Contents/Resources/security/darwin-safe-file-system', present: true },
        hash: { algorithm: 'sha256', value: dmgSha256 },
        mount: { path: '/Volumes/AI Novel', attached: true },
        unmount: { attempted: true, succeeded: true },
      },
    })
    writeJson(path.join(evidenceRoot, 'acceptance', 'packaged-smoke.json'), {
      schemaVersion: 2,
      kind: 'packaged-smoke',
      platform: 'darwin',
      arch: architecture,
      accepted: true,
      observations: ['Validated vector, homepage, skin, and direct DMG smoke facts.'],
      direct: {
        architecture: architectureEvidence,
        secureFileSystemSmoke: true,
        vectorSmoke: true,
        officialHomepageSmoke: true,
        skinSmoke: true,
        dmgSha256,
      },
      references: {
        vector: { kind: 'packaged-vector-smoke', path: 'qualification/packaged-vector-smoke.json', sha256: qualificationEvidenceSha256('packaged-vector-smoke.json') },
        homepage: { kind: 'packaged-official-homepage-smoke', path: 'qualification/packaged-official-homepage-smoke.json', sha256: qualificationEvidenceSha256('packaged-official-homepage-smoke.json') },
        skin: { kind: 'packaged-skin-smoke', path: 'qualification/packaged-skin-smoke.json', sha256: qualificationEvidenceSha256('packaged-skin-smoke.json') },
        dmg: { kind: 'macos-dmg-smoke', path: 'qualification/macos-dmg-smoke.json', sha256: qualificationEvidenceSha256('macos-dmg-smoke.json') },
      },
    })
    const signingReceiptPath = path.join(evidenceRoot, 'acceptance', 'signing.json')
    writeJson(signingReceiptPath, {
      schemaVersion: 2,
      kind: 'signing',
      platform: 'darwin',
      arch: architecture,
      accepted: true,
      status: 'developer_id_signed',
      validationResult: 'Developer ID distribution identity observed.',
      unsignedDistributionImpact: 'macOS Gatekeeper can require an explicit user approval for this unsigned package.',
      gatekeeperImpact: 'Gatekeeper was accepted on this runner but remains independent from code-signing policy.',
      observations: ['codesign and spctl inspection completed.'],
      direct: {
        architecture: architectureEvidence,
        codeSigning: {
          expected: 'ad_hoc_or_unsigned',
          observed: 'developer_id_signed',
          signature: null,
          teamIdentifier: 'ABCDE12345',
          authorities: ['Developer ID Application: Example Developer (ABCDE12345)'],
          hasDeveloperIdIdentity: true,
          details: { command: 'codesign -dv --verbose=4', exitCode: 0, outputSha256: commandOutputSha256 },
          verification: { command: 'codesign --verify --deep --strict --verbose=2', exitCode: 0, outputSha256: commandOutputSha256 },
        },
        notarization: { expected: 'not_notarized', observed: 'not_notarized', basis: 'This formal release has no notarization stage.' },
        gatekeeper: {
          assessment: { command: 'spctl --assess --type execute --verbose=4', exitCode: 0, outputSha256: commandOutputSha256 },
          observed: 'accepted-on-runner',
        },
      },
    })

    const rejectedFinalize = spawnSync(process.execPath, [
      evidenceScript,
      'finalize',
      '--platform', platform,
      '--evidence-root', evidenceRoot,
      '--release-root', releaseRoot,
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(rejectedFinalize.status).not.toBe(0)
    expect(rejectedFinalize.stderr).toContain('requires ad-hoc or unsigned code signing without a Developer ID identity')

    writeJson(signingReceiptPath, {
      schemaVersion: 2,
      kind: 'signing',
      platform: 'darwin',
      arch: architecture,
      accepted: true,
      status: 'ad_hoc_or_unsigned',
      validationResult: 'Observed an ad-hoc signature without a Developer ID identity; notarization and Gatekeeper are modeled separately.',
      unsignedDistributionImpact: 'macOS Gatekeeper can require an explicit user approval for this unsigned and unnotarized package.',
      gatekeeperImpact: 'Gatekeeper can require manual confirmation for this unsigned and unnotarized package.',
      observations: ['codesign observed an ad-hoc signature without Developer ID identity.', 'spctl Gatekeeper assessment was recorded separately.'],
      direct: {
        architecture: architectureEvidence,
        codeSigning: {
          expected: 'ad_hoc_or_unsigned',
          observed: 'ad_hoc',
          signature: 'adhoc',
          teamIdentifier: 'not set',
          authorities: [],
          hasDeveloperIdIdentity: false,
          details: { command: 'codesign -dv --verbose=4', exitCode: 0, outputSha256: commandOutputSha256 },
          verification: { command: 'codesign --verify --deep --strict --verbose=2', exitCode: 0, outputSha256: commandOutputSha256 },
        },
        notarization: { expected: 'not_notarized', observed: 'not_notarized', basis: 'Unsigned packages cannot be notarized.' },
        gatekeeper: {
          assessment: { command: 'spctl --assess --type execute --verbose=4', exitCode: 1, outputSha256: commandOutputSha256 },
          observed: 'manual-confirmation-may-be-required',
        },
      },
    })

    const finalize = spawnSync(process.execPath, [
      evidenceScript,
      'finalize',
      '--platform', platform,
      '--evidence-root', evidenceRoot,
      '--release-root', releaseRoot,
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(finalize.status, finalize.stderr).toBe(0)

    const acceptanceDirectory = path.join(releaseRoot, 'qualification', 'acceptance')
    expect(existsSync(path.join(releaseRoot, 'qualification', 'release-contract.json'))).toBe(true)
    expect(existsSync(path.join(releaseRoot, 'qualification', 'run-ledger.json'))).toBe(true)
    expect(readFileSync(path.join(acceptanceDirectory, 'dmg-mount.json'), 'utf8')).toContain('"dmg-mount"')
    expect(readFileSync(path.join(acceptanceDirectory, 'packaged-smoke.json'), 'utf8')).toContain('"packaged-smoke"')
    expect(readFileSync(path.join(acceptanceDirectory, 'signing.json'), 'utf8')).toContain('"ad_hoc_or_unsigned"')
    expect(existsSync(path.join(releaseRoot, `${dmg}.sha256`))).toBe(true)
    const manifestPath = path.join(releaseRoot, 'manifest.json')
    const originalManifestText = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(originalManifestText)
    expect(manifest).toMatchObject({ platform, architecture })
    expect(manifest).not.toHaveProperty('arch')
    expect(manifest.acceptanceProfile).toEqual([
      'qualification/acceptance/dmg-mount.json',
      'qualification/acceptance/packaged-smoke.json',
      'qualification/acceptance/signing.json',
    ])

    const verify = spawnSync(process.execPath, [
      evidenceScript,
      'verify-bundle',
      '--platform', platform,
      '--bundle-root', releaseRoot,
      '--expected-commit', 'd'.repeat(40),
      '--expected-lockfile-sha256', canonicalPnpmLockfileSha256(path.join(repositoryRoot, 'pnpm-lock.yaml')),
      '--run-attempt', '1',
      '--version', version,
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(verify.status, verify.stderr).toBe(0)
    expect(JSON.parse(verify.stdout)).toMatchObject({
      platform,
      releaseFiles: [dmg, `${dmg}.sha256`],
    })

    const deprecatedManifest = { ...manifest, arch: architecture }
    writeFileSync(manifestPath, `${JSON.stringify(deprecatedManifest, null, 2)}\n`, 'utf8')
    const rejectedDeprecatedField = spawnSync(process.execPath, [
      evidenceScript,
      'verify-bundle',
      '--platform', platform,
      '--bundle-root', releaseRoot,
      '--expected-commit', 'd'.repeat(40),
      '--expected-lockfile-sha256', canonicalPnpmLockfileSha256(path.join(repositoryRoot, 'pnpm-lock.yaml')),
      '--run-attempt', '1',
      '--version', version,
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(rejectedDeprecatedField.status).not.toBe(0)
    expect(rejectedDeprecatedField.stderr).toContain('Qualification manifest must use architecture instead of deprecated arch')
    writeFileSync(manifestPath, originalManifestText, 'utf8')

    writeJson(path.join(acceptanceDirectory, 'signing.json'), {
      schemaVersion: 2,
      kind: 'signing',
      platform: 'darwin',
      arch: architecture,
      accepted: true,
      status: 'developer_id_signed',
      validationResult: 'Developer ID distribution identity observed.',
      unsignedDistributionImpact: 'macOS Gatekeeper impact must remain explicit.',
      gatekeeperImpact: 'Gatekeeper was accepted on this runner but remains independent from code-signing policy.',
      observations: ['codesign observed a signature.'],
      direct: {
        architecture: architectureEvidence,
        codeSigning: {
          expected: 'ad_hoc_or_unsigned',
          observed: 'developer_id_signed',
          signature: null,
          teamIdentifier: 'ABCDE12345',
          authorities: ['Developer ID Application: Example Developer (ABCDE12345)'],
          hasDeveloperIdIdentity: true,
          details: { command: 'codesign -dv --verbose=4', exitCode: 0, outputSha256: commandOutputSha256 },
          verification: { command: 'codesign --verify --deep --strict --verbose=2', exitCode: 0, outputSha256: commandOutputSha256 },
        },
        notarization: { expected: 'not_notarized', observed: 'not_notarized', basis: 'This formal release has no notarization stage.' },
        gatekeeper: {
          assessment: { command: 'spctl --assess --type execute --verbose=4', exitCode: 0, outputSha256: commandOutputSha256 },
          observed: 'accepted-on-runner',
        },
      },
    })
    const rejectedVerify = spawnSync(process.execPath, [
      evidenceScript,
      'verify-bundle',
      '--platform', platform,
      '--bundle-root', releaseRoot,
      '--expected-commit', 'd'.repeat(40),
      '--expected-lockfile-sha256', canonicalPnpmLockfileSha256(path.join(repositoryRoot, 'pnpm-lock.yaml')),
      '--run-attempt', '1',
      '--version', version,
    ], { cwd: repositoryRoot, encoding: 'utf8' })
    expect(rejectedVerify.status).not.toBe(0)
    expect(rejectedVerify.stderr).toContain('requires ad-hoc or unsigned code signing without a Developer ID identity')
  }, RECEIPT_FINALIZE_TIMEOUT_MS)
})
