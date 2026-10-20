/* global process */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import * as blueprint from './redesign/pages/blueprint.mjs'
import * as runSheet from './redesign/pages/run-sheet.mjs'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = argument('package-dir')
const expectedAsar = argument('asar-sha256')
const expectedExe = argument('exe-sha256')
assert(packageDir && /^[a-f0-9]{64}$/.test(expectedAsar ?? '') && /^[a-f0-9]{64}$/.test(expectedExe ?? ''),
  'pass --package-dir=<win-unpacked> --asar-sha256=<hash> --exe-sha256=<hash>')
const executablePath = resolveWindowsExecutable(packageDir)
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
let secondRequestResolve
const secondRequest = new Promise(resolve => { secondRequestResolve = resolve })
// 写稿先要一份短细纲（只写短细纲），再写正文。细纲另计，requests 只数正文请求：第 1 次 A 写完，第 2 次 B 挂住等取消，第 3 次 A 可控失败。
const fixture = { requests: 0, outlines: 0 }
const shortOutline = '- 原目标：发现线索。\n- 结尾状态：线索指向旧车站。'
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
    || request.headers.authorization !== `Bearer ${model.apiKey}`) { response.writeHead(403).end(); return }
  let raw = ''
  for await (const chunk of request) raw += chunk
  let prompt
  try {
    prompt = (JSON.parse(raw).messages ?? []).map(message => String(message.content)).join('\n')
  } catch {
    // 处理函数是 async 的：这里抛出会成为未处理的拒绝，直接结束旅程进程，回执与失败截图都来不及写。
    response.writeHead(400).end()
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (prompt.includes('只写短细纲')) {
    fixture.outlines++
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: shortOutline }, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  fixture.requests++
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

// 纸墨外壳：写作此章从流程脊的章节进单章视图点「写作此章」；运行、历史与可恢复的内容都在运行侧页。
// 旧外壳的 AI 输出历史按章节标题找按钮，而运行标题是「第 1 章 · 写稿」，那个查找总是落空（#381 R11）；
// 这里按运行侧页「历史」分页的行与它展开后的输出判定，项目隔离按行数与正文判定，查不到就失败。
const RUN_TITLE = '第 1 章 · 写稿'

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
  await stage.waitForStage(page)
  assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
  return { app, page }
}

async function openFromShelf(page, name) {
  await stage.dismissMigrationNotice(page)
  await stage.showLibrary(page)
  await stage.openFromLibrary(page, name)
  await stage.waitForWork(page, name)
}

/** 从流程脊打开这一章（待写），点单章视图的「写作此章」：按蓝图与设定里的每章字数直接开始，运行侧页随之展开。 */
async function startChapter(page, number) {
  if (!await stage.chapterList(page).isVisible()) await stage.stageButton(page, '正文').click()
  await stage.chapterButton(page, number).click()
  await stage.root(page).getByRole('button', { name: '写作此章', exact: true }).click()
  await runSheet.waitUntilOpen(page)
}

async function showRunSheetTab(page, name) {
  await runSheet.openFromPalette(page)
  await runSheet.tab(page, name).click()
}

/** 运行侧页「历史」分页里的行：标题、是否完成。没有记录时是空状态。 */
async function historyRows(page) {
  await showRunSheetTab(page, '历史')
  const list = page.getByRole('list', { name: '运行历史' })
  if (await list.count() === 0) return []
  return list.getByRole('listitem').evaluateAll(items => items.map(item => ({
    title: item.querySelector('.run-history-title')?.textContent ?? '',
    completed: item.querySelector('.run-visually-hidden')?.textContent?.startsWith('已完成') ?? false,
  })))
}

/** 展开历史里第 index 行，再展开其中每一步，返回展开后的文字。 */
async function historyDetail(page, index) {
  const item = page.getByRole('list', { name: '运行历史' }).getByRole('listitem').nth(index)
  await item.locator('.run-history-row').click()
  const detail = item.locator('.run-history-detail')
  await detail.waitFor({ state: 'visible' })
  for (const toggle of await detail.locator('button[aria-expanded="false"]').all()) await toggle.click()
  return detail.innerText()
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
      const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, profile.projects)).grantId, name: names[key],
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
      // 纸墨外壳的写作此章不再填字数，按设定里的每章字数写；夹具一次回 120 字，目标定在 100。
      const core = await invoke(page, 'db:project-core-update', { totalChapters: 1, wordsPerChapter: 100 }, created.projectPath, session)
      assert.equal(core.success, true, core.error)
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
    await startChapter(page, 1)
    await runSheet.waitForRunDone(page)
    assert.equal(fixture.requests, 1, 'A must make exactly one isolated provider request')
    const persistedA = savedDraft(projects.A)
    assert.equal(persistedA.length, 1)
    assert.deepEqual({ version: persistedA[0].version, status: persistedA[0].status, body: persistedA[0].body },
      { version: 1, status: 'draft', body: bodies.A })
    const rowsA = await historyRows(page)
    assert.deepEqual(rowsA, [{ title: RUN_TITLE, completed: true }], 'A history must list its one completed write run')
    const detailA = await historyDetail(page, 0)
    assert(detailA.includes('甲项目合成正文。'), 'A history detail must show the generated prose')
    const historyButtons = await page.getByRole('list', { name: '运行历史' }).getByRole('button').evaluateAll(buttons => buttons.map(button => ({
      label: button.textContent?.trim(), clientWidth: button.clientWidth, scrollWidth: button.scrollWidth,
      clientHeight: button.clientHeight, scrollHeight: button.scrollHeight,
    })))
    for (const button of historyButtons) {
      assert(button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight,
        `history button overflows: ${button.label} ${JSON.stringify(button)}`)
    }
    pass('A-history', { project: names.A, draftStatus: persistedA[0].status, providerRequests: fixture.requests,
      historyRows: rowsA, historyButtons: historyButtons.length })
    await page.screenshot({ path: path.join(receiptDir, 'a-history.png') })

    currentStep = 'A-to-B-isolation'
    await stage.backToLibrary(page, names.A)
    await stage.openFromLibrary(page, names.B)
    await stage.waitForWork(page, names.B)
    assert.deepEqual(await historyRows(page), [], 'A run history leaked into B project')
    assert.equal((await runSheet.sheet(page).innerText()).includes('甲项目合成正文。'), false, 'A body leaked into B project')
    await startChapter(page, 1)
    const cancel = runSheet.sheet(page).getByRole('button', { name: `取消「${RUN_TITLE}」` })
    await cancel.waitFor({ state: 'visible' })
    await Promise.race([secondRequest, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('B provider request missing')), 30_000); timer.unref() })])
    assert.equal(fixture.requests, 2, 'B must reach the isolated provider fixture')
    assert.deepEqual(await runSheet.activeTitles(page), [RUN_TITLE], 'B active runs must only be its own write run')
    assert.equal((await runSheet.sheet(page).innerText()).includes('甲项目合成正文。'), false,
      'A body leaked while B generation was running')
    await cancel.click()
    await cancel.waitFor({ state: 'hidden', timeout: 30_000 })
    assert.deepEqual(savedDraft(projects.B), [], 'cancelled B must not save a draft')
    // 取消按钮在运行转为「取消中」时就隐藏，运行要等执行器退出才进历史；先等历史里出现这一条再读，免得读到空表
    await showRunSheetTab(page, '历史')
    await page.getByRole('list', { name: '运行历史' }).getByRole('listitem')
      .filter({ has: page.locator('.run-history-title', { hasText: RUN_TITLE }) }).first().waitFor({ state: 'visible', timeout: 30_000 })
    const rowsB = await historyRows(page)
    assert.deepEqual(rowsB, [{ title: RUN_TITLE, completed: false }], 'B history must hold only its own stopped run')
    assert.equal((await runSheet.sheet(page).innerText()).includes('甲项目合成正文。'), false, 'A body leaked into B after stop')
    pass('A-to-B-isolation', { project: names.B, otherProjectHistoryVisible: false, stopClicked: true,
      historyRows: rowsB, providerRequests: fixture.requests })
    await page.screenshot({ path: path.join(receiptDir, 'b-after-stop.png') })
    await app.close(); app = null

    currentStep = 'new-process-reopen'
    ;({ app, page } = await launch(port))
    lastPage = page
    await openFromShelf(page, names.A)
    const reopenedProse = await stage.openChapter(page, 1)
    assert.equal(await stage.proseBody(reopenedProse), bodies.A)
    assert.deepEqual(savedDraft(projects.A), persistedA)
    const reopenedHistory = await historyRows(page)
    pass('new-process-reopen', { persistedDraft: true, workflowHistoryEntryCount: reopenedHistory.length })

    currentStep = 'A-provider-failure'
    // 第 1 章已有草稿时单章视图不再摆「写作此章」；没有定稿前权威的下一章仍是第 1 章，蓝图页的「写第 1 章」再写一稿。
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await runSheet.waitUntilOpen(page)
    await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).getByText(/ · 失败$/).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(fixture.requests, 3, 'controlled failure must reach the provider fixture once')
    const failed = failedGeneration(projects.A)
    assert(failed, 'failed run must have a durable main-process artifact')
    assert.equal(JSON.parse(failed.artifactJson).text, failedBody, 'durable artifact must contain exactly the visible SSE body')
    assert.equal(failed.artifactStatus, 'partial', 'failed artifact must remain partial')
    assert.equal(JSON.parse(failed.attemptJson).status, 'unknown', 'failed provider attempt must retain unknown accounting')
    assert.deepEqual(savedDraft(projects.A), persistedA, 'failed generation must not add or replace any draft')
    await runSheet.tab(page, '进行中').click()
    await runSheet.recovery(page).getByText(failedBody, { exact: false }).first().waitFor({ state: 'visible' })
    pass('A-provider-failure', { providerRequests: fixture.requests, runStatus: failed.runStatus,
      artifactStatus: failed.artifactStatus, draftUnchanged: true, visibleTextHash: createHash('sha256').update(failedBody).digest('hex') })
    await page.screenshot({ path: path.join(receiptDir, 'a-failed-candidate.png') })
    await app.close(); app = null

    currentStep = 'failed-candidate-new-process'
    ;({ app, page } = await launch(port))
    lastPage = page
    await openFromShelf(page, names.A)
    await runSheet.openFromPalette(page)
    await runSheet.tab(page, '进行中').click()
    const candidate = runSheet.recovery(page).getByRole('article').filter({ hasText: failedBody })
    await candidate.first().waitFor({ state: 'visible' })
    // 候选里同一次运行的短细纲与正文各是一段摘录，各有自己的「复制」；复制的是带失败正文的那一段。
    const copy = candidate.first().locator('figure').filter({ hasText: failedBody }).getByRole('button', { name: '复制', exact: true })
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
      evidenceLevel: 'electron', shell: 'stage', checkoutHeadAtRun: git('rev-parse', 'HEAD'),
      artifact: { executablePath, executableSha256: sha256(executablePath), asarPath, asarSha256: sha256(asarPath) },
      driver: { path: fileURLToPath(import.meta.url), sha256: sha256(fileURLToPath(import.meta.url)) },
      profile: { scratch, projectPaths: projects }, fixture: { provider: 'loopback synthetic OpenAI SSE', requests: fixture.requests, shortOutlines: fixture.outlines,
        mainProcessFetchPolicy: 'api.openai.com requests rewritten to loopback; other origins rejected' },
      steps, unverified: ['real model quality', 'durable renderer workflow history across restart'], failure }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${path.join(receiptDir, 'receipt.json')}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

await main()
