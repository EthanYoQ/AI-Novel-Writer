/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

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
const executablePath = path.join(packageDir, 'AI小说作家.exe')
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
const provider = createServer(async (request, response) => {
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
})
const steps = []
let phase = 'setup'
let app

const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const writer = page => page.locator('.writer-shell[data-shell-presentation="writer"][data-shell-variant="v3"]')
async function assertWriter(page) {
  await writer(page).waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal(await writer(page).getAttribute('data-shell-presentation'), 'writer', `${phase}: not Writer`)
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
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { opened, page }
  } catch (error) { await opened.close(); throw error }
}
async function selectWriter(page) {
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const previous = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...previous, shellPreference: 'writer',
      revision: Number(previous.revision ?? 0) + 1, origin: 'author' }))
  })
  await page.reload()
  await assertWriter(page)
}
async function openProject(page) {
  await assertWriter(page)
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await page.locator('.writer-left-rail button[title="欢迎页"]').click()
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
  await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
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
    await selectWriter(session.page)
    const created = await invoke(session.page, 'project:create', { path: profile.projects, name: projectName,
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
    const blueprint = await invoke(session.page, 'db:blueprint-upsert', { chapterNumber: 1, title: '旧站来信',
      role: '发展', purpose: '调查来信来源', keyEvents: '发现铜钥匙', characters: [] }, created.projectPath, fixtureSession)
    assert.equal(blueprint.success, true, blueprint.error)
    assert.equal((await invoke(session.page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(session.page, 'llm:set-default-model', model.id)).success, true)
    await session.page.reload()
    await openProject(session.page)

    phase = 'writer-plot-tree'
    await assertWriter(session.page)
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    const views = session.page.getByRole('tablist', { name: '剧情编辑器视图' })
    await views.getByRole('tab', { name: '剧情树' }).waitFor({ state: 'visible' })
    assert.equal(await views.getByRole('tab', { name: '剧情树' }).getAttribute('aria-selected'), 'true')
    await session.page.getByText('尚未生成剧情树', { exact: true }).waitFor({ state: 'visible' })
    steps.push({ stepId: 'writer-plot-tree-entry', relatedActionId: 'U15.A06', coverage: 'empty-tree-entry-only',
      assertion: 'Writer rail opened the real plot tree view and rendered its empty state' })

    phase = 'writer-narrative-plan'
    await assertWriter(session.page)
    await views.getByRole('tab', { name: '计划清单' }).click()
    assert.equal(await views.getByRole('tab', { name: '计划清单' }).getAttribute('aria-selected'), 'true')
    const form = session.page.getByText('新建计划', { exact: true }).locator('xpath=..').locator('xpath=..')
    await form.getByText('标题', { exact: true }).locator('xpath=..').locator('input').fill(planTitle)
    await form.getByText('类型', { exact: true }).locator('xpath=..').locator('input').fill('伏笔')
    await form.getByText('作者意图 / 理由', { exact: true }).locator('xpath=..').locator('textarea').fill('在第三章回收旧站来信的来源。')
    await form.getByRole('button', { name: '保存计划' }).click()
    await session.page.getByRole('heading', { name: planTitle }).waitFor({ state: 'visible' })
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
      assertion: 'Writer plan form saved through production UI; a fresh main project session listed its durable plan fields' })

    phase = 'v3-plot-generate'
    await openProject(session.page)
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
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
      assertion: 'V3 generated a source-backed tree through controlled model request and persisted its selected result' })
    await openProject(session.page)

    phase = 'v3-plot-source-navigation'
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await session.page.getByText('旧站主线-1', { exact: true }).waitFor({ state: 'visible' })
    await session.page.getByRole('button', { name: /旧站线索-1/u }).click()
    await session.page.getByRole('button', { name: `叙事计划 #${sourcePlanId}` }).click()
    assert.equal(await views.getByRole('tab', { name: '计划清单' }).getAttribute('aria-selected'), 'true')
    const planSection = session.page.locator(`#narrative-plan-${sourcePlanId}`)
    await planSection.getByRole('heading', { name: planTitle }).waitFor({ state: 'visible' })
    steps.push({ stepId: 'v3-plot-open-source', relatedActionId: 'U15.A06', coverage: 'event-source-navigation',
      assertion: 'V3 tree event opened its persisted narrative-plan source in the plan view' })

    phase = 'v3-plot-blueprint-source-navigation'
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await session.page.getByRole('button', { name: '蓝图线索-1' }).click()
    await session.page.getByRole('button', { name: '第 1 章蓝图' }).click()
    await session.page.getByRole('heading', { name: '第 1 章：旧站来信' }).waitFor({ state: 'visible' })
    assert.equal(await session.page.getByPlaceholder('本章主角最迫切要解决的一件事...').inputValue(), '调查来信来源')
    steps.push({ stepId: 'v3-plot-open-blueprint-source', relatedActionId: 'U15.A06',
      coverage: 'existing-blueprint-event-source-navigation',
      assertion: 'V3 tree event opened the existing chapter 1 blueprint and displayed its persisted purpose' })

    phase = 'v3-plot-finalized-source-navigation'
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await session.page.getByRole('button', { name: '定稿线索-1' }).click()
    await session.page.getByRole('button', { name: '第 1 章定稿' }).click()
    await session.page.getByText('已定稿（只读）', { exact: true }).waitFor({ state: 'visible' })
    await session.page.getByText(finalizedText, { exact: true }).waitFor({ state: 'visible' })
    steps.push({ stepId: 'v3-plot-open-finalized-source', relatedActionId: 'U15.A06',
      coverage: 'existing-finalized-event-source-navigation',
      assertion: 'V3 tree event opened the existing finalized chapter 1 as read-only with its persisted body' })

    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await views.getByRole('tab', { name: '计划清单' }).click()

    phase = 'v3-narrative-plan-update'
    await planSection.getByRole('button', { name: '编辑', exact: true }).click()
    const editForm = session.page.getByText('编辑计划', { exact: true }).locator('xpath=..').locator('xpath=..')
    await editForm.getByText('标题', { exact: true }).locator('xpath=..').locator('input').fill(updatedTitle)
    await editForm.getByText('作者意图 / 理由', { exact: true }).locator('xpath=..').locator('textarea')
      .fill('在第一章确认旧站来信并延伸铜钥匙线索。')
    await editForm.getByRole('button', { name: '保存计划' }).click()
    await planSection.getByRole('heading', { name: updatedTitle }).waitFor({ state: 'visible' })
    steps.push({ stepId: 'v3-narrative-plan-update', relatedActionId: 'U15.A07', coverage: 'ui-plan-update',
      assertion: 'V3 plan edit updated the persisted source identity shown in the plan list' })

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
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await views.getByRole('tab', { name: '计划清单' }).click()
    const eventPlanSection = session.page.locator(`#narrative-plan-${sourcePlanId}`)
    await eventPlanSection.getByRole('heading', { name: updatedTitle }).waitFor({ state: 'visible' })
    await eventPlanSection.getByRole('button', { name: '确认定稿事件' }).click()
    const eventDraftSelect = eventPlanSection.locator('select').first()
    const selectedFinalizedDraft = await eventDraftSelect.inputValue()
    assert(selectedFinalizedDraft, 'event form did not select a finalized chapter')
    await eventDraftSelect.selectOption(selectedFinalizedDraft)
    const invalidEvidence = `不存在的合成证据-${runId.slice(0, 8)}`
    const invalidReason = '用于验证定稿证据拒绝'
    await eventPlanSection.getByPlaceholder('粘贴该定稿章节中的短原文').fill(invalidEvidence)
    await eventPlanSection.getByPlaceholder('确认理由').fill(invalidReason)
    await eventPlanSection.getByRole('button', { name: '保存事件' }).click()
    const evidenceError = eventPlanSection.getByText('请粘贴所选定稿章节中实际出现的短原文。', { exact: true })
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
      assertion: 'V3 rejected synthetic evidence absent from the selected finalized chapter, showed the required error, and left the plan/event read view unchanged' })

    phase = 'v3-narrative-event-confirm'
    await openProject(session.page)
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await views.getByRole('tab', { name: '计划清单' }).click()
    const confirmationSection = session.page.locator(`#narrative-plan-${sourcePlanId}`)
    await confirmationSection.getByRole('heading', { name: updatedTitle }).waitFor({ state: 'visible' })
    await confirmationSection.getByRole('button', { name: '确认定稿事件' }).click()
    await confirmationSection.locator('select').first().selectOption(selectedFinalizedDraft)
    await confirmationSection.getByPlaceholder('粘贴该定稿章节中的短原文').fill('旧站来信')
    await confirmationSection.getByPlaceholder('确认理由').fill('定稿原文明确出现来信')
    await confirmationSection.getByRole('button', { name: '保存事件' }).click()
    await confirmationSection.getByText('第1章 · 已埋设 · 旧站来信', { exact: true }).waitFor({ state: 'visible' })
    steps.push({ stepId: 'v3-narrative-event-confirm', relatedActionId: 'U15.A07', coverage: 'ui-finalized-evidence-confirm',
      assertion: 'V3 confirmed a short quote from the synthetic finalized chapter as a plan event' })

    phase = 'v3-narrative-plan-delete'
    const newForm = session.page.getByText('新建计划', { exact: true }).locator('xpath=..').locator('xpath=..')
    await newForm.getByText('标题', { exact: true }).locator('xpath=..').locator('input').fill(deletedTitle)
    await newForm.getByText('类型', { exact: true }).locator('xpath=..').locator('input').fill('支线')
    await newForm.getByText('作者意图 / 理由', { exact: true }).locator('xpath=..').locator('textarea').fill('只用于验证删除')
    await newForm.getByRole('button', { name: '保存计划' }).click()
    const deletedSection = session.page.locator('section[id^="narrative-plan-"]')
      .filter({ has: session.page.getByRole('heading', { name: deletedTitle }) })
    await deletedSection.getByRole('heading', { name: deletedTitle }).waitFor({ state: 'visible' })
    await deletedSection.getByRole('button', { name: '删除', exact: true }).click()
    await session.page.getByRole('heading', { name: deletedTitle }).waitFor({ state: 'hidden' })
    steps.push({ stepId: 'v3-narrative-plan-delete', relatedActionId: 'U15.A07', coverage: 'ui-plan-delete',
      assertion: 'V3 deleted only the transient synthetic plan and kept the edited plan visible' })

    phase = 'v3-plot-refresh'
    await views.getByRole('tab', { name: '剧情树' }).click()
    await session.page.getByRole('status').filter({ hasText: '剧情资料已有更新' }).waitFor({ state: 'visible' })
    await session.page.getByRole('button', { name: '刷新剧情树', exact: true }).click()
    await session.page.getByText('旧站主线-2', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(providerRequests.length, 2)
    assert.equal(providerRequests[1].sourceTitle, updatedTitle)
    assert.equal(providerRequests[1].sourceEvents, 1)
    steps.push({ stepId: 'v3-plot-refresh', relatedActionId: 'U15.A06', coverage: 'ui-refresh-after-source-update',
      assertion: 'V3 refreshed the stale tree using the updated plan and confirmed finalized event' })

    phase = 'v3-plot-generation-failure'
    const beforeFailureOpen = await invoke(session.page, 'project:open', created.projectPath, randomUUID(), created.projectPath)
    assert.equal(beforeFailureOpen.success, true, beforeFailureOpen.error)
    const beforeFailureSession = { projectId: created.projectId, projectPath: created.projectPath,
      leaseId: beforeFailureOpen.project.sessionLease }
    const beforeFailureTree = await invoke(session.page, 'db:plot-tree-read', created.projectPath, beforeFailureSession)
    assert.equal(beforeFailureTree.snapshot?.tracks[0]?.title, '旧站主线-2')
    await openProject(session.page)
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await session.page.getByText('旧站主线-2', { exact: true }).waitFor({ state: 'visible' })
    failNextRequest = true
    await session.page.getByRole('button', { name: '刷新剧情树', exact: true }).click()
    const generationAlert = session.page.getByRole('alert').filter({ hasText: /剧情树.*失败/u })
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
      assertion: 'V3 surfaced the failed provider request, showed no false success and kept the SQLite-backed plot-tree read view unchanged' })

    phase = 'v3-plot-clear'
    await openProject(session.page)
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await session.page.getByText('旧站主线-2', { exact: true }).waitFor({ state: 'visible' })
    await session.page.getByRole('button', { name: '清除剧情树', exact: true }).click()
    await session.page.getByText('尚未生成剧情树', { exact: true }).waitFor({ state: 'visible' })
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
      assertion: 'V3 cleared the stored tree while retaining the edited plan and its finalized event' })

    phase = 'v3-narrative-candidate-reject'
    await openProject(session.page)
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await views.getByRole('tab', { name: '计划清单' }).click()
    await session.page.getByRole('button', { name: 'AI 建议伏笔与线索' }).click()
    const candidateDialog = session.page.getByRole('dialog', { name: '蓝图计划候选' })
    await candidateDialog.getByRole('button', { name: '生成候选', exact: true }).click()
    const candidateSection = candidateDialog.locator('section').filter({ hasText: candidateTitle })
    await candidateSection.getByText(candidateTitle, { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(providerRequests.length, 4)
    assert.equal(providerRequests[3].kind, 'plan-candidate')
    assert.equal(providerRequests[3].responseStatus, 200)
    await candidateSection.getByRole('button', { name: '拒绝候选' }).click()
    await candidateSection.waitFor({ state: 'hidden' })
    await candidateDialog.locator('div.border-t').getByRole('button', { name: '关闭', exact: true }).click()
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
      assertion: 'V3 rejected a generated blueprint plan candidate without changing the existing author plan or confirmed event' })

    phase = 'restart-persistence'
    await quit()
    session = await launch()
    app = session.opened
    await openProject(session.page)
    await assertWriter(session.page)
    await session.page.locator('.writer-left-rail button[title="剧情树"]').click()
    await session.page.getByText('尚未生成剧情树', { exact: true }).waitFor({ state: 'visible' })
    await session.page.getByRole('tablist', { name: '剧情编辑器视图' }).getByRole('tab', { name: '计划清单' }).click()
    await session.page.getByRole('heading', { name: updatedTitle }).waitFor({ state: 'visible' })
    await session.page.getByText('第1章 · 已埋设 · 旧站来信', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await session.page.getByRole('heading', { name: deletedTitle }).count(), 0)
    steps.push({ stepId: 'writer-narrative-plan-restart', relatedActionId: 'U15.A07', coverage: 'persisted-plan-reopen',
      assertion: 'Fresh packaged Electron session reopened the author plan through Writer UI' })
  } catch (error) { failure = error }
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
    evidenceLevel: 'packaged-electron+controlled-provider', shell: 'writer-v3',
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
