/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = argument('package-dir')
const packageSourceSha = argument('package-source-sha')
const expectedExe = argument('exe-sha256')
const expectedAsar = argument('asar-sha256')
assert(packageDir && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const previousU14Path = path.join(repository, '.runtime', '.cache', 'f05-u14-save-feedback', '9e6e279e-9d5a-4683-bdcf-e7bc4b72152b', 'receipt.json')
const previousU14 = JSON.parse(fs.readFileSync(previousU14Path, 'utf8'))
for (const actionId of ['U14.A06', 'U14.A07']) {
  assert(previousU14.steps?.some(step => step.actionId === actionId && step.outcome === 'PASS'), `previous ${actionId} PASS receipt missing`)
}
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
assert.equal(git('rev-parse', packageSourceSha), packageSourceSha, 'package source SHA is unavailable')
const previousBuildChangedPaths = git('diff', '--name-only', `${previousU14.testedSha}..${packageSourceSha}`).split('\n').filter(Boolean)
const previousProductChangedPaths = previousBuildChangedPaths.filter(name => /^(?:src|electron)\//.test(name) && !name.includes('/__tests__/'))
const previousDraftSaveOwnerChanges = previousBuildChangedPaths.filter(name => [
  'src/components/editor/DraftEditor.tsx', 'src/components/editor/CodeMirrorEditor.tsx',
  'src/components/editor/save-feedback.tsx', 'src/stores/editor-store.ts',
  'electron/controllers/db-controller.ts', 'electron/repositories/draft-repository.ts',
  'electron/repositories/content-repository.ts',
].includes(name))
assert.deepEqual(previousDraftSaveOwnerChanges, [], 'prior shortcut/button-save owner changed since its PASS receipt')
const changedPaths = git('diff', '--name-only', `${packageSourceSha}..HEAD`).split('\n').filter(Boolean)
assert.equal(git('diff', '--name-only', `${packageSourceSha}..HEAD`, '--', 'src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '',
  'product input changed since package build')
const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)), 'product source dirty beyond test screenshots')
assert.equal(fileHash(executablePath), expectedExe)
assert.equal(fileHash(asarPath), expectedAsar)

const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u14-save-feedback', runId)
const scratch = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository), 'VibeCodingScratch', 'an', 'u14', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const projectName = 'U14'
const configMarker = `U14 配置 ${runId}`
const blueprintMarker = `U14 蓝图 ${runId}`
const bodyMarker = `U14 正文 ${runId}`
const shortcutMarker = ` 快捷键 ${runId}`
const archMarker = `U14 世界观 ${runId}`
const characterMarker = `U14 角色 ${runId}`
const steps = []
const pass = (stepId, actionId, assertion, observed) => steps.push({ stepId, actionId, outcome: 'PASS', assertion, observed })
async function invoke(page, channel, ...args) {
  let timer
  try {
    return await Promise.race([
      page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`IPC timeout: ${channel}`)), 20_000) }),
    ])
  } finally { clearTimeout(timer) }
}
const writer = page => page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]')
async function assertWriter(page, actionId) {
  await writer(page).waitFor({ state: 'visible' })
  assert.equal(await writer(page).getAttribute('data-shell-variant'), 'v3', `${actionId}: shell is not V3`)
}
async function openProject(page) {
  await assertWriter(page, 'project-open')
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
  await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
}
async function launch(env) {
  const app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(12_000)
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
  return { app, page }
}
async function setWriterAndReload(page) {
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const previous = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...previous, shellPreference: 'writer', revision: Number(previous.revision ?? 0) + 1, origin: 'author' }))
  })
  await page.reload()
  await assertWriter(page, 'explicit-writer-selection')
}
async function visibleStatus(page, label) {
  await page.locator(label === '保存失败' ? '[role="alert"]' : '[role="status"]')
    .filter({ hasText: new RegExp(`^${label}$`) }).last().waitFor({ state: 'visible' })
}
const editorBody = locator => locator.evaluate(element => Array.from(element.querySelectorAll('.cm-line'), line => {
  const copy = line.cloneNode(true)
  copy.querySelector('.cm-lp-paperhead')?.remove()
  return copy.textContent
}).join('\n'))
function projectDatabase(projectPath) {
  const databasePath = path.join(projectPath, '.ai-novel', 'project.db')
  assert.equal(path.relative(scratch, databasePath).startsWith('..'), false, 'fault injection must stay in isolated profile')
  assert(fs.statSync(databasePath).isFile())
  const Database = createRequire(import.meta.url)('better-sqlite3')
  return new Database(databasePath, { fileMustExist: true })
}
async function withFailedSave(db, table, action, operation = 'UPDATE') {
  assert(['project_core', 'blueprints', 'contents', 'characters'].includes(table))
  assert(['UPDATE', 'INSERT'].includes(operation))
  const trigger = `u14_fail_${table}`
  db.exec(`CREATE TRIGGER ${trigger} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'U14_INJECTED_SAVE_FAILURE'); END`)
  try { await action() }
  finally { db.exec(`DROP TRIGGER IF EXISTS ${trigger}`) }
}
async function waitForCommittedSave(app) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await app.evaluate(() => globalThis.__f05U14SaveGate?.committed === true)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('U14.A09: draft commit did not reach the held response')
}
async function quit(app) {
  const pid = app.process().pid
  let timer
  const closed = await Promise.race([app.close().then(() => true).catch(() => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 10_000) })])
  clearTimeout(timer)
  if (!closed) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U14 save feedback', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'review packaged Writer U14 action receipt',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app
  let page
  let failure
  let diagnostic = null
  let currentStep = 'setup'
  let project
  let draftId
  let db
  const mark = value => { currentStep = value; process.stderr.write(`${value}\n`) }
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
    AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
    APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  try {
    currentStep = 'packaged-native-load'
    const native = verifyWindowsPackage(packageDir)
    assert(native.nativeBinding && native.betterSqliteBinding)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    pass('packaged-native-load', null, 'verified package hashes and native bindings')
    mark('fixture-launch')
    ;({ app } = await launch(env))
    page = await app.firstWindow()
    mark('fixture-project-create')
    project = await invoke(page, 'project:create', { path: profile.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(project.success, true, project.error)
    mark('fixture-project-open')
    const opened = await invoke(page, 'project:open', project.projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: project.projectId, projectPath: project.projectPath, leaseId: opened.project.sessionLease }
    mark('fixture-blueprint-seed')
    const seededBlueprint = await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '初始蓝图', role: '发展',
      purpose: '前往车站', keyEvents: '发现线索', characters: [] }, project.projectPath, context)
    assert.equal(seededBlueprint.success, true, seededBlueprint.error)
    mark('fixture-draft-seed')
    const seededDraft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
      content: '列车抵达旧车站。', wordCount: 8 }, project.projectPath, context)
    assert.equal(seededDraft.success, true, seededDraft.error)
    draftId = seededDraft.id ?? seededDraft.draft?.id
    assert(Number.isInteger(draftId), `draft id absent: ${JSON.stringify(seededDraft)}`)
    mark('explicit-writer-selection')
    await setWriterAndReload(page)
    mark('writer-project-open')
    await openProject(page)
    pass('v3-project-entry', null, 'explicitly selected V3 and opened isolated project', { projectPath: project.projectPath })
    db = projectDatabase(project.projectPath)

    mark('U14.A04-config-button-save')
    await assertWriter(page, 'U14.A04')
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
    const config = page.getByPlaceholder('在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置...')
    await config.fill(configMarker)
    await visibleStatus(page, '未保存')
    const configSave = page.getByRole('heading', { name: '小说配置' }).locator('xpath=../..').getByRole('button', { name: '保存', exact: true })
    const oldConfig = db.prepare('SELECT core_outline FROM project_core WHERE id = ?').get('main').core_outline
    await withFailedSave(db, 'project_core', async () => {
      await assertWriter(page, 'U14.A04-failure')
      await configSave.click()
      await visibleStatus(page, '保存失败')
      assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'configuration falsely marked clean after failed save')
      assert.equal(db.prepare('SELECT core_outline FROM project_core WHERE id = ?').get('main').core_outline, oldConfig)
      pass('U14.A04-failure', 'U14.A04', 'repository UPDATE aborted; Writer shows failure and dirty; original configuration is retained')
    })
    await assertWriter(page, 'U14.A04-retry')
    await configSave.click()
    await visibleStatus(page, '已保存')
    assert.equal(db.prepare('SELECT core_outline FROM project_core WHERE id = ?').get('main').core_outline, configMarker)
    pass('U14.A04-retry', 'U14.A04', 'Writer retry changed dirty to saved and repository contains the new configuration', { marker: configMarker })

    mark('U14.A03-blueprint-button-save')
    await assertWriter(page, 'U14.A03')
    await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    const blueprint = page.getByPlaceholder('引人入胜的章节标题')
    await blueprint.fill(blueprintMarker)
    await visibleStatus(page, '未保存')
    const blueprintSave = page.getByRole('button', { name: '保存', exact: true }).last()
    const oldBlueprint = db.prepare('SELECT title FROM blueprints WHERE chapter_number = 1').get().title
    await withFailedSave(db, 'blueprints', async () => {
      await assertWriter(page, 'U14.A03-failure')
      await blueprintSave.click()
      await visibleStatus(page, '保存失败')
      assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'blueprint falsely marked clean after failed save')
      assert.equal(db.prepare('SELECT title FROM blueprints WHERE chapter_number = 1').get().title, oldBlueprint)
      pass('U14.A03-failure', 'U14.A03', 'repository UPSERT update aborted; Writer shows failure and dirty; original blueprint is retained')
    })
    await assertWriter(page, 'U14.A03-retry')
    await blueprintSave.click()
    await visibleStatus(page, '已保存')
    assert.equal(db.prepare('SELECT title FROM blueprints WHERE chapter_number = 1').get().title, blueprintMarker)
    pass('U14.A03-retry', 'U14.A03', 'Writer retry changed dirty to saved and repository contains the new blueprint', { marker: blueprintMarker })

    mark('U14.A02-architecture-save')
    await assertWriter(page, 'U14.A02')
    await page.locator('.writer-project-tree').getByText('世界观', { exact: true }).click()
    const arch = page.locator('.cm-content[contenteditable="true"]')
    await arch.waitFor({ state: 'visible' })
    await arch.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(archMarker)
    await visibleStatus(page, '未保存')
    const archSave = page.getByRole('button', { name: '保存', exact: true }).last()
    const oldArch = db.prepare('SELECT worldbuilding FROM project_core WHERE id = ?').get('main').worldbuilding
    await withFailedSave(db, 'project_core', async () => {
      await assertWriter(page, 'U14.A02-failure')
      await archSave.click()
      await visibleStatus(page, '保存失败')
      assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'architecture falsely marked clean after failed save')
      assert.equal(db.prepare('SELECT worldbuilding FROM project_core WHERE id = ?').get('main').worldbuilding, oldArch)
      pass('U14.A02-failure', 'U14.A02', 'repository UPDATE aborted; Writer shows failure and dirty; original architecture is retained')
    })
    await assertWriter(page, 'U14.A02-retry')
    await archSave.click()
    await visibleStatus(page, '已保存')
    assert.equal(db.prepare('SELECT worldbuilding FROM project_core WHERE id = ?').get('main').worldbuilding, archMarker)
    pass('U14.A02-retry', 'U14.A02', 'Writer retry saved the architecture through its project session', { marker: archMarker })

    mark('U14.A01-body-button-save')
    await assertWriter(page, 'U14.A01')
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    const body = page.locator('.cm-content[contenteditable="true"]')
    await body.waitFor({ state: 'visible' })
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(bodyMarker)
    await visibleStatus(page, '未保存')
    const bodySave = page.locator('button[title="保存（⌘S）"]')
    const storedBody = () => db.prepare('SELECT contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id WHERE drafts.id = ?').get(draftId).body
    const oldBody = storedBody()
    await withFailedSave(db, 'contents', async () => {
      await assertWriter(page, 'U14.A01-failure')
      await bodySave.click()
      await visibleStatus(page, '保存失败')
      assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'draft falsely marked clean after failed save')
      assert.equal(storedBody(), oldBody)
      pass('U14.A01-failure', 'U14.A01', 'first repository body UPDATE aborted; Writer shows failure and dirty; original body is retained')
    })
    await assertWriter(page, 'U14.A01-retry')
    await bodySave.click()
    await visibleStatus(page, '已保存')
    assert(storedBody().includes(bodyMarker))
    pass('U14.A01-retry', 'U14.A01', 'Writer retry changed dirty to saved and repository contains the new body', { marker: bodyMarker })

    mark('U14.A09-concurrent-edit')
    await assertWriter(page, 'U14.A09')
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 并发一')
    await visibleStatus(page, '未保存')
    db.exec('BEGIN IMMEDIATE')
    try {
      await assertWriter(page, 'U14.A09-lock-failure')
      await bodySave.click()
      await visibleStatus(page, '保存失败')
      assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'lock failure falsely marked the draft clean')
      assert(!storedBody().includes('并发一'), 'failed locked save changed the durable draft')
      await body.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(' 并发二')
    } finally { db.exec('COMMIT') }
    await visibleStatus(page, '未保存')
    pass('U14.A09-lock-failure', 'U14.A09', 'concurrent SQLite writer made save fail visibly; later local input remains dirty')
    await assertWriter(page, 'U14.A09-retry')
    await bodySave.click()
    await visibleStatus(page, '已保存')
    assert(storedBody().includes('并发一'))
    assert(storedBody().includes('并发二'))
    pass('U14.A09-retry', 'U14.A09', 'subsequent Writer save persisted both edits after the lock was released', { suffix: ' 并发一 并发二' })

    await app.evaluate(({ ipcMain }) => {
      const channel = 'db:draft-update-content'
      const original = ipcMain._invokeHandlers.get(channel)
      if (!original) throw new Error('draft save IPC handler missing')
      const gate = { committed: false, release: null }
      globalThis.__f05U14SaveGate = gate
      globalThis.__f05U14OriginalDraftHandler = original
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        const result = await original(event, ...args)
        if (result?.success) {
          gate.committed = true
          await new Promise(resolve => { gate.release = resolve })
        }
        return result
      })
    })
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 并发三')
    await bodySave.waitFor({ state: 'visible' })
    await visibleStatus(page, '未保存')
    await assertWriter(page, 'U14.A09-inflight-success')
    await bodySave.click()
    await waitForCommittedSave(app)
    assert(storedBody().includes('并发三'), 'held save did not persist its first snapshot')
    assert(!storedBody().includes('并发四'), 'later input existed before it was typed')
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 并发四')
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.__f05U14SaveGate
      if (!gate?.release || !ipcMain._invokeHandlers.has('db:draft-update-content')) throw new Error('held draft response missing')
      gate.release()
    })
    await bodySave.waitFor({ state: 'visible' })
    await visibleStatus(page, '未保存')
    assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'earlier save response falsely cleared later input')
    assert(!storedBody().includes('并发四'), 'earlier save included later input')
    pass('U14.A09-inflight-success', 'U14.A09', 'successful repository commit had its IPC response held; a later edit stayed dirty after the first response returned')
    await app.evaluate(({ ipcMain }) => {
      const channel = 'db:draft-update-content'
      const original = globalThis.__f05U14OriginalDraftHandler
      if (!original) throw new Error('original draft save handler missing')
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, original)
      delete globalThis.__f05U14SaveGate
      delete globalThis.__f05U14OriginalDraftHandler
    })
    await assertWriter(page, 'U14.A09-second-save')
    await bodySave.click()
    await visibleStatus(page, '已保存')
    assert(storedBody().includes('并发三') && storedBody().includes('并发四'))
    pass('U14.A09-second-save', 'U14.A09', 'second Writer save persisted the later edit without losing the committed snapshot')

    mark('U14.A06-shortcut-save')
    await assertWriter(page, 'U14.A06')
    const beforeShortcut = storedBody()
    assert(!beforeShortcut.includes(shortcutMarker))
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(shortcutMarker)
    const shortcutSavedBody = `${beforeShortcut}${shortcutMarker}`
    assert.equal(await editorBody(body), shortcutSavedBody, 'shortcut test input did not reach the focused editor')
    assert(await body.evaluate(element => element === document.activeElement), 'shortcut target is not the focused editor')
    await visibleStatus(page, '未保存')
    assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'shortcut input did not mark the draft dirty')
    assert.equal(storedBody(), beforeShortcut, 'shortcut input saved before the key command')
    await page.keyboard.press('Control+s')
    await visibleStatus(page, '已保存')
    assert.equal(storedBody(), shortcutSavedBody, 'Ctrl+S did not persist the exact draft body')
    assert(!(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible()), 'Ctrl+S left the draft dirty')
    pass('U14.A06-shortcut-save', 'U14.A06', 'focused V3 draft Ctrl+S changed dirty to saved and persisted the exact body without clicking Save', { marker: shortcutMarker })

    mark('U14.A05-character-save')
    await assertWriter(page, 'U14.A05')
    await page.locator('.writer-left-rail button[title="角色"]').click()
    await page.getByTitle('新建角色').click()
    const characterName = page.getByText('姓名', { exact: true }).locator('xpath=..').locator('input')
    await characterName.fill(characterMarker)
    await visibleStatus(page, '未保存')
    const characterSave = page.getByRole('button', { name: '保存', exact: true }).last()
    const oldCharacterCount = db.prepare('SELECT count(*) AS n FROM characters').get().n
    await withFailedSave(db, 'characters', async () => {
      await assertWriter(page, 'U14.A05-failure')
      await characterSave.click()
      await visibleStatus(page, '保存失败')
      assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'character falsely marked clean after failed save')
      assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, oldCharacterCount)
      pass('U14.A05-failure', 'U14.A05', 'roster transaction INSERT aborted; Writer shows failure and dirty; no character was committed')
    }, 'INSERT')
    await assertWriter(page, 'U14.A05-retry')
    await characterSave.click()
    await visibleStatus(page, '已保存')
    assert.equal(db.prepare('SELECT name FROM characters WHERE name = ? AND retired = 0').get(characterMarker)?.name, characterMarker)
    pass('U14.A05-retry', 'U14.A05', 'Writer roster retry saved the character through the existing commit transaction', { marker: characterMarker })

    mark('U14.A08-exit-save')
    await assertWriter(page, 'U14.A08')
    await page.locator('.writer-left-rail button[title="项目"]').click()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    const exitBody = page.locator('.cm-content[contenteditable="true"]')
    await exitBody.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 退出保存')
    await visibleStatus(page, '未保存')
    await withFailedSave(db, 'contents', async () => {
      await assertWriter(page, 'U14.A08-failure')
      await page.locator('.writer-topbar button[title="关闭"]').click()
      const exitDialog = page.getByRole('dialog', { name: '退出前处理未保存内容' })
      await exitDialog.getByRole('button', { name: '保存并退出' }).click()
      await exitDialog.getByText(/U14_INJECTED_SAVE_FAILURE/).waitFor({ state: 'visible' })
      assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'failed exit save falsely marked clean')
      assert(!storedBody().includes('退出保存'), 'failed exit save changed the durable draft body')
      pass('U14.A08-failure', 'U14.A08', 'exit dialog remains open with failure; Writer stays dirty and durable body is unchanged')
    })
    await assertWriter(page, 'U14.A08-retry')
    const closed = page.waitForEvent('close', { timeout: 20_000 })
    const appClosed = app.waitForEvent('close', { timeout: 20_000 })
    await page.getByRole('dialog', { name: '退出前处理未保存内容' }).getByRole('button', { name: '保存并退出' }).click()
    await closed
    await appClosed
    assert.equal(storedBody(), `${shortcutSavedBody} 退出保存`, 'exit save did not persist the exact draft')
    pass('U14.A08-retry', 'U14.A08', 'Writer exit-save closed the real window only after durable draft save')
    db.close(); db = null
    app = null

    mark('reopen-persisted-results')
    ;({ app, page } = await launch(env))
    await assertWriter(page, 'reopen-persisted-results')
    await openProject(page)
    const charactersRail = page.locator('.writer-left-rail button[title="角色"]')
    await charactersRail.click()
    await page.locator('button[title="新建角色"]:not([disabled])').waitFor({ state: 'visible' })
    await page.locator('[data-character-id]').filter({ hasText: characterMarker }).first().click()
    assert.equal(await page.getByText('姓名', { exact: true }).locator('xpath=..').locator('input').inputValue(), characterMarker)
    await page.locator('.writer-left-rail button[title="项目"]').click()
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
    assert.equal(await page.getByPlaceholder('在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置...').inputValue(), configMarker)
    await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    assert.equal(await page.getByPlaceholder('引人入胜的章节标题').inputValue(), blueprintMarker)
    await page.locator('.writer-project-tree').getByText('世界观', { exact: true }).click()
    assert((await page.locator('.cm-content[contenteditable="true"]').innerText()).includes(archMarker))
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    const reopenedDraft = page.locator('.cm-content[contenteditable="true"]')
    assert.equal(await editorBody(reopenedDraft), `${shortcutSavedBody} 退出保存`, 'reopened editor body differs from the saved shortcut and exit edits')
    const reopenedDb = projectDatabase(project.projectPath)
    try {
      assert.equal(reopenedDb.prepare('SELECT contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id WHERE drafts.id = ?').get(draftId).body,
        `${shortcutSavedBody} 退出保存`, 'reopened SQLite body differs from the saved shortcut and exit edits')
    } finally { reopenedDb.close() }
    pass('reopen-persisted-results', null, 'new installed process reopened Writer configuration, architecture, blueprint, character and draft after failure/retry and exit-save')
  } catch (error) {
    failure = error
    if (page) {
      let diagnosticTimer
      try {
        diagnostic = await Promise.race([
          page.evaluate(() => ({
            shell: document.querySelector('[data-shell-presentation]')?.getAttribute('data-shell-presentation'),
            saveFeedback: [...document.querySelectorAll('[role="status"], [role="alert"]')].map(element => element.textContent?.trim()).filter(Boolean),
            configDraft: document.querySelector('textarea[placeholder^="在此输入你的创作想法"]')?.value ?? null,
            characterRows: [...document.querySelectorAll('[data-character-id]')].map(element => element.textContent?.trim()),
            characterPanel: document.body.innerText.match(/角色列表（\d+）|暂无角色|角色列表读取失败[^\n]*/g) ?? [],
            sidebarText: document.querySelector('.skin-workspace-panel')?.textContent?.trim().slice(0, 1000) ?? null,
            panelHeaders: [...document.querySelectorAll('.skin-workspace-panel .panel-header')].map(element => element.textContent?.trim()),
            characterButton: [...document.querySelectorAll('button[title="新建角色"]')].map(element => ({
              visible: Boolean(element.getClientRects().length), disabled: element.disabled,
              panel: element.closest('.skin-workspace-panel')?.textContent?.trim().slice(0, 300) ?? null,
            })),
            characterSearch: document.querySelector('input[aria-label="搜索角色"]')?.value ?? null,
            refreshDisabled: document.querySelector('button[title="刷新列表"]')?.disabled ?? null,
          })),
          new Promise((_, reject) => { diagnosticTimer = setTimeout(() => reject(new Error('diagnostic timeout')), 3_000) }),
        ])
      } catch { diagnostic = { unavailable: true } }
      finally { clearTimeout(diagnosticTimer) }
      if (currentStep === 'reopen-persisted-results') {
        try {
          diagnostic.runtimeContext = await invoke(page, 'project:get-runtime-context')
        } catch (readError) { diagnostic.runtimeContext = { error: String(readError) } }
      }
    }
  }
  finally {
    if (db) {
      try { db.close() }
      catch (error) { failure ??= error }
    }
    if (app) {
      try { await quit(app) }
      catch (error) { failure ??= error }
    }
  }
  const actionCoverage = Object.fromEntries(['U14.A01', 'U14.A02', 'U14.A03', 'U14.A04', 'U14.A05', 'U14.A08', 'U14.A09'].map(actionId => [actionId, {
    failure: steps.some(step => step.actionId === actionId && step.stepId.endsWith('failure') && step.outcome === 'PASS'),
    retry: steps.some(step => step.actionId === actionId && step.stepId.endsWith('retry') && step.outcome === 'PASS'),
  }]))
  const unverified = Object.entries(actionCoverage).filter(([, value]) => !value.failure || !value.retry).map(([actionId]) => actionId)
  if (!steps.some(step => step.stepId === 'U14.A09-inflight-success' && step.outcome === 'PASS')) unverified.push('U14.A09 in-flight success settlement')
  if (!steps.some(step => step.stepId === 'U14.A06-shortcut-save' && step.outcome === 'PASS')) unverified.push('U14.A06 V3 shortcut entry')
  unverified.push('model subgates pending final qualification')
  const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U14_PACKAGED_V3_SAVE_ACTIONS_WITH_MODEL_SUBGATES_PENDING',
    evidenceLevel: 'electron', shell: 'writer-v3', testedSha: packageSourceSha, executionHead: git('rev-parse', 'HEAD'), changedPaths,
    reuseDecision: { testedSha: packageSourceSha, changedPaths, differences: changedPaths.join(', ') || 'none',
      reason: 'product inputs are unchanged since package source SHA; executable and asar hashes match requested artifact; driver is hashed below' },
    sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean), dirtyProductPaths,
    artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
    driver: { path: fileURLToPath(import.meta.url), sha256: fileHash(fileURLToPath(import.meta.url)) },
    profile: { canonical: profile.canonical, userData: profile.userData, projectRoot: profile.projects },
    project: { path: project?.projectPath ?? null, draftId }, steps, actionCoverage,
    previouslyVerified: { actions: ['U14.A06', 'U14.A07'], receipt: previousU14Path, sha256: fileHash(previousU14Path),
      testedSha: previousU14.testedSha, currentBuildSha: packageSourceSha,
      changedPaths: previousBuildChangedPaths, productChangedPaths: previousProductChangedPaths, draftSaveOwnerChanges: previousDraftSaveOwnerChanges,
      reuseReason: 'The old Writer receipt is SHA-bound and supports only the unchanged save owner; V3 shortcut and button entries are exercised by current A06 and A01 respectively.' },
    unverified,
    failedStep: failure ? currentStep : null, error: failure ? String(failure) : null, diagnostic }
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
