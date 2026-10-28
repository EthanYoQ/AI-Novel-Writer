/* global process, Buffer */
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
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'
import * as arch from './redesign/pages/architecture.mjs'
import * as blueprint from './redesign/pages/blueprint.mjs'
import * as refs from './redesign/pages/refs.mjs'
import * as runSheet from './redesign/pages/run-sheet.mjs'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageArgs = ['package-dir', 'package-source-sha', 'exe-sha256', 'asar-sha256'].map(argument)
assert(packageArgs.every(Boolean), 'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const packageDir = path.resolve(repository, packageArgs[0])
const executablePath = resolveWindowsExecutable(packageDir)
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const [, packageSourceSha, expectedExeSha, expectedAsarSha] = packageArgs
assert(/^[a-f0-9]{40}$/.test(packageSourceSha) && [expectedExeSha, expectedAsarSha].every(value => /^[a-f0-9]{64}$/.test(value)), 'invalid package source or artifact SHA')
const Database = createRequire(import.meta.url)('better-sqlite3')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = file => sha256(fs.readFileSync(file))
const scriptPath = fileURLToPath(import.meta.url)
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const testedSha = packageSourceSha
const immersionOnly = process.argv.includes('--immersion-only')
const columnsOnly = process.argv.includes('--columns-only')
const livenessOnly = process.argv.includes('--liveness-only')
assert([immersionOnly, columnsOnly, livenessOnly].filter(Boolean).length <= 1, 'journey modes are mutually exclusive')
const productPathArgs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
const changedPaths = git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean)
const readProjectCore = projectPath => {
  const database = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
  try {
    const row = database.prepare("SELECT * FROM project_core WHERE id='main'").get()
    assert(row, 'project_core main row is missing')
    return JSON.stringify(row)
  } finally { database.close() }
}
const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u07-dirty-tabs', runId)
const scratch = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository), 'VibeCodingScratch', 'an', 'u7d', runId.slice(0, 6))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects'].map(name => [name, path.join(scratch, name)]))
const projectName = 'U07-dirty-tabs'
const steps = []
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, outcome: 'PASS', assertion })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
/** generation:list 只给身份与状态；要候选、账本时按 handle 逐个读完整视图。 */
const listRunViews = async (page, context) => Promise.all((await invoke(page, 'generation:list', context)).map(run => invoke(page, 'generation:read', run.handle, context)))
/** 内容区标签：只有两个以上标签时才显示标签条。 */
const tab = (page, name) => stage.tabList(page).getByRole('tab', { name, exact: true })
const assertActiveTab = async (page, name, actionId) => {
  await tab(page, name).waitFor({ state: 'visible' })
  assert.equal(await tab(page, name).getAttribute('aria-selected'), 'true', `${actionId}: ${name} tab is not active`)
}
/** 流程脊上当前这一步（aria-current="page"）。 */
const spineCurrent = page => stage.spine(page).locator('[aria-current="page"]')
const candidateBody = `U07 失败后保留的合成正文 ${runId}。`.repeat(8)
const runningBody = `U07 运行中可见的合成正文 ${runId}`
const shortOutline = '- 原目标：验证面板切换。\n- 结尾状态：正文仍在生成。'
const model = { id: 'u07-liveness-fixture', name: 'U07 liveness fixture', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'u07-offline',
  maxTokens: 8192, temperature: 0.7, purposes: ['generation'] }
// 写稿先要一份短细纲（只写短细纲）再写正文：细纲照常回复并另计；requests 只数正文请求。
// 第 1 次正文只发可见文字、不发 [DONE]，留下持久候选；第 2 次挂住不结束，作为运行中的任务。
const fixture = { requests: 0, outlines: 0 }
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
    || request.headers.authorization !== `Bearer ${model.apiKey}`) { response.writeHead(403).end(); return }
  let raw = ''
  for await (const chunk of request) raw += chunk
  const prompt = (JSON.parse(raw).messages ?? []).map(message => String(message.content)).join('\n')
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (prompt.includes('只写短细纲')) {
    fixture.outlines++
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: shortOutline }, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n')
    return
  }
  fixture.requests++
  if (fixture.requests > 2) { response.end(); return }
  const body = fixture.requests === 1 ? candidateBody : runningBody
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: body } }] })}\n\n`)
  if (fixture.requests === 1) response.end()
})
const assertStage = async (page, actionId) => {
  await stage.waitForStage(page)
  assert.equal(await stage.root(page).getAttribute('data-shell-presentation'), 'stage', `${actionId}: current shell is not the paper-ink stage`)
}
const waitHome = async page => {
  await assertStage(page, 'U07.home')
  await stage.dismissMigrationNotice(page)
  await stage.showLibrary(page)
}
const openWork = async page => {
  await waitHome(page)
  await stage.openFromLibrary(page, projectName)
  await stage.waitForWork(page, projectName)
}
/** 蓝图页的「写第 1 章」：按蓝图直接开始写，运行侧页随之展开。 */
const startChapter = async page => {
  await blueprint.open(page)
  await blueprint.writeButton(page).click()
}
/** 标签条至少两个标签（架构、设定），落在设定。 */
const ensureTwoTabs = async page => {
  await arch.open(page)
  await stage.stageButton(page, '设定').click()
  await stage.setupOutline(page).waitFor({ state: 'visible' })
  await stage.tabList(page).waitFor({ state: 'visible' })
}
const runningSession = (projectPath, projectId) => {
  const database = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
  try {
    const rows = database.prepare("SELECT run_id, binding_json FROM generation_runs WHERE status='running' ORDER BY created_at_ms DESC").all()
    const row = rows.find(value => { const binding = JSON.parse(value.binding_json); return binding.projectId === projectId && binding.sourceManifest?.operation === 'chapter-draft' })
    assert(row, 'running chapter-draft binding is missing')
    const binding = JSON.parse(row.binding_json)
    assert(binding.epoch, 'running chapter-draft binding has no project lease')
    return { session: { projectId, projectPath, leaseId: binding.epoch }, runId: row.run_id }
  } finally { database.close() }
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U07 dirty tabs', sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'review packaged stage dirty-tab receipt', cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app
  let page
  let failure
  let cleanupError = null
  let appClosed = false
  let currentStep = 'setup'
  let projectCreateObservation = null
  let projectCoreBefore = null
  let projectCoreAfter = null
  let uiObservation = null
  let livenessObservation = null
  const visualEvidence = []
  const captureVisual = async (page, name, target) => {
    const file = path.join(receiptDir, `stage-${name}-1440x900.png`)
    const png = await page.screenshot({ path: file })
    const windowMetrics = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { windowSize: window.getSize(), contentSize: window.getContentSize(), zoomFactor: window.webContents.getZoomFactor() }
    })
    const rendering = await page.locator(target).evaluate(element => ({
      viewport: [window.innerWidth, window.innerHeight],
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      targetFontFamily: getComputedStyle(element).fontFamily,
    }))
    const evidence = { name, path: file, sha256: fileHash(file), pixels: [png.readUInt32BE(16), png.readUInt32BE(20)], ...windowMetrics, ...rendering }
    assert.deepEqual(evidence.pixels, [1440, 900])
    assert.deepEqual(evidence.contentSize, [1440, 900])
    assert.deepEqual(evidence.viewport, [1440, 900])
    assert.equal(evidence.zoomFactor, 1)
    visualEvidence.push(evidence)
    pass(`U07.A01-${name}-visual`, 'U07.A01', `Fresh-profile stage ${name} screenshot: ${evidence.sha256}, 1440×900, zoom=1, font=${evidence.targetFontFamily}`)
  }
  const marker = `U07 dirty tab ${runId}`
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  try {
    currentStep = 'packaged-native-load'
    assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productPathArgs), '', 'product source changed since fixed package SHA')
    const dirtyProductPaths = git('status', '--porcelain', '--', ...productPathArgs).split('\n').filter(Boolean)
    assert(dirtyProductPaths.every(line => /^\?\? src\/.*\/__tests__\/__screenshots__\/$/.test(line)), 'product source dirty beyond test screenshots')
    assert.equal(fileHash(executablePath), expectedExeSha)
    assert.equal(fileHash(asarPath), expectedAsarSha)
    const verified = verifyWindowsPackage(packageDir)
    assert(verified.nativeBinding && verified.betterSqliteBinding)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    pass('packaged-native-load', null, 'fixed package artifact hashes and packaged native bindings verified')
    if (livenessOnly) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
    if (livenessOnly) await app.evaluate((_, fixturePort) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, options) => {
        const url = new URL(String(input))
        if (url.origin !== 'https://api.openai.com') throw new Error('U07_NETWORK_REFUSED')
        return originalFetch(`http://127.0.0.1:${fixturePort}${url.pathname}`, options)
      }
    }, server.address().port)
    page = await app.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(12_000)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    await stage.waitForStage(page)
    if (columnsOnly) await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1440, 900)
      window.webContents.setZoomFactor(1)
    })

    currentStep = 'fixture-project'
    const project = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, profile.projects)).grantId, name: projectName, genre: 'fixture', targetAudience: 'fixture', writingLanguage: 'zh-CN' }, randomUUID(), null)
    projectCreateObservation = { success: project.success, stale: project.stale ?? 'absent', error: project.error ?? null, projectPath: project.projectPath ?? null }
    assert.equal(project.success, true, JSON.stringify(projectCreateObservation))
    projectCoreBefore = readProjectCore(project.projectPath)
    if (livenessOnly) {
      const opened = await invoke(page, 'project:open', project.projectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const session = { projectId: project.projectId, projectPath: project.projectPath, leaseId: opened.project.sessionLease }
      const roster = await invoke(page, 'db:character-roster-read', project.projectPath, session)
      assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
        expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries: [{ characterId: `draft:${randomUUID()}`,
          name: '林岚', role: 'protagonist', gender: '', age: '', appearance: '', personality: '', background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }] }, project.projectPath, session)).success, true)
      assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: 'U07 保全章节', role: '发展', purpose: '验证面板切换', keyEvents: '保留正文', characters: [] }, project.projectPath, session)).success, true)
      assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
      assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
    }
    await page.reload()
    await waitHome(page)
    if (columnsOnly) {
      currentStep = 'U07.A01-library-visual'
      await captureVisual(page, 'library', '.stage-library')
    }
    await openWork(page)

    if (livenessOnly) {
      currentStep = 'U07-liveness-candidate'
      await startChapter(page)
      await runSheet.sheet(page).getByText('工作流未完成').first().waitFor({ state: 'visible', timeout: 30_000 })
      assert.equal(fixture.requests, 1, 'first prose request must end without [DONE]')
      await page.reload()
      await openWork(page)
      // 运行侧页用「运行侧页」命令打开；它已开着时不再点，不会把它关掉（#381 C2）。
      await runSheet.openFromPalette(page)
      await runSheet.recovery(page).getByText(candidateBody.slice(0, 60)).first().waitFor({ state: 'visible' })
      await startChapter(page)
      await runSheet.waitUntilOpen(page)
      await runSheet.sheet(page).getByRole('button', { name: /^取消「/ }).first().waitFor({ state: 'visible', timeout: 30_000 })
      await runSheet.sheet(page).getByText(runningBody).first().waitFor({ state: 'visible', timeout: 30_000 })
      assert.equal(fixture.requests, 2, 'second prose request must remain open')
      const { session, runId: ledgerRunId } = runningSession(project.projectPath, project.projectId)
      const runs = await listRunViews(page, session)
      const candidateRun = runs.find(item => item.candidates?.some(artifact => artifact.text === candidateBody))
      const candidate = candidateRun?.candidates?.find(artifact => artifact.text === candidateBody)
      assert(candidateRun && candidate, 'main-owned durable visible-text candidate missing')
      assert.equal(candidateRun.handle.projectId, project.projectId)
      assert.equal(candidate.textHash, sha256(candidateBody), 'durable artifact text hash differs from provider body')
      const running = runs.filter(item => item.status === 'running' && item.operation === 'chapter-draft')
      assert.equal(running.length, 1, 'exactly one chapter-draft task must be running')
      const task = running[0]
      assert.equal(task.handle.runId, ledgerRunId, 'generation:list must identify the same running ledger row used to read the lease')
      assert.equal(task.handle.projectId, project.projectId)
      assert.equal(task.handle.epoch, session.leaseId)
      assert.notEqual(task.handle.runId, candidateRun.handle.runId)
      assert(task.handle.rootActionId && task.handle.runId)
      livenessObservation = { sessionSource: 'running generation_runs.binding_json.epoch, confirmed by generation:list authorization and run_id',
        candidateKind: 'main-owned durable visible-text artifact, not a legacy recovery_candidates row',
        task: { ...task.handle, status: task.status }, durableCandidate: { ...candidateRun.handle, runStatus: candidateRun.status,
          artifactId: candidate.artifactId, artifactStatus: candidate.status, visibleText: candidate.text, textHash: candidate.textHash },
        providerRequests: fixture.requests, shortOutlines: fixture.outlines }
      const assertLiveness = async label => {
        assert.equal(fixture.requests, 2, `${label}: unexpected provider request`)
        const context = await invoke(page, 'project:get-runtime-context')
        assert.equal(path.resolve(context.activeProjectPath), path.resolve(project.projectPath), `${label}: active project changed`)
        assert.equal(context.dbReady, true)
        const currentRuns = await listRunViews(page, session)
        const listed = currentRuns.find(item => item.handle.runId === task.handle.runId)
        assert.deepEqual({ ...listed?.handle, status: listed?.status }, livenessObservation.task, `${label}: running task identity/status changed`)
        const recoveredRun = currentRuns.find(item => item.handle.runId === candidateRun.handle.runId)
        const recovered = recoveredRun?.candidates?.find(artifact => artifact.artifactId === candidate.artifactId)
        assert.deepEqual(recovered && { ...recoveredRun.handle, runStatus: recoveredRun.status,
          artifactId: recovered.artifactId, artifactStatus: recovered.status, visibleText: recovered.text,
          textHash: recovered.textHash }, livenessObservation.durableCandidate, `${label}: durable candidate changed`)
      }
      await assertLiveness('before layout switching')
      pass('U07-liveness-precondition', null, 'One real running main-generation task and one prior main-owned durable visible-text artifact share the active project')
      livenessObservation.assert = assertLiveness
    }

    if (!immersionOnly && !columnsOnly && !livenessOnly) {
    currentStep = 'U07.A02-dirty-indicator'
    await assertStage(page, 'U07.A02')
    await ensureTwoTabs(page)
    const field = stage.setupOutline(page)
    await field.fill(marker)
    assert.equal(await field.inputValue(), marker)
    assert.equal(readProjectCore(project.projectPath), projectCoreBefore, 'unsaved config edit must not change the SQLite project_core snapshot')
    await stage.saveStatus(page).filter({ hasText: /^未保存$/ }).waitFor({ state: 'visible' })
    const dirtyClose = stage.tabList(page).getByRole('button', { name: '关闭「设定」，有未保存的修改', exact: true })
    await dirtyClose.waitFor({ state: 'visible' })
    assert.equal(await stage.tabList(page).locator('.stage-tab[data-dirty]').count(), 1, 'only the setup tab should be marked dirty')
    pass('U07.A02-dirty-indicator', 'U07.A02', 'A setup edit shows 未保存 in the top bar and the dirty close affordance on the 设定 tab; SQLite project_core keeps its original snapshot')

    currentStep = 'U07.A03-cancel-close'
    await assertStage(page, 'U07.A03')
    const confirm = page.getByRole('dialog', { name: '放弃未保存的修改？' })
    await dirtyClose.click()
    await confirm.waitFor({ state: 'visible' })
    await confirm.getByText('「设定」有未保存的修改，关闭后这些修改会丢失。').waitFor({ state: 'visible' })
    await confirm.getByRole('button', { name: '继续编辑', exact: true }).click()
    await confirm.waitFor({ state: 'detached' })
    assert.equal(await field.inputValue(), marker)
    assert.equal(readProjectCore(project.projectPath), projectCoreBefore, 'canceling close must leave the SQLite project_core snapshot unchanged')
    await dirtyClose.waitFor({ state: 'visible' })
    pass('U07.A03-cancel-close', 'U07.A03', '继续编辑 in the discard confirmation keeps the dirty 设定 tab and edited value without changing SQLite project_core')

    currentStep = 'U07.A03-discard-close'
    await assertStage(page, 'U07.A03')
    await dirtyClose.click()
    await confirm.waitFor({ state: 'visible' })
    await confirm.getByRole('button', { name: '放弃并关闭', exact: true }).click()
    await confirm.waitFor({ state: 'detached' })
    await dirtyClose.waitFor({ state: 'detached' })
    await stage.stageButton(page, '设定').click()
    await field.waitFor({ state: 'visible' })
    assert.notEqual(await field.inputValue(), marker, 'discarded config draft must not reappear when the tab is reopened')
    projectCoreAfter = readProjectCore(project.projectPath)
    assert.equal(projectCoreAfter, projectCoreBefore, 'discarding close must preserve the original SQLite project_core snapshot')
    pass('U07.A03-discard-close', 'U07.A03', '放弃并关闭 closes the dirty 设定 tab, the draft does not reappear on reopen, and SQLite project_core keeps its original snapshot')

    currentStep = 'U07.A04-tab-prev-next'
    await assertStage(page, 'U07.A04')
    await blueprint.open(page)
    uiObservation = { action: 'U07.A04', tabLabels: await stage.tabList(page).getByRole('tab').allInnerTexts() }
    assert.deepEqual(uiObservation.tabLabels, ['架构', '设定', '蓝图'])
    // 旧外壳标签条的「上一个 / 下一个编辑器」在纸墨外壳是标签条上的 ← →。
    await tab(page, '设定').click()
    await assertActiveTab(page, '设定', 'U07.A04.start')
    await page.keyboard.press('ArrowLeft')
    await assertActiveTab(page, '架构', 'U07.A04.previous')
    await arch.page(page).waitFor({ state: 'visible' })
    await page.keyboard.press('ArrowRight')
    await assertActiveTab(page, '设定', 'U07.A04.next')
    await field.waitFor({ state: 'visible' })
    await page.keyboard.press('ArrowRight')
    await assertActiveTab(page, '蓝图', 'U07.A04.next-again')
    pass('U07.A04-tab-prev-next', 'U07.A04', '← and → on the focused tab move to the previous and next open page (架构 / 设定 / 蓝图) and show that page')

    currentStep = 'U07.A05-open-tab-list'
    await assertStage(page, 'U07.A05')
    await stage.root(page).getByRole('button', { name: '标签操作', exact: true }).click()
    const openPages = page.getByRole('menu', { name: '标签操作' }).getByRole('group', { name: '已打开的页面' })
    assert.deepEqual(await openPages.getByRole('menuitem').allInnerTexts(), ['架构', '设定', '蓝图（当前）'])
    await openPages.getByRole('menuitem', { name: '设定', exact: true }).click()
    await assertActiveTab(page, '设定', 'U07.A05')
    await field.waitFor({ state: 'visible' })
    pass('U07.A05-open-tab-list', 'U07.A05', 'The 标签操作 menu lists every open page under 已打开的页面 and choosing 设定 returns to its page')

    currentStep = 'U07.A06-spine-tab-sync'
    await assertStage(page, 'U07.A06')
    await tab(page, '蓝图').click()
    await assertActiveTab(page, '蓝图', 'U07.A06.blueprint')
    assert.equal(await spineCurrent(page).getAttribute('data-stage'), 'blueprint', 'U07.A06: the spine does not mark 蓝图 for the blueprint tab')
    await tab(page, '设定').click()
    await assertActiveTab(page, '设定', 'U07.A06.setup')
    assert.equal(await spineCurrent(page).getAttribute('data-stage'), 'setup', 'U07.A06: the spine does not mark 设定 for the setup tab')
    pass('U07.A06-spine-tab-sync', 'U07.A06', 'Selecting the 蓝图 and 设定 tabs moves the spine’s current step with them')
    }

    if (!columnsOnly) {
    currentStep = 'U07.A07-enter-exit-focus'
    await assertStage(page, 'U07.A07')
    await ensureTwoTabs(page)
    await runSheet.openFromPalette(page)
    const root = stage.root(page)
    const spine = stage.spine(page)
    const tabs = stage.tabList(page)
    const sheet = runSheet.sheet(page)
    for (const part of [spine, tabs, sheet]) await part.waitFor({ state: 'visible' })
    if (livenessOnly) await livenessObservation.assert('before focus')
    await stage.root(page).getByRole('button', { name: '进入沉浸写作', exact: true }).click()
    assert.equal(await root.getAttribute('data-focus'), 'true')
    for (const part of [spine, tabs, sheet]) await part.waitFor({ state: 'hidden' })
    if (livenessOnly) await livenessObservation.assert('inside focus')
    await page.getByRole('button', { name: '退出沉浸写作', exact: true }).click()
    assert.equal(await root.getAttribute('data-focus'), null)
    for (const part of [spine, tabs, sheet]) await part.waitFor({ state: 'visible' })
    if (livenessOnly) await livenessObservation.assert('after focus')
    pass('U07.A07-enter-exit-focus', 'U07.A07', 'The top bar enters focus mode, hiding the spine, the tab bar and the run sheet, and exits with all three restored')

    currentStep = 'U07.A08-open-run-sheet-exits-focus'
    await stage.root(page).getByRole('button', { name: '进入沉浸写作', exact: true }).click()
    assert.equal(await root.getAttribute('data-focus'), 'true')
    await sheet.waitFor({ state: 'hidden' })
    if (livenessOnly) await livenessObservation.assert('before the run sheet opens')
    await runSheet.openFromPalette(page)
    assert.equal(await root.getAttribute('data-focus'), null)
    await sheet.waitFor({ state: 'visible' })
    if (livenessOnly) {
      await livenessObservation.assert('after the run sheet opens')
      await runSheet.tab(page, '进行中').click()
      await sheet.getByRole('button', { name: /^取消「/ }).first().waitFor({ state: 'visible' })
      await runSheet.recovery(page).getByText(candidateBody.slice(0, 60)).first().waitFor({ state: 'visible' })
      await sheet.getByText(runningBody).first().waitFor({ state: 'visible' })
      await livenessObservation.assert('in the run sheet')
      pass('U07-liveness-panel-switch', 'U07.A08', 'Focus mode and the run sheet kept the same running task, main-owned durable candidate and visible text')
    }
    pass('U07.A08-open-run-sheet-exits-focus', 'U07.A08', 'Opening the run sheet from the command palette leaves focus mode and shows the run sheet')
    }

    if (columnsOnly) {
      /** 点流程脊上的一项，等它成为当前一步，读内容区的第一个标题作为看得见的落点（空页面是空状态的标题）。 */
      const contentHeading = () => stage.root(page).locator('.stage-content').getByRole('heading').first()
      const visit = async (id, button, current, owner) => {
        currentStep = `U07.A01-${id}`
        await button.click()
        await owner.waitFor({ state: 'visible' })
        if (current) await spineCurrent(page).filter({ hasText: current }).waitFor({ state: 'visible' })
        const heading = (await contentHeading().innerText().catch(() => '')).trim()
        pass(currentStep, 'U07.A01', `Clicked ${id}; visible result: ${heading || await owner.evaluate(element => element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 80))}`)
      }
      const blueprintOwner = blueprint.plan(page).or(blueprint.emptyHeading(page))
      await visit('setup', stage.stageButton(page, '设定'), '设定', stage.setupOutline(page))
      await visit('architecture', stage.stageButton(page, '架构'), '架构', arch.page(page))
      currentStep = 'U07.A01-architecture-visual'
      await arch.waitReady(page)
      await captureVisual(page, 'architecture', '.arch-page')
      await visit('cast', arch.section(page, 'characters').getByRole('button', { name: '打开角色名单' }), null, arch.castRoster(page))
      await visit('blueprint', stage.stageButton(page, '蓝图'), '蓝图', blueprintOwner)
      // 还没有章节时「正文」落到蓝图页（先规划章节）。
      await visit('manuscript', stage.stageButton(page, '正文'), '蓝图', blueprintOwner)
      for (const [id, name] of Object.entries(refs.PAGES)) {
        await visit(id, refs.resourceButton(page, id), name, contentHeading())
        await assertActiveTab(page, name, `U07.A01.${id}`)
      }
      await visit('settings', stage.spine(page).getByRole('button', { name: '设置', exact: true }), '设置', stage.settingsNav(page))
      await stage.closeSettings(page)
      currentStep = 'U07.A01-run-sheet'
      await runSheet.openFromPalette(page)
      await runSheet.sheet(page).waitFor({ state: 'visible' })
      pass(currentStep, 'U07.A01', 'Opened 运行侧页 from the command palette; the run sheet is visible')
      pass('U07.A01-all-columns', 'U07.A01', 'Every stage spine entry (4 steps, 3 reference pages, settings), the cast and the run sheet reached their visible owner; 正文 lands on 蓝图 before any chapter exists')
    }
  } catch (error) {
    failure = error
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(receiptDir, 'failure.png') }).catch(() => {})
  }
  finally {
    // 挂住的 SSE 让工作流一直在跑；关窗守卫会正确拒绝退出，先断开它，等运行侧页里这次运行结束。
    server.closeAllConnections()
    try {
      if (livenessOnly && fixture.requests === 2 && page && !page.isClosed()) {
        if (await stage.root(page).getAttribute('data-focus') === 'true') await page.getByRole('button', { name: '退出沉浸写作', exact: true }).click()
        await runSheet.openFromPalette(page)
        await runSheet.tab(page, '进行中').click()
        await runSheet.sheet(page).getByRole('button', { name: /^取消「/ }).first().waitFor({ state: 'detached', timeout: 30_000 })
      }
    } catch (error) {
      cleanupError = String(error)
      failure ??= error
    }
    try { await app?.close(); appClosed = Boolean(app) }
    catch (error) { cleanupError ??= String(error); failure ??= error }
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
  const artifactHashes = { executable: fileHash(executablePath), asar: fileHash(asarPath) }
  const verifiedActions = [...new Set(steps.map(step => step.actionId).filter(Boolean))].filter(id => id !== 'U07.A01' || steps.some(step => step.stepId === 'U07.A01-all-columns'))
  const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U07_V3_PARTIAL', evidenceLevel: 'electron', shell: 'stage', testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths, packageRoot: packageDir, artifactHashes, driver: { path: scriptPath, sha256: fileHash(scriptPath) }, sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean), dirtyProductPaths: git('status', '--porcelain', '--', ...productPathArgs).split('\n').filter(Boolean), profile: { canonical: profile.canonical, userData: profile.userData, projectRoot: profile.projects }, fixture: livenessOnly ? { provider: 'loopback synthetic OpenAI SSE', requests: fixture.requests, shortOutlines: fixture.outlines, externalModelRequests: 0 } : null, steps, visualEvidence, projectCreateObservation, projectCore: { table: 'project_core', key: "id='main'", originalSha256: projectCoreBefore ? sha256(Buffer.from(projectCoreBefore)) : null, afterDiscardSha256: projectCoreAfter ? sha256(Buffer.from(projectCoreAfter)) : null, unchanged: Boolean(projectCoreBefore && projectCoreAfter && projectCoreBefore === projectCoreAfter) }, uiObservation, livenessObservation: livenessObservation && { sessionSource: livenessObservation.sessionSource, candidateKind: livenessObservation.candidateKind, task: livenessObservation.task, durableCandidate: livenessObservation.durableCandidate, providerRequests: livenessObservation.providerRequests, shortOutlines: livenessObservation.shortOutlines }, cleanup: { appClosed, error: cleanupError }, scope: { mode: columnsOnly ? 'columns-only' : immersionOnly ? 'immersion-only' : livenessOnly ? 'liveness-only' : 'full', verifiedActions, unverifiedActions: ['U07.A01', 'U07.A02', 'U07.A03', 'U07.A04', 'U07.A05', 'U07.A06', 'U07.A07', 'U07.A08'].filter(id => !verifiedActions.includes(id)).concat('full F05 and release qualification') }, failedStep: failure ? currentStep : null, error: failure ? String(failure) : null }
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
