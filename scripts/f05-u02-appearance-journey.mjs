/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = option('package-dir') && path.resolve(option('package-dir'))
const packageBaseSha = option('package-base-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
const executablePath = resolveWindowsExecutable(packageDir ?? '')
const asarPath = path.join(packageDir ?? '', 'resources', 'app.asar')
const appearanceKey = 'ai-novel-writer-appearance-v3'
const previousAppearanceKey = 'ai-novel-writer-appearance'
const runId = randomUUID()
const receiptPath = path.join(repository, '.runtime', '.cache', 'f05-u02-appearance', runId, 'receipt.json')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const driverSha256 = sha256(fileURLToPath(import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const steps = []
let currentStep = 'setup'
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, assertion, outcome: 'PASS' })
// RD-10 删除了图片皮肤（动漫与自定义背景）：U02.A04 的入口不复存在，这里只核对它确实没了。
const retiredActions = [{ actionId: 'U02.A04',
  reason: 'RD-10 removed image skins (anime and custom backgrounds); the paper-ink appearance page has no background image setting and the skin IPC channels are gone.' }]

function provenance() {
  assert(packageDir && packageBaseSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '')
    && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''), 'Pass fixed package directory, package base SHA and both hashes')
  const resolvedBase = git('rev-parse', '--verify', `${packageBaseSha}^{commit}`)
  const executionHead = git('rev-parse', 'HEAD')
  const changedPaths = git('diff', '--name-only', `${resolvedBase}..${executionHead}`).split('\n').filter(Boolean)
  const appearanceInputChanges = git('diff', '--name-only', `${resolvedBase}..${executionHead}`, '--',
    'src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts',
    'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
  const scopedDirtyPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build', 'package.json',
    'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
  const excludedTestArtifactPaths = scopedDirtyPaths.filter(status => /^src\/.*\/__tests__\/__screenshots__\//.test(status.slice(3)))
  const dirtyProductPaths = scopedDirtyPaths.filter(status => !excludedTestArtifactPaths.includes(status))
  const driverDirty = git('status', '--porcelain', '--', 'scripts/f05-u02-appearance-journey.mjs').split('\n').filter(Boolean)
  assert.deepEqual(appearanceInputChanges, [], 'U02 appearance inputs differ from fixed package source')
  assert.deepEqual(dirtyProductPaths, [], 'Dirty product inputs prevent fixed package reuse')
  assert.equal(sha256(executablePath), expectedExe)
  assert.equal(sha256(asarPath), expectedAsar)
  return { testedSha: resolvedBase, packageBaseSha: resolvedBase, executionHead, changedPaths, appearanceInputChanges,
    dirtyProductPaths, excludedTestArtifactPaths, driverDirty,
    artifactHashes: { executableSha256: expectedExe, asarSha256: expectedAsar }, packageDir,
    reuseReason: 'Fixed package hashes match; testedSha remains the package build source and is not advanced to executionHead.' }
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
    await stage.waitForStage(page)
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

async function zoomFactor(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())
}

/**
 * 设置里的「外观」：主题、界面语言、两种字体与界面缩放，改动立即生效。
 * 隔离档案里有空的旧来源目录，启动后会出「旧来源已保留」的通知条，盖住设置页顶部的返回，先点「知道了」。
 */
async function openAppearance(page) {
  await stage.dismissMigrationNotice(page)
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '外观')
}
const themeRadio = (page, name) => stage.root(page).getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: new RegExp(`^${name}`) })
const fontSelect = (page, label) => stage.root(page).getByLabel(label, { exact: true })
const zoomGroup = page => stage.root(page).getByRole('group', { name: '界面缩放' })
const cssVariable = (page, name) => page.evaluate(variable => document.documentElement.style.getPropertyValue(variable), name)
const shellTheme = page => stage.root(page).getAttribute('data-theme')

async function main() {
  assert(!process.argv.includes('--background-only'), 'U02.A04 background images were removed in RD-10; there is no background-only mode')
  const source = provenance()
  const roots = profile()
  const initialUserDataEntries = fs.readdirSync(roots.userData)
  assert.deepEqual(initialUserDataEntries, [], 'Fresh Electron userData must be empty before first launch')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  let session
  let firstLaunchObservation
  try {
    currentStep = 'U02.A01'
    session = await launch(roots)
    let { page } = session
    await page.waitForFunction(key => localStorage.getItem(key) !== null, appearanceKey)
    firstLaunchObservation = await page.evaluate(({ key, previousKey }) => ({
      appearanceRaw: localStorage.getItem(key),
      previousAppearanceRaw: localStorage.getItem(previousKey),
      userDataWasEmptyBeforeLaunch: true,
      shellPresentations: Array.from(document.querySelectorAll('[data-shell-presentation]'), element => element.getAttribute('data-shell-presentation')),
      shellTheme: document.querySelector('[data-shell-presentation]')?.getAttribute('data-theme') ?? null,
      libraryVisible: Boolean(document.querySelector('.stage-library')),
    }), { key: appearanceKey, previousKey: previousAppearanceKey })
    const freshProfile = await stored(page)
    assert.equal(freshProfile.schemaVersion, 3, 'Fresh install must write the v3 appearance profile')
    assert.equal(freshProfile.colorTheme, 'light', 'Fresh install starts on the light paper-ink theme')
    assert.equal(Object.hasOwn(freshProfile, 'shellPreference'), false, 'v3 profile has no shell preference')
    assert.equal(firstLaunchObservation.previousAppearanceRaw, null, 'Fresh install must not write the pre-RD-10 appearance key')
    assert.deepEqual(firstLaunchObservation.shellPresentations, ['stage'])
    await stage.root(page).locator('.stage-library').waitFor({ state: 'visible' })
    assert.equal(await shellTheme(page), 'light')
    pass('fresh-install-stage-default', 'U02.A01', 'No appearance preference was seeded; first launch opens the paper-ink library in light and writes only the v3 profile')

    currentStep = 'U02.A03'
    await openAppearance(page)
    await themeRadio(page, '深色').click()
    await page.waitForFunction(() => document.querySelector('[data-shell-presentation="stage"]')?.getAttribute('data-theme') === 'dark'
      && document.documentElement.classList.contains('dark'))
    assert.equal(await themeRadio(page, '深色').getAttribute('aria-checked'), 'true')
    assert.equal(await themeRadio(page, '浅色').getAttribute('aria-checked'), 'false')
    assert.equal((await stored(page)).colorTheme, 'dark')
    pass('stage-select-color-theme', 'U02.A03', 'The 外观 theme radio applies dark to the paper-ink root, the document and the canonical profile')

    currentStep = 'U02.A04-retired'
    const appearancePage = stage.root(page).locator('.stage-set-rows')
    assert.equal(await stage.root(page).locator('[data-skin-card], [data-skin-action]').count(), 0, 'appearance page still renders skin cards')
    assert.doesNotMatch(await appearancePage.innerText(), /皮肤|背景图|Skin|Background image/u, 'appearance page still offers a background image')
    const skinChannel = await page.evaluate(() => window.aiNovelAPI.invoke('skin:get-state').then(() => 'resolved', error => String(error)))
    assert.notEqual(skinChannel, 'resolved', 'skin IPC channel still answers')
    pass('background-image-retired', 'U02.A04', `RD-10 retired image skins: the 外观 page has no background control and skin:get-state is refused (${skinChannel.slice(0, 120)})`)

    currentStep = 'U02.A05'
    await fontSelect(page, '界面字体').selectOption('inter')
    await page.waitForFunction(() => /Inter/.test(document.documentElement.style.getPropertyValue('--font-sans')))
    assert.equal((await stored(page)).uiFont, 'inter')
    await fontSelect(page, '写作字体').selectOption('noto-serif-sc')
    await page.waitForFunction(() => /Noto Serif SC/.test(document.documentElement.style.getPropertyValue('--font-writing')))
    assert.equal((await stored(page)).writingFont, 'noto-serif-sc')
    pass('stage-select-two-fonts', 'U02.A05', 'The 外观 font selects apply interface and writing fonts to CSS and the canonical profile')

    currentStep = 'U02.A06'
    await zoomGroup(page).getByRole('button', { name: '放大', exact: true }).click()
    await zoomGroup(page).getByText('105%', { exact: true }).waitFor()
    assert.equal((await stored(page)).zoom, 1.05)
    assert.equal(await zoomFactor(session.app), 1.05)
    pass('stage-zoom-native', 'U02.A06', 'The 外观 zoom control reaches 105% in the canonical profile and the Electron native zoom factor')
    await stage.closeSettings(page)

    currentStep = 'U02.A08'
    const before = await stored(page)
    await quit(session.app)
    session = await launch(roots)
    page = session.page
    const after = await stored(page)
    assert.deepEqual(after, before, 'Canonical appearance profile changed on restart')
    assert.equal(await shellTheme(page), 'dark')
    assert.equal(await zoomFactor(session.app), 1.05)
    assert.match(await cssVariable(page, '--font-sans'), /Inter/)
    assert.match(await cssVariable(page, '--font-writing'), /Noto Serif SC/)
    await openAppearance(page)
    assert.equal(await themeRadio(page, '深色').getAttribute('aria-checked'), 'true')
    assert.equal(await fontSelect(page, '界面字体').inputValue(), 'inter')
    assert.equal(await fontSelect(page, '写作字体').inputValue(), 'noto-serif-sc')
    await zoomGroup(page).getByText('105%', { exact: true }).waitFor()
    await stage.closeSettings(page)
    pass('stage-preferences-reopened', 'U02.A08', 'The same profile reopens in the stage with the selected theme, both fonts, native zoom and canonical bytes')
    await quit(session.app)
    session = null

    assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256, 'Driver changed during journey')
    assert.deepEqual(provenance().artifactHashes, source.artifactHashes, 'Built bytes changed during journey')
    assert.deepEqual(source.appearanceInputChanges, [], 'No U02 appearance product input may differ from fixed package source')
    const receipt = { outcome: 'PARTIAL', qualification: 'F05_U02_APPEARANCE_ONLY', evidenceLevel: 'electron', shell: 'stage',
      ...source, driverSha256, fullActionQualification: false, releaseDefaultQualified: false, retiredActions,
      runConditions: { runtime: process.version, nodeAbi: process.versions.modules, packageLaunch: true,
        freshProfile: true, preseededAppearanceKey: false, initialUserDataEntries, firstLaunchObservation }, steps }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: 'PARTIAL', testedSha: source.testedSha, executionHead: source.executionHead,
      driverSha256, receipt: path.relative(repository, receiptPath), steps: steps.map(step => step.stepId) })}\n`)
  } catch (error) {
    if (session) {
      await session.page.screenshot({ path: path.join(path.dirname(receiptPath), 'failure.png') }).catch(() => {})
      await session.app.close().catch(() => {})
    }
    fs.writeFileSync(receiptPath, JSON.stringify({ outcome: 'FAIL', qualification: 'F05_U02_APPEARANCE_ONLY', shell: 'stage', ...source, driverSha256,
      failedStep: currentStep, initialUserDataEntries, firstLaunchObservation, retiredActions,
      fullActionQualification: false, releaseDefaultQualified: false, steps, error: String(error) }, null, 2))
    throw error
  }
}

if (process.argv.includes('--help')) process.stdout.write('Pass --package-dir, --package-base-sha, --exe-sha256 and --asar-sha256 for the fixed package.\n')
else main().catch(error => { console.error(error); process.exitCode = 1 })
