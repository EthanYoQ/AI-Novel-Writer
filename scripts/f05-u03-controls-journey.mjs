/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = option('package-dir') && path.resolve(option('package-dir'))
const packageSourceSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
assert(packageDir && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const priorPath = path.join(repository, '.runtime', '.cache', 'f05-u03-controls', '4d4c1bab-16f7-48c7-b7a8-7514b353eb76', 'receipt.json')
const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'))
assert.equal(prior.outcome, 'PASS', 'historical Writer controls receipt missing')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = file => sha256(fs.readFileSync(file))
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const testedSha = git('rev-parse', `${packageSourceSha}^{commit}`)
const changedPaths = git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean)
assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', 'src', 'electron', 'public', 'build',
  'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '', 'product source changed since fixed package SHA')
const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|pages\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)), 'product source dirty beyond test screenshots')
assert.equal(fileHash(executablePath), expectedExe)
assert.equal(fileHash(asarPath), expectedAsar)

const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u03-controls', runId)
const scratch = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository), 'VibeCodingScratch', 'an', 'u3c', runId.slice(0, 6))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects'].map(name => [name, path.join(scratch, name)]))
const steps = []
const preconditions = []
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, outcome: 'PASS', assertion })
const recordPrecondition = (stepId, assertion) => preconditions.push({ stepId, assertion })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const writer = page => page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]')
const settings = page => page.getByRole('button', { name: '关闭设置' }).locator('xpath=ancestor::div[contains(@class,"relative flex")]')

async function assertWriter(page, actionId) {
  await writer(page).waitFor({ state: 'visible' })
  assert.equal(await writer(page).getAttribute('data-shell-variant'), 'v3', `${actionId}: current shell is not V3 writer`)
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U03 controls', sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'review packaged V3 U03 controls receipt', cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let failure
  let currentStep = 'setup'
  let app
  let copiedDiagnostic = ''
  let clipboardObservation = null
  let projectCreateObservation = null
  try {
    currentStep = 'packaged-native-load'
    const verified = verifyWindowsPackage(packageDir)
    assert(verified.nativeBinding && verified.betterSqliteBinding)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    pass('packaged-native-load', null, 'fixed artifact hashes and packaged native bindings verified')
    const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
    app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
    const page = await app.firstWindow({ timeout: 30_000 })
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    // The packaged artifact keeps its release default separate from test-profile selection.
    // Select Writer explicitly before any journey action and then assert the selected shell.
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    await page.evaluate(() => {
      const key = 'ai-novel-writer-appearance'
      const appearance = JSON.parse(localStorage.getItem(key))
      appearance.shellPreference = 'writer'
      appearance.revision += 1
      appearance.origin = 'author'
      localStorage.setItem(key, JSON.stringify(appearance))
    })
    await page.reload()
    await writer(page).waitFor({ state: 'visible', timeout: 30_000 })

    currentStep = 'U03.A01-sidebar-settings'
    await assertWriter(page, 'U03.A01')
    await page.locator('.writer-left-rail button[title="设置"]').click()
    await settings(page).getByRole('heading', { name: 'AI 生成模型' }).waitFor()
    recordPrecondition('U03.A01-sidebar-settings', 'V3 shell assertion preceded the rail settings click and the real settings modal rendered')
    await page.getByRole('button', { name: '关闭设置' }).click()

    currentStep = 'U03.A02-statusbar-settings'
    await assertWriter(page, 'U03.A02')
    await page.locator('.writer-statusbar [title="点击配置模型"]').click()
    await settings(page).getByRole('heading', { name: 'AI 生成模型' }).waitFor()
    recordPrecondition('U03.A02-statusbar-settings', 'V3 shell assertion preceded the status bar model entry and the same real settings modal rendered')
    await page.getByRole('button', { name: '关闭设置' }).click()

    currentStep = 'U03.A13-proxy-failure'
    await assertWriter(page, 'U03.A13')
    const generations = fs.readdirSync(path.join(profile.canonical, 'generations'))
    assert.equal(generations.length, 1, 'isolated profile must have one admitted global generation')
    const configPath = path.join(profile.canonical, 'generations', generations[0], 'config.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null
    const malformedConfig = '{ malformed proxy config'
    fs.writeFileSync(configPath, malformedConfig)
    await page.locator('.writer-left-rail button[title="设置"]').click()
    await settings(page).getByRole('button', { name: '网络代理', exact: true }).click()
    await settings(page).getByRole('heading', { name: '网络代理' }).waitFor()
    const proxySwitch = settings(page).getByRole('switch', { name: '启用代理' })
    if (!(await proxySwitch.isChecked())) await proxySwitch.click()
    await settings(page).getByRole('textbox').first().fill('127.0.0.1')
    await settings(page).getByRole('button', { name: '保存代理配置', exact: true }).click()
    const proxyAlert = settings(page).getByRole('alert')
    await proxyAlert.waitFor()
    assert.match(await proxyAlert.textContent(), /代理配置保存失败/u)
    assert.equal(fs.readFileSync(configPath, 'utf8'), malformedConfig, 'malformed admitted config must remain untouched')
    recordPrecondition('U03.A13-proxy-failure', 'V3 proxy save surfaced the malformed-global-config failure through the visible alert without replacing the protected file')
    await page.getByRole('button', { name: '关闭设置' }).click()
    if (originalConfig) fs.writeFileSync(configPath, originalConfig)
    else fs.rmSync(configPath, { force: true })
    await page.reload()
    await assertWriter(page, 'U03.A14')

    currentStep = 'U03.A14-safe-diagnostic-copy'
    await assertWriter(page, 'U03.A14')
    const project = await invoke(page, 'project:create', { path: profile.projects, name: 'U03-controls', genre: 'fixture', targetAudience: 'fixture', writingLanguage: 'zh-CN' }, randomUUID(), null)
    projectCreateObservation = { success: project.success,
      stale: Object.hasOwn(project, 'stale') ? project.stale : 'absent',
      hasOwnError: Object.hasOwn(project, 'error'),
      error: project.error ? String(project.error).replaceAll(scratch, '[scratch]') : null,
      databaseRestored: project.databaseRestored, dbReady: project.dbReady }
    assert.equal(project.success, true, JSON.stringify(projectCreateObservation))
    // Seed the existing project database directly; this action tests copying a displayed record.
    const fixtureDb = new Database(path.join(project.projectPath, '.ai-novel', 'project.db'))
    const sensitivePurpose = 'chapter-draft Authorization: Bearer sk-do-not-copy C:\\VibeCodingScratch\\private'
    try {
      fixtureDb.prepare('INSERT INTO llm_calls (model_id, model_name, purpose, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        '2f491640-c201-4c6e-922b-3103e8c2c5f7', `Grok 4 ${runId}`, sensitivePurpose, 20, 40, 60, 900, 0, 'finish:content_filter',
      )
      assert.equal(fixtureDb.prepare('SELECT purpose FROM llm_calls ORDER BY id DESC LIMIT 1').get().purpose, sensitivePurpose)
    } finally { fixtureDb.close() }
    await page.reload()
    await writer(page).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '打开《U03-controls》' }).click()
    const context = await invoke(page, 'project:get-runtime-context')
    assert.equal(path.resolve(context.activeProjectPath), path.resolve(project.projectPath))
    await page.locator('.writer-left-rail button[title="模型"]').click()
    await page.getByRole('button', { name: '复制安全诊断' }).waitFor()
    const clipboardSentinel = `pre-click-sentinel-${runId}`
    const previousClipboard = await app.evaluate(({ clipboard }) => ({
      formats: clipboard.availableFormats(),
      text: clipboard.readText(),
    }))
    const wasEmpty = previousClipboard.formats.length === 0
    if ((wasEmpty && previousClipboard.text !== '')
      || (!wasEmpty && !(previousClipboard.formats.length === 1 && previousClipboard.formats[0] === 'text/plain'))) {
      clipboardObservation = {
        beforeFormats: previousClipboard.formats,
        beforeWasEmpty: wasEmpty,
        preflight: 'unsupported-formats',
        sentinelVerified: false,
        diagnosticReadBackVerified: false,
        restoreStatus: 'not-started',
        restoredFormats: null,
        restoredTextVerified: false,
      }
      throw new Error('OS clipboard has formats that this journey cannot preserve losslessly')
    }
    clipboardObservation = {
      beforeFormats: previousClipboard.formats,
      beforeWasEmpty: wasEmpty,
      preflight: 'preservable',
      sentinelVerified: false,
      diagnosticReadBackVerified: false,
      restoreStatus: 'not-started',
      restoredFormats: null,
      restoredTextVerified: false,
    }
    try {
      await app.evaluate(({ clipboard }, sentinel) => clipboard.writeText(sentinel), clipboardSentinel)
      const sentinelState = await app.evaluate(({ clipboard }) => ({
        formats: clipboard.availableFormats(),
        text: clipboard.readText(),
      }))
      if (sentinelState.text !== clipboardSentinel || sentinelState.formats.length !== 1 || sentinelState.formats[0] !== 'text/plain') {
        throw new Error('OS clipboard test sentinel was not written as plain text')
      }
      clipboardObservation.sentinelVerified = true
      await page.getByRole('button', { name: '复制安全诊断' }).click()
      const copiedState = await app.evaluate(({ clipboard }) => ({
        formats: clipboard.availableFormats(),
        text: clipboard.readText(),
      }))
      copiedDiagnostic = copiedState.text
      if (copiedState.formats.length !== 1 || copiedState.formats[0] !== 'text/plain'
        || copiedDiagnostic === clipboardSentinel || !copiedDiagnostic.includes(runId)) {
        throw new Error('V3 copy did not write this run’s diagnostic to the OS clipboard')
      }
      if (!copiedDiagnostic.includes('Grok 4') || !copiedDiagnostic.includes('content_filter')
        || /Authorization|request body|sk-do-not-copy|VibeCodingScratch/u.test(copiedDiagnostic)) {
        throw new Error('OS clipboard diagnostic projection did not match the safe fixture')
      }
      clipboardObservation.diagnosticReadBackVerified = true
    } finally {
      const restoration = await app.evaluate(({ clipboard }, { previous, sentinel, marker, wasEmpty }) => {
        const current = clipboard.readText()
        if (current !== sentinel && !current.includes(marker)) {
          return { status: 'skipped-external-change', formats: clipboard.availableFormats(), textMatches: false }
        }
        if (wasEmpty) clipboard.clear()
        else clipboard.writeText(previous)
        const formats = clipboard.availableFormats()
        const textMatches = clipboard.readText() === previous
        const formatsMatch = wasEmpty
          ? formats.length === 0
          : formats.length === 1 && formats[0] === 'text/plain'
        return { status: textMatches && formatsMatch ? 'verified' : 'mismatch', formats, textMatches }
      }, { previous: previousClipboard.text, sentinel: clipboardSentinel, marker: runId, wasEmpty })
      clipboardObservation.restoreStatus = restoration.status
      clipboardObservation.restoredFormats = restoration.formats
      clipboardObservation.restoredTextVerified = restoration.textMatches
    }
    if (clipboardObservation.restoreStatus !== 'verified') {
      throw new Error(`OS clipboard restoration was not verified (${clipboardObservation.restoreStatus})`)
    }
    pass('U03.A14-safe-diagnostic-copy', 'U03.A14', 'V3 button wrote the safe diagnostic to the OS clipboard, excluded fixture secrets and paths, and restored the prior supported clipboard state')
  } catch (error) { failure = error }
  finally { await app?.close() }
  const receipt = {
    outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U03_A14_OS_CLIPBOARD_ONLY', shell: 'writer-v3',
    testedSha, currentHead: git('rev-parse', 'HEAD'), changedPaths,
    reuseDecision: { testedSha, changedPaths, differences: changedPaths.join(', ') || 'none', reason: 'historical Writer UI is not reused; fixed V3 package hashes match and current V3 UI is exercised independently' },
    dirtyProductPaths, buildReceipt: { path: priorPath, sha256: fileHash(priorPath) },
    sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
    artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
    driver: { path: fileURLToPath(import.meta.url), sha256: fileHash(fileURLToPath(import.meta.url)) },
    profile: { canonical: profile.canonical, userData: profile.userData, projectRoot: profile.projects },
    steps, preconditions, projectCreateObservation, clipboardObservation,
    unverified: Array.from({ length: 13 }, (_, index) => `U03.A${String(index + 1).padStart(2, '0')}`),
    failedStep: failure ? currentStep : null, error: failure ? String(failure) : null,
  }
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
