/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = argument('package-dir')
const expectedAsar = argument('asar-sha256')
const expectedExe = argument('exe-sha256')
assert(packageDir && /^[a-f0-9]{64}$/.test(expectedAsar ?? '') && /^[a-f0-9]{64}$/.test(expectedExe ?? ''),
  'pass --package-dir=<win-unpacked> --asar-sha256=<hash> --exe-sha256=<hash>')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
assert.equal(sha256(executablePath), expectedExe, 'executable changed since build attribution')
assert.equal(sha256(asarPath), expectedAsar, 'bundle changed since build attribution')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const Database = createRequire(import.meta.url)('better-sqlite3')

const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', `h-${runId.slice(0, 8)}`)
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const receiptDir = path.join(repository, '.runtime', '.cache', 'f04-v3-history-recovery', runId)
const names = { A: `V3历史A-${runId.slice(0, 4)}`, B: `V3历史B-${runId.slice(0, 4)}` }
const bodies = { A: '甲项目合成正文。'.repeat(15), B: '乙项目合成正文。'.repeat(15) }
const failedBody = '甲项目失败流的可见正文。'.repeat(8)
const model = { id: 'v3-history-fixture', name: 'V3 history fixture', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'v3-history-offline',
  maxTokens: 8192, temperature: 0.7, purposes: ['generation'] }
const steps = []
const pass = (name, observed) => steps.push({ name, outcome: 'PASS', observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const assistant = page => page.locator('[aria-label="写作助手"]')
let secondRequestResolve
const secondRequest = new Promise(resolve => { secondRequestResolve = resolve })
const fixture = { requests: 0 }
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
    || request.headers.authorization !== `Bearer ${model.apiKey}`) { response.writeHead(403).end(); return }
  fixture.requests++
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (fixture.requests === 1) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: bodies.A }, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  } else if (fixture.requests === 2) {
    response.flushHeaders()
    secondRequestResolve()
  } else if (fixture.requests === 3) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: failedBody } }] })}\n\n`)
    response.end() // A valid visible SSE chunk without [DONE] is a controlled provider failure.
  } else {
    response.end('unexpected fixture request')
  }
})

async function launch(port) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
    AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
    APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  await app.evaluate((_, fixturePort) => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://api.openai.com') throw new Error('V3_NETWORK_REFUSED')
      return originalFetch(`http://127.0.0.1:${fixturePort}${url.pathname}`, options)
    }
  }, port)
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(15_000)
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...value, shellPreference: 'writer', revision: Number(value.revision ?? 0) + 1, origin: 'author' }))
  })
  await page.reload()
  await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
  return { app, page }
}

async function dismissNotice(page) {
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
}
async function openFromShelf(page, name) {
  await dismissNotice(page)
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${name}》` }).click()
  await page.locator('.writer-project-tree').getByText(name, { exact: true }).waitFor({ state: 'visible' })
}
async function startChapter(page) {
  await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
  await page.getByRole('button', { name: '写作此章' }).click()
  await page.getByRole('dialog').getByPlaceholder('3000').fill('100')
  await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
}
function savedDraft(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true })
  try { return db.prepare('SELECT d.id, d.version, d.status, c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=1 ORDER BY d.id').all() }
  finally { db.close() }
}
function failedGeneration(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true })
  try {
    return db.prepare(`SELECT r.status AS runStatus, a.status AS artifactStatus, a.artifact_json AS artifactJson,
      t.attempt_json AS attemptJson FROM generation_artifacts a
      JOIN generation_attempts t ON t.attempt_id=a.attempt_id
      JOIN generation_runs r ON r.run_id=a.run_id ORDER BY a.rowid DESC LIMIT 1`).get()
  } finally { db.close() }
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F04 V3 history journey',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48,
    retainedReason: 'isolated Electron/SQLite evidence review',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app
  let lastPage
  let failure = null
  let currentStep = 'launch'
  const projects = {}
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    ;({ app } = await launch(port))
    let page = await app.firstWindow()
    lastPage = page
    currentStep = 'fixture-projects'
    for (const key of ['A', 'B']) {
      const created = await invoke(page, 'project:create', { path: profile.projects, name: names[key],
        genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
      assert.equal(created.success, true, created.error)
      projects[key] = created.projectPath
      const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
      const roster = await invoke(page, 'db:character-roster-read', created.projectPath, session)
      const rosterCommit = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(),
        expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision,
        schemaVersion: 1, intent: 'manual_edit', entries: [{ characterId: `draft:${randomUUID()}`,
          name: '林岚', role: 'protagonist', gender: '', age: '', appearance: '', personality: '',
          background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }] }, created.projectPath, session)
      assert.equal(rosterCommit.success, true, rosterCommit.error)
      assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: `${names[key]}章节`,
        role: '发展', purpose: '验证历史隔离', keyEvents: '发现线索', characters: [] }, created.projectPath, session)).success, true)
    }
    assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
    await app.close(); app = null

    currentStep = 'A-history'
    ;({ app, page } = await launch(port))
    lastPage = page
    await openFromShelf(page, names.A)
    await startChapter(page)
    await assistant(page).getByRole('button', { name: /中止生成|Stop generation/ }).waitFor({ state: 'visible' })
    await assistant(page).getByRole('button', { name: /中止生成|Stop generation/ }).waitFor({ state: 'hidden', timeout: 30_000 })
    assert.equal(fixture.requests, 1, 'A must make exactly one isolated provider request')
    await assistant(page).getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible' })
    const persistedA = savedDraft(projects.A)
    assert.equal(persistedA.length, 1)
    assert.deepEqual({ version: persistedA[0].version, status: persistedA[0].status, body: persistedA[0].body },
      { version: 1, status: 'draft', body: bodies.A })
    const historyA = assistant(page).getByRole('button', { name: new RegExp(names.A + '章节') }).first()
    await historyA.waitFor({ state: 'visible' })
    await historyA.click()
    await assistant(page).getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible' })
    await assistant(page).getByText('甲项目合成正文。', { exact: false }).first().waitFor({ state: 'visible' })
    const candidateButtons = await assistant(page).locator('section[aria-label="持久正文候选"] button').evaluateAll(buttons => buttons.map(button => ({
      label: button.textContent?.trim(), clientWidth: button.clientWidth, scrollWidth: button.scrollWidth,
      clientHeight: button.clientHeight, scrollHeight: button.scrollHeight,
    })))
    assert(candidateButtons.length >= 2, 'saved candidate copy and continue buttons missing')
    for (const button of candidateButtons) {
      assert(button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight,
        `saved candidate button overflows: ${button.label} ${JSON.stringify(button)}`)
    }
    pass('A-history', { project: names.A, draftStatus: persistedA[0].status, providerRequests: fixture.requests,
      candidateButtons })
    await page.screenshot({ path: path.join(receiptDir, 'a-history.png') })

    currentStep = 'A-to-B-isolation'
    await page.locator('.writer-left-rail button[title="欢迎页"]').click()
    await openFromShelf(page, names.B)
    await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
    assert.equal(await assistant(page).getByRole('button', { name: new RegExp(names.A + '章节') }).count(), 0,
      'A history title leaked into B project')
    assert.equal((await assistant(page).innerText()).includes('甲项目合成正文。'), false, 'A body leaked into B project')
    await startChapter(page)
    const stop = assistant(page).getByRole('button', { name: /中止生成|Stop generation/ })
    await stop.waitFor({ state: 'visible' })
    await Promise.race([secondRequest, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('B provider request missing')), 30_000); timer.unref() })])
    assert.equal(fixture.requests, 2, 'B must reach the isolated provider fixture')
    assert.equal(await assistant(page).getByRole('button', { name: new RegExp(names.A + '章节') }).count(), 0)
    assert.equal((await assistant(page).innerText()).includes('甲项目合成正文。'), false,
      'A body leaked while B generation was running')
    assert.equal((await page.locator('.writer-task-table').innerText()).includes(names.A), false,
      'A task title leaked into B bottom task table while running')
    await stop.click()
    await stop.waitFor({ state: 'hidden', timeout: 30_000 })
    assert.deepEqual(savedDraft(projects.B), [], 'cancelled B must not save a draft')
    assert.equal((await page.locator('.writer-task-table').innerText()).includes(names.A), false,
      'A task title leaked into B bottom task table after stop')
    pass('A-to-B-isolation', { project: names.B, oldHistoryVisible: false, oldBottomTaskVisible: false,
      stopClicked: true, providerRequests: fixture.requests })
    await page.screenshot({ path: path.join(receiptDir, 'b-after-stop.png') })
    await app.close(); app = null

    currentStep = 'new-process-reopen'
    ;({ app, page } = await launch(port))
    lastPage = page
    await openFromShelf(page, names.A)
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).waitFor({ state: 'visible' })
    assert.deepEqual(savedDraft(projects.A), persistedA)
    await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
    const reopenedHistoryCount = await assistant(page).getByRole('button', { name: new RegExp(names.A + '章节') }).count()
    pass('new-process-reopen', { persistedDraft: true, workflowHistoryEntryCount: reopenedHistoryCount })

    currentStep = 'A-provider-failure'
    await startChapter(page)
    await assistant(page).getByText('工作流未完成', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(fixture.requests, 3, 'controlled failure must reach the provider fixture once')
    const failed = failedGeneration(projects.A)
    assert(failed, 'failed run must have a durable main-process artifact')
    assert.equal(JSON.parse(failed.artifactJson).text, failedBody, 'durable artifact must contain exactly the visible SSE body')
    assert.equal(failed.artifactStatus, 'partial', 'failed artifact must remain partial')
    assert.equal(JSON.parse(failed.attemptJson).status, 'unknown', 'failed provider attempt must retain unknown accounting')
    assert.deepEqual(savedDraft(projects.A), persistedA, 'failed generation must not add or replace any draft')
    await assistant(page).locator('section[aria-label="持久正文候选"]').getByText(failedBody, { exact: false }).waitFor({ state: 'visible' })
    pass('A-provider-failure', { providerRequests: fixture.requests, runStatus: failed.runStatus,
      artifactStatus: failed.artifactStatus, draftUnchanged: true, visibleTextHash: createHash('sha256').update(failedBody).digest('hex') })
    await page.screenshot({ path: path.join(receiptDir, 'a-failed-candidate.png') })
    await app.close(); app = null

    currentStep = 'failed-candidate-new-process'
    ;({ app, page } = await launch(port))
    lastPage = page
    await openFromShelf(page, names.A)
    await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
    const candidate = assistant(page).locator('section[aria-label="持久正文候选"]')
    await candidate.getByText(failedBody, { exact: false }).waitFor({ state: 'visible' })
    assert.equal(await assistant(page).getByRole('button', { name: new RegExp(names.A + '章节') }).count(), 0,
      'renderer workflow history should not be mistaken for durable recovery')
    const copy = candidate.locator('article').filter({ hasText: failedBody }).getByRole('button', { name: '复制', exact: true })
    const clipboardSentinel = `V3_RECOVERY_BEFORE_COPY_${runId}`
    assert.equal(await page.evaluate(async sentinel => {
      await navigator.clipboard.writeText(sentinel)
      return navigator.clipboard.readText()
    }, clipboardSentinel), clipboardSentinel, 'clipboard precondition must be verified before copy')
    await copy.click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), failedBody, 'copy must return the recovered visible prose')
    const reopened = failedGeneration(projects.A)
    assert.equal(JSON.parse(reopened.artifactJson).text, failedBody)
    assert.equal(reopened.artifactStatus, 'partial', 'reopened failed artifact must remain partial')
    assert.equal(JSON.parse(reopened.attemptJson).status, 'unknown')
    assert.deepEqual(savedDraft(projects.A), persistedA)
    pass('failed-candidate-new-process', { source: 'generation_artifacts', runStatus: reopened.runStatus,
      artifactStatus: reopened.artifactStatus, action: 'copy', draftUnchanged: true })
    await page.screenshot({ path: path.join(receiptDir, 'a-reopened-candidate.png') })
  } catch (error) {
    const ui = await lastPage?.locator('body').innerText().catch(() => '')
    const screenshot = path.join(receiptDir, 'failure.png')
    await lastPage?.screenshot({ path: screenshot }).catch(() => {})
    failure = { step: currentStep, name: error?.name, message: error?.message, ui: ui?.slice(-3000), screenshot }
  } finally {
    await app?.close().catch(() => {})
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    const receipt = { schemaVersion: 1, qualification: 'F04_V3_HISTORY_RECOVERY', outcome: failure ? 'FAIL' : 'PARTIAL',
      evidenceLevel: 'electron', shell: 'writer-v3', checkoutHeadAtRun: git('rev-parse', 'HEAD'),
      artifact: { executablePath, executableSha256: sha256(executablePath), asarPath, asarSha256: sha256(asarPath) },
      driver: { path: fileURLToPath(import.meta.url), sha256: sha256(fileURLToPath(import.meta.url)) },
      profile: { scratch, projectPaths: projects }, fixture: { provider: 'loopback synthetic OpenAI SSE', requests: fixture.requests,
        mainProcessFetchPolicy: 'api.openai.com requests rewritten to loopback; other origins rejected' },
      steps, unverified: ['real model quality', 'durable renderer workflow history across restart'], failure }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${path.join(receiptDir, 'receipt.json')}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

await main()
