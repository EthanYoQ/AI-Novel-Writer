/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const Database = createRequire(import.meta.url)('better-sqlite3')
if (process.argv.includes('--help')) {
  process.stdout.write('F05 U13 packaged V3 HistoryList plus controlled workflow-status sub-evidence journey; pass fixed Windows package source and artifact hashes.\n')
  process.exit(0)
}
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const testedSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
const packageDir = option('package-dir') && path.resolve(repository, option('package-dir'))
assert(packageDir && testedSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', 'u13', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects'].map(name => [name, path.join(scratch, name)]))
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const driverPath = fileURLToPath(import.meta.url)
const model = { id: 'u13-history-fixture', name: 'U13 history fixture', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'u13-history-offline', maxTokens: 8192, temperature: 0.7, purposes: ['generation'] }
const syntheticProse = '合成正文'.repeat(30)
const projectName = `u13h-${runId.slice(0, 4)}`
const steps = []
const pass = (stepId, actionId, assertion, observed) => steps.push({ stepId, actionId, outcome: 'PASS', assertion, observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const writer = page => page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]')
async function assertWriter(page, actionId) {
  await writer(page).waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await writer(page).getAttribute('data-shell-variant'), 'v3', `${actionId}: shell is not V3`)
}
async function launch(port) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  await app.evaluate((_, fixturePort) => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://api.openai.com') throw new Error('U13_NETWORK_REFUSED')
      return originalFetch(`http://127.0.0.1:${fixturePort}${url.pathname}`, options)
    }
  }, port)
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(15_000)
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  return { app, page }
}
async function quit(app) { await app.close().catch(() => {}) }
async function openFromShelf(page, name) {
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${name}》` }).click()
  await page.locator('.writer-project-tree').getByText(name, { exact: true }).waitFor({ state: 'visible' })
}
const assistant = page => page.locator('.writer-ai-panel')
function durableRuns(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try { return db.prepare(`SELECT r.run_id, r.binding_json, a.attempt_json, a.usage_receipt_json
    FROM generation_runs r LEFT JOIN generation_attempts a ON a.run_id=r.run_id ORDER BY r.created_at_ms`).all()
    .map(row => ({ runId: row.run_id, operation: JSON.parse(row.binding_json).sourceManifest?.operation,
      attemptStatus: row.attempt_json && JSON.parse(row.attempt_json).status,
      usageTrusted: row.usage_receipt_json && JSON.parse(row.usage_receipt_json).result?.usage?.trusted === true,
      finishReason: row.usage_receipt_json && JSON.parse(row.usage_receipt_json).result?.finishReason })) }
  finally { db.close() }
}

async function main() {
  assert.equal(git('rev-parse', testedSha), testedSha, 'packaged tested SHA is unavailable')
  assert(fs.existsSync(executablePath) && fs.existsSync(asarPath), 'packaged Windows artifact is missing')
  const changedPaths = git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean)
  assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', 'src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '',
    'product input changed since package build')
  assert.equal(sha256(executablePath), expectedExe, 'packaged executable changed')
  assert.equal(sha256(asarPath), expectedAsar, 'packaged app changed')
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U13 HistoryList/workflow-status sub-evidence', sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 24,
    retainedReason: 'independent review of packaged V3 HistoryList and durable SQLite run identities',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const fixtureState = { requests: 0 }
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${model.apiKey}` || request.url !== '/v1/chat/completions') { response.writeHead(403).end(); return }
    fixtureState.requests++
    if (fixtureState.requests === 2) { response.writeHead(500).end('fixture failure'); return }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: syntheticProse }, finish_reason: 'stop' }] })}\n\n`)
    response.write('data: {"choices":[],"usage":{"prompt_tokens":400,"completion_tokens":200,"total_tokens":600}}\n\n')
    response.end('data: [DONE]\n\n')
  })
  let app
  let project
  let failure
  let currentStep = 'setup'
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    ;({ app } = await launch(port))
    const page = await app.firstWindow()
    await page.evaluate(() => { const key = 'ai-novel-writer-appearance'; const value = JSON.parse(localStorage.getItem(key) ?? '{}'); localStorage.setItem(key, JSON.stringify({ ...value, shellPreference: 'writer', revision: Number(value.revision ?? 0) + 1, origin: 'author' })) })
    await page.reload(); await assertWriter(page, 'writer-shell-selection')
    project = await invoke(page, 'project:create', { path: profile.projects, name: projectName, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(project.success, true, project.error)
    const opened = await invoke(page, 'project:open', project.projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: project.projectId, projectPath: project.projectPath, leaseId: opened.project.sessionLease }
    assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
    const roster = await invoke(page, 'db:character-roster-read', project.projectPath, context)
    const characterId = `draft:${randomUUID()}`
    const rosterCommit = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries: [{ characterId, name: '林岚', role: 'protagonist', gender: '', age: '', appearance: '', personality: '', background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }] }, project.projectPath, context)
    assert.equal(rosterCommit.success, true, JSON.stringify(rosterCommit))
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '历史印章章节', role: '发展', purpose: '验证历史', keyEvents: '验证状态', characters: [] }, project.projectPath, context)).success, true)
    await quit(app); app = null
    ;({ app } = await launch(port))
    const page2 = await app.firstWindow()
    await assertWriter(page2, 'project-open')
    await openFromShelf(page2, projectName)
    assert.equal(path.resolve((await invoke(page2, 'project:get-runtime-context')).activeProjectPath), path.resolve(project.projectPath))
    await page2.getByRole('button', { name: 'AI 输出', exact: true }).click()
    await page2.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    currentStep = 'U13.workflow-status-pending'
    await assertWriter(page2, 'U13.workflow-status-pending')
    await page2.getByRole('button', { name: '写作此章' }).click()
    await page2.getByRole('dialog').getByPlaceholder('3000').fill('100')
    await page2.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
    await page2.getByRole('button', { name: /中止生成|Stop generation/ }).waitFor({ state: 'visible' })
    pass('u13-workflow-status-pending', null, 'Writer active run exposes controlled pending/stop workflow status before provider completion as sub-evidence')
    await page2.getByRole('button', { name: /中止生成|Stop generation/ }).waitFor({ state: 'hidden', timeout: 30_000 })
    assert.equal(fixtureState.requests, 1, `first generation must reach the isolated provider fixture; UI: ${(await page2.locator('body').innerText()).slice(-1600)}`)
    await assertWriter(page2, 'U13.workflow-status-success-history')
    await assertWriter(page2, 'U13.workflow-status-success')
    await page2.getByText('合成正文', { exact: false }).first().waitFor({ state: 'visible', timeout: 5_000 })
    await page2.getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
    const db = new Database(path.join(project.projectPath, '.ai-novel', 'project.db'), { readonly: true })
    let savedDraft
    try { savedDraft = db.prepare('SELECT d.status, c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=1').get() } finally { db.close() }
    assert.equal(savedDraft?.body, syntheticProse, `first generation did not persist the completed draft; UI: ${(await page2.locator('body').innerText()).slice(-1000)}`)
    assert.equal(savedDraft?.status, 'draft', 'completed generation must remain an unfinalized draft')
    const successfulRuns = durableRuns(project.projectPath)
    assert.equal(successfulRuns.length, 1)
    assert.equal(successfulRuns[0].operation, 'chapter-draft')
    assert.equal(successfulRuns[0].attemptStatus, 'settled')
    assert.equal(successfulRuns[0].usageTrusted, true)
    assert.equal(successfulRuns[0].finishReason, 'stop')
    pass('u13-workflow-status-success', null, 'Writer completed workflow status, trusted settled provider attempt, visible output and persisted draft agree as sub-evidence',
      { status: savedDraft.status, attemptStatus: successfulRuns[0].attemptStatus, providerRequests: fixtureState.requests })
    currentStep = 'U13.workflow-status-failure'
    await page2.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    await assertWriter(page2, 'U13.workflow-status-failure')
    await page2.getByRole('button', { name: '写作此章' }).click()
    await page2.getByRole('dialog').getByPlaceholder('3000').fill('100')
    await page2.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
    await page2.getByText('工作流未完成', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(fixtureState.requests, 2, 'controlled failure must reach the fixture exactly once')
    const failureDb = new Database(path.join(project.projectPath, '.ai-novel', 'project.db'), { readonly: true })
    let draftCount
    try { draftCount = failureDb.prepare('SELECT count(*) AS count FROM drafts WHERE chapter_number=1').get().count } finally { failureDb.close() }
    assert.equal(draftCount, 1, 'failed provider request must not add another saved draft')
    pass('u13-workflow-status-failure', null, 'Writer exposes controlled provider failure without adding a draft as sub-evidence', { providerRequests: fixtureState.requests, draftCount })
    await assertWriter(page2, 'U13.workflow-status-failure-history')
    currentStep = 'U13.A08-select-history'
    const historyButtons = assistant(page2).getByRole('button', { name: /历史印章章节/ })
    await historyButtons.nth(1).waitFor({ state: 'visible' })
    assert.equal(await historyButtons.count(), 2, 'V3 must expose both completed and failed runs in selectable history')
    await historyButtons.nth(1).click()
    const selectedView = assistant(page2).locator('div.flex.flex-col.h-full.overflow-hidden.relative')
    assert.equal(await selectedView.count(), 1, 'selected V3 history result view is ambiguous')
    await selectedView.getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible' })
    const selectedBody = selectedView.getByText(savedDraft.body, { exact: true })
    for (const header of await selectedView.locator('[title="点击查看该步骤的历史输出"]').all()) {
      if (await selectedBody.count()) break
      await header.click()
    }
    await selectedBody.waitFor({ state: 'visible' })
    assert.equal(await selectedBody.innerText(), savedDraft.body, 'selected completed history output differs from the persisted draft')
    await historyButtons.nth(0).click()
    await selectedView.getByText('工作流未完成', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await selectedView.getByText(savedDraft.body, { exact: true }).count(), 0, 'failed history selection still shows completed-run body')
    const runs = durableRuns(project.projectPath)
    assert.equal(runs.length, 2)
    assert(runs.every(run => run.operation === 'chapter-draft'))
    assert.notEqual(runs[0].runId, runs[1].runId)
    assert.equal(runs[1].attemptStatus, 'unknown', 'failed provider attempt must not receive a trusted success status')
    assert.notEqual(runs[1].usageTrusted, true)
    const readSession = await invoke(page2, 'project:open', project.projectPath, randomUUID(), null)
    assert.equal(readSession.success, true, readSession.error)
    const readContext = { projectId: project.projectId, projectPath: project.projectPath, leaseId: readSession.project.sessionLease }
    const listedRuns = await invoke(page2, 'generation:list', readContext)
    assert.deepEqual(listedRuns.map(run => run.handle.runId).sort(), runs.map(run => run.runId).sort())
    pass('u13-v3-select-history', 'U13.A08', 'V3 HistoryList selected the exact persisted success body then the failed run; main IPC and SQLite retain two distinct chapter-draft run identities',
      { runIds: runs.map(run => run.runId), selectedStatuses: ['completed', 'failed'], selectedSuccessBodySha256: createHash('sha256').update(savedDraft.body).digest('hex') })
    await quit(app); app = null
    currentStep = 'U13.A08-reopen-boundary'
    ;({ app } = await launch(port))
    const reopenedPage = await app.firstWindow()
    await assertWriter(reopenedPage, 'U13.A08-reopen-boundary')
    await openFromShelf(reopenedPage, projectName)
    await reopenedPage.getByRole('button', { name: 'AI 输出', exact: true }).click()
    await assistant(reopenedPage).locator('section[aria-label="持久正文候选"]').waitFor({ state: 'visible' })
    await assistant(reopenedPage).locator('section[aria-label="持久正文候选"]').getByText('合成正文', { exact: false }).first().waitFor({ state: 'visible' })
    assert.equal(await assistant(reopenedPage).getByRole('button', { name: /历史印章章节/ }).count(), 0,
      'renderer workflow HistoryList is expected to be empty after a new process')
    assert.deepEqual(durableRuns(project.projectPath), runs, 'new process changed durable generation run identities')
    pass('u13-reopen-limitation', null, 'New V3 process exposes durable candidates while in-memory renderer HistoryList is empty; no history persistence is claimed',
      { durableRunIds: runs.map(run => run.runId), rendererHistoryCount: 0 })
  } catch (error) { failure = error }
  finally { if (app) await quit(app); if (server.listening) await new Promise(resolve => server.close(resolve)) }
  const receipt = { schemaVersion: 1, qualification: 'F05_U13_PACKAGED_V3_HISTORY_WORKFLOW_STATUS_SUBEVIDENCE', outcome: failure ? 'FAIL' : 'PARTIAL', evidenceLevel: 'electron', shell: 'writer', shellVariant: 'v3', scope: { kind: 'controlled-workflow-status-sub-evidence', workflowStatusSteps: ['u13-workflow-status-pending', 'u13-workflow-status-success', 'u13-workflow-status-failure'], verified: ['U13.A08 same-process V3 HistoryList selection', 'durable provider attempt and body assertions', 'new-process renderer HistoryList limitation'], excludes: ['U13.A09 DraftEditor PostProcessStatusPanel finalization pending/success/failure seal'] }, testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths, artifact: { executablePath, executableSha256: sha256(executablePath), asarPath, asarSha256: sha256(asarPath) }, driver: { path: driverPath, sha256: sha256(driverPath) }, profile: { projectRoot: profile.projects, scratch }, fixture: { provider: 'loopback synthetic OpenAI SSE', requests: fixtureState.requests, externalModelRequests: 0 }, steps,
    unverifiedActions: ['U13.A01 real model streaming', 'U13.A02 provider reasoning qualification', 'U13.A03-U13.A07', 'U13.A09 real DraftEditor PostProcessStatusPanel finalization pending/success/failure seal', 'release default and model quality'],
    limitation: 'Renderer workflow HistoryList is in-memory and empty in a new process; durable main-generation candidates remain visible without reconstructing that list',
    failedStep: failure ? currentStep : null, error: failure ? String(failure) : null }
  const receiptPath = path.join(repository, '.runtime', '.cache', 'f05-u13-history-seals', runId, 'receipt.json'); fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2)); process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, receipt: receiptPath, steps: steps.map(step => step.stepId), testedSha })}\n`); if (failure) throw failure
}

main().catch(error => { console.error(error); process.exitCode = 1 })
