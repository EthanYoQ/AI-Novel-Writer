/* global process */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import * as refs from './redesign/pages/refs.mjs'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const driverPath = fileURLToPath(import.meta.url)
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = path.resolve(option('package-dir') ?? '')
const testedSha = git('rev-parse', '--verify', `${option('build-sha')}^{commit}`)
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
assert(packageDir && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'Pass fixed package directory, build SHA, executable hash and ASAR hash')
const executionHead = git('rev-parse', 'HEAD')
const changedPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`).split('\n').filter(Boolean)
const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml',
  'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
assert.equal(git('diff', '--name-only', `${testedSha}..${executionHead}`, '--', ...productInputs), '',
  'Product source changed since fixed package build')
const dirtyProduct = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build',
  'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5')
  .split('\n').filter(Boolean)
assert.deepEqual(dirtyProduct, [], 'Dirty product inputs since packaged build')
const executablePath = resolveWindowsExecutable(packageDir)
const asarPath = path.join(packageDir, 'resources', 'app.asar')
assert.equal(sha256(executablePath), expectedExe)
assert.equal(sha256(asarPath), expectedAsar)
const driverSha256 = sha256(driverPath)
const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u15-plot-narrative', runId)
assert(process.env.LOCALAPPDATA, 'LOCALAPPDATA is required for isolated profile')
const scratchBase = path.resolve(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'an', 'u15')
const scratch = path.join(scratchBase, runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const projectName = '合成剧情计划'
const planTitle = `旧站来信 ${runId.slice(0, 8)}`
const updatedTitle = `旧站回信 ${runId.slice(0, 8)}`
const deletedTitle = `待删除线索 ${runId.slice(0, 8)}`
const candidateTitle = `未采纳线索 ${runId.slice(0, 8)}`
const model = { id: `u15-plot-${runId.slice(0, 8)}`, name: 'U15 isolated plot fixture', provider: 'openai',
  protocol: 'openai', modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: `u15-${runId}`,
  maxTokens: 8192, temperature: 0.7, purposes: ['generation'] }
const providerRequests = []
let sourcePlanId
let sourceDraftId
let failNextRequest = false
let generationFailureEvidence
let candidateRejectionEvidence
let eventEvidenceFailure
let providerFailure
const provider = createServer(async (request, response) => {
  try {
    const authorized = request.method === 'POST' && request.url === '/v1/chat/completions'
      && request.headers.authorization === `Bearer ${model.apiKey}`
    if (!authorized || !sourcePlanId) { response.writeHead(403).end(); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const facts = JSON.parse(body.messages.at(-1).content)
    const isPlanCandidate = Boolean(facts.blueprint)
    const currentPlan = isPlanCandidate ? null : facts.narrativeThreads.find(plan => plan.id === sourcePlanId)
    if (isPlanCandidate) assert.equal(facts.blueprint.chapterNumber, 1, 'candidate request omitted the synthetic blueprint')
    else {
      assert(currentPlan, 'model request omitted the current narrative plan')
      assert(facts.blueprints.some(blueprint => blueprint.chapterNumber === 1 && blueprint.title === '旧站来信'),
        'plot request omitted the synthetic blueprint')
      assert(facts.finalizedChapters.some(chapter => chapter.draftId === sourceDraftId && chapter.chapterNumber === 1),
        'plot request omitted the synthetic finalized chapter')
    }
    const number = providerRequests.length + 1
    const responseStatus = failNextRequest ? 503 : 200
    failNextRequest = false
    providerRequests.push({ number, kind: isPlanCandidate ? 'plan-candidate' : 'plot', path: request.url, authorized,
      sourcePlanId, sourceTitle: currentPlan?.title, sourceEvents: currentPlan?.events.length, responseStatus })
    if (responseStatus === 503) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'U15 controlled provider failure' } }))
      return
    }
    const content = isPlanCandidate
      ? JSON.stringify({ candidates: [{ title: candidateTitle, type: '伏笔', targetStartChapter: 1,
        targetEndChapter: 1, authorIntent: '仅供作者审阅，不自动写入。' }] })
      : JSON.stringify({ tracks: [{ id: 'u15-main', title: `旧站主线-${number}`, role: 'main',
      startChapter: 1, endChapter: 1, summary: '隔离模型归纳的合成主线', events: [{ status: 'planned', chapterNumber: 1,
        summary: `旧站线索-${number}`, sources: [{ type: 'narrative-thread', planId: sourcePlanId }] },
      { status: 'planned', chapterNumber: 1, summary: `蓝图线索-${number}`,
        sources: [{ type: 'blueprint', chapterNumber: 1 }] },
      { status: 'occurred', chapterNumber: 1, summary: `定稿线索-${number}`,
        sources: [{ type: 'finalized-chapter', draftId: sourceDraftId, chapterNumber: 1 }] }] }] })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  } catch {
    providerFailure = new Error('U15_SYNTHETIC_PROVIDER_REQUEST_INVALID')
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: providerFailure.message } }))
  }
})
const steps = []
let phase = 'setup'
let app

const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
async function assertWriter(page) {
  await stage.waitForStage(page)
  assert.equal(await stage.root(page).getAttribute('data-shell-presentation'), 'stage', `${phase}: not the paper-ink stage`)
}
const plotView = (page, name) => refs.plotView(page, name)
async function openPlot(page) {
  await refs.open(page, 'plot')
  await page.getByRole('heading', { level: 1, name: '剧情与伏笔' }).waitFor({ state: 'visible' })
}
async function showThreads(page) {
  await plotView(page, '伏笔线索').click()
  await page.getByRole('region', { name: '线索计划' }).waitFor({ state: 'visible' })
}
const threadItem = (page, title) => page.locator('li.stage-thread').filter({ has: page.getByText(title, { exact: true }) })
async function threadMenu(page, title, item) {
  await refs.threadMore(page, title).click()
  await page.getByRole('menuitem', { name: item }).click()
}
async function fillThreadForm(page, dialogTitle, values) {
  const dialog = page.getByRole('dialog', { name: dialogTitle })
  await dialog.waitFor({ state: 'visible' })
  if (values.title !== undefined) await dialog.getByLabel('名称', { exact: true }).fill(values.title)
  if (values.type !== undefined) await dialog.getByLabel('类型', { exact: true }).fill(values.type)
  // label 包着 textarea，已有内容会进 label 的文字（「你的打算」后面跟着原来的打算），按开头匹配。
  if (values.intent !== undefined) await dialog.getByLabel(/^你的打算/).fill(values.intent)
  await dialog.getByRole('button', { name: '保存线索' }).click()
  await dialog.waitFor({ state: 'hidden' })
}
const plotEvent = (page, summary) => refs.plotTable(page).getByRole('button', { name: summary })
async function openEventSource(page, label) {
  await page.getByRole('region', { name: '事件详情' }).getByRole('button', { name: `打开来源：${label}` }).click()
}
async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy,
    HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const opened = await electron.launch({ executablePath, cwd: packageDir,
    args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  try {
    await opened.evaluate((_, port) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, options) => {
        const url = new URL(String(input))
        if (url.origin !== 'https://api.openai.com') throw new Error('U15_UNREGISTERED_MAIN_FETCH')
        return originalFetch(`http://127.0.0.1:${port}${url.pathname}`, options)
      }
    }, provider.address().port)
    const page = await opened.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(12_000)
    await stage.waitForStage(page)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { opened, page }
  } catch (error) { await opened.close(); throw error }
}
async function openProject(page) {
  await assertWriter(page)
  await stage.dismissMigrationNotice(page)
  await stage.showLibrary(page)
  await stage.openFromLibrary(page, projectName)
  await stage.waitForWork(page, projectName)
}
async function quit() {
  const child = app.process()
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); return true })
  assert.deepEqual(await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Electron did not exit')), 10_000))]),
    { code: 0, signal: null })
  app = null
}
async function main() {
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u15',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 24,
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let failure
  try {
    await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
    phase = 'fixture-project'
    let session = await launch()
    app = session.opened
    const created = await invoke(session.page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(session.opened, session.page, profile.projects)).grantId, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    assert.equal(path.relative(scratch, created.projectPath).startsWith('..'), false)
    const openedProject = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), null)
    assert.equal(openedProject.success, true, openedProject.error)
    const fixtureSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: openedProject.project.sessionLease }
    const finalizedText = '旧站来信藏着铜钥匙'
    const imported = await invoke(session.page, 'db:draft-import-finalized-batch', { operationId: `u15-${runId}`,
      chapters: [{ chapterNumber: 1, title: '旧站来信', content: finalizedText,
        wordCount: [...finalizedText].length }] }, created.projectPath, fixtureSession)
    assert.equal(imported.success, true, imported.error)
    const importedDrafts = await invoke(session.page, 'db:draft-list-all', created.projectPath, fixtureSession)
    const importedDraft = importedDrafts.find(draft => draft.chapterNumber === 1 && draft.status === 'finalized')
    assert(importedDraft, 'synthetic finalized chapter was not listed')
    sourceDraftId = importedDraft.id
    const persistedFinalized = await invoke(session.page, 'db:draft-get-full', sourceDraftId, created.projectPath, fixtureSession)
    assert.equal(persistedFinalized?.content, finalizedText)
    const blueprint = await invoke(session.page, 'db:blueprint-upsert', { chapterNumber: 1, title: '旧站来信',
      role: '发展', purpose: '调查来信来源', keyEvents: '发现铜钥匙', characters: [] }, created.projectPath, fixtureSession)
    assert.equal(blueprint.success, true, blueprint.error)
    assert.equal((await invoke(session.page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(session.page, 'llm:set-default-model', model.id)).success, true)
    await session.page.reload()
    await openProject(session.page)

    // 纸墨外壳：「剧情与伏笔」是作品资料里的一页，「剧情树」与「伏笔线索」两种视图；线索在「新建线索」对话框里建，
    // 编辑、记录定稿里的变化、删除都在线索的「更多」菜单里；剧情树事件的来源在「事件详情」里打开。
    phase = 'writer-plot-tree'
    await assertWriter(session.page)
    await openPlot(session.page)
    assert.equal(await plotView(session.page, '剧情树').getAttribute('aria-pressed'), 'true')
    await session.page.getByText('还没有剧情树', { exact: true }).waitFor({ state: 'visible' })
    steps.push({ stepId: 'writer-plot-tree-entry', relatedActionId: 'U15.A06', coverage: 'empty-tree-entry-only',
      assertion: 'The plot & threads page opened on the plot tree view and rendered its empty state' })

    phase = 'writer-narrative-plan'
    await showThreads(session.page)
    await session.page.getByRole('button', { name: '新建线索' }).first().click()
    await fillThreadForm(session.page, '新建线索', { title: planTitle, type: '伏笔', intent: '在第三章回收旧站来信的来源。' })
    await threadItem(session.page, planTitle).waitFor({ state: 'visible' })
    const reopened = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), created.projectPath)
    assert.equal(reopened.success, true, reopened.error)
    const projectSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: reopened.project.sessionLease }
    const savedPlans = await invoke(session.page, 'db:narrative-thread-list', created.projectPath, projectSession)
    const savedPlan = savedPlans.find(plan => plan.title === planTitle && plan.type === '伏笔'
      && plan.authorIntent === '在第三章回收旧站来信的来源。')
    assert(savedPlan)
    sourcePlanId = savedPlan.id
    steps.push({ stepId: 'writer-narrative-plan-create', relatedActionId: 'U15.A07', coverage: 'plan-create-and-list-ipc',
      assertion: 'The new-thread dialog saved through production UI; a fresh main project session listed its durable plan fields' })

    phase = 'v3-plot-generate'
    await openProject(session.page)
    await openPlot(session.page)
    await session.page.getByRole('button', { name: '生成剧情树', exact: true }).click()
    await session.page.getByText('旧站主线-1', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    const readOpen = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), created.projectPath)
    assert.equal(readOpen.success, true, readOpen.error)
    const readSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: readOpen.project.sessionLease }
    const firstTree = await invoke(session.page, 'db:plot-tree-read', created.projectPath, readSession)
    assert.equal(firstTree.snapshot?.tracks[0]?.title, '旧站主线-1')
    assert.equal(providerRequests.length, 1)
    steps.push({ stepId: 'v3-plot-generate', relatedActionId: 'U15.A06', coverage: 'ui-model-generate-and-db-read',
      assertion: 'The stage generated a source-backed tree through a controlled model request and persisted its selected result' })
    await openProject(session.page)

    phase = 'v3-plot-source-navigation'
    await openPlot(session.page)
    await session.page.getByText('旧站主线-1', { exact: true }).waitFor({ state: 'visible' })
    await plotEvent(session.page, '旧站线索-1').click()
    await openEventSource(session.page, '伏笔线索计划')
    assert.equal(await plotView(session.page, '伏笔线索').getAttribute('aria-pressed'), 'true')
    const planSection = session.page.locator(`#narrative-plan-${sourcePlanId}`)
    await planSection.getByText(planTitle, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await planSection.getAttribute('data-source'), 'true', 'the opened source thread is not highlighted')
    steps.push({ stepId: 'v3-plot-open-source', relatedActionId: 'U15.A06', coverage: 'event-source-navigation',
      assertion: 'A plot tree event opened its persisted thread-plan source in the threads view' })

    phase = 'v3-plot-blueprint-source-navigation'
    await openPlot(session.page)
    await plotEvent(session.page, '蓝图线索-1').click()
    await openEventSource(session.page, '第 1 章蓝图')
    const blueprintCard = session.page.getByRole('region', { name: '第 1 章蓝图' })
    await blueprintCard.waitFor({ state: 'visible' })
    assert.equal(await blueprintCard.getByRole('textbox', { name: '章节标题' }).inputValue(), '旧站来信')
    assert.equal(await blueprintCard.getByLabel(/^主角小目标/).inputValue(), '调查来信来源')
    steps.push({ stepId: 'v3-plot-open-blueprint-source', relatedActionId: 'U15.A06',
      coverage: 'existing-blueprint-event-source-navigation',
      assertion: 'A plot tree event opened the existing chapter 1 blueprint card and displayed its persisted purpose' })

    phase = 'v3-plot-finalized-source-navigation'
    await openPlot(session.page)
    await plotEvent(session.page, '定稿线索-1').click()
    await openEventSource(session.page, '第 1 章定稿')
    await session.page.getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible' })
    const finalizedEditor = stage.prose(session.page)
    await finalizedEditor.waitFor({ state: 'visible' })
    assert.equal(await finalizedEditor.getAttribute('contenteditable'), 'false')
    assert.equal(await stage.proseBody(finalizedEditor), persistedFinalized.content)
    steps.push({ stepId: 'v3-plot-open-finalized-source', relatedActionId: 'U15.A06',
      coverage: 'existing-finalized-event-source-navigation',
      assertion: 'A plot tree event opened the existing finalized chapter 1 as read-only with its persisted body' })

    await openPlot(session.page)
    await showThreads(session.page)

    phase = 'v3-narrative-plan-update'
    await threadMenu(session.page, planTitle, '编辑线索')
    await fillThreadForm(session.page, '编辑线索', { title: updatedTitle, intent: '在第一章确认旧站来信并延伸铜钥匙线索。' })
    await threadItem(session.page, updatedTitle).waitFor({ state: 'visible' })
    steps.push({ stepId: 'v3-narrative-plan-update', relatedActionId: 'U15.A07', coverage: 'ui-plan-update',
      assertion: 'Editing the thread updated the persisted source identity shown in the thread list' })

    phase = 'v3-narrative-event-evidence-reject'
    const beforeInvalidOpen = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), created.projectPath)
    assert.equal(beforeInvalidOpen.success, true, beforeInvalidOpen.error)
    const beforeInvalidSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: beforeInvalidOpen.project.sessionLease }
    const beforeInvalidPlans = await invoke(session.page, 'db:narrative-thread-list', created.projectPath, beforeInvalidSession)
    const beforeInvalidPlanReadSha256 = createHash('sha256').update(JSON.stringify(beforeInvalidPlans)).digest('hex')
    assert.equal(beforeInvalidPlans.length, 1)
    assert.equal(beforeInvalidPlans[0].id, sourcePlanId)
    assert.equal(beforeInvalidPlans[0].events.length, 0)
    await openProject(session.page)
    await openPlot(session.page)
    await showThreads(session.page)
    await threadMenu(session.page, updatedTitle, '记录定稿里的变化')
    const eventForm = session.page.getByRole('region', { name: '定稿里的线索变化' })
    const eventDraftSelect = eventForm.getByLabel('定稿章节')
    const selectedFinalizedDraft = await eventDraftSelect.inputValue()
    assert(selectedFinalizedDraft, 'event form did not select a finalized chapter')
    await eventDraftSelect.selectOption(selectedFinalizedDraft)
    const invalidEvidence = `不存在的合成证据-${runId.slice(0, 8)}`
    const invalidReason = '用于验证定稿证据拒绝'
    await eventForm.getByLabel('定稿里的原文').fill(invalidEvidence)
    await eventForm.getByLabel('理由').fill(invalidReason)
    await eventForm.getByRole('button', { name: '记入线索' }).click()
    const evidenceError = eventForm.getByRole('alert')
    await evidenceError.waitFor({ state: 'visible' })
    const evidenceErrorText = (await evidenceError.textContent())?.trim()
    assert.equal(evidenceErrorText, '请粘贴所选定稿章节中实际出现的短原文。')
    assert.equal(await eventDraftSelect.inputValue(), selectedFinalizedDraft)
    const afterInvalidOpen = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), created.projectPath)
    assert.equal(afterInvalidOpen.success, true, afterInvalidOpen.error)
    const afterInvalidSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: afterInvalidOpen.project.sessionLease }
    const afterInvalidPlans = await invoke(session.page, 'db:narrative-thread-list', created.projectPath, afterInvalidSession)
    const afterInvalidPlanReadSha256 = createHash('sha256').update(JSON.stringify(afterInvalidPlans)).digest('hex')
    assert.deepEqual(afterInvalidPlans, beforeInvalidPlans, 'invalid finalized evidence changed the narrative plan or events')
    assert.equal(afterInvalidPlans[0].events.length, 0)
    assert.equal(afterInvalidPlanReadSha256, beforeInvalidPlanReadSha256)
    eventEvidenceFailure = { errorText: evidenceErrorText, invalidEvidence, invalidReason, selectedFinalizedDraft,
      beforePlanReadSha256: beforeInvalidPlanReadSha256, afterPlanReadSha256: afterInvalidPlanReadSha256,
      beforeEventCount: beforeInvalidPlans[0].events.length, afterEventCount: afterInvalidPlans[0].events.length }
    steps.push({ stepId: 'v3-narrative-event-evidence-reject', relatedActionId: 'U15.A07', coverage: 'ui-finalized-evidence-reject-and-db-read',
      assertion: 'The stage rejected synthetic evidence absent from the selected finalized chapter, showed the required error, and left the plan/event read view unchanged' })

    phase = 'v3-narrative-event-confirm'
    await openProject(session.page)
    await openPlot(session.page)
    await showThreads(session.page)
    await threadMenu(session.page, updatedTitle, '记录定稿里的变化')
    const confirmForm = session.page.getByRole('region', { name: '定稿里的线索变化' })
    await confirmForm.getByLabel('定稿章节').selectOption(selectedFinalizedDraft)
    await confirmForm.getByLabel('定稿里的原文').fill('旧站来信')
    await confirmForm.getByLabel('理由').fill('定稿原文明确出现来信')
    await confirmForm.getByRole('button', { name: '记入线索' }).click()
    await threadItem(session.page, updatedTitle).getByText('第 1 章 · 已埋设 · 旧站来信', { exact: true }).waitFor({ state: 'visible' })
    steps.push({ stepId: 'v3-narrative-event-confirm', relatedActionId: 'U15.A07', coverage: 'ui-finalized-evidence-confirm',
      assertion: 'The stage recorded a short quote from the synthetic finalized chapter as a planted event of the thread' })

    phase = 'v3-narrative-plan-delete'
    await session.page.getByRole('button', { name: '新建线索' }).first().click()
    await fillThreadForm(session.page, '新建线索', { title: deletedTitle, type: '支线', intent: '只用于验证删除' })
    await threadItem(session.page, deletedTitle).waitFor({ state: 'visible' })
    await threadMenu(session.page, deletedTitle, '删除线索…')
    await session.page.getByRole('dialog', { name: '删除这条线索？' }).getByRole('button', { name: '删除线索', exact: true }).click()
    await threadItem(session.page, deletedTitle).waitFor({ state: 'detached' })
    await threadItem(session.page, updatedTitle).waitFor({ state: 'visible' })
    steps.push({ stepId: 'v3-narrative-plan-delete', relatedActionId: 'U15.A07', coverage: 'ui-plan-delete',
      assertion: 'The stage deleted only the transient synthetic thread after the danger confirmation and kept the edited thread visible' })

    phase = 'v3-plot-refresh'
    await plotView(session.page, '剧情树').click()
    await session.page.getByText('之后资料有更新', { exact: false }).waitFor({ state: 'visible' })
    await session.page.getByRole('button', { name: '刷新剧情树', exact: true }).click()
    await session.page.getByText('旧站主线-2', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(providerRequests.length, 2)
    assert.equal(providerRequests[1].sourceTitle, updatedTitle)
    assert.equal(providerRequests[1].sourceEvents, 1)
    steps.push({ stepId: 'v3-plot-refresh', relatedActionId: 'U15.A06', coverage: 'ui-refresh-after-source-update',
      assertion: 'The stage marked the tree stale and refreshed it using the updated plan and confirmed finalized event' })

    phase = 'v3-plot-generation-failure'
    const beforeFailureOpen = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), created.projectPath)
    assert.equal(beforeFailureOpen.success, true, beforeFailureOpen.error)
    const beforeFailureSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: beforeFailureOpen.project.sessionLease }
    const beforeFailureTree = await invoke(session.page, 'db:plot-tree-read', created.projectPath, beforeFailureSession)
    assert.equal(beforeFailureTree.snapshot?.tracks[0]?.title, '旧站主线-2')
    await openProject(session.page)
    await openPlot(session.page)
    await session.page.getByText('旧站主线-2', { exact: true }).waitFor({ state: 'visible' })
    failNextRequest = true
    await session.page.getByRole('button', { name: '刷新剧情树', exact: true }).click()
    // 失败写在剧情树上方的危险提示里（这次是「本次生成未完成保存……」，引导去整理记录恢复），不出现新的剧情树。
    const generationAlert = stage.root(session.page).locator('.pi-notice[data-tone="danger"]')
    await generationAlert.waitFor({ state: 'visible', timeout: 60_000 })
    const errorText = (await generationAlert.textContent())?.trim()
    assert(errorText)
    assert.equal(failNextRequest, false, 'controlled failure request was not sent')
    assert.equal(providerRequests.length, 3, 'failed generation made an unexpected number of requests')
    assert.equal(providerRequests[2].responseStatus, 503)
    await session.page.getByText('旧站主线-2', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await session.page.getByText('旧站主线-3', { exact: true }).count(), 0)
    const afterFailureOpen = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), created.projectPath)
    assert.equal(afterFailureOpen.success, true, afterFailureOpen.error)
    const afterFailureSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: afterFailureOpen.project.sessionLease }
    const afterFailureTree = await invoke(session.page, 'db:plot-tree-read', created.projectPath, afterFailureSession)
    assert.deepEqual(afterFailureTree, beforeFailureTree, 'failed generation overwrote the stored plot tree')
    generationFailureEvidence = { requestNumber: providerRequests[2].number,
      responseStatus: providerRequests[2].responseStatus, errorText,
      beforePlotTreeReadSha256: createHash('sha256').update(JSON.stringify(beforeFailureTree)).digest('hex'),
      afterPlotTreeReadSha256: createHash('sha256').update(JSON.stringify(afterFailureTree)).digest('hex') }
    steps.push({ stepId: 'v3-plot-generation-failure', relatedActionId: 'U15.A06',
      coverage: 'ui-controlled-provider-failure-and-db-read',
      assertion: 'The stage surfaced the failed provider request, showed no false success and kept the SQLite-backed plot-tree read view unchanged' })

    phase = 'v3-plot-clear'
    await openProject(session.page)
    await openPlot(session.page)
    await session.page.getByText('旧站主线-2', { exact: true }).waitFor({ state: 'visible' })
    await refs.plotMore(session.page).click()
    await refs.menuItem(session.page, '清除剧情树…').click()
    await session.page.getByRole('dialog', { name: '清除剧情树？' }).getByRole('button', { name: '清除剧情树', exact: true }).click()
    await session.page.getByText('还没有剧情树', { exact: true }).waitFor({ state: 'visible' })
    const afterOpen = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), created.projectPath)
    assert.equal(afterOpen.success, true, afterOpen.error)
    const afterSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: afterOpen.project.sessionLease }
    const afterTree = await invoke(session.page, 'db:plot-tree-read', created.projectPath, afterSession)
    assert.equal(afterTree.snapshot, null)
    const afterPlans = await invoke(session.page, 'db:narrative-thread-list', created.projectPath, afterSession)
    assert.equal(afterPlans.length, 1)
    assert.equal(afterPlans[0].id, sourcePlanId)
    assert.equal(afterPlans[0].title, updatedTitle)
    assert.equal(afterPlans[0].events.length, 1)
    assert.equal(afterPlans[0].events[0].evidence, '旧站来信')
    steps.push({ stepId: 'v3-plot-clear', relatedActionId: 'U15.A06', coverage: 'ui-clear-and-db-read',
      assertion: 'The stage cleared the stored tree after the danger confirmation while retaining the edited thread and its finalized event' })

    phase = 'v3-narrative-candidate-reject'
    await openProject(session.page)
    await openPlot(session.page)
    await showThreads(session.page)
    const suggestions = session.page.getByRole('region', { name: 'AI 建议的伏笔' })
    await suggestions.getByRole('button', { name: '根据蓝图建议伏笔' }).click()
    const candidateSection = suggestions.getByRole('article', { name: '伏笔建议' }).filter({ hasText: candidateTitle })
    await candidateSection.getByText(candidateTitle, { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(providerRequests.length, 4)
    assert.equal(providerRequests[3].kind, 'plan-candidate')
    assert.equal(providerRequests[3].responseStatus, 200)
    await candidateSection.getByRole('button', { name: '不采纳' }).click()
    await candidateSection.waitFor({ state: 'detached' })
    const afterRejectOpen = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), created.projectPath)
    assert.equal(afterRejectOpen.success, true, afterRejectOpen.error)
    const afterRejectSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: afterRejectOpen.project.sessionLease }
    const afterRejectPlans = await invoke(session.page, 'db:narrative-thread-list', created.projectPath, afterRejectSession)
    assert.deepEqual(afterRejectPlans, afterPlans, 'rejected AI candidate changed the author plan or confirmed event')
    candidateRejectionEvidence = { requestNumber: providerRequests[3].number,
      beforePlanReadSha256: createHash('sha256').update(JSON.stringify(afterPlans)).digest('hex'),
      afterPlanReadSha256: createHash('sha256').update(JSON.stringify(afterRejectPlans)).digest('hex') }
    steps.push({ stepId: 'v3-narrative-candidate-reject', relatedActionId: 'U15.A07',
      coverage: 'ui-controlled-ai-candidate-reject-and-db-read',
      assertion: 'The stage dismissed a generated blueprint thread suggestion without changing the existing author plan or confirmed event' })

    phase = 'restart-persistence'
    await quit()
    session = await launch()
    app = session.opened
    await openProject(session.page)
    await assertWriter(session.page)
    await openPlot(session.page)
    await session.page.getByText('还没有剧情树', { exact: true }).waitFor({ state: 'visible' })
    await showThreads(session.page)
    await threadItem(session.page, updatedTitle).getByText('第 1 章 · 已埋设 · 旧站来信', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await threadItem(session.page, deletedTitle).count(), 0)
    steps.push({ stepId: 'writer-narrative-plan-restart', relatedActionId: 'U15.A07', coverage: 'persisted-plan-reopen',
      assertion: 'A fresh packaged Electron session reopened the author thread and its event through the stage UI' })
  } catch (error) {
    failure = error
    fs.mkdirSync(receiptDir, { recursive: true })
    await app?.windows()[0]?.screenshot({ path: path.join(receiptDir, 'failure.png') }).catch(() => {})
  }
  failure = providerFailure ?? failure
  const cleanupErrors = []
  if (app) try { await quit() } catch (error) { cleanupErrors.push(error) }
  if (provider.listening) try { await new Promise(resolve => provider.close(resolve)) } catch (error) { cleanupErrors.push(error) }
  try {
    const relativeScratch = path.relative(fs.realpathSync(scratchBase), fs.realpathSync(scratch))
    assert(relativeScratch && !relativeScratch.startsWith('..') && !path.isAbsolute(relativeScratch),
      'U15 scratch escaped its owner base')
    assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, '.vibe-owner.json'), 'utf8')).owner, 'codex/f05-u15')
    fs.rmSync(scratch, { recursive: true, force: true })
  } catch (error) { cleanupErrors.push(error) }
  if (cleanupErrors.length) failure = new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'U15 cleanup failed')
  assert.equal(sha256(driverPath), driverSha256, 'U15 driver changed during run')
  assert.equal(sha256(executablePath), expectedExe, 'Executable changed during run')
  assert.equal(sha256(asarPath), expectedAsar, 'ASAR changed during run')
  assert.equal(git('rev-parse', 'HEAD'), executionHead, 'HEAD changed during run')
  const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U15_A06_A07_PACKAGED_V3_SLICE',
    fullActionQualification: false, testedSha, executionHead, changedPaths, driverSha256,
    packageReuseReason: 'Fixed package hashes match and product inputs are unchanged since the build SHA.',
    packageDir,
    artifact: { executableSha256: sha256(executablePath), asarSha256: sha256(asarPath) },
    evidenceLevel: 'packaged-electron+controlled-provider', shell: 'stage',
    fixtureProviderRequests: providerRequests, generationFailureEvidence, candidateRejectionEvidence, eventEvidenceFailure,
    networkInterception: 'main-process fetch for https://api.openai.com only',
    steps: steps.map(step => ({ ...step, outcome: 'PASS' })),
    remainingGaps: ['U15.A06: real provider not exercised',
      'U15.A07: real provider not exercised'],
    failedPhase: failure ? phase : null, error: failure ? String(failure) : null }
  fs.mkdirSync(receiptDir, { recursive: true })
  fs.writeFileSync(path.join(receiptDir, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u15',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${receiptDir.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const receiptPath = path.join(receiptDir, 'receipt.json')
  const candidate = path.join(receiptDir, '.receipt-candidate.json')
  fs.writeFileSync(candidate, JSON.stringify(receipt, null, 2))
  fs.renameSync(candidate, receiptPath)
  process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, testedSha, steps: steps.map(step => step.stepId), receipt: path.relative(repository, receiptPath) })}\n`)
  if (failure) throw failure
}

main().catch(error => { console.error(error); process.exitCode = 1 })
