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
  process.stdout.write('F05 U12.A01-A08 V3 packaged review journey: --package-dir --package-source-sha --exe-sha256 --asar-sha256 [--a06-only] [--diagnose-a06-lifecycle]\n')
  process.exit(0)
}
const packageDir = option('package-dir') && path.resolve(option('package-dir'))
const testedSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
const a06Only = process.argv.includes('--a06-only')
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
const lifecycle = process.argv.includes('--diagnose-a06-lifecycle') ? [] : null
const recordLifecycle = (event, details = {}) => {
  if (lifecycle) lifecycle.push({ sequence: lifecycle.length + 1, at: new Date().toISOString(),
    monotonicMs: Number(process.hrtime.bigint() / 1_000_000n), event, ...details })
}
const projectName = 'u12'
const liveProjectName = 'u12-live'
const candidateProjectName = 'u8'
const body = '林岚离开港口，带走了日志。第二天，她回到灯塔。'
const revisedBody = '林岚离开港口，把日志仔细收进背包。第二天，她回到灯塔，先核对日志上的时间，再向守塔人询问昨夜的潮汐。'
const recheckedBody = revisedBody.replace('第二天，她回到灯塔', '第三天，她回到灯塔')
const forbiddenReturn = '本章林岚不得返回灯塔'
const forbiddenReturnQuote = '第二天，她回到灯塔'
const recheckEvidence = '第三天，她回到灯塔'
const liveModel = { id: 'f05-u12-synthetic', name: 'U12 合成流式模型', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'f05-u12-offline-key',
  maxTokens: 2048, temperature: 0.7, purposes: ['generation'] }
const liveReport = JSON.stringify({ summary: '核对日志和时间线。', items: [
  { category: '连续性', severity: 'warning', description: '核对离港与返抵灯塔的时间线。', quote: '第二天，她回到灯塔。' },
], goalReviews: [{ id: 'ch1:keyEvents:1', status: 'completed', description: '林岚已离开港口。',
  evidence: [{ quote: '林岚离开港口' }] }] })
const objectiveReport = JSON.stringify({ summary: '本章返抵灯塔违反作者约束。', items: [
  { category: '日志', severity: 'pass', description: '日志仍由林岚保管。' }],
  goalReviews: [{ id: 'ch1:keyEvents:1', status: 'unmet', description: '林岚在本章返抵灯塔，违反不得返回的约束。',
    evidence: [{ quote: forbiddenReturnQuote }] }] })
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
      cycles: db.prepare('SELECT cycle_id AS cycleId,root_action_id AS rootActionId,review_id AS reviewId,confirmation_review_id AS confirmationReviewId,revision_id AS revisionId,revision_status AS revisionStatus,merged_hash AS mergedHash,finding_set_hash AS findingSetHash,recheck_count AS recheckCount,recheck_attempt_id AS recheckAttemptId FROM review_cycles').all(),
      effects: db.prepare(`SELECT a.attempt_id AS attemptId,a.root_action_id AS rootActionId,
        json_extract(a.usage_receipt_json,'$.reviewRevisionEffect.kind') AS kind,
        json_extract(a.usage_receipt_json,'$.reviewRevisionEffect.id') AS id,
        json_extract(r.binding_json,'$.projectId') AS projectId
        FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id
        WHERE json_extract(a.usage_receipt_json,'$.reviewRevisionEffect.kind') IS NOT NULL`).all(),
      revisions: db.prepare(`SELECT v.id,v.base_draft_id AS baseDraftId,v.revision_type AS revisionType,
        v.review_source_id AS reviewSourceId,v.status,c.body AS content
        FROM revisions v JOIN contents c ON c.id=v.content_id`).all(),
      blueprintKeyEvents: db.prepare('SELECT key_events FROM blueprints WHERE chapter_number=1').pluck().get(),
      draftStatuses: db.prepare('SELECT id,status FROM drafts').all(),
      outboxCount: db.prepare('SELECT COUNT(*) FROM finalization_outbox').pluck().get(),
      publicationStatuses: db.prepare('SELECT draft_id AS draftId,publication_status AS status FROM finalization_outbox').all(),
    }
  } finally { db.close() }
}
function formalRows(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    return {
      drafts: db.prepare('SELECT d.*, c.body AS content FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY d.id').all(),
      reviews: db.prepare('SELECT r.*, c.body AS content FROM reviews r JOIN contents c ON c.id=r.content_id ORDER BY r.id').all(),
      revisions: db.prepare('SELECT v.*, c.body AS content FROM revisions v JOIN contents c ON c.id=v.content_id ORDER BY v.id').all(),
      cycles: db.prepare('SELECT * FROM review_cycles ORDER BY cycle_id').all(),
      findings: db.prepare('SELECT * FROM review_findings ORDER BY cycle_id,finding_id').all(),
      outbox: db.prepare('SELECT * FROM finalization_outbox ORDER BY rowid').all(),
      effects: db.prepare("SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind') IS NOT NULL ORDER BY rowid").all(),
    }
  } finally { db.close() }
}
function generationRows(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    return {
      runs: db.prepare('SELECT run_id AS runId,root_action_id AS rootActionId,binding_json AS binding FROM generation_runs ORDER BY rowid').all(),
      attempts: db.prepare('SELECT attempt_id AS attemptId,run_id AS runId,root_action_id AS rootActionId,attempt_json AS attempt,usage_receipt_json AS usage FROM generation_attempts ORDER BY rowid').all(),
      artifacts: db.prepare('SELECT artifact_id AS artifactId,attempt_id AS attemptId,run_id AS runId,artifact_json AS artifact,status FROM generation_artifacts ORDER BY rowid').all(),
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
  assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5')
    .split('\n').filter(name => name && !/(^|\/)(__tests__|__screenshots__)(\/|$)|\.(test|spec)\./.test(name)).length,
  0, 'product input changed since package build')
  const dirtyProductPaths = git('status', '--porcelain', '--untracked-files=all', '--', 'src', 'electron',
    'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5')
    .split('\n').filter(line => line && !/(^|\/)(__tests__|__screenshots__)(\/|$)|\.(test|spec)\./.test(line.slice(3)))
  assert.deepEqual(dirtyProductPaths, [], 'dirty product input prevents package reuse')
  assert(fs.existsSync(executablePath) && fs.existsSync(asarPath), 'Windows package missing')
  assert.equal(sha256(executablePath), expectedExe, 'executable hash mismatch')
  assert.equal(sha256(asarPath), expectedAsar, 'asar hash mismatch')
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U12.A01-A08',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 24,
    retainedReason: 'isolated SQLite and failure evidence for independent review',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const fixture = { requests: [], externalModelRequests: 0, promptBoundaries: [], candidateReviewAccepted: false }
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
    const prompt = Array.isArray(payload.messages) ? payload.messages.map(message => typeof message?.content === 'string'
      ? message.content : JSON.stringify(message?.content ?? '')).join('\n') : ''
    const messageRoles = Array.isArray(payload.messages) ? payload.messages.map(message => message?.role ?? null) : []
    const candidateProject = prompt.includes('候选边界')
    const candidateSourceBound = prompt.includes(body) && prompt.includes('林岚离开港口')
    const confirmedRevision = prompt.includes('【已确认纳入本次修稿的审稿项】')
    const candidateReview = candidateProject && candidateSourceBound && !confirmedRevision
    const candidateRevision = fixture.candidateReviewAccepted && candidateSourceBound && confirmedRevision
      && prompt.includes('核对离港与返抵灯塔的时间线。')
    if (dispatch > 6) fixture.promptBoundaries.push({ dispatch,
      candidateProject, candidateSourceBound, confirmedRevision, candidateReview, candidateRevision,
      model: payload.model, stream: payload.stream, messageRoles })
    if (dispatch === 5) {
      const finding = fixture.recheckFinding
      const confirmedTarget = Boolean(finding && prompt.includes('【已确认纳入本次修稿的审稿项】')
        && prompt.includes(finding.problem))
      const previousBody = prompt.includes(revisedBody)
      fixture.promptBoundaries.push({ dispatch, messageRoles, confirmedTarget, previousBody })
      if (!confirmedTarget || !previousBody) { response.writeHead(422).end(); return }
    }
    if (dispatch === 6) {
      const finding = fixture.recheckFinding
      const expected = /"expected"\s*:\s*"([^"]+)"/u.exec(prompt)?.[1]
      const recheckTarget = Boolean(finding && prompt.includes(finding.findingId) && prompt.includes(finding.targetId))
      const findingSemantics = Boolean(finding && prompt.includes(finding.problem)
        && expected?.includes(finding.expected))
      const mergedBody = prompt.includes(recheckedBody)
      fixture.promptBoundaries.push({ dispatch, messageRoles, recheckTarget, findingSemantics, mergedBody })
      if (!recheckTarget || !findingSemantics || !mergedBody) { response.writeHead(422).end(); return }
    }
    if (dispatch === 1) fixture.reviewFocusBound = payload.messages?.some(message =>
      typeof message.content === 'string' && message.content.includes(
        '★【作者要求重点检查的维度（如有，这些维度必须优先、深入检查）】★：\n剧情连贯性\n'))
    const content = dispatch === 1 ? liveReport : dispatch === 2 ? revisedBody : dispatch === 3 ? body
      : dispatch === 4 ? objectiveReport : dispatch === 5 ? recheckedBody
        : dispatch === 6 && fixture.recheckFinding ? JSON.stringify({ summary: '返抵灯塔仍违反作者约束。', items: [{
          findingId: fixture.recheckFinding.findingId, targetId: fixture.recheckFinding.targetId,
          resolved: false, evidenceQuote: recheckEvidence, reason: '合并稿仍写明林岚在本章返抵灯塔。',
        }] }) : candidateRevision ? revisedBody : candidateReview ? liveReport : null
    if (dispatch === 4) fixture.objectiveBound = payload.messages?.some(message =>
      typeof message.content === 'string' && message.content.includes(forbiddenReturn))
    if (!content || payload.model !== liveModel.modelName || payload.stream !== true) {
      response.writeHead(422).end(); return
    }
    if (candidateReview) fixture.candidateReviewAccepted = true
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  let app, page, projectPath, sourceReviewId, draftId, failure, liveProjectPath, observedProcess
  const processState = () => ({ pid: observedProcess?.pid ?? null,
    exitCode: observedProcess?.exitCode ?? null, signalCode: observedProcess?.signalCode ?? null })
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

    currentStep = 'U12.A05-noop-negative-control'
    const beforeNoop = formalRows(liveProjectPath)
    const beforeGeneration = generationRows(liveProjectPath)
    await page.getByRole('dialog', { name: /^修稿合并 — 审稿修复/ })
      .getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByText('审稿报告：第1章', { exact: true }).click()
    await page.getByText('已确认', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '按确认意见修稿', exact: true }).click()
    await page.getByLabel('本次修稿模型').selectOption(liveModel.id)
    await page.getByRole('button', { name: '开始修稿', exact: true }).click()
    const failedNotice = page.locator('.writer-ai-panel').getByRole('alert')
      .filter({ hasText: 'GENERATION_REVIEW_REVISION_NOOP' })
    await failedNotice.waitFor({ state: 'visible', timeout: 60_000 })
    assert.match(await failedNotice.innerText(), /工作流未完成.*GENERATION_REVIEW_REVISION_NOOP/s)
    const copyOnly = page.getByRole('region', { name: '持久正文候选' }).locator('article')
      .filter({ hasText: '候选未通过保存校验；可复制保留' })
    await copyOnly.waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await copyOnly.count(), 1)
    assert.equal(await copyOnly.getByText(body, { exact: true }).count(), 1)
    assert.equal(await copyOnly.getByRole('button', { name: '复制', exact: true }).count(), 1)
    assert.equal(await copyOnly.getByRole('button', { name: '恢复此审修任务' }).isDisabled(), true)
    const afterNoop = formalRows(liveProjectPath)
    assert.deepEqual(afterNoop, beforeNoop, 'no-op changed formal drafts, reviews, revisions, cycles, bindings, effects or outbox')
    const afterGeneration = generationRows(liveProjectPath)
    const newRuns = afterGeneration.runs.filter(row => !beforeGeneration.runs.some(before => before.runId === row.runId))
    const newAttempts = afterGeneration.attempts.filter(row => !beforeGeneration.attempts.some(before => before.attemptId === row.attemptId))
    const newArtifacts = afterGeneration.artifacts.filter(row => !beforeGeneration.artifacts.some(before => before.artifactId === row.artifactId))
    assert.deepEqual(afterGeneration.runs.filter(row => beforeGeneration.runs.some(before => before.runId === row.runId)),
      beforeGeneration.runs, 'no-op changed an existing generation binding')
    assert.equal(newRuns.length, 1, 'no-op did not create exactly one fresh generation run')
    const noOpContext = JSON.parse(newRuns[0].binding).sourceManifest
    assert.equal(noOpContext.operation, 'refine-from-review')
    assert.equal(noOpContext.reviewRevisionContext.confirmation.reviewSourceId, confirmedReview.id)
    assert.deepEqual(noOpContext.reviewRevisionContext.source, liveSourceDraft)
    assert.equal(newAttempts.length, 1, 'no-op did not retain exactly one provider attempt')
    assert.equal(newAttempts[0].runId, newRuns[0].runId)
    assert.equal(newAttempts[0].rootActionId, newRuns[0].rootActionId)
    assert(['settled', 'unknown'].includes(JSON.parse(newAttempts[0].attempt).status))
    assert.equal(JSON.parse(newAttempts[0].usage).result.finishReason, 'stop')
    assert.equal(JSON.parse(newAttempts[0].usage).reviewRevisionEffect, undefined)
    assert.equal(newArtifacts.length, 1, 'no-op did not retain exactly one provider artifact')
    assert.equal(newArtifacts[0].attemptId, newAttempts[0].attemptId)
    assert.equal(newArtifacts[0].runId, newRuns[0].runId)
    assert.equal(JSON.parse(newArtifacts[0].artifact).text, body)
    assert.notEqual(newArtifacts[0].status, 'discarded')
    fixture.externalModelRequests += await app.evaluate(() => globalThis.__f05U12ExternalRequests ?? 0)
    assert.equal(fixture.externalModelRequests, 0)
    assert.deepEqual(fixture.requests.filter(item => item.route === '/v1/chat/completions')
      .map(item => [item.method, item.authorized]), [['POST', true], ['POST', true], ['POST', true]])
    pass('U12.A05-noop-negative-control', 'A fresh V3 revision returned the exact source; UI failure and copy-only artifact remained while all formal rows stayed unchanged',
      { confirmationReviewId: confirmedReview.id, preservedRevisionId: revision.id,
        runId: newRuns[0].runId, rootActionId: newRuns[0].rootActionId,
        attemptId: newAttempts[0].attemptId, artifactId: newArtifacts[0].artifactId,
        externalModelRequests: fixture.externalModelRequests }, 'U12.A05')

    currentStep = 'U12.A06-merge-unverified-control'
    const oldFinding = formalRows(liveProjectPath).findings
    assert.equal(oldFinding.length, 1)
    assert.equal(oldFinding[0].cycle_id, revised.cycles[0].cycleId)
    assert.deepEqual([oldFinding[0].kind, oldFinding[0].status, oldFinding[0].target_id],
      ['literary', 'unverified', null], 'the old unanchored finding cannot be a recheck positive control')
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    await page.getByRole('button', { name: '待合并(1)' }).click()
    const oldMerge = page.getByRole('dialog', { name: /^修稿合并 — 第1章/ })
    await oldMerge.getByRole('button', { name: '全部修稿' }).click()
    await oldMerge.getByRole('button', { name: '完成合并' }).click()
    const oldMerged = await waitForRows(liveProjectPath, state => state.cycles[0]?.revisionStatus === 'merge-committed'
      && state.revisions[0]?.status === 'merged' && state.draftStatuses[0]?.status === 'revised')
    assert.equal(draftRow(liveProjectPath, liveDraft.id).content, revisedBody)
    assert.equal(oldMerged.cycles[0].revisionId, revision.id)
    assert.equal(oldMerged.cycles[0].recheckCount, 0)
    assert.equal(formalRows(liveProjectPath).findings[0].status, 'unverified')
    await oldMerge.waitFor({ state: 'hidden' })
    const draftSave = page.getByRole('button', { name: '保存', exact: true })
    assert.equal(await draftSave.locator('..').locator('[title="有未保存的修改"]').count(), 1,
      'the first merge did not leave the observed unsaved chapter tab')
    assert.equal((await page.locator('.cm-content').innerText()).trim(), `港口灯塔\n第 1 章\n${revisedBody}`,
      'the unsaved editor body differs from the committed first merge')
    await draftSave.click()
    await draftSave.waitFor({ state: 'hidden' })
    assert.deepEqual(draftRow(liveProjectPath, liveDraft.id), { ...liveSourceDraft, status: 'revised', content: revisedBody })
    assert.equal(formalRows(liveProjectPath).revisions[0].status, 'merged')

    currentStep = 'U12.A06-objective-review'
    await page.locator('.writer-left-rail button[title="章节蓝图"]').click()
    const keyEventsInput = page.getByPlaceholder('主角做了什么，遭遇了什么反转，金手指怎么用的...')
    await keyEventsInput.waitFor({ state: 'visible' })
    assert.equal(await keyEventsInput.inputValue(), '林岚离开港口')
    await keyEventsInput.fill(forbiddenReturn)
    await page.getByRole('heading', { name: '第 1 章：港口灯塔' }).locator('..')
      .getByRole('button', { name: '保存', exact: true }).click()
    await waitForRows(liveProjectPath, state => state.blueprintKeyEvents === forbiddenReturn)
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    await page.getByRole('button', { name: 'AI 审稿', exact: true }).click()
    await page.getByRole('heading', { name: 'AI 审稿确认' }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '确认执行', exact: true }).click()
    const objectiveReviewed = await waitForRows(liveProjectPath, state => state.reviews.length === 3
      && state.cycles.length === 2)
    assert.equal(fixture.objectiveBound, true, 'the changed blueprint was not frozen in the production review request')
    const objectiveReview = objectiveReviewed.reviews[2]
    const objectiveCycle = objectiveReviewed.cycles.find(cycle => cycle.reviewId === objectiveReview.id)
    assert(objectiveCycle, 'the objective review has no production cycle')
    const objective = JSON.parse(objectiveReview.content)
    assert.deepEqual(objective.goalReview.items.map(item => [item.id, item.status, item.evidence[0]?.quote]),
      [['ch1:keyEvents:1', 'unmet', forbiddenReturnQuote]])
    const objectiveFinding = formalRows(liveProjectPath).findings.find(finding => finding.cycle_id === objectiveCycle.cycleId)
    assert(objectiveFinding, 'the objective review has no persisted finding')
    assert.deepEqual([objectiveFinding.kind, objectiveFinding.status, objectiveFinding.target_id,
      objectiveFinding.span_unit, objectiveFinding.span_start !== null, objectiveFinding.span_end !== null],
    ['objective', 'unresolved', 'ch1:keyEvents:1', 'utf16-code-unit', true, true])
    assert.equal(revisedBody.slice(objectiveFinding.span_start, objectiveFinding.span_end), forbiddenReturnQuote)
    fixture.recheckFinding = { findingId: objectiveFinding.finding_id, targetId: objectiveFinding.target_id,
      problem: objective.goalReview.items[0].description, expected: forbiddenReturn.replace(/^本章/, '') }

    currentStep = 'U12.A06-objective-revision'
    await page.getByText('人工确认修稿清单', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '明确纳入修稿', exact: true }).click()
    await page.getByRole('button', { name: '确认审稿清单', exact: true }).click()
    const objectiveConfirmed = await waitForRows(liveProjectPath, state => state.reviews.length === 4)
    const objectiveConfirmation = objectiveConfirmed.reviews[3]
    const objectiveSnapshot = JSON.parse(objectiveConfirmation.content)
    assert.equal(objectiveSnapshot.sourceReviewId, objectiveReview.id)
    assert.deepEqual(objectiveSnapshot.items.map(item => [item.goalId, item.decision]),
      [[undefined, 'ignore'], ['ch1:keyEvents:1', 'apply']])
    await page.getByRole('button', { name: '按确认意见修稿', exact: true }).click()
    await page.getByLabel('本次修稿模型').selectOption(liveModel.id)
    await page.getByRole('button', { name: '开始修稿', exact: true }).click()
    const objectiveRevised = await waitForRows(liveProjectPath, state => state.revisions.length === 2
      && state.cycles.find(cycle => cycle.cycleId === objectiveCycle.cycleId)?.revisionStatus === 'generated')
    const objectiveRevision = objectiveRevised.revisions.find(row => row.reviewSourceId === objectiveConfirmation.id)
    assert(objectiveRevision, 'the objective revision has no saved candidate')
    assert.equal(objectiveRevision.status, 'pending')
    assert.equal(objectiveRevision.content, recheckedBody)
    assert.equal(draftRow(liveProjectPath, liveDraft.id).content, revisedBody)
    assert.equal(formalRows(liveProjectPath).findings.find(row => row.finding_id === objectiveFinding.finding_id).status,
      'unresolved', 'generation cannot resolve an objective finding')

    currentStep = 'U12.A06-merge-and-recheck'
    if (lifecycle) {
      observedProcess = app.process()
      recordLifecycle('observe-start', processState())
      observedProcess.on('exit', (exitCode, signalCode) => recordLifecycle('process-exit',
        { pid: observedProcess.pid, exitCode, signalCode }))
      app.on('close', () => recordLifecycle('app-close', processState()))
      page.on('close', () => recordLifecycle('page-close'))
      page.on('crash', () => recordLifecycle('page-crash'))
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) recordLifecycle('page-main-frame-navigated')
      })
      try {
        const cdp = await app.context().newCDPSession(page)
        cdp.on('Runtime.executionContextCreated', ({ context }) => recordLifecycle('renderer-context-created',
          { contextId: context.id }))
        cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
          recordLifecycle('renderer-context-destroyed', { contextId: executionContextId }))
        cdp.on('Runtime.executionContextsCleared', () => recordLifecycle('renderer-contexts-cleared'))
        cdp.on('close', () => recordLifecycle('renderer-cdp-close'))
        await cdp.send('Runtime.enable')
        recordLifecycle('renderer-cdp-enabled')
      } catch (error) {
        recordLifecycle('renderer-cdp-unavailable', { message: error?.message ?? String(error) })
      }
    }
    const objectiveMerge = page.getByRole('dialog', { name: /^修稿合并 — 审稿修复/ })
    await objectiveMerge.waitFor({ state: 'visible' })
    assert.equal((await objectiveMerge.locator('.twm-cell-left').innerText()).trim(), revisedBody,
      'the second comparison is not based on the committed source draft')
    await objectiveMerge.getByRole('button', { name: '全部修稿' }).click()
    await objectiveMerge.getByRole('button', { name: '完成合并' }).click()
    const committedRows = waitForRows(liveProjectPath, state => state.reviews.length === 5
      && state.cycles.find(cycle => cycle.cycleId === objectiveCycle.cycleId)?.recheckCount === 1)
    const mergeErrorToast = page.locator('#vela-toast-root span').filter({
      hasText: /^(?:项目会话已失效，未合并修订内容|打开对比后正文已变化，未提交修订；请保存后重新打开|合并失败：|合并出错：)/,
    })
    const toastFailure = mergeErrorToast.waitFor({ state: 'visible', timeout: 60_000 }).then(async () => {
      const toast = await mergeErrorToast.first().innerText()
      const rows = liveRows(liveProjectPath)
      const error = new Error('F05_U12_MERGE_TOAST')
      error.diagnostic = {
        toast, modalVisible: await objectiveMerge.isVisible(),
        draft: draftRow(liveProjectPath, liveDraft.id), reviewCount: rows.reviews.length,
        revisions: rows.revisions.map(row => ({ id: row.id, status: row.status })),
        cycles: rows.cycles.map(row => ({ cycleId: row.cycleId, revisionStatus: row.revisionStatus,
          mergedHash: row.mergedHash, recheckCount: row.recheckCount })),
      }
      throw error
    }, () => committedRows)
    const completed = await Promise.race([committedRows, toastFailure])
    const committedCycle = completed.cycles.find(cycle => cycle.cycleId === objectiveCycle.cycleId)
    assert.equal(committedCycle.revisionStatus, 'merge-committed')
    assert.equal(committedCycle.revisionId, objectiveRevision.id)
    assert.equal(committedCycle.mergedHash, createHash('sha256').update(recheckedBody).digest('hex'))
    assert.equal(draftRow(liveProjectPath, liveDraft.id).content, recheckedBody)
    const finalRows = formalRows(liveProjectPath)
    const committedRevision = finalRows.revisions.find(row => row.id === objectiveRevision.id)
    assert.equal(committedRevision.status, 'merged')
    assert.equal(committedRevision.merged_to_draft_id, liveDraft.id)
    const finalFinding = finalRows.findings.find(row => row.finding_id === objectiveFinding.finding_id)
    assert.deepEqual([finalFinding.status, finalFinding.target_id, finalFinding.cycle_id],
      ['unresolved', 'ch1:keyEvents:1', objectiveCycle.cycleId], 'merge and recheck must not mark the still-violated goal resolved')
    const recheckAttempt = generationRows(liveProjectPath).attempts.find(row => row.attemptId === committedCycle.recheckAttemptId)
    assert(recheckAttempt, 'formal recheck has no provider attempt')
    const recheckReceipt = JSON.parse(recheckAttempt.usage).reviewCycleRecheck
    assert.equal(recheckAttempt.rootActionId, committedCycle.rootActionId)
    assert.deepEqual([recheckReceipt.cycleId, recheckReceipt.mergedHash, recheckReceipt.findingSetHash],
      [objectiveCycle.cycleId, committedCycle.mergedHash, committedCycle.findingSetHash])
    assert.deepEqual(recheckReceipt.findings.map(finding => [finding.findingId, finding.targetId, finding.resolved]),
      [[objectiveFinding.finding_id, 'ch1:keyEvents:1', false]])
    assert.equal(finalFinding.evidence_hash, recheckReceipt.findings[0].evidenceHash)
    assert.equal(finalRows.findings.find(row => row.cycle_id === oldMerged.cycles[0].cycleId).status, 'unverified')
    if (lifecycle) recordLifecycle('main-evaluate-before', processState())
    try {
      fixture.externalModelRequests += await app.evaluate(() => globalThis.__f05U12ExternalRequests ?? 0)
      if (lifecycle) recordLifecycle('main-evaluate-after', processState())
    } catch (error) {
      if (lifecycle) recordLifecycle('main-evaluate-error', { ...processState(),
        name: error?.name, message: error?.message })
      throw error
    }
    assert.equal(fixture.externalModelRequests, 0)
    assert.equal(fixture.requests.filter(item => item.route === '/v1/chat/completions').length, 6)
    pass('U12.A06-merge-not-resolved', 'V3 merged the old unverified control and a new anchored unresolved objective; the production post-merge recheck retained unresolved with matching cycle and hashes',
      { oldCycleId: oldMerged.cycles[0].cycleId, cycleId: objectiveCycle.cycleId,
        findingId: objectiveFinding.finding_id, revisionId: objectiveRevision.id,
        recheckAttemptId: committedCycle.recheckAttemptId, mergedHash: committedCycle.mergedHash,
        findingSetHash: committedCycle.findingSetHash, recheckCount: committedCycle.recheckCount,
        externalModelRequests: fixture.externalModelRequests }, 'U12.A06')
    if (a06Only) return

    currentStep = 'U12.A07-finalize-and-publish'
    await objectiveMerge.waitFor({ state: 'hidden' })
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    assert.equal((await page.locator('.cm-content').innerText()).trim(), `港口灯塔\n第 1 章\n${recheckedBody}`,
      'V3 editor does not show the rechecked revision being finalized')
    assert.deepEqual(liveRows(liveProjectPath).publicationStatuses, [], 'outbox existed before V3 finalization')
    await page.getByRole('button', { name: '定稿', exact: true }).click()
    const finalizationConfirm = page.getByRole('dialog').filter({ hasText: '确定要将第 1 章定稿吗？' })
    await finalizationConfirm.getByRole('button', { name: '确认定稿', exact: true }).click()
    await waitForRows(liveProjectPath, state => state.draftStatuses.some(row => row.id === liveDraft.id
      && row.status === 'finalized') && state.publicationStatuses.some(row => row.draftId === liveDraft.id
      && row.status === 'published'))
    const publishedRows = formalRows(liveProjectPath)
    const finalizedDraft = publishedRows.drafts.find(row => row.id === liveDraft.id)
    assert.equal(finalizedDraft.status, 'finalized')
    assert.equal(finalizedDraft.content, recheckedBody)
    assert.equal(publishedRows.outbox.length, 1, 'finalization did not atomically retain one outbox row')
    const outbox = publishedRows.outbox[0]
    const contentHash = createHash('sha256').update(recheckedBody, 'utf8').digest('hex')
    assert.equal(outbox.draft_id, liveDraft.id)
    assert.equal(outbox.chapter_number, 1)
    assert.equal(outbox.chapter_title, '港口灯塔')
    assert.equal(outbox.content_snapshot, recheckedBody)
    assert.equal(outbox.content_hash, contentHash)
    assert(Number.isInteger(outbox.content_revision) && outbox.content_revision > 0)
    assert.equal(outbox.publication_status, 'published')
    assert.equal(outbox.last_error, '')
    assert(outbox.published_at, 'published outbox has no timestamp')
    assert.equal(path.basename(outbox.target_file_name), outbox.target_file_name)
    const manuscriptPath = path.join(liveProjectPath, outbox.target_file_name)
    const manuscriptBytes = fs.readFileSync(manuscriptPath)
    const expectedManuscript = `第1章 港口灯塔\n\n${recheckedBody}`
    assert.deepEqual(manuscriptBytes, Buffer.from(expectedManuscript, 'utf8'), 'published manuscript bytes differ')
    await page.getByText('已定稿（只读）', { exact: true }).waitFor({ state: 'visible' })
    await page.locator('.writer-ai-panel').getByText('整个工作流已全部完成', { exact: true })
      .waitFor({ state: 'visible', timeout: 60_000 })
    fixture.externalModelRequests += await app.evaluate(() => globalThis.__f05U12ExternalRequests ?? 0)
    assert.equal(fixture.externalModelRequests, 0)
    await app.close(); app = null

    currentStep = 'U12.A07-process-reopen'
    ;({ app, page } = await launch(fixturePort))
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${liveProjectName}》` }).click()
    await page.locator(`.writer-project-tree .tree-item[title="点击打开 — 第1章 港口灯塔"]`).click()
    await page.getByText('已定稿（只读）', { exact: true }).waitFor({ state: 'visible' })
    const reopenedBody = await page.locator('.writer-editor-content .cm-content[contenteditable="false"]')
      .evaluate(element => Array.from(element.querySelectorAll('.cm-line'), line => {
        const copy = line.cloneNode(true)
        copy.querySelector('.cm-lp-paperhead')?.remove()
        return copy.textContent
      }).join('\n'))
    assert.equal(reopenedBody, recheckedBody)
    assert.equal(draftRow(liveProjectPath, liveDraft.id).status, 'finalized')
    const reopenedOutbox = formalRows(liveProjectPath).outbox
    assert.equal(reopenedOutbox.length, 1)
    for (const [key, value] of Object.entries(outbox)) {
      if (!['knowledge_document_id', 'updated_at'].includes(key)) assert.deepEqual(reopenedOutbox[0][key], value,
        `reopen changed committed outbox ${key}`)
    }
    assert.deepEqual(fs.readFileSync(manuscriptPath), manuscriptBytes, 'reopen changed the UTF-8 manuscript')
    fixture.externalModelRequests += await app.evaluate(() => globalThis.__f05U12ExternalRequests ?? 0)
    assert.equal(fixture.externalModelRequests, 0)
    pass('U12.A07-finalize-publish-reopen', 'V3 finalized the rechecked revision; SQLite draft and outbox, UTF-8 manuscript, and a new process agree on frozen content',
      { draftId: liveDraft.id, finalizationId: outbox.finalization_id, contentHash,
        contentRevision: outbox.content_revision, publicationStatus: outbox.publication_status,
        targetFileName: outbox.target_file_name,
        manuscriptSha256: createHash('sha256').update(manuscriptBytes).digest('hex'),
        externalModelRequests: fixture.externalModelRequests }, 'U12.A07')

    currentStep = 'U12.A08-failed-candidate-reopen'
    await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
    const failedCandidate = page.getByRole('region', { name: '持久正文候选' }).locator('article')
      .filter({ hasText: body })
    await failedCandidate.waitFor({ state: 'visible' })
    assert.equal(await failedCandidate.getByRole('button', { name: '复制', exact: true }).count(), 1)
    assert.equal(await failedCandidate.getByRole('button', { name: '恢复此审修任务' }).isDisabled(), true)
    assert.equal(generationRows(liveProjectPath).artifacts.find(row => row.artifactId === newArtifacts[0].artifactId)?.artifactId,
      newArtifacts[0].artifactId, 'the failed no-op artifact disappeared after process reopen')
    pass('U12.A08-failed-candidate-reopen', 'The failed no-op revision keeps its original copyable artifact after process reopen',
      { projectId: created.projectId, runId: newRuns[0].runId, artifactId: newArtifacts[0].artifactId,
        candidateTextSha256: createHash('sha256').update(body).digest('hex') }, 'U12.A08')
    await app.close(); app = null

    currentStep = 'U12.A08-isolated-candidate'
    ;({ app, page } = await launch(fixturePort))
    const candidateProject = await invoke(page, 'project:create', { path: profile.projects, name: candidateProjectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(candidateProject.success, true, candidateProject.error)
    const candidateProjectPath = candidateProject.projectPath
    const candidateOpen = await invoke(page, 'project:open', candidateProjectPath, randomUUID(), null)
    assert.equal(candidateOpen.success, true, candidateOpen.error)
    const candidateSession = { projectId: candidateProject.projectId, projectPath: candidateProjectPath,
      leaseId: candidateOpen.project.sessionLease }
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '候选边界',
      role: '发展', purpose: '保留过期候选', keyEvents: '林岚离开港口', characters: [] },
    candidateProjectPath, candidateSession)).success, true)
    const candidateDraft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1,
      source: 'write', content: body, wordCount: body.length }, candidateProjectPath, candidateSession)
    assert.equal(candidateDraft.success, true, candidateDraft.error)
    await app.close(); app = null
    ;({ app, page } = await launch(fixturePort))
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${candidateProjectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    await page.getByRole('button', { name: 'AI 审稿', exact: true }).click()
    await page.getByRole('heading', { name: 'AI 审稿确认' }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '确认执行', exact: true }).click()
    await waitForRows(candidateProjectPath, rows => rows.reviews.length === 1 && rows.cycles.length === 1)
    await page.getByText('人工确认修稿清单', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '确认审稿清单', exact: true }).click()
    await waitForRows(candidateProjectPath, rows => rows.reviews.length === 2)
    await page.getByRole('button', { name: '按确认意见修稿', exact: true }).click()
    await page.getByLabel('本次修稿模型').selectOption(liveModel.id)
    await page.getByRole('button', { name: '开始修稿', exact: true }).click()
    const candidateRows = await waitForRows(candidateProjectPath, rows => rows.revisions.length === 1
      && rows.cycles[0]?.revisionStatus === 'generated')
    const candidateRevision = candidateRows.revisions[0]
    assert.deepEqual([candidateRevision.baseDraftId, candidateRevision.status, candidateRevision.content],
      [candidateDraft.id, 'pending', revisedBody])
    assert.equal(candidateRows.outboxCount, 0)
    pass('U12.A08-isolated-candidate', 'V3 generated a pending source-bound review-fix candidate in a separate project',
      { projectId: candidateProject.projectId, draftId: candidateDraft.id, revisionId: candidateRevision.id,
        cycleId: candidateRows.cycles[0].cycleId }, 'U12.A08')

    currentStep = 'U12.A08-session-conflict'
    const candidateMerge = page.getByRole('dialog', { name: /^修稿合并 — 审稿修复/ })
    await candidateMerge.waitFor({ state: 'visible' })
    await candidateMerge.getByRole('button', { name: '全部修稿' }).click()
    const renewed = await invoke(page, 'project:open', candidateProjectPath, randomUUID(), null)
    assert.equal(renewed.success, true, renewed.error)
    const renewedSession = { projectId: candidateProject.projectId, projectPath: candidateProjectPath,
      leaseId: renewed.project.sessionLease }
    const concurrentBody = `${body} 作者另存了新句。`
    const concurrentSave = await invoke(page, 'db:draft-update-content', candidateDraft.id, concurrentBody,
      concurrentBody.length, candidateProjectPath, renewedSession)
    assert.equal(concurrentSave.success, true, concurrentSave.error)
    const beforeRejectedMerge = formalRows(candidateProjectPath)
    const beforeRejectedGeneration = generationRows(candidateProjectPath)
    await candidateMerge.getByRole('button', { name: '完成合并' }).click()
    await page.locator('#vela-toast-root').getByText(/项目会话已失效|合并失败/).first()
      .waitFor({ state: 'visible' })
    assert.deepEqual(formalRows(candidateProjectPath), beforeRejectedMerge,
      'stale V3 session merged or changed formal rows after a concurrent author save')
    assert.deepEqual(generationRows(candidateProjectPath), beforeRejectedGeneration)
    assert.equal(draftRow(candidateProjectPath, candidateDraft.id).content, concurrentBody)
    pass('U12.A08-session-conflict', 'V3 merge attempt rejected an expired project lease after a legal concurrent draft save',
      { projectId: candidateProject.projectId, draftId: candidateDraft.id,
        revisionId: candidateRevision.id, preservedStatus: 'pending' }, 'U12.A08')
    await app.close(); app = null

    currentStep = 'U12.A08-stale-source-reopen'
    ;({ app, page } = await launch(fixturePort))
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${candidateProjectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    await page.getByRole('button', { name: '待合并(1)' }).click()
    const staleMerge = page.getByRole('dialog', { name: /^修稿合并 — 第1章/ })
    await staleMerge.getByRole('alert').getByText('当前草稿已不是该修订稿的生成时源稿，修订仍可查看但不能合并。')
      .waitFor({ state: 'visible' })
    assert.equal((await staleMerge.locator('.twm-cell-left').innerText()).trim(), body,
      'stale comparison no longer shows the frozen source')
    await staleMerge.getByRole('button', { name: '全部修稿' }).click()
    const beforeStaleClick = formalRows(candidateProjectPath)
    await staleMerge.getByRole('button', { name: '完成合并' }).click()
    assert.deepEqual(formalRows(candidateProjectPath), beforeStaleClick,
      'stale V3 merge button changed formal rows')
    assert.equal(draftRow(candidateProjectPath, candidateDraft.id).content, concurrentBody)
    assert.equal(formalRows(candidateProjectPath).outbox.length, 0)
    await staleMerge.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '待合并(1)' }).click()
    await staleMerge.getByRole('alert').waitFor({ state: 'visible' })
    assert.equal(formalRows(candidateProjectPath).revisions[0].status, 'pending')
    pass('U12.A08-stale-source-reopen', 'V3 reopened the frozen candidate, explained the stale source, and refused to write draft, review, revision or outbox on merge',
      { projectId: candidateProject.projectId, draftId: candidateDraft.id,
        revisionId: candidateRevision.id, sourceTextSha256: createHash('sha256').update(body).digest('hex'),
        currentTextSha256: createHash('sha256').update(concurrentBody).digest('hex'),
        persistedCandidateTextSha256: createHash('sha256').update(revisedBody).digest('hex') }, 'U12.A08')
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message,
      ...(lifecycle ? { stack: error?.stack } : {}),
      ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}),
      ui: (await page?.locator('body').innerText().catch(() => ''))?.slice(-2500) }
    steps.push({ stepId: currentStep, actionId: currentStep === 'fixture-persist' ? null
      : currentStep.startsWith('U12.A02') ? 'U12.A02'
        : currentStep.startsWith('U12.A01') ? 'U12.A01'
          : currentStep.startsWith('U12.A04') ? 'U12.A04'
            : currentStep.startsWith('U12.A05') ? 'U12.A05'
              : currentStep.startsWith('U12.A06') ? 'U12.A06'
                : currentStep.startsWith('U12.A07') ? 'U12.A07'
                  : currentStep.startsWith('U12.A08') ? 'U12.A08' : 'U12.A03',
      outcome: 'RED', assertion: 'first failing boundary', observed: failure })
  } finally {
    if (app && failure) fixture.externalModelRequests += await app.evaluate(() => globalThis.__f05U12ExternalRequests ?? 0).catch(() => 0)
    const closing = app?.close().catch(() => {})
    if (closing && page) {
      const exitDialog = page.getByRole('dialog', { name: '退出前处理未保存内容' })
      const needsDiscard = await Promise.race([
        closing.then(() => false),
        exitDialog.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false),
      ])
      if (needsDiscard) await exitDialog.getByRole('button', { name: '放弃并退出' }).click()
    }
    await closing
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
    const requiredA08Steps = ['U12.A08-failed-candidate-reopen', 'U12.A08-isolated-candidate',
      'U12.A08-session-conflict', 'U12.A08-stale-source-reopen']
    const receipt = { schemaVersion: 1, qualification: a06Only ? 'F05_U12_A06_DIAGNOSTIC_ONLY' : 'F05_U12_A01_A08_PACKAGED_V3_FINALIZATION',
      overall: failure ? 'FAIL' : a06Only ? 'DIAGNOSTIC_ONLY' : 'PARTIAL', evidenceLevel: 'electron', shell: 'writer-v3',
      scope: a06Only ? ['U12.A06'] : ['U12.A01', 'U12.A02', 'U12.A03', 'U12.A04', 'U12.A05', 'U12.A06', 'U12.A07', 'U12.A08'], testedSha, executionHead: git('rev-parse', 'HEAD'),
      artifact: { executablePath, executableSha256: sha256(executablePath), asarPath, asarSha256: sha256(asarPath) },
      driver: { path: driverPath, sha256: sha256(driverPath) }, profile: { scratch, projectPath, liveProjectPath },
      provider: { kind: 'loopback-synthetic-openai-sse', localRequests: fixture.requests,
        externalModelRequests: fixture.externalModelRequests, promptBoundaries: fixture.promptBoundaries },
      steps, unverifiedActions: ['U12.A01', 'U12.A02', 'U12.A03', 'U12.A04', 'U12.A05', 'U12.A06', 'U12.A07', 'U12.A08']
        .filter(actionId => actionId === 'U12.A08'
          ? !requiredA08Steps.every(stepId => steps.some(step => step.stepId === stepId && step.outcome === 'PASS'))
          : !steps.some(step => step.actionId === actionId && step.outcome === 'PASS')),
      failure, ...(lifecycle ? { lifecycle } : {}) }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ overall: receipt.overall, receipt: receiptPath,
      failedStep: failure?.step ?? null, steps: steps.map(step => step.stepId) })}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
