/* global process */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

/** 纸墨外壳的根；设置是外壳里的一页，「返回书房」或「返回作品」收起它。 */
export const STAGE_SHELL = '[data-shell-presentation="stage"]'
export const SETTINGS_BACK = /^(返回书房|Back to library|返回作品|Back to the book)$/

export async function verifyOrdinaryStartup(page) {
  await page.waitForFunction(async () => {
    if (!window.aiNovelAPI) return false
    const state = await window.aiNovelAPI.invoke('startup:get-state')
    return state.state === 'ready' || state.state === 'blocked'
  }, null, { timeout: 30_000 })
  const state = await page.evaluate(() => window.aiNovelAPI.invoke('startup:get-state'))
  assert.equal(state.state, 'ready', `Ordinary startup blocked: ${state.code ?? state.state}`)
  const shell = page.locator(STAGE_SHELL)
  await shell.waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
  const back = page.getByRole('button', { name: SETTINGS_BACK })
  await back.waitFor({ state: 'visible' })
  await back.click()
  await back.waitFor({ state: 'hidden' })
  assert.equal(await shell.isVisible(), true)
  return { startupState: state.state, workbenchVisible: true, settingsOpenedAndClosed: true }
}

export async function runInstalledStartup({ executable, evidence, expectedVersion, defaultProfile = false }) {
  const evidencePath = resolve(evidence)
  mkdirSync(dirname(evidencePath), { recursive: true })
  const record = { kind: 'installed-normal-startup', accepted: false, mode: defaultProfile ? 'default-profile' : 'isolated-profile' }
  let app
  try {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^AI_NOVEL_|^ELECTRON_RUN_AS_NODE$|^VITE_DEV_SERVER_URL$/.test(key)) delete env[key]
    }
    const args = []
    let expectedUserData
    if (defaultProfile) {
      assert(process.platform === 'win32' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted',
        'Default-profile acceptance requires a disposable GitHub-hosted Windows runner')
      assert(env.APPDATA, 'APPDATA is required to inspect the default profile before launch')
      expectedUserData = join(env.APPDATA, 'ai-novel-writer')
      const paths = [expectedUserData, join(env.APPDATA, 'ai-novel-writer-data'), join(homedir(), '.vela')]
      for (const path of paths) assert.equal(existsSync(path), false, `Default profile is not pristine; refusing to launch: ${path}`)
      record.defaultPathsAbsentBeforeLaunch = paths
    } else {
      const root = mkdtempSync(join(dirname(evidencePath), 'normal-startup-profile-'))
      expectedUserData = join(root, 'userData')
      env.AI_NOVEL_APP_DATA_HOME = join(root, 'canonical')
      env.AI_NOVEL_LEGACY_SOURCE_HOME = join(root, 'legacy')
      env.AI_NOVEL_VELA_HOME = env.AI_NOVEL_LEGACY_SOURCE_HOME
      args.push(`--user-data-dir=${expectedUserData}`)
    }
    app = await electron.launch({ executablePath: resolve(executable), args, env, timeout: 30_000 })
    const page = await app.firstWindow({ timeout: 30_000 })
    const actual = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'), appData: app.getPath('appData'), version: app.getVersion(), packaged: app.isPackaged,
    }))
    assert.equal(resolve(actual.userData), resolve(expectedUserData))
    assert.equal(actual.packaged, true, 'Startup acceptance must use the installed package')
    assert.equal(actual.version, expectedVersion)
    record.application = actual
    Object.assign(record, await verifyOrdinaryStartup(page))
    await app.close()
    app = null
    record.accepted = true
    return record
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    try { if (app) await app.close() } finally {
      writeFileSync(evidencePath, `${JSON.stringify(record, null, 2)}\n`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    executable: { type: 'string' }, evidence: { type: 'string' }, 'expected-version': { type: 'string' },
    'default-profile': { type: 'boolean', default: false },
  } })
  assert(values.executable && values.evidence && values['expected-version'], 'Required: --executable --evidence --expected-version')
  runInstalledStartup({ executable: values.executable, evidence: values.evidence,
    expectedVersion: values['expected-version'], defaultProfile: values['default-profile'],
  }).then(record => process.stdout.write(`${JSON.stringify(record)}\n`)).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
