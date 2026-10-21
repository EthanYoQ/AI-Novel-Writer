/* global process */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'
import * as arch from './redesign/pages/architecture.mjs'
import * as runSheet from './redesign/pages/run-sheet.mjs'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = argument('package-dir') && path.resolve(argument('package-dir'))
const packageSourceSha = argument('package-source-sha')
const expectedExe = argument('exe-sha256')
const expectedAsar = argument('asar-sha256')
assert(packageDir && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const a01A04Only = process.argv.includes('--a01-a04-only')
assert(a01A04Only || process.argv.includes('--include-recovery'), 'pass --a01-a04-only; recovery actions A05–A08 require explicit --include-recovery')
const priorPath = path.join(repository, '.runtime', '.cache', 'f05-u04-architecture', '45f2cfb2-e7a1-494d-a7cd-a3c5d39c5241', 'receipt.json')
// 旧外壳时期的历史回执只在当年的机器上：有就核对，没有就记下缺席。
const prior = fs.existsSync(priorPath) ? JSON.parse(fs.readFileSync(priorPath, 'utf8')) : null
if (prior) assert.equal(prior.outcome, 'PARTIAL')
const executablePath = resolveWindowsExecutable(packageDir)
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const testedSha = git('rev-parse', `${packageSourceSha}^{commit}`)
const changedPaths = git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean)
assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', 'src', 'electron', 'public', 'build',
  'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '', 'product source changed since fixed package SHA')
const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|pages\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)), 'product source dirty beyond test screenshots')
assert.equal(fileHash(executablePath), expectedExe)
assert.equal(fileHash(asarPath), expectedAsar)

const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u04-architecture', runId)
const scratch = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository), 'VibeCodingScratch', 'an', 'u04', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const projectName = 'U04'
const model = { id: 'f05-u04-synthetic', name: 'U04 隔离合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'f05-u04-offline-only', maxTokens: 4096, temperature: 0.7, purposes: ['generation'] }
const premise = '在潮汐城，林岚寻找失落的地图。旧港每逢钟声都会关闭，守塔人和记录员各自保管一半线索。她必须在第三次钟声前找到真正的入口。'.repeat(2)
const worldText = '潮汐城分为上城与旧港，钟声决定城门开放。守塔人记录海潮，记录员保管地图。任何进入旧港的人都必须留下姓名和归来时间。'.repeat(3)
const recoveryText = '恢复后追加：林岚查清了旧港的潮汐规则。'.repeat(3)
const heldText = '候选保留：旧港的钟声记录尚未核对完毕。'.repeat(4)
const staleText = '旧源候选：新增前提尚未纳入这次生成。'.repeat(4)
const outline = chapter => `## 第${chapter}章：旧港线索${chapter}\n林岚在钟声之后核对地图，找到第${chapter}条线索，并决定下一步调查方向。她请守塔人核对潮位和城门记录，再与记录员比对地图上的旧标记，确认线索的来源与风险。`
const steps = []
const pass = (stepId, actionId, assertion, observed) => steps.push({ stepId, actionId, outcome: 'PASS', assertion, observed })
const timeout = 60_000
const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
  AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
  APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]

async function invoke(page, channel, ...args) {
  return page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
}
async function assertStage(page, actionId) {
  await stage.waitForStage(page, timeout)
  assert.equal(await stage.root(page).getAttribute('data-shell-presentation'), 'stage', `${actionId}: not the paper-ink stage`)
}
async function launch(port) {
  const app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout })
  try {
    await app.evaluate((_, fixturePort) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, options) => {
        const url = new URL(String(input))
        if (url.origin !== 'https://api.openai.com' || !url.pathname.startsWith('/v1/')) throw new Error('F05_U04_NETWORK_REFUSED')
        return originalFetch(`http://127.0.0.1:${fixturePort}${url.pathname}`, options)
      }
    }, port)
    const page = await app.firstWindow({ timeout })
    page.setDefaultTimeout(15_000)
    await stage.waitForStage(page, timeout)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { app, page }
  } catch (error) { await app.close(); throw error }
}
async function quit(app) {
  const pid = app.process().pid
  let timer
  const closed = await Promise.race([app.close().then(() => true).catch(() => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 10_000) })])
  clearTimeout(timer)
  if (!closed) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
  return { forced: !closed }
}
async function openProject(page) {
  await assertStage(page, 'project-open')
  await stage.dismissMigrationNotice(page)
  await stage.showLibrary(page)
  await stage.openFromLibrary(page, projectName)
  await stage.waitForWork(page, projectName)
}
/** 设定页的核心大纲（旧外壳的「小说配置」创作想法），改完 Ctrl S。 */
async function saveCoreOutline(page, value) {
  await stage.stageButton(page, '设定').click()
  await stage.setupOutline(page).fill(value)
  await page.keyboard.press('ControlOrMeta+s')
  await stage.saveStatus(page).filter({ hasText: /^已保存$/ }).waitFor({ state: 'visible' })
}
async function architecture(page) {
  await assertStage(page, 'architecture-entry')
  await arch.open(page)
}
const SECTION_KEYS = { 故事前提: 'premise', 角色名单: 'characters', 世界观: 'worldbuilding', 情节大纲: 'synopsis' }
/** 四节都有内容后主按钮是「下一步」，生成在「架构的更多操作」里；否则主按钮就是生成。 */
async function openGenerateDialog(page) {
  if (await arch.primary(page).filter({ hasText: /生成架构/ }).count() > 0) await arch.primary(page).click()
  else {
    await page.getByRole('button', { name: '架构的更多操作' }).click()
    await page.getByRole('menuitem', { name: 'AI 生成架构…' }).click()
  }
  await arch.dialog(page).waitFor({ state: 'visible' })
  return arch.dialog(page)
}
async function startGenerate(page) {
  const dialog = arch.dialog(page)
  await dialog.getByRole('button', { name: /^开始生成 \d+ 项$/ }).click()
  try {
    await dialog.waitFor({ state: 'hidden' })
  } catch (error) {
    const state = await dialog.evaluate(element => ({
      guardError: element.querySelector('span.arch-guard')?.textContent?.slice(0, 500) ?? null,
      confirm: [...element.querySelectorAll('button')].filter(button => /开始生成|校验中/.test(button.textContent ?? ''))
        .map(button => ({ text: button.textContent?.trim().slice(0, 80), disabled: button.disabled })),
      range: [...element.querySelectorAll('input[type="number"]')].map(input => input.value),
    }))
    throw new Error(`architecture dialog remained open: ${JSON.stringify(state)}; ${String(error)}`)
  }
}
async function generate(page, selected, range) {
  await assertStage(page, `generate-${selected}`)
  await openGenerateDialog(page)
  await arch.selectOnly(page, [SECTION_KEYS[selected]])
  if (range) await arch.setRange(page, range.from, range.to)
  await startGenerate(page)
}
async function readCore(_page, context) {
  const projectRoot = path.resolve(context.projectPath)
  assert.equal(path.dirname(projectRoot), path.resolve(profile.projects), 'database read escaped isolated project root')
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    const row = database.prepare("SELECT premise, core_outline, worldbuilding, synopsis FROM project_core WHERE id='main'").get()
    assert(row, 'project core missing from isolated SQLite')
    return row
  } finally { database.close() }
}
function readAttemptCount(context, handle) {
  const projectRoot = path.resolve(context.projectPath)
  assert.equal(path.dirname(projectRoot), path.resolve(profile.projects), 'attempt read escaped isolated project root')
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    const row = database.prepare('SELECT r.root_action_id, COUNT(a.attempt_id) AS count FROM generation_runs r LEFT JOIN generation_attempts a ON a.run_id = r.run_id WHERE r.run_id = ? GROUP BY r.run_id').get(handle.runId)
    assert.equal(row?.root_action_id, handle.rootActionId, 'recovery run identity differs from checkpoint')
    return row.count
  } finally { database.close() }
}
async function waitCore(page, context, predicate, label) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const core = await readCore(page, context)
    if (predicate(core)) return core
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
// 旧外壳底部任务表的「历史任务」在纸墨外壳是运行侧页「历史」分页：数行数，判断这次运行已经结束、锁已释放。
const historyRows = page => page.getByRole('list', { name: '运行历史' }).getByRole('listitem')
async function showRunHistory(page) {
  await runSheet.openFromPalette(page)
  await runSheet.tab(page, '历史').click()
}
/** 失败时的诊断：运行历史只在「历史」页挂载，先切过去再读；读不到就返回空，不盖掉原来的错误。 */
async function historyTextsForDiagnostics(page) {
  try {
    await showRunHistory(page)
    return await historyRows(page).allTextContents()
  } catch {
    return []
  }
}
async function waitWorkflowReleased(page, previousCount) {
  await showRunHistory(page)
  await page.waitForFunction(count => (document.querySelector('[aria-label="运行历史"]')?.children.length ?? 0) > count, previousCount, { timeout })
  await runSheet.tab(page, '进行中').click()
}
async function runCount(page) {
  await showRunHistory(page)
  const count = await historyRows(page).count()
  await runSheet.tab(page, '进行中').click()
  return count
}
/** 世界观或大纲半途停下时的提示条：正式内容保留，候选可看、可复制、可断点续写。 */
const candidateNotice = page => stage.root(page).locator('.pi-notice').filter({ hasText: /^上次生成在半途停下/ })
const alertTexts = page => stage.root(page).locator('[role="alert"], .pi-notice[data-tone="danger"]').allTextContents()
async function readPartial(_page, context) {
  const projectRoot = path.resolve(context.projectPath)
  assert.equal(path.dirname(projectRoot), path.resolve(profile.projects), 'partial checkpoint escaped isolated project root')
  const checkpoint = path.join(projectRoot, '.ai-novel', 'partial_arch.json')
  return fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')) : null
}
async function waitPartial(page, context, predicate, label) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const partial = await readPartial(page, context)
    if (predicate(partial)) return partial
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function waitArtifacts(context, handle, predicate, label) {
  assert.equal(handle.projectId, context.projectId, 'candidate handle belongs to another project')
  const projectRoot = path.resolve(context.projectPath)
  assert.equal(path.dirname(projectRoot), path.resolve(profile.projects), 'artifact read escaped isolated project root')
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
    const texts = database.prepare('SELECT artifact_json FROM generation_artifacts WHERE run_id = ? ORDER BY rowid')
      .all(handle.runId).map(row => JSON.parse(row.artifact_json).text)
    database.close()
    if (predicate(texts)) return texts
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function waitPending(fixture) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fixture.pending) return fixture.pending
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for intercepted provider stream')
}
async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U04 architecture', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'review stage U04 receipt',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const fixture = { mode: 'idle', requests: [], pending: null }
  const server = createServer(async (request, response) => {
    const authorized = request.headers.authorization === `Bearer ${model.apiKey}`
    fixture.requests.push({ mode: fixture.mode, method: request.method, path: request.url, authorized })
    if (request.method !== 'POST' || !authorized || request.url !== '/v1/chat/completions') { response.writeHead(403).end(); return }
    request.resume()
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (content, finishReason = 'stop') => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
    if (fixture.mode === 'world-stop') send(worldText)
    else if (fixture.mode === 'world-resume') send(recoveryText)
    else if (fixture.mode === 'outline-first' || fixture.mode === 'outline-next') {
      const ordinal = fixture.requests.filter(row => row.mode === fixture.mode).length
      send(outline((fixture.mode === 'outline-first' ? 0 : 2) + ordinal))
    }
    else if (fixture.mode === 'world-length') send(heldText, 'length')
    else if (fixture.mode === 'world-hold' || fixture.mode === 'world-source-change') {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: fixture.mode === 'world-source-change' ? staleText : heldText } }] })}\n\n`)
      fixture.pending = { response, send }
    }
    else response.end()
  })
  let app, page, failure, currentStep = 'setup', context, project
  const mark = step => { currentStep = step; process.stderr.write(`${step}\n`) }
  try {
    verifyWindowsPackage(packageDir)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    ;({ app, page } = await launch(port))
    project = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, profile.projects)).grantId, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(project.success, true, project.error)
    const opened = await invoke(page, 'project:open', project.projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    context = { projectId: project.projectId, projectPath: project.projectPath, leaseId: opened.project.sessionLease }
    const seeded = await invoke(page, 'db:project-core-update', { premise }, project.projectPath, context)
    assert.equal(seeded.success, true, seeded.error)
    const seededCore = await invoke(page, 'db:project-core-get', project.projectPath, context)
    assert.equal(seededCore?.premise, premise, 'worldbuilding prerequisite premise was not persisted')
    const roster = await invoke(page, 'db:character-roster-read', project.projectPath, context)
    const character = { characterId: `draft:${randomUUID()}`, name: '林岚', role: 'protagonist', gender: '', age: '', appearance: '',
      personality: '', background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }
    const rosterSeed = await invoke(page, 'db:character-roster-commit', {
      operationId: randomUUID(), expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision,
      schemaVersion: 1, intent: 'manual_edit', entries: [character],
    }, project.projectPath, context)
    assert.equal(rosterSeed.success, true, rosterSeed.error)
    const outlinedCore = await invoke(page, 'db:project-core-get', project.projectPath, context)
    assert(outlinedCore?.charactersArch?.includes('林岚'), 'outline prerequisite roster projection was not persisted')
    assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
    await page.reload()
    await openProject(page)
    await saveCoreOutline(page, premise)
    await architecture(page)

    mark('U04.A01-worldbuilding')
    fixture.mode = 'world-stop'
    let priorRuns = await runCount(page)
    await generate(page, '世界观')
    await waitCore(page, context, core => core?.worldbuilding?.includes(worldText), 'formal worldbuilding')
    await waitWorkflowReleased(page, priorRuns)
    pass('U04.A01-worldbuilding', 'U04.A01', 'The architecture generate dialog produced formal worldbuilding through the shared workflow and project core', { syntheticRequests: fixture.requests.length })

    mark('U04.A02-outline-range')
    fixture.mode = 'outline-first'
    priorRuns = await runCount(page)
    await generate(page, '情节大纲', { from: 1, to: 2 })
    let first
    try {
      first = await waitCore(page, context, core => core?.synopsis?.includes('第1章：旧港线索1') && core?.synopsis?.includes('已覆盖至第 2 章'), 'first outline batch')
    } catch (error) {
      const notice = await alertTexts(page)
      const taskHistory = await historyTextsForDiagnostics(page)
      throw new Error(`first outline batch failed: ${JSON.stringify({ notice: notice.map(text => text.slice(0, 500)), taskHistory: taskHistory.slice(0, 3) })}; ${String(error)}`)
    }
    await waitWorkflowReleased(page, priorRuns)
    assert.equal(first.synopsis.includes('第3章：旧港线索3'), false)
    assert(first.synopsis.includes('第2章：旧港线索2'))
    pass('U04.A02-outline-range', 'U04.A02', 'The explicit 1..2 batch persisted only its requested range', { from: 1, to: 2 })

    mark('U04.A03-completed-range')
    await architecture(page)
    await arch.section(page, 'synopsis').getByText(/^上次生成到第 2 章停下了，第 3–\d+ 章还没有大纲。$/).waitFor({ state: 'visible' })
    pass('U04.A03-completed-range', 'U04.A03', 'The outline section displayed the completed range from the persisted 1..2 checkpoint', { coveredTo: 2 })

    mark('U04.A04-continue-batch')
    fixture.mode = 'outline-next'
    priorRuns = await runCount(page)
    await arch.section(page, 'synopsis').getByRole('button', { name: '续写第 3 章起' }).click()
    await arch.dialog(page).waitFor({ state: 'visible' })
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).inputValue(), '3')
    await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的结束章' }).fill('4')
    await arch.selectOnly(page, ['synopsis'])
    await startGenerate(page)
    try {
      await waitCore(page, context, core => core?.synopsis?.includes('第4章：旧港线索4') && core?.synopsis?.includes('已覆盖至第 4 章'), 'continued outline batch')
    } catch (error) {
      const dialog = await page.getByRole('dialog').allTextContents()
      const notice = await alertTexts(page)
      const taskHistory = await historyTextsForDiagnostics(page)
      throw new Error(`continued outline batch failed: ${JSON.stringify({ dialog: dialog.map(text => text.slice(0, 500)), notice: notice.map(text => text.slice(0, 500)), taskHistory: taskHistory.slice(0, 3) })}; ${String(error)}`)
    }
    await waitWorkflowReleased(page, priorRuns)
    const continued = await readCore(page, context)
    const progressAt = first.synopsis.indexOf('\n\n> 本大纲已覆盖至第')
    assert(progressAt > 0, 'first batch has no completed-range marker')
    const confirmedPrefix = first.synopsis.slice(0, progressAt)
    assert(confirmedPrefix.includes('第2章：旧港线索2'), 'first batch chapter 2 missing from confirmed prefix')
    assert(continued.synopsis.startsWith(confirmedPrefix), 'continuation replaced confirmed chapters 1–2')
    assert(continued.synopsis.includes('第3章：旧港线索3'))
    assert.deepEqual(fixture.requests.map(request => [request.mode, request.method, request.path, request.authorized]), [
      ['world-stop', 'POST', '/v1/chat/completions', true],
      ['outline-first', 'POST', '/v1/chat/completions', true],
      ['outline-first', 'POST', '/v1/chat/completions', true],
      ['outline-next', 'POST', '/v1/chat/completions', true],
      ['outline-next', 'POST', '/v1/chat/completions', true],
    ], 'stage UI actions did not reach the five expected loopback generation requests')
    pass('U04.A04-continue-batch', 'U04.A04', 'The outline continuation started at chapter 3 and preserved chapters 1–2 while extending through chapter 4', { from: 3, to: 4 })

    if (!a01A04Only) {
    mark('U04.A05-length-candidate')
    fixture.mode = 'world-length'
    const requestsBeforeLength = fixture.requests.length
    const beforeLength = (await readCore(page, context)).worldbuilding
    await generate(page, '世界观')
    const interrupted = await waitPartial(page, context, partial => partial?.world_building_incomplete === true
      && partial?.world_building_generation_handle, 'length candidate checkpoint')
    await waitArtifacts(context, interrupted.world_building_generation_handle,
      texts => texts.length === 2 && texts.every(text => text === heldText), 'two length candidate artifacts')
    assert.equal(readAttemptCount(context, interrupted.world_building_generation_handle), 2, 'length continuation was not recorded on one run')
    try {
      await architecture(page)
      await candidateNotice(page).waitFor({ state: 'visible', timeout })
    } catch (error) {
      const partial = await readPartial(page, context)
      const composition = partial?.world_building_generation_handle
        ? await invoke(page, 'generation:read-visible-composition', partial.world_building_generation_handle, context).catch(() => null)
        : null
      const taskHistory = await historyTextsForDiagnostics(page)
      const alerts = await alertTexts(page)
      const statuses = await page.getByRole('status').allTextContents()
      throw new Error(`length candidate UI missing: ${JSON.stringify({
        candidateMirrorPresent: Boolean(partial?.world_building_partial_result),
        handlePresent: Boolean(partial?.world_building_generation_handle),
        composition: composition ? { algorithm: composition.algorithm, textLength: composition.text?.length ?? 0,
          artifactCount: composition.artifactIds?.length ?? 0 } : null,
        candidateButtonCount: await page.getByRole('button', { name: '查看未完成候选' }).count(),
        syntheticRequestsSinceLength: fixture.requests.length - requestsBeforeLength,
        statuses: statuses.slice(0, 8).map(value => value.slice(0, 160)),
        alerts: alerts.slice(0, 3).map(value => value.slice(0, 300)),
        taskHistory: taskHistory.slice(0, 3).map(value => value.slice(0, 500)),
      })}; ${String(error)}`)
    }
    assert(fixture.requests.length - requestsBeforeLength >= 2, 'length continuation did not reach its second synthetic request')
    assert.equal((await readCore(page, context)).worldbuilding, beforeLength, 'length result overwrote formal worldbuilding')
    await quit(app); app = null
    ;({ app, page } = await launch(port))
    await assertStage(page, 'U04.A05')
    await openProject(page)
    await architecture(page)
    assert.deepEqual((await readPartial(page, context))?.world_building_generation_handle, interrupted.world_building_generation_handle,
      'reopened candidate did not retain the exact run handle')
    assert.equal((await readCore(page, context)).worldbuilding, beforeLength, 'reopened candidate changed formal worldbuilding')
    await candidateNotice(page).waitFor({ state: 'visible' })
    await candidateNotice(page).getByRole('button', { name: '查看未完成候选' }).click()
    await stage.root(page).getByRole('region', { name: '未完成候选' }).getByText(heldText, { exact: false }).waitFor({ state: 'visible' })
    pass('U04.A05-length-candidate', 'U04.A05', 'Two length-ended synthetic responses retained an inspectable candidate after installed-process restart without changing formal worldbuilding',
      { candidateHandle: Boolean(interrupted.world_building_generation_handle) })

    mark('U04.A07-safe-world-resume')
    fixture.mode = 'world-resume'
    priorRuns = await runCount(page)
    await candidateNotice(page).getByRole('button', { name: '断点续写', exact: true }).click()
    await waitCore(page, context, core => core?.worldbuilding?.includes(recoveryText), 'resumed formal worldbuilding')
    await waitWorkflowReleased(page, priorRuns)
    assert.equal(readAttemptCount(context, interrupted.world_building_generation_handle), 3, 'resume did not add an attempt to the selected run')
    assert((await readCore(page, context)).worldbuilding.includes(heldText), 'resume discarded selected candidate text')
    assert.equal((await readPartial(page, context))?.world_building_incomplete, undefined)
    pass('U04.A07-safe-world-resume', 'U04.A07', 'The candidate notice resumed the persisted candidate by its exact handle and committed new formal worldbuilding',
      { priorCandidateHandle: Boolean(interrupted.world_building_generation_handle) })

    mark('U04.A06-cancel-candidate')
    fixture.mode = 'world-hold'
    fixture.pending = null
    priorRuns = await runCount(page)
    const beforeCancel = (await readCore(page, context)).worldbuilding
    await generate(page, '世界观')
    await waitPending(fixture)
    // 旧外壳 AI 输出的「中止生成」是运行侧页里这次运行卡片的「取消」。
    await runSheet.openFromPalette(page)
    await runSheet.sheet(page).getByRole('button', { name: /^取消「/ }).click()
    const cancelled = await waitPartial(page, context, partial => partial?.world_building_incomplete === true
      && partial?.world_building_generation_handle, 'cancelled candidate checkpoint')
    await waitWorkflowReleased(page, priorRuns)
    assert.notDeepEqual(cancelled.world_building_generation_handle, interrupted.world_building_generation_handle)
    await waitArtifacts(context, cancelled.world_building_generation_handle,
      texts => texts.some(text => text?.includes(heldText)), 'stopped candidate artifact')
    assert.equal((await readCore(page, context)).worldbuilding, beforeCancel, 'stop changed formal worldbuilding')
    pass('U04.A06-cancel-candidate', 'U04.A06', 'Cancelling the run kept the partial worldbuilding candidate and left prior formal worldbuilding intact',
      { candidateHandle: Boolean(cancelled.world_building_generation_handle) })

    mark('U04.A08-source-change')
    fixture.mode = 'world-source-change'
    fixture.pending = null
    await generate(page, '世界观')
    const stream = await waitPending(fixture)
    const beforeChange = (await readCore(page, context)).worldbuilding
    const checkpointPath = path.join(context.projectPath, '.ai-novel', 'partial_arch.json')
    const checkpointBefore = fs.statSync(checkpointPath).mtimeMs
    await saveCoreOutline(page, `${premise} 作者新增前提。`)
    assert.equal((await readCore(page, context)).core_outline, `${premise} 作者新增前提。`, 'source change was not persisted before stale completion')
    stream.send(staleText)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline && fs.statSync(checkpointPath).mtimeMs <= checkpointBefore) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (fs.statSync(checkpointPath).mtimeMs <= checkpointBefore) {
      const partial = await readPartial(page, context)
      const composition = partial?.world_building_generation_handle
        ? await invoke(page, 'generation:read-visible-composition', partial.world_building_generation_handle, context).catch(() => null)
        : null
      const alerts = await alertTexts(page)
      const taskHistory = await historyTextsForDiagnostics(page)
      throw new Error(`source-change candidate was not persisted after provider completed: ${JSON.stringify({
        handlePresent: Boolean(partial?.world_building_generation_handle),
        incomplete: partial?.world_building_incomplete,
        composition: composition ? { textLength: composition.text?.length ?? 0, artifactCount: composition.artifactIds?.length ?? 0 } : null,
        candidateButtonCount: await page.getByRole('button', { name: '查看未完成候选' }).count(),
        syntheticRequests: fixture.requests.length,
        alerts: alerts.slice(0, 3).map(value => value.slice(0, 300)),
        taskHistory: taskHistory.slice(0, 3).map(value => value.slice(0, 500)),
      })}`)
    }
    const sourceChanged = await readPartial(page, context)
    assert.equal(sourceChanged?.world_building_incomplete, true)
    assert.notDeepEqual(sourceChanged.world_building_generation_handle, cancelled.world_building_generation_handle,
      'source-change checkpoint reused the previous candidate handle')
    await waitArtifacts(context, sourceChanged.world_building_generation_handle,
      texts => texts.some(text => text?.includes(staleText)), 'source-change candidate artifact')
    assert.equal((await readCore(page, context)).worldbuilding, beforeChange, 'stale result overwrote formal worldbuilding')
    await architecture(page)
    await page.getByRole('button', { name: '架构的更多操作' }).click()
    await page.getByRole('menuitem', { name: '刷新状态' }).click()
    try {
      await candidateNotice(page).waitFor({ state: 'visible' })
      await candidateNotice(page).getByRole('button', { name: '查看未完成候选' }).click()
      await stage.root(page).getByRole('region', { name: '未完成候选' }).filter({ hasText: staleText }).waitFor({ state: 'visible' })
    } catch (error) {
      const partial = await readPartial(page, context)
      const composition = partial?.world_building_generation_handle
        ? await invoke(page, 'generation:read-visible-composition', partial.world_building_generation_handle, context).catch(() => null)
        : null
      const alerts = await alertTexts(page)
      const taskHistory = await historyTextsForDiagnostics(page)
      throw new Error(`source-change candidate UI missing: ${JSON.stringify({
        candidateMirrorPresent: Boolean(partial?.world_building_partial_result),
        handlePresent: Boolean(partial?.world_building_generation_handle),
        composition: composition ? { algorithm: composition.algorithm, textLength: composition.text?.length ?? 0,
          artifactCount: composition.artifactIds?.length ?? 0 } : null,
        candidateButtonCount: await page.getByRole('button', { name: '查看未完成候选' }).count(),
        alerts: alerts.slice(0, 3).map(value => value.slice(0, 300)),
        taskHistory: taskHistory.slice(0, 3).map(value => value.slice(0, 500)),
      })}; ${String(error)}`)
    }
    // 运行侧页「历史」里这次失败的运行写明了原因。
    await showRunHistory(page)
    const latestRun = historyRows(page).first()
    if (await latestRun.locator('.run-history-row').getAttribute('aria-expanded') !== 'true') await latestRun.locator('.run-history-row').click()
    await latestRun.getByText('世界观生成期间故事前提、小说配置或模板已变化，本次结果已保留为候选且未写入正式世界观', { exact: false }).first()
      .waitFor({ state: 'visible' })
    pass('U04.A08-source-change', 'U04.A08', 'Changing premise while the worldbuilding run was streaming rejected the stale formal write and retained a candidate',
      { changedSource: 'coreOutline', formalUnchanged: true })
    }
  } catch (error) {
    failure = error
    if (page) await page.screenshot({ path: path.join(receiptDir, 'failure.png') }).catch(() => {})
  }
  finally {
    if (app) try { await quit(app) } catch (error) { failure ??= error }
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
  const coveredActions = new Set(steps.filter(step => step.outcome === 'PASS').map(step => step.actionId))
  const unverified = Array.from({ length: 8 }, (_, index) => `U04.A${String(index + 1).padStart(2, '0')}`)
    .filter(actionId => !coveredActions.has(actionId))
  const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: a01A04Only ? 'F05_U04_V3_ARCHITECTURE_A01_A04_ONLY' : 'F05_U04_V3_ARCHITECTURE_RECOVERY_EXPERIMENT',
    evidenceLevel: 'electron', shell: 'stage', testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths,
    reuseDecision: { testedSha, changedPaths, differences: changedPaths.join(', ') || 'none',
      reason: 'historical Writer receipts are not reused; fixed package hashes match and the current paper-ink stage UI is exercised independently' },
    sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean), dirtyProductPaths,
    buildReceipt: prior ? { path: priorPath, sha256: fileHash(priorPath) } : { path: priorPath, missing: true },
    artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
    driver: { path: fileURLToPath(import.meta.url), sha256: fileHash(fileURLToPath(import.meta.url)) },
    profile: { canonical: profile.canonical, userData: profile.userData, projectRoot: profile.projects },
    project: { path: project?.projectPath ?? null }, persistenceRead: 'isolated project SQLite readonly; stage actions and writes remain production UI/IPC',
    setupFixture: 'formal premise via project-core-update; protagonist roster via character-roster-commit derives charactersArch; neither counted as U04 action',
    syntheticRequests: fixture.requests, externalModelRequests: 0, steps,
    unverified,
    failedStep: failure ? currentStep : null, error: failure ? String(failure) : null }
  assert.equal(JSON.stringify(receipt).includes(model.apiKey), false)
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
