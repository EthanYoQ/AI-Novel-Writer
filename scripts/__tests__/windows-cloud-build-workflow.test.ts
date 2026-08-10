import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'windows-cloud-build-test.yml')
const evidenceScriptPath = path.join(repositoryRoot, 'scripts', 'release-evidence-v2.mjs')
const forbiddenJobEnvContextPattern = /\$\{\{\s*runner(?:\.|\[)/i
const windowsIt = process.platform === 'win32' ? it : it.skip

function readRequiredFile(file: string) {
  expect(existsSync(file), `Missing required cloud-build contract file: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

function namedStep(source: string, name: string) {
  const start = source.indexOf(`- name: ${name}`)
  expect(start, `Missing workflow step: ${name}`).toBeGreaterThanOrEqual(0)
  const remainder = source.slice(start)
  const nextStep = remainder.search(/\r?\n\s{6}- name:/)
  return nextStep < 0 ? remainder : remainder.slice(0, nextStep)
}

function jobLevelEnvBlocks(source: string) {
  const lines = source.split(/\r?\n/)
  const blocks: string[] = []
  let inJobs = false
  let inJob = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    const indentation = line.length - line.trimStart().length

    if (!inJobs) {
      if (/^jobs:\s*(?:#.*)?$/.test(line)) inJobs = true
      continue
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (indentation === 0) {
      inJobs = false
      inJob = false
      continue
    }
    if (indentation === 2 && /^ {2}[^\s:#][^:]*:\s*(?:#.*)?$/.test(line)) {
      inJob = true
      continue
    }
    if (!inJob) continue

    const env = line.match(/^ {4}env:(?<inline>.*)$/)
    if (!env) continue

    const block = [env.groups?.inline ?? '']
    let nestedIndex = index + 1
    for (; nestedIndex < lines.length; nestedIndex += 1) {
      const nestedLine = lines[nestedIndex]
      const nestedTrimmed = nestedLine.trim()
      const nestedIndentation = nestedLine.length - nestedLine.trimStart().length
      if (nestedTrimmed !== '' && !nestedTrimmed.startsWith('#') && nestedIndentation <= 4) break
      block.push(nestedLine)
    }
    blocks.push(block.join('\n'))
    index = nestedIndex - 1
  }

  return blocks
}

describe('Windows cloud build workflow contract', () => {
  it('uses an isolated, manual, pinned, runtime-qualified Windows build without release publication', () => {
    const workflow = readRequiredFile(workflowPath)
    const evidenceScript = readRequiredFile(evidenceScriptPath)

    const triggerBlock = workflow.match(/^on:\r?\n(?<triggers>(?: {2}.*(?:\r?\n|$))*)/m)?.groups?.triggers
    expect(triggerBlock?.trim()).toBe('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s{2}(?:push|pull_request|schedule):/m)
    expect(workflow).toMatch(/^permissions:\r?\n\s{2}contents:\s*read\s*$/m)
    expect(workflow).toContain('runs-on: windows-2022')
    expect(workflow).toContain('timeout-minutes: 60')
    expect(workflow).toMatch(/concurrency:\r?\n\s+group:\s+.+\r?\n\s+cancel-in-progress:\s+false/)

    const actionUses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(match => match[1])
    expect(actionUses).toEqual([
      'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
      'pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    ])
    expect(workflow).toMatch(/node-version:\s*['"]?22\.23\.1['"]?/)
    expect(workflow).toMatch(/version:\s*['"]?11\.11\.0['"]?/)
    expect(workflow).toContain('pnpm install --frozen-lockfile')
    expect(workflow).toContain('pnpm run build:win')
    expect(workflow).not.toContain('build:win-dir')

    expect(workflow).toContain('AI-Novel-Writer-0.2.5-windows-x64.zip')
    expect(workflow).toContain('22b38b7337a456882bf130ccb898f17616fffb85d6c8b8b3d0ee431409f18531')
    expect(workflow).toContain('AI_NOVEL_PREVIOUS_PORTABLE_ZIP')
    expect(workflow).toContain('release-evidence-v2.mjs finalize --platform windows')

    const portableDownload = namedStep(workflow, 'Download verified v0.2.5 portable migration input')
    expect(portableDownload).toContain("$portableZip = Join-Path $env:RUNNER_TEMP 'AI-Novel-Writer-0.2.5-windows-x64.zip'")
    expect(portableDownload).toContain('"AI_NOVEL_PREVIOUS_PORTABLE_ZIP=$portableZip" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8')

    expect(evidenceScript).toContain("gateLevel: 'RUNTIME_VERIFIED'")
    expect(evidenceScript).toContain('releaseCreated: false')
    expect(evidenceScript).toContain('lockfileSha256')
    expect(evidenceScript).toContain('runnerImage')
    expect(evidenceScript).toContain('SHA256SUMS.txt')

    const successfulArtifact = namedStep(workflow, 'Upload runtime-verified Windows package')
    const failedArtifact = namedStep(workflow, 'Upload Windows build diagnostics')
    expect(successfulArtifact).toMatch(/if:\s*\$\{\{\s*success\(\)\s*\}\}/)
    expect(successfulArtifact).toMatch(/retention-days:\s*7/)
    expect(successfulArtifact).toContain('manifest.json')
    expect(successfulArtifact).toContain('SHA256SUMS.txt')
    expect(successfulArtifact).toContain('qualification/packaged-vector-smoke.json')
    expect(successfulArtifact).toContain('qualification/packaged-official-homepage-smoke.json')
    expect(successfulArtifact).toContain('qualification/packaged-skin-smoke.json')
    expect(successfulArtifact).not.toContain('win-unpacked')
    expect(successfulArtifact).not.toMatch(/failure\(\)/)
    expect(failedArtifact).toMatch(/if:\s*\$\{\{\s*failure\(\)\s*\}\}/)
    expect(failedArtifact).toContain('ai-novel-cloud-build-diagnostics')
    expect(failedArtifact).not.toMatch(/release\/|\.exe|win-unpacked/i)
    expect(failedArtifact).not.toMatch(/success\(\)/)

    expect(workflow).not.toMatch(/\b(?:gh\s+release|softprops\/action-gh-release|actions\/(?:create-release|upload-release-asset)|git\s+tag|git\s+push\s+.*(?:tag|refs\/tags)|create-release|upload-release|npm\s+publish|signtool|codesign)\b/i)
  })

  it('does not interpolate runner context in job-level environment variables', () => {
    const workflow = readRequiredFile(workflowPath)

    expect(jobLevelEnvBlocks(workflow).join('\n')).not.toMatch(forbiddenJobEnvContextPattern)
  })

  it('freezes v2 evidence before install and records install, browser, build, and finalization without broad diagnostics', () => {
    const workflow = readRequiredFile(workflowPath)
    const checkout = namedStep(workflow, 'Check out source')
    const initialize = namedStep(workflow, 'Initialize frozen Windows release evidence')
    const install = namedStep(workflow, 'Install locked dependencies')
    const browserInstall = namedStep(workflow, 'Install Playwright Chromium')
    const browserTest = namedStep(workflow, 'Run renderer browser tests')
    const build = namedStep(workflow, 'Run complete Windows release gate')
    const finalize = namedStep(workflow, 'Finalize Windows release evidence')
    const diagnostics = namedStep(workflow, 'Collect Windows build diagnostics')
    const upload = namedStep(workflow, 'Upload runtime-verified Windows package')

    expect(checkout).toContain('ref: ${{ github.sha }}')
    expect(checkout).toContain('persist-credentials: false')
    expect(workflow.indexOf('Initialize frozen Windows release evidence'))
      .toBeLessThan(workflow.indexOf('Install locked dependencies'))
    expect(initialize).toContain('release-evidence-v2.mjs init --platform windows')
    expect(initialize).toContain('AI_NOVEL_RELEASE_EVIDENCE_ROOT')
    expect(initialize).toContain('git rev-parse HEAD')
    expect(initialize).toContain('--expected-node-version 22.23.1')
    expect(initialize).toContain('--expected-pnpm-version 11.11.0')
    expect(initialize).toContain('--run-attempt "$env:GITHUB_RUN_ATTEMPT"')
    expect(initialize).toContain("--workflow-path '.github/workflows/windows-cloud-build-test.yml'")
    expect(initialize).toContain("--workflow-name 'Windows cloud package qualification'")
    expect(initialize).toContain('--actor "$env:GITHUB_ACTOR"')
    expect(initialize).toContain('--event "$env:GITHUB_EVENT_NAME"')
    expect(initialize).toContain("--dispatch-inputs-json '{}'")
    expect(initialize).not.toContain('AI_NOVEL_RELEASE_EVIDENCE_NODE_VERSION')
    expect(initialize).not.toContain('AI_NOVEL_RELEASE_EVIDENCE_PNPM_VERSION')
    expect(initialize).not.toContain('$actualNodeVersion')
    expect(initialize).not.toContain('$actualPnpmVersion')
    for (const [step, safeName, fixedCommand] of [
      [install, 'install-locked-dependencies', 'pnpm install --frozen-lockfile'],
      [browserInstall, 'install-playwright-chromium', 'pnpm exec playwright install chromium'],
      [browserTest, 'renderer-browser-tests', 'pnpm run test:browser'],
      [build, 'complete-windows-release-gate', 'pnpm run build:win'],
    ] as const) {
      expect(step).toContain('release-evidence-v2.mjs record')
      expect(step).toContain(`--step ${safeName}`)
      expect(step).toContain('-- "$env:ComSpec" /d /s /c')
      expect(step).toContain(`"${fixedCommand}"`)
    }
    expect(finalize).toContain('release-evidence-v2.mjs finalize --platform windows')
    expect(finalize).toContain('--release-root "release/$version"')
    expect(upload).toContain('release/*/qualification/release-contract.json')
    expect(upload).toContain('release/*/qualification/run-ledger.json')
    expect(upload).toContain('release/*/qualification/acceptance/*.json')
    expect(diagnostics).not.toContain('Copy-Item -LiteralPath $_.FullName')
    expect(diagnostics).not.toMatch(/-Recurse\b/)
    expect(diagnostics).not.toContain('monitor-control-log.jsonl')
    expect(diagnostics).toContain('orchestrator-failures.jsonl')
    expect(diagnostics).toContain('monitor-status.json')
  })

  windowsIt('executes pnpm through the explicit trusted command processor and records the sanitized result', () => {
    const evidenceRoot = mkdtempSync(path.join(tmpdir(), 'ai-novel-windows-comspec-record-'))
    try {
      const initialize = spawnSync(process.execPath, [
        evidenceScriptPath,
        'init',
        '--platform', 'windows',
        '--evidence-root', evidenceRoot,
        '--repository', 'EthanYoQ/AI-Novel-Writer',
        '--commit', 'a'.repeat(40),
        '--run-id', '123',
        '--run-attempt', '1',
        '--runner-label', 'windows-2022',
        '--image-os', 'Windows',
        '--image-version', 'test',
        '--expected-node-version', process.versions.node,
        '--expected-pnpm-version', '11.11.0',
        '--workflow-path', '.github/workflows/windows-cloud-build-test.yml',
        '--workflow-name', 'Windows cloud package qualification',
        '--actor', 'release-operator',
        '--event', 'workflow_dispatch',
        '--dispatch-inputs-json', '{}',
      ], { cwd: repositoryRoot, encoding: 'utf8' })
      expect(initialize.status, initialize.stderr).toBe(0)

      const commandProcessor = process.env.ComSpec
      expect(commandProcessor).toBeTruthy()
      const recorded = spawnSync(process.execPath, [
        evidenceScriptPath,
        'record',
        '--evidence-root', evidenceRoot,
        '--step', 'pnpm-comspec-probe',
        '--', commandProcessor!, '/d', '/s', '/c', 'pnpm --version',
      ], { cwd: repositoryRoot, encoding: 'utf8' })
      expect(recorded.status, recorded.stderr).toBe(0)

      const ledger = JSON.parse(readFileSync(path.join(evidenceRoot, 'run-ledger.json'), 'utf8')) as {
        commands: Array<{ step: string, command: { executable: string, argumentCount: number }, exitCode: number }>
      }
      expect(ledger.commands).toEqual([
        expect.objectContaining({
          step: 'pnpm-comspec-probe',
          command: { executable: path.basename(commandProcessor!), argumentCount: 4 },
          exitCode: 0,
        }),
      ])
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'block mapping',
      [
        'jobs:',
        '  package:',
        '    runs-on: windows-2022',
        '    env:',
        '      INPUT: "${{ runner.temp }}/input.zip"',
        '    steps: []',
      ].join('\n'),
    ],
    [
      'inline mapping',
      [
        'jobs:',
        '  package:',
        '    runs-on: windows-2022',
        '    env: { INPUT: "${{ runner.temp }}/input.zip" }',
        '    steps: []',
      ].join('\n'),
    ],
  ])('recognizes runner context in a job-level %s', (_mappingStyle, fixture) => {
    const blocks = jobLevelEnvBlocks(fixture)

    expect(blocks).toHaveLength(1)
    expect(blocks.join('\n')).toMatch(forbiddenJobEnvContextPattern)
  })
})
