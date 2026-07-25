import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..', '..')
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'windows-cloud-build-test.yml')
const manifestScriptPath = path.join(repositoryRoot, 'scripts', 'generate-cloud-build-manifest.mjs')
const forbiddenJobEnvContextPattern = /\$\{\{\s*runner(?:\.|\[)/i

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
    const manifestScript = readRequiredFile(manifestScriptPath)

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
    expect(workflow).toContain('node scripts/generate-cloud-build-manifest.mjs')

    const portableDownload = namedStep(workflow, 'Download verified v0.2.5 portable migration input')
    expect(portableDownload).toContain("$portableZip = Join-Path $env:RUNNER_TEMP 'AI-Novel-Writer-0.2.5-windows-x64.zip'")
    expect(portableDownload).toContain('"AI_NOVEL_PREVIOUS_PORTABLE_ZIP=$portableZip" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8')

    expect(manifestScript).toContain("gateLevel: 'RUNTIME_VERIFIED'")
    expect(manifestScript).toContain('releaseCreated: false')
    expect(manifestScript).toContain('lockfileSha256')
    expect(manifestScript).toContain('runnerImage')
    expect(manifestScript).toContain('SHA256SUMS.txt')

    const successfulArtifact = namedStep(workflow, 'Upload runtime-verified Windows package')
    const failedArtifact = namedStep(workflow, 'Upload Windows build diagnostics')
    expect(successfulArtifact).toMatch(/if:\s*\$\{\{\s*success\(\)\s*\}\}/)
    expect(successfulArtifact).toMatch(/retention-days:\s*7/)
    expect(successfulArtifact).toContain('manifest.json')
    expect(successfulArtifact).toContain('SHA256SUMS.txt')
    expect(successfulArtifact).toContain('qualification/packaged-vector-smoke.json')
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
