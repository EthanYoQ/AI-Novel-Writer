/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = option('package-dir') && path.resolve(option('package-dir'))
const packageBaseSha = option('package-base-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
const backgroundOnly = process.argv.includes('--background-only')
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
  const appearanceInputChanges = changedPaths.filter(file =>
    /^src\/(components\/settings\/AppearanceSettings|stores\/appearance-bootstrap|shared\/(appearance-profile|skin-types)|App)\./i.test(file)
      || /^electron\/(controllers\/skin-controller|services\/skin-service|main|ipc-handlers)\./i.test(file))
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

function pngChunk(type, data) {
  const name = Buffer.from(type)
  const body = Buffer.concat([name, data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, body, checksum])
}

function syntheticPng(red, green, blue) {
  const width = 8, height = 6
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 2
  const rows = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const start = y * (1 + width * 3)
    for (let x = 0; x < width; x += 1) rows.set([red, green, blue], start + 1 + x * 3)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function preparePickerHelper(scratch) {
  const sourcePath = path.join(repository, 'scripts', 'f05-u16-native-picker.ps1')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const anchor = "  '选择角色头像' { 1148 }"
  assert.equal(source.split(anchor).length - 1, 1, 'Native picker helper title map changed')
  const helperPath = path.join(scratch, 'f05-u02-native-picker.ps1')
  let diagnosticSource = source.replace(anchor, `${anchor}\n  '选择自定义皮肤图片' { 1148 }`)
  const isWindowAnchor = '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);'
  assert.equal(diagnosticSource.split(isWindowAnchor).length - 1, 1, 'Native picker IsWindowVisible declaration changed')
  diagnosticSource = diagnosticSource.replace(isWindowAnchor,
    `${isWindowAnchor}\n  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);`)
  const outputAnchor = '[pscustomobject]@{ dialogTitle=$DialogTitle; dialogPid=$d.pid;'
  assert.equal(diagnosticSource.split(outputAnchor).length - 1, 1, 'Native picker evidence output changed')
  diagnosticSource = diagnosticSource.replace(outputAnchor,
    '$closeWatch = [System.Diagnostics.Stopwatch]::StartNew()\n' +
    '$dialogClosed = $false\n' +
    'while($closeWatch.ElapsedMilliseconds -lt 3000){\n' +
    '  if(-not [NativePickerInput]::IsWindow($d.h)){ $dialogClosed = $true; break }\n' +
    '  Start-Sleep -Milliseconds 50\n' +
    '}\n' +
    '$closeWatch.Stop()\n' +
    '$dialogCloseWaitMs = [int]$closeWatch.ElapsedMilliseconds\n' +
    `${outputAnchor}`)
  diagnosticSource = diagnosticSource.replace(
    'typedExact=$true; submitted=$true; submitControl=',
    'typedExact=$true; submitted=$true; dialogClosed=$dialogClosed; dialogCloseWaitMs=$dialogCloseWaitMs; submitControl=')
  fs.writeFileSync(helperPath, diagnosticSource)
  return helperPath
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

async function assertCustomSkin(page, label) {
  const resultHandle = await page.waitForFunction(async () => {
    const state = await window.aiNovelAPI.invoke('skin:get-state')
    if (state.activeSkin === 'custom' && /^[a-f0-9]{64}$/i.test(state.customSkin?.revision ?? '')) return { ready: true, state }
    const notice = document.querySelector('.appearance-settings .appearance-notice[role="status"]')
    if (notice) return { ready: false, notice: notice.textContent?.trim() ?? '' }
    return false
  }, undefined, { polling: 100, timeout: 15_000 })
  const result = await resultHandle.jsonValue()
  await resultHandle.dispose()
  assert.equal(result.ready, true, `${label}: ${result.notice ? `appearance UI reported: ${result.notice}` : 'skin import did not reach its persisted revision'}`)
  const state = result.state
  assert.equal(state.activeSkin, 'custom', `${label}: custom skin must be active in the main service`)
  assert.equal(await page.locator('.app-skin-root').getAttribute('data-skin'), 'custom', `${label}: rendered skin id`)
  const image = page.locator('.app-skin-background-image')
  await image.waitFor({ state: 'visible', timeout: 30_000 })
  assert.ok(await image.evaluate(element => element.complete && element.naturalWidth === 8 && element.naturalHeight === 6),
    `${label}: selected background must decode at the synthetic dimensions`)
  const asset = await page.evaluate(() => window.aiNovelAPI.invoke('skin:read-custom-asset'))
  assert.equal(asset.success, true, `${label}: stored skin asset must be readable`)
  assert.match(state.customSkin.revision, /^[a-f0-9]{64}$/i, `${label}: persisted skin revision format`)
  assert.equal(asset.revision, state.customSkin.revision, `${label}: state and readback asset revision`)
  const assetSha256 = createHash('sha256').update(Buffer.from(asset.bytes)).digest('hex')
  assert.equal(assetSha256, state.customSkin.revision, `${label}: revision must match normalized readback asset bytes`)
  assert.equal(state.customSkin.width, 8, `${label}: persisted skin width`)
  assert.equal(state.customSkin.height, 6, `${label}: persisted skin height`)
  assert.equal(state.customSkin.mime, 'image/png', `${label}: persisted skin MIME type`)
  return { revision: state.customSkin.revision, width: state.customSkin.width, height: state.customSkin.height,
    mime: state.customSkin.mime, storedBytes: asset.bytes.length, assetSha256 }
}

function selectNativeSkinImage(helperPath, executablePath, imagePath) {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-Target', imagePath, '-ExpectedExe', executablePath, '-DialogTitle', '选择自定义皮肤图片'],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim()
  const evidence = JSON.parse(output)
  assert.equal(evidence.typedExact, true, 'Native picker must receive the exact synthetic image path')
  assert.equal(evidence.submitted, true, 'Native picker must submit the selected synthetic image')
  return evidence
}

function assertNativePickerClosed(evidence) {
  assert.equal(evidence.dialogClosed, true,
    `PICKER_DID_NOT_CLOSE: HWND ${evidence.dialogHandle} remained open for ${evidence.dialogCloseWaitMs}ms after Enter`)
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
  const scratch = path.dirname(roots.userData)
  const pickerHelper = preparePickerHelper(scratch)
  const firstImagePath = path.join(scratch, 'synthetic-background-first.png')
  const replacementImagePath = path.join(scratch, 'synthetic-background-replacement.png')
  const firstImage = syntheticPng(214, 48, 66)
  const replacementImage = syntheticPng(28, 102, 211)
  fs.writeFileSync(firstImagePath, firstImage)
  fs.writeFileSync(replacementImagePath, replacementImage)
  const firstImageSha256 = createHash('sha256').update(firstImage).digest('hex')
  const replacementImageSha256 = createHash('sha256').update(replacementImage).digest('hex')
  const initialUserDataEntries = fs.readdirSync(roots.userData)
  assert.deepEqual(initialUserDataEntries, [], 'Fresh Electron userData must be empty before first launch')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  let session
  let firstLaunchObservation
  let explicitWriterSelection
  const nativePickerSelections = []
  try {
    if (backgroundOnly) {
      currentStep = 'background-only-explicit-writer'
      session = await launch(roots)
      let { page } = session
      await page.waitForFunction(key => localStorage.getItem(key) !== null, appearanceKey)
      const initialAppearance = await stored(page)
      assert.equal(initialAppearance.shellPreference, 'unset', 'Background-only profile must begin without an explicit shell choice')
      explicitWriterSelection = await page.evaluate(key => {
        const appearance = JSON.parse(localStorage.getItem(key))
        appearance.shellPreference = 'writer'
        appearance.revision += 1
        appearance.origin = 'author'
        localStorage.setItem(key, JSON.stringify(appearance))
        return { before: 'unset', after: appearance.shellPreference, revision: appearance.revision }
      }, appearanceKey)
      assert.equal(explicitWriterSelection.after, 'writer')
      await quit(session.app)
      session = await launch(roots)
      page = session.page
      await assertWriter(page)
      assert.equal((await stored(page)).shellPreference, 'writer')
      pass('background-only-select-writer', 'setup', 'Explicit profile choice reopens the same isolated profile in Writer; this does not qualify U02.A01')

      currentStep = 'U02.A04-select-background'
      const modal = await openSettings(page, '外观')
      await modal.locator('[data-skin-card="custom"] [data-skin-action="choose"]').click()
      const choosePicker = selectNativeSkinImage(pickerHelper, executablePath, firstImagePath)
      nativePickerSelections.push(choosePicker)
      assertNativePickerClosed(choosePicker)
      const firstSkinEvidence = await assertCustomSkin(page, 'U02.A04 initial selection')
      pass('custom-background-native-select', 'U02.A04', 'Appearance UI native picker imported the synthetic PNG into the main skin service and rendered it')

      currentStep = 'U02.A04-replace-background'
      await modal.locator('[data-skin-card="custom"] [data-skin-action="change"]').click()
      const replacementPicker = selectNativeSkinImage(pickerHelper, executablePath, replacementImagePath)
      nativePickerSelections.push(replacementPicker)
      assertNativePickerClosed(replacementPicker)
      const replacementSkinEvidence = await assertCustomSkin(page, 'U02.A04 replacement')
      assert.notEqual(replacementSkinEvidence.revision, firstSkinEvidence.revision, 'Replacement must persist a distinct image revision')
      pass('custom-background-replace', 'U02.A04', 'Appearance UI native picker replaced the image with a distinct persisted PNG revision')
      await closeSettings(modal)

      currentStep = 'U02.A04-reopen-persisted-background'
      await quit(session.app)
      session = await launch(roots)
      page = session.page
      await assertWriter(page)
      assert.equal((await stored(page)).shellPreference, 'writer')
      const reopenedSkinEvidence = await assertCustomSkin(page, 'U02.A04 after restart')
      assert.deepEqual(reopenedSkinEvidence, replacementSkinEvidence, 'Replacement skin state and image must survive process restart')
      await quit(session.app)
      session = null

      assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256, 'Driver changed during background-only journey')
      assert.deepEqual(provenance().artifactHashes, source.artifactHashes, 'Built bytes changed during background-only journey')
      const receipt = { outcome: 'PARTIAL', qualification: 'F05_U02_A04_BACKGROUND_ONLY', evidenceLevel: 'electron',
        ...source, driverSha256, pickerHelperSha256: sha256(pickerHelper), fullActionQualification: false,
        releaseDefaultQualified: false, explicitlySelectedWriter: explicitWriterSelection,
        runConditions: { runtime: process.version, nodeAbi: process.versions.modules, packageLaunch: true,
          freshProfile: true, preseededAppearanceKey: false, initialUserDataEntries,
          syntheticImages: [{ path: firstImagePath, sha256: firstImageSha256 },
            { path: replacementImagePath, sha256: replacementImageSha256 }],
          nativePickerSelections: [choosePicker, replacementPicker],
          skinEvidence: { selected: firstSkinEvidence, replacement: replacementSkinEvidence, afterRestart: reopenedSkinEvidence } }, steps }
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
      process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, qualification: receipt.qualification,
        testedSha: source.testedSha, executionHead: source.executionHead, driverSha256,
        receipt: path.relative(repository, receiptPath), steps: steps.map(step => step.stepId) })}\n`)
      return
    }

    currentStep = 'U02.A01'
    session = await launch(roots)
    let { page } = session
    firstLaunchObservation = await page.evaluate(key => {
      const root = document.querySelector('.app-skin-root')
      return {
        appearanceRaw: localStorage.getItem(key),
        userDataWasEmptyBeforeLaunch: true,
        rootSkin: root?.getAttribute('data-skin') ?? null,
        rootTheme: root?.getAttribute('data-theme') ?? null,
        writerShellCount: document.querySelectorAll('.writer-shell').length,
        shellPresentations: Array.from(document.querySelectorAll('[data-shell-presentation]'), element => ({
          presentation: element.getAttribute('data-shell-presentation'), variant: element.getAttribute('data-shell-variant'),
        })),
      }
    }, appearanceKey)
    await assertWriter(page)
    const freshProfile = await stored(page)
    assert.equal(freshProfile.shellPreference, 'unset', 'Fresh install must retain unset shell preference')
    assert.equal(await page.evaluate(() => document.querySelector('.writer-shell')?.getAttribute('data-shell-presentation')), 'writer')
    pass('fresh-install-unset-default-writer', 'U02.A01', 'No appearance preference was seeded; first launch resolves unset to Writer and retains unset')

    currentStep = 'U02.A03'
    let modal = await openSettings(page, '外观')
    await modal.locator('.appearance-theme-option[data-theme="galaxy"]').click()
    await page.waitForFunction(() => document.querySelector('.app-skin-root')?.getAttribute('data-theme') === 'galaxy')
    assert.equal(await modal.locator('.appearance-theme-option[data-theme="galaxy"]').getAttribute('aria-pressed'), 'true')
    assert.equal((await stored(page)).colorTheme, 'galaxy')
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('galaxy')), true)
    pass('writer-select-color-theme', 'U02.A03', 'Writer appearance button applies Galaxy theme in UI and canonical profile')

    currentStep = 'U02.A04'
    const chooseButton = modal.locator('[data-skin-card="custom"] [data-skin-action="choose"]')
    await chooseButton.click()
    const choosePicker = selectNativeSkinImage(pickerHelper, executablePath, firstImagePath)
    nativePickerSelections.push(choosePicker)
    assertNativePickerClosed(choosePicker)
    const firstSkinEvidence = await assertCustomSkin(page, 'U02.A04 initial selection')
    pass('custom-background-native-select', 'U02.A04', 'Appearance UI native picker imported the synthetic PNG into SkinService and rendered it')
    const replaceButton = modal.locator('[data-skin-card="custom"] [data-skin-action="change"]')
    await replaceButton.click()
    const replacementPicker = selectNativeSkinImage(pickerHelper, executablePath, replacementImagePath)
    nativePickerSelections.push(replacementPicker)
    assertNativePickerClosed(replacementPicker)
    const replacementSkinEvidence = await assertCustomSkin(page, 'U02.A04 replacement')
    assert.notEqual(replacementSkinEvidence.revision, firstSkinEvidence.revision, 'Replacement must persist a distinct image revision')
    pass('custom-background-replace', 'U02.A04', 'Appearance UI native picker replaced the image with a distinct persisted PNG revision')
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
    const reopenedSkinEvidence = await assertCustomSkin(page, 'U02.A04 after restart')
    assert.deepEqual(reopenedSkinEvidence, replacementSkinEvidence, 'Replacement skin state and image must survive Electron restart')
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
    assert.deepEqual(source.appearanceInputChanges, [], 'No U02 appearance product input may differ from fixed package source')
    const receipt = { outcome: 'PARTIAL', qualification: 'F05_U02_APPEARANCE_ONLY', evidenceLevel: 'electron',
      ...source, driverSha256, pickerHelperSha256: sha256(pickerHelper), fullActionQualification: false, releaseDefaultQualified: false,
      runConditions: { runtime: process.version, nodeAbi: process.versions.modules, packageLaunch: true,
        freshProfile: true, preseededAppearanceKey: false, initialUserDataEntries, syntheticImages: [
          { path: firstImagePath, sha256: firstImageSha256 }, { path: replacementImagePath, sha256: replacementImageSha256 },
        ], nativePickerSelections: [choosePicker, replacementPicker], skinEvidence: { selected: firstSkinEvidence,
          replacement: replacementSkinEvidence, afterRestart: reopenedSkinEvidence } }, steps }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: 'PARTIAL', testedSha: source.testedSha, executionHead: source.executionHead,
      driverSha256, receipt: path.relative(repository, receiptPath), steps: steps.map(step => step.stepId) })}\n`)
  } catch (error) {
    if (session) await session.app.close().catch(() => {})
    fs.writeFileSync(receiptPath, JSON.stringify({ outcome: 'FAIL', qualification: backgroundOnly
      ? 'F05_U02_A04_BACKGROUND_ONLY' : 'F05_U02_APPEARANCE_ONLY', ...source, driverSha256,
      pickerHelperSha256: sha256(pickerHelper), failedStep: currentStep, initialUserDataEntries, firstLaunchObservation,
      explicitlySelectedWriter: explicitWriterSelection, fullActionQualification: false, releaseDefaultQualified: false,
      nativePickerSelections, steps, error: String(error) }, null, 2))
    throw error
  }
}

if (process.argv.includes('--help')) process.stdout.write('Pass --package-dir, --package-base-sha, --exe-sha256 and --asar-sha256 for fixed V3 package; use --background-only to qualify U02.A04 independently.\n')
else main().catch(error => { console.error(error); process.exitCode = 1 })
