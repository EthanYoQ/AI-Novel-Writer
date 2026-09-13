/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appearanceKey = 'ai-novel-writer-appearance'
const themeKey = 'ai-novel-writer-theme'
const shellKey = 'ai-novel-writer-ui-version'
const root = path.join(repositoryRoot, '.runtime', '.cache', 'global-startup-acceptance', randomUUID())
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function inventory(directory) {
  if (!fs.existsSync(directory)) return {}
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const file = path.join(entry.parentPath, entry.name)
      return [path.relative(directory, file).replaceAll('\\', '/'), digest(file)]
    }).sort(([a], [b]) => a.localeCompare(b)))
}
function fixture(name) {
  const base = path.join(root, name)
  const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData'].map(key => [key, path.join(base, key)]))
  for (const [key, directory] of Object.entries(roots)) if (key !== 'canonical') fs.mkdirSync(directory, { recursive: true })
  return roots
}
async function launch(roots) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    AI_NOVEL_VELA_HOME: roots.legacy, HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  const app = await electron.launch({ cwd: repositoryRoot, args: ['.', `--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  try {
    const page = await app.firstWindow({ timeout: 30_000 })
    const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(path.resolve(actualUserData), roots.userData)
    return { app, page }
  } catch (error) { await app.close(); throw error }
}
async function ready(page) {
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  return page.evaluate(() => window.aiNovelAPI.invoke('startup:get-state'))
}
async function blockedScenario(name, populate, expectedCode) {
  const roots = fixture(name)
  populate(roots)
  const before = { legacy: inventory(roots.legacy), canonical: inventory(roots.canonical) }
  const { app, page } = await launch(roots)
  try {
    await page.getByRole('heading', { name: '启动尚未完成' }).waitFor()
    const state = await page.evaluate(() => window.aiNovelAPI.invoke('startup:get-state'))
    assert.equal(state.state, 'blocked'); assert.equal(state.code, expectedCode)
    assert.equal(await page.locator('.app-skin-root').count(), 0)
    assert.equal(await page.evaluate(key => localStorage.getItem(key), appearanceKey), null)
    const writableRejected = await page.evaluate(async () => {
      try { await window.aiNovelAPI.invoke('config:set', {}); return false } catch { return true }
    })
    assert.equal(writableRejected, true)
  } finally { await app.close() }
  assert.deepEqual({ legacy: inventory(roots.legacy), canonical: inventory(roots.canonical) }, before)
  return { name, outcome: 'PASS', ordinaryWorkspaceBlocked: true, sourceAndTargetUnchanged: true }
}

if (process.argv.includes('--help')) {
  process.stdout.write('Run after build and the Electron native profile. Uses synthetic repository-cache roots and no provider requests.\n')
} else {
  fs.mkdirSync(root, { recursive: true })
  const results = []
  try {
    const roots = fixture('legacy-and-restart')
    fs.writeFileSync(path.join(roots.legacy, 'config.json'), '{}')
    fs.writeFileSync(path.join(roots.legacy, 'unrecognized.txt'), 'synthetic retained content')
    const sourceBefore = inventory(roots.legacy)
    let session = await launch(roots)
    let generation
    const oldTheme = JSON.stringify({ state: { theme: 'dark', zoom: 1.1, writingFont: 'system', uiFont: 'system', fontDefaultsVersion: 0 }, version: 0 })
    try {
      const state = await ready(session.page)
      assert.equal(state.state, 'ready'); generation = state.globalGeneration
      assert.equal(state.migrationNotice.legacySourceIgnored, true)
      assert.equal(state.migrationNotice.preservedUnknownCount, 1)
      assert.match(await session.page.getByRole('status').filter({ hasText: '旧来源已保留' }).innerText(), /明确导入/)
      const staleAck = await session.page.evaluate(({ appearanceKey, state }) => window.aiNovelAPI.invoke('startup:appearance-ack', {
        storageKey: appearanceKey, profileRevision: 1, globalGeneration: 'stale', skinRevision: state.skinRevision,
      }), { appearanceKey, state })
      assert.equal(staleAck, false)
      await session.page.evaluate(({ appearanceKey, themeKey, shellKey, oldTheme }) => {
        localStorage.removeItem(appearanceKey); localStorage.setItem(themeKey, oldTheme); localStorage.setItem(shellKey, 'v1')
        localStorage.setItem('startup-unrelated-selection', 'synthetic-selected-model')
      }, { appearanceKey, themeKey, shellKey, oldTheme })
    } finally { await session.app.close() }
    assert.deepEqual(inventory(roots.legacy), sourceBefore)
    // This now-invalid old source must never regain write authority after cutover.
    fs.writeFileSync(path.join(roots.legacy, 'config.json'), '{later source change')
    const changedSource = inventory(roots.legacy)
    session = await launch(roots)
    try {
      const state = await ready(session.page)
      assert.equal(state.globalGeneration, generation)
      const stored = await session.page.evaluate(({ appearanceKey, themeKey, shellKey }) => ({
        canonical: JSON.parse(localStorage.getItem(appearanceKey)), theme: localStorage.getItem(themeKey),
        shell: localStorage.getItem(shellKey), unrelated: localStorage.getItem('startup-unrelated-selection'),
      }), { appearanceKey, themeKey, shellKey })
      assert.equal(stored.canonical.shellPreference, 'classic'); assert.equal(stored.canonical.colorTheme, 'dark')
      assert.equal(stored.canonical.zoom, 1.1); assert.equal(stored.canonical.uiFont, 'system'); assert.equal(stored.canonical.writingFont, 'system')
      assert.equal(stored.theme, oldTheme); assert.equal(stored.shell, 'v1'); assert.equal(stored.unrelated, 'synthetic-selected-model')
    } finally { await session.app.close() }
    assert.deepEqual(inventory(roots.legacy), changedSource)
    results.push({ name: 'legacy-and-restart', outcome: 'PASS', sameGlobalGeneration: true, originalRendererStoragePreserved: true, sourceNeverReimported: true })
    results.push(await blockedScenario('corrupt-source', roots => fs.writeFileSync(path.join(roots.legacy, 'config.json'), '{corrupt'), 'GLOBAL_DATA_BLOCKED'))
    results.push(await blockedScenario('credential-conflict', roots => {
      fs.mkdirSync(roots.canonical)
      for (const [directory, apiKey] of [[roots.legacy, 'synthetic-a'], [roots.canonical, 'synthetic-b']]) {
        fs.writeFileSync(path.join(directory, 'models.json'), JSON.stringify([{ id: 'synthetic-model', apiKey }]))
      }
    }, 'GLOBAL_MODEL_CREDENTIALS_DIFFER'))
    const brokenAppearance = fixture('corrupt-renderer-preferences')
    session = await launch(brokenAppearance)
    try {
      await ready(session.page)
      await session.page.evaluate(key => localStorage.setItem(key, '{corrupt appearance'), appearanceKey)
    } finally { await session.app.close() }
    session = await launch(brokenAppearance)
    try {
      await session.page.getByRole('heading', { name: '启动尚未完成' }).waitFor()
      assert.equal(await session.page.locator('.app-skin-root').count(), 0)
      assert.equal(await session.page.evaluate(key => localStorage.getItem(key), appearanceKey), '{corrupt appearance')
      const closed = session.app.waitForEvent('close', { timeout: 10_000 })
      await session.page.getByRole('button', { name: '关闭应用', exact: true }).click()
      await closed
    } finally { await session.app.close() }
    results.push({ name: 'corrupt-renderer-preferences', outcome: 'PASS', originalBytesPreserved: true, explicitCloseWorks: true })
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'PASS', physicalModelRequests: 0, results }, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: 'PASS', scenarios: results.length, physicalModelRequests: 0, evidence: path.relative(repositoryRoot, path.join(root, 'evidence.json')) })}\n`)
  } catch (error) {
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'FAIL', results, error: error instanceof Error ? error.message : 'Unknown error' }, null, 2))
    throw error
  }
}
