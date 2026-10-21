/* global process */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import * as blueprint from './redesign/pages/blueprint.mjs'
import * as runSheet from './redesign/pages/run-sheet.mjs'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

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
const executablePath = resolveWindowsExecutable(packageDir)
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
// 纸墨外壳：写作此章在单章视图，已有草稿后再写一稿走蓝图页「写第 1 章」；运行状态、历史与可恢复的内容都在运行侧页。
const RUN_TITLE = '第 1 章 · 写稿'
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
  await stage.waitForStage(page)
  return { app, page }
}
async function quit(app) { await app.close().catch(() => {}) }
async function openFromShelf(page, name) {
  await stage.dismissMigrationNotice(page)
  await stage.showLibrary(page)
  await stage.openFromLibrary(page, name)
  await stage.waitForWork(page, name)
}
/** 运行侧页「历史」里的行，最新的在前。 */
async function historyRows(page) {
  await runSheet.openFromPalette(page)
  await runSheet.tab(page, '历史').click()
  const list = page.getByRole('list', { name: '运行历史' })
  // 「历史」页是点了之后才挂载的：先等列表或空状态出现，空历史的对照才有意义。
  await list.or(runSheet.sheet(page).getByText('还没有运行记录', { exact: true })).first().waitFor({ state: 'visible' })
  if (await list.count() === 0) return []
  return list.getByRole('listitem').evaluateAll(items => items.map(item => ({
    title: item.querySelector('.run-history-title')?.textContent ?? '',
    completed: item.querySelector('.run-visually-hidden')?.textContent?.startsWith('已完成') ?? false,
  })))
}
/** 展开历史第 index 行与其中每一步，返回展开后的文字；再点一次行就收起。 */
async function historyDetail(page, index) {
  const item = page.getByRole('list', { name: '运行历史' }).getByRole('listitem').nth(index)
  await item.locator('.run-history-row').click()
  const detail = item.locator('.run-history-detail')
  await detail.waitFor({ state: 'visible' })
  for (const toggle of await detail.locator('button[aria-expanded="false"]').all()) await toggle.click()
  return detail.innerText()
}
/** 每次运行一条：写稿先发短细纲再发正文，同一运行有两次尝试，记正文那次（purpose chapter-draft）。 */
function durableRuns(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare(`SELECT r.run_id, r.binding_json, a.attempt_json, a.usage_receipt_json
      FROM generation_runs r LEFT JOIN generation_attempts a ON a.run_id=r.run_id ORDER BY r.created_at_ms, a.rowid`).all()
    const runs = new Map()
    for (const row of rows) {
      const receipt = row.usage_receipt_json && JSON.parse(row.usage_receipt_json)
      const entry = runs.get(row.run_id) ?? { runId: row.run_id, operation: JSON.parse(row.binding_json).sourceManifest?.operation, purposes: [] }
      if (receipt) entry.purposes.push(receipt.purpose)
      if (receipt?.purpose === 'chapter-draft') Object.assign(entry, { attemptStatus: JSON.parse(row.attempt_json).status,
        usageTrusted: receipt.result?.usage?.trusted === true, finishReason: receipt.result?.finishReason })
      runs.set(row.run_id, entry)
    }
    return [...runs.values()]
  } finally { db.close() }
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
    retainedReason: 'independent review of packaged stage run history and durable SQLite run identities',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  // 写稿先要一份短细纲（只写短细纲）再写正文。细纲照常回复并另计；requests 只数正文请求，第 2 次回 500 作可控失败。
  const fixtureState = { requests: 0, outlines: 0 }
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${model.apiKey}` || request.url !== '/v1/chat/completions') { response.writeHead(403).end(); return }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const prompt = (JSON.parse(raw).messages ?? []).map(message => String(message.content)).join('\n')
    const outline = prompt.includes('只写短细纲')
    if (outline) fixtureState.outlines++
    else fixtureState.requests++
    if (!outline && fixtureState.requests === 2) { response.writeHead(500).end('fixture failure'); return }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: outline ? '- 原目标：验证历史。' : syntheticProse }, finish_reason: 'stop' }] })}\n\n`)
    response.write('data: {"choices":[],"usage":{"prompt_tokens":400,"completion_tokens":200,"total_tokens":600}}\n\n')
    response.end('data: [DONE]\n\n')
  })
  let app
  let project
  let failure
  let currentStep = 'setup'
  let lastPage
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    ;({ app } = await launch(port))
    const page = await app.firstWindow()
    project = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, profile.projects)).grantId, name: projectName, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
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
    // 纸墨外壳的写作此章按设定里的每章字数写；夹具一次回 120 字，目标定在 100。
    const core = await invoke(page, 'db:project-core-update', { totalChapters: 1, wordsPerChapter: 100 }, project.projectPath, context)
    assert.equal(core.success, true, core.error)
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '历史印章章节', role: '发展', purpose: '验证历史', keyEvents: '验证状态', characters: [] }, project.projectPath, context)).success, true)
    await quit(app); app = null
    ;({ app } = await launch(port))
    const page2 = await app.firstWindow()
    lastPage = page2
    await openFromShelf(page2, projectName)
    assert.equal(path.resolve((await invoke(page2, 'project:get-runtime-context')).activeProjectPath), path.resolve(project.projectPath))
    currentStep = 'U13.workflow-status-pending'
    if (!await stage.chapterList(page2).isVisible()) await stage.stageButton(page2, '正文').click()
    await stage.chapterButton(page2, 1).click()
    await stage.root(page2).getByRole('button', { name: '写作此章', exact: true }).click()
    const cancel = runSheet.sheet(page2).getByRole('button', { name: `取消「${RUN_TITLE}」` })
    await cancel.waitFor({ state: 'visible' })
    pass('u13-workflow-status-pending', null, 'Stage run sheet exposes the running write card with its cancel control before provider completion as sub-evidence')
    await runSheet.waitForRunDone(page2)
    assert.equal(fixtureState.requests, 1, `first generation must reach the isolated provider fixture; UI: ${(await page2.locator('body').innerText()).slice(-1600)}`)
    const db = new Database(path.join(project.projectPath, '.ai-novel', 'project.db'), { readonly: true })
    let savedDraft
    try { savedDraft = db.prepare('SELECT d.status, c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=1').get() } finally { db.close() }
    assert.equal(savedDraft?.body, syntheticProse, `first generation did not persist the completed draft; UI: ${(await page2.locator('body').innerText()).slice(-1000)}`)
    assert.equal(savedDraft?.status, 'draft', 'completed generation must remain an unfinalized draft')
    await stage.waitForProse(page2, '合成正文')
    const successfulRuns = durableRuns(project.projectPath)
    assert.equal(successfulRuns.length, 1)
    assert.equal(successfulRuns[0].operation, 'chapter-draft')
    assert.deepEqual(successfulRuns[0].purposes, ['chapter-draft-short-outline', 'chapter-draft'])
    assert.equal(successfulRuns[0].attemptStatus, 'settled')
    assert.equal(successfulRuns[0].usageTrusted, true)
    assert.equal(successfulRuns[0].finishReason, 'stop')
    pass('u13-workflow-status-success', null, 'Stage completed run status, trusted settled provider attempt, visible prose and persisted draft agree as sub-evidence',
      { status: savedDraft.status, attemptStatus: successfulRuns[0].attemptStatus, providerRequests: fixtureState.requests })
    currentStep = 'U13.workflow-status-failure'
    // 第 1 章已有草稿时单章视图不再摆「写作此章」；没有定稿前权威的下一章仍是第 1 章，从蓝图页再写一稿。
    await blueprint.open(page2)
    await blueprint.writeNext(page2)
    await runSheet.waitUntilOpen(page2)
    await runSheet.anyCard(page2).filter({ hasText: /^上一次运行/ }).getByText(/ · 失败$/).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(fixtureState.requests, 2, 'controlled failure must reach the fixture exactly once')
    const failureDb = new Database(path.join(project.projectPath, '.ai-novel', 'project.db'), { readonly: true })
    let draftCount
    try { draftCount = failureDb.prepare('SELECT count(*) AS count FROM drafts WHERE chapter_number=1').get().count } finally { failureDb.close() }
    assert.equal(draftCount, 1, 'failed provider request must not add another saved draft')
    pass('u13-workflow-status-failure', null, 'Stage run sheet exposes controlled provider failure without adding a draft as sub-evidence', { providerRequests: fixtureState.requests, draftCount })
    currentStep = 'U13.A08-select-history'
    const rows = await historyRows(page2)
    assert.deepEqual(rows, [{ title: RUN_TITLE, completed: false }, { title: RUN_TITLE, completed: true }],
      'stage must expose both the failed and the completed run in selectable history, newest first')
    const completedDetail = await historyDetail(page2, 1)
    assert(completedDetail.includes(savedDraft.body), 'selected completed history output differs from the persisted draft')
    await page2.getByRole('list', { name: '运行历史' }).getByRole('listitem').nth(1).locator('.run-history-row').click()
    const failedDetail = await historyDetail(page2, 0)
    assert.equal(failedDetail.includes(savedDraft.body), false, 'failed history selection still shows completed-run body')
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
    pass('u13-v3-select-history', 'U13.A08', 'Stage run history selected the exact persisted success body then the failed run; main IPC and SQLite retain two distinct chapter-draft run identities',
      { runIds: runs.map(run => run.runId), selectedStatuses: ['completed', 'failed'], selectedSuccessBodySha256: createHash('sha256').update(savedDraft.body).digest('hex') })
    await quit(app); app = null
    currentStep = 'U13.A08-reopen-boundary'
    ;({ app } = await launch(port))
    const reopenedPage = await app.firstWindow()
    lastPage = reopenedPage
    await openFromShelf(reopenedPage, projectName)
    await runSheet.openFromPalette(reopenedPage)
    await runSheet.tab(reopenedPage, '进行中').click()
    await runSheet.recovery(reopenedPage).getByText('合成正文', { exact: false }).first().waitFor({ state: 'visible' })
    const reopenedRows = await historyRows(reopenedPage)
    assert.deepEqual(reopenedRows, [], 'renderer run history is expected to be empty after a new process')
    assert.deepEqual(durableRuns(project.projectPath), runs, 'new process changed durable generation run identities')
    pass('u13-reopen-limitation', null, 'New process exposes durable candidates in the run sheet while the in-memory run history is empty; no history persistence is claimed',
      { durableRunIds: runs.map(run => run.runId), rendererHistoryCount: reopenedRows.length })
  } catch (error) {
    failure = error
    fs.mkdirSync(path.join(repository, '.runtime', '.cache', 'f05-u13-history-seals', runId), { recursive: true })
    await lastPage?.screenshot({ path: path.join(repository, '.runtime', '.cache', 'f05-u13-history-seals', runId, 'failure.png') }).catch(() => {})
  }
  finally { if (app) await quit(app); if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
  const receipt = { schemaVersion: 1, qualification: 'F05_U13_PACKAGED_V3_HISTORY_WORKFLOW_STATUS_SUBEVIDENCE', outcome: failure ? 'FAIL' : 'PARTIAL', evidenceLevel: 'electron', shell: 'stage', scope: { kind: 'controlled-workflow-status-sub-evidence', workflowStatusSteps: ['u13-workflow-status-pending', 'u13-workflow-status-success', 'u13-workflow-status-failure'], verified: ['U13.A08 same-process stage run history selection', 'durable provider attempt and body assertions', 'new-process run history limitation'], excludes: ['U13.A09 chapter view post-processing finalization pending/success/failure seal'] }, testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths, artifact: { executablePath, executableSha256: sha256(executablePath), asarPath, asarSha256: sha256(asarPath) }, driver: { path: driverPath, sha256: sha256(driverPath) }, profile: { projectRoot: profile.projects, scratch }, fixture: { provider: 'loopback synthetic OpenAI SSE', requests: fixtureState.requests, shortOutlines: fixtureState.outlines, externalModelRequests: 0 }, steps,
    unverifiedActions: ['U13.A01 real model streaming', 'U13.A02 provider reasoning qualification', 'U13.A03-U13.A07', 'U13.A09 real chapter view post-processing finalization pending/success/failure seal', 'release default and model quality'],
    limitation: 'Renderer run history is in-memory and empty in a new process; durable main-generation candidates remain visible without reconstructing that list',
    failedStep: failure ? currentStep : null, error: failure ? String(failure) : null }
  const receiptPath = path.join(repository, '.runtime', '.cache', 'f05-u13-history-seals', runId, 'receipt.json'); fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2)); process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, receipt: receiptPath, steps: steps.map(step => step.stepId), testedSha })}\n`); if (failure) throw failure
}

main().catch(error => { console.error(error); process.exitCode = 1 })
