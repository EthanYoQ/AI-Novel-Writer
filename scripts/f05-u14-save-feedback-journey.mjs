/* global process */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'
import * as arch from './redesign/pages/architecture.mjs'
import * as blueprint from './redesign/pages/blueprint.mjs'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = argument('package-dir')
const packageSourceSha = argument('package-source-sha')
const expectedExe = argument('exe-sha256')
const expectedAsar = argument('asar-sha256')
assert(packageDir && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
// 旧外壳时期 A06、A07 的通过回执只在当年的机器上，而且出自已删除的旧外壳：有就记下，不沿用。
// A06 由本次编辑区里的 Ctrl S 直接验证；A07 在纸墨外壳里没有重放，记为未验证。
const previousU14Path = path.join(repository, '.runtime', '.cache', 'f05-u14-save-feedback', '9e6e279e-9d5a-4683-bdcf-e7bc4b72152b', 'receipt.json')
const previousU14 = fs.existsSync(previousU14Path) ? JSON.parse(fs.readFileSync(previousU14Path, 'utf8')) : null
const executablePath = resolveWindowsExecutable(packageDir)
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
assert.equal(git('rev-parse', packageSourceSha), packageSourceSha, 'package source SHA is unavailable')
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
async function assertStage(page, actionId) {
  await stage.waitForStage(page)
  assert.equal(await stage.root(page).getAttribute('data-shell-presentation'), 'stage', `${actionId}: not the paper-ink stage`)
}
async function openProject(page) {
  await assertStage(page, 'project-open')
  await stage.dismissMigrationNotice(page)
  await stage.showLibrary(page)
  await stage.openFromLibrary(page, projectName)
  await stage.waitForWork(page, projectName)
}
async function launch(env) {
  const app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(12_000)
  await stage.waitForStage(page)
  assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
  return { app, page }
}
/** 顶栏的保存状态：这部作品有任何一页没保存就是「未保存」。 */
const topStatus = (page, label) => stage.saveStatus(page).filter({ hasText: new RegExp(`^${label}$`) })
async function waitTopStatus(page, label) {
  await topStatus(page, label).waitFor({ state: 'visible' })
}
// 退出对话框这类模态打开时，其余部分从无障碍树里隐去，按角色找不到顶栏；这里按顶栏保存状态的类名读。
const shownDirty = async page => await stage.root(page).locator('.stage-saved').filter({ hasText: /^未保存$/ }).count() > 0
const failureToasts = page => stage.toastStack(page).locator(`${stage.LIVE_TOAST}[data-tone="danger"]`)
/** 把还在的失败通知逐条关掉，免得下一步把旧通知当成新的。 */
async function dismissFailureToasts(page) {
  for (let left = await failureToasts(page).count(); left > 0; left--) {
    await failureToasts(page).first().getByRole('button', { name: '关闭通知' }).click()
    await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length < count,
      { selector: `.pi-toast-stack ${stage.LIVE_TOAST}[data-tone="danger"]`, count: left })
  }
}
/** 等一条失败通知出现，读出它的文字，再关掉。 */
async function takeFailureToast(page) {
  await failureToasts(page).first().waitFor({ state: 'visible' })
  const message = (await failureToasts(page).first().innerText()).trim()
  await dismissFailureToasts(page)
  return message
}
/** 正文没有保存按钮：焦点离开编辑区后按 Ctrl S，由外壳保存当前标签。编辑区里的 Ctrl S 另由 A06 验证。 */
async function saveFromShell(page) {
  await stage.root(page).locator('.stage-ch-title').click()
  await page.keyboard.press('ControlOrMeta+s')
}
/** 架构文档标签（世界观等）沿用的编辑器：自带保存按钮与「未保存 / 保存失败 / 已保存」提示。 */
const archDocument = page => stage.root(page).locator('.stage-content')
const archFeedback = (page, label) => archDocument(page).getByRole(label === '保存失败' ? 'alert' : 'status').filter({ hasText: new RegExp(`^${label}$`) })
const archEditor = page => archDocument(page).locator('.cm-content[contenteditable="true"]')
async function waitFor(read, expected, label) {
  const deadline = Date.now() + 12_000
  let value
  while (Date.now() < deadline) {
    value = await read().catch(() => undefined)
    if (expected(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${label}: ${JSON.stringify(typeof value === 'string' ? value.slice(0, 300) : value)}`)
}
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
async function waitForSaveGate(app, field, label) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await app.evaluate((_, name) => globalThis.__f05U14SaveGate?.[name] === true, field)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`U14.A09: ${label}`)
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
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'review packaged stage U14 action receipt',
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
    project = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, profile.projects)).grantId, name: projectName,
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
    mark('stage-project-open')
    await page.reload()
    await openProject(page)
    pass('stage-project-entry', null, 'opened the isolated project in the paper-ink stage', { projectPath: project.projectPath })
    db = projectDatabase(project.projectPath)

    mark('U14.A04-config-button-save')
    await assertStage(page, 'U14.A04')
    await stage.stageButton(page, '设定').click()
    await stage.setupOutline(page).fill(configMarker)
    await waitTopStatus(page, '未保存')
    const configSave = stage.setupFoot(page).getByRole('button', { name: /^保存/ })
    const oldConfig = db.prepare('SELECT core_outline FROM project_core WHERE id = ?').get('main').core_outline
    await withFailedSave(db, 'project_core', async () => {
      await assertStage(page, 'U14.A04-failure')
      await configSave.click()
      const alert = stage.setupFoot(page).getByRole('alert').filter({ hasText: /^没能保存。/ })
      await alert.waitFor({ state: 'visible' })
      assert(await shownDirty(page), 'configuration falsely marked clean after failed save')
      assert.equal(db.prepare('SELECT core_outline FROM project_core WHERE id = ?').get('main').core_outline, oldConfig)
      pass('U14.A04-failure', 'U14.A04', 'repository UPDATE aborted; the setup page shows the failure, the top bar stays unsaved and the original configuration is retained',
        { alert: (await alert.innerText()).trim() })
    })
    await dismissFailureToasts(page)
    await assertStage(page, 'U14.A04-retry')
    await configSave.click()
    await waitTopStatus(page, '已保存')
    assert.equal(db.prepare('SELECT core_outline FROM project_core WHERE id = ?').get('main').core_outline, configMarker)
    pass('U14.A04-retry', 'U14.A04', 'retrying from the setup page changed unsaved to saved and the repository contains the new configuration', { marker: configMarker })

    mark('U14.A03-blueprint-button-save')
    await assertStage(page, 'U14.A03')
    await blueprint.open(page)
    await blueprint.planItem(page, 1).click()
    await blueprint.titleInput(page).fill(blueprintMarker)
    await waitTopStatus(page, '未保存')
    const blueprintSave = blueprint.card(page).getByRole('button', { name: '保存此章' })
    const oldBlueprint = db.prepare('SELECT title FROM blueprints WHERE chapter_number = 1').get().title
    await withFailedSave(db, 'blueprints', async () => {
      await assertStage(page, 'U14.A03-failure')
      await blueprintSave.click()
      const message = await takeFailureToast(page)
      assert.match(message, /^保存失败/, 'blueprint failure notice')
      assert(await shownDirty(page), 'blueprint falsely marked clean after failed save')
      assert.equal(db.prepare('SELECT title FROM blueprints WHERE chapter_number = 1').get().title, oldBlueprint)
      pass('U14.A03-failure', 'U14.A03', 'repository UPSERT update aborted; the blueprint page shows a failure notice, the top bar stays unsaved and the original blueprint is retained',
        { toast: message })
    })
    await assertStage(page, 'U14.A03-retry')
    await blueprintSave.click()
    await waitTopStatus(page, '已保存')
    assert.equal(db.prepare('SELECT title FROM blueprints WHERE chapter_number = 1').get().title, blueprintMarker)
    pass('U14.A03-retry', 'U14.A03', 'retrying 保存此章 changed unsaved to saved and the repository contains the new blueprint', { marker: blueprintMarker })

    mark('U14.A02-architecture-save')
    await assertStage(page, 'U14.A02')
    await arch.open(page)
    await arch.section(page, 'worldbuilding').getByRole('button', { name: /^(编辑|自己写)$/ }).click()
    await archEditor(page).waitFor({ state: 'visible' })
    await archEditor(page).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(archMarker)
    await archFeedback(page, '未保存').waitFor({ state: 'visible' })
    await waitTopStatus(page, '未保存')
    const archSave = archDocument(page).getByRole('button', { name: '保存', exact: true })
    const oldArch = db.prepare('SELECT worldbuilding FROM project_core WHERE id = ?').get('main').worldbuilding
    await withFailedSave(db, 'project_core', async () => {
      await assertStage(page, 'U14.A02-failure')
      await archSave.click()
      await archFeedback(page, '保存失败').waitFor({ state: 'visible' })
      const message = await takeFailureToast(page)
      assert(await shownDirty(page), 'architecture falsely marked clean after failed save')
      assert.equal(db.prepare('SELECT worldbuilding FROM project_core WHERE id = ?').get('main').worldbuilding, oldArch)
      pass('U14.A02-failure', 'U14.A02', 'repository UPDATE aborted; the worldbuilding document shows 保存失败 with a failure notice, the top bar stays unsaved and the original architecture is retained',
        { toast: message })
    })
    await assertStage(page, 'U14.A02-retry')
    await archSave.click()
    await archFeedback(page, '已保存').waitFor({ state: 'visible' })
    await waitTopStatus(page, '已保存')
    assert.equal(db.prepare('SELECT worldbuilding FROM project_core WHERE id = ?').get('main').worldbuilding, archMarker)
    pass('U14.A02-retry', 'U14.A02', 'retrying the worldbuilding document save persisted the architecture through its project session', { marker: archMarker })

    mark('U14.A01-body-shell-save')
    await assertStage(page, 'U14.A01')
    const body = await stage.openChapter(page, 1)
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(bodyMarker)
    await waitTopStatus(page, '未保存')
    const storedBody = () => db.prepare('SELECT contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id WHERE drafts.id = ?').get(draftId).body
    const oldBody = storedBody()
    await withFailedSave(db, 'contents', async () => {
      await assertStage(page, 'U14.A01-failure')
      await saveFromShell(page)
      const message = await takeFailureToast(page)
      assert(await shownDirty(page), 'draft falsely marked clean after failed save')
      assert.equal(storedBody(), oldBody)
      pass('U14.A01-failure', 'U14.A01', 'first repository body UPDATE aborted; the shell save of the chapter tab showed a failure notice, the top bar stays unsaved and the original body is retained',
        { toast: message })
    })
    await assertStage(page, 'U14.A01-retry')
    await saveFromShell(page)
    await waitTopStatus(page, '已保存')
    assert(storedBody().includes(bodyMarker))
    pass('U14.A01-retry', 'U14.A01', 'retrying the shell save changed unsaved to saved and the repository contains the new body', { marker: bodyMarker })

    mark('U14.A09-concurrent-edit')
    await assertStage(page, 'U14.A09')
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 并发一')
    await waitTopStatus(page, '未保存')
    let lockMessage
    db.exec('BEGIN IMMEDIATE')
    try {
      await assertStage(page, 'U14.A09-lock-failure')
      await saveFromShell(page)
      lockMessage = await takeFailureToast(page)
      assert(await shownDirty(page), 'lock failure falsely marked the draft clean')
      assert(!storedBody().includes('并发一'), 'failed locked save changed the durable draft')
      await body.click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(' 并发二')
    } finally { db.exec('COMMIT') }
    await waitTopStatus(page, '未保存')
    pass('U14.A09-lock-failure', 'U14.A09', 'concurrent SQLite writer made save fail visibly; later local input remains dirty', { toast: lockMessage })
    await assertStage(page, 'U14.A09-retry')
    await saveFromShell(page)
    await waitTopStatus(page, '已保存')
    assert(storedBody().includes('并发一'))
    assert(storedBody().includes('并发二'))
    pass('U14.A09-retry', 'U14.A09', 'subsequent save persisted both edits after the lock was released', { suffix: ' 并发一 并发二' })

    await app.evaluate(({ ipcMain }) => {
      const channel = 'db:draft-update-content'
      const original = ipcMain._invokeHandlers.get(channel)
      if (!original) throw new Error('draft save IPC handler missing')
      const gate = { committed: false, returned: false, release: null }
      globalThis.__f05U14SaveGate = gate
      globalThis.__f05U14OriginalDraftHandler = original
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        const result = await original(event, ...args)
        if (result?.success) {
          gate.committed = true
          await new Promise(resolve => { gate.release = resolve })
          gate.returned = true
        }
        return result
      })
    })
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 并发三')
    await waitTopStatus(page, '未保存')
    await assertStage(page, 'U14.A09-inflight-success')
    await saveFromShell(page)
    await waitForSaveGate(app, 'committed', 'draft commit did not reach the held response')
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
    await waitForSaveGate(app, 'returned', 'held draft response was not returned')
    // 放行的回应要经过渲染进程处理；给它一秒，若误把后来的输入当成已保存，顶栏会在这期间翻成「已保存」。
    await page.waitForTimeout(1_000)
    assert(await shownDirty(page), 'earlier save response falsely cleared later input')
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
    await assertStage(page, 'U14.A09-second-save')
    await saveFromShell(page)
    await waitTopStatus(page, '已保存')
    assert(storedBody().includes('并发三') && storedBody().includes('并发四'))
    pass('U14.A09-second-save', 'U14.A09', 'second save persisted the later edit without losing the committed snapshot')

    mark('U14.A06-shortcut-save')
    await assertStage(page, 'U14.A06')
    const beforeShortcut = storedBody()
    assert(!beforeShortcut.includes(shortcutMarker))
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(shortcutMarker)
    const shortcutSavedBody = `${beforeShortcut}${shortcutMarker}`
    assert.equal(await stage.proseBody(body), shortcutSavedBody, 'shortcut test input did not reach the focused editor')
    assert(await body.evaluate(element => element === document.activeElement), 'shortcut target is not the focused editor')
    await waitTopStatus(page, '未保存')
    assert.equal(storedBody(), beforeShortcut, 'shortcut input saved before the key command')
    await page.keyboard.press('Control+s')
    await waitTopStatus(page, '已保存')
    assert.equal(storedBody(), shortcutSavedBody, 'Ctrl+S did not persist the exact draft body')
    assert(!(await shownDirty(page)), 'Ctrl+S left the draft dirty')
    pass('U14.A06-shortcut-save', 'U14.A06', 'Ctrl+S in the focused chapter editor changed unsaved to saved and persisted the exact body', { marker: shortcutMarker })

    mark('U14.A05-character-save')
    await assertStage(page, 'U14.A05')
    await arch.open(page)
    await arch.openCast(page)
    await arch.castRoster(page).getByRole('button', { name: '新建角色' }).click()
    const characterName = stage.root(page).getByLabel('姓名', { exact: true })
    await characterName.fill(characterMarker)
    const castSaveState = label => stage.root(page).locator('.cast-save-state').filter({ hasText: new RegExp(`^${label}$`) })
    await castSaveState('未保存').waitFor({ state: 'visible' })
    await waitTopStatus(page, '未保存')
    const characterSave = stage.root(page).getByRole('button', { name: '保存角色' })
    const oldCharacterCount = db.prepare('SELECT count(*) AS n FROM characters').get().n
    await withFailedSave(db, 'characters', async () => {
      await assertStage(page, 'U14.A05-failure')
      await characterSave.click()
      await castSaveState('保存失败').waitFor({ state: 'visible' })
      const saveError = stage.root(page).locator('.cast-profile-error[role="alert"]').first()
      await saveError.waitFor({ state: 'visible' })
      assert(await shownDirty(page), 'character falsely marked clean after failed save')
      assert.equal(db.prepare('SELECT count(*) AS n FROM characters').get().n, oldCharacterCount)
      pass('U14.A05-failure', 'U14.A05', 'roster transaction INSERT aborted; the profile shows 保存失败 with the error, the top bar stays unsaved and no character was committed',
        { saveError: (await saveError.innerText()).trim() })
    }, 'INSERT')
    await dismissFailureToasts(page)
    await assertStage(page, 'U14.A05-retry')
    await characterSave.click()
    await castSaveState('已保存').waitFor({ state: 'visible' })
    await waitTopStatus(page, '已保存')
    assert.equal(db.prepare('SELECT name FROM characters WHERE name = ? AND retired = 0').get(characterMarker)?.name, characterMarker)
    pass('U14.A05-retry', 'U14.A05', 'retrying 保存角色 saved the character through the existing roster commit transaction', { marker: characterMarker })

    mark('U14.A08-exit-save')
    await assertStage(page, 'U14.A08')
    const exitBody = await stage.openChapter(page, 1)
    await exitBody.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' 退出保存')
    await waitTopStatus(page, '未保存')
    const exitDialog = page.getByRole('dialog', { name: '退出前处理未保存的内容' })
    await withFailedSave(db, 'contents', async () => {
      await assertStage(page, 'U14.A08-failure')
      await stage.root(page).locator(stage.WINDOW_CLOSE).click()
      await exitDialog.getByRole('button', { name: '保存并退出' }).click()
      const exitError = exitDialog.getByRole('alert')
      await exitError.waitFor({ state: 'visible' })
      const message = (await exitError.innerText()).trim()
      assert.match(message, /U14_INJECTED_SAVE_FAILURE/, 'exit dialog does not name the failed save')
      assert(await shownDirty(page), 'failed exit save falsely marked clean')
      assert(!storedBody().includes('退出保存'), 'failed exit save changed the durable draft body')
      pass('U14.A08-failure', 'U14.A08', 'exit dialog remains open with the failure; the top bar stays unsaved and the durable body is unchanged', { exitError: message })
    })
    await assertStage(page, 'U14.A08-retry')
    const closed = page.waitForEvent('close', { timeout: 20_000 })
    const appClosed = app.waitForEvent('close', { timeout: 20_000 })
    await exitDialog.getByRole('button', { name: '保存并退出' }).click()
    await closed
    await appClosed
    assert.equal(storedBody(), `${shortcutSavedBody} 退出保存`, 'exit save did not persist the exact draft')
    pass('U14.A08-retry', 'U14.A08', 'save-and-exit closed the real window only after the durable draft save')
    db.close(); db = null
    app = null

    mark('reopen-persisted-results')
    ;({ app, page } = await launch(env))
    await openProject(page)
    await arch.open(page)
    await arch.openCast(page)
    await arch.castRow(page, characterMarker).click()
    await waitFor(() => stage.root(page).getByLabel('姓名', { exact: true }).inputValue(), value => value === characterMarker, 'reopened character name')
    await stage.stageButton(page, '设定').click()
    await waitFor(() => stage.setupOutline(page).inputValue(), value => value === configMarker, 'reopened setup outline')
    await blueprint.open(page)
    await blueprint.planItem(page, 1).click()
    await waitFor(() => blueprint.titleInput(page).inputValue(), value => value === blueprintMarker, 'reopened blueprint title')
    await arch.open(page)
    // 一节不到 50 字时架构页仍按「待生成」显示「自己写」，打开的是同一份文档。
    await arch.section(page, 'worldbuilding').getByRole('button', { name: /^(编辑|自己写)$/ }).click()
    await waitFor(() => archEditor(page).innerText(), value => value?.includes(archMarker), 'reopened worldbuilding document')
    const reopenedDraft = await stage.openChapter(page, 1)
    await waitFor(() => stage.proseBody(reopenedDraft), value => value === `${shortcutSavedBody} 退出保存`,
      'reopened editor body differs from the saved shortcut and exit edits')
    const reopenedDb = projectDatabase(project.projectPath)
    try {
      assert.equal(reopenedDb.prepare('SELECT contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id WHERE drafts.id = ?').get(draftId).body,
        `${shortcutSavedBody} 退出保存`, 'reopened SQLite body differs from the saved shortcut and exit edits')
    } finally { reopenedDb.close() }
    pass('reopen-persisted-results', null, 'a new installed process reopened the setup, architecture, blueprint, character and draft in the stage after failure/retry and exit-save')
  } catch (error) {
    failure = error
    if (page) {
      await page.screenshot({ path: path.join(receiptDir, 'failure.png') }).catch(() => {})
      let diagnosticTimer
      try {
        diagnostic = await Promise.race([
          page.evaluate(() => ({
            shell: document.querySelector('[data-shell-presentation]')?.getAttribute('data-shell-presentation'),
            saveFeedback: [...document.querySelectorAll('[role="status"], [role="alert"], .cast-save-state')].map(element => element.textContent?.trim()).filter(Boolean),
            toasts: [...document.querySelectorAll('.pi-toast')].map(element => element.textContent?.trim()),
            tabs: [...document.querySelectorAll('[role="tablist"] [role="tab"]')].map(element => element.textContent?.trim()),
            textareas: [...document.querySelectorAll('.stage-content textarea')].map(element => element.value.slice(0, 200)),
            characterRows: [...document.querySelectorAll('.cast-list li')].map(element => element.textContent?.trim()),
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
  if (!steps.some(step => step.stepId === 'U14.A06-shortcut-save' && step.outcome === 'PASS')) unverified.push('U14.A06 focused editor shortcut entry')
  unverified.push('U14.A07 only has a historical Writer receipt; not re-exercised in the stage')
  unverified.push('model subgates pending final qualification')
  const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U14_PACKAGED_V3_SAVE_ACTIONS_WITH_MODEL_SUBGATES_PENDING',
    evidenceLevel: 'electron', shell: 'stage', testedSha: packageSourceSha, executionHead: git('rev-parse', 'HEAD'), changedPaths,
    reuseDecision: { testedSha: packageSourceSha, changedPaths, differences: changedPaths.join(', ') || 'none',
      reason: 'product inputs are unchanged since package source SHA; executable and asar hashes match requested artifact; driver is hashed below' },
    sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean), dirtyProductPaths,
    artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
    driver: { path: fileURLToPath(import.meta.url), sha256: fileHash(fileURLToPath(import.meta.url)) },
    profile: { canonical: profile.canonical, userData: profile.userData, projectRoot: profile.projects },
    project: { path: project?.projectPath ?? null, draftId }, steps, actionCoverage,
    previouslyVerified: { actions: ['U14.A07'], receipt: previousU14Path, present: Boolean(previousU14),
      sha256: previousU14 ? fileHash(previousU14Path) : null, testedSha: previousU14?.testedSha ?? null, reused: false,
      reuseReason: 'The historical receipt came from the deleted Writer shell, so it is recorded but not reused; A06 is exercised directly through the focused editor shortcut.' },
    unverified,
    failedStep: failure ? currentStep : null, error: failure ? String(failure) : null, diagnostic }
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
