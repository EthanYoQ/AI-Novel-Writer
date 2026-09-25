/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const currentMode = process.argv.includes('--a07-current')
const buildTree = currentMode ? arg('build-tree') : null
const packageDir = currentMode ? (arg('package-dir') ?? '') : path.join(repository, '.runtime', '.cache', 'f04-v3-build', 's13-core-1')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const packageSourceSha = currentMode ? arg('tested-sha') : '7110f53d5ce173d70bc0dcef90209bccb38d9fff'
const expectedExeSha = currentMode ? arg('exe-sha256') : 'c3864b55649358e6acae5e828861dc231521f75e5bfa0422212d86b3349f6669'
const expectedAsarSha = currentMode ? arg('asar-sha256') : 'bf2f5c95ae8b72e377710759bfdb392cd0344f9e4c2d67fb0ef0ecbfb7b37b66'
const priorReceiptPath = path.join(repository, '.runtime', '.cache', 'f05-u02-migration',
  currentMode ? 'cca73e9a-b803-4ac6-9328-2148d29be65c' : '14988078-c897-452a-92da-7bbf6e14e367', 'receipt.json')
const Database = createRequire(import.meta.url)('better-sqlite3')
const runId = randomUUID()
const root = path.join(repository, '.runtime', '.cache', 'f05-u02-migration', runId)
assert(process.env.LOCALAPPDATA, 'F05 U02 needs LOCALAPPDATA for short isolated SQLite paths')
const scratchRoot = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel', `u02-${runId.slice(0, 8)}`)
const projectParent = path.join(scratchRoot, 'projects')
const appearanceKey = 'ai-novel-writer-appearance'
const themeKey = 'ai-novel-writer-theme'
const shellKey = 'ai-novel-writer-ui-version'
const themeRaw = JSON.stringify({ state: { theme: 'dark', zoom: 1.2, writingFont: 'noto-serif-sc', uiFont: 'inter', fontDefaultsVersion: 0 }, version: 0 })
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const testedSha = packageSourceSha
const driverSha256 = sha256(fileURLToPath(import.meta.url))
const initialBody = `迁移前正文 ${runId}`
const savedBody = `${initialBody} 迁移后补写`
const steps = []
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
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    return { app, page }
  } catch (error) { await app.close(); throw error }
}

async function stored(page) {
  return page.evaluate(({ appearanceKey, themeKey, shellKey }) => ({
    appearance: JSON.parse(localStorage.getItem(appearanceKey)),
    theme: localStorage.getItem(themeKey), shell: localStorage.getItem(shellKey),
  }), { appearanceKey, themeKey, shellKey })
}

async function writer(page) {
  await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await page.locator('.app-skin-root').getAttribute('data-skin'), 'anime')
}
const editorBody = locator => locator.evaluate(element => Array.from(element.querySelectorAll('.cm-line'), line => {
  const copy = line.cloneNode(true)
  copy.querySelector('.cm-lp-paperhead')?.remove()
  return copy.textContent
}).join('\n'))
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

async function migrate(name, legacyShell, expectedPreference, prepare) {
  const roots = profile(name)
  let projectPath
  let session = await launch(roots)
  try {
    if (name === 'v1' && !currentMode) {
      const result = await session.page.evaluate(({ projectParent, requestToken }) => window.aiNovelAPI.invoke('project:create',
        { path: projectParent, name: '迁移前作品', genre: '合成测试', targetAudience: '合成读者', writingLanguage: 'zh-CN' },
        requestToken), { projectParent, requestToken: randomUUID() })
      assert.equal(result.success, true, result.error)
      projectPath = result.projectPath
      assert(fs.existsSync(path.join(projectPath, '.ai-novel', 'project.json')))
      const opened = await session.page.evaluate(({ projectPath, requestToken }) => window.aiNovelAPI.invoke('project:open',
        projectPath, requestToken, null), { projectPath, requestToken: randomUUID() })
      assert.equal(opened.success, true, opened.error)
      const context = { projectId: result.projectId, projectPath, leaseId: opened.project.sessionLease }
      const draft = await session.page.evaluate(({ projectPath, context, initialBody }) => window.aiNovelAPI.invoke('db:draft-create',
        { chapterNumber: 1, version: 1, source: 'write', content: initialBody, wordCount: initialBody.length }, projectPath, context),
      { projectPath, context, initialBody })
      assert.equal(draft.success, true, draft.error)
      assert.equal(dbBody(projectPath), initialBody)
    }
    const skin = await session.page.evaluate(() => window.aiNovelAPI.invoke('skin:execute', { type: 'activate', skinId: 'anime' }))
    assert.equal(skin.success, true)
    await session.page.evaluate(({ appearanceKey, themeKey, shellKey, themeRaw, legacyShell }) => {
      localStorage.removeItem(appearanceKey)
      localStorage.setItem(themeKey, themeRaw)
      localStorage.setItem(shellKey, legacyShell)
    }, { appearanceKey, themeKey, shellKey, themeRaw, legacyShell })
    assert.equal((await stored(session.page)).appearance, null)
  } finally { await session.app.close() }

  if (prepare) prepare(roots)

  session = await launch(roots)
  try {
    const state = await stored(session.page)
    assert.equal(state.theme, themeRaw, 'legacy theme bytes were changed')
    assert.equal(state.shell, legacyShell, 'legacy shell bytes were changed')
    assert.deepEqual({ shellPreference: state.appearance.shellPreference, colorTheme: state.appearance.colorTheme,
      zoom: state.appearance.zoom, writingFont: state.appearance.writingFont, uiFont: state.appearance.uiFont,
      origin: state.appearance.origin }, { shellPreference: expectedPreference, colorTheme: 'dark',
      zoom: 1.2, writingFont: 'noto-serif-sc', uiFont: 'inter', origin: 'legacy-import' })
    assert.equal(await session.page.locator('.app-skin-root').getAttribute('data-skin'), 'anime')
    await writer(session.page)
    steps.push({ stepId: `${name}-legacy-converted`, phase: 'migration-intermediate',
      assertion: `Electron startup converted ${legacyShell} and legacy appearance without changing their bytes or image skin`, outcome: 'PASS' })
  } finally { await session.app.close() }
  session = await launch(roots)
  try {
    await writer(session.page)
    const state = await stored(session.page)
    assert.deepEqual({ shellPreference: state.appearance.shellPreference, colorTheme: state.appearance.colorTheme,
      zoom: state.appearance.zoom, writingFont: state.appearance.writingFont, uiFont: state.appearance.uiFont },
    { shellPreference: 'writer', colorTheme: 'dark', zoom: 1.2, writingFont: 'noto-serif-sc', uiFont: 'inter' })
    assert.equal(state.shell, legacyShell)
    assert.equal(state.theme, themeRaw)
    pass(`${name}-v3-after-migration`, 'U02.A02', 'The same isolated migrated profile reopens in V3 Writer with its appearance, image skin and legacy bytes retained',
      'legacy-shell-preference-to-writer')
    return { roots, session, projectPath }
  } catch (error) { await session.app.close(); throw error }
}

async function projectState(roots, session, projectPath) {
  const projectName = '迁移前作品'
  let page = session.page
  const openProject = async () => {
    await writer(page)
    if (!await page.locator('.writer-shelf').isVisible()) await page.locator('.writer-left-rail button[title="欢迎页"]').click()
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(path.resolve((await page.evaluate(() => window.aiNovelAPI.invoke('project:get-runtime-context'))).activeProjectPath).toLowerCase(),
      path.resolve(projectPath).toLowerCase())
  }
  try {
    assert(fs.existsSync(path.join(projectPath, '.ai-novel', 'project.json')))
    assert.equal(dbBody(projectPath), initialBody)
    await openProject()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    const body = page.locator('.cm-content[contenteditable="true"]')
    await body.waitFor({ state: 'visible' })
    assert.equal(await editorBody(body), initialBody)
    pass('v1-v3-project-imported', 'U02.A07', 'The pre-migration project identity and exact SQLite draft body appear in the migrated V3 editor',
      'legacy-shell-preference-with-project-state-to-writer')
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 迁移后补写')
    assert.equal(await editorBody(body), savedBody)
    await page.locator('[role="status"]').filter({ hasText: /^未保存$/ }).last().waitFor({ state: 'visible' })
    assert.equal(dbBody(projectPath), initialBody, 'V3 draft wrote before Save')
    await page.locator('button[title="保存（⌘S）"]').click()
    await page.locator('[role="status"]').filter({ hasText: /^已保存$/ }).last().waitFor({ state: 'visible' })
    assert.equal(dbBody(projectPath), savedBody)
    pass('v1-v3-project-edited', 'U02.A07', 'V3 draft Save persists exact edited body after legacy preference migration',
      'legacy-shell-preference-with-project-state-to-writer')
    await session.app.close()
    session = await launch(roots)
    page = session.page
    await openProject()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    assert.equal(await editorBody(page.locator('.cm-content[contenteditable="true"]')), savedBody)
    assert.equal(dbBody(projectPath), savedBody)
    assert.equal((await stored(page)).appearance.shellPreference, 'writer')
    pass('v1-v3-project-reopened', 'U02.A07', 'New installed process opens the same project through V3 shelf with exact saved draft and migrated preference',
      'legacy-shell-preference-with-project-state-to-writer')
  } finally { await session.app.close() }
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

async function currentProjectState(name, roots, session, source) {
  const targetParent = path.join(scratchRoot, `t${name.slice(1)}`)
  fs.mkdirSync(targetParent)
  const targetRoot = path.join(targetParent, `${path.basename(source.sourceRoot)}-新版副本`)
  assert(targetRoot.length <= 85, 'synthetic target exceeds current Windows project path contract')
  let page = session.page
  const open = async () => {
    await writer(page)
    if (!await page.locator('.writer-shelf').isVisible()) await page.locator('.writer-left-rail button[title="欢迎页"]').click()
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${source.sourceName}》` }).click()
    await page.locator('.writer-project-tree').getByText(source.sourceName, { exact: true }).waitFor({ state: 'visible' })
    const context = await page.evaluate(() => window.aiNovelAPI.invoke('project:get-runtime-context'))
    assert.equal(path.resolve(context.activeProjectPath).toLowerCase(), path.resolve(targetRoot).toLowerCase())
  }
  try {
    await writer(page)
    if (!await page.locator('.writer-shelf').isVisible()) await page.locator('.writer-left-rail button[title="欢迎页"]').click()
    await session.app.evaluate(({ dialog }, { sourceRoot, targetParent }) => {
      globalThis.__u02Dialogs = []
      dialog.showOpenDialog = async options => {
        globalThis.__u02Dialogs.push(options.title)
        if (options.title === '选择旧版小说项目文件夹') return { canceled: false, filePaths: [sourceRoot] }
        if (options.title === '选择恢复副本所在文件夹') return { canceled: false, filePaths: [targetParent] }
        throw new Error(`Unexpected dialog: ${options.title}`)
      }
      dialog.showMessageBox = async options => {
        globalThis.__u02Dialogs.push(options.message)
        if (!options.message.includes('保存并关闭旧版程序')) throw new Error('Unexpected confirmation')
        return { response: 1, checkboxChecked: false }
      }
    }, { sourceRoot: source.sourceRoot, targetParent })
    await page.getByRole('button', { name: '导入旧项目副本' }).click()
    try {
      await page.locator('.writer-project-tree').getByText(source.sourceName, { exact: true })
        .waitFor({ state: 'visible', timeout: 30_000 })
    } catch (error) {
      const diagnostic = { dialogs: await session.app.evaluate(() => globalThis.__u02Dialogs).catch(error => ({ unavailable: String(error) })),
        notices: await page.locator('[role="status"]').allInnerTexts().catch(error => ({ unavailable: String(error) })),
        welcome: await page.locator('.writer-welcome').innerText().catch(() => null),
        targetExists: fs.existsSync(targetRoot), targetParentEntries: fs.readdirSync(targetParent) }
      throw new Error(`Writer import did not open project: ${JSON.stringify(diagnostic)}`, { cause: error })
    }
    const dialogs = await session.app.evaluate(() => globalThis.__u02Dialogs)
    assert.equal(dialogs.length, 3)
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
    pass(`${name}-schema7-import`, 'U02.A07', 'Writer V3 imported schema0 project into schema7 with exact title, draft body and new copy identity; old source bytes stayed unchanged',
      'legacy-shell-preference-with-project-state-to-writer')
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    let body = page.locator('.cm-content[contenteditable="true"]')
    await body.waitFor({ state: 'visible' })
    assert.equal(await editorBody(body), initialBody)
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 迁移后补写')
    assert.equal(await editorBody(body), savedBody)
    await page.locator('[role="status"]').filter({ hasText: /^未保存$/ }).last().waitFor({ state: 'visible' })
    assert.equal(dbBody(targetRoot), initialBody)
    await page.locator('button[title="保存（⌘S）"]').click()
    await page.locator('[role="status"]').filter({ hasText: /^已保存$/ }).last().waitFor({ state: 'visible' })
    assert.equal(dbBody(targetRoot), savedBody)
    assert.equal(modelCallCount(targetRoot), 0)
    assert.deepEqual(sourceFiles(source.sourceRoot), source.before)
    pass(`${name}-schema7-save`, 'U02.A07', 'Writer V3 saved the exact edited body in the imported schema7 copy without changing the old source',
      'legacy-shell-preference-with-project-state-to-writer')
    await session.app.close()
    session = await launch(roots)
    page = session.page
    await open()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    body = page.locator('.cm-content[contenteditable="true"]')
    assert.equal(await editorBody(body), savedBody)
    assert.equal(dbBody(targetRoot), savedBody)
    assert.equal(modelCallCount(targetRoot), 0)
    assert.deepEqual(sourceFiles(source.sourceRoot), source.before)
    pass(`${name}-schema7-reopen`, 'U02.A07', 'New Writer V3 process reopened the same copy identity and exact saved body; old source bytes stayed unchanged',
      'legacy-shell-preference-with-project-state-to-writer')
  } finally { await session.app.close() }
}

async function currentMain() {
  assert(buildTree && path.isAbsolute(buildTree) && path.isAbsolute(packageDir)
    && /^[a-f0-9]{40}$/.test(testedSha ?? '') && /^[a-f0-9]{64}$/.test(expectedExeSha ?? '')
    && /^[a-f0-9]{64}$/.test(expectedAsarSha ?? ''), 'Specify --build-tree, --package-dir, --tested-sha and fixed exe/asar SHA256')
  const buildGit = (...args) => execFileSync('git', args, { cwd: buildTree, encoding: 'utf8' }).trim()
  assert.equal(buildGit('rev-parse', 'HEAD'), testedSha)
  assert.equal(buildGit('status', '--porcelain'), '', 'fixed package build tree must be clean')
  assert.equal(path.resolve(packageDir), path.join(path.resolve(buildTree), 'release', '1.1.0', 'win-unpacked'))
  assert.equal(sha256(executablePath), expectedExeSha)
  assert.equal(sha256(asarPath), expectedAsarSha)
  const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
  assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productInputs), '', 'product inputs changed since fixed package')
  const dirtyProductPaths = git('status', '--porcelain', '--', ...productInputs).split('\n').filter(Boolean)
  assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:characters|dialogs|editor|layout\/v2|pages|pages\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)),
    'product inputs dirty beyond test screenshots')
  const prior = JSON.parse(fs.readFileSync(priorReceiptPath, 'utf8'))
  assert.equal(prior.outcome, 'PARTIAL')
  assert.equal(prior.testedSha, '7110f53d5ce173d70bc0dcef90209bccb38d9fff')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(scratchRoot, { recursive: true })
  fs.writeFileSync(path.join(scratchRoot, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u02-a07',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${scratchRoot}' -Recurse -Force`,
    retainReason: 'Synthetic schema0-to-schema7 Writer import evidence' }, null, 2))
  const receipt = { outcome: 'FAIL', qualification: 'F05_U02_DEFAULT_A02_A07_CURRENT', evidenceLevel: 'electron',
    shell: 'writer-v3', testedSha, buildTree: path.resolve(buildTree), executionHead: git('rev-parse', 'HEAD'),
    driverSha256, artifactHashes: { executable: expectedExeSha, asar: expectedAsarSha }, packageRoot: packageDir,
    historicalReceipt: { path: priorReceiptPath, sha256: sha256(priorReceiptPath), testedSha: prior.testedSha },
    dirtyProductPaths, sourceDirtyPaths: git('status', '--porcelain').split('\n').filter(Boolean),
    persistedModelCalls: null, physicalModelRequestsObservation: 'NOT_OBSERVED_BY_THIS_JOURNEY',
    releaseDefaultQualified: false, steps }
  try {
    currentStep = 'fresh-default-and-canonical-classic'
    const freshRoots = profile('fresh-default')
    let fresh = await launch(freshRoots)
    try {
      await fresh.page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
      const state = await stored(fresh.page)
      assert.equal(state.appearance.shellPreference, 'unset')
      assert.equal(state.theme, null)
      assert.equal(state.shell, null)
      pass('fresh-unset-v3-default', 'U02.A02', 'A fresh installed profile opens Writer V3 with an unset preference',
        'fresh-unset-to-writer-v3')
      const skin = await fresh.page.evaluate(() => window.aiNovelAPI.invoke('skin:execute', { type: 'activate', skinId: 'anime' }))
      assert.equal(skin.success, true)
      await fresh.page.evaluate(key => {
        const previous = JSON.parse(localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify({ ...previous, shellPreference: 'classic', colorTheme: 'dark',
          zoom: 1.2, writingFont: 'noto-serif-sc', uiFont: 'inter', revision: previous.revision + 1, origin: 'author' }))
      }, appearanceKey)
    } finally { await fresh.app.close() }
    fresh = await launch(freshRoots)
    try {
      await writer(fresh.page)
      const state = await stored(fresh.page)
      assert.deepEqual({ shellPreference: state.appearance.shellPreference, colorTheme: state.appearance.colorTheme,
        zoom: state.appearance.zoom, writingFont: state.appearance.writingFont, uiFont: state.appearance.uiFont,
        origin: state.appearance.origin, revision: state.appearance.revision },
      { shellPreference: 'writer', colorTheme: 'dark', zoom: 1.2, writingFont: 'noto-serif-sc',
        uiFont: 'inter', origin: 'author', revision: 3 })
      assert.equal(state.theme, null)
      assert.equal(state.shell, null)
      pass('canonical-classic-v3-migrated', 'U02.A02', 'An existing Classic profile opens Writer V3 with authored appearance and skin retained',
        'canonical-classic-to-writer-v3')
    } finally { await fresh.app.close() }
    for (const name of ['v1', 'v2']) {
      const targetParent = path.join(scratchRoot, `t${name.slice(1)}`)
      assert(!fs.existsSync(targetParent), 'synthetic target parent collides with an existing profile')
    }
    for (const [name, legacyShell, preference] of [
      ['v1', 'v1', 'writer'], ['v2', JSON.stringify({ state: { uiVersion: 'v2' }, version: 0 }), 'writer'],
    ]) {
      currentStep = `${name}-schema0-setup`
      let source
      const migrated = await migrate(name, legacyShell, preference, () => { source = prepareLegacyProject(name) })
      currentStep = `${name}-schema7-import-save-reopen`
      await currentProjectState(name, migrated.roots, migrated.session, source)
    }
    assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256, 'driver changed during run')
    const required = ['v1', 'v2'].flatMap(name => [`${name}-schema7-import`, `${name}-schema7-save`, `${name}-schema7-reopen`])
    assert(required.every(id => steps.some(step => step.stepId === id && step.outcome === 'PASS')))
    assert(['fresh-unset-v3-default', 'canonical-classic-v3-migrated', 'v1-legacy-converted', 'v2-legacy-converted']
      .every(id => steps.some(step => step.stepId === id && step.outcome === 'PASS')))
    receipt.persistedModelCalls = 0
    receipt.outcome = 'PARTIAL'
    receipt.sliceOutcome = 'PASS'
    receipt.releaseDefaultQualified = true
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

async function main() {
  assert.equal(path.isAbsolute(packageDir), true)
  assert.equal(sha256(executablePath), expectedExeSha)
  assert.equal(sha256(asarPath), expectedAsarSha)
  assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '',
  'product source changed since fixed package build')
  assert.equal(git('diff', '--name-only', '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '',
  'tracked product source is dirty beyond the fixed package')
  const prior = JSON.parse(fs.readFileSync(priorReceiptPath, 'utf8'))
  assert.equal(prior.outcome, 'PASS')
  const expectedRoot = path.join(repository, '.runtime', '.cache', 'f05-u02-migration')
  assert.equal(path.dirname(root), expectedRoot)
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(scratchRoot, { recursive: true })
  fs.mkdirSync(projectParent, { recursive: true })
  fs.writeFileSync(path.join(scratchRoot, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u02',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${scratchRoot}' -Recurse -Force`,
    retainReason: 'Synthetic migrated Writer project for receipt inspection' }, null, 2))
  const evidenceFile = path.join(root, 'receipt.json')
  const artifactHashes = { executable: sha256(executablePath), asar: sha256(asarPath) }
  try {
    currentStep = 'v1-migration'
    const v1 = await migrate('v1', 'v1', 'writer')
    currentStep = 'v1-project-state'
    await projectState(v1.roots, v1.session, v1.projectPath)
    currentStep = 'v2-migration'
    const v2 = await migrate('v2', JSON.stringify({ state: { uiVersion: 'v2' }, version: 0 }), 'writer')
    await v2.session.app.close()
    assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256, 'driver changed during run')
    const required = {
      'U02.A02': ['v1-v3-after-migration', 'v2-v3-after-migration'],
      'U02.A07': ['v1-v3-project-imported', 'v1-v3-project-edited', 'v1-v3-project-reopened'],
    }
    const verifiedActions = Object.entries(required).filter(([, ids]) => ids.every(id => steps.some(step => step.stepId === id && step.outcome === 'PASS')))
      .map(([actionId]) => actionId)
    assert.deepEqual(verifiedActions, ['U02.A02', 'U02.A07'])
    const receipt = { outcome: 'PARTIAL', qualification: 'F05_U02_V3_A02_A07_ONLY', evidenceLevel: 'electron', shell: 'writer-v3',
      testedSha, executionHead: git('rev-parse', 'HEAD'), driverSha256, artifactHashes, packageRoot: packageDir,
      priorReceipt: { path: priorReceiptPath, sha256: sha256(priorReceiptPath), testedSha: prior.testedSha,
        reuseReason: 'historical Writer migration evidence is retained, but V3 presentation and project-body save are verified in this run' },
      sourceDirtyPaths: execFileSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
      releaseDefaultQualified: false, physicalModelRequests: 0, steps, verifiedActions,
      unverifiedActions: ['Full F05 and release-default activation are not qualified by this isolated migration journey'] }
    fs.writeFileSync(evidenceFile, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, testedSha, driverSha256,
      receipt: path.relative(repository, evidenceFile), steps: steps.map(s => s.stepId) })}\n`)
  } catch (error) {
    fs.writeFileSync(evidenceFile, JSON.stringify({ outcome: 'FAIL', testedSha, driverSha256, artifactHashes,
      packageRoot: packageDir, priorReceipt: { path: priorReceiptPath, sha256: sha256(priorReceiptPath) },
      failedStep: currentStep, steps, error: String(error) }, null, 2))
    throw error
  }
}

if (process.argv.includes('--help')) process.stdout.write('Runs isolated v1/v2 preference migration. Use --a07-current with --build-tree, --package-dir, --tested-sha, --exe-sha256 and --asar-sha256 for synthetic schema0-to-schema7 Writer import.\n')
else (currentMode ? currentMain() : main()).catch(error => { console.error(error); process.exitCode = 1 })
