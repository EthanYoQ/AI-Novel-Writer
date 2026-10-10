/* global process */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.join(repositoryRoot, '.runtime', '.cache', 'default-startup-acceptance', randomUUID())
const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
const appearanceKey = 'ai-novel-writer-appearance'
const themeKey = 'ai-novel-writer-theme'
const shellKey = 'ai-novel-writer-ui-version'
const legacyTheme = JSON.stringify({ state: { theme: 'dark', zoom: 1.1, writingFont: 'system', uiFont: 'system' }, version: 0 })

function fixture(name) {
  const directory = path.join(root, name)
  const appData = path.join(directory, 'appData')
  const legacy = path.join(directory, 'legacy')
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: packageJson.name, version: packageJson.version, main: 'main.cjs' }))
  // Relocate appData before Electron derives userData, retaining the product's default profile name.
  fs.writeFileSync(path.join(directory, 'main.cjs'), `const { app } = require('electron');
app.setPath('appData', ${JSON.stringify(appData)});
import(${JSON.stringify(pathToFileURL(path.join(repositoryRoot, 'dist-electron', 'main.js')).href)}).catch(error => { console.error(error); app.exit(1); });
`)
  return { directory, appData, legacy }
}

async function launch(roots) {
  const env = { ...process.env, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_VELA_HOME', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  const app = await electron.launch({ cwd: repositoryRoot, args: [roots.directory], env, timeout: 30_000 })
  try {
    const page = await app.firstWindow({ timeout: 30_000 })
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(userData, path.join(roots.appData, packageJson.name))
    await page.waitForFunction(() => Boolean(window.aiNovelAPI))
    const state = await page.evaluate(() => window.aiNovelAPI.invoke('startup:get-state'))
    assert.equal(state.state, 'ready', 'default directories must admit startup')
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    return { app, page, state, userData }
  } catch (error) { await app.close(); throw error }
}

async function verify() {
  const results = []
  for (const name of ['fresh', 'legacy-and-restart']) {
    const roots = fixture(name)
    const legacyConfig = path.join(roots.legacy, 'config.json')
    if (name === 'legacy-and-restart') fs.writeFileSync(legacyConfig, '{"theme":"dark"}')
    let session = await launch(roots)
    const generation = session.state.globalGeneration
    try {
      assert.equal(fs.existsSync(path.join(session.userData, '.migration')), false)
      const receipt = JSON.parse(fs.readFileSync(path.join(roots.appData, 'ai-novel-writer-data', '.migration', 'receipt.json'), 'utf8'))
      assert.equal(receipt.generation, generation)
      if (name === 'legacy-and-restart') {
        await session.page.evaluate(({ appearanceKey, themeKey, shellKey, legacyTheme }) => {
          localStorage.removeItem(appearanceKey)
          localStorage.setItem(themeKey, legacyTheme)
          localStorage.setItem(shellKey, 'v1')
          localStorage.setItem('startup-unrelated-selection', 'synthetic-selected-model')
        }, { appearanceKey, themeKey, shellKey, legacyTheme })
      }
    } finally { await session.app.close() }
    if (name === 'legacy-and-restart') {
      session = await launch(roots)
      try {
        assert.equal(session.state.globalGeneration, generation)
        const stored = await session.page.evaluate(({ appearanceKey, themeKey, shellKey }) => ({
          profile: JSON.parse(localStorage.getItem(appearanceKey)), theme: localStorage.getItem(themeKey),
          shell: localStorage.getItem(shellKey), unrelated: localStorage.getItem('startup-unrelated-selection'),
        }), { appearanceKey, themeKey, shellKey })
        assert.equal(stored.profile.colorTheme, 'dark')
        assert.equal(stored.profile.zoom, 1.1)
        assert.equal(stored.profile.writingFont, 'system')
        assert.equal(stored.profile.uiFont, 'system')
        assert.equal(stored.theme, legacyTheme)
        assert.equal(stored.shell, 'v1')
        assert.equal(stored.unrelated, 'synthetic-selected-model')
        assert.equal(fs.readFileSync(legacyConfig, 'utf8'), '{"theme":"dark"}')
      } finally { await session.app.close() }
    }
    results.push({ name, outcome: 'PASS' })
  }
  return results
}

try {
  const results = await verify()
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'PASS', results }, null, 2))
  process.stdout.write(`${JSON.stringify({ outcome: 'PASS', scenarios: results.length, evidence: path.relative(repositoryRoot, path.join(root, 'evidence.json')) })}\n`)
} catch (error) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ outcome: 'FAIL', error: error instanceof Error ? error.message : 'Unknown error' }, null, 2))
  throw error
}
