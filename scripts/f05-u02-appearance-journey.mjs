/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = option('package-dir') && path.resolve(option('package-dir'))
const packageBaseSha = option('package-base-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
const executablePath = path.join(packageDir ?? '', 'AI小说作家.exe')
const asarPath = path.join(packageDir ?? '', 'resources', 'app.asar')
const appearanceKey = 'ai-novel-writer-appearance'
const runId = randomUUID()
const receiptPath = path.join(repository, '.runtime', '.cache', 'f05-u02-appearance', runId, 'receipt.json')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const driverSha256 = sha256(fileURLToPath(import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const steps = []
let currentStep = 'setup'
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, assertion, outcome: 'PASS' })

function provenance() {
  assert(packageDir && packageBaseSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '')
    && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''), 'Pass fixed package directory, package base SHA and both hashes')
  const resolvedBase = git('rev-parse', '--verify', `${packageBaseSha}^{commit}`)
  const executionHead = git('rev-parse', 'HEAD')
  const changedPaths = git('diff', '--name-only', `${resolvedBase}..${executionHead}`).split('\n').filter(Boolean)
  const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build', 'package.json',
    'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
  assert.equal(sha256(executablePath), expectedExe)
  assert.equal(sha256(asarPath), expectedAsar)
  return { testedSha: null, packageBaseSha: resolvedBase, executionHead, changedPaths, dirtyProductPaths,
    artifactHashes: { executableSha256: expectedExe, asarSha256: expectedAsar }, packageDir,
    reuseReason: 'Fixed packaged bytes match supplied hashes; uncommitted product inputs prevent exact source-to-package attribution.' }
}

function profile() {
  assert(process.env.LOCALAPPDATA, 'Short LOCALAPPDATA scratch is required')
  const scratch = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel', `u02-appearance-${runId.slice(0, 8)}`)
  const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData']
    .map(key => [key, path.join(scratch, key)]))
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u02-appearance',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${scratch}' -Recurse -Force`,
    retainReason: 'Synthetic Electron preference profile for receipt inspection' }, null, 2))
  return roots
}

async function launch(roots) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir,
    args: [`--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  try {
    const page = await app.firstWindow({ timeout: 30_000 })
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), roots.userData)
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    return { app, page }
  } catch (error) { await app.close(); throw error }
}

async function quit(app) {
  const child = app.process()
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); return true })
  const result = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Electron did not exit')), 10_000))])
  assert.deepEqual(result, { code: 0, signal: null }, 'Electron did not quit cleanly')
}

async function stored(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), appearanceKey)
}

async function assertWriter(page) {
  await page.locator('.writer-shell[data-shell-presentation="writer"][data-shell-variant="v3"]')
    .waitFor({ state: 'visible', timeout: 30_000 })
}

async function openSettings(page, section) {
  await assertWriter(page)
  await page.locator('.writer-left-rail button[title="设置"]').click()
  const modal = page.locator('.skin-solid-surface').first()
  await modal.waitFor({ state: 'visible' })
  await modal.locator('aside button').filter({ hasText: section }).click()
  await modal.getByRole('heading', { name: section, exact: true }).waitFor()
  return modal
}

async function closeSettings(modal) {
  await modal.getByRole('button', { name: '关闭设置' }).click()
  await modal.waitFor({ state: 'detached' })
}

function fontField(page, label) {
  return page.getByText(label, { exact: true }).locator('xpath=ancestor::div[contains(@class,"space-y-1.5")][1]')
}

async function zoomFactor(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
}

async function main() {
  const source = provenance()
  const roots = profile()
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  let session
  try {
    currentStep = 'select-writer-test-profile'
    session = await launch(roots)
    await session.page.waitForFunction(key => localStorage.getItem(key) !== null, appearanceKey)
    await session.page.evaluate(key => {
      const previous = JSON.parse(localStorage.getItem(key))
      localStorage.setItem(key, JSON.stringify({ ...previous, shellPreference: 'writer', revision: previous.revision + 1, origin: 'author' }))
    }, appearanceKey)
    await quit(session.app)
    session = await launch(roots)
    let { page } = session
    await assertWriter(page)
    assert.equal((await stored(page)).shellPreference, 'writer')

    currentStep = 'U02.A03'
    let modal = await openSettings(page, '外观')
    await modal.locator('.appearance-theme-option[data-theme="galaxy"]').click()
    await page.waitForFunction(() => document.querySelector('.app-skin-root')?.getAttribute('data-theme') === 'galaxy')
    assert.equal(await modal.locator('.appearance-theme-option[data-theme="galaxy"]').getAttribute('aria-pressed'), 'true')
    assert.equal((await stored(page)).colorTheme, 'galaxy')
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('galaxy')), true)
    pass('writer-select-color-theme', 'U02.A03', 'Writer appearance button applies Galaxy theme in UI and canonical profile')
    await closeSettings(modal)

    currentStep = 'U02.A05'
    modal = await openSettings(page, '编辑器')
    const uiField = fontField(page, '界面字体')
    await uiField.getByRole('button').first().click()
    await uiField.getByRole('button').filter({ hasText: 'Inter' }).last().click()
    assert.equal((await stored(page)).uiFont, 'inter')
    assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--font-sans')), /Inter/)
    const writingField = fontField(page, '写作字体')
    await writingField.getByRole('button').first().click()
    await writingField.getByRole('button').filter({ hasText: '思源宋体' }).last().click()
    assert.equal((await stored(page)).writingFont, 'noto-serif-sc')
    assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--font-writing')), /Noto Serif SC/)
    pass('writer-select-two-fonts', 'U02.A05', 'Writer editor settings apply interface and writing fonts to CSS and canonical profile')
    await closeSettings(modal)

    currentStep = 'U02.A06'
    await assertWriter(page)
    const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await page.locator('.writer-topbar button[title="放大"]').click()
    await page.locator('.writer-topbar button[title="重置缩放"]').getByText('105%').waitFor()
    assert.equal((await stored(page)).zoom, 1.05)
    assert.equal(await zoomFactor(session.app), 1.05)
    pass('writer-zoom-native', 'U02.A06', 'Writer titlebar zoom reaches 105%, canonical profile and Electron native zoom factor')

    currentStep = 'U02.A08'
    const before = await stored(page)
    await quit(session.app)
    session = await launch(roots)
    page = session.page
    await assertWriter(page)
    const after = await stored(page)
    assert.deepEqual(after, before, 'Canonical appearance profile changed on restart')
    assert.equal(await page.locator('.app-skin-root').getAttribute('data-theme'), 'galaxy')
    assert.equal(await zoomFactor(session.app), 1.05)
    assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--font-sans')), /Inter/)
    assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--font-writing')), /Noto Serif SC/)
    modal = await openSettings(page, '外观')
    assert.equal(await modal.locator('.appearance-theme-option[data-theme="galaxy"]').getAttribute('aria-pressed'), 'true')
    await closeSettings(modal)
    modal = await openSettings(page, '编辑器')
    assert.match(await fontField(page, '界面字体').getByRole('button').first().innerText(), /Inter/)
    assert.match(await fontField(page, '写作字体').getByRole('button').first().innerText(), /思源宋体/)
    await closeSettings(modal)
    pass('writer-preferences-reopened', 'U02.A08', 'Same profile reopens in Writer with selected theme, both fonts, native zoom and canonical bytes')
    await quit(session.app)
    session = null

    assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256, 'Driver changed during journey')
    assert.deepEqual(provenance().artifactHashes, source.artifactHashes, 'Built bytes changed during journey')
    const receipt = { outcome: 'PARTIAL', qualification: 'F05_U02_APPEARANCE_ONLY', evidenceLevel: 'electron',
      ...source, driverSha256, fullActionQualification: false, releaseDefaultQualified: false, steps }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: 'PARTIAL', testedSha: source.testedSha, executionHead: source.executionHead,
      driverSha256, receipt: path.relative(repository, receiptPath), steps: steps.map(step => step.stepId) })}\n`)
  } catch (error) {
    if (session) await session.app.close().catch(() => {})
    fs.writeFileSync(receiptPath, JSON.stringify({ outcome: 'FAIL', ...source, driverSha256, failedStep: currentStep,
      steps, error: String(error) }, null, 2))
    throw error
  }
}

if (process.argv.includes('--help')) process.stdout.write('Pass --package-dir, --package-base-sha, --exe-sha256 and --asar-sha256 for fixed V3 package.\n')
else main().catch(error => { console.error(error); process.exitCode = 1 })
