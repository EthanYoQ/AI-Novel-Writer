/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = arg('package-dir') && path.resolve(arg('package-dir'))
const executablePath = resolveWindowsExecutable(packageDir ?? '')
const asarPath = path.join(packageDir ?? '', 'resources', 'app.asar')
const testedSha = arg('package-source-sha')
const expectedExeSha = arg('exe-sha256')
const expectedAsarSha = arg('asar-sha256')
// 旧外壳时期的历史回执只在当年的机器上：有就记下，不沿用。
const priorReceiptPath = path.join(repository, '.runtime', '.cache', 'f05-u02-migration', 'cca73e9a-b803-4ac6-9328-2148d29be65c', 'receipt.json')
const Database = createRequire(import.meta.url)('better-sqlite3')
const runId = randomUUID()
const root = path.join(repository, '.runtime', '.cache', 'f05-u02-migration', runId)
assert(process.env.LOCALAPPDATA, 'F05 U02 needs LOCALAPPDATA for short isolated SQLite paths')
const scratchRoot = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel', `u02-${runId.slice(0, 8)}`)
const appearanceKey = 'ai-novel-writer-appearance-v3'
const previousKey = 'ai-novel-writer-appearance'
const themeKey = 'ai-novel-writer-theme'
const shellKey = 'ai-novel-writer-ui-version'
const themeRaw = JSON.stringify({ state: { theme: 'dark', zoom: 1.2, writingFont: 'noto-serif-sc', uiFont: 'inter', fontDefaultsVersion: 0 }, version: 0 })
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const driverSha256 = sha256(fileURLToPath(import.meta.url))
const initialBody = `迁移前正文 ${runId}`
const savedBody = `${initialBody} 迁移后补写`
const steps = []
const screenshots = {}
let currentStep = 'setup'
const pass = (stepId, actionId, assertion, migrationScenario) => steps.push({ stepId, actionId, assertion, migrationScenario, outcome: 'PASS' })

function profile(name) {
  const base = path.join(scratchRoot, name)
  const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData']
    .map(key => [key, path.join(base, key)]))
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true })
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
    await page.waitForFunction(key => localStorage.getItem(key) !== null, appearanceKey)
    return { app, page }
  } catch (error) { await app.close(); throw error }
}

/** v3 外观偏好（解析后）与三个旧键的原始字节。 */
async function stored(page) {
  return page.evaluate(keys => ({
    appearance: JSON.parse(localStorage.getItem(keys.appearanceKey)),
    previous: localStorage.getItem(keys.previousKey),
    theme: localStorage.getItem(keys.themeKey), shell: localStorage.getItem(keys.shellKey),
  }), { appearanceKey, previousKey, themeKey, shellKey })
}

/** 迁移后不阻塞：启动就绪、进入纸墨书房、没有弹窗挡住；主题落在纸墨根与文档上。 */
async function assertOpenStage(page, theme) {
  assert.equal((await page.evaluate(() => window.aiNovelAPI.invoke('startup:get-state'))).state, 'ready')
  await stage.root(page).locator('.stage-library').waitFor({ state: 'visible' })
  assert.equal(await page.getByRole('dialog').count(), 0, 'a dialog blocks the migrated profile')
  assert.equal(await stage.root(page).getAttribute('data-theme'), theme)
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark')
  assert.equal(await page.locator('.app-skin-root, .app-skin-background-image').count(), 0, 'an image skin is still rendered')
}

/** 旧版本把图片皮肤记在全局数据的 skins/manifest.json；新版本不再读它，迁移时原样带进新数据目录留给回退。 */
function seedLegacySkin(roots, skin) {
  const manifest = JSON.stringify({ version: 1, activeSkin: skin })
  fs.mkdirSync(path.join(roots.legacy, 'skins'), { recursive: true })
  fs.writeFileSync(path.join(roots.legacy, 'skins', 'manifest.json'), manifest)
  return manifest
}
function assertSkinManifestRetained(roots, manifest) {
  const receipt = JSON.parse(fs.readFileSync(path.join(roots.canonical, '.migration', 'receipt.json'), 'utf8'))
  assert.equal(fs.readFileSync(path.join(roots.canonical, 'generations', receipt.generation, 'skins', 'manifest.json'), 'utf8'), manifest,
    'migrated global data lost the old skin manifest')
  assert.equal(fs.readFileSync(path.join(roots.legacy, 'skins', 'manifest.json'), 'utf8'), manifest, 'old skin manifest changed')
}

function dbBody(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
  try { return db.prepare('SELECT contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id WHERE drafts.chapter_number = 1 AND drafts.version = 1').get().body }
  finally { db.close() }
}
function modelCallCount(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
  try { return db.prepare('SELECT COUNT(*) AS count FROM llm_calls').get().count }
  finally { db.close() }
}

function sourceFiles(sourceRoot) {
  const result = {}
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) result[path.relative(sourceRoot, file).replaceAll('\\', '/')] = sha256(file)
      else throw new Error(`Unsafe synthetic source: ${file}`)
    }
  }
  visit(sourceRoot)
  return result
}

function prepareLegacyProject(name) {
  const sourceRoot = path.join(scratchRoot, `s${name.slice(1)}`)
  const storage = path.join(sourceRoot, '.vela')
  fs.mkdirSync(storage, { recursive: true })
  const sourceProjectId = randomUUID()
  const sourceName = `迁移前作品-${name}`
  const sourceDatabase = path.join(storage, 'vela.db')
  const db = new Database(sourceDatabase)
  try {
    db.pragma('foreign_keys = ON')
    db.exec(fs.readFileSync(path.join(repository, 'electron', 'services', '__tests__', 'legacy-v110-schema.sql'), 'utf8'))
    db.prepare('INSERT INTO project_core(id,project_name,genre) VALUES (?,?,?)').run('main', sourceName, '合成测试')
    db.prepare('INSERT INTO contents(body) VALUES (?)').run(initialBody)
    db.prepare('INSERT INTO drafts(chapter_number,version,content_id,word_count) VALUES (1,1,1,?)').run(initialBody.length)
    assert.equal(db.pragma('user_version', { simple: true }), 0)
  } finally { db.close() }
  fs.writeFileSync(path.join(storage, 'project.json'), JSON.stringify({ schemaVersion: 1,
    kind: 'ai-novel-project', projectId: sourceProjectId, createdAt: new Date().toISOString() }))
  return { sourceRoot, sourceProjectId, sourceName, sourceDatabase, before: sourceFiles(sourceRoot) }
}

/**
 * 整窗截图走主进程的 capturePage：外观里的缩放改的是 Electron 原生缩放，Playwright 按页面视口截图会裁掉一角或多出空白。
 */
async function windowShot(app, file) {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(file, Buffer.from(png, 'base64'))
}

/** 顶栏保存状态。 */
async function topStatus(page, label) {
  await stage.saveStatus(page).filter({ hasText: new RegExp(`^${label}$`) }).waitFor({ state: 'visible' })
}

/** 从书房的「导入旧项目副本」把 schema0 旧项目导成新版副本，在副本里改正文、Ctrl S 保存，再开新进程重开。 */
async function currentProjectState(name, roots, session, source) {
  const targetParent = path.join(scratchRoot, `t${name.slice(1)}`)
  fs.mkdirSync(targetParent)
  const targetRoot = path.join(targetParent, `${path.basename(source.sourceRoot)}-新版副本`)
  assert(targetRoot.length <= 85, 'synthetic target exceeds current Windows project path contract')
  let page = session.page
  const open = async () => {
    await stage.dismissMigrationNotice(page)
    await stage.showLibrary(page)
    await stage.openFromLibrary(page, source.sourceName)
    await stage.waitForWork(page, source.sourceName)
    const context = await page.evaluate(() => window.aiNovelAPI.invoke('project:get-runtime-context'))
    assert.equal(path.resolve(context.activeProjectPath).toLowerCase(), path.resolve(targetRoot).toLowerCase())
  }
  try {
    await stage.dismissMigrationNotice(page)
    await stage.showLibrary(page)
    await session.app.evaluate(({ dialog }, { sourceRoot, targetParent }) => {
      globalThis.__u02Dialogs = []
      dialog.showOpenDialog = async options => {
        globalThis.__u02Dialogs.push({ type: 'open', title: options.title })
        if (options.title === '选择旧版小说项目文件夹') return { canceled: false, filePaths: [sourceRoot] }
        if (options.title === '选择恢复副本所在文件夹') return { canceled: false, filePaths: [targetParent] }
        throw new Error(`Unexpected dialog: ${options.title}`)
      }
      dialog.showMessageBox = async options => {
        globalThis.__u02Dialogs.push({ type: 'confirm', message: options.message })
        if (!options.message.includes('保存并关闭旧版程序')) throw new Error('Unexpected confirmation')
        return { response: 1, checkboxChecked: false }
      }
    }, { sourceRoot: source.sourceRoot, targetParent })
    await stage.importLegacyCopy(page)
    try {
      await stage.waitForWork(page, source.sourceName)
    } catch (error) {
      const diagnostic = { dialogs: await session.app.evaluate(() => globalThis.__u02Dialogs).catch(error => ({ unavailable: String(error) })),
        notices: await page.locator('[role="status"]').allInnerTexts().catch(error => ({ unavailable: String(error) })),
        library: await page.locator('.stage-library').innerText().catch(() => null),
        targetExists: fs.existsSync(targetRoot), targetParentEntries: fs.readdirSync(targetParent) }
      throw new Error(`stage import did not open project: ${JSON.stringify(diagnostic)}`, { cause: error })
    }
    const dialogs = await session.app.evaluate(() => globalThis.__u02Dialogs)
    assert.deepEqual(dialogs.map(dialog => dialog.type), ['open', 'open', 'confirm'])
    assert(fs.existsSync(path.join(targetRoot, '.ai-novel', 'project.db')))
    const manifest = JSON.parse(fs.readFileSync(path.join(targetRoot, '.ai-novel', 'project.json'), 'utf8'))
    assert.match(manifest.projectId, /^[a-f0-9-]{36}$/)
    assert.notEqual(manifest.projectId, source.sourceProjectId)
    assert.equal(manifest.storageFormat, 'ai-novel')
    const db = new Database(path.join(targetRoot, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 7)
      assert.deepEqual(db.prepare('SELECT id,project_name FROM project_core').get(), { id: 'main', project_name: source.sourceName })
    } finally { db.close() }
    assert.equal(dbBody(targetRoot), initialBody)
    assert.equal(modelCallCount(targetRoot), 0)
    assert.deepEqual(sourceFiles(source.sourceRoot), source.before)
    pass(`${name}-schema7-import`, 'U02.A07', 'The library 导入旧项目副本 imported the schema0 project into schema7 with exact title, draft body and new copy identity; old source bytes stayed unchanged',
      'legacy-appearance-with-project-state-to-stage')
    let body = await stage.openChapter(page, 1)
    assert.equal(await stage.proseBody(body), initialBody)
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 迁移后补写')
    assert.equal(await stage.proseBody(body), savedBody)
    await topStatus(page, '未保存')
    assert.equal(dbBody(targetRoot), initialBody)
    await page.keyboard.press('ControlOrMeta+s')
    await topStatus(page, '已保存')
    assert.equal(dbBody(targetRoot), savedBody)
    assert.equal(modelCallCount(targetRoot), 0)
    assert.deepEqual(sourceFiles(source.sourceRoot), source.before)
    pass(`${name}-schema7-save`, 'U02.A07', 'Ctrl S in the stage chapter editor saved the exact edited body in the imported schema7 copy without changing the old source',
      'legacy-appearance-with-project-state-to-stage')
    await session.app.close()
    session = await launch(roots)
    page = session.page
    await open()
    body = await stage.openChapter(page, 1)
    assert.equal(await stage.proseBody(body), savedBody)
    assert.equal(dbBody(targetRoot), savedBody)
    assert.equal(modelCallCount(targetRoot), 0)
    assert.deepEqual(sourceFiles(source.sourceRoot), source.before)
    pass(`${name}-schema7-reopen`, 'U02.A07', 'A new process reopened the same copy identity from the library with the exact saved body; old source bytes stayed unchanged',
      'legacy-appearance-with-project-state-to-stage')
  } finally { await session.app.close() }
}

async function main() {
  assert(packageDir && path.isAbsolute(packageDir) && /^[a-f0-9]{40}$/.test(testedSha ?? '') && /^[a-f0-9]{64}$/.test(expectedExeSha ?? '')
    && /^[a-f0-9]{64}$/.test(expectedAsarSha ?? ''), 'Specify --package-dir, --package-source-sha and fixed exe/asar SHA256')
  assert.equal(git('rev-parse', `${testedSha}^{commit}`), testedSha, 'package source SHA is unavailable')
  assert.equal(sha256(executablePath), expectedExeSha)
  assert.equal(sha256(asarPath), expectedAsarSha)
  const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
  assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productInputs), '', 'product inputs changed since fixed package')
  const dirtyProductPaths = git('status', '--porcelain', '--', ...productInputs).split('\n').filter(Boolean)
  assert(dirtyProductPaths.every(line => /^\?\? src\/.*\/__tests__\/__screenshots__\/$/.test(line)), 'product inputs dirty beyond test screenshots')
  const prior = fs.existsSync(priorReceiptPath) ? JSON.parse(fs.readFileSync(priorReceiptPath, 'utf8')) : null
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(scratchRoot, { recursive: true })
  fs.writeFileSync(path.join(scratchRoot, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u02-a07',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${scratchRoot}' -Recurse -Force`,
    retainReason: 'Synthetic appearance migration and schema0-to-schema7 stage import evidence' }, null, 2))
  const receipt = { outcome: 'FAIL', qualification: 'F05_U02_DEFAULT_A02_A07_CURRENT', evidenceLevel: 'electron',
    shell: 'stage', testedSha, executionHead: git('rev-parse', 'HEAD'),
    driverSha256, artifactHashes: { executable: expectedExeSha, asar: expectedAsarSha }, packageRoot: packageDir,
    historicalReceipt: prior ? { path: priorReceiptPath, sha256: sha256(priorReceiptPath), testedSha: prior.testedSha, reused: false }
      : { path: priorReceiptPath, missing: true },
    dirtyProductPaths, sourceDirtyPaths: git('status', '--porcelain').split('\n').filter(Boolean),
    persistedModelCalls: null, physicalModelRequestsObservation: 'NOT_OBSERVED_BY_THIS_JOURNEY',
    releaseDefaultQualified: false, screenshots, steps }
  try {
    currentStep = 'fresh-default'
    const fresh = await launch(profile('fresh-default'))
    try {
      const state = await stored(fresh.page)
      assert.deepEqual(state.appearance, { schemaVersion: 3, revision: 1, colorTheme: 'light', zoom: 1, writingFont: 'lxgw-wenkai',
        uiFont: 'noto-sans-sc', origin: 'legacy-import', legacyImportCompleted: true })
      assert.equal(state.previous, null)
      assert.equal(state.theme, null)
      assert.equal(state.shell, null)
      await assertOpenStage(fresh.page, 'light')
      // RD-10 lane 2：全新安装首次启动停在空书房。
      await stage.root(fresh.page).getByText('书架还是空的', { exact: true }).waitFor({ state: 'visible' })
      await stage.modelMissingNotice(fresh.page).waitFor({ state: 'visible' })
      screenshots.fresh = path.join(root, 'rd10-fresh.png')
      await windowShot(fresh.app, screenshots.fresh)
      pass('fresh-default-stage', 'U02.A02', 'A fresh installed profile opens the empty light paper-ink library and writes only the v3 profile', 'fresh-to-stage')
    } finally { await fresh.app.close() }

    // RD-10 之前的外观偏好（v1 带 writer、v2 带 classic）加旧图片皮肤：星空迁为深色，纸面迁为浅色，皮肤不再生效，旧键与旧清单原样保留。
    for (const scenario of [
      { name: 'galaxy', skin: 'anime', theme: 'dark', shot: 'rd10-migrate-galaxy.png', previous: { schemaVersion: 1, revision: 4,
        shellPreference: 'writer', colorTheme: 'galaxy', zoom: 1.2, writingFont: 'noto-serif-sc', uiFont: 'inter', origin: 'author', legacyImportCompleted: true } },
      { name: 'paper', skin: 'custom', theme: 'light', shot: 'rd10-migrate-paper.png', previous: { schemaVersion: 2, revision: 7,
        shellPreference: 'classic', colorTheme: 'paper', zoom: 0.9, writingFont: 'lxgw-wenkai', uiFont: 'system', origin: 'author', legacyImportCompleted: true } },
    ]) {
      currentStep = `${scenario.name}-previous-appearance`
      const roots = profile(scenario.name)
      const manifest = seedLegacySkin(roots, scenario.skin)
      const previousRaw = JSON.stringify(scenario.previous)
      let session = await launch(roots)
      try {
        await session.page.evaluate(({ appearanceKey, previousKey, previousRaw }) => {
          localStorage.removeItem(appearanceKey)
          localStorage.setItem(previousKey, previousRaw)
        }, { appearanceKey, previousKey, previousRaw })
      } finally { await session.app.close() }
      const { shellPreference: _dropped, colorTheme: _oldTheme, ...carried } = scenario.previous
      const expected = { ...carried, schemaVersion: 3, colorTheme: scenario.theme }
      session = await launch(roots)
      try {
        const state = await stored(session.page)
        assert.deepEqual(state.appearance, expected)
        assert.equal(state.previous, previousRaw, 'pre-RD-10 appearance bytes were changed')
        await assertOpenStage(session.page, scenario.theme)
        assertSkinManifestRetained(roots, manifest)
        // 书房读完最近项目才定版面（空书房标题与模型提示），之后再截图。
        await stage.root(session.page).getByText('书架还是空的', { exact: true }).waitFor({ state: 'visible' })
        await stage.modelMissingNotice(session.page).waitFor({ state: 'visible' })
        screenshots[scenario.name] = path.join(root, scenario.shot)
        await windowShot(session.app, screenshots[scenario.name])
        steps.push({ stepId: `${scenario.name}-previous-converted`, phase: 'migration-intermediate', outcome: 'PASS',
          assertion: `Startup converted the v${scenario.previous.schemaVersion} ${scenario.previous.colorTheme} profile with the ${scenario.skin} skin into ${scenario.theme} without blocking; old key and skin manifest kept` })
      } finally { await session.app.close() }
      session = await launch(roots)
      try {
        const state = await stored(session.page)
        assert.deepEqual(state.appearance, expected)
        assert.equal(state.previous, previousRaw)
        await assertOpenStage(session.page, scenario.theme)
        pass(`${scenario.name}-stage-after-migration`, 'U02.A02', `The migrated ${scenario.previous.colorTheme} profile reopens in the ${scenario.theme} stage with its zoom and fonts; the old key stays for rollback`,
          `previous-${scenario.previous.colorTheme}-${scenario.skin}-to-${scenario.theme}`)
      } finally { await session.app.close() }
    }

    // 最早的版本：主题、缩放与字体在 ai-novel-writer-theme，外壳选择在 ai-novel-writer-ui-version。迁移后接着导入旧项目副本。
    for (const [name, legacyShell] of [['v1', 'v1'], ['v2', JSON.stringify({ state: { uiVersion: 'v2' }, version: 0 })]]) {
      currentStep = `${name}-legacy-keys`
      const roots = profile(name)
      const manifest = seedLegacySkin(roots, 'anime')
      let session = await launch(roots)
      try {
        await session.page.evaluate(keys => {
          localStorage.removeItem(keys.appearanceKey)
          localStorage.removeItem(keys.previousKey)
          localStorage.setItem(keys.themeKey, keys.themeRaw)
          localStorage.setItem(keys.shellKey, keys.legacyShell)
        }, { appearanceKey, previousKey, themeKey, shellKey, themeRaw, legacyShell })
      } finally { await session.app.close() }
      const source = prepareLegacyProject(name)
      const expected = { schemaVersion: 3, revision: 1, colorTheme: 'dark', zoom: 1.2, writingFont: 'noto-serif-sc', uiFont: 'inter',
        origin: 'legacy-import', legacyImportCompleted: true, legacyFontDefaultsVersion: 0 }
      session = await launch(roots)
      try {
        const state = await stored(session.page)
        assert.deepEqual(state.appearance, expected)
        assert.equal(state.theme, themeRaw, 'legacy theme bytes were changed')
        assert.equal(state.shell, legacyShell, 'legacy shell bytes were changed')
        assert.equal(state.previous, null)
        await assertOpenStage(session.page, 'dark')
        assertSkinManifestRetained(roots, manifest)
        steps.push({ stepId: `${name}-legacy-converted`, phase: 'migration-intermediate', outcome: 'PASS',
          assertion: `Startup converted the ${name} legacy theme and shell keys into the dark v3 profile without changing their bytes; the old anime skin is no longer applied` })
      } finally { await session.app.close() }
      session = await launch(roots)
      try {
        const state = await stored(session.page)
        assert.deepEqual(state.appearance, expected)
        assert.equal(state.theme, themeRaw)
        assert.equal(state.shell, legacyShell)
        await assertOpenStage(session.page, 'dark')
        pass(`${name}-stage-after-migration`, 'U02.A02', 'The same migrated profile reopens in the dark stage with its zoom and fonts; legacy bytes retained',
          'legacy-theme-keys-to-stage')
      } catch (error) { await session.app.close(); throw error }
      currentStep = `${name}-schema7-import-save-reopen`
      await currentProjectState(name, roots, session, source)
    }
    assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256, 'driver changed during run')
    const required = ['v1', 'v2'].flatMap(name => [`${name}-schema7-import`, `${name}-schema7-save`, `${name}-schema7-reopen`])
    assert(required.every(id => steps.some(step => step.stepId === id && step.outcome === 'PASS')))
    assert(['fresh-default-stage', 'galaxy-stage-after-migration', 'paper-stage-after-migration', 'v1-stage-after-migration', 'v2-stage-after-migration']
      .every(id => steps.some(step => step.stepId === id && step.outcome === 'PASS')))
    receipt.persistedModelCalls = 0
    receipt.outcome = 'PARTIAL'
    receipt.sliceOutcome = 'PASS'
    receipt.verifiedActions = ['U02.A02', 'U02.A07']
    receipt.unverifiedActions = ['Full F05 is not qualified by this isolated migration journey']
  } catch (error) {
    receipt.failedStep = currentStep
    receipt.error = String(error)
    throw error
  } finally {
    const evidenceFile = path.join(root, 'receipt.json')
    fs.writeFileSync(evidenceFile, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, sliceOutcome: receipt.sliceOutcome ?? 'FAIL',
      testedSha, driverSha256, receipt: path.relative(repository, evidenceFile), failedStep: receipt.failedStep })}\n`)
  }
}

if (process.argv.includes('--help')) process.stdout.write('Pass --package-dir, --package-source-sha, --exe-sha256 and --asar-sha256 for the fixed package: fresh, pre-RD-10 galaxy/paper and legacy v1/v2 appearance migrations, then schema0-to-schema7 import in the stage.\n')
else main().catch(error => { console.error(error); process.exitCode = 1 })
