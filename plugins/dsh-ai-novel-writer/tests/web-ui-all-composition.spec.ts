/** Optional real-profile composition check for dsh-web-ui-all tool isolation. */
import { execFile } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { makeTestWorkspace } from './test-workspace.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'complete-chapter')
const profileRoot = process.env.DSH_WEB_PROFILE_ROOT
const realProfileIt = profileRoot === undefined ? it.skip : it

describe('dsh-web-ui-all installed-profile composition', () => {
  realProfileIt('keeps only the two novel tools in every real request header', async () => {
    if (profileRoot === undefined) throw new Error('real-profile test requires DSH_WEB_PROFILE_ROOT')
    const workspace = await makeTestWorkspace('web-ui-all-composition-')
    const packageEntry = (packageName: string) => join(profileRoot, 'node_modules', ...packageName.split('/'), 'lib', 'index.js')
    const entries = {
      DSH_WEB_UI_ALL_ENTRY: pathToFileURL(packageEntry('@linxin666/dsh-web-ui-all')).href,
      DSH_WEB_UI_SSH_ENTRY: pathToFileURL(packageEntry('@linxin666/dsh-ssh')).href,
      DSH_WEB_UI_DESCRIBE_ENTRY: pathToFileURL(packageEntry('@linxin666/dsh-tool-describe-image')).href,
      DSH_SNAPSHOT_BACKEND_ENTRY: pathToFileURL(join(fixtureRoot, 'snapshot-backend.mjs')).href,
    }
    await Promise.all(Object.values(entries).map(entry => access(new URL(entry))))
    const configPath = join(workspace, 'web-ui-all.cordis.yml')
    let config = await readFile(join(fixtureRoot, 'web-ui-all.cordis.yml'), 'utf8')
    for (const [name, entry] of Object.entries(entries)) config = config.replaceAll(`__${name}__`, JSON.stringify(entry))
    await writeFile(configPath, config, 'utf8')

    const { stdout } = await execFileAsync(process.execPath, [
      join(fixtureRoot, 'driver.mjs'),
      configPath,
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HOME: join(workspace, '.dsh'),
        DSH_AGENTS_HOME: join(workspace, '.agents'),
        DSH_NOVEL_PRESET_ROOT: join(packageRoot, 'presets'),
      },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
    })
    const requests = stdout.trimEnd().split('\n')
      .map(line => JSON.parse(line) as { type: string; request?: { tools?: { name: string }[] } })
      .filter(line => line.type === 'model_request')
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(line =>
      line.request?.tools?.map(tool => tool.name).sort().join(',') === 'novel_apply_change,novel_read')).toBe(true)
  }, 45_000)
})
