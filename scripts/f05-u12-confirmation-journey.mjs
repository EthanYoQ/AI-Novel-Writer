/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
if (process.argv.includes('--help')) {
  process.stdout.write('F05 U12.A01-A04 V3 packaged review journey: --package-dir --package-source-sha --exe-sha256 --asar-sha256\n')
  process.exit(0)
}
const packageDir = option('package-dir') && path.resolve(option('package-dir'))
const testedSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
assert(packageDir && /^[a-f0-9]{40}$/.test(testedSha ?? '') && /^[a-f0-9]{64}$/.test(expectedExe ?? '')
  && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const driverPath = fileURLToPath(import.meta.url)
const Database = createRequire(import.meta.url)('better-sqlite3')
const runId = randomUUID()
const scratch = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'an', `u12-${runId.slice(0, 12)}`)
  : path.join(repository, '.runtime', '.cache', 'f05-u12', runId)
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const receiptPath = path.join(repository, '.runtime', '.cache', 'f05-u12-confirmation', runId, 'receipt.json')
const projectName = 'u12'
const liveProjectName = 'u12-live'
const body = '林岚离开港口，带走了日志。第二天，她回到灯塔。'
const revisedBody = '林岚离开港口，把日志仔细收进背包。第二天，她回到灯塔，先核对日志上的时间，再向守塔人询问昨夜的潮汐。'
const liveModel = { id: 'f05-u12-synthetic', name: 'U12 合成流式模型', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'f05-u12-offline-key',
  maxTokens: 2048, temperature: 0.7, purposes: ['generation'] }
const liveReport = JSON.stringify({ summary: '核对日志和时间线。', items: [
  { category: '连续性', severity: 'warning', description: '核对离港与返抵灯塔的时间线。', quote: '第二天，她回到灯塔。' },
], goalReviews: [{ id: 'ch1:keyEvents:1', status: 'completed', description: '林岚已离开港口。',
  evidence: [{ quote: '林岚离开港口' }] }] })
const unverifiedQuote = '第二天，她回到灯塔。'
const report = JSON.stringify({ summary: '三项待作者判断。', items: [
  { category: '连续性', severity: 'error', description: '保留：核对林岚离开港口后的时间线。', quote: '第二天，她回到灯塔。' },
  { category: '节奏', severity: 'warning', description: '拒绝：删掉灯塔场景。', quote: '她回到灯塔。' },
  { category: '来源核实', severity: 'unknown', description: '缺失角色标识，需核对林岚返抵灯塔的记录。',
    quote: unverifiedQuote, sourceChapter: 1 },
] })
const steps = []
const pass = (stepId, assertion, observed, actionId = 'U12.A03') => steps.push({ stepId, actionId, outcome: 'PASS', assertion, observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
function reviewRows(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    return db.prepare(`SELECT r.id, r.base_draft_id AS baseDraftId, r.review_index AS reviewIndex,
      r.source_content AS sourceContent, c.body AS content FROM reviews r JOIN contents c ON c.id=r.content_id
      ORDER BY r.review_index`).all()
  } finally { db.close() }
}
function draftRow(projectPath, draftId) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    return db.prepare(`SELECT d.id, d.chapter_number AS chapterNumber, d.version, d.status,
      c.body AS content FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?`).get(draftId)
  } finally { db.close() }
}
function liveRows(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    return {
      reviews: reviewRows(projectPath),
      cycles: db.prepare('SELECT cycle_id AS cycleId,root_action_id AS rootActionId,review_id AS reviewId,confirmation_review_id AS confirmationReviewId,revision_id AS revisionId,revision_status AS revisionStatus FROM review_cycles').all(),
      effects: db.prepare(`SELECT a.attempt_id AS attemptId,a.root_action_id AS rootActionId,
        json_extract(a.usage_receipt_json,'$.reviewRevisionEffect.kind') AS kind,
        json_extract(a.usage_receipt_json,'$.reviewRevisionEffect.id') AS id,
        json_extract(r.binding_json,'$.projectId') AS projectId
        FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id
        WHERE json_extract(a.usage_receipt_json,'$.reviewRevisionEffect.kind') IS NOT NULL`).all(),
      revisions: db.prepare(`SELECT v.id,v.base_draft_id AS baseDraftId,v.revision_type AS revisionType,
        v.review_source_id AS reviewSourceId,v.status,c.body AS content
        FROM revisions v JOIN contents c ON c.id=v.content_id`).all(),
      draftStatuses: db.prepare('SELECT id,status FROM drafts').all(),
      outboxCount: db.prepare('SELECT COUNT(*) FROM finalization_outbox').pluck().get(),
    }
  } finally { db.close() }
}
async function waitForRows(projectPath, select, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = liveRows(projectPath)
    if (select(rows)) return rows
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('F05_U12_DURABLE_OUTCOME_TIMEOUT')
}
async function launch(fixturePort) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy,
    HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir,
    args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  if (fixturePort) await app.evaluate((_, port) => {
    const originalFetch = globalThis.fetch
    globalThis.__f05U12ExternalRequests = 0
    globalThis.fetch = (input, options) => {
      let url
      try { url = new URL(String(input)) } catch {
        globalThis.__f05U12ExternalRequests += 1
        throw new Error('F05_U12_EXTERNAL_FETCH_REFUSED')
      }
      if (url.origin !== 'https://api.openai.com'
        || !['/v1/chat/completions', '/v1/embeddings'].includes(url.pathname)
        || url.search) {
        globalThis.__f05U12ExternalRequests += 1
        throw new Error('F05_U12_EXTERNAL_FETCH_REFUSED')
      }
      return originalFetch(`http://127.0.0.1:${port}${url.pathname}`, options)
    }
  }, fixturePort)
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(15_000)
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...value, shellPreference: 'writer',
      revision: Number(value.revision ?? 0) + 1, origin: 'author' }))
  })
  await page.reload()
  await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
  return { app, page }
}
async function openReport(page, name = projectName) {
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${name}》` }).click()
  await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
  await page.getByRole('button', { name: /审稿报告\(/ }).click()
  await page.getByText('人工确认修稿清单', { exact: true }).waitFor({ state: 'visible' })
}

async function main() {
  assert.equal(git('rev-parse', testedSha), testedSha, 'tested source SHA unavailable')
  assert(fs.existsSync(executablePath) && fs.existsSync(asarPath), 'Windows package missing')
  assert.equal(sha256(executablePath), expectedExe, 'executable hash mismatch')
  assert.equal(sha256(asarPath), expectedAsar, 'asar hash mismatch')
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U12.A01-A04',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 24,
    retainedReason: 'isolated SQLite and failure evidence for independent review',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const fixture = { requests: [], externalModelRequests: 0 }
  const server = createServer(async (request, response) => {
    const authorized = request.headers.authorization === `Bearer ${liveModel.apiKey}`
    const route = request.url
    fixture.requests.push({ method: request.method, route, authorized })
    if (request.method !== 'POST' || !authorized) { response.writeHead(403).end(); return }
    if (route === '/v1/embeddings') {
      const payload = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input]
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })),
      }))
      return
    }
    if (route !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    const payload = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
    const dispatch = fixture.requests.filter(item => item.route === '/v1/chat/completions').length
    if (dispatch === 1) fixture.reviewFocusBound = payload.messages?.some(message =>
      typeof message.content === 'string' && message.content.includes(
        '★【作者要求重点检查的维度（如有，这些维度必须优先、深入检查）】★：\n剧情连贯性\n'))
    const content = dispatch === 1 ? liveReport : dispatch === 2 ? revisedBody : null
    if (!content || payload.model !== liveModel.modelName || payload.stream !== true) {
      response.writeHead(422).end(); return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  let app, page, projectPath, sourceReviewId, draftId, failure, liveProjectPath
  let currentStep = 'fixture-persist'
  try {
    ({ app, page } = await launch())
    const project = await invoke(page, 'project:create', { path: profile.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(project.success, true, project.error)
    projectPath = project.projectPath
    const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const session = { projectId: project.projectId, projectPath, leaseId: opened.project.sessionLease }
    const blueprint = await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '港口灯塔',
      role: '发展', purpose: '核对审稿决定', keyEvents: '林岚离开港口', characters: [] }, projectPath, session)
    assert.equal(blueprint.success, true, blueprint.error)
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
      content: body, wordCount: body.length }, projectPath, session)
    assert.equal(draft.success, true, draft.error)
    draftId = draft.id
    const full = await invoke(page, 'db:draft-get-full', draftId, projectPath, session)
    const sourceDraft = { id: full.id, chapterNumber: full.chapterNumber, version: full.version,
      status: full.status, content: full.content }
    const saved = await invoke(page, 'db:review-create', { baseDraftId: draftId, content: report,
      expectedSource: sourceDraft }, projectPath, session)
    assert.equal(saved.success, true, saved.error)
    sourceReviewId = saved.id
    assert(Number.isSafeInteger(sourceReviewId) && sourceReviewId > 0)
    assert.deepEqual(reviewRows(projectPath).map(row => row.content), [report])
    assert.deepEqual(draftRow(projectPath, draftId), sourceDraft)
    assert(sourceDraft.content.includes(unverifiedQuote), 'review quote is not in the immutable source draft')
    pass('fixture-source', 'Production project, draft and original review repositories persist a visible source record',
      { draftId, sourceReviewId, sourceReviewSha256: createHash('sha256').update(report).digest('hex') })
    await app.close(); app = null

    currentStep = 'U12.A02-v3-evidence'
    ;({ app, page } = await launch())
    await openReport(page)
    const issueFields = page.locator('textarea[aria-label="审稿问题"]')
    assert.equal(await issueFields.count(), 3, 'V3 must show all seeded review issues')
    assert.equal(await issueFields.nth(2).inputValue(), '缺失角色标识，需核对林岚返抵灯塔的记录。')
    const unverifiedSeverity = page.getByRole('combobox', { name: '严重程度' }).nth(2)
    assert.equal(await unverifiedSeverity.inputValue(), 'unknown')
    assert.equal(await unverifiedSeverity.locator('option:checked').innerText(), '待核实')
    assert.equal(await page.getByRole('textbox', { name: '相关原文（可选）' }).nth(2).inputValue(), unverifiedQuote)
    await page.getByText('来源：第1章', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByText('已忽略，不会传给模型', { exact: true }).count(), 1,
      'the unverified item must not enter revision by default')
    assert.equal(await page.getByRole('button', { name: '明确纳入修稿', exact: true }).count(), 1)
    assert.deepEqual(reviewRows(projectPath).map(row => row.content), [report], 'viewing changed the source review')
    assert.deepEqual(draftRow(projectPath, draftId), sourceDraft, 'viewing changed the source draft')
    pass('U12.A02-v3-evidence', 'V3 shows a locatable source quote as unverified and leaves the source draft and AI report unchanged',
      { sourceReviewId, draftId, quote: unverifiedQuote, sourceChapter: 1, defaultDecision: 'ignore' }, 'U12.A02')

    currentStep = 'U12.A03-v3-confirm'
    assert.equal(await issueFields.nth(1).inputValue(), '拒绝：删掉灯塔场景。')
    assert.equal(await page.getByRole('button', { name: '忽略', exact: true }).count(), 2,
      'both fixture review items must default to included')
    await page.getByRole('button', { name: '忽略', exact: true }).nth(1).click()
    await page.getByRole('heading', { name: '节奏', exact: true }).locator('..')
      .getByText('已忽略，不会传给模型', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('heading', { name: '来源核实', exact: true }).locator('..')
      .getByText('已忽略，不会传给模型', { exact: true }).count(), 1,
      'unverified item must remain ignored after the author rejects the second item')
    assert.equal(await page.getByText('已纳入本次修稿', { exact: true }).count(), 1,
      'first item must remain included in the UI')
    await page.getByRole('button', { name: '确认审稿清单', exact: true }).click()
    await page.getByText('已确认', { exact: true }).waitFor({ state: 'visible' })
    const rows = reviewRows(projectPath)
    assert.equal(rows.length, 2, 'UI confirmation must append exactly one review row')
    assert.equal(rows[0].id, sourceReviewId)
    assert.equal(rows[0].content, report, 'original AI review was rewritten')
    assert.equal(rows[0].sourceContent, body)
    const confirmation = JSON.parse(rows[1].content)
    assert.equal(confirmation.kind, 'human-confirmed-review')
    assert.equal(confirmation.sourceReviewId, sourceReviewId)
    assert.deepEqual(confirmation.sourceDraft, sourceDraft)
    assert.deepEqual(confirmation.items.map(item => [item.description, item.decision, item.origin]), [
      ['保留：核对林岚离开港口后的时间线。', 'apply', 'ai'],
      ['拒绝：删掉灯塔场景。', 'ignore', 'ai'],
      ['缺失角色标识，需核对林岚返抵灯塔的记录。', 'ignore', 'ai'],
    ])
    assert.equal(rows[1].baseDraftId, draftId)
    assert.equal(rows[1].reviewIndex, rows[0].reviewIndex + 1)
    pass('U12.A03-v3-confirm', 'V3 UI kept one suggestion, rejected another, and appended an exact source-bound snapshot without changing the AI report',
      { sourceReviewId, confirmationReviewId: rows[1].id, decisions: confirmation.items.map(item => item.decision) })
    await app.close(); app = null

    currentStep = 'U12.A03-process-reopen'
    ;({ app, page } = await launch())
    await openReport(page)
    await page.getByRole('button', { name: '按确认意见修稿', exact: true }).waitFor({ state: 'visible' })
    assert.deepEqual(reviewRows(projectPath), rows, 'restart changed persisted reviews')
    pass('U12.A03-process-reopen', 'A new Electron process renders the confirmed review and retains both immutable rows',
      { sourceReviewId, confirmationReviewId: rows[1].id, reviewCount: rows.length })
    await app.close(); app = null

    currentStep = 'U12.A01-production-review'
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const fixturePort = server.address().port
    ;({ app, page } = await launch(fixturePort))
    const created = await invoke(page, 'project:create', { path: profile.projects, name: liveProjectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    liveProjectPath = created.projectPath
    const openedLive = await invoke(page, 'project:open', liveProjectPath, randomUUID(), null)
    assert.equal(openedLive.success, true, openedLive.error)
    const liveSession = { projectId: created.projectId, projectPath: liveProjectPath,
      leaseId: openedLive.project.sessionLease }
    assert.equal((await invoke(page, 'llm:save-model', liveModel)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-model', liveModel.id)).success, true)
    const liveBlueprint = await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '港口灯塔',
      role: '发展', purpose: '核对审稿决定', keyEvents: '林岚离开港口', characters: [] }, liveProjectPath, liveSession)
    assert.equal(liveBlueprint.success, true, liveBlueprint.error)
    const liveDraft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
      content: body, wordCount: body.length }, liveProjectPath, liveSession)
    assert.equal(liveDraft.success, true, liveDraft.error)
    const liveSourceDraft = draftRow(liveProjectPath, liveDraft.id)
    assert.equal(liveSourceDraft.content, body)
    fixture.externalModelRequests += await app.evaluate(() => globalThis.__f05U12ExternalRequests ?? 0)
    await app.close(); app = null
    ;({ app, page } = await launch(fixturePort))
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${liveProjectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    await page.getByRole('button', { name: 'AI 审稿', exact: true }).click()
    await page.getByRole('heading', { name: 'AI 审稿确认' }).waitFor({ state: 'visible' })
    const dimensionLabels = ['剧情连贯性', '剧情合理性', '角色状态', '前后章节串联']
    const dimension = label => page.getByRole('dialog').locator('label').filter({ hasText: label })
    for (const label of dimensionLabels) await dimension(label).click()
    await dimension('剧情连贯性').click()
    for (const label of dimensionLabels) assert.equal(await dimension(label).locator('svg').count(),
      label === '剧情连贯性' ? 1 : 0, `incorrect selected review dimension: ${label}`)
    await page.getByRole('button', { name: '确认执行', exact: true }).click()
    const reviewed = await waitForRows(liveProjectPath, state => state.reviews.length === 1 && state.cycles.length === 1)
    assert.equal(fixture.reviewFocusBound, true, 'selected dimension was not bound into the production review request')
    const liveReview = reviewed.reviews[0]
    const parsedReview = JSON.parse(liveReview.content)
    assert.equal(parsedReview.items[0].quote, '第二天，她回到灯塔。')
    assert.equal(parsedReview.goalReview.coverage, 'complete')
    assert.deepEqual(parsedReview.goalReview.items.map(item => [item.id, item.status, item.evidence[0]?.quote]),
      [['ch1:keyEvents:1', 'completed', '林岚离开港口']])
    assert.equal(reviewed.effects.filter(effect => effect.kind === 'review' && effect.id === liveReview.id
      && effect.projectId === created.projectId && effect.rootActionId === reviewed.cycles[0].rootActionId).length, 1)
    assert.equal(reviewed.cycles[0].reviewId, liveReview.id)
    assert.equal(reviewed.cycles[0].revisionStatus, 'not-generated')
    assert.deepEqual(draftRow(liveProjectPath, liveDraft.id), liveSourceDraft)
    pass('U12.A01-production-review', 'V3 selected review dimensions and checked the frozen chapter goal through the production owner and cycle',
      { projectId: created.projectId, reviewId: liveReview.id, cycleId: reviewed.cycles[0].cycleId,
        goalIds: parsedReview.goalReview.items.map(item => item.id), providerRequests: fixture.requests.length }, 'U12.A01')

    currentStep = 'U12.A04-confirmed-revision'
    assert.equal(await page.getByText('人工确认修稿清单', { exact: true }).isVisible(), true,
      'production review did not open its confirmation report')
    await page.getByRole('button', { name: '确认审稿清单', exact: true }).click()
    const confirmedRows = await waitForRows(liveProjectPath, state => state.reviews.length === 2)
    const confirmedReview = confirmedRows.reviews[1]
    const confirmed = JSON.parse(confirmedReview.content)
    assert.equal(confirmed.sourceReviewId, liveReview.id)
    assert(confirmed.items.some(item => item.decision === 'apply'))
    assert.equal(confirmedRows.reviews[0].content, liveReview.content)
    await page.getByRole('button', { name: '按确认意见修稿', exact: true }).click()
    await page.getByLabel('本次修稿模型').selectOption(liveModel.id)
    await page.getByRole('button', { name: '开始修稿', exact: true }).click()
    const revised = await waitForRows(liveProjectPath, state => state.revisions.length === 1
      && state.cycles[0]?.revisionStatus === 'generated')
    const revision = revised.revisions[0]
    assert.equal(revision.baseDraftId, liveDraft.id)
    assert.equal(revision.reviewSourceId, confirmedReview.id)
    assert.equal(revision.revisionType, 'review-fix')
    assert.equal(revision.status, 'pending')
    assert.equal(revision.content, revisedBody)
    assert.notEqual(revision.content, body)
    assert.equal(revised.cycles[0].revisionId, revision.id)
    assert.equal(revised.cycles[0].confirmationReviewId, confirmedReview.id)
    assert.equal(revised.effects.filter(effect => effect.kind === 'revision' && effect.id === revision.id
      && effect.projectId === created.projectId).length, 1)
    assert.deepEqual(draftRow(liveProjectPath, liveDraft.id), liveSourceDraft)
    assert.equal(revised.reviews[0].content, liveReview.content)
    assert.equal(revised.outboxCount, 0)
    assert.deepEqual(revised.draftStatuses, [{ id: liveDraft.id, status: 'draft' }])
    fixture.externalModelRequests += await app.evaluate(() => globalThis.__f05U12ExternalRequests ?? 0)
    assert.equal(fixture.externalModelRequests, 0)
    assert(fixture.requests.every(item => item.method === 'POST' && item.authorized
      && ['/v1/chat/completions', '/v1/embeddings'].includes(item.route)))
    assert.deepEqual(fixture.requests.filter(item => item.route === '/v1/chat/completions')
      .map(item => [item.method, item.authorized]), [['POST', true], ['POST', true]])
    pass('U12.A04-confirmed-revision', 'V3 author confirmation drove a controlled provider revision into a pending formal review-fix candidate',
      { reviewId: liveReview.id, confirmationReviewId: confirmedReview.id, revisionId: revision.id,
        cycleId: revised.cycles[0].cycleId, providerRequests: fixture.requests.length,
        externalModelRequests: fixture.externalModelRequests }, 'U12.A04')
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message,
      ui: (await page?.locator('body').innerText().catch(() => ''))?.slice(-2500) }
    steps.push({ stepId: currentStep, actionId: currentStep === 'fixture-persist' ? null
      : currentStep.startsWith('U12.A02') ? 'U12.A02'
        : currentStep.startsWith('U12.A01') ? 'U12.A01'
          : currentStep.startsWith('U12.A04') ? 'U12.A04' : 'U12.A03',
      outcome: 'RED', assertion: 'first failing boundary', observed: failure })
  } finally {
    if (app && failure) fixture.externalModelRequests += await app.evaluate(() => globalThis.__f05U12ExternalRequests ?? 0).catch(() => 0)
    await app?.close().catch(() => {})
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
    const receipt = { schemaVersion: 1, qualification: 'F05_U12_A01_A04_PACKAGED_V3_REVIEW_REVISION',
      overall: failure ? 'FAIL' : 'PARTIAL', evidenceLevel: 'electron', shell: 'writer-v3',
      scope: ['U12.A01', 'U12.A02', 'U12.A03', 'U12.A04'], testedSha, executionHead: git('rev-parse', 'HEAD'),
      artifact: { executablePath, executableSha256: sha256(executablePath), asarPath, asarSha256: sha256(asarPath) },
      driver: { path: driverPath, sha256: sha256(driverPath) }, profile: { scratch, projectPath, liveProjectPath },
      provider: { kind: 'loopback-synthetic-openai-sse', localRequests: fixture.requests,
        externalModelRequests: fixture.externalModelRequests },
      steps, unverifiedActions: ['U12.A01', 'U12.A02', 'U12.A03', 'U12.A04', 'U12.A05', 'U12.A06', 'U12.A07', 'U12.A08']
        .filter(actionId => !steps.some(step => step.actionId === actionId && step.outcome === 'PASS')),
      failure }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ overall: receipt.overall, receipt: receiptPath,
      failedStep: failure?.step ?? null, steps: steps.map(step => step.stepId) })}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
