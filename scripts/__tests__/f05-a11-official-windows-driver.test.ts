import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'

const windowsIt = process.platform === 'win32' ? it : it.skip
const repository = path.resolve(import.meta.dirname, '../..')
const driver = path.join(repository, 'scripts/f05-a11-offline-import-journey.mjs')
const cache = path.join(repository, '.runtime', '.cache')
mkdirSync(cache, { recursive: true })
const scratch = mkdtempSync(path.join(cache, 'a11-win-driver-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

windowsIt('admits the installed official Windows mode before checking package bytes', () => {
  const installedApp = path.join(scratch, 'installed-app')
  mkdirSync(path.join(installedApp, 'resources'), { recursive: true })
  const exe = path.join(installedApp, 'AI小说作家.exe')
  const asar = path.join(installedApp, 'resources/app.asar')
  writeFileSync(exe, 'wrong executable')
  writeFileSync(asar, 'wrong asar')
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  const result = spawnSync(process.execPath, [driver,
    `--win-installed-app=${installedApp}`, '--win-version=v1.0.0',
    `--scratch-root=${path.join(scratch, 'run')}`, `--tested-sha=${sha}`,
    `--exe-sha256=${'0'.repeat(64)}`, `--asar-sha256=${'0'.repeat(64)}`,
  ], { cwd: repository, encoding: 'utf8' })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Installed app executable hash differs')
  expect(result.stderr).not.toContain('Specify clean build tree')
})

it.each(['v1.0.0', 'v1.1.0'])('preserves Mac official fixture seed for %s', version => {
  const fixtureScratch = path.join(scratch, `mac-${version}`)
  const result = spawnSync(process.execPath, [driver, '--mac-fixture-only=1',
    `--mac-version=${version}`, `--scratch-root=${fixtureScratch}`], { cwd: repository, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const fact = JSON.parse(result.stdout.trim())
  const manifest = JSON.parse(readFileSync(path.join(repository, 'scripts/fixtures/s14c-official-old-sources/manifest.json'), 'utf8'))
  const entry = manifest.cases.find((item: { version: string }) => `v${item.version}` === version)
  expect(fact).toMatchObject({ kind: 'official-old-app-mac-fixture', sourceVersion: version,
    officialProofSha256: entry.proofSha256, llmCalls: 0 })
  expect(fact.sourceInventorySha256).toMatch(/^[a-f0-9]{64}$/)
})
