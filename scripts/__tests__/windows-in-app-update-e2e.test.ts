import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  OFFICIAL_UPDATE_REPOSITORY,
  WINDOWS_RELEASE_MONITOR_READY_TIMEOUT_MS,
  WINDOWS_UPDATE_RUNNER_COMMAND,
  createOfficialUpdatePlan,
  normalizeFinalReleaseTag,
  parseWindowsInAppUpdateE2eCli,
} from '../windows-in-app-update-e2e.mjs'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-novel-update-e2e-test-'))
  temporaryRoots.push(root)
  return root
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha512(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64')
}

function response(body: unknown, contentType = 'application/json'): Response {
  return new Response(
    Buffer.isBuffer(body) ? body : JSON.stringify(body),
    { status: 200, headers: { 'content-type': contentType } },
  )
}

function releaseFixture(tag: string) {
  const version = tag.slice(1)
  const installerName = `ai-novel-writer-setup-${version}.exe`
  const installer = Buffer.from(`official installer ${tag}`, 'utf8')
  const blockMap = Buffer.from(`official blockmap ${tag}`, 'utf8')
  const latestYml = Buffer.from([
    `version: ${version}`,
    'files:',
    `  - url: ${installerName}`,
    `    sha512: ${sha512(installer)}`,
    `    size: ${installer.length}`,
    `path: ${installerName}`,
    `sha512: ${sha512(installer)}`,
  ].join('\n'), 'utf8')
  const asset = (name: string, bytes: Buffer) => ({
    name,
    size: bytes.length,
    digest: `sha256:${sha256(bytes)}`,
    browser_download_url: `https://downloads.example.test/${tag}/${encodeURIComponent(name)}`,
  })
  return {
    release: {
      id: tag,
      tag_name: tag,
      draft: false,
      prerelease: false,
      assets: [
        asset('latest.yml', latestYml),
        asset(installerName, installer),
        asset(`${installerName}.blockmap`, blockMap),
      ],
    },
    files: new Map([
      [`https://downloads.example.test/${tag}/${encodeURIComponent('latest.yml')}`, latestYml],
      [`https://downloads.example.test/${tag}/${encodeURIComponent(installerName)}`, installer],
      [`https://downloads.example.test/${tag}/${encodeURIComponent(`${installerName}.blockmap`)}`, blockMap],
    ]),
  }
}

function fixtureFetcher(fromTag: string, expectedTag: string, options: { latestTag?: string, corruptDigest?: boolean } = {}) {
  const from = releaseFixture(fromTag)
  const expected = releaseFixture(expectedTag)
  if (options.corruptDigest) {
    expected.release.assets[1].digest = `sha256:${'0'.repeat(64)}`
  }
  const latestTag = options.latestTag ?? expectedTag
  const requests: string[] = []
  const fetcher = async (url: string | URL) => {
    const value = String(url)
    requests.push(value)
    if (value === 'https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/latest') {
      return response({ ...expected.release, tag_name: latestTag })
    }
    if (value === `https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/tags/${fromTag}`) {
      return response(from.release)
    }
    if (value === `https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/tags/${expectedTag}`) {
      return response(expected.release)
    }
    const bytes = from.files.get(value) ?? expected.files.get(value)
    if (bytes) return response(bytes, 'application/octet-stream')
    return new Response('not found', { status: 404 })
  }
  return { fetcher, requests }
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
  }
})

describe('Windows official in-app update E2E contract', () => {
  it('pins the official repository and accepts final semantic release tags only', () => {
    expect(OFFICIAL_UPDATE_REPOSITORY).toEqual({ owner: 'EthanYoQ', repo: 'AI-Novel-Writer' })
    expect(normalizeFinalReleaseTag('v0.5.2', 'from_tag')).toBe('v0.5.2')
    expect(normalizeFinalReleaseTag('0.6.0', 'expected_tag')).toBe('v0.6.0')

    for (const invalid of ['v0.6.0-rc.1', 'v0.6.0+build.4', 'refs/heads/main', ' v0.6.0', 'v0.6']) {
      expect(() => normalizeFinalReleaseTag(invalid, 'expected_tag')).toThrow('final semantic version')
    }
  })

  it('writes verified official assets only when expected_tag is the current formal latest release', async () => {
    const evidenceRoot = temporaryRoot()
    const { fetcher, requests } = fixtureFetcher('v0.5.2', 'v0.6.0')

    const plan = await createOfficialUpdatePlan({
      fromTag: 'v0.5.2',
      expectedTag: 'v0.6.0',
      evidenceRoot,
      fetcher,
    })

    expect(plan).toMatchObject({
      schemaVersion: 1,
      officialRepository: OFFICIAL_UPDATE_REPOSITORY,
      from: { tag: 'v0.5.2', version: '0.5.2' },
      expected: { tag: 'v0.6.0', version: '0.6.0' },
      latest: { tag: 'v0.6.0' },
    })
    expect(plan.expected.assets.installer.name).toBe('ai-novel-writer-setup-0.6.0.exe')
    expect(readFileSync(join(evidenceRoot, 'release-plan.json'), 'utf8')).toContain('sha256:')
    expect(requests).toEqual(expect.arrayContaining([
      'https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/latest',
      'https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/tags/v0.5.2',
      'https://api.github.com/repos/EthanYoQ/AI-Novel-Writer/releases/tags/v0.6.0',
    ]))
    expect(requests.every(url => url.includes('EthanYoQ/AI-Novel-Writer') || url.startsWith('https://downloads.example.test/'))).toBe(true)
  })

  it('rejects a non-latest expected tag and any mismatched GitHub asset digest', async () => {
    await expect(createOfficialUpdatePlan({
      fromTag: 'v0.5.2',
      expectedTag: 'v0.6.0',
      evidenceRoot: temporaryRoot(),
      fetcher: fixtureFetcher('v0.5.2', 'v0.6.0', { latestTag: 'v0.6.1' }).fetcher,
    })).rejects.toThrow('expected_tag must equal the current latest formal Release')

    await expect(createOfficialUpdatePlan({
      fromTag: 'v0.5.2',
      expectedTag: 'v0.6.0',
      evidenceRoot: temporaryRoot(),
      fetcher: fixtureFetcher('v0.5.2', 'v0.6.0', { corruptDigest: true }).fetcher,
    })).rejects.toThrow('SHA-256 digest does not match')
  })

  it('exposes a CLI with only release-tag and evidence-root inputs', () => {
    expect(parseWindowsInAppUpdateE2eCli([
      'prepare',
      '--from-tag', 'v0.5.2',
      '--expected-tag', 'v0.6.0',
      '--evidence-root', 'C:\\evidence',
    ])).toEqual({
      command: 'prepare',
      fromTag: 'v0.5.2',
      expectedTag: 'v0.6.0',
      evidenceRoot: 'C:\\evidence',
    })
    expect(() => parseWindowsInAppUpdateE2eCli([
      'prepare', '--from-tag', 'v0.5.2', '--expected-tag', 'v0.6.0', '--repository', 'other/repo',
    ])).toThrow('Usage:')
  })

  it('keeps the dispatch-only workflow and real UI/update evidence requirements explicit', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/windows-in-app-update-e2e.yml'), 'utf8')
    const powershell = readFileSync(resolve(process.cwd(), 'scripts/windows-in-app-update-e2e.ps1'), 'utf8')
    const driver = readFileSync(resolve(process.cwd(), 'scripts/windows-in-app-update-e2e-driver.mjs'), 'utf8')

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m)
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).toContain('${{ env.AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT }}/*.json')
    expect(workflow).not.toContain('path: ${{ env.AI_NOVEL_UPDATE_E2E_EVIDENCE_ROOT }}')
    expect(workflow).toContain('node scripts/windows-in-app-update-e2e.mjs run')
    expect(workflow).toContain('EthanYoQ/AI-Novel-Writer')
    expect(workflow).toContain('v0.5.2')
    expect(workflow).toContain('v0.6.0')

    expect(powershell).toContain('smoke-win-installer.ps1')
    expect(powershell).toContain('monitor-win-release-gate.ps1')
    expect(powershell).toContain('AI_NOVEL_VELA_HOME')
    expect(powershell).toContain('Get-FileHash')
    expect(powershell).toContain('--remote-debugging-port')
    expect(powershell).toContain('$e2eInstallRoot')
    expect(powershell).not.toMatch(/\$installRoot\s*=/)
    expect(driver).toContain('connectOverCDP')
    expect(driver).toContain('检查更新')
    expect(driver).toContain('Check for updates')
    expect(driver).toContain('立即重启更新')
    expect(driver).toContain('Restart and update now')
  })

  it('keeps the PowerShell runner ASCII-safe for Windows PowerShell child-process parsing', () => {
    const powershellBytes = readFileSync(resolve(process.cwd(), 'scripts/windows-in-app-update-e2e.ps1'))

    expect([...powershellBytes].every(byte => byte < 0x80)).toBe(true)
  })

  it('allows a cold GitHub runner enough time to initialize the release monitor', () => {
    expect(WINDOWS_RELEASE_MONITOR_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('runs the E2E orchestration under the workflow PowerShell runtime', () => {
    expect(WINDOWS_UPDATE_RUNNER_COMMAND).toBe('pwsh.exe')
  })
})
