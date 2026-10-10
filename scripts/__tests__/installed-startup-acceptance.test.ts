import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runInstalledStartup, verifyOrdinaryStartup } from '../installed-startup-acceptance.mjs'

const roots: string[] = []
function fixture() {
  const cache = resolve('.runtime/.cache')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'installed-startup-test-'))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('rejects a visible startup error before accepting or interacting with the workbench', async () => {
  const locator = vi.fn()
  await expect(verifyOrdinaryStartup({
    waitForFunction: async () => {},
    evaluate: async () => ({ state: 'blocked', code: 'GLOBAL_DATA_BLOCKED' }),
    locator,
  })).rejects.toThrow('Ordinary startup blocked: GLOBAL_DATA_BLOCKED')
  expect(locator).not.toHaveBeenCalled()
})

it('refuses default-profile access outside a disposable hosted runner', async () => {
  vi.stubEnv('GITHUB_ACTIONS', '')
  const root = fixture()
  await expect(runInstalledStartup({
    executable: join(root, 'missing.exe'), evidence: join(root, 'result.json'),
    expectedVersion: '1.2.1-Preview', defaultProfile: true,
  })).rejects.toThrow('disposable GitHub-hosted Windows runner')
  expect(JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')).accepted).toBe(false)
})

it.skipIf(process.platform !== 'win32')('refuses an existing default profile without changing its bytes', async () => {
  const root = fixture()
  vi.stubEnv('GITHUB_ACTIONS', 'true')
  vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted')
  vi.stubEnv('APPDATA', root)
  const profile = join(root, 'ai-novel-writer')
  mkdirSync(profile)
  const file = join(profile, 'Preferences')
  writeFileSync(file, 'preserve these existing bytes')
  await expect(runInstalledStartup({
    executable: join(root, 'missing.exe'), evidence: join(root, 'result.json'),
    expectedVersion: '1.2.1-Preview', defaultProfile: true,
  })).rejects.toThrow('Default profile is not pristine; refusing to launch')
  expect(readFileSync(file, 'utf8')).toBe('preserve these existing bytes')
})

it('checks the candidate normal startup before special smoke modes and confines defaults to the first clean install', () => {
  const installer = readFileSync(resolve('scripts/smoke-win-installer.ps1'), 'utf8')
  const startup = installer.indexOf('  & node @normalStartupArguments')
  expect(startup).toBeGreaterThan(installer.indexOf('  Install-Silently $resolvedInstaller'))
  expect(startup).toBeLessThan(installer.indexOf('  Invoke-AiNovelPackagedVectorSmoke -Path $exePath'))
  expect(installer).toContain("$env:GITHUB_ACTIONS -eq 'true' -and -not $hasPreviousVersion")
  expect(installer).toContain('normalStartup = $normalStartup')
})
