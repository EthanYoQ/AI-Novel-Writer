/* global process, Buffer */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const a08Only = process.argv.includes('--v3-a08-only')
const a09Only = process.argv.includes('--v3-a09-only')
const a12Only = process.argv.includes('--v3-a12-only')
const a10Only = process.argv.includes('--v3-a10-only')
const v3Mode = a08Only || a09Only || a10Only || a12Only || process.argv.includes('--v3-a10-a13')
const buildReceiptPath = process.argv.find(arg => arg.startsWith('--reuse-package='))?.slice('--reuse-package='.length)
assert(v3Mode || buildReceiptPath, 'pass --reuse-package=<build receipt>, --v3-a08-only, --v3-a09-only, --v3-a10-a13, --v3-a12-only or --v3-a10-only')
const buildReceipt = buildReceiptPath ? JSON.parse(fs.readFileSync(buildReceiptPath, 'utf8')) : null
const testedSha = v3Mode ? 'e803b10c461cddbb567ad925743b164f42af9e1a' : buildReceipt.build?.buildSha
if (!v3Mode) assert.equal(testedSha, 'c6fd2b5e02230d4ddd6e20d92c66bcf8a8f77010')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const executionHead = git('rev-parse', 'HEAD')
const changedPaths = git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean)
assert(changedPaths.every(name => name.startsWith('scripts/') || name.includes('/__tests__/') || (v3Mode && name.startsWith('docs/'))), 'product source changed since package build')
const dirtyProduct = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml')
  .split('\n').filter(Boolean).filter(line => !/src\/.*\/__tests__\//.test(line))
assert.deepEqual(dirtyProduct, [], 'dirty product input since package build')
const packageDir = v3Mode
  ? path.join(repository, '.runtime', '.cache', 'f05-u12-m06-package', 'e803b10c', 'win-unpacked')
  : path.join(repository, 'release', '1.1.0', 'win-unpacked')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
assert.equal(sha256(executablePath), v3Mode ? '35f08ef5f2317f7151d6a2a0884531106a0bb2fba926cab7d09ff50b5f2e8f11' : buildReceipt.artifact.executableSha256)
assert.equal(sha256(asarPath), v3Mode ? '6aa5c19a88481eef994df8d1e4050578e8c860d314ee8e6662656b967b2d190c' : buildReceipt.artifact.asarSha256)
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
const sentinelName = `原有角色${runId.slice(0, 6)}`
const a08TargetNotes = `U11.A08 档案哨兵甲 ${runId}`
const a08OtherNotes = `U11.A08 档案哨兵乙 ${runId}`
const model = { id: 'f05-u11-synthetic', name: 'U11 隔离合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'f05-u11-offline-only', maxTokens: 4096, temperature: 0.7, purposes: ['generation'] }
const premise = '在潮汐城，守塔人发现被封存的港口档案。调查者沿钟声记录找到三条线索，必须在城门关闭前核对证人、地图和旧港的通行记录。'.repeat(2)
const steps = []
const pass = (stepId, actionId, assertion, observed) => steps.push({ stepId, actionId, outcome: 'PASS', assertion, observed })
const writer = page => page.locator('[data-shell-presentation="writer"]')
async function assertWriter(page, step) {
  await writer(page).waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await writer(page).getAttribute('data-shell-presentation'), 'writer', `${step}: wrong shell`)
  if (v3Mode) assert.equal(await writer(page).getAttribute('data-shell-variant'), 'v3', `${step}: wrong shell variant`)
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
async function setWriter(page) {
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const old = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...old, shellPreference: 'writer', revision: Number(old.revision ?? 0) + 1, origin: 'author' }))
  })
  await page.reload()
  await assertWriter(page, 'profile-selected')
}
async function addCharacter(page, name) {
  await assertWriter(page, `add-${name}`)
  await page.getByTitle('新建角色').click()
  await page.getByText('姓名', { exact: true }).locator('xpath=..').locator('input').fill(name)
  await page.getByRole('button', { name: '保存', exact: true }).last().click()
  await page.getByText('已保存', { exact: true }).last().waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.writer-left-rail').getByRole('button', { name: '角色', exact: true }).waitFor({ state: 'visible' })
}
async function quit(app) {
  const pid = app.process().pid
  let timer
  const closed = await Promise.race([app.close().then(() => true).catch(() => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 10_000) })])
  clearTimeout(timer)
  if (!closed) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' }) }
    catch { /* A process that exited during taskkill is checked below. */ }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0) }
    catch (error) { if (error.code === 'ESRCH') return; throw error }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Electron PID ${pid} did not exit`)
}
function rosterFacts(db) {
  return JSON.stringify({
    characters: db.prepare('SELECT character_id, name, retired FROM characters ORDER BY character_id').all(),
    relationships: db.prepare('SELECT source_character_id, target_character_id, relation FROM character_relationships ORDER BY relationship_id').all(),
    revision: db.prepare("SELECT revision FROM character_roster_meta WHERE id='main'").pluck().get(),
  })
}
async function verifyV3A08(page, db, setStep) {
  setStep('U11.A08-v3-graph-to-profile')
  await assertWriter(page, 'U11.A08')
  const duplicateRows = db.prepare('SELECT character_id, name, notes FROM characters WHERE retired=0 AND name=? ORDER BY character_id').all(firstName)
  assert.equal(duplicateRows.length, 2, 'A08 fixture must contain exactly two active same-name stable IDs')
  const target = duplicateRows.find(row => row.notes === a08TargetNotes)
  const other = duplicateRows.find(row => row.notes === a08OtherNotes)
  assert(target?.character_id && other?.character_id && target.character_id !== other.character_id)
  assert.equal(target.name, other.name)
  assert.notEqual(target.notes, other.notes, 'same-name profiles need a distinct non-name sentinel field')

  await page.locator('.writer-left-rail button[title="角色"]').click()
  await page.getByText('角色列表（2）', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '关系图谱', exact: true }).click()
  const canvas = page.locator('canvas[aria-label^="角色关系图谱"]')
  await canvas.waitFor({ state: 'visible' })
  const sidebar = page.getByRole('complementary', { name: '图谱人物侧栏' })
  const targetGraphButton = sidebar.locator(`button[data-graph-character-id="${target.character_id}"]`)
  await targetGraphButton.waitFor({ state: 'visible' })
  assert.equal(await sidebar.locator(`button[data-graph-character-id="${other.character_id}"]`).count(), 1)
  await targetGraphButton.click()
  await page.getByText(`${target.name} — 编辑档案`, { exact: true }).waitFor({ state: 'visible' })

  const selectedProfile = page.locator(`[data-character-id="${target.character_id}"]`)
  const otherProfile = page.locator(`[data-character-id="${other.character_id}"]`)
  const targetClickSelectedTarget = await selectedProfile.getAttribute('aria-pressed')
  const targetClickSelectedOther = await otherProfile.getAttribute('aria-pressed')
  assert.equal(targetClickSelectedTarget, 'true', 'graph click did not select its stable character ID')
  assert.equal(targetClickSelectedOther, 'false', 'same-name profile with another stable ID was selected')
  const notesField = page.locator('textarea[placeholder="输入备注..."]')
  const targetClickNotes = await notesField.inputValue()
  assert.equal(targetClickNotes, target.notes, 'opened profile notes do not match the clicked stable ID')
  assert.notEqual(targetClickNotes, other.notes, 'opened profile notes came from the other same-name character')

  await page.getByRole('button', { name: '关系图谱', exact: true }).click()
  await canvas.waitFor({ state: 'visible' })
  const otherGraphButton = sidebar.locator(`button[data-graph-character-id="${other.character_id}"]`)
  await otherGraphButton.waitFor({ state: 'visible' })
  await otherGraphButton.click()
  await page.waitForFunction(({ targetId, otherId, otherNotes }) => {
    const profileFor = id => Array.from(document.querySelectorAll('[data-character-id]'))
      .find(profile => profile.getAttribute('data-character-id') === id)
    const targetProfile = profileFor(targetId)
    const otherProfile = profileFor(otherId)
    const notesField = document.querySelector('textarea[placeholder="输入备注..."]')
    return targetProfile?.getAttribute('aria-pressed') === 'false'
      && otherProfile?.getAttribute('aria-pressed') === 'true'
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
    'V3 graph sidebar clicks opened each same-name stable ID independently; selected IDs and distinct notes matched, with no A09 write',
    { targetCharacterId: target.character_id, otherCharacterId: other.character_id, sharedName: target.name,
      targetNotes: target.notes, otherNotes: other.notes,
      targetClick: { selectedTarget: targetClickSelectedTarget, selectedOther: targetClickSelectedOther, notes: targetClickNotes },
      otherClick: { selectedTarget: otherClickSelectedTarget, selectedOther: otherClickSelectedOther, notes: otherClickNotes },
      fixtureSeed: 'roster IPC with unique names, then isolated SQLite rename by character_id' })
}
async function verifyV3A09(page, db, setStep) {
  setStep('U11.A09-v3-relationship-edit')
  await assertWriter(page, 'U11.A09')
  const rows = db.prepare('SELECT character_id, name FROM characters WHERE retired=0 AND name IN (?, ?)').all(firstName, secondName)
  assert.equal(rows.length, 2, 'A09 fixture requires exactly two active characters')
  const source = rows.find(row => row.name === firstName)
  const target = rows.find(row => row.name === secondName)
  assert(source?.character_id && target?.character_id && source.character_id !== target.character_id)
  const relationRows = db.prepare('SELECT source_character_id, target_character_id, relation FROM character_relationships').all()
  assert.deepEqual(relationRows, [{ source_character_id: source.character_id,
    target_character_id: target.character_id, relation: initialRelationship }], 'A09 fixture must begin with only the old relation')

  await page.locator('.writer-left-rail button[title="角色"]').click()
  await page.getByRole('button', { name: '关系图谱', exact: true }).click()
  await page.locator('canvas[aria-label^="角色关系图谱"]').waitFor({ state: 'visible' })
  await page.getByRole('complementary', { name: '图谱人物侧栏' })
    .locator(`button[data-graph-character-id="${source.character_id}"]`).click()
  await page.getByText(`${firstName} — 编辑档案`, { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator(`[data-character-id="${source.character_id}"]`).getAttribute('aria-pressed'), 'true')
  const field = page.locator('textarea[placeholder^="每行一位角色"]')
  assert.equal(await field.inputValue(), `${secondName}：${initialRelationship}`)
  await field.fill(`${secondName}：${relationship}`)
  assert.equal(await field.inputValue(), `${secondName}：${relationship}`)
  await page.getByText('未保存', { exact: true }).last().waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '保存', exact: true }).last().click()
  await page.getByText('已保存', { exact: true }).last().waitFor({ state: 'visible', timeout: 20_000 })
  assert.deepEqual(db.prepare('SELECT source_character_id, target_character_id, relation FROM character_relationships').all(),
    [{ source_character_id: source.character_id, target_character_id: target.character_id, relation: relationship }],
    'UI save did not replace the old relation at the original stable IDs')

  setStep('U11.A09-v3-reopen')
  await page.reload()
  await assertWriter(page, 'U11.A09-reopen')
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
  await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.writer-left-rail button[title="角色"]').click()
  await page.getByRole('button', { name: '关系图谱', exact: true }).click()
  await page.getByRole('complementary', { name: '图谱人物侧栏' })
    .locator(`button[data-graph-character-id="${source.character_id}"]`).click()
  assert.equal(await page.locator(`[data-character-id="${source.character_id}"]`).getAttribute('aria-pressed'), 'true')
  assert.equal(await field.inputValue(), `${secondName}：${relationship}`)
  const Database = createRequire(import.meta.url)('better-sqlite3')
  const reopenedDb = new Database(db.name, { fileMustExist: true, readonly: true })
  try {
    assert.deepEqual(reopenedDb.prepare('SELECT source_character_id, target_character_id, relation FROM character_relationships').all(),
      [{ source_character_id: source.character_id, target_character_id: target.character_id, relation: relationship }])
  } finally { reopenedDb.close() }
  pass('U11.A09-v3-relationship-edit-and-reopen', 'U11.A09',
    'V3 graph opened the original stable-ID profile; UI replaced its existing relation, and reopened project and SQLite agreed',
    { sourceId: source.character_id, targetId: target.character_id,
      fixtureRelation: initialRelationship, savedRelation: relationship, reopenedRelation: relationship })
}
async function verifyV3Graph(page, db, setStep) {
  await assertWriter(page, 'V3 graph')
  const rows = db.prepare('SELECT character_id, name FROM characters WHERE retired=0').all()
  assert.equal(rows.length, 1000, 'bounded graph fixture must contain exactly 1000 durable characters')
  const first = rows.find(row => row.name === firstName)
  const second = rows.find(row => row.name === secondName)
  assert(first?.character_id && second?.character_id)
  assert.equal(db.prepare('SELECT relation FROM character_relationships WHERE source_character_id=? AND target_character_id=?')
    .get(first.character_id, second.character_id)?.relation, relationship)
  await page.locator('.writer-left-rail button[title="角色"]').click()
  await page.getByText('角色列表（1000）', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '关系图谱', exact: true }).click()
  const canvas = page.locator('canvas[aria-label^="角色关系图谱"]')
  await canvas.waitFor({ state: 'visible' })
  const sidebar = page.getByRole('complementary', { name: '图谱人物侧栏' })

  const beforeReset = rosterFacts(db)
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
  assert.equal(visibleIds.size, 1000, 'pagination did not reach every stable character ID')
  await sidebar.getByRole('textbox', { name: '搜索图谱人物' }).fill(secondName)
  await sidebar.locator(`button[data-graph-character-id="${second.character_id}"]`).waitFor({ state: 'visible' })
  assert.equal(await sidebar.locator('button[data-graph-character-id]').count(), 1)
  pass('U11.A13-bounded-search-pagination', 'U11.A13', 'V3 graph renders at most 80 nodes; 20 visible sidebar pages reach all 1000 durable IDs and exact search reaches the last target',
    { durableCount: rows.length, renderedNodes: Number(await canvas.getAttribute('data-rendered-node-count')), reachedIds: visibleIds.size, searchId: second.character_id })

  setStep('U11.A11-reset-layout-zero-fact-write')
  await sidebar.getByRole('textbox', { name: '搜索图谱人物' }).fill('')
  await page.getByRole('button', { name: '放大关系图谱' }).click()
  await page.getByRole('button', { name: '重置图谱布局' }).click()
  assert.equal(rosterFacts(db), beforeReset, 'layout reset wrote character or relation facts')
  pass('U11.A11-reset-layout-zero-fact-write', 'U11.A11', 'Visible V3 zoom and reset controls left the complete roster, relation facts and revision unchanged',
    { beforeSha256: createHash('sha256').update(beforeReset).digest('hex'), afterSha256: createHash('sha256').update(rosterFacts(db)).digest('hex') })
  }

  setStep('U11.A12-delete-character-cancel')
  await sidebar.locator(`button[data-graph-character-id="${first.character_id}"]`).click()
  await page.getByText(`${firstName} — 编辑档案`, { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const dialog = page.getByRole('dialog')
  assert.match(await dialog.innerText(), new RegExp(firstName))
  await dialog.getByRole('button', { name: '取消' }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(rosterFacts(db), beforeReset, 'cancelled character deletion wrote facts')
  pass('U11.A12-delete-character-cancel', 'U11.A12', 'Visible delete confirmation named the selected stable-ID character; cancel preserved all facts', { targetId: first.character_id })

  setStep('U11.A12-delete-only-target-and-relations')
  await page.getByRole('button', { name: '删除', exact: true }).click()
  assert.match(await dialog.innerText(), new RegExp(firstName))
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByText('角色列表（999）', { exact: true }).waitFor({ state: 'visible' })
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
  assert.equal(await page.locator(`[data-character-id="${first.character_id}"]`).count(), 0, 'retired character remains selectable in the role list')
  await page.getByRole('button', { name: '关系图谱', exact: true }).click()
  const graphAfterDelete = page.locator('canvas[aria-label^="角色关系图谱"]')
  await graphAfterDelete.waitFor({ state: 'visible' })
  assert.equal(await page.locator(`button[data-graph-character-id="${first.character_id}"]`).count(), 0, 'retired character remains selectable in the graph')
  assert(!(await graphAfterDelete.getAttribute('aria-label')).includes(firstName), 'visible graph still exposes deleted relationship')
  const rawHistoricalRelations = db.prepare('SELECT count(*) FROM character_relationships').pluck().get()
  pass('U11.A12-delete-only-target-and-relations', 'U11.A12', 'Confirming selected V3 character deletion retired only its ID and removed its edge from the active graph and projection; the raw historical row remains',
    { targetId: first.character_id, survivorId: second.character_id, durableSurvivors: 999, activeRelations,
      rawHistoricalRelations, historicalRowPolicy: 'raw edges from retired IDs are retained; not active roster or graph facts' })

  setStep('U11.A12-delete-all-confirmation')
  await page.getByRole('button', { name: '删除全部角色与关系', exact: true }).click()
  const clearDialog = page.getByRole('dialog')
  assert.match(await clearDialog.innerText(), /999 个角色及其关系/)
  const beforeClear = rosterFacts(db)
  await clearDialog.getByRole('button', { name: '取消' }).click()
  await clearDialog.waitFor({ state: 'detached' })
  assert.equal(rosterFacts(db), beforeClear, 'cancelled graph clear wrote facts')
  await page.getByRole('button', { name: '删除全部角色与关系', exact: true }).click()
  await clearDialog.getByRole('button', { name: '确认删除全部' }).click()
  await page.getByText('角色列表（0）', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(db.prepare('SELECT count(*) FROM characters WHERE retired=0').pluck().get(), 0)
  assert.equal(db.prepare(`SELECT count(*) FROM character_relationships r JOIN characters source ON source.character_id=r.source_character_id
    JOIN characters target ON target.character_id=r.target_character_id WHERE source.retired=0 AND target.retired=0`).pluck().get(), 0)
  pass('U11.A12-delete-all-confirmation', 'U11.A12', 'Visible graph clear required explicit confirmation; cancellation wrote nothing and confirmation removed all active synthetic roles and relationships while retaining raw history',
    { beforeCount: 999, afterCount: 0, rawHistoricalRelations: db.prepare('SELECT count(*) FROM character_relationships').pluck().get() })
}
async function verifyV3Proposal(page, db, fixture, setStep) {
  setStep('U11.A10-generate-proposal')
  await assertWriter(page, 'U11.A10')
  const sentinelBefore = db.prepare('SELECT * FROM characters WHERE name=? AND retired=0').get(sentinelName)
  assert(sentinelBefore?.character_id, 'unrelated synthetic role was not persisted')
  assert.equal(db.prepare('SELECT count(*) FROM character_relationships').pluck().get(), 0)
  await page.locator('.writer-project-tree').getByText('小说配置', { exact: true }).click()
  await page.getByPlaceholder('在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置...').fill(premise)
  await page.getByRole('heading', { name: '小说配置' }).locator('xpath=../..').getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /^已保存$/ }).last().waitFor({ state: 'visible' })
  await page.locator('.writer-project-tree').getByText('故事架构', { exact: true }).click()
  await page.getByRole('button', { name: 'AI 生成架构' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '全选' }).click()
  for (const label of ['故事前提', '世界观', '情节大纲']) await dialog.locator('label').filter({ hasText: label }).click()
  await dialog.getByRole('button', { name: '确认生成（1/4）' }).click()
  await dialog.waitFor({ state: 'hidden' })
  const panel = page.getByTestId('workflow-confirmation-panel')
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
  pass('U11.A10-generate-proposal', 'U11.A10', 'V3 architecture button produced a durable pending relationship proposal through bounded authorized local provider calls without changing formal roster',
    { proposalBatchId: pending[0].proposal_id, source: beforeBatch.source.kind, syntheticRequests: fixture.requests })

  setStep('U11.A10-explicit-adoption')
  await relation.uncheck()
  assert.equal(await relation.isChecked(), false, 'relation choice did not respond to user input')
  await relation.check()
  assert.equal(await relation.isChecked(), true, 'relation choice was not restored before adoption')
  const confirm = panel.getByTestId('workflow-confirmation-confirm')
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
  pass('U11.A10-explicit-adoption', 'U11.A10', 'Visible V3 relationship choice and confirmation adopted only the three proposed stable-ID roles and one relation; unrelated role stayed byte-for-byte unchanged',
    { proposalBatchId: batch.proposalBatchId, approvalOperationId: batch.approvalOperationId, generated, relations, sentinelId: sentinelBefore.character_id })
}
async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U11 graph profile', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'isolated synthetic Writer receipt',
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
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    await setWriter(page)
    currentStep = 'fixture-project'
    const created = await invoke(page, 'project:create', { path: profile.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    projectPath = created.projectPath
    assert.equal(path.relative(scratch, projectPath).startsWith('..'), false)
    if (v3Mode) {
      currentStep = a10Only ? 'fixture-proposal-prerequisites' : a08Only ? 'fixture-same-name-stable-id-roster'
        : a09Only ? 'fixture-two-stable-id-old-relation' : 'fixture-1000-character-roster'
      const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const session = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
      const roster = await invoke(page, 'db:character-roster-read', projectPath, session)
      const names = a10Only ? [sentinelName] : a08Only || a09Only ? [firstName, secondName]
        : [firstName, secondName, ...Array.from({ length: 998 }, (_, index) => `角色${String(index).padStart(4, '0')}`)]
      const entries = names.map((name, index) => ({ characterId: `draft:${randomUUID()}`, name,
        role: index === 0 ? 'protagonist' : 'supporting', gender: '', age: '', appearance: '', personality: '',
        background: '', abilities: '', motivation: '', relationships: [], arc: '',
        notes: a08Only ? index === 0 ? a08TargetNotes : a08OtherNotes : '' }))
      if (a09Only) entries[0].relationships = [{ target: secondName, targetCharacterId: entries[1].characterId, relation: initialRelationship }]
      else if (!a10Only && !a08Only) entries[0].relationships = [{ target: secondName, targetCharacterId: entries[1].characterId, relation: relationship }]
      const seeded = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
        expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries }, projectPath, session)
      assert.equal(seeded.success, true, JSON.stringify(seeded))
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
    }
    await page.reload()
    await assertWriter(page, 'fixture-project')
    const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
    const Database = createRequire(import.meta.url)('better-sqlite3')
    db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true })
    if (v3Mode) {
      currentStep = a08Only ? 'U11.A08-v3-graph-entry' : a09Only ? 'U11.A09-v3-graph-entry' : a10Only ? 'U11.A10-v3-architecture-entry'
        : a12Only ? 'U11.A12-v3-graph-entry' : 'U11.A13-v3-graph-entry'
      if (a08Only) await verifyV3A08(page, db, step => { currentStep = step })
      else if (a09Only) await verifyV3A09(page, db, step => { currentStep = step })
      else if (a10Only) await verifyV3Proposal(page, db, fixture, step => { currentStep = step })
      else await verifyV3Graph(page, db, step => { currentStep = step })
    } else {
    currentStep = 'fixture-two-characters'
    await assertWriter(page, currentStep)
    await page.locator('.writer-left-rail').getByRole('button', { name: '角色', exact: true }).click()
    await page.getByTitle('新建角色').waitFor({ state: 'visible' })
    await addCharacter(page, firstName)
    await addCharacter(page, secondName)
    const rows = db.prepare('SELECT character_id, name, relationships FROM characters WHERE retired = 0 AND name IN (?, ?)').all(firstName, secondName)
    assert.equal(rows.length, 2)
    const first = rows.find(row => row.name === firstName)
    const second = rows.find(row => row.name === secondName)
    assert(first?.character_id && second?.character_id)

    currentStep = 'U11.A08-graph-to-profile'
    await assertWriter(page, currentStep)
    await page.getByRole('button', { name: '关系图谱', exact: true }).click()
    await page.locator('canvas[aria-label^="角色关系图谱"]').waitFor({ state: 'visible' })
    await page.locator(`button[data-graph-character-id="${first.character_id}"]`).click()
    await page.getByText(`${firstName} — 编辑档案`, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByText('姓名', { exact: true }).locator('xpath=..').locator('input').inputValue(), firstName)
    assert.equal(await page.locator(`[data-character-id="${first.character_id}"]`).getAttribute('aria-pressed'), 'true')
    pass('U11.A08-graph-to-profile', 'U11.A08', 'Writer graph person button opened the matching stable-ID profile', { characterId: first.character_id })

    currentStep = 'U11.A09-relationship-edit'
    await assertWriter(page, currentStep)
    const relationshipInput = page.getByText('关系网', { exact: true }).locator('xpath=..').locator('textarea')
    await relationshipInput.fill(`${secondName}：${relationship}`)
    assert.equal(await relationshipInput.inputValue(), `${secondName}：${relationship}`)
    await page.getByText('未保存', { exact: true }).last().waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '保存', exact: true }).last().click()
    let stored = null
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      stored = db.prepare('SELECT relation FROM character_relationships WHERE source_character_id = ? AND target_character_id = ?')
        .get(first.character_id, second.character_id)?.relation ?? null
      if (stored === relationship) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    diagnostic = { relationshipValue: await relationshipInput.inputValue(), storedRelation: stored }
    assert.equal(stored, relationship, 'normalized relationship row not committed')
    await page.getByText('已保存', { exact: true }).last().waitFor({ state: 'visible', timeout: 20_000 })
    assert((await relationshipInput.inputValue()).includes(secondName), 'saved relationship missing from Writer profile')
    pass('U11.A09-relationship-edit', 'U11.A09', 'Writer profile relationship editor saved durable relation to the original stable ID',
      { sourceId: first.character_id, targetId: second.character_id, storedRelation: stored })
    }
  } catch (error) {
    failure = String(error)
    if (a10Only && page) diagnostic = { syntheticRequests: fixture.requests,
      visibleAlerts: await page.locator('[role="alert"]').allTextContents().catch(() => []),
      confirmationText: await page.getByTestId('workflow-confirmation-panel').allTextContents().catch(() => []) }
  }
  finally {
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
    const receipt = { outcome: failure ? 'FAIL' : v3Mode ? 'PARTIAL' : 'PASS',
      qualification: v3Mode ? a08Only ? 'F05_U11_A08_V3_PARTIAL' : a09Only ? 'F05_U11_A09_V3_PARTIAL' : a10Only ? 'F05_U11_A10_V3_PARTIAL' : a12Only ? 'F05_U11_A12_V3_PARTIAL' : 'F05_U11_A10_A13_V3_PARTIAL' : 'F05_U11_A08_A09_WRITER', evidenceLevel: 'electron',
      testedSha, executionHead, changedPaths, sourceDirtyPaths: git('status', '--porcelain').split('\n').filter(Boolean),
      driverSha256, buildReceipt: buildReceiptPath ? { path: buildReceiptPath, sha256: sha256(buildReceiptPath) } : null,
      fixtureSetup: a09Only ? { method: 'character-roster-commit with two stable IDs and old relation; UI alone edits relation',
        firstName, secondName, initialRelation: initialRelationship, editedRelation: relationship }
        : a08Only ? { method: 'character-roster-commit with unique names and distinct notes, then isolated SQLite rename by character_id',
        firstName, secondName, duplicateName: firstName, distinctField: 'notes', targetNotes: a08TargetNotes, otherNotes: a08OtherNotes } : null,
      packageRoot: packageDir, shell: v3Mode ? 'writer-v3' : 'writer', mode: a08Only ? 'v3-a08-only' : a09Only ? 'v3-a09-only' : a10Only ? 'v3-a10-only' : a12Only ? 'v3-a12-only' : v3Mode ? 'v3-a10-a13' : 'legacy-a08-a09',
      artifact: { executableSha256: sha256(executablePath), asarSha256: sha256(asarPath) },
      nodeAbi: process.versions.modules, cleanupConfirmed, isolatedRoot: scratch, projectPath, failedStep: failure ? currentStep : null,
      error: failure, diagnostic: failure ? diagnostic : null, steps,
      unverified: v3Mode ? (a08Only ? ['U11.A09', 'U11.A10', 'U11.A11', 'U11.A12', 'U11.A13']
        : a09Only ? ['U11.A08', 'U11.A10', 'U11.A11', 'U11.A12', 'U11.A13']
          : ['U11.A10', 'U11.A11', 'U11.A12', 'U11.A13']).filter(id => !verified(id))
        : failure ? ['U11.A08', 'U11.A09'].filter(id => !steps.some(step => step.actionId === id && step.outcome === 'PASS')) : [] }
    const receiptPath = path.join(evidenceDir, 'receipt.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(JSON.stringify({ outcome: receipt.outcome, failedStep: receipt.failedStep, steps, receiptPath }) + '\n')
  }
  if (failure) throw new Error(failure)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
