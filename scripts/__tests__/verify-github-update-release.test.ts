import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { verifyGithubWindowsUpdateRelease } from '../verify-github-update-release.mjs'

const fixtures: string[] = []

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-github-release-'))
  fixtures.push(root)
  return root
}

function write(root: string, relative: string, content: string | Buffer) {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

function sha256(content: string | Buffer) {
  return createHash('sha256').update(content).digest('hex')
}

function createArtifacts(root: string) {
  const installer = write(root, 'ai-novel-writer-setup-0.2.6.exe', 'installer')
  const latestMetadata = write(root, 'latest.yml', 'version: 0.2.6\nsha512: verified\n')
  const blockMap = write(root, 'ai-novel-writer-setup-0.2.6.exe.blockmap', 'blockmap')
  return { installer, latestMetadata, blockMap, version: '0.2.6' }
}

function releaseFor(artifacts: ReturnType<typeof createArtifacts>) {
  return {
    id: 123,
    tag_name: 'v0.2.6',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: path.basename(artifacts.installer),
        size: 9,
        digest: `sha256:${sha256('installer')}`,
      },
      {
        name: path.basename(artifacts.latestMetadata),
        size: Buffer.byteLength('version: 0.2.6\nsha512: verified\n'),
        digest: `sha256:${sha256('version: 0.2.6\nsha512: verified\n')}`,
        browser_download_url: 'https://example.test/latest.yml',
      },
      {
        name: path.basename(artifacts.blockMap),
        size: 8,
        digest: `sha256:${sha256('blockmap')}`,
      },
    ],
  }
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GitHub Windows update release verification', () => {
  it('accepts a non-draft final release whose remote metadata matches local verified artifacts', async () => {
    const artifacts = createArtifacts(fixture())
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/releases/tags/v0.2.6')) return new Response(JSON.stringify(releaseFor(artifacts)))
      return new Response('version: 0.2.6\nsha512: verified\n')
    })

    await expect(verifyGithubWindowsUpdateRelease({
      tag: 'v0.2.6',
      localArtifacts: artifacts,
      fetcher,
      apiBaseUrl: 'https://api.example.test',
    })).resolves.toMatchObject({
      tag: 'v0.2.6',
      installer: 'ai-novel-writer-setup-0.2.6.exe',
    })
  })

  it('keeps the Windows updater verification on latest.yml when a formal release also contains macOS assets', async () => {
    const artifacts = createArtifacts(fixture())
    const release = {
      ...releaseFor(artifacts),
      assets: [
        ...releaseFor(artifacts).assets,
        {
          name: 'ai-novel-writer-0.2.6-arm64.dmg',
          size: 7,
          digest: `sha256:${sha256('mac-dmg')}`,
          browser_download_url: 'https://example.test/ai-novel-writer-0.2.6-arm64.dmg',
        },
        {
          name: 'ai-novel-writer-0.2.6-arm64.dmg.sha256',
          size: 64,
          digest: `sha256:${sha256('mac-checksum')}`,
          browser_download_url: 'https://example.test/ai-novel-writer-0.2.6-arm64.dmg.sha256',
        },
      ],
    }
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/releases/tags/v0.2.6')) return new Response(JSON.stringify(release))
      return new Response('version: 0.2.6\nsha512: verified\n')
    })

    await expect(verifyGithubWindowsUpdateRelease({
      tag: 'v0.2.6',
      localArtifacts: artifacts,
      fetcher,
      apiBaseUrl: 'https://api.example.test',
    })).resolves.toMatchObject({
      installer: 'ai-novel-writer-setup-0.2.6.exe',
      latestMetadata: 'latest.yml',
      blockMap: 'ai-novel-writer-setup-0.2.6.exe.blockmap',
    })

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/repos/EthanYoQ/AI-Novel-Writer/releases/tags/v0.2.6',
      'https://example.test/latest.yml',
    ])
  })

  it('rejects a draft, prerelease, or portable ZIP release before accepting updater assets', async () => {
    const artifacts = createArtifacts(fixture())
    const invalidRelease = {
      ...releaseFor(artifacts),
      draft: true,
      prerelease: true,
      assets: [
        ...releaseFor(artifacts).assets,
        { name: 'AI-Novel-Writer-0.2.6-windows-x64.zip', size: 1 },
      ],
    }
    const fetcher = vi.fn(async () => new Response(JSON.stringify(invalidRelease)))

    await expect(verifyGithubWindowsUpdateRelease({
      tag: 'v0.2.6',
      localArtifacts: artifacts,
      fetcher,
      apiBaseUrl: 'https://api.example.test',
    })).rejects.toThrow('must not be a draft')
  })

  it('rejects public latest.yml that differs from the locally verified metadata', async () => {
    const artifacts = createArtifacts(fixture())
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/releases/tags/v0.2.6')) return new Response(JSON.stringify(releaseFor(artifacts)))
      return new Response('version: 0.2.6\nsha512: tampered\n')
    })

    await expect(verifyGithubWindowsUpdateRelease({
      tag: 'v0.2.6',
      localArtifacts: artifacts,
      fetcher,
      apiBaseUrl: 'https://api.example.test',
    })).rejects.toThrow('Public latest.yml differs')
  })

  it('requires GitHub asset digests instead of trusting an equal asset size', async () => {
    const artifacts = createArtifacts(fixture())
    const release = releaseFor(artifacts)
    Reflect.deleteProperty(release.assets[0], 'digest')
    const fetcher = vi.fn(async () => new Response(JSON.stringify(release)))

    await expect(verifyGithubWindowsUpdateRelease({
      tag: 'v0.2.6',
      localArtifacts: artifacts,
      fetcher,
      apiBaseUrl: 'https://api.example.test',
    })).rejects.toThrow('must expose a SHA-256 digest')
  })
})
