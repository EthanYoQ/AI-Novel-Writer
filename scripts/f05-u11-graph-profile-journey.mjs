/* global process, Buffer */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import * as arch from './redesign/pages/architecture.mjs'
import * as runSheet from './redesign/pages/run-sheet.mjs'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const a08Only = process.argv.includes('--v3-a08-only')
const a09Only = process.argv.includes('--v3-a09-only')
const a12Only = process.argv.includes('--v3-a12-only')
const a10Only = process.argv.includes('--v3-a10-only')
const graphCoreOnly = process.argv.includes('--v3-a01-a07-only')
const graphRemainingOnly = process.argv.includes('--v3-a11-a13-only')
const narrowOnly = process.argv.includes('--v3-narrow-only')
const avatarOnly = process.argv.includes('--v3-avatar-batch-only')
assert([a08Only, a09Only, a12Only, a10Only, graphCoreOnly, graphRemainingOnly, narrowOnly, avatarOnly].filter(Boolean).length <= 1,
  'select only one focused journey mode')
// 不带模式参数（或 --v3-a10-a13）时走千人名单的 A11、A12、A13；旧外壳时期按模式写死的历史安装包都换成同一组固定安装包参数。
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = option('package-dir') && path.resolve(option('package-dir'))
const testedSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
assert(packageDir && /^[a-f0-9]{40}$/.test(testedSha ?? '') && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
assert.equal(git('rev-parse', `${testedSha}^{commit}`), testedSha, 'package source SHA is unavailable')
const executionHead = git('rev-parse', 'HEAD')
const changedPaths = git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean)
const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productInputs), '', 'product source changed since package build')
const dirtyProduct = git('status', '--porcelain', '--', ...productInputs)
  .split('\n').filter(Boolean).filter(line => !/src\/.*\/__tests__\//.test(line))
assert.deepEqual(dirtyProduct, [], 'dirty product input since package build')
const executablePath = resolveWindowsExecutable(packageDir)
const asarPath = path.join(packageDir, 'resources', 'app.asar')
assert.equal(sha256(executablePath), expectedExe)
assert.equal(sha256(asarPath), expectedAsar)
const driverSha256 = sha256(fileURLToPath(import.meta.url))
const runId = randomUUID()
const evidenceDir = path.join(repository, '.runtime', '.cache', 'f05-u11-graph-profile', runId)
const scratch = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'an', 'u11', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const projectName = 'U11'
const firstName = `甲${runId.slice(0, 6)}`
const secondName = `乙${runId.slice(0, 6)}`
const relationship = '同盟'
const initialRelationship = '旧识'
const thirdName = `丙${runId.slice(0, 6)}`
const fourthName = `丁${runId.slice(0, 6)}`
const fifthName = `戊${runId.slice(0, 6)}`
const sentinelName = `原有角色${runId.slice(0, 6)}`
const a08TargetNotes = `U11.A08 档案哨兵甲 ${runId}`
const a08OtherNotes = `U11.A08 档案哨兵乙 ${runId}`
const model = { id: 'f05-u11-synthetic', name: 'U11 隔离合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'f05-u11-offline-only', maxTokens: 4096, temperature: 0.7, purposes: ['generation'] }
const premise = '在潮汐城，守塔人发现被封存的港口档案。调查者沿钟声记录找到三条线索，必须在城门关闭前核对证人、地图和旧港的通行记录。'.repeat(2)
const steps = []
const pass = (stepId, actionId, assertion, observed) => steps.push({ stepId, actionId, outcome: 'PASS', assertion, observed })
async function assertStage(page, step) {
  await stage.waitForStage(page)
  assert.equal(await stage.root(page).getAttribute('data-shell-presentation'), 'stage', `${step}: wrong shell`)
}
async function invoke(page, channel, ...args) {
  let timer
  try {
    return await Promise.race([
      page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`IPC timeout: ${channel}`)), 20_000) }),
    ])
  } finally { clearTimeout(timer) }
}
async function quit(app) {
  const pid = app.process().pid
  let timer
  let timedOut = false
  const closed = await Promise.race([app.close().then(() => true).catch(() => false),
    new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(false) }, 10_000) })])
  clearTimeout(timer)
  if (!closed) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' }) }
    catch { /* A process that exited during taskkill is checked below. */ }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0) }
    catch (error) {
      if (error.code === 'ESRCH') {
        if (!closed) throw new Error(`${timedOut ? 'ELECTRON_CLOSE_TIMEOUT' : 'ELECTRON_CLOSE_FAILED'} pid=${pid}`)
        return
      }
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(timedOut ? `ELECTRON_CLOSE_TIMEOUT pid=${pid}; process still running`
    : `Electron PID ${pid} did not exit`)
}
function rosterFacts(db) {
  return JSON.stringify({
    characters: db.prepare('SELECT * FROM characters ORDER BY character_id').all(),
    relationships: db.prepare('SELECT source_character_id, target_character_id, relation FROM character_relationships ORDER BY relationship_id').all(),
    revision: db.prepare("SELECT revision FROM character_roster_meta WHERE id='main'").pluck().get(),
  })
}

/* 纸墨外壳的角色名单：架构阶段「角色名单」一节的「打开角色名单」；左边名单、右边档案，档案视图里有关系图谱。 */
async function openProject(page) {
  await stage.dismissMigrationNotice(page)
  await stage.showLibrary(page)
  await stage.openFromLibrary(page, projectName)
  await stage.waitForWork(page, projectName)
}
async function openCast(page) {
  await arch.open(page)
  await arch.openCast(page)
}
/** 名单底部写「N 位角色 · 第 p / P 页」。 */
async function waitRosterCount(page, count) {
  await arch.castRoster(page).locator('.cast-roster-foot').getByText(new RegExp(`^${count} 位角色 · `)).waitFor({ state: 'visible' })
}
const profileView = (page, name) => stage.root(page).getByRole('group', { name: '档案视图' }).getByRole('button', { name, exact: true })
async function showGraph(page) {
  await profileView(page, '关系图谱').click()
  const canvas = page.locator('canvas[aria-label^="角色关系图谱"]')
  await canvas.waitFor({ state: 'visible' })
  return canvas
}
/** 图谱里点人：档案换到这位并回到「基础设定」。 */
async function waitProfileOf(page, name) {
  await stage.root(page).locator('.cast-profile-name').filter({ hasText: new RegExp(`^${name}$`) }).waitFor({ state: 'visible' })
  assert.equal(await profileView(page, '基础设定').getAttribute('aria-pressed'), 'true', 'graph click did not return to the profile view')
}
const rosterRow = (page, characterId) => arch.castRoster(page).locator(`[data-character-id="${characterId}"]`)
const profileField = (page, label) => stage.root(page).getByLabel(label, { exact: true })
const saveState = (page, label) => stage.root(page).locator('.cast-save-state').filter({ hasText: new RegExp(`^${label}$`) })
async function profileMenu(page, item) {
  await stage.root(page).getByRole('button', { name: '角色的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

async function verifyV3A08(page, db, setStep) {
  setStep('U11.A08-v3-graph-to-profile')
  await assertStage(page, 'U11.A08')
  const duplicateRows = db.prepare('SELECT character_id, name, notes FROM characters WHERE retired=0 AND name=? ORDER BY character_id').all(firstName)
  assert.equal(duplicateRows.length, 2, 'A08 fixture must contain exactly two active same-name stable IDs')
  const target = duplicateRows.find(row => row.notes === a08TargetNotes)
  const other = duplicateRows.find(row => row.notes === a08OtherNotes)
  assert(target?.character_id && other?.character_id && target.character_id !== other.character_id)
  assert.equal(target.name, other.name)
  assert.notEqual(target.notes, other.notes, 'same-name profiles need a distinct non-name sentinel field')

  await openCast(page)
  await waitRosterCount(page, 2)
  await showGraph(page)
  const sidebar = page.getByRole('complementary', { name: '图谱人物侧栏' })
  const targetGraphButton = sidebar.locator(`button[data-graph-character-id="${target.character_id}"]`)
  await targetGraphButton.waitFor({ state: 'visible' })
  assert.equal(await sidebar.locator(`button[data-graph-character-id="${other.character_id}"]`).count(), 1)
  await targetGraphButton.click()
  await waitProfileOf(page, target.name)

  const selectedProfile = rosterRow(page, target.character_id)
  const otherProfile = rosterRow(page, other.character_id)
  const targetClickSelectedTarget = await selectedProfile.getAttribute('aria-pressed')
  const targetClickSelectedOther = await otherProfile.getAttribute('aria-pressed')
  assert.equal(targetClickSelectedTarget, 'true', 'graph click did not select its stable character ID')
  assert.equal(targetClickSelectedOther, 'false', 'same-name profile with another stable ID was selected')
  const notesField = profileField(page, '备注')
  const targetClickNotes = await notesField.inputValue()
  assert.equal(targetClickNotes, target.notes, 'opened profile notes do not match the clicked stable ID')
  assert.notEqual(targetClickNotes, other.notes, 'opened profile notes came from the other same-name character')

  await showGraph(page)
  const otherGraphButton = sidebar.locator(`button[data-graph-character-id="${other.character_id}"]`)
  await otherGraphButton.waitFor({ state: 'visible' })
  await otherGraphButton.click()
  await page.waitForFunction(({ targetId, otherId, otherNotes }) => {
    const rowFor = id => document.querySelector(`.cast-roster [data-character-id="${id}"]`)
    const notesField = Array.from(document.querySelectorAll('label')).find(label => label.textContent === '备注')?.control
    return rowFor(targetId)?.getAttribute('aria-pressed') === 'false'
      && rowFor(otherId)?.getAttribute('aria-pressed') === 'true'
      && notesField?.value === otherNotes
  }, { targetId: target.character_id, otherId: other.character_id, otherNotes: other.notes }, { timeout: 5_000 })
  const otherClickSelectedTarget = await selectedProfile.getAttribute('aria-pressed')
  const otherClickSelectedOther = await otherProfile.getAttribute('aria-pressed')
  const otherClickNotes = await notesField.inputValue()
  assert.equal(otherClickSelectedOther, 'true', 'second graph click did not select the other stable character ID')
  assert.equal(otherClickSelectedTarget, 'false', 'second graph click left the first same-name profile selected')
  assert.equal(otherClickNotes, other.notes, 'second graph click opened notes from the wrong stable character ID')
  assert.notEqual(otherClickNotes, target.notes, 'second graph click reused the first same-name profile notes')
  pass('U11.A08-v3-graph-to-profile', 'U11.A08',
    'Graph sidebar clicks on the cast page opened each same-name stable ID independently; selected roster rows and distinct notes matched, with no A09 write',
    { targetCharacterId: target.character_id, otherCharacterId: other.character_id, sharedName: target.name,
      targetNotes: target.notes, otherNotes: other.notes,
      targetClick: { selectedTarget: targetClickSelectedTarget, selectedOther: targetClickSelectedOther, notes: targetClickNotes },
      otherClick: { selectedTarget: otherClickSelectedTarget, selectedOther: otherClickSelectedOther, notes: otherClickNotes },
      fixtureSeed: 'roster IPC with unique names, then isolated SQLite rename by character_id' })
}
async function verifyV3A09(page, db, setStep) {
  setStep('U11.A09-v3-relationship-edit')
  await assertStage(page, 'U11.A09')
  const rows = db.prepare('SELECT character_id, name FROM characters WHERE retired=0 AND name IN (?, ?)').all(firstName, secondName)
  assert.equal(rows.length, 2, 'A09 fixture requires exactly two active characters')
  const source = rows.find(row => row.name === firstName)
  const target = rows.find(row => row.name === secondName)
  assert(source?.character_id && target?.character_id && source.character_id !== target.character_id)
  const relationRows = db.prepare('SELECT source_character_id, target_character_id, relation FROM character_relationships').all()
  assert.deepEqual(relationRows, [{ source_character_id: source.character_id,
    target_character_id: target.character_id, relation: initialRelationship }], 'A09 fixture must begin with only the old relation')

  await openCast(page)
  await showGraph(page)
  await page.getByRole('complementary', { name: '图谱人物侧栏' })
    .locator(`button[data-graph-character-id="${source.character_id}"]`).click()
  await waitProfileOf(page, firstName)
  assert.equal(await rosterRow(page, source.character_id).getAttribute('aria-pressed'), 'true')
  const field = profileField(page, '关系网')
  assert.equal(await field.inputValue(), `${secondName}：${initialRelationship}`)
  await field.fill(`${secondName}：${relationship}`)
  assert.equal(await field.inputValue(), `${secondName}：${relationship}`)
  await saveState(page, '未保存').waitFor({ state: 'visible' })
  await stage.root(page).getByRole('button', { name: '保存角色', exact: true }).click()
  await saveState(page, '已保存').waitFor({ state: 'visible', timeout: 20_000 })
  assert.deepEqual(db.prepare('SELECT source_character_id, target_character_id, relation FROM character_relationships').all(),
    [{ source_character_id: source.character_id, target_character_id: target.character_id, relation: relationship }],
    'UI save did not replace the old relation at the original stable IDs')

  setStep('U11.A09-v3-reopen')
  await page.reload()
  await assertStage(page, 'U11.A09-reopen')
  await openProject(page)
  await openCast(page)
  await showGraph(page)
  await page.getByRole('complementary', { name: '图谱人物侧栏' })
    .locator(`button[data-graph-character-id="${source.character_id}"]`).click()
  await waitProfileOf(page, firstName)
  assert.equal(await rosterRow(page, source.character_id).getAttribute('aria-pressed'), 'true')
  assert.equal(await profileField(page, '关系网').inputValue(), `${secondName}：${relationship}`)
  const Database = createRequire(import.meta.url)('better-sqlite3')
  const reopenedDb = new Database(db.name, { fileMustExist: true, readonly: true })
  try {
    assert.deepEqual(reopenedDb.prepare('SELECT source_character_id, target_character_id, relation FROM character_relationships').all(),
      [{ source_character_id: source.character_id, target_character_id: target.character_id, relation: relationship }])
  } finally { reopenedDb.close() }
  pass('U11.A09-v3-relationship-edit-and-reopen', 'U11.A09',
    'The graph opened the original stable-ID profile; editing 关系网 and 保存角色 replaced its existing relation, and the reopened project and SQLite agreed',
    { sourceId: source.character_id, targetId: target.character_id,
      fixtureRelation: initialRelationship, savedRelation: relationship, reopenedRelation: relationship })
}
async function verifyV3Graph(page, db, setStep) {
  await assertStage(page, 'graph')
  const rows = db.prepare('SELECT character_id, name FROM characters WHERE retired=0').all()
  assert.equal(rows.length, 1000, 'bounded graph fixture must contain exactly 1000 durable characters')
  const first = rows.find(row => row.name === firstName)
  const second = rows.find(row => row.name === secondName)
  assert(first?.character_id && second?.character_id)
  assert.equal(db.prepare('SELECT relation FROM character_relationships WHERE source_character_id=? AND target_character_id=?')
    .get(first.character_id, second.character_id)?.relation, relationship)
  await openCast(page)
  await waitRosterCount(page, 1000)
  const canvas = await showGraph(page)
  const sidebar = page.getByRole('complementary', { name: '图谱人物侧栏' })

  if (!a12Only) {
  setStep('U11.A13-bounded-search-pagination')
  assert(Number(await canvas.getAttribute('data-rendered-node-count')) <= 80, 'graph canvas rendered more than 80 nodes')
  const visibleIds = new Set()
  for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
    await sidebar.getByText(`${pageNumber} / 20 · 1000`, { exact: true }).waitFor({ state: 'visible' })
    const ids = await sidebar.locator('button[data-graph-character-id]').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-graph-character-id')))
    assert.equal(ids.length, 50, `graph page ${pageNumber} should expose 50 people`)
    for (const id of ids) visibleIds.add(id)
    if (pageNumber < 20) await sidebar.getByRole('button', { name: '下一页人物' }).click()
  }
  assert.deepEqual([...visibleIds].sort(), rows.map(row => row.character_id).sort(), 'pagination did not reach every durable character ID')
  const searchTarget = rows.at(-1)
  await sidebar.getByRole('textbox', { name: '搜索图谱人物' }).fill(searchTarget.name)
  await sidebar.locator(`button[data-graph-character-id="${searchTarget.character_id}"]`).waitFor({ state: 'visible' })
  assert.equal(await sidebar.locator('button[data-graph-character-id]').count(), 1)
  pass('U11.A13-bounded-search-pagination', 'U11.A13', 'The cast graph renders at most 80 nodes; 20 visible sidebar pages reach all 1000 durable IDs and exact search reaches the last target',
    { durableCount: rows.length, renderedNodes: Number(await canvas.getAttribute('data-rendered-node-count')), reachedIds: visibleIds.size,
      searchedTargetId: searchTarget.character_id, searchedTargetName: searchTarget.name })

  setStep('U11.A11-reset-layout-zero-fact-write')
  await sidebar.getByRole('textbox', { name: '搜索图谱人物' }).fill('')
  await page.getByRole('button', { name: '放大关系图谱' }).click()
  const beforeReset = rosterFacts(db)
  await page.getByRole('button', { name: '重置图谱布局' }).click()
  assert.equal(rosterFacts(db), beforeReset, 'layout reset wrote character or relation facts')
  pass('U11.A11-reset-layout-zero-fact-write', 'U11.A11', 'Visible zoom and reset controls left the complete roster, relation facts and revision unchanged',
    { beforeSha256: createHash('sha256').update(beforeReset).digest('hex'), afterSha256: createHash('sha256').update(rosterFacts(db)).digest('hex') })
  }

  if (!graphRemainingOnly) {
  setStep('U11.A12-delete-character-cancel')
  const beforeDelete = rosterFacts(db)
  await sidebar.locator(`button[data-graph-character-id="${first.character_id}"]`).click()
  await waitProfileOf(page, firstName)
  const deleteDialog = page.getByRole('dialog', { name: `删除角色「${firstName}」？` })
  await profileMenu(page, `删除角色「${firstName}」…`)
  await deleteDialog.waitFor({ state: 'visible' })
  assert.match(await deleteDialog.innerText(), new RegExp(firstName))
  await deleteDialog.getByRole('button', { name: '取消', exact: true }).click()
  await deleteDialog.waitFor({ state: 'detached' })
  assert.equal(rosterFacts(db), beforeDelete, 'cancelled character deletion wrote facts')
  pass('U11.A12-delete-character-cancel', 'U11.A12', 'The delete confirmation named the selected stable-ID character; cancel preserved all facts', { targetId: first.character_id })

  setStep('U11.A12-delete-only-target-and-relations')
  await profileMenu(page, `删除角色「${firstName}」…`)
  await deleteDialog.waitFor({ state: 'visible' })
  await deleteDialog.getByRole('button', { name: '删除角色', exact: true }).click()
  await waitRosterCount(page, 999)
  assert.equal(db.prepare('SELECT retired FROM characters WHERE character_id=?').get(first.character_id)?.retired, 1)
  assert.equal(db.prepare('SELECT retired FROM characters WHERE character_id=?').get(second.character_id)?.retired, 0)
  assert.equal(db.prepare('SELECT count(*) FROM characters WHERE retired=0').pluck().get(), 999)
  const activeRelations = db.prepare(`SELECT count(*) FROM character_relationships r
    JOIN characters source ON source.character_id=r.source_character_id
    JOIN characters target ON target.character_id=r.target_character_id
    WHERE source.retired=0 AND target.retired=0`).pluck().get()
  assert.equal(activeRelations, 0, 'deleted character relation remained an active fact')
  const projection = db.prepare("SELECT characters_arch FROM project_core WHERE id='main'").pluck().get()
  assert(!projection.includes(firstName), 'formal roster projection still exposes deleted character')
  assert(projection.includes(secondName), 'formal roster projection lost surviving character')
  assert.equal(await rosterRow(page, first.character_id).count(), 0, 'retired character remains selectable in the role list')
  const graphAfterDelete = await showGraph(page)
  assert.equal(await page.locator(`button[data-graph-character-id="${first.character_id}"]`).count(), 0, 'retired character remains selectable in the graph')
  assert(!(await graphAfterDelete.getAttribute('aria-label')).includes(firstName), 'visible graph still exposes deleted relationship')
  const rawHistoricalRelations = db.prepare('SELECT count(*) FROM character_relationships').pluck().get()
  pass('U11.A12-delete-only-target-and-relations', 'U11.A12', 'Confirming 删除角色 retired only the selected ID and removed its edge from the active graph and projection; the raw historical row remains',
    { targetId: first.character_id, survivorId: second.character_id, durableSurvivors: 999, activeRelations,
      rawHistoricalRelations, historicalRowPolicy: 'raw edges from retired IDs are retained; not active roster or graph facts' })

  setStep('U11.A12-delete-all-confirmation')
  const clearDialog = page.getByRole('dialog', { name: '删除全部角色与关系？' })
  await profileMenu(page, '删除全部角色与关系…')
  await clearDialog.waitFor({ state: 'visible' })
  assert.match(await clearDialog.innerText(), /全部 999 位角色及其关系/)
  const beforeClear = rosterFacts(db)
  await clearDialog.getByRole('button', { name: '取消', exact: true }).click()
  await clearDialog.waitFor({ state: 'detached' })
  assert.equal(rosterFacts(db), beforeClear, 'cancelled graph clear wrote facts')
  await profileMenu(page, '删除全部角色与关系…')
  await clearDialog.getByRole('button', { name: '删除全部', exact: true }).click()
  await waitRosterCount(page, 0)
  assert.equal(db.prepare('SELECT count(*) FROM characters WHERE retired=0').pluck().get(), 0)
  assert.equal(db.prepare(`SELECT count(*) FROM character_relationships r JOIN characters source ON source.character_id=r.source_character_id
    JOIN characters target ON target.character_id=r.target_character_id WHERE source.retired=0 AND target.retired=0`).pluck().get(), 0)
  pass('U11.A12-delete-all-confirmation', 'U11.A12', '删除全部角色与关系 required explicit confirmation; cancellation wrote nothing and confirmation removed all active synthetic roles and relationships while retaining raw history',
    { beforeCount: 999, afterCount: 0, rawHistoricalRelations: db.prepare('SELECT count(*) FROM character_relationships').pluck().get() })
  }
}
async function verifyV3AvatarBatch(page, app, db, avatarFixture, projectId, oversizedRejected, setStep) {
  setStep('U10.A08-graph-batch-read')
  assert.deepEqual(oversizedRejected, { requestedIds: 257, errorCode: 'INVALID_CHARACTER_ID' })
  assert.equal(db.prepare('SELECT count(*) FROM characters WHERE retired=0').pluck().get(), 1000)
  assert.equal(new Set(avatarFixture.map(avatar => avatar.characterId)).size, 2)
  const before = rosterFacts(db)
  await openCast(page)
  await waitRosterCount(page, 1000)
  const probe = await app.evaluate(({ ipcMain }) => {
    const channel = 'character-avatar:read-batch'
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || typeof handlers.get(channel) !== 'function') return { installed: false }
    const original = handlers.get(channel)
    const calls = []
    globalThis.__u10AvatarProbe = { channel, original, calls }
    handlers.set(channel, async (event, ids, context) => {
      const call = { ids: [...ids], projectId: context?.projectId, leaseId: context?.leaseId,
        projectPath: context?.projectPath }
      calls.push(call)
      const response = await original.call(ipcMain, event, ids, context)
      call.success = response.success
      call.avatars = response.avatars?.map(avatar => ({ characterId: avatar.characterId, assetRevision: avatar.assetRevision })) ?? []
      return response
    })
    return { installed: true, channel, strategy: 'main IPC handler forwards production response unchanged' }
  })
  assert.equal(probe.installed, true, 'read-only batch observer could not attach')
  const canvas = await showGraph(page)
  const renderedNodes = Number(await canvas.getAttribute('data-rendered-node-count'))
  const pixels = await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas[aria-label^="角色关系图谱"]')
    if (!canvas) return false
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let magenta = 0, cyan = 0
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] > 180 && data[index + 1] < 90 && data[index + 2] > 140) magenta += 1
      if (data[index] < 90 && data[index + 1] > 150 && data[index + 2] > 150) cyan += 1
    }
    return magenta > 20 && cyan > 20 ? { magenta, cyan, width: canvas.width, height: canvas.height } : false
  }, null, { timeout: 12_000 }).then(handle => handle.jsonValue())
  const sidebar = page.getByRole('complementary', { name: '图谱人物侧栏' })
  await sidebar.getByRole('button', { name: '下一页人物' }).click()
  await sidebar.getByText('2 / 20 · 1000', { exact: true }).waitFor({ state: 'visible' })
  await sidebar.getByRole('textbox', { name: '搜索图谱人物' }).fill('角色0997')
  await sidebar.getByText('1 / 1 · 1', { exact: true }).waitFor({ state: 'visible' })
  const screenshotPath = path.join(evidenceDir, 'stage-avatar-batch-graph.png')
  await page.screenshot({ path: screenshotPath })
  const calls = await app.evaluate(() => globalThis.__u10AvatarProbe.calls)
  const observed = { probe, fixture: avatarFixture, renderedNodes, pixels, calls,
    screenshot: { path: screenshotPath, sha256: sha256(screenshotPath) },
    beforeFactsSha256: createHash('sha256').update(before).digest('hex'),
    afterFactsSha256: createHash('sha256').update(rosterFacts(db)).digest('hex') }
  assert(renderedNodes > 0 && renderedNodes <= 80, 'graph exceeded the bounded visible window')
  assert(calls.length > 0 && calls.length <= 3, 'graph avatar IPC was missing or unbounded')
  assert(calls.every(call => call.success && call.ids.length > 0 && call.ids.length <= 80
    && new Set(call.ids).size === call.ids.length && call.projectId === projectId
    && call.projectPath === path.dirname(path.dirname(db.name)) && call.leaseId),
  'batch requests were not bounded to the active project session')
  assert(avatarFixture.every(avatar => calls.some(call => call.avatars.some(view =>
    view.characterId === avatar.characterId && view.assetRevision === avatar.assetRevision))), 'batch response omitted a persisted avatar')
  assert.equal(observed.afterFactsSha256, observed.beforeFactsSha256, 'graph avatar reads wrote roster facts')
  observed.oversizedRejected = oversizedRejected
  fs.writeFileSync(path.join(evidenceDir, 'avatar-batch-observation.json'), JSON.stringify(observed, null, 2))
  pass('U10.A08-graph-batch-read', 'U10.A08', 'The thousand-person cast graph used bounded production avatar batches and painted two stable-ID avatars without roster writes', observed)
}
async function verifyV3Narrow(page, app, setStep) {
  setStep('U11.V3-narrow-graph-entry')
  await openCast(page)
  await waitRosterCount(page, 1000)
  await showGraph(page)
  const sidebar = page.getByRole('complementary', { name: '图谱人物侧栏' })
  const search = sidebar.getByRole('textbox', { name: '搜索图谱人物' })
  const next = sidebar.getByRole('button', { name: '下一页人物' })
  const fit = page.getByRole('button', { name: '适合视图' })
  const observations = []
  for (const width of [1024, 1200, 1280, 1324, 1325, 1440]) {
    setStep(`F04.V3-narrow-${width}`)
    const windowSize = await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(width, 720)
      window.webContents.setZoomFactor(1)
      return { windowSize: window.getSize(), contentSize: window.getContentSize(), zoomFactor: window.webContents.getZoomFactor() }
    }, width)
    assert.deepEqual(windowSize.contentSize, [width, 720], `${width}: native content size differed`)
    await fit.scrollIntoViewIfNeeded()
    // 纸墨顶栏：作品菜单、搜索、保存状态、沉浸写作与窗口按钮都要露在窗口里、没被盖住；图谱控件同样。
    const layout = await page.evaluate(() => {
      const visibleBox = element => {
        const rect = element.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          hit: element.contains(document.elementFromPoint(x, y)), visible: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight }
      }
      const topbar = Array.from(document.querySelectorAll('.stage-topbar > button, .stage-topbar .stage-work-title, .stage-topbar .stage-search, .stage-topbar .stage-saved, .stage-topbar .stage-window-controls button'))
        .map(element => ({ name: element.getAttribute('aria-label') || element.className, ...visibleBox(element) }))
      const names = ['canvas[aria-label^="角色关系图谱"]', 'aside[aria-label="图谱人物侧栏"]', 'input[aria-label="搜索图谱人物"]',
        'button[aria-label="缩小关系图谱"]', 'button[aria-label="放大关系图谱"]', 'button[aria-label="适合视图"]',
        'button[aria-label="重置图谱布局"]', 'button[aria-label="折叠人物侧栏"]', 'button[aria-label="下一页人物"]']
      return { viewport: { width: innerWidth, height: innerHeight }, topbar,
        elements: Object.fromEntries(names.map(name => [name, visibleBox(document.querySelector(name))])) }
    })
    const screenshotPath = path.join(evidenceDir, `stage-narrow-${width}.png`)
    const png = await page.screenshot({ path: screenshotPath })
    const evidence = { windowSize, layout, screenshot: { path: screenshotPath, sha256: sha256(screenshotPath), pixels: [png.readUInt32BE(16), png.readUInt32BE(20)] }, portals: [] }
    observations.push(evidence)
    fs.writeFileSync(path.join(evidenceDir, 'narrow-observation.json'), JSON.stringify(observations, null, 2))
    assert.equal(layout.viewport.width, width)
    assert(layout.topbar.length >= 6, `${width}: top bar controls missing`)
    assert.deepEqual(layout.topbar.filter(control => !control.visible || !control.hit).map(control => control.name), [],
      `${width}: top bar control crosses the window edge or is covered`)
    for (const [name, box] of Object.entries(layout.elements)) {
      assert.equal(box.visible, true, `${width}: ${name} crosses the window edge`)
      assert.equal(box.hit, true, `${width}: ${name} is covered`)
    }
    await fit.click()
    await next.click()
    await sidebar.getByText('2 / 20 · 1000', { exact: true }).waitFor({ state: 'visible' })
    await search.fill('角色0997')
    await sidebar.getByText('1 / 1 · 1', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await sidebar.getByRole('button', { name: '上一页人物' }).isDisabled(), true)
    await search.fill('')
    if ([1024, 1280, 1440].includes(width)) {
      for (const [item, slug] of [['导出…', 'export'], ['新建作品…', 'new']]) {
        await stage.openWorkMenuItem(page, projectName, item)
        const dialog = page.getByRole('dialog')
        await dialog.waitFor({ state: 'visible' })
        const rect = await dialog.boundingBox()
        assert(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= 720,
          `${width}: ${item} dialog crosses the window edge`)
        const hit = await dialog.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
        })
        assert.equal(hit, true, `${width}: ${item} dialog is covered`)
        const portalPath = path.join(evidenceDir, `stage-narrow-${width}-${slug}.png`)
        await page.screenshot({ path: portalPath })
        evidence.portals.push({ item, rect, hit, screenshot: { path: portalPath, sha256: sha256(portalPath) } })
        fs.writeFileSync(path.join(evidenceDir, 'narrow-observation.json'), JSON.stringify(observations, null, 2))
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
      }
    }
    pass(`F04.V3-narrow-${width}`, 'F04', 'Stage top bar controls and graph controls remain visible, uncovered and interactive; export and new-book dialogs fit the window',
      { width, screenshot: evidence.screenshot, topbar: layout.topbar, graph: layout.elements, portals: evidence.portals })
  }
}
async function verifyV3GraphCore(page, db, setStep) {
  setStep('U11.A01-five-importance-tiers')
  await assertStage(page, 'U11.A01')
  const names = [firstName, secondName, thirdName, fourthName, fifthName]
  const rows = db.prepare('SELECT character_id,name FROM characters WHERE retired=0').all()
  assert.deepEqual(new Set(rows.map(row => row.name)), new Set(names))
  const beforeFacts = rosterFacts(db)
  await openCast(page)
  await waitRosterCount(page, 5)
  await page.evaluate(() => {
    const probe = { frame: 0, arcs: [], labels: [], lastArc: null }
    window.__f05GraphProbe = probe
    const proto = CanvasRenderingContext2D.prototype
    const clear = proto.clearRect, arc = proto.arc, fillText = proto.fillText
    const graph = context => context.canvas.matches('canvas[aria-label^="角色关系图谱"]')
    proto.clearRect = function (...args) {
      if (graph(this)) { probe.frame += 1; probe.arcs = []; probe.labels = []; probe.lastArc = null }
      return clear.apply(this, args)
    }
    proto.arc = function (...args) {
      if (graph(this)) {
        const [x, y, r] = args
        probe.lastArc = { x, y, r }
        probe.arcs.push(probe.lastArc)
      }
      return arc.apply(this, args)
    }
    proto.fillText = function (...args) {
      if (graph(this)) {
        const [label] = args
        const { a, c, d, e, f } = this.getTransform()
        probe.labels.push({ label, arc: probe.lastArc, transform: { a, c, d, e, f } })
      }
      return fillText.apply(this, args)
    }
  })
  const canvas = await showGraph(page)
  const sidebar = page.getByRole('complementary', { name: '图谱人物侧栏' })
  await sidebar.getByRole('button', { name: `以${firstName}为中心` }).click()
  await page.getByText(`中心: ${firstName}`, { exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(expected => expected.every(name => window.__f05GraphProbe?.labels.some(item => item.label === name)), names)
  const paint = () => page.evaluate(expected => {
    const canvas = document.querySelector('canvas[aria-label^="角色关系图谱"]')
    const probe = window.__f05GraphProbe
    const rect = canvas.getBoundingClientRect(), ratio = canvas.width / rect.width
    return { frame: probe.frame, radii: [...new Set(probe.arcs.map(item => item.r))], width: rect.width, height: rect.height,
      left: rect.left, top: rect.top, nodes: probe.labels.filter(item => expected.includes(item.label) && item.arc).map(item => ({
        name: item.label, x: item.arc.x, y: item.arc.y, radius: item.arc.r, scale: item.transform.a,
        screenX: rect.left + (item.transform.a * item.arc.x + item.transform.c * item.arc.y + item.transform.e) / ratio,
        screenY: rect.top + (item.transform.d * item.arc.y + item.transform.f) / ratio,
      })) }
  }, names)
  const initial = await paint()
  assert.equal(initial.nodes.length, 5, 'all five durable roles were not painted')
  assert.deepEqual([16, 18, 20, 22, 24].every(radius => initial.radii.includes(radius)), true, 'five importance tiers were not painted')
  assert.equal(Number(await canvas.getAttribute('data-rendered-node-count')), 5)
  pass('U11.A01-five-importance-tiers', 'U11.A01', 'The cast graph painted five stable-ID roles at five distinct importance radii',
    { durableIds: rows.map(row => row.character_id), radii: initial.nodes.map(node => ({ name: node.name, radius: node.radius })) })

  setStep('U11.A02-center-character')
  await sidebar.getByRole('button', { name: `以${thirdName}为中心` }).click()
  await page.getByText(`中心: ${thirdName}`, { exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(frame => window.__f05GraphProbe.frame > frame, initial.frame)
  const centered = await paint()
  assert.equal(centered.nodes.length, 5)
  assert.notDeepEqual(centered.nodes.map(node => [node.name, node.x, node.y]), initial.nodes.map(node => [node.name, node.x, node.y]), 'center change did not relayout nodes')
  pass('U11.A02-center-character', 'U11.A02', 'Visible center control relaid out the five durable roles around the selected character',
    { centerId: rows.find(row => row.name === thirdName).character_id, centerName: thirdName })

  setStep('U11.A03-drag-node')
  const target = centered.nodes.find(node => node.name === thirdName)
  await page.mouse.move(target.screenX, target.screenY)
  await page.mouse.down()
  await page.mouse.move(target.screenX + 32, target.screenY + 12, { steps: 4 })
  await page.mouse.up()
  const dragged = await paint()
  const moved = dragged.nodes.find(node => node.name === thirdName)
  assert(Math.hypot(moved.x - target.x, moved.y - target.y) > 20, 'pointer drag did not move the graph node')
  assert.equal(rosterFacts(db), beforeFacts, 'node drag wrote roster facts')
  pass('U11.A03-drag-node', 'U11.A03', 'Real pointer drag moved the selected painted node without changing durable facts',
    { characterId: rows.find(row => row.name === thirdName).character_id, before: [target.x, target.y], after: [moved.x, moved.y] })

  setStep('U11.A04-pan-blank-canvas')
  const candidates = [[0.14, 0.2], [0.14, 0.8], [0.7, 0.8]].map(([x, y]) => ({ x: dragged.left + dragged.width * x, y: dragged.top + dragged.height * y }))
  const blank = candidates.map(point => ({ ...point, gap: Math.min(...dragged.nodes.map(node => Math.hypot(point.x - node.screenX, point.y - node.screenY))) }))
    .sort((a, b) => b.gap - a.gap)[0]
  assert(blank.gap > 60, 'no verified blank canvas point available for panning')
  await page.mouse.move(blank.x, blank.y)
  await page.mouse.down()
  await page.mouse.move(blank.x - 30, blank.y + 20, { steps: 4 })
  await page.mouse.up()
  const panned = await paint()
  const pannedTarget = panned.nodes.find(node => node.name === thirdName)
  assert(Math.abs(pannedTarget.screenX - moved.screenX + 30) < 5 && Math.abs(pannedTarget.screenY - moved.screenY - 20) < 5,
    'blank drag did not translate the painted graph view')
  assert.equal(pannedTarget.x, moved.x, 'blank drag moved a node instead of the view')
  pass('U11.A04-pan-blank-canvas', 'U11.A04', 'Real pointer drag on verified blank canvas shifted the graph view and left node world positions unchanged',
    { shift: [pannedTarget.screenX - moved.screenX, pannedTarget.screenY - moved.screenY] })

  setStep('U11.A05-wheel-zoom')
  await page.mouse.move(blank.x - 30, blank.y + 20)
  await page.mouse.wheel(0, 100)
  await page.waitForFunction(before => {
    const label = document.querySelector('button[aria-label="缩小关系图谱"]')?.nextElementSibling?.textContent ?? ''
    return Number.parseInt(label, 10) < Math.round(before * 100)
  }, panned.nodes[0].scale)
  const zoomed = await paint()
  assert(zoomed.nodes[0].scale < panned.nodes[0].scale, 'real wheel did not shrink graph scale')
  const zoomLabel = await page.getByRole('button', { name: '缩小关系图谱' }).locator('xpath=following-sibling::span[1]').innerText()
  assert.equal(zoomLabel, `${Math.round(zoomed.nodes[0].scale * 100)}%`, 'visible zoom label disagreed with painted scale')
  pass('U11.A05-wheel-zoom', 'U11.A05', 'Real wheel input changed canvas scale and the visible zoom percentage together',
    { beforeScale: panned.nodes[0].scale, afterScale: zoomed.nodes[0].scale, zoomLabel })

  setStep('U11.A06-fit-and-reset')
  await page.getByRole('button', { name: '适合视图' }).click()
  const fitted = await paint()
  assert.notDeepEqual([fitted.nodes[0].scale, fitted.nodes[0].screenX], [zoomed.nodes[0].scale, zoomed.nodes[0].screenX], 'fit view did not adjust canvas')
  assert(fitted.nodes.every(node => node.screenX >= fitted.left && node.screenX <= fitted.left + fitted.width
    && node.screenY >= fitted.top && node.screenY <= fitted.top + fitted.height), 'fit view left a graph node off canvas')
  await page.getByRole('button', { name: '重置图谱布局' }).click()
  const reset = await paint()
  const resetTarget = reset.nodes.find(node => node.name === thirdName)
  assert.deepEqual([resetTarget.x, resetTarget.y], [target.x, target.y], 'reset did not restore original node position')
  assert.equal(rosterFacts(db), beforeFacts, 'fit or reset wrote roster facts')
  pass('U11.A06-fit-and-reset', 'U11.A06', 'Visible fit and reset controls restored the moved graph node and left durable facts unchanged',
    { draggedPosition: [moved.x, moved.y], resetPosition: [resetTarget.x, resetTarget.y], factHash: createHash('sha256').update(beforeFacts).digest('hex') })

  setStep('U11.A07-collapse-sidebar')
  const widthBefore = (await canvas.boundingBox()).width
  await page.getByRole('button', { name: '折叠人物侧栏' }).click()
  await sidebar.waitFor({ state: 'detached' })
  const widthCollapsed = (await canvas.boundingBox()).width
  assert(widthCollapsed > widthBefore, 'collapsing graph sidebar did not give space to canvas')
  await page.getByRole('button', { name: '展开人物侧栏' }).click()
  await sidebar.waitFor({ state: 'visible' })
  assert.equal(rosterFacts(db), beforeFacts, 'sidebar toggle wrote roster facts')
  pass('U11.A07-collapse-sidebar', 'U11.A07', 'Visible graph sidebar collapsed and reopened, expanding the canvas without writing facts',
    { widthBefore, widthCollapsed, restoredCharacters: await sidebar.locator('button[data-graph-character-id]').count() })
}

async function verifyV3Proposal(page, db, fixture, setStep) {
  setStep('U11.A10-generate-proposal')
  await assertStage(page, 'U11.A10')
  const sentinelBefore = db.prepare('SELECT * FROM characters WHERE name=? AND retired=0').get(sentinelName)
  assert(sentinelBefore?.character_id, 'unrelated synthetic role was not persisted')
  assert.equal(db.prepare('SELECT count(*) FROM character_relationships').pluck().get(), 0)
  // 旧外壳「小说配置」的创作想法是设定页的核心大纲。
  await stage.stageButton(page, '设定').click()
  await stage.setupOutline(page).fill(premise)
  await page.keyboard.press('ControlOrMeta+s')
  await stage.saveStatus(page).filter({ hasText: /^已保存$/ }).waitFor({ state: 'visible' })
  // 架构阶段的「生成架构」只勾角色名单。
  await arch.open(page)
  if (await arch.primary(page).filter({ hasText: /生成架构/ }).count() > 0) await arch.primary(page).click()
  else {
    await page.getByRole('button', { name: '架构的更多操作' }).click()
    await page.getByRole('menuitem', { name: 'AI 生成架构…' }).click()
  }
  await arch.dialog(page).waitFor({ state: 'visible' })
  await arch.selectOnly(page, ['characters'])
  await arch.startGenerate(page)
  // 候选要作者确认：运行侧页里这次运行停在「需要你确认」，同一个批量选择面板。
  await runSheet.openFromPalette(page)
  await runSheet.tab(page, '进行中').click()
  const panel = runSheet.sheet(page).getByRole('region', { name: '需要你确认' })
  await panel.waitFor({ state: 'visible', timeout: 60_000 })
  const selection = panel.getByRole('region', { name: '批量选择角色采用方式' })
  for (const name of [firstName, secondName, thirdName]) await selection.getByText(new RegExp(`^${name} ·`)).waitFor({ state: 'visible' })
  const relation = selection.locator('label').filter({ hasText: `${firstName} → ${secondName}：${relationship}` }).getByRole('checkbox')
  assert.equal(await relation.isChecked(), true, 'generated relation was not selected by default')
  const pending = db.prepare("SELECT proposal_id,raw_value FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'").all()
  assert.equal(pending.length, 1, 'formal generation must persist one proposal batch')
  const beforeBatch = JSON.parse(pending[0].raw_value).batch
  assert.equal(beforeBatch.status, 'pending-approval')
  assert.equal(beforeBatch.source.kind, 'generation')
  assert.equal(beforeBatch.source.inputKind, 'architecture')
  assert.deepEqual(db.prepare('SELECT name FROM characters WHERE retired=0 ORDER BY name').all(), [{ name: sentinelName }], 'proposal wrote formal roles before adoption')
  assert(fixture.requests.length >= 2 && fixture.requests.length <= 4, 'character architecture request count exceeded bounded manifest/details batches')
  assert(fixture.requests.every(request => request.method === 'POST' && request.path === '/v1/chat/completions' && request.authorized))
  assert.deepEqual(fixture.requests.slice(1).flatMap(request => request.slotIds).sort(), ['slot-0', 'slot-1', 'slot-2'], 'details requests did not cover frozen slots exactly once')
  pass('U11.A10-generate-proposal', 'U11.A10', 'The architecture generate dialog (角色名单 only) produced a durable pending relationship proposal through bounded authorized local provider calls without changing the formal roster',
    { proposalBatchId: pending[0].proposal_id, source: beforeBatch.source.kind, syntheticRequests: fixture.requests })

  setStep('U11.A10-explicit-adoption')
  const relationLabel = selection.locator('label').filter({ hasText: `${firstName} → ${secondName}：${relationship}` })
  await relationLabel.click()
  assert.equal(await relation.isChecked(), false, 'relation choice did not respond to user input')
  await relationLabel.click()
  assert.equal(await relation.isChecked(), true, 'relation choice was not restored before adoption')
  const confirm = panel.getByRole('button', { name: '按当前选择确认', exact: true })
  await confirm.waitFor({ state: 'visible' })
  assert.equal(await confirm.isEnabled(), true, 'adoption unavailable to current project session')
  await confirm.click()
  const deadline = Date.now() + 30_000
  let batch
  while (Date.now() < deadline) {
    batch = JSON.parse(db.prepare('SELECT raw_value FROM character_identity_proposals WHERE proposal_id=?').pluck().get(pending[0].proposal_id)).batch
    if (batch.status === 'approved') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(batch?.status, 'approved', 'visible confirmation did not approve durable proposal')
  const generated = db.prepare('SELECT character_id,name,retired FROM characters WHERE name IN (?,?,?) ORDER BY name').all(firstName, secondName, thirdName)
  assert.equal(generated.length, 3)
  assert(generated.every(row => row.character_id && !row.character_id.startsWith('draft:') && row.retired === 0), 'adopted role lacks active stable ID')
  const first = generated.find(row => row.name === firstName)
  const second = generated.find(row => row.name === secondName)
  const relations = db.prepare('SELECT source_character_id,target_character_id,relation FROM character_relationships').all()
  assert.deepEqual(relations, [{ source_character_id: first.character_id, target_character_id: second.character_id, relation: relationship }])
  assert.deepEqual(db.prepare('SELECT * FROM characters WHERE character_id=?').get(sentinelBefore.character_id), sentinelBefore, 'adoption changed unrelated character')
  assert.equal(db.prepare('SELECT count(*) FROM characters WHERE retired=0').pluck().get(), 4)
  assert.equal(db.prepare('SELECT count(*) FROM character_identity_approvals WHERE operation_id=?').pluck().get(batch.approvalOperationId), 1, 'adoption business receipt missing')
  pass('U11.A10-explicit-adoption', 'U11.A10', 'The relationship choice and 按当前选择确认 in the run sheet adopted only the three proposed stable-ID roles and one relation; the unrelated role stayed byte-for-byte unchanged',
    { proposalBatchId: batch.proposalBatchId, approvalOperationId: batch.approvalOperationId, generated, relations, sentinelId: sentinelBefore.character_id })
}
async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U11 graph profile', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'isolated synthetic stage receipt',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
    AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
    APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  let app
  let db
  let cleanupConfirmed = false
  let currentStep = 'launch'
  let failure = null
  let diagnostic = null
  let projectPath = null
  let page
  let avatarFixture = null
  let avatarProjectId = null
  let avatarOversized = null
  const fixture = { requests: [] }
  const server = a10Only ? createServer(async (request, response) => {
    const authorized = request.headers.authorization === `Bearer ${model.apiKey}`
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || !authorized || fixture.requests.length >= 4) {
      fixture.requests.push({ method: request.method, path: request.url, authorized, slotIds: [] })
      response.writeHead(403).end(); return
    }
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
    const taskText = body.messages?.map(message => message.content).filter(value => typeof value === 'string').join('\n') ?? ''
    const batchLine = /【本批必须完整生成的 slotId】\s*\n([^\n]+)/u.exec(taskText)?.[1]
    const slotIds = batchLine ? batchLine.split(',').map(value => value.trim()) : []
    fixture.requests.push({ method: request.method, path: request.url, authorized, slotIds })
    const slots = [firstName, secondName, thirdName].map((name, index) => ({ slotId: `slot-${index}`, name,
      role: index === 0 ? 'protagonist' : 'supporting', narrativeDuty: '核对旧港线索',
      relations: index === 0 ? [{ targetSlotId: 'slot-1', relation: relationship }] : [] }))
    const entries = slots.map(slot => ({ slotId: slot.slotId, name: slot.name, role: slot.role,
      gender: '未知', age: '成年', appearance: '携带旧港记录', personality: '谨慎', background: '潮汐城居民', abilities: '核对证据',
      motivation: '查明真相', arc: '学会信任同伴', notes: '合成角色', currentState: { location: '旧港', powerLevel: '普通',
        physicalState: '健康', mentalState: '警觉', keyItems: '档案', recentEvents: '发现线索', updatedAtChapter: 0 } }))
    if (fixture.requests.length > 1 && (slotIds.length === 0 || slotIds.some(id => !slots.some(slot => slot.slotId === id)))) {
      response.writeHead(422).end(); return
    }
    const content = JSON.stringify(fixture.requests.length === 1 ? { slots } : { entries: entries.filter(entry => slotIds.includes(entry.slotId)) })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  }) : null
  const mode = avatarOnly ? 'v3-avatar-batch-only' : narrowOnly ? 'v3-narrow-only' : graphCoreOnly ? 'v3-a01-a07-only' : a08Only ? 'v3-a08-only'
    : a09Only ? 'v3-a09-only' : a10Only ? 'v3-a10-only' : a12Only ? 'v3-a12-only' : graphRemainingOnly ? 'v3-a11-a13-only' : 'v3-a10-a13'
  try {
    if (server) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
    if (server) await app.evaluate((_, port) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, options) => {
        const url = new URL(String(input))
        if (url.origin !== 'https://api.openai.com' || !url.pathname.startsWith('/v1/')) throw new Error('F05_U11_NETWORK_REFUSED')
        return originalFetch(`http://127.0.0.1:${port}${url.pathname}`, options)
      }
    }, server.address().port)
    page = await app.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(12_000)
    await stage.waitForStage(page)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    currentStep = 'fixture-project'
    const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, profile.projects)).grantId, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    projectPath = created.projectPath
    assert.equal(path.relative(scratch, projectPath).startsWith('..'), false)
    currentStep = a10Only ? 'fixture-proposal-prerequisites' : graphCoreOnly ? 'fixture-five-tier-graph'
      : a08Only ? 'fixture-same-name-stable-id-roster' : a09Only ? 'fixture-two-stable-id-old-relation' : 'fixture-1000-character-roster'
    const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const session = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
    const roster = await invoke(page, 'db:character-roster-read', projectPath, session)
    const names = a10Only ? [sentinelName] : graphCoreOnly ? [firstName, secondName, thirdName, fourthName, fifthName]
      : a08Only || a09Only ? [firstName, secondName]
      : [firstName, secondName, ...Array.from({ length: 998 }, (_, index) => `角色${String(index).padStart(4, '0')}`)]
    const entries = names.map((name, index) => ({ characterId: `draft:${randomUUID()}`, name,
      role: index === 0 ? 'protagonist' : 'supporting', gender: '', age: '', appearance: '', personality: '',
      background: '', abilities: '', motivation: '', relationships: [], arc: '',
      notes: a08Only ? index === 0 ? a08TargetNotes : a08OtherNotes : '' }))
    if (graphCoreOnly) for (let index = 0; index < 4; index++) entries[index].relationships = [
      { target: names[index + 1], targetCharacterId: entries[index + 1].characterId, relation: relationship }]
    else if (a09Only) entries[0].relationships = [{ target: secondName, targetCharacterId: entries[1].characterId, relation: initialRelationship }]
    else if (!a10Only && !a08Only) entries[0].relationships = [{ target: secondName, targetCharacterId: entries[1].characterId, relation: relationship }]
    const seeded = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
      expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries }, projectPath, session)
    assert.equal(seeded.success, true, JSON.stringify(seeded))
    if (avatarOnly) {
      avatarProjectId = created.projectId
      const FixtureDatabase = createRequire(import.meta.url)('better-sqlite3')
      const fixtureDb = new FixtureDatabase(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
      let ids
      try { ids = fixtureDb.prepare('SELECT character_id,name FROM characters WHERE retired=0 AND name IN (?, ?) ORDER BY name').all(firstName, secondName) }
      finally { fixtureDb.close() }
      assert.equal(ids.length, 2)
      avatarFixture = []
      for (const [row, color] of ids.map((row, index) => [row, index === 0 ? '#ef00d7' : '#00e8e8'])) {
        const base64 = await page.evaluate(color => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 32
          const context = canvas.getContext('2d')
          context.fillStyle = color
          context.fillRect(0, 0, 32, 32)
          return canvas.toDataURL('image/png').split(',')[1]
        }, color)
        const committed = await invoke(page, 'character-avatar:commit', row.character_id, base64, session)
        assert.equal(committed.success, true, JSON.stringify(committed.error))
        avatarFixture.push({ characterId: row.character_id, name: row.name, color,
          assetRevision: committed.avatar.assetRevision, sha256: createHash('sha256').update(Buffer.from(committed.avatar.base64, 'base64')).digest('hex') })
      }
      const beforeOversized = new FixtureDatabase(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
      try {
        const facts = rosterFacts(beforeOversized)
        const oversized = await invoke(page, 'character-avatar:read-batch',
          Array.from({ length: 257 }, (_, index) => `character-${index}`), session)
        assert.equal(oversized.success, false, 'oversized avatar batch was accepted')
        assert.equal(oversized.error.code, 'INVALID_CHARACTER_ID')
        assert.equal(rosterFacts(beforeOversized), facts, 'oversized avatar batch wrote roster facts')
        avatarOversized = { requestedIds: 257, errorCode: oversized.error.code }
      } finally { beforeOversized.close() }
    }
    if (a08Only) {
      const FixtureDatabase = createRequire(import.meta.url)('better-sqlite3')
      const fixtureDb = new FixtureDatabase(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true })
      try {
        const other = fixtureDb.prepare('SELECT character_id FROM characters WHERE retired=0 AND name=?').get(secondName)
        assert(other?.character_id, 'A08 second stable ID missing before synthetic same-name fixture setup')
        const renamed = fixtureDb.prepare('UPDATE characters SET name=? WHERE character_id=?').run(firstName, other.character_id)
        assert.equal(renamed.changes, 1, 'A08 synthetic name collision did not update exactly the selected stable ID')
        const sameNameRows = fixtureDb.prepare('SELECT character_id, notes FROM characters WHERE retired=0 AND name=?').all(firstName)
        assert.equal(sameNameRows.length, 2)
        assert.equal(new Set(sameNameRows.map(row => row.character_id)).size, 2)
        assert.deepEqual(new Set(sameNameRows.map(row => row.notes)), new Set([a08TargetNotes, a08OtherNotes]))
      } finally { fixtureDb.close() }
    }
    if (a10Only) {
      assert.equal((await invoke(page, 'db:project-core-update', { premise }, projectPath, session)).success, true)
      assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
      assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
    }
    await page.reload()
    await assertStage(page, 'fixture-project')
    await openProject(page)
    const Database = createRequire(import.meta.url)('better-sqlite3')
    db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true })
    currentStep = avatarOnly ? 'U10.A08-stage-graph-entry' : graphCoreOnly ? 'U11.A01-stage-graph-entry' : a08Only ? 'U11.A08-stage-graph-entry' : a09Only ? 'U11.A09-stage-graph-entry' : a10Only ? 'U11.A10-stage-architecture-entry'
      : a12Only ? 'U11.A12-stage-graph-entry' : 'U11.A13-stage-graph-entry'
    if (avatarOnly) await verifyV3AvatarBatch(page, app, db, avatarFixture, avatarProjectId, avatarOversized, step => { currentStep = step })
    else if (narrowOnly) await verifyV3Narrow(page, app, step => { currentStep = step })
    else if (graphCoreOnly) await verifyV3GraphCore(page, db, step => { currentStep = step })
    else if (a08Only) await verifyV3A08(page, db, step => { currentStep = step })
    else if (a09Only) await verifyV3A09(page, db, step => { currentStep = step })
    else if (a10Only) await verifyV3Proposal(page, db, fixture, step => { currentStep = step })
    else await verifyV3Graph(page, db, step => { currentStep = step })
  } catch (error) {
    failure = String(error)
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidenceDir, 'failure.png') }).catch(() => {})
    if (avatarOnly && app) diagnostic = await app.evaluate(() => globalThis.__u10AvatarProbe?.calls ?? []).catch(() => [])
    if (a10Only && page) diagnostic = { syntheticRequests: fixture.requests,
      visibleAlerts: await page.locator('[role="alert"]').allTextContents().catch(() => []),
      runSheet: await runSheet.sheet(page).allTextContents().catch(() => []) }
  }
  finally {
    if (avatarOnly && app) {
      try { await app.evaluate(({ ipcMain }) => {
        const probe = globalThis.__u10AvatarProbe
        if (probe) { ipcMain._invokeHandlers.set(probe.channel, probe.original); delete globalThis.__u10AvatarProbe }
      }) }
      catch (error) { failure = [failure, `observer cleanup: ${String(error)}`].filter(Boolean).join('; ') }
    }
    try { db?.close() }
    catch (error) { failure = [failure, `database cleanup: ${String(error)}`].filter(Boolean).join('; ') }
    if (app) {
      try { await quit(app); cleanupConfirmed = true }
      catch (error) { failure = [failure, `cleanup: ${String(error)}`].filter(Boolean).join('; ') }
    }
    if (server) await new Promise(resolve => server.close(resolve))
    assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256, 'driver changed during run')
    const verified = actionId => actionId === 'U11.A12'
      ? ['U11.A12-delete-character-cancel', 'U11.A12-delete-only-target-and-relations', 'U11.A12-delete-all-confirmation']
        .every(stepId => steps.some(step => step.stepId === stepId && step.outcome === 'PASS'))
      : actionId === 'U11.A10'
        ? ['U11.A10-generate-proposal', 'U11.A10-explicit-adoption']
          .every(stepId => steps.some(step => step.stepId === stepId && step.outcome === 'PASS'))
      : steps.some(step => step.actionId === actionId && step.outcome === 'PASS')
    const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL',
      qualification: avatarOnly ? 'F05_U10_A08_V3_PARTIAL' : narrowOnly ? 'F04_V3_NARROW_GRAPH_PARTIAL' : graphCoreOnly ? 'F05_U11_A01_A07_V3_PARTIAL' : a08Only ? 'F05_U11_A08_V3_PARTIAL' : a09Only ? 'F05_U11_A09_V3_PARTIAL' : a10Only ? 'F05_U11_A10_V3_PARTIAL' : a12Only ? 'F05_U11_A12_V3_PARTIAL' : graphRemainingOnly ? 'F05_U11_A11_A13_V3_PARTIAL' : 'F05_U11_A10_A13_V3_PARTIAL', evidenceLevel: 'electron',
      testedSha, executionHead, changedPaths, sourceDirtyPaths: git('status', '--porcelain').split('\n').filter(Boolean),
      driverSha256,
      fixtureSetup: a09Only ? { method: 'character-roster-commit with two stable IDs and old relation; UI alone edits relation',
        firstName, secondName, initialRelation: initialRelationship, editedRelation: relationship }
        : a08Only ? { method: 'character-roster-commit with unique names and distinct notes, then isolated SQLite rename by character_id',
        firstName, secondName, duplicateName: firstName, distinctField: 'notes', targetNotes: a08TargetNotes, otherNotes: a08OtherNotes } : null,
      packageRoot: packageDir, shell: 'stage', mode,
      artifact: { executableSha256: sha256(executablePath), asarSha256: sha256(asarPath) },
      nodeAbi: process.versions.modules, cleanupConfirmed, isolatedRoot: scratch, projectPath, failedStep: failure ? currentStep : null,
      error: failure, diagnostic: failure ? diagnostic : null, steps,
      unverified: (avatarOnly ? ['U10.A01-U10.A07', 'U11.A08-U11.A13']
        : graphCoreOnly ? ['U11.A08', 'U11.A09', 'U11.A10', 'U11.A11', 'U11.A12', 'U11.A13']
        : narrowOnly ? ['U11.A08', 'U11.A09', 'U11.A10', 'U11.A11', 'U11.A12', 'U11.A13']
        : a08Only ? ['U11.A09', 'U11.A10', 'U11.A11', 'U11.A12', 'U11.A13']
        : a09Only ? ['U11.A08', 'U11.A10', 'U11.A11', 'U11.A12', 'U11.A13']
          : ['U11.A10', 'U11.A11', 'U11.A12', 'U11.A13']).filter(id => !verified(id)) }
    const receiptPath = path.join(evidenceDir, 'receipt.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(JSON.stringify({ outcome: receipt.outcome, failedStep: receipt.failedStep, steps: steps.map(step => step.stepId), receiptPath }) + '\n')
  }
  if (failure) throw new Error(failure)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
