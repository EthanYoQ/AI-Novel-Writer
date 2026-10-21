/* global process */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { Buffer } from 'node:buffer'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import * as arch from './redesign/pages/architecture.mjs'
import * as chapterView from './redesign/pages/chapter-view.mjs'
import * as runSheet from './redesign/pages/run-sheet.mjs'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = option('package-dir')
const u09ImportOnly = process.argv.includes('--u09-import-only')
const u09FinalizedOnly = process.argv.includes('--u09-finalized-only')
const u09StaleOnly = process.argv.includes('--u09-stale-only')
assert(!(u09ImportOnly && u09FinalizedOnly), 'choose one U09 journey mode')
assert(!u09StaleOnly || u09FinalizedOnly, 'stale source requires --u09-finalized-only')
const controlledModel = u09ImportOnly || u09FinalizedOnly
const packageSourceSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
assert(packageDir && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const exe = resolveWindowsExecutable(packageDir)
const asar = path.join(packageDir, 'resources', 'app.asar')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const testedSha = git('rev-parse', '--verify', `${packageSourceSha}^{commit}`)
const executionHead = git('rev-parse', 'HEAD')
const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml',
  'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
const changedPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`).split('\n').filter(Boolean)
const changedProductPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`, '--', ...productInputs).split('\n').filter(Boolean)
const ignoredTestOnlyPaths = changedProductPaths.filter(file => [
  'electron/services/__tests__/project-archive-service.test.ts',
  'electron/services/__tests__/release-vector-smoke.test.ts',
].includes(file))
const dirtyProductPaths = git('status', '--porcelain', '--untracked-files=all', '--', ...productInputs).split('\n').filter(Boolean)
const ignoredScreenshotPaths = dirtyProductPaths.filter(line => /^\?\? src\/.*\/__tests__\/__screenshots__\/.*\.png$/.test(line))
assert.deepEqual(changedProductPaths.filter(file => !ignoredTestOnlyPaths.includes(file)), [], 'product source changed since fixed package build')
assert.deepEqual(dirtyProductPaths.filter(line => !ignoredScreenshotPaths.includes(line)), [], 'product build inputs are dirty')
assert.equal(sha256(exe), expectedExe, 'executable hash changed')
assert.equal(sha256(asar), expectedAsar, 'bundle hash changed')
const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', 'f04c', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const receiptDir = path.join(repository, '.runtime', '.cache', 'f04-v3-characters', runId)
const receiptPath = path.join(receiptDir, 'receipt.json')
const nativePickerHelper = path.join(repository, 'scripts', 'f05-u16-native-picker.ps1')
const projectName = 'V3C'
const names = [`甲${runId.slice(0, 4)}`, `乙${runId.slice(0, 4)}`]
const backgrounds = [`北港线人 ${runId.slice(0, 8)}`, `南站警员 ${runId.slice(0, 8)}`]
const importNames = [`候选甲${runId.slice(0, 4)}`, `候选乙${runId.slice(0, 4)}`, `候选丙${runId.slice(0, 4)}`]
const finalizedNames = [`派生甲${runId.slice(0, 4)}`, `作者乙${runId.slice(0, 4)}`, `同名丙${runId.slice(0, 4)}`]
const finalizedProse = `${finalizedNames[0]}走进北塔。${finalizedNames[1]}留在旧港。${finalizedNames[2]}站在桥上。`
let finalizedIds = []
const lateName = `迟到丁${runId.slice(0, 4)}`
const lateProse = `${lateName}走进南站。`
let lateId
let releaseLateModel
let signalLateModel
const lateModelRequested = new Promise(resolve => { signalLateModel = resolve })
const model = { id: 'u09-local-fixture', name: 'U09 controlled fixture', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'u09-offline', maxTokens: 8192,
  temperature: 0.7, purposes: ['generation'] }
const modelRequests = []
let fixturePort
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
    || request.headers.authorization !== `Bearer ${model.apiKey}` || modelRequests.length >= (u09FinalizedOnly ? 6 : 3)) {
    response.writeHead(403).end(); return
  }
  const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
  modelRequests.push(body)
  const index = modelRequests.length - 1
  const content = u09StaleOnly ? index === 0 ? lateProse
    : JSON.stringify({ updates: [{ characterId: lateId, currentState: { location: '旧源模型值' }, evidence: { text: lateProse } }] })
    : u09FinalizedOnly ? index === 0 ? `${finalizedNames[0]}走进北塔。` : index === 2 ? lateProse : index >= 3
    ? JSON.stringify({ updates: [{ characterId: lateId, currentState: { location: '模型旧值' }, evidence: { text: lateProse } }] })
    : JSON.stringify({ updates: [
    { characterId: finalizedIds[0], currentState: { location: '北塔' }, evidence: { text: `${finalizedNames[0]}走进北塔。` } },
    { characterId: finalizedIds[1], currentState: { location: '旧港' }, evidence: { text: `${finalizedNames[1]}留在旧港。` } },
    { characterId: finalizedIds[2], name: finalizedNames[2], currentState: { location: '桥上' }, evidence: { text: `${finalizedNames[2]}站在桥上。` } },
  ] }) : JSON.stringify({ results: [{ sourceId: '1:1', characterCards: [{
    name: importNames[index], role: 'supporting', background: `模型背景${index + 1}`, notes: '合成提取',
  }] }] })
  if (u09FinalizedOnly && index === (u09StaleOnly ? 1 : 3)) {
    signalLateModel()
    await new Promise(resolve => { releaseLateModel = resolve })
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`)
  response.end('data: [DONE]\n\n')
})
const steps = []
const pass = (name, observed) => steps.push({ name, outcome: 'PASS', observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const pickerEvidence = []
function chooseNativeAvatar(target) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nativePickerHelper,
    '-Target', target, '-ExpectedExe', exe, '-DialogTitle', '选择角色头像'],
  { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, `native avatar picker: ${result.stderr || result.stdout || result.error}`)
  const evidence = JSON.parse(result.stdout.trim())
  assert.equal(evidence.dialogTitle, '选择角色头像')
  assert.equal(evidence.typedExact, true)
  assert.equal(evidence.submitted, true)
  pickerEvidence.push(evidence)
  return evidence
}

async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
    AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
    APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath: exe, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  if (controlledModel) await app.evaluate((_, port) => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/chat/completions') throw new Error('U09_EXTERNAL_NETWORK_REFUSED')
      return originalFetch(`http://127.0.0.1:${port}${url.pathname}`, options)
    }
  }, fixturePort)
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(15_000)
  await stage.waitForStage(page)
  assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
  return { app, page }
}

async function waitBounded(promise, ms, message) {
  let timer
  try {
    await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })])
  } finally { clearTimeout(timer) }
}

async function closeAppBounded(app) {
  const pid = app.process().pid
  try { await waitBounded(app.close(), 10_000, `ELECTRON_CLOSE_TIMEOUT pid=${pid}`) }
  catch (error) { throw new Error(`ELECTRON_CLOSE_FAILED pid=${pid}: ${error?.message}`) }
}

/* 纸墨外壳的角色名单：从书房打开作品，架构阶段「角色名单」一节进入；左边名单、右边档案。 */
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
async function openRolePage(page) {
  await openProject(page)
  await openCast(page)
}
const castRow = (page, characterId) => arch.castRoster(page).locator(`[data-character-id="${characterId}"]`)
const rosterIds = page => arch.castRoster(page).locator('[data-character-id]')
  .evaluateAll(rows => rows.map(row => row.getAttribute('data-character-id')))
const profileField = (page, label) => stage.root(page).getByLabel(label, { exact: true })
/** 当前状态各字段标签旁的来源：定稿派生、作者输入等。 */
const fieldSource = (page, label) => stage.root(page).locator('.cast-field')
  .filter({ has: page.getByText(label, { exact: true }) }).locator('.cast-field-hint')
const profileAvatar = page => stage.root(page).locator('img.cast-profile-avatar')
const saveState = (page, label) => stage.root(page).locator('.cast-save-state').filter({ hasText: new RegExp(`^${label}$`) })
async function showProfileView(page, name) {
  const button = stage.root(page).getByRole('group', { name: '档案视图' }).getByRole('button', { name, exact: true })
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click()
}
/** 档案有改动时写「未保存」；从它等到「已保存」，不会读到上一次保存留下的状态。 */
async function saveCharacter(page) {
  await saveState(page, '未保存').waitFor({ state: 'visible' })
  await stage.root(page).getByRole('button', { name: '保存角色', exact: true }).click()
  await saveState(page, '已保存').waitFor({ state: 'visible', timeout: 20_000 })
}
/** 名单里新建一位：新草稿自动选中，填姓名后保存，等名单里出现它的稳定 ID。 */
async function addCharacter(page, name) {
  const before = new Set(await rosterIds(page))
  await arch.castRoster(page).getByRole('button', { name: '新建角色', exact: true }).click()
  await showProfileView(page, '基础设定')
  await profileField(page, '姓名').fill(name)
  await saveCharacter(page)
  const stableNew = ids => ids.find(id => id && !id.startsWith('draft:') && !before.has(id))
  await page.waitForFunction(previous => [...document.querySelectorAll('.cast-roster [data-character-id]')]
    .some(row => { const id = row.getAttribute('data-character-id'); return id && !id.startsWith('draft:') && !previous.includes(id) }), [...before])
  const id = stableNew(await rosterIds(page))
  assert(id, `stable ID missing for ${name}`)
  return id
}
/** 运行侧页：这次定稿进了「历史」（成功或失败都算结束），「进行中」里没有别的运行。 */
async function waitRunsQuiet(page, title) {
  await runSheet.openFromPalette(page)
  await runSheet.tab(page, '历史').click()
  const history = page.getByRole('list', { name: '运行历史' })
  await history.locator('.run-history-title').filter({ hasText: new RegExp(`^${title}$`) }).first().waitFor({ state: 'visible', timeout: 90_000 })
  // 运行历史只在「历史」页挂载，切到「进行中」之前读。
  const historyTitles = await history.locator('.run-history-title').allTextContents()
  await runSheet.tab(page, '进行中').click()
  let active = []
  for (let attempt = 0; attempt < 360; attempt++) {
    active = await runSheet.activeTitles(page)
    if (active.length === 0) return { active, historyTitles }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`RUNS_NOT_QUIESCENT ${JSON.stringify({ active, title, historyTitles })}`)
}
async function waitRunCompleted(page, title) {
  await runSheet.openFromPalette(page)
  await runSheet.tab(page, '历史').click()
  await page.getByRole('list', { name: '运行历史' }).getByRole('listitem')
    .filter({ has: page.locator('.run-history-title', { hasText: new RegExp(`^${title}$`) }) }).first()
    .locator('.run-history-row').filter({ hasText: '已完成，' }).waitFor({ state: 'visible', timeout: 90_000 })
}
/** 打开第 number 章，核对正文是夹具写进去的那一份，然后定稿。 */
async function finalizeChapter(page, number, prose) {
  await stage.openChapter(page, number)
  assert((await chapterView.prose(page).innerText()).includes(prose), `chapter ${number} draft differs from fixture source`)
  await chapterView.finalize(page, number)
}
const suggestions = page => stage.root(page).getByRole('region', { name: '待处理的角色建议' })
const imageHash = locator => locator.evaluate(async image => {
  const bytes = new Uint8Array(await (await fetch(image.src)).arrayBuffer())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
})

async function main() {
  if (controlledModel) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    fixturePort = server.address().port
  }
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F04 V3 characters synthetic journey', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'isolated stage packaged role evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app
  let importDb
  let currentStep = 'launch'
  let failure = null
  let projectPath
  try {
    let launched = await launch()
    app = launched.app
    const page = launched.page
    currentStep = 'fixture-project'
    const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, profile.projects)).grantId, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    projectPath = created.projectPath
    if (controlledModel) {
      assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
      assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
    }
    await closeAppBounded(app)
    app = null

    launched = await launch()
    app = launched.app
    const rolePage = launched.page
    currentStep = 'stage-role-entry'
    await openRolePage(rolePage)
    assert.equal(await rolePage.locator(stage.STAGE_SHELL).count(), 1)
    if (u09StaleOnly) {
      currentStep = 'u09-a09-stale-source-setup'
      lateId = await addCharacter(rolePage, lateName)
      const opened = await invoke(rolePage, 'project:open', projectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const session = { projectId: created.projectId, projectPath, leaseId: opened.project?.sessionLease }
      assert(session.leaseId, 'stale source fixture session missing')
      const blueprint = await invoke(rolePage, 'db:blueprint-upsert', { chapterNumber: 1, title: '南站', role: '发展',
        purpose: '核对旧来源拒写', keyEvents: lateProse, characters: [] }, projectPath, session)
      assert.equal(blueprint.success, true, blueprint.error)
      const draft = await invoke(rolePage, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
        content: lateProse, wordCount: lateProse.length }, projectPath, session)
      assert.equal(draft.success, true, draft.error)
      await closeAppBounded(app); app = null

      launched = await launch()
      app = launched.app
      const stalePage = launched.page
      await openProject(stalePage)
      currentStep = 'u09-a09-stale-source'
      await finalizeChapter(stalePage, 1, lateProse)
      await waitBounded(lateModelRequested, 90_000, 'old source model request missing')
      assert.equal(modelRequests.length, 2)
      assert(JSON.stringify(modelRequests[1].messages).includes(lateId), 'old request lacks frozen character ID')
      importDb = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
      const binding = JSON.parse(importDb.prepare('SELECT binding_json FROM generation_runs ORDER BY rowid DESC LIMIT 1').pluck().get())
      assert.equal(binding.sourceManifest.operation, 'finalized-character-state')
      const currentSession = { projectId: created.projectId, projectPath, leaseId: binding.epoch }
      const older = importDb.prepare('SELECT finalization_id AS finalizationId FROM finalization_outbox WHERE draft_id=?').get(draft.id)
      assert(older?.finalizationId, 'old stage finalization missing')
      const newerText = `${lateProse}新版定稿。`
      const newer = await invoke(stalePage, 'db:draft-create', { chapterNumber: 1, version: 2, source: 'write',
        content: newerText, wordCount: newerText.length }, projectPath, currentSession)
      assert.equal(newer.success, true, newer.error)
      const committed = await invoke(stalePage, 'finalization:commit', { tabId: 'u09-stale-v2', projectPath,
        projectSession: currentSession, draftId: newer.id, chapterNumber: 1, chapterTitle: '南站新版',
        content: newerText, contentRevision: 0 }, currentSession)
      assert.equal(committed.success, true, committed.error)
      assert.equal(importDb.prepare("SELECT id FROM drafts WHERE chapter_number=1 AND status='finalized' ORDER BY version DESC LIMIT 1").get().id,
        newer.id, 'newer version did not become authoritative')
      releaseLateModel(); releaseLateModel = undefined
      const failureRow = importDb.prepare(`SELECT s.ok,s.error_msg AS errorMsg,s.attempt_count AS attemptCount FROM post_process_steps s
        JOIN post_process_runs r ON r.id=s.run_id WHERE r.trigger_source_id=? AND s.step_key='character_cards' ORDER BY s.id DESC LIMIT 1`)
      let rejected
      for (let attempt = 0; attempt < 360; attempt++) {
        rejected = failureRow.get(`finalization:${older.finalizationId}`)
        if (rejected?.attemptCount) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.equal(rejected?.ok, 0, 'old source result was accepted')
      assert.equal(rejected.errorMsg, 'FINALIZATION_GENERATION_SOURCE_CHANGED',
        'old source was rejected for a different reason')
      const row = importDb.prepare('SELECT cs_location AS location,cs_provenance AS provenance FROM characters WHERE character_id=?').get(lateId)
      assert.equal(row.location, '', 'old source overwrote the character after newer finalization')
      assert.equal(modelRequests.length, 2, 'old source failure retried the model')
      const quiet = await waitRunsQuiet(stalePage, '第 1 章 · 定稿')
      await closeAppBounded(app); app = null
      launched = await launch()
      app = launched.app
      const reopened = launched.page
      const persisted = importDb.prepare('SELECT cs_location AS location FROM characters WHERE character_id=?').get(lateId)
      assert.equal(persisted.location, '', 'old source write survived restart')
      assert.deepEqual(failureRow.get(`finalization:${older.finalizationId}`), rejected)
      steps.push({ stepId: currentStep, actionId: 'U09.A09', outcome: 'PASS',
        assertion: 'A held finalized-character response from a chapter finalized in the stage shell was rejected after version 2 became authoritative; no stale character write or retry survived restart.',
        observed: { oldFinalizationId: older.finalizationId, newerDraftId: newer.id, rejection: rejected, runSheet: quiet,
          characterId: lateId, modelRequestCount: modelRequests.length, stageShell: await reopened.locator(stage.STAGE_SHELL).count() } })
      return
    }
    if (u09FinalizedOnly) {
      finalizedIds = [await addCharacter(rolePage, finalizedNames[0]), await addCharacter(rolePage, finalizedNames[1]),
        await addCharacter(rolePage, finalizedNames[2]), await addCharacter(rolePage, finalizedNames[2])]
      await castRow(rolePage, finalizedIds[1]).click()
      await showProfileView(rolePage, '当前状态')
      await profileField(rolePage, '当前位置/阵营').fill('作者旧港')
      await saveCharacter(rolePage)
      await closeAppBounded(app); app = null

      launched = await launch()
      app = launched.app
      const sourcePage = launched.page
      const opened = await invoke(sourcePage, 'project:open', projectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const session = { projectId: created.projectId, projectPath, leaseId: opened.project?.sessionLease }
      assert(session.leaseId, 'finalized fixture session missing')
      const blueprint = await invoke(sourcePage, 'db:blueprint-upsert', { chapterNumber: 1, title: '北塔', role: '发展',
        purpose: '核对角色状态', keyEvents: finalizedProse, characters: [] }, projectPath, session)
      assert.equal(blueprint.success, true, blueprint.error)
      const draft = await invoke(sourcePage, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
        content: finalizedProse, wordCount: finalizedProse.length }, projectPath, session)
      assert.equal(draft.success, true, draft.error)
      const draftId = draft.id
      assert(Number.isSafeInteger(draftId) && draftId > 0)
      await closeAppBounded(app); app = null

      currentStep = 'u09-a05-stage-finalize'
      launched = await launch()
      app = launched.app
      const finalPage = launched.page
      await openProject(finalPage)
      await finalizeChapter(finalPage, 1, finalizedProse)
      await waitRunCompleted(finalPage, '第 1 章 · 定稿')

      assert.equal(modelRequests.length, 2)
      assert(JSON.stringify(modelRequests[1].messages).includes(finalizedIds[0]), 'model did not receive frozen character ID')
      importDb = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
      const outbox = importDb.prepare('SELECT finalization_id AS finalizationId,content_hash AS contentHash,content_snapshot AS content FROM finalization_outbox WHERE draft_id=?').get(draftId)
      assert.equal(outbox.content, finalizedProse)
      const source = { draftId, chapterNumber: 1, finalizationId: outbox.finalizationId, contentHash: outbox.contentHash }
      const postSteps = importDb.prepare("SELECT step_key AS stepKey,ok FROM post_process_steps WHERE step_key IN ('chapter_notes','character_cards')").all()
      assert.deepEqual(postSteps.map(step => [step.stepKey, step.ok]).sort(), [['chapter_notes', 1], ['character_cards', 1]])
      await closeAppBounded(app); app = null

      launched = await launch()
      app = launched.app
      const verificationPage = launched.page
      const verifyOpened = await invoke(verificationPage, 'project:open', projectPath, randomUUID(), null)
      assert.equal(verifyOpened.success, true, verifyOpened.error)
      const verifySession = { projectId: created.projectId, projectPath, leaseId: verifyOpened.project?.sessionLease }
      assert(verifySession.leaseId, 'finalized verification session missing')
      const verify = (channel, ...args) => invoke(verificationPage, channel, ...args, verifySession)
      const context = await verify('finalized-character:read-context', { draftId })
      assert.equal(context.context.identityStatus, 'bound')
      assert.deepEqual(context.context.characters.filter(character => character.displayNameSnapshot === finalizedNames[2])
        .map(character => character.characterId).sort(), finalizedIds.slice(2).sort())
      const notes = await verify('finalization-generation:read', { slot: { source, stepKey: 'chapter_notes' } })
      const characterSlot = { source, stepKey: 'character_cards' }
      const characterStage = await verify('finalization-generation:read', { slot: characterSlot })
      assert.equal(notes.effect?.success, true)
      assert.equal(characterStage.effect?.success, true)
      currentStep = 'u09-a05-derived'
      const state = id => importDb.prepare('SELECT cs_location AS location,cs_provenance AS provenance FROM characters WHERE character_id=?').get(id)
      const derived = state(finalizedIds[0])
      assert.equal(derived.location, '北塔')
      assert.deepEqual(JSON.parse(derived.provenance).location.source, source)
      assert.equal(JSON.parse(derived.provenance).location.kind, 'derived')
      steps.push({ stepId: currentStep, actionId: 'U09.A05', outcome: 'PASS',
        assertion: 'Bound finalized prose applied one nonconflicting dynamic field with derived source provenance.',
        observed: { draftId, finalizationId: source.finalizationId, characterId: finalizedIds[0], location: derived.location } })

      currentStep = 'u09-a06-proposals'
      assert.equal(state(finalizedIds[1]).location, '作者旧港')
      assert.equal(JSON.parse(state(finalizedIds[1]).provenance).location.kind, 'author')
      assert.equal(characterStage.effect.candidates.some(candidate => candidate.characterId === finalizedIds[1]
        && candidate.reason === 'author-protected'), true)
      assert.equal(characterStage.effect.unresolved.some(candidate => candidate.reason === 'ambiguous'
        && candidate.candidateIds.length === 2), true)
      const [pendingState] = await verify('finalized-character:list-state-candidates')
      const [pendingIdentity] = await verify('character-proposal:list-pending-finalized')
      assert(pendingState && pendingIdentity, 'conflict or ambiguity proposal missing')
      const proposal = await verify('finalized-character:read-state-candidate',
        { draftId, candidateKey: pendingState.candidateKey })
      assert.equal(proposal.value, '旧港')
      assert.equal(proposal.source.finalizationId, source.finalizationId)
      await closeAppBounded(app); app = null

      launched = await launch()
      app = launched.app
      const proposalPage = launched.page
      await openRolePage(proposalPage)
      // 纸墨外壳把状态建议与定稿角色决策合成角色名单页顶上的一条提示条，各占一行。
      await suggestions(proposalPage).locator('li[data-kind="state"]').waitFor({ state: 'visible' })
      await suggestions(proposalPage).locator('li[data-kind="decision"]').waitFor({ state: 'visible' })
      steps.push({ stepId: currentStep, actionId: 'U09.A06', outcome: 'PASS',
        assertion: 'The cast page showed both the author-field conflict and the ambiguous identity as source-bound pending suggestions; the author value remained intact.',
        observed: { stateCandidateKey: proposal.candidateKey, identityBatchId: pendingIdentity.proposalBatchId,
          authorValue: state(finalizedIds[1]).location, ambiguousCandidateIds: finalizedIds.slice(2) } })

      currentStep = 'u09-a07-decline-reopen'
      await suggestions(proposalPage).getByRole('button', { name: '检查定稿状态建议' }).click()
      await suggestions(proposalPage).getByRole('button', { name: '拒绝状态建议' }).click()
      await suggestions(proposalPage).locator('li[data-kind="state"]').waitFor({ state: 'detached' })
      await suggestions(proposalPage).getByRole('button', { name: '检查定稿角色决策' }).click()
      await suggestions(proposalPage).getByRole('button', { name: '拒绝这些决策' }).click()
      await suggestions(proposalPage).waitFor({ state: 'hidden' })
      const stored = JSON.parse(importDb.prepare('SELECT character_state_candidates FROM summary_snapshots WHERE draft_id=?').pluck().get(draftId))
      assert.equal(stored.pending.length, 0)
      assert(stored.receipts.some(receipt => receipt.candidateKey === proposal.candidateKey && receipt.decision === 'decline'))
      const identityEnvelope = JSON.parse(importDb.prepare('SELECT raw_value FROM character_identity_proposals WHERE proposal_id=?')
        .pluck().get(pendingIdentity.proposalBatchId))
      assert.equal(identityEnvelope.batch.status, 'cancelled')
      assert.equal(state(finalizedIds[1]).location, '作者旧港')
      await closeAppBounded(app); app = null

      launched = await launch()
      app = launched.app
      const reopenedPage = launched.page
      await openRolePage(reopenedPage)
      assert.equal(await suggestions(reopenedPage).count(), 0)
      const readOpened = await invoke(reopenedPage, 'project:open', projectPath, randomUUID(), projectPath)
      assert.equal(readOpened.success, true, readOpened.error)
      const readSession = { projectId: created.projectId, projectPath, leaseId: readOpened.project?.sessionLease }
      assert.deepEqual(await invoke(reopenedPage, 'finalized-character:list-state-candidates', readSession), [])
      assert.deepEqual(await invoke(reopenedPage, 'character-proposal:list-pending-finalized', readSession), [])
      assert.deepEqual((await invoke(reopenedPage, 'finalization-generation:read', { slot: characterSlot }, readSession)).effect,
        characterStage.effect)
      assert.equal(state(finalizedIds[1]).location, '作者旧港')
      assert.equal(modelRequests.length, 2, 'reopening repeated finalized generation')
      steps.push({ stepId: currentStep, actionId: 'U09.A07', outcome: 'PASS',
        assertion: 'Decline receipts survived an Electron process restart and neither pending decision nor model call reappeared.',
        observed: { stateDecision: stored.receipts.find(receipt => receipt.candidateKey === proposal.candidateKey),
          identityBatchId: pendingIdentity.proposalBatchId, modelRequestCount: modelRequests.length } })

      currentStep = 'u09-a08-rename-source-reopen'
      await closeAppBounded(app); app = null
      launched = await launch()
      app = launched.app
      const renamePage = launched.page
      await openRolePage(renamePage)
      await castRow(renamePage, finalizedIds[0]).click()
      await showProfileView(renamePage, '当前状态')
      assert.equal(await profileField(renamePage, '当前位置/阵营').inputValue(), '北塔')
      assert.equal(await fieldSource(renamePage, '当前位置/阵营').innerText(), '定稿派生')
      await showProfileView(renamePage, '基础设定')
      await profileField(renamePage, '姓名').fill(finalizedNames[1])
      await saveCharacter(renamePage)
      await closeAppBounded(app); app = null

      launched = await launch()
      app = launched.app
      const sameNamePage = launched.page
      await openRolePage(sameNamePage)
      for (const [id, value, origin] of [[finalizedIds[0], '北塔', '定稿派生'], [finalizedIds[1], '作者旧港', '作者输入']]) {
        await castRow(sameNamePage, id).click()
        await showProfileView(sameNamePage, '当前状态')
        assert.equal(await profileField(sameNamePage, '当前位置/阵营').inputValue(), value)
        assert.equal(await fieldSource(sameNamePage, '当前位置/阵营').innerText(), origin, `${id} source label changed`)
      }
      const sameNameRows = importDb.prepare('SELECT character_id AS id,name FROM characters WHERE character_id IN (?,?) ORDER BY character_id')
        .all(finalizedIds[0], finalizedIds[1])
      assert.equal(sameNameRows.length, 2)
      assert(sameNameRows.every(row => row.name === finalizedNames[1]), 'same-name rename merged or changed an identity')
      const aliases = importDb.prepare('SELECT character_id AS id,name,valid_through AS validThrough FROM character_aliases WHERE character_id IN (?,?)')
        .all(finalizedIds[0], finalizedIds[1])
      assert(aliases.some(row => row.id === finalizedIds[0] && row.name === finalizedNames[0] && row.validThrough !== null))
      assert(finalizedIds.slice(0, 2).every(id => aliases.some(row => row.id === id && row.name === finalizedNames[1] && row.validThrough === null)))
      assert.equal(JSON.parse(state(finalizedIds[0]).provenance).location.kind, 'derived')
      assert.equal(JSON.parse(state(finalizedIds[1]).provenance).location.kind, 'author')
      steps.push({ stepId: currentStep, actionId: 'U09.A08', outcome: 'PASS',
        assertion: 'Renaming to an existing display name on the cast page kept two stable IDs, each field value and source label, and ID-scoped alias history after restart.',
        observed: { ids: finalizedIds.slice(0, 2), displayName: finalizedNames[1], locations: ['北塔', '作者旧港'],
          sourceKinds: ['derived', 'author'], aliasCount: aliases.length } })

      currentStep = 'u09-a09-late-author-save'
      lateId = await addCharacter(sameNamePage, lateName)
      await closeAppBounded(app); app = null
      launched = await launch()
      app = launched.app
      const secondSourcePage = launched.page
      const secondOpened = await invoke(secondSourcePage, 'project:open', projectPath, randomUUID(), null)
      assert.equal(secondOpened.success, true, secondOpened.error)
      const secondSession = { projectId: created.projectId, projectPath, leaseId: secondOpened.project?.sessionLease }
      assert(secondSession.leaseId, 'second finalized fixture session missing')
      const secondBlueprint = await invoke(secondSourcePage, 'db:blueprint-upsert', { chapterNumber: 2, title: '南站', role: '发展',
        purpose: '核对迟到的角色状态', keyEvents: lateProse, characters: [] }, projectPath, secondSession)
      assert.equal(secondBlueprint.success, true, secondBlueprint.error)
      const secondDraft = await invoke(secondSourcePage, 'db:draft-create', { chapterNumber: 2, version: 1, source: 'write',
        content: lateProse, wordCount: lateProse.length }, projectPath, secondSession)
      assert.equal(secondDraft.success, true, secondDraft.error)
      await closeAppBounded(app); app = null

      launched = await launch()
      app = launched.app
      const latePage = launched.page
      await openProject(latePage)
      await finalizeChapter(latePage, 2, lateProse)
      let lateTimeout
      await Promise.race([lateModelRequested, new Promise((_, reject) => {
        lateTimeout = setTimeout(() => reject(new Error('late model request missing')), 90_000)
      })]).finally(() => clearTimeout(lateTimeout))
      assert.equal(modelRequests.length, 4, 'unexpected finalized model call order')
      assert(JSON.stringify(modelRequests[3].messages).includes(lateId), 'late model request lacks frozen character ID')
      await openCast(latePage)
      await castRow(latePage, lateId).click()
      await showProfileView(latePage, '当前状态')
      await profileField(latePage, '当前位置/阵营').fill('作者并发值')
      await saveCharacter(latePage)
      assert.equal(state(lateId).location, '作者并发值', 'cast page save did not persist before late response')
      assert.equal(JSON.parse(state(lateId).provenance).location.kind, 'author')
      const beforeRelease = { characterId: lateId, location: state(lateId).location,
        provenance: JSON.parse(state(lateId).provenance).location, requestCount: modelRequests.length }
      const secondOutbox = importDb.prepare('SELECT finalization_id AS finalizationId,content_hash AS contentHash FROM finalization_outbox WHERE draft_id=?')
        .get(secondDraft.id)
      assert(secondOutbox?.finalizationId, 'second stage finalization outbox missing')
      const secondSlot = { source: { draftId: secondDraft.id, chapterNumber: 2, ...secondOutbox }, stepKey: 'character_cards' }
      releaseLateModel(); releaseLateModel = undefined
      const failureRow = importDb.prepare(`SELECT s.ok,s.error_msg AS errorMsg,s.attempt_count AS attemptCount FROM post_process_steps s
        JOIN post_process_runs r ON r.id=s.run_id WHERE r.trigger_source_id=? AND s.step_key='character_cards' ORDER BY s.id DESC LIMIT 1`)
      let lateFailure
      for (let attempt = 0; attempt < 360; attempt++) {
        lateFailure = failureRow.get(`finalization:${secondOutbox.finalizationId}`)
        if (lateFailure?.attemptCount) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.equal(lateFailure?.ok, 0, 'late result did not fail the conflicting step')
      assert(lateFailure.errorMsg.includes('FIELD_CONFLICT'), `late result failure missing field conflict: ${lateFailure.errorMsg}`)
      assert.equal(lateFailure.attemptCount, 1, 'conflict retry created another post-process attempt')
      assert.equal(modelRequests.length, 4, 'conflict retry dispatched another model request')
      assert(modelRequests.slice(3).every(request => JSON.stringify(request.messages).includes(lateId)),
        'a retry escaped the frozen character ID')
      assert.equal(state(lateId).location, '作者并发值')
      assert.equal(state(finalizedIds[0]).location, '北塔')
      const quiet = await waitRunsQuiet(latePage, '第 2 章 · 定稿')
      const staleApp = app; app = null
      await closeAppBounded(staleApp)

      launched = await launch()
      app = launched.app
      const lateReopenPage = launched.page
      await openRolePage(lateReopenPage)
      for (const [id, value, origin] of [[lateId, '作者并发值', '作者输入'], [finalizedIds[0], '北塔', '定稿派生']]) {
        await castRow(lateReopenPage, id).click()
        await showProfileView(lateReopenPage, '当前状态')
        assert.equal(await profileField(lateReopenPage, '当前位置/阵营').inputValue(), value)
        assert.equal(await fieldSource(lateReopenPage, '当前位置/阵营').innerText(), origin)
      }
      const lateOpened = await invoke(lateReopenPage, 'project:open', projectPath, randomUUID(), projectPath)
      assert.equal(lateOpened.success, true, lateOpened.error)
      const lateSession = { projectId: created.projectId, projectPath, leaseId: lateOpened.project?.sessionLease }
      const recovered = await invoke(lateReopenPage, 'finalization-generation:read', { slot: secondSlot }, lateSession)
      assert.equal(recovered?.attemptCount, 1, 'conflict retry created another physical attempt')
      assert.equal(recovered?.view?.artifacts?.length, 1, 'late model artifact did not survive restart')
      assert(recovered.view.artifacts.every(artifact => artifact.text.includes('模型旧值')),
        'a late model artifact lost the stale proposal')
      assert.equal(recovered.effect, undefined, 'stale result was silently committed')
      assert.deepEqual(failureRow.get(`finalization:${secondOutbox.finalizationId}`), lateFailure)
      assert.equal(state(lateId).location, '作者并发值')
      assert.equal(JSON.parse(state(lateId).provenance).location.kind, 'author')
      assert.equal(JSON.parse(state(finalizedIds[0]).provenance).location.kind, 'derived')
      assert.equal(modelRequests.length, 4, 'reopening reran a stale model result')
      const verifiedApp = app; app = null
      await closeAppBounded(verifiedApp)
      steps.push({ stepId: currentStep, actionId: 'U09.A09', outcome: 'PASS',
        assertion: 'The cast page saved an author edit while a model response was held; the late result left a persisted field-conflict failure and artifact, and neither source or value regressed after restart.',
        observed: { beforeRelease, finalizationId: secondOutbox.finalizationId, failure: lateFailure, runSheet: quiet,
          artifactIds: recovered.view.artifacts.map(artifact => artifact.artifactId), modelRequestCount: modelRequests.length } })
      return
    }
    if (u09ImportOnly) {
      importDb = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
      const roster = () => importDb.prepare('SELECT character_id AS id,name,background,notes,static_provenance AS provenance FROM characters ORDER BY name').all()
      const original = roster()
      const sourceText = [
        `【原文】${importNames[0]}在旧港发现线索。`,
        `【大纲】${importNames[0]}负责调查失踪案。`,
        `【世界观】旧港有严格的夜航禁令。`,
      ].join('\n')
      // 提取的候选停在运行侧页「需要你确认」里，同一张运行卡片上有「取消」。
      const panel = runSheet.sheet(rolePage).getByRole('region', { name: '需要你确认' })
      const importButton = arch.castRoster(rolePage).getByRole('button', { name: '粘贴 / 导入角色卡', exact: true })
      const importSource = rolePage.getByRole('dialog').getByRole('textbox', { name: '角色卡全文' })
      const openImport = async text => {
        if (!await importSource.isVisible()) await importButton.click()
        await importSource.fill(text)
        await rolePage.getByRole('dialog').getByRole('button', { name: 'AI 提取并预览' }).click()
        await rolePage.getByRole('dialog').getByRole('button', { name: '发送并提取' }).click()
        await runSheet.waitUntilOpen(rolePage)
        await runSheet.tab(rolePage, '进行中').click()
        await panel.waitFor({ state: 'visible', timeout: 30_000 })
        assert.equal(await rolePage.locator(stage.STAGE_SHELL).count(), 1)
      }
      const waitImportSettled = () => rolePage.waitForFunction(() => {
        const button = [...document.querySelectorAll('.cast-roster button')].find(candidate => candidate.textContent?.includes('粘贴 / 导入角色卡'))
        return button && !button.disabled
      }, null, { timeout: 30_000 })
      currentStep = 'u09-a01-extract'
      await openImport(sourceText)
      assert.equal(modelRequests.length, 1)
      const sent = JSON.stringify(modelRequests[0].messages)
      for (const text of ['【原文】', '【大纲】', '【世界观】', importNames[0]]) assert(sent.includes(text), `fixture did not receive ${text}`)
      await panel.getByText(importNames[0], { exact: false }).first().waitFor({ state: 'visible' })
      assert.deepEqual(roster(), original, 'extraction changed canonical characters before approval')
      steps.push({ stepId: currentStep, actionId: 'U09.A01', outcome: 'PASS',
        assertion: 'The cast page paste entry sent text, outline, and worldbuilding to the controlled endpoint and the run sheet showed a candidate without writing characters.',
        observed: { modelRequestCount: 1, sourceKinds: ['text', 'outline', 'worldbuilding'], candidateName: importNames[0] } })

      currentStep = 'u09-a02-edit'
      await panel.locator('select[aria-label^="采用方式："]').first().selectOption('create')
      await panel.getByText('编辑导入候选', { exact: true }).click()
      const editedName = `作者改名${runId.slice(0, 4)}`
      const editedBackground = `作者补充背景 ${runId.slice(0, 8)}`
      await panel.getByRole('textbox', { name: `编辑候选姓名：1:1:character:1` }).fill(editedName)
      await panel.getByRole('textbox', { name: `编辑候选背景：1:1:character:1` }).fill(editedBackground)
      assert.deepEqual(roster(), original, 'editing candidate changed canonical characters before approval')
      steps.push({ stepId: currentStep, actionId: 'U09.A02', outcome: 'PASS',
        assertion: 'The run-sheet candidate name and background were editable before approval without changing the canonical roster.',
        observed: { editedName, editedBackground } })

      currentStep = 'u09-a03-accept'
      await panel.getByRole('button', { name: '按当前选择确认', exact: true }).click()
      await waitImportSettled()
      const accepted = roster()
      assert.equal(accepted.length, original.length + 1)
      const saved = accepted.find(row => row.name === editedName)
      assert(saved && saved.background === editedBackground && saved.notes === '合成提取')
      const provenance = JSON.parse(saved.provenance)
      assert.equal(provenance.kind, 'generated')
      assert.equal(provenance.fields.name.kind, 'author')
      assert.equal(provenance.fields.background.kind, 'author')
      assert.equal(provenance.fields.notes, undefined)
      steps.push({ stepId: currentStep, actionId: 'U09.A03', outcome: 'PASS',
        assertion: 'One run-sheet confirmation atomically adopted the candidate with author provenance only on edited fields.',
        observed: { id: saved.id, editedName, editedBackground, uneditedNotes: saved.notes } })

      currentStep = 'u09-a04-reject-cancel'
      const rejectedSource = `${importNames[1]}是旧港配角；拒绝此人物。`
      await openImport(rejectedSource)
      await panel.locator('select[aria-label^="采用方式："]').first().selectOption('keep-unresolved')
      await panel.getByRole('button', { name: '按当前选择确认', exact: true }).click()
      await waitImportSettled()
      assert.deepEqual(roster(), accepted, 'rejected candidate changed original roster')
      await importSource.waitFor({ state: 'visible' })
      assert.equal(await importSource.inputValue(), rejectedSource,
        'rejecting every candidate discarded the original pasted text')
      const cancelledSource = `${importNames[2]}来自作者未采用的世界观草稿。`
      await openImport(cancelledSource)
      await runSheet.sheet(rolePage).getByRole('article').filter({ has: rolePage.getByRole('region', { name: '需要你确认' }) })
        .getByRole('button', { name: /^取消「/ }).click()
      await importSource.waitFor({ state: 'visible', timeout: 30_000 })
      assert.equal(await importSource.inputValue(), cancelledSource)
      assert.deepEqual(roster(), accepted, 'cancelled candidate changed original roster')
      assert.equal(modelRequests.length, 3)
      steps.push({ stepId: currentStep, actionId: 'U09.A04', outcome: 'PASS',
        assertion: 'Explicit keep-unresolved and cancelling the run in the run sheet preserved the accepted roster; both retained the pasted source text.',
        observed: { modelRequestCount: modelRequests.length, retainedRejectedSource: rejectedSource,
          retainedCancelledSource: cancelledSource } })
      return
    }
    const [firstId, secondId] = [await addCharacter(rolePage, names[0]), await addCharacter(rolePage, names[1])]
    assert.notEqual(firstId, secondId)
    pass('stage-role-entry', { names, ids: [firstId, secondId] })

    currentStep = 'fixture-avatar'
    const avatarBase64 = await rolePage.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 32
      const draw = canvas.getContext('2d')
      draw.fillStyle = '#a8842f'
      draw.fillRect(0, 0, 32, 32)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const opened = await invoke(rolePage, 'project:open', projectPath, randomUUID(), projectPath)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: created.projectId, projectPath, leaseId: opened.project?.sessionLease }
    assert(context.leaseId, 'project session lease missing')
    const avatar = await invoke(rolePage, 'character-avatar:commit', firstId, avatarBase64, context)
    assert.equal(avatar.success, true, JSON.stringify(avatar.error))
    const avatarRoot = path.join(projectPath, '.ai-novel', 'avatars')
    const persistedAvatarFiles = fs.readdirSync(avatarRoot, { recursive: true })
      .map(name => path.join(avatarRoot, name)).filter(file => fs.statSync(file).isFile())
    assert.equal(persistedAvatarFiles.length, 1, 'expected one persisted avatar asset')
    let persistedAvatarPath = persistedAvatarFiles[0]
    let persistedAvatarBytes = fs.readFileSync(persistedAvatarPath)
    assert(persistedAvatarBytes.equals(Buffer.from(avatar.avatar.base64, 'base64')), 'persisted avatar bytes differ from commit response')
    await closeAppBounded(app)
    app = null

    launched = await launch()
    app = launched.app
    const editProcessPid = app.process().pid
    const profilePage = launched.page
    await openRolePage(profilePage)
    const characterCard = castRow(profilePage, firstId)
    await characterCard.waitFor({ state: 'visible' })
    currentStep = 'u10-a07-cast-row-avatar-reopen'
    await profilePage.waitForFunction(characterId => {
      const image = document.querySelector(`.cast-roster [data-character-id="${characterId}"] img`)
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 32
    }, firstId)
    await characterCard.click()
    await profilePage.waitForFunction(() => {
      const image = document.querySelector('img.cast-profile-avatar')
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 32
    })
    assert.equal(await profileAvatar(profilePage).getAttribute('alt'), `${names[0]}头像`)
    await profilePage.screenshot({ path: path.join(receiptDir, 'stage-character-profile.png') })

    const sourceImage = path.join(scratch, 'avatar-blue.png')
    const blueBase64 = await profilePage.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 32
      const draw = canvas.getContext('2d')
      draw.fillStyle = '#1876d2'
      draw.fillRect(0, 0, 32, 32)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    fs.writeFileSync(sourceImage, Buffer.from(blueBase64, 'base64'))
    const avatarState = (characterId = firstId) => {
      const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
      try {
        const row = db.prepare('SELECT asset_revision AS revision, relative_path AS relativePath, content_hash AS contentHash, byte_size AS byteSize, mime FROM character_avatar_assets WHERE character_id=?').get(characterId)
        return { row, files: fs.readdirSync(avatarRoot, { recursive: true }).map(name => path.join(avatarRoot, name))
          .filter(file => fs.statSync(file).isFile()).map(file => ({ path: file, sha256: sha256(file) })).sort((a, b) => a.path.localeCompare(b.path)) }
      } finally { db.close() }
    }
    const assetPath = row => path.join(projectPath, '.ai-novel', ...row.relativePath.split('/'))
    const originalAvatar = avatarState()
    const previewHash = () => imageHash(profileAvatar(profilePage))
    assert.equal(await previewHash(), sha256(persistedAvatarPath))
    const avatarButton = (page, name) => stage.root(page).getByRole('button', { name, exact: true })

    currentStep = 'u10-a01-stage-preview'
    await avatarButton(profilePage, '更换头像').click()
    chooseNativeAvatar(sourceImage)
    await avatarButton(profilePage, '取消头像更改').waitFor({ state: 'visible' })
    const stagedHash = await previewHash()
    assert.equal(stagedHash, sha256(sourceImage), 'UI preview bytes differ from native-selected file')
    assert.notEqual(stagedHash, sha256(persistedAvatarPath), 'chosen image did not replace UI preview')
    assert.deepEqual(avatarState(), originalAvatar, 'preview changed SQLite or persisted avatar bytes')
    await profilePage.screenshot({ path: path.join(receiptDir, 'stage-avatar-staged.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A01', outcome: 'PASS',
      assertion: 'The cast profile shows the native-selected avatar only as a staged preview; SQLite row and asset bytes are unchanged.',
      observed: { characterId: firstId, picker: pickerEvidence.at(-1), stagedSha256: stagedHash, originalAvatar } })

    currentStep = 'u10-a02-discard-stage'
    await avatarButton(profilePage, '取消头像更改').click()
    await avatarButton(profilePage, '取消头像更改').waitFor({ state: 'hidden' })
    assert.equal(await previewHash(), sha256(persistedAvatarPath), 'discard did not restore original UI preview')
    assert.deepEqual(avatarState(), originalAvatar, 'discard changed SQLite or persisted avatar bytes')
    await profilePage.screenshot({ path: path.join(receiptDir, 'stage-avatar-discarded.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A02', outcome: 'PASS',
      assertion: 'Discarding the selected avatar restores the original UI preview, SQLite row and asset bytes.',
      observed: { characterId: firstId, originalRevision: originalAvatar.row.revision, originalSha256: sha256(persistedAvatarPath) } })

    currentStep = 'u10-a03-save-avatar'
    await avatarButton(profilePage, '更换头像').click()
    chooseNativeAvatar(sourceImage)
    await avatarButton(profilePage, '取消头像更改').waitFor({ state: 'visible' })
    await saveCharacter(profilePage)
    const committedAvatar = avatarState()
    assert.equal(committedAvatar.row.revision, originalAvatar.row.revision + 1)
    persistedAvatarPath = path.join(projectPath, '.ai-novel', ...committedAvatar.row.relativePath.split('/'))
    persistedAvatarBytes = fs.readFileSync(persistedAvatarPath)
    assert.equal(sha256(persistedAvatarPath), committedAvatar.row.contentHash)
    assert.notEqual(committedAvatar.row.contentHash, originalAvatar.row.contentHash)
    assert.equal(await previewHash(), committedAvatar.row.contentHash)
    await profilePage.screenshot({ path: path.join(receiptDir, 'stage-avatar-saved.png') })

    currentStep = 'cast-graph-stable-id'
    await profileField(profilePage, '背景').fill(backgrounds[0])
    await profileField(profilePage, '关系网').fill(`${names[1]}：同盟`)
    await saveCharacter(profilePage)
    await showProfileView(profilePage, '关系图谱')
    const graph = profilePage.locator('canvas[aria-label^="角色关系图谱"]')
    await graph.waitFor({ state: 'visible' })
    assert((await graph.getAttribute('aria-label'))?.includes('同盟'), 'relationship missing from graph projection')
    await profilePage.screenshot({ path: path.join(receiptDir, 'stage-character-graph.png') })
    await profilePage.locator(`button[data-graph-character-id="${secondId}"]`).click()
    await arch.profileName(profilePage).filter({ hasText: new RegExp(`^${names[1]}$`) }).waitFor({ state: 'visible' })
    assert.equal(await castRow(profilePage, secondId).getAttribute('aria-pressed'), 'true')
    pass('cast-graph-stable-id', { sourceId: firstId, targetId: secondId, relation: '同盟' })
    await profilePage.screenshot({ path: path.join(receiptDir, 'stage-character-graph-open.png') })

    currentStep = 'fixture-second-avatar-before-rename'
    const secondSourceImage = path.join(scratch, 'avatar-gold.png')
    fs.writeFileSync(secondSourceImage, Buffer.from(avatarBase64, 'base64'))
    await avatarButton(profilePage, '选择头像').click()
    chooseNativeAvatar(secondSourceImage)
    await avatarButton(profilePage, '取消头像更改').waitFor({ state: 'visible' })
    await saveCharacter(profilePage)

    currentStep = 'u09-a08-same-name-rename'
    await profileField(profilePage, '背景').fill(backgrounds[1])
    await profileField(profilePage, '姓名').fill(names[0])
    await saveCharacter(profilePage)

    currentStep = 'u10-a09-rename-same-name-avatar-identity'
    const firstRenamedAvatar = avatarState(firstId).row
    const secondRenamedAvatar = avatarState(secondId).row
    assert(firstRenamedAvatar && secondRenamedAvatar, 'two saved avatars required before same-name rename')
    assert.notEqual(firstRenamedAvatar.contentHash, secondRenamedAvatar.contentHash,
      'same-name identity sentinels must have different avatar bytes')
    const renamedDb = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
    try {
      const renamedNames = renamedDb.prepare('SELECT character_id AS id,name FROM characters WHERE character_id IN (?,?)').all(firstId, secondId)
      assert.deepEqual(new Map(renamedNames.map(row => [row.id, row.name])), new Map([[firstId, names[0]], [secondId, names[0]]]))
    } finally { renamedDb.close() }
    for (const [id, row] of [[firstId, firstRenamedAvatar], [secondId, secondRenamedAvatar]]) {
      const image = castRow(profilePage, id).locator('img')
      await image.waitFor({ state: 'visible' })
      assert.equal(await imageHash(image), row.contentHash, `${id} row has another person's avatar after rename`)
      assert.equal(sha256(assetPath(row)), row.contentHash)
    }
    await profilePage.screenshot({ path: path.join(receiptDir, 'stage-avatar-same-name-identity.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A09', outcome: 'PASS',
      assertion: 'After renaming to an existing display name on the cast page, two distinct avatar byte sentinels remain bound to their original stable IDs in roster rows, SQLite and assets.',
      observed: { displayName: names[0], firstId, secondId, firstSha256: firstRenamedAvatar.contentHash,
        secondSha256: secondRenamedAvatar.contentHash, firstRevision: firstRenamedAvatar.revision, secondRevision: secondRenamedAvatar.revision } })

    currentStep = 'u10-a07-cast-row-avatar-reopen'
    const reopened = await invoke(profilePage, 'project:open', projectPath, randomUUID(), projectPath)
    assert.equal(reopened.success, true, reopened.error)
    const reopenedContext = { projectId: created.projectId, projectPath, leaseId: reopened.project?.sessionLease }
    assert(reopenedContext.leaseId, 'reopened project session lease missing')
    const batch = await invoke(profilePage, 'character-avatar:read-batch', [firstId], reopenedContext)
    assert.equal(batch.success, true, JSON.stringify(batch.error))
    assert.equal(batch.avatars.length, 1)
    assert.equal(batch.avatars[0].characterId, firstId)
    assert(Buffer.from(batch.avatars[0].base64, 'base64').equals(persistedAvatarBytes), 'read-batch bytes differ from persisted asset')
    steps.push({ stepId: currentStep, actionId: 'U10.A07', outcome: 'PASS',
      assertion: 'The cast roster row renders the stable-ID avatar after process restart; main read-batch returns the persisted file bytes.',
      observed: { characterId: firstId, avatarWidth: 32, assetRevision: batch.avatars[0].assetRevision,
        persistedAsset: path.relative(projectPath, persistedAvatarPath).split(path.sep).join('/'),
        persistedByteSize: persistedAvatarBytes.length, persistedSha256: sha256(persistedAvatarPath) } })

    await closeAppBounded(app)
    app = null
    launched = await launch()
    app = launched.app
    const reopenedProcessPid = app.process().pid
    assert.notEqual(reopenedProcessPid, editProcessPid, 'avatar reopen reused Electron process')
    let identityPage = launched.page
    await openRolePage(identityPage)
    currentStep = 'u09-a08-same-name-reopen'
    const firstSameName = castRow(identityPage, firstId)
    const secondSameName = castRow(identityPage, secondId)
    await firstSameName.waitFor({ state: 'visible' })
    await secondSameName.waitFor({ state: 'visible' })
    assert((await firstSameName.innerText()).includes(backgrounds[0]), 'first same-name row lost its source note')
    assert((await secondSameName.innerText()).includes(backgrounds[1]), 'second same-name row lost its source note')
    assert.equal(await arch.castRoster(identityPage).locator('[data-character-id]').filter({ hasText: names[0] }).count(), 2,
      'same-name rows were merged in the cast roster')
    await identityPage.screenshot({ path: path.join(receiptDir, 'stage-character-same-name.png') })

    await firstSameName.click()
    await showProfileView(identityPage, '关系图谱')
    const sameNameGraph = identityPage.locator('canvas[aria-label^="角色关系图谱"]')
    await sameNameGraph.waitFor({ state: 'visible' })
    const graphLabel = await sameNameGraph.getAttribute('aria-label')
    assert(graphLabel?.includes(firstId.slice(-8)) && graphLabel.includes(secondId.slice(-8)) && graphLabel.includes('同盟'),
      'same-name graph did not expose stable-ID endpoints')
    await identityPage.screenshot({ path: path.join(receiptDir, 'stage-character-same-name-graph.png') })

    const inspectSameNameRoster = async () => {
      const identityOpened = await invoke(identityPage, 'project:open', projectPath, randomUUID(), projectPath)
      assert.equal(identityOpened.success, true, identityOpened.error)
      const identityContext = { projectId: identityOpened.project?.id, projectPath, leaseId: identityOpened.project?.sessionLease }
      assert(identityContext.projectId && identityContext.leaseId, 'reopened identity project session missing')
      const roster = await invoke(identityPage, 'db:character-roster-read', projectPath, identityContext)
      const byId = new Map(roster.entries.map(entry => [entry.characterId, entry]))
      assert.equal(byId.get(firstId)?.name, names[0])
      assert.equal(byId.get(secondId)?.name, names[0])
      assert.equal(byId.get(firstId)?.background, backgrounds[0])
      assert.equal(byId.get(secondId)?.background, backgrounds[1])
      assert(byId.get(firstId)?.relationships.some(item => item.targetCharacterId === secondId && item.relation === '同盟'),
        'main roster snapshot lost stable-ID relationship after same-name rename')

      const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
      let persistedCharacters
      let persistedAliases
      let persistedRelationship
      try {
        persistedCharacters = db.prepare(`SELECT character_id AS characterId,name,background,retired FROM characters
          WHERE character_id IN (?,?) ORDER BY character_id`).all(firstId, secondId)
        persistedAliases = db.prepare(`SELECT character_id AS characterId,name,source_key AS sourceKey,valid_from AS validFrom,
          valid_through AS validThrough FROM character_aliases WHERE character_id IN (?,?)
          ORDER BY character_id,valid_from`).all(firstId, secondId)
        persistedRelationship = db.prepare(`SELECT source_character_id AS sourceCharacterId,target_character_id AS targetCharacterId,
          relation FROM character_relationships WHERE source_character_id=? AND target_character_id=?`).get(firstId, secondId)
      } finally { db.close() }
      assert.equal(persistedCharacters.length, 2, 'same-name rename merged SQLite identities')
      assert.deepEqual(new Map(persistedCharacters.map(row => [row.characterId, row.background])),
        new Map([[firstId, backgrounds[0]], [secondId, backgrounds[1]]]))
      assert(persistedCharacters.every(row => row.name === names[0] && row.retired === 0), 'same-name SQLite rows were overwritten or retired')
      assert(persistedAliases.some(row => row.characterId === secondId && row.name === names[1] && row.validThrough !== null),
        'renamed identity lost its closed historical alias')
      assert(persistedAliases.some(row => row.characterId === firstId && row.name === names[0] && row.validThrough === null)
        && persistedAliases.some(row => row.characterId === secondId && row.name === names[0] && row.validThrough === null),
      'same display name did not retain two active ID-scoped aliases')
      assert.deepEqual(persistedRelationship,
        { sourceCharacterId: firstId, targetCharacterId: secondId, relation: '同盟' })
      steps.push({ stepId: currentStep, actionId: 'U09.A08', outcome: 'PASS',
        assertion: 'The cast roster keeps two renamed same-name rows separate by stable ID/source note after restart; main IPC and SQLite retain both backgrounds, alias history and the ID-bound relationship without merge or overwrite.',
        observed: { displayName: names[0], ids: [firstId, secondId], sourceDisplay: backgrounds,
          derivedSourceRequired: false, sourceDisplayContract: 'background note or stable-ID suffix',
          mainRosterIdentityRevision: roster.identityRevision, relationship: persistedRelationship,
          activeSameNameAliases: persistedAliases.filter(row => row.name === names[0] && row.validThrough === null).length } })
    }

    currentStep = 'u10-a10-reopen-same-name-avatars'
    await showProfileView(identityPage, '基础设定')
    for (const [id, row] of [[firstId, firstRenamedAvatar], [secondId, secondRenamedAvatar]]) {
      const image = castRow(identityPage, id).locator('img')
      await image.waitFor({ state: 'visible' })
      assert.equal(await imageHash(image), row.contentHash, `${id} row avatar changed after process restart`)
      await castRow(identityPage, id).click()
      await profileAvatar(identityPage).waitFor({ state: 'visible' })
      await identityPage.waitForFunction(characterId => document.querySelector(`.cast-roster [data-character-id="${characterId}"]`)
        ?.getAttribute('aria-pressed') === 'true', id)
      assert.equal(await imageHash(profileAvatar(identityPage)), row.contentHash, `${id} profile avatar changed after process restart`)
      assert.deepEqual(avatarState(id).row, row, `${id} SQLite avatar row changed after process restart`)
      assert.equal(sha256(assetPath(row)), row.contentHash)
    }
    assert.notEqual(reopenedProcessPid, editProcessPid)
    await identityPage.screenshot({ path: path.join(receiptDir, 'stage-avatar-same-name-reopened.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A10', outcome: 'PASS',
      assertion: 'A new Electron process reopens both same-name roster rows and profile avatars with distinct stable-ID avatar bytes and unchanged SQLite asset revisions.',
      observed: { firstId, secondId, editProcessPid, reopenedProcessPid, firstSha256: firstRenamedAvatar.contentHash,
        secondSha256: secondRenamedAvatar.contentHash, firstRevision: firstRenamedAvatar.revision, secondRevision: secondRenamedAvatar.revision } })

    currentStep = 'u10-a03-reopen-avatar'
    await firstSameName.click()
    await identityPage.waitForFunction(characterId => document.querySelector(`.cast-roster [data-character-id="${characterId}"]`)
      ?.getAttribute('aria-pressed') === 'true', firstId)
    await profileAvatar(identityPage).waitFor({ state: 'visible' })
    assert.equal(await imageHash(profileAvatar(identityPage)), committedAvatar.row.contentHash)
    const reopenedAvatars = avatarState()
    assert.deepEqual(reopenedAvatars.row, committedAvatar.row, 'fresh process changed committed avatar')
    assert.deepEqual(avatarState(secondId).row, secondRenamedAvatar, 'fresh process changed second avatar')
    assert.deepEqual(reopenedAvatars.files, [...committedAvatar.files,
      { path: assetPath(secondRenamedAvatar), sha256: secondRenamedAvatar.contentHash }].sort((a, b) => a.path.localeCompare(b.path)),
    'fresh process changed committed avatar assets')
    await identityPage.screenshot({ path: path.join(receiptDir, 'stage-avatar-reopened.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A03', outcome: 'PASS',
      assertion: '保存角色 committed the native-selected avatar to a new SQLite revision and asset bytes; a fresh Electron process reopens the same stable-ID avatar.',
      observed: { characterId: firstId, picker: pickerEvidence.at(-1), editProcessPid, reopenedProcessPid, revision: committedAvatar.row.revision,
        relativePath: committedAvatar.row.relativePath, persistedSha256: committedAvatar.row.contentHash } })

    currentStep = 'u09-a08-same-name-roster'
    await inspectSameNameRoster()

    const previewInfo = page => profileAvatar(page).evaluate(async image => {
      const bytes = new Uint8Array(await (await fetch(image.src)).arrayBuffer())
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      return { sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
        width: image.naturalWidth, height: image.naturalHeight }
    })
    const reopenRolePage = async () => {
      await closeAppBounded(app)
      app = null
      const relaunched = await launch()
      app = relaunched.app
      await openRolePage(relaunched.page)
      return relaunched.page
    }
    const selectRow = async (page, characterId) => {
      await castRow(page, characterId).click()
      await page.waitForFunction(id => document.querySelector(`.cast-roster [data-character-id="${id}"]`)
        ?.getAttribute('aria-pressed') === 'true', characterId)
    }

    currentStep = 'u10-a04-large-compress-invalid-preserve'
    identityPage = await reopenRolePage()
    const otherAvatar = avatarState(secondId).row
    assert.equal(otherAvatar.revision, 1)
    const otherAssetPath = assetPath(otherAvatar)
    assert.equal(sha256(otherAssetPath), otherAvatar.contentHash)
    await selectRow(identityPage, firstId)
    await profileAvatar(identityPage).waitFor({ state: 'visible' })
    assert.equal((await previewInfo(identityPage)).sha256, committedAvatar.row.contentHash)

    const largeSource = path.join(scratch, 'avatar-large.png')
    const largeBase64 = await identityPage.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 768
      const context = canvas.getContext('2d')
      const pixels = context.createImageData(768, 768)
      let seed = 1
      for (let index = 0; index < pixels.data.length; index += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        pixels.data[index] = seed & 255
        pixels.data[index + 1] = (seed >>> 8) & 255
        pixels.data[index + 2] = (seed >>> 16) & 255
        pixels.data[index + 3] = 255
      }
      context.putImageData(pixels, 0, 0)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    fs.writeFileSync(largeSource, Buffer.from(largeBase64, 'base64'))
    const largeSourceBytes = fs.statSync(largeSource).size
    assert(largeSourceBytes > 100_000 && largeSourceBytes < 4 * 1024 * 1024, 'large synthetic PNG is outside avatar input contract')
    await avatarButton(identityPage, '更换头像').click()
    chooseNativeAvatar(largeSource)
    await avatarButton(identityPage, '取消头像更改').waitFor({ state: 'visible' })
    assert.equal((await previewInfo(identityPage)).sha256, sha256(largeSource))
    await saveCharacter(identityPage)
    const compressedAvatar = avatarState()
    assert.equal(compressedAvatar.row.revision, committedAvatar.row.revision + 1)
    assert.equal(sha256(assetPath(compressedAvatar.row)), compressedAvatar.row.contentHash)
    assert.equal(fs.statSync(assetPath(compressedAvatar.row)).size, compressedAvatar.row.byteSize)
    assert(compressedAvatar.row.byteSize < largeSourceBytes, 'large PNG was not compressed')
    await identityPage.waitForFunction(() => {
      const image = document.querySelector('img.cast-profile-avatar')
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 && image.naturalWidth <= 256
    })
    const compressedPreview = await previewInfo(identityPage)
    assert.equal(compressedPreview.sha256, compressedAvatar.row.contentHash)
    assert(compressedPreview.width <= 256 && compressedPreview.height <= 256 && compressedPreview.width > 0 && compressedPreview.height > 0,
      'stored avatar exceeds the 256-pixel edge contract')
    await identityPage.screenshot({ path: path.join(receiptDir, 'stage-avatar-compressed.png') })

    const badSource = path.join(scratch, 'avatar-bad.png')
    fs.writeFileSync(badSource, 'not an image')
    await avatarButton(identityPage, '更换头像').click()
    chooseNativeAvatar(badSource)
    await stage.root(identityPage).getByRole('alert').filter({ hasText: '请选择有效的 PNG、JPEG 或 WebP 图片。' }).waitFor({ state: 'visible' })
    assert.deepEqual(avatarState(), compressedAvatar, 'invalid image changed SQLite or asset bytes')
    assert.equal((await previewInfo(identityPage)).sha256, compressedAvatar.row.contentHash)
    await identityPage.screenshot({ path: path.join(receiptDir, 'stage-avatar-invalid-preserved.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A04', outcome: 'PASS',
      assertion: 'Native selection and 保存角色 compress a valid large image within the 256-pixel bound; an invalid selected PNG shows an error and preserves the saved SQLite row and asset.',
      observed: { characterId: firstId, validPicker: pickerEvidence.at(-2), invalidPicker: pickerEvidence.at(-1),
        sourceBytes: largeSourceBytes, storedBytes: compressedAvatar.row.byteSize, dimensions: compressedPreview,
        revision: compressedAvatar.row.revision, persistedSha256: compressedAvatar.row.contentHash } })

    currentStep = 'u10-a05-replace-avatar'
    await avatarButton(identityPage, '更换头像').click()
    chooseNativeAvatar(sourceImage)
    await avatarButton(identityPage, '取消头像更改').waitFor({ state: 'visible' })
    await saveCharacter(identityPage)
    const replacedAvatar = avatarState()
    assert.equal(replacedAvatar.row.revision, compressedAvatar.row.revision + 1)
    assert.equal(sha256(assetPath(replacedAvatar.row)), replacedAvatar.row.contentHash)
    assert.notEqual(replacedAvatar.row.contentHash, compressedAvatar.row.contentHash)
    assert.equal(fs.existsSync(assetPath(compressedAvatar.row)), false, 'replaced avatar file was not reclaimed')
    assert.equal((await previewInfo(identityPage)).sha256, replacedAvatar.row.contentHash)
    const replaceProcessPid = app.process().pid
    const replacementPage = await reopenRolePage()
    const replacementReopenPid = app.process().pid
    assert.notEqual(replacementReopenPid, replaceProcessPid, 'replacement reused Electron process')
    await castRow(replacementPage, firstId).locator('img').waitFor({ state: 'visible' })
    await selectRow(replacementPage, firstId)
    await profileAvatar(replacementPage).waitFor({ state: 'visible' })
    assert.equal((await previewInfo(replacementPage)).sha256, replacedAvatar.row.contentHash)
    assert.deepEqual(avatarState(), replacedAvatar, 'replacement changed after process restart')
    await replacementPage.screenshot({ path: path.join(receiptDir, 'stage-avatar-replaced-reopened.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A05', outcome: 'PASS',
      assertion: 'A second native selection and 保存角色 increments the stable-ID revision, reclaims the old file, and reopens the new avatar in a fresh Electron process.',
      observed: { characterId: firstId, picker: pickerEvidence.at(-1), revision: replacedAvatar.row.revision,
        oldRelativePath: compressedAvatar.row.relativePath, newRelativePath: replacedAvatar.row.relativePath,
        persistedSha256: replacedAvatar.row.contentHash, replaceProcessPid, replacementReopenPid } })

    currentStep = 'u10-a06-remove-avatar'
    await avatarButton(replacementPage, '移除头像').click()
    await avatarButton(replacementPage, '取消头像更改').waitFor({ state: 'visible' })
    assert.deepEqual(avatarState(), replacedAvatar, 'staged removal changed SQLite or asset bytes')
    await saveCharacter(replacementPage)
    assert.equal(avatarState().row, undefined, 'removed avatar kept a SQLite binding')
    assert.equal(fs.existsSync(assetPath(replacedAvatar.row)), false, 'removed avatar file was not reclaimed')
    assert.deepEqual(avatarState(secondId).row, otherAvatar, 'other character avatar binding changed')
    assert.equal(sha256(otherAssetPath), otherAvatar.contentHash, 'other character avatar bytes changed')
    await replacementPage.screenshot({ path: path.join(receiptDir, 'stage-avatar-removed.png') })
    const removeProcessPid = app.process().pid
    const removalPage = await reopenRolePage()
    const removalReopenPid = app.process().pid
    assert.notEqual(removalReopenPid, removeProcessPid, 'removal reused Electron process')
    const removedFirst = castRow(removalPage, firstId)
    const preservedSecond = castRow(removalPage, secondId)
    await removedFirst.waitFor({ state: 'visible' })
    await preservedSecond.locator('img').waitFor({ state: 'visible' })
    assert.equal(await removedFirst.locator('img').count(), 0)
    await selectRow(removalPage, firstId)
    await avatarButton(removalPage, '选择头像').waitFor({ state: 'visible' })
    assert.equal(await profileAvatar(removalPage).count(), 0)
    assert.equal(avatarState().row, undefined)
    assert.deepEqual(avatarState(secondId).row, otherAvatar)
    assert.equal(sha256(otherAssetPath), otherAvatar.contentHash)
    await removalPage.screenshot({ path: path.join(receiptDir, 'stage-avatar-removed-reopened.png') })
    steps.push({ stepId: currentStep, actionId: 'U10.A06', outcome: 'PASS',
      assertion: '移除头像 and 保存角色 clear the stable-ID binding, reclaim its asset, and persist the empty state across restart while the other character keeps its own avatar.',
      observed: { removedCharacterId: firstId, preservedCharacterId: secondId, removedRelativePath: replacedAvatar.row.relativePath,
        preservedRelativePath: otherAvatar.relativePath, preservedSha256: otherAvatar.contentHash, removeProcessPid, removalReopenPid } })
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
    if (app) {
      const windows = app.windows()
      if (windows.length) await windows[0].screenshot({ path: path.join(receiptDir, 'failure.png') }).catch(() => {})
    }
  } finally {
    const cleanupFailures = []
    releaseLateModel?.()
    try { importDb?.close() } catch (error) { cleanupFailures.push(`DATABASE_CLOSE_FAILED: ${error?.message}`) }
    try { if (app) await closeAppBounded(app) } catch (error) { cleanupFailures.push(error?.message) }
    try {
      if (controlledModel) await waitBounded(new Promise(resolve => server.close(resolve)), 10_000, 'LOOPBACK_CLOSE_TIMEOUT')
    } catch (error) { cleanupFailures.push(error?.message) }
    if (!failure && cleanupFailures.length) failure = { step: 'cleanup', name: 'CleanupError', message: cleanupFailures[0] }
    if (cleanupFailures.length) {
      const a09 = steps.find(step => step.actionId === 'U09.A09')
      if (a09) { a09.outcome = 'FAIL'; a09.cleanupFailure = cleanupFailures[0] }
    }
    const verifiedActions = [...new Set(steps.filter(step => step.outcome === 'PASS' && step.actionId).map(step => step.actionId))]
    const receipt = { schemaVersion: 1, qualification: u09ImportOnly ? 'F05_U09_A01_A02_A03_A04_PACKAGED_STAGE_IMPORT'
      : u09StaleOnly ? 'F05_U09_A09_STALE_SOURCE_PACKAGED_STAGE_FINALIZED'
        : u09FinalizedOnly ? 'F05_U09_A05_A06_A07_A08_A09_PACKAGED_STAGE_FINALIZED' : 'F05_U09_A08_U10_A01_A02_A03_A04_A05_A06_A07_A09_A10_PACKAGED_STAGE_CHARACTERS',
      outcome: failure ? 'FAIL' : 'PARTIAL', sliceOutcome: failure ? 'FAIL' : 'PASS', fullU10Qualification: false,
      fullU09Qualification: false, fullF05Qualification: false, evidenceLevel: 'electron', shell: 'stage', testedSha, executionHead, changedPaths,
      dirtyProductPaths, ignoredScreenshotPaths, ignoredTestOnlyPaths, package: { directory: packageDir, executableSha256: sha256(exe), asarSha256: sha256(asar) },
      ...(controlledModel ? { providerEvidence: { kind: 'controlled-loopback', realModelQualification: false,
        requestCount: modelRequests.length } } : {}),
      driver: { path: fileURLToPath(import.meta.url), sha256: sha256(fileURLToPath(import.meta.url)) },
      nativePickerHelper: { path: nativePickerHelper, sha256: sha256(nativePickerHelper) }, pickerEvidence,
      evidence: { receipt: path.relative(repository, receiptPath), screenshots: ['stage-character-profile.png', 'stage-avatar-staged.png', 'stage-avatar-discarded.png', 'stage-avatar-saved.png',
        'stage-character-graph.png', 'stage-character-graph-open.png',
        'stage-avatar-reopened.png', 'stage-character-same-name.png', 'stage-character-same-name-graph.png',
        'stage-avatar-compressed.png', 'stage-avatar-invalid-preserved.png', 'stage-avatar-replaced-reopened.png',
        'stage-avatar-removed.png', 'stage-avatar-removed-reopened.png',
        'stage-avatar-same-name-identity.png', 'stage-avatar-same-name-reopened.png', 'failure.png'].filter(name => fs.existsSync(path.join(receiptDir, name))) },
      verifiedActions, unverifiedActions: [u09ImportOnly ? 'U09.A05-U09.A09' : u09FinalizedOnly ? 'U09.A01-U09.A04' : 'U09.A01-U09.A07',
        ...(u09FinalizedOnly ? ['U09.A05', 'U09.A06', 'U09.A07', 'U09.A08', 'U09.A09'].filter(id => !verifiedActions.includes(id)) : []),
        ...(controlledModel ? [] : ['U09.A09']),
        ...['U10.A01', 'U10.A02', 'U10.A03', 'U10.A04', 'U10.A05', 'U10.A06', 'U10.A07', 'U10.A09', 'U10.A10'].filter(id => !verifiedActions.includes(id)),
        'U10.A08', 'U10.A11-U10.A12', 'F05 whole-product qualification'],
      projectPath, scratch, steps, failure, ...(cleanupFailures.length ? { cleanupFailures } : {}) }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, sliceOutcome: receipt.sliceOutcome, testedSha,
      driverSha256: receipt.driver.sha256, receipt: path.relative(repository, receiptPath), verifiedActions: receipt.verifiedActions })}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

await main()
