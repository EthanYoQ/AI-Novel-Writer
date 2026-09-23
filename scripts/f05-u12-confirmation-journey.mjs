/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
if (process.argv.includes('--help')) {
  process.stdout.write('F05 U12.A03 V3 packaged confirmation journey: --package-dir --package-source-sha --exe-sha256 --asar-sha256\n')
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
const body = '林岚离开港口，带走了日志。第二天，她回到灯塔。'
const report = JSON.stringify({ summary: '两项待作者判断。', items: [
  { category: '连续性', severity: 'error', description: '保留：核对林岚离开港口后的时间线。', quote: '第二天，她回到灯塔。' },
  { category: '节奏', severity: 'warning', description: '拒绝：删掉灯塔场景。', quote: '她回到灯塔。' },
] })
const steps = []
const pass = (stepId, assertion, observed) => steps.push({ stepId, actionId: 'U12.A03', outcome: 'PASS', assertion, observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
function reviewRows(projectPath) {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    return db.prepare(`SELECT r.id, r.base_draft_id AS baseDraftId, r.review_index AS reviewIndex,
      r.source_content AS sourceContent, c.body AS content FROM reviews r JOIN contents c ON c.id=r.content_id
      ORDER BY r.review_index`).all()
  } finally { db.close() }
}
async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy,
    HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir,
    args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
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
async function openReport(page) {
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
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
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U12.A03',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 24,
    retainedReason: 'isolated SQLite and failure evidence for independent review',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app, page, projectPath, sourceReviewId, draftId, failure
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
    pass('fixture-source', 'Production project, draft and original review repositories persist a visible source record',
      { draftId, sourceReviewId, sourceReviewSha256: createHash('sha256').update(report).digest('hex') })
    await app.close(); app = null

    currentStep = 'U12.A03-v3-confirm'
    ;({ app, page } = await launch())
    await openReport(page)
    const issueFields = page.locator('textarea[aria-label="审稿问题"]')
    assert.equal(await issueFields.count(), 2, 'V3 must show both seeded review issues')
    assert.equal(await issueFields.nth(1).inputValue(), '拒绝：删掉灯塔场景。')
    assert.equal(await page.getByRole('button', { name: '忽略', exact: true }).count(), 2,
      'both fixture review items must default to included')
    await page.getByRole('button', { name: '忽略', exact: true }).nth(1).click()
    await page.getByText('已忽略，不会传给模型', { exact: true }).waitFor({ state: 'visible' })
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
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message,
      ui: (await page?.locator('body').innerText().catch(() => ''))?.slice(-2500) }
    steps.push({ stepId: currentStep, actionId: currentStep === 'fixture-persist' ? null : 'U12.A03',
      outcome: 'RED', assertion: 'first failing boundary', observed: failure })
  } finally {
    await app?.close().catch(() => {})
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
    const receipt = { schemaVersion: 1, qualification: 'F05_U12_A03_PACKAGED_V3_CONFIRMATION',
      overall: failure ? 'FAIL' : 'PARTIAL', evidenceLevel: 'electron', shell: 'writer-v3',
      scope: ['U12.A03'], testedSha, executionHead: git('rev-parse', 'HEAD'),
      artifact: { executablePath, executableSha256: sha256(executablePath), asarPath, asarSha256: sha256(asarPath) },
      driver: { path: driverPath, sha256: sha256(driverPath) }, profile: { scratch, projectPath },
      steps, unverifiedActions: ['U12.A01', 'U12.A02', 'U12.A04', 'U12.A05', 'U12.A06', 'U12.A07', 'U12.A08'],
      failure }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ overall: receipt.overall, receipt: receiptPath,
      failedStep: failure?.step ?? null, steps: steps.map(step => step.stepId) })}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
