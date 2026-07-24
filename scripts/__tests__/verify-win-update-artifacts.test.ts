import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadElectronBuilderConfig,
  verifyWindowsUpdateArtifacts,
} from '../verify-win-update-artifacts.mjs'

const fixtures: string[] = []

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ai-novel-update-package-'))
  fixtures.push(root)
  return root
}

function write(root: string, relative: string, content: string | Buffer) {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

function sha512(content: string | Buffer) {
  return createHash('sha512').update(content).digest('base64')
}

function createFormalWindowsRelease(root: string, options: { sha512?: string; releaseType?: string } = {}) {
  const installerName = 'AI小说作家-0.2.6-setup.exe'
  const installer = Buffer.from('known-good-nsis-installer')
  const installerSha512 = options.sha512 ?? sha512(installer)

  write(root, installerName, installer)
  write(root, `${installerName}.blockmap`, '{"version":"2","files":[]}')
  write(
    root,
    'latest.yml',
    [
      'version: 0.2.6',
      'files:',
      `  - url: ${installerName}`,
      `    sha512: ${installerSha512}`,
      `    size: ${installer.length}`,
      `path: ${installerName}`,
      `sha512: ${installerSha512}`,
      'releaseDate: 2026-07-25T00:00:00.000Z',
      '',
    ].join('\n'),
  )
  write(
    root,
    'win-unpacked/resources/app-update.yml',
    [
      'provider: github',
      'owner: EthanYoQ',
      'repo: AI-Novel-Writer',
      `releaseType: ${options.releaseType ?? 'release'}`,
      'channel: latest',
      'tagNamePrefix: v',
      '',
    ].join('\n'),
  )

  return { installerName, installer }
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows update release artifact verification', () => {
  it('accepts a formal GitHub NSIS update package whose metadata resolves to the installer', () => {
    const root = fixture()
    const { installerName } = createFormalWindowsRelease(root)

    expect(verifyWindowsUpdateArtifacts(root)).toMatchObject({
      installer: path.join(root, installerName),
      latestMetadata: path.join(root, 'latest.yml'),
      blockMap: path.join(root, `${installerName}.blockmap`),
      embeddedUpdateConfig: path.join(root, 'win-unpacked/resources/app-update.yml'),
      version: '0.2.6',
      provider: 'github',
      owner: 'EthanYoQ',
      repo: 'AI-Novel-Writer',
      releaseType: 'release',
    })
  })

  it('rejects an installer whose latest metadata hash cannot authenticate the download', () => {
    const root = fixture()
    createFormalWindowsRelease(root, { sha512: sha512('different-installer') })

    expect(() => verifyWindowsUpdateArtifacts(root)).toThrow('does not match latest.yml')
  })

  it('rejects update metadata that points to a prerelease channel', () => {
    const root = fixture()
    createFormalWindowsRelease(root, { releaseType: 'prerelease' })

    expect(() => verifyWindowsUpdateArtifacts(root)).toThrow('formal GitHub releases')
  })

  it('rejects release metadata that does not match the expected formal version', () => {
    const root = fixture()
    createFormalWindowsRelease(root)

    expect(() => verifyWindowsUpdateArtifacts(root, undefined, '0.2.5')).toThrow('does not match expected release version')
  })

  it('rejects a portable ZIP alongside the formal NSIS update assets', () => {
    const root = fixture()
    createFormalWindowsRelease(root)
    write(root, 'AI-Novel-Writer-0.2.6-windows-x64.zip', 'legacy portable package')

    expect(() => verifyWindowsUpdateArtifacts(root)).toThrow('must not contain portable ZIP archives')
  })

  it('resolves electron-builder to a Windows-only NSIS final-release update configuration', async () => {
    const config = await loadElectronBuilderConfig(path.resolve('.'))
    const windowsTargets = Array.isArray(config.win?.target) ? config.win.target : [config.win?.target]
    const windowsPublish = Array.isArray(config.win?.publish) ? config.win.publish[0] : config.win?.publish

    expect(windowsTargets).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(config.nsis?.artifactName).toBe('ai-novel-writer-setup-${version}.${ext}')
    expect(windowsPublish).toMatchObject({
      provider: 'github',
      owner: 'EthanYoQ',
      repo: 'AI-Novel-Writer',
      releaseType: 'release',
      publishAutoUpdate: true,
      tagNamePrefix: 'v',
    })
  })
})
