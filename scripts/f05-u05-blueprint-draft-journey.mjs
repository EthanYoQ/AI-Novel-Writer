/* global process */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'
import * as blueprint from './redesign/pages/blueprint.mjs'
import * as runSheet from './redesign/pages/run-sheet.mjs'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const testedSha = option('package-source-sha')
const selectedAction = option('only-action')
assert(!selectedAction || selectedAction === 'U05.A07', '--only-action currently supports only U05.A07')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
const packageDir = option('package-dir') && path.resolve(repository, option('package-dir'))
assert(packageDir && testedSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const executablePath = resolveWindowsExecutable(packageDir)
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
assert.equal(git('rev-parse', testedSha), testedSha, 'packaged tested SHA is unavailable')
const changedPaths = git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean)
assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', 'src', 'electron', 'public', 'build', 'package.json',
  'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '',
  'product input changed since package build')
const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build', 'package.json',
  'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:characters|dialogs|editor|layout\/v2|pages|pages\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)),
  'product source dirty beyond test screenshots')
assert.equal(fileHash(executablePath), expectedExe)
assert.equal(fileHash(asarPath), expectedAsar)

const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u05-blueprint-draft', randomUUID())
const scratch = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository), 'VibeCodingScratch', 'an', 'u05', randomUUID().slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const projectName = 'U05'
assert(path.join(profile.projects, projectName).length <= 85, 'isolated project path exceeds native fixture limit')
const model = { id: 'f05-u05-synthetic', name: 'U05 隔离合成模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'f05-u05-offline-only', maxTokens: 4096, temperature: 0.7, purposes: ['generation'] }
const premise = '在潮汐城，林岚寻找旧港地图。守塔人保管潮汐记录。'.repeat(3)
const worldbuilding = '旧港城门按钟声和潮位开放；进入者必须登记姓名。'.repeat(3)
const synopsis = '# 全书总纲\n林岚追查旧港地图。\n## 第1章：旧港线索1\n林岚找到地图。\n## 第2章：旧港线索2\n林岚核对潮汐。\n## 第3章：旧港线索3\n林岚抵达旧港。'
const prose = '林岚沿旧港石阶核对钟声潮位地图线索'.repeat(5)
const shortOutline = '- 原目标：核对旧港线索。\n- 结尾状态：线索指向下一次钟声。'
const proseTwo = '守塔人到北堤寻找钟锤，盐仓船票揭示去向。林岚查出船票上的日期晚于地图失踪之夜，于是先封存票据，再请港务员核对出航簿。北堤钟楼传来三声短响，二人决定追查最后一艘离港货船。'
const steps = []
const timeout = 60_000
const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
  AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
  APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]

const pass = (stepId, actionId, assertion, observed) => steps.push({ stepId, actionId, outcome: 'PASS', assertion, observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
async function assertStage(page, step) {
  await stage.waitForStage(page, timeout)
  assert.equal(await stage.root(page).getAttribute('data-shell-presentation'), 'stage', `${step}: not the paper-ink stage`)
}
async function launch(port) {
  const app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout })
  try {
    await app.evaluate((_, fixturePort) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, options) => {
        const url = new URL(String(input))
        if (url.origin !== 'https://api.openai.com' || !url.pathname.startsWith('/v1/')) throw new Error('F05_U05_NETWORK_REFUSED')
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
async function openProject(page, name = projectName) {
  await assertStage(page, 'project-open')
  await stage.dismissMigrationNotice(page)
  await stage.showLibrary(page)
  await stage.openFromLibrary(page, name)
  await stage.waitForWork(page, name)
}
async function blueprintPage(page) {
  await assertStage(page, 'blueprint-page')
  await blueprint.open(page)
}
/** 收起运行侧页：运行开始时它会自动展开，收起后才能用「展开了」判断下一次运行已经开始。 */
async function closeRunSheet(page) {
  if (!await runSheet.sheet(page).isVisible()) return
  await runSheet.sheet(page).getByRole('button', { name: '收起运行侧页' }).first().click()
  await runSheet.sheet(page).waitFor({ state: 'hidden' })
}
/** 大纲没写满全书时，生成蓝图前会先问「架构还不完整」；确认后照常生成。没有这一问就直接开始，运行侧页展开。 */
async function confirmIncompleteArchitecture(page) {
  const warning = page.getByRole('dialog', { name: '架构还不完整' })
  await warning.or(runSheet.sheet(page)).first().waitFor({ state: 'visible', timeout })
  if (!await warning.isVisible()) return false
  await warning.getByRole('button', { name: '继续生成' }).click()
  await runSheet.sheet(page).waitFor({ state: 'visible', timeout })
  return true
}
/** 写作前的一致性预检有提示时停下等作者处理（这里选「仅本次忽略」）；没有提示就直接开始，运行侧页展开。 */
async function passPreflight(page, scope) {
  const ignore = scope.getByRole('button', { name: '仅本次忽略' })
  await ignore.or(runSheet.sheet(page)).first().waitFor({ state: 'visible', timeout })
  if (!await ignore.isVisible()) return false
  await ignore.click()
  await runSheet.sheet(page).waitFor({ state: 'visible', timeout })
  return true
}
/** 「AI 生成蓝图」里「接着生成 N 章」：已有蓝图时从下一章往后补，保留已有的。 */
async function requestBlueprints(page, count) {
  await assertStage(page, `blueprints-${count}`)
  await closeRunSheet(page)
  await blueprint.openGenerate(page)
  const dialog = blueprint.generateDialog(page)
  await dialog.getByRole('spinbutton', { name: '本次蓝图章数' }).fill(String(count))
  await dialog.getByRole('button', { name: '开始生成' }).click()
  await dialog.waitFor({ state: 'hidden', timeout })
  return confirmIncompleteArchitecture(page)
}
async function waitBlueprints(page, context, expected) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const rows = readProjectDb(context.projectPath, db => db.prepare('SELECT chapter_number AS chapterNumber,title FROM blueprints ORDER BY chapter_number').all())
    if (rows.length === expected.length && rows.every((row, index) => row.chapterNumber === expected[index])) return rows
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`blueprint persistence did not reach exact range ${expected.join(',')}`)
}
async function waitDrafts(page, context, expected) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const drafts = readProjectDb(context.projectPath, db => db.prepare('SELECT id,chapter_number AS chapterNumber,version,status FROM drafts ORDER BY chapter_number').all())
    if (drafts.length >= expected) return drafts
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`draft persistence did not reach ${expected}`)
}
function readProjectDb(projectPath, read) {
  const db = new DatabaseSync(path.join(projectPath, '.ai-novel', 'project.db'), { readOnly: true })
  try { return read(db) } finally { db.close() }
}
function assertTrustedAttempts(projectPath, expected) {
  const attempts = readProjectDb(projectPath, db => db.prepare('SELECT attempt_json,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
    .map(row => ({ status: JSON.parse(row.attempt_json).status,
      trusted: JSON.parse(row.usage_receipt_json).result?.usage?.trusted,
      finishReason: JSON.parse(row.usage_receipt_json).result?.finishReason })))
  assert.equal(attempts.length, expected, 'unexpected provider attempt count')
  assert.ok(attempts.every(row => row.status === 'settled' && row.trusted === true && row.finishReason === 'stop'),
    `untrusted provider attempt: ${JSON.stringify(attempts)}`)
}
async function waitBatch(page, context, expectedCompleted, mode) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const batch = readProjectDb(context.projectPath, db => {
      const root = db.prepare('SELECT run_id,binding_json FROM generation_runs').all()
        .map(row => ({ batchId: row.run_id, binding: JSON.parse(row.binding_json) }))
        .find(row => row.binding.sourceManifest.operation === 'batch-chapters'
          && row.binding.sourceManifest.batchIntent?.mode === mode)
      if (!root) return null
      const completedChapters = db.prepare('SELECT usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
        .map(row => JSON.parse(row.usage_receipt_json).draftCommit)
        .filter(commit => commit?.batchId === root.batchId)
        .map(commit => ({ chapterNumber: commit.chapterNumber, draftId: commit.id }))
      return { batchId: root.batchId, ...root.binding.sourceManifest.batchIntent,
        modelId: root.binding.sourceManifest.modelReceipt?.modelId,
        projectId: root.binding.projectId, leaseId: root.binding.epoch, completedChapters }
    })
    if (batch) {
      if (batch.completedChapters.length >= expectedCompleted) return batch
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`batch did not commit ${expectedCompleted} chapters`)
}
/** 蓝图页的「批量创作」：写几章、每章目标字数、本次模型与写完之后的去向；自动定稿要再确认一次。 */
async function batchDialog(page, count, mode) {
  await assertStage(page, `batch-${mode}`)
  await blueprintPage(page)
  await closeRunSheet(page)
  await page.getByRole('button', { name: '批量创作' }).click()
  const dialog = blueprint.batchDialog(page)
  await dialog.getByLabel(/^写几章/).fill(String(count))
  await dialog.getByLabel('每章目标字数').fill('100')
  await dialog.getByRole('radio', { name: mode === 'draft_review' ? /^留作草稿/ : /^自动定稿/ }).check()
  await dialog.getByLabel(/^本次模型/).selectOption(model.id)
  if (mode === 'auto_finalize') {
    await dialog.getByRole('button', { name: '继续确认自动定稿' }).click()
    await dialog.getByRole('button', { name: '确认自动定稿并开始' }).click()
  } else {
    await dialog.getByRole('button', { name: `开始写 ${count} 章` }).click()
  }
  await passPreflight(page, dialog)
  await dialog.waitFor({ state: 'hidden', timeout })
}
/** 运行侧页里这次批量创作的「取消」：只有进行中的运行才有。 */
const batchCancel = page => runSheet.sheet(page).getByRole('button', { name: /^取消「批量草稿待审/ }).first()
/** 等运行侧页「进行中」没有运行；返回开始等之前还在跑的运行标题。 */
async function waitNoActiveRuns(page) {
  await runSheet.openFromPalette(page)
  await runSheet.tab(page, '进行中').click()
  const initially = await runSheet.activeTitles(page)
  const deadline = Date.now() + timeout
  let active = initially
  while (active.length > 0) {
    if (Date.now() > deadline) throw new Error(`RUNS_NOT_QUIESCENT ${JSON.stringify(active)}`)
    await new Promise(resolve => setTimeout(resolve, 250))
    active = await runSheet.activeTitles(page)
  }
  return initially
}
/** 运行侧页「历史」里标题为 title 的最近一次运行记为已完成。 */
async function assertRunCompleted(page, title) {
  await runSheet.openFromPalette(page)
  await runSheet.tab(page, '历史').click()
  const row = page.getByRole('list', { name: '运行历史' }).getByRole('listitem')
    .filter({ has: page.locator('.run-history-title', { hasText: title }) }).first()
  await row.locator('.run-history-row').filter({ hasText: '已完成，' }).waitFor({ state: 'visible', timeout })
  await runSheet.tab(page, '进行中').click()
}
/** 定稿视图里的「定稿后处理」：每一步的名字、状态（success / pending / failed）与说明。 */
const postProcess = page => stage.root(page).getByRole('region', { name: '定稿后处理' })
async function waitPostProcess(page, accept, label) {
  const deadline = Date.now() + timeout
  let rows = []
  while (Date.now() < deadline) {
    rows = await postProcess(page).locator('.stage-ch-post-step').evaluateAll(items => items.map(item => ({
      label: item.querySelector('b')?.textContent ?? '', state: item.getAttribute('data-state'),
      detail: item.querySelector('.stage-ch-post-detail')?.textContent ?? '' }))).catch(() => [])
    if (accept(rows)) return rows
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label}: ${JSON.stringify(rows)}`)
}
/** 切到设定再回到第 1 章，定稿视图重新挂载、重读后处理记录。 */
async function reopenChapterOne(page) {
  await stage.stageButton(page, '设定').click()
  await stage.openChapter(page, 1)
}
async function createConfiguredProject(app, page, name) {
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, profile.projects)).grantId, name,
    genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
  // 写作此章不再弹参数表单（UX-05），单章的目标字数取自作品设定的每章字数；合成正文约 85 字，设为下限 100，一次写完不续写。
  assert.equal((await invoke(page, 'db:project-core-update', { premise, worldbuilding, synopsis, wordsPerChapter: 100 }, created.projectPath, session)).success, true)
  const roster = await invoke(page, 'db:character-roster-read', created.projectPath, session)
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(),
    expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision, schemaVersion: 1,
    intent: 'manual_edit', entries: [{ characterId: `draft:${randomUUID()}`, name: '林岚', role: 'protagonist',
      gender: '', age: '', appearance: '', personality: '',
      background: '林岚是旧港潮汐记录的测绘师，长期整理城门钟声和港口航线。',
      abilities: '能根据潮位与地图判断安全通道。', motivation: '守护居民通行并查明失踪地图的来源。',
      relationships: [], arc: '', notes: '' }] }, created.projectPath, session)).success, true)
  const cards = await invoke(page, 'db:character-get-all', created.projectPath, session)
  const core = await invoke(page, 'db:project-core-get', created.projectPath, session)
  assert.equal(cards.length, 1, 'roster fixture did not persist one character card')
  assert.ok([core?.premise, core?.charactersArch, core?.worldbuilding, core?.synopsis].every(value => value?.length > 50),
    'blueprint fixture does not satisfy all architecture guard fields')
  await page.reload()
  await openProject(page, name)
  await blueprintPage(page)
  return { created, session }
}
async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U05', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'review stage U05 receipt',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const fixture = { requests: [], outlines: [], chapters: [], mode: 'blueprint', blueprintQueue: [1], releaseFirst: null, releaseRetry: null }
  const server = createServer(async (request, response) => {
    const authorized = request.headers.authorization === `Bearer ${model.apiKey}`
    if (request.method !== 'POST' || !authorized) { response.writeHead(403).end(); return }
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
    if (request.url === '/v1/embeddings') {
      const input = Array.isArray(body.input) ? body.input : [body.input]
      fixture.requests.push({ kind: 'embedding', count: input.length, authorized })
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })),
      }))
      return
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    const prompt = body.messages?.map(message => message.content ?? '').join('\n') ?? ''
    const range = /继续严密推演 第(\d+)章 到 第(\d+)章/u.exec(prompt)
    const compact = /"targetChapterNumber"\s*:\s*(\d+)/u.exec(prompt)
    const rangeLength = range ? Number(range[2]) - Number(range[1]) + 1 : 0
    const chapters = fixture.mode === 'blueprint' && range && rangeLength >= 1 && rangeLength <= 10
      ? Array.from({ length: rangeLength }, (_, index) => Number(range[1]) + index)
      : fixture.mode === 'blueprint' && compact ? [Number(compact[1])] : []
    const synopsisChapterOne = prompt.includes('林岚找到地图。')
    const synopsisChapterTwo = prompt.includes('林岚核对潮汐。')
    // 写稿先要一份短细纲（只写短细纲）再写正文：细纲照常回复、另记在 outlines，requests 只记蓝图与正文请求，挂起与失败也只作用于正文。
    if (prompt.includes('只写短细纲')) {
      fixture.outlines.push({ mode: fixture.mode, model: body.model, synopsisChapterOne, synopsisChapterTwo })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: shortOutline }, finish_reason: 'stop' }] })}\n\n`)
      response.write('data: {"choices":[],"usage":{"prompt_tokens":300,"completion_tokens":60,"total_tokens":360}}\n\n')
      response.end('data: [DONE]\n\n')
      return
    }
    if (fixture.mode === 'draft_review' && synopsisChapterOne === synopsisChapterTwo) {
      response.writeHead(422).end('AMBIGUOUS_U05_DRAFT_CHAPTER'); return
    }
    const characterStateRequest = fixture.mode === 'auto_finalize'
      && (prompt.includes('只返回一个 JSON 对象：{"updates"') || prompt.includes('Return one JSON object: {"updates"'))
    const responseText = fixture.mode === 'blueprint' ? null
      : characterStateRequest ? '{"updates":[]}' : synopsisChapterTwo ? proseTwo : prose
    fixture.requests.push({ mode: fixture.mode, chapters, model: body.model, path: request.url, authorized,
      characterStateRequest,
      synopsisChapterOne, synopsisChapterTwo, responseSha256: responseText ? createHash('sha256').update(responseText).digest('hex') : null,
      blueprintOne: prompt.includes('旧港线索1'), blueprintTwo: prompt.includes('旧港线索2') })
    if (fixture.mode === 'blueprint' && (!chapters.length
      || JSON.stringify(chapters) !== JSON.stringify(fixture.blueprintQueue.slice(0, chapters.length)))) {
      response.writeHead(422).end('UNEXPECTED_U05_FIXTURE_REQUEST'); return
    }
    if (fixture.mode === 'blueprint') {
      fixture.blueprintQueue.splice(0, chapters.length)
      fixture.chapters.push(...chapters)
    }
    if (fixture.mode === 'cancel_request') await new Promise(resolve => { fixture.releaseFirst = resolve })
    if (fixture.mode === 'retry_request') await new Promise(resolve => { fixture.releaseRetry = resolve })
    if (fixture.mode === 'fail_request') {
      await new Promise(resolve => setTimeout(resolve, 1_500))
      response.writeHead(503).end('U05_CONTROLLED_PROVIDER_FAILURE'); return
    }
    const content = fixture.mode === 'blueprint'
      ? JSON.stringify({ blueprints: chapters.map(chapter => ({ chapterNumber: chapter, title: `旧港线索${chapter}`,
        role: '发展', purpose: '林岚核对地图与潮位', keyEvents: `林岚发现第${chapter}条旧港线索`,
        characters: ['林岚'], relationships: [], suspenseHook: '下一次钟声会改变入口' })) })
      : responseText
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`)
    response.write('data: {"choices":[],"usage":{"prompt_tokens":400,"completion_tokens":200,"total_tokens":600}}\n\n')
    response.end('data: [DONE]\n\n')
  })
  // A04 的批次与请求供 A08 核对；两段各在自己的 if 里，所以提到这里声明。
  let app, page, failure, failureUi, currentStep = 'setup', context, project, exit, batch, batchRequests
  const mark = step => { currentStep = step; process.stderr.write(`${step}\n`) }
  try {
    verifyWindowsPackage(packageDir)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    ;({ app, page } = await launch(server.address().port))
    assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
    if (!selectedAction) {
    ;({ created: project, session: context } = await createConfiguredProject(app, page, projectName))

    mark('U05.A01-single-blueprint')
    const firstWarned = await requestBlueprints(page, 1)
    const first = await waitBlueprints(page, context, [1])
    assert.equal(first[0].title, '旧港线索1')
    assert.deepEqual(fixture.chapters, [1])
    assert.deepEqual(fixture.blueprintQueue, [])
    assertTrustedAttempts(context.projectPath, 1)
    pass('U05.A01-single-blueprint', 'U05.A01', 'AI 生成蓝图 with 接着生成 1 章 produced and persisted exactly chapter 1 blueprint',
      { chapterNumbers: first.map(row => row.chapterNumber), requests: [...fixture.chapters], incompleteArchitectureConfirmed: firstWarned })

    mark('U05.A02-batch-blueprints')
    fixture.blueprintQueue = [2, 3]
    await requestBlueprints(page, 2)
    let continuedOperationId = null
    const appendDeadline = Date.now() + timeout
    while (Date.now() < appendDeadline) {
      const saved = readProjectDb(context.projectPath, db => db.prepare('SELECT chapter_number FROM blueprints ORDER BY chapter_number').all().map(row => row.chapter_number))
      if (JSON.stringify(saved) === '[1,2,3]') break
      if (JSON.stringify(saved) === '[1,2]' && await page.locator('[role="alert"],[role="status"]').filter({ hasText: 'DIRECTORY_PARTIAL_COMMIT' }).first().isVisible()) {
        const progress = readProjectDb(context.projectPath, db => db.prepare('SELECT usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
          .map(row => JSON.parse(row.usage_receipt_json).directoryProgress)
          .find(row => row?.requestedRange?.startChapter === 2 && row.requestedRange.endChapter === 3))
        assert.deepEqual(progress?.committedRange, { startChapter: 2, endChapter: 2 })
        assert.deepEqual(progress?.remainingRange, { startChapter: 3, endChapter: 3 })
        assert.ok(progress.operationId && !progress.continuationHandle)
        continuedOperationId = progress.operationId
        await assertStage(page, 'blueprint-partial-continuation')
        await blueprint.openGenerate(page)
        const dialog = blueprint.generateDialog(page)
        const card = dialog.locator('.pi-notice').filter({ hasText: '已保存第 2～2 章蓝图' })
        const continueButton = card.getByRole('button', { name: '继续第 3～3 章', exact: true })
        await continueButton.waitFor({ state: 'visible', timeout })
        assert.equal(await continueButton.count(), 1)
        await continueButton.click()
        await dialog.waitFor({ state: 'hidden', timeout })
        break
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const all = await waitBlueprints(page, context, [1, 2, 3])
    if (continuedOperationId) {
      const progress = readProjectDb(context.projectPath, db => db.prepare('SELECT usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
        .map(row => JSON.parse(row.usage_receipt_json).directoryProgress)
        .find(row => row?.operationId === continuedOperationId))
      assert.ok(progress?.continuationHandle?.runId, 'continuation did not bind to the original operation')
    }
    assert.equal(all[0].title, first[0].title, 'append rewrote committed first blueprint')
    assert.deepEqual(fixture.chapters, [1, 2, 3], 'provider dispatch duplicated or skipped a chapter')
    assert.deepEqual(fixture.blueprintQueue, [], 'provider dispatched fewer blueprint requests than selected range')
    assertTrustedAttempts(context.projectPath, 3)
    pass('U05.A02-batch-blueprints', 'U05.A02', '接着生成 2 章 appended ordered chapters 2–3 once and preserved chapter 1',
      { chapterNumbers: all.map(row => row.chapterNumber), requests: [...fixture.chapters], continuedOperationId })

    mark('U05.A03-single-draft')
    fixture.mode = 'draft'
    await assertStage(page, 'single-draft')
    await blueprintPage(page)
    await closeRunSheet(page)
    // 主按钮直接按蓝图与默认模型（这里就是隔离合成模型）开始写，不弹表单。
    await blueprint.writeButton(page).click()
    await passPreflight(page, blueprint.popover(page))
    const drafts = await waitDrafts(page, context, 1)
    assert.equal(drafts.length, 1)
    const savedDraft = readProjectDb(context.projectPath, db => db.prepare('SELECT c.body AS content FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(drafts[0].id))
    assert.equal(savedDraft.content, prose)
    assert.equal(drafts[0].status, 'draft', 'single write must remain an unfinalized draft')
    const draftRequests = fixture.requests.filter(row => row.mode === 'draft')
    assert.ok(draftRequests.length > 0)
    assert.ok(draftRequests.every(row => row.model === model.modelName && row.synopsisChapterOne && !row.synopsisChapterTwo))
    const draftOutlines = fixture.outlines.filter(row => row.mode === 'draft')
    assert.equal(draftOutlines.length, 1, 'single write should request exactly one short outline')
    assertTrustedAttempts(context.projectPath, 3 + draftOutlines.length + draftRequests.length)
    pass('U05.A03-single-draft', 'U05.A03', 'the blueprint page 写第 1 章 button persisted chapter 1 prose from the default provider with the current chapter synopsis',
      { draftId: drafts[0].id, chapterNumber: drafts[0].chapterNumber, units: prose.length, providerCalls: draftRequests.length })

    mark('U05.A04-batch-review')
    ;({ created: project, session: context } = await createConfiguredProject(app, page, 'U05B'))
    fixture.mode = 'blueprint'
    fixture.blueprintQueue = [1, 2]
    const blueprintRequestOffset = fixture.chapters.length
    await requestBlueprints(page, 2)
    await waitBlueprints(page, context, [1, 2])
    assert.deepEqual(fixture.chapters.slice(blueprintRequestOffset), [1, 2])
    assert.deepEqual(fixture.blueprintQueue, [])
    fixture.mode = 'draft_review'
    await batchDialog(page, 2, 'draft_review')
    batch = await waitBatch(page, context, 2, 'draft_review')
    const batchDrafts = await waitDrafts(page, context, 2)
    const savedBodies = readProjectDb(context.projectPath, db => db.prepare('SELECT d.chapter_number AS chapterNumber,c.body FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY d.chapter_number').all())
    assert.equal(batch.mode, 'draft_review')
    assert.deepEqual(batch.range, { startChapter: 1, endChapter: 2 })
    assert.equal(batch.targetUnits, 100)
    assert.equal(batch.modelId, model.id)
    assert.deepEqual(batch.completedChapters.map(row => row.chapterNumber), [1, 2])
    assert.deepEqual(batchDrafts.map(row => row.chapterNumber), [1, 2])
    assert.deepEqual(savedBodies.map(row => row.chapterNumber), [1, 2])
    assert.ok(savedBodies[0].body.includes(prose) && !savedBodies[0].body.includes(proseTwo))
    assert.ok(savedBodies[1].body.includes(proseTwo) && !savedBodies[1].body.includes(prose))
    assert.ok(batchDrafts.every(row => row.status === 'draft'), 'review mode finalized a draft')
    batchRequests = fixture.requests.filter(row => row.mode === 'draft_review')
    assert.ok(batchRequests.some(row => row.blueprintOne && row.synopsisChapterOne && !row.synopsisChapterTwo))
    assert.ok(batchRequests.some(row => row.blueprintTwo && row.synopsisChapterTwo && !row.synopsisChapterOne))
    assert.deepEqual(batchRequests.map(row => row.responseSha256), [createHash('sha256').update(prose).digest('hex'), createHash('sha256').update(proseTwo).digest('hex')])
    // 两章蓝图各一次；每章正文两次尝试：短细纲与正文。
    assertTrustedAttempts(context.projectPath, 2 + 2 * 2)
    await assertRunCompleted(page, '批量草稿待审 · 第 1 至 2 章')
    pass('U05.A04-batch-review', 'U05.A04', 'stage batch review froze mode/range/model/budget and persisted two distinct unfinalized drafts',
      { batchId: batch.batchId, range: batch.range, targetUnits: batch.targetUnits,
        draftIds: batchDrafts.map(row => row.id), requestCount: batchRequests.length })
    }

    if (!process.argv.includes('--stop-after-a04')) {
    if (!selectedAction) {
    mark('U05.A08-current-chapter-source-budget')
    const frozen = readProjectDb(context.projectPath, db => db.prepare('SELECT run_id AS runId,root_action_id AS rootActionId,binding_json AS binding FROM generation_runs').all()
      .map(row => ({ ...row, binding: JSON.parse(row.binding) }))
      .filter(row => row.binding.sourceManifest.operation === 'chapter-draft' && row.binding.sourceManifest.batchId === batch.batchId)
      .sort((left, right) => left.binding.sourceManifest.chapterNumber - right.binding.sourceManifest.chapterNumber))
    assert.deepEqual(frozen.map(row => row.binding.sourceManifest.chapterNumber), [1, 2])
    assert.ok(frozen.every(row => row.rootActionId === frozen[0].rootActionId))
    for (const [index, row] of frozen.entries()) {
      const inputs = row.binding.sourceManifest.authorInputs
      const chapterInfo = JSON.parse(inputs.find(item => item.id === 'draft:chapter-info').text)
      assert.equal(chapterInfo.chapterNumber, index + 1)
      assert.equal(chapterInfo.title, `旧港线索${index + 1}`)
      assert.equal(chapterInfo.keyEvents, `林岚发现第${index + 1}条旧港线索`)
      assert.equal(inputs.find(item => item.id === 'draft:target-units').text, '100')
      assert.equal(row.binding.sourceManifest.modelReceipt.modelId, model.id)
    }
    const budgetReceipts = readProjectDb(context.projectPath, db => db.prepare('SELECT run_id AS runId,usage_receipt_json AS receipt FROM generation_attempts').all()
      .filter(row => frozen.some(run => run.runId === row.runId))
      .map(row => JSON.parse(row.receipt))
      .filter(receipt => receipt.purpose === 'chapter-draft')
      .map(receipt => receipt.budgetDecision))
    assert.equal(budgetReceipts.length, 2)
    assert.ok(budgetReceipts.every(receipt => receipt?.decision === 'ready' && receipt.reservationLiabilityTokens > 0))
    assert.deepEqual(batchRequests.map(row => [row.synopsisChapterOne, row.synopsisChapterTwo]), [[true, false], [false, true]])
    pass('U05.A08-current-chapter-source-budget', 'U05.A08', 'two stage batch chapters used their own frozen blueprint, synopsis and one shared bounded root',
      { runIds: frozen.map(row => row.runId), rootActionId: frozen[0].rootActionId,
        requestedOutputTokens: budgetReceipts.map(row => row.requestedOutputTokens) })

    mark('U05.A06-stop-batch')
    ;({ created: project, session: context } = await createConfiguredProject(app, page, 'U05C'))
    fixture.mode = 'blueprint'
    fixture.blueprintQueue = [1, 2]
    await requestBlueprints(page, 2)
    await waitBlueprints(page, context, [1, 2])
    assert.deepEqual(fixture.blueprintQueue, [])
    fixture.mode = 'cancel_request'
    await batchDialog(page, 2, 'draft_review')
    const cancelDeadline = Date.now() + timeout
    while (!fixture.releaseFirst && Date.now() < cancelDeadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(typeof fixture.releaseFirst, 'function', 'first batch request did not reach controlled provider')
    await assertStage(page, 'batch-cancel')
    await runSheet.openFromPalette(page)
    await batchCancel(page).click()
    fixture.releaseFirst()
    fixture.releaseFirst = null
    await batchCancel(page).waitFor({ state: 'hidden', timeout })
    const cancelRequests = fixture.requests.filter(row => row.mode === 'cancel_request')
    assert.equal(cancelRequests.length, 1)
    assert.ok(cancelRequests[0].synopsisChapterOne && !cancelRequests[0].synopsisChapterTwo)
    // 「取消」按下后运行先进入取消中，按钮随即消失；等根动作真的记为已取消再读。
    let cancelState
    const cancelledDeadline = Date.now() + timeout
    while (Date.now() < cancelledDeadline) {
      cancelState = readProjectDb(context.projectPath, db => ({
        roots: db.prepare('SELECT action_json FROM generation_roots').all().map(row => JSON.parse(row.action_json)).filter(row => row.operation === 'batch-chapters'),
        drafts: db.prepare('SELECT chapter_number FROM drafts ORDER BY chapter_number').all(),
      }))
      if (cancelState.roots[0]?.status === 'cancelled') break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.equal(cancelState.roots.length, 1)
    assert.equal(cancelState.roots[0].status, 'cancelled')
    assert.ok(cancelState.drafts.every(row => row.chapter_number !== 2))
    pass('U05.A06-stop-batch', 'U05.A06', 'the run sheet 取消 stopped the active batch before chapter 2 dispatch or write',
      { rootActionId: cancelState.roots[0].rootActionId, status: cancelState.roots[0].status,
        requests: cancelRequests.length, savedChapters: cancelState.drafts.map(row => row.chapter_number) })
    }

    mark('U05.A07-failure-stops-before-next')
    ;({ created: project, session: context } = await createConfiguredProject(app, page, 'U05D'))
    fixture.mode = 'blueprint'
    fixture.blueprintQueue = [1, 2]
    await requestBlueprints(page, 2)
    await waitBlueprints(page, context, [1, 2])
    assert.deepEqual(fixture.blueprintQueue, [])
    const a07RequestOffset = fixture.requests.length
    fixture.mode = 'fail_request'
    await batchDialog(page, 2, 'draft_review')
    await batchCancel(page).waitFor({ state: 'visible', timeout })
    await batchCancel(page).waitFor({ state: 'hidden', timeout })
    const failedRequests = fixture.requests.slice(a07RequestOffset).filter(row => row.mode === 'fail_request')
    assert.equal(failedRequests.length, 1, 'initial batch failure should make one provider request before explicit retry')
    assert.ok(failedRequests.every(row => row.synopsisChapterOne && !row.synopsisChapterTwo))
    const failedDrafts = readProjectDb(context.projectPath, db => db.prepare('SELECT chapter_number FROM drafts ORDER BY chapter_number').all())
    assert.deepEqual(failedDrafts, [])
    const failedRuns = readProjectDb(context.projectPath, db => db.prepare('SELECT r.run_id AS runId,r.binding_json AS binding,a.attempt_json AS attempt,a.usage_receipt_json AS receipt FROM generation_runs r LEFT JOIN generation_attempts a ON a.run_id=r.run_id').all()
      .map(row => ({ ...row, source: JSON.parse(row.binding).sourceManifest })))
      .filter(row => row.source.operation === 'chapter-draft' && (!row.receipt || JSON.parse(row.receipt).purpose === 'chapter-draft'))
    assert.deepEqual(failedRuns.map(row => row.source.chapterNumber), [1], 'failed batch opened a later chapter run')
    assert.equal(JSON.parse(failedRuns[0].attempt).status, 'unknown')
    assert.equal(JSON.parse(failedRuns[0].receipt).result?.failureCode, 'GENERATION_PROVIDER_FAILED')
    const failedBatchId = failedRuns[0].source.batchId
    assert.ok(failedBatchId, 'failed chapter run is not bound to its batch')

    fixture.mode = 'retry_request'
    // 失败的批次在运行侧页「进行中」的「可恢复的内容」里，可以「继续此批次」。
    await runSheet.openFromPalette(page)
    await runSheet.tab(page, '进行中').click()
    await runSheet.recovery(page).getByRole('button', { name: '继续此批次', exact: true }).click()
    const retryDeadline = Date.now() + timeout
    while (!fixture.releaseRetry && Date.now() < retryDeadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(typeof fixture.releaseRetry, 'function', 'explicit batch retry did not reach controlled provider')
    const retryRequests = fixture.requests.slice(a07RequestOffset).filter(row => row.mode === 'retry_request')
    assert.equal(retryRequests.length, 1)
    assert.ok(retryRequests[0].synopsisChapterOne && !retryRequests[0].synopsisChapterTwo,
      'explicit retry did not target the failed first chapter')
    assert.deepEqual(readProjectDb(context.projectPath, db => db.prepare('SELECT chapter_number FROM drafts ORDER BY chapter_number').all()), [],
      'a draft was committed before the explicit retry response')
    const stillBlockedRuns = readProjectDb(context.projectPath, db => db.prepare('SELECT binding_json FROM generation_runs').all()
      .map(row => JSON.parse(row.binding_json).sourceManifest)
      .filter(source => source.operation === 'chapter-draft'))
    assert.ok(stillBlockedRuns.every(source => source.chapterNumber === 1), 'batch advanced while retry response was pending')

    fixture.mode = 'draft_review'
    fixture.releaseRetry()
    fixture.releaseRetry = null
    const resumedBatch = await waitBatch(page, context, 2, 'draft_review')
    assert.equal(resumedBatch.batchId, failedBatchId, 'retry did not resume the original batch')
    const resumedDrafts = await waitDrafts(page, context, 2)
    assert.deepEqual(resumedDrafts.map(row => row.chapterNumber), [1, 2])
    const resumedBodies = readProjectDb(context.projectPath, db => db.prepare('SELECT d.chapter_number AS chapterNumber,c.body FROM drafts d JOIN contents c ON c.id=d.content_id ORDER BY d.chapter_number').all())
    assert.ok(resumedBodies[0].body.includes(prose) && !resumedBodies[0].body.includes(proseTwo))
    assert.ok(resumedBodies[1].body.includes(proseTwo) && !resumedBodies[1].body.includes(prose))
    assert.equal(fixture.requests.slice(a07RequestOffset).filter(row => row.mode === 'draft_review').length, 1,
      'next chapter was not dispatched exactly once after the failed chapter retry succeeded')
    // 两稿进库时批次运行还在收尾；下一步要新建并打开另一部作品，先等运行侧页「进行中」清空，
    // 否则还在跑的批次与换作品重叠（曾在 A05 开头报主进程执行上下文被销毁，失败截图里批次停在 95%）。
    const activeWhenCommitted = await waitNoActiveRuns(page)
    pass('U05.A07-failure-stops-explicit-retry-continues', 'U05.A07',
      'first-chapter HTTP 503 stopped before chapter 2; 继续此批次 in the run sheet reissued chapter 1, then continued to chapter 2',
      { initialFailureRequests: failedRequests.length, retryRequests: retryRequests.length,
        batchId: resumedBatch.batchId, completedChapters: resumedBatch.completedChapters.map(row => row.chapterNumber),
        savedChapters: resumedDrafts.map(row => row.chapterNumber), activeRunsWhenDraftsCommitted: activeWhenCommitted })

    if (!selectedAction) {
    mark('U05.A05-auto-finalize')
    ;({ created: project, session: context } = await createConfiguredProject(app, page, 'U05E'))
    fixture.mode = 'blueprint'
    fixture.blueprintQueue = [1]
    await requestBlueprints(page, 1)
    await waitBlueprints(page, context, [1])
    assert.deepEqual(fixture.blueprintQueue, [])
    fixture.mode = 'auto_finalize'
    await batchDialog(page, 1, 'auto_finalize')
    const autoBatch = await waitBatch(page, context, 1, 'auto_finalize')
    assert.equal(autoBatch.projectId, project.projectId, 'batch binding belongs to another project')
    assert.ok(autoBatch.leaseId, 'batch binding has no project session epoch')
    const batchSession = { projectId: autoBatch.projectId, projectPath: context.projectPath,
      leaseId: autoBatch.leaseId }
    assert.equal(autoBatch.mode, 'auto_finalize')
    assert.equal(autoBatch.targetUnits, 100)
    assert.equal(autoBatch.modelId, model.id)
    const readAutoAttempts = () => readProjectDb(context.projectPath, db => db.prepare('SELECT r.binding_json AS binding,a.attempt_json AS attempt,a.usage_receipt_json AS receipt FROM generation_runs r JOIN generation_attempts a ON a.run_id=r.run_id').all()
      .map(row => ({ operation: JSON.parse(row.binding).sourceManifest.operation,
        purpose: JSON.parse(row.receipt).purpose,
        status: JSON.parse(row.attempt).status,
        trusted: JSON.parse(row.receipt).result?.usage?.trusted,
        finishReason: JSON.parse(row.receipt).result?.finishReason }))
      .filter(row => ['chapter-draft', 'finalized-chapter-notes', 'finalized-character-state'].includes(row.operation)
        && row.purpose !== 'chapter-draft-short-outline'))
    let finalized, confirmed, autoAttempts
    const finalizeDeadline = Date.now() + timeout
    while (Date.now() < finalizeDeadline) {
      finalized = readProjectDb(context.projectPath, db => db.prepare('SELECT d.id AS draftId,d.chapter_number AS chapterNumber,d.status,o.finalization_id AS finalizationId,o.content_hash AS contentHash,o.publication_status AS publicationStatus FROM drafts d LEFT JOIN finalization_outbox o ON o.draft_id=d.id ORDER BY d.chapter_number').all())
      confirmed = await invoke(page, 'generation:read-batch', { batchId: autoBatch.batchId }, batchSession)
      autoAttempts = readAutoAttempts()
      // postProcessComplete 只看关键后处理（入库检索与章节笔记）；角色状态建议不在其中，会在它之后才结算。
      if (finalized[0]?.publicationStatus === 'published' && confirmed.completedChapters[0]?.postProcessComplete
        && autoAttempts.some(row => row.operation === 'finalized-character-state' && row.status === 'settled')) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.equal(finalized.length, 1)
    assert.equal(finalized[0].status, 'finalized')
    assert.ok(finalized[0].finalizationId && finalized[0].publicationStatus === 'published')
    assert.equal(confirmed.completedChapters[0]?.postProcessComplete, true)
    assert.deepEqual(autoAttempts.map(row => row.operation).sort(), ['chapter-draft', 'finalized-chapter-notes', 'finalized-character-state'])
    assert.ok(autoAttempts.every(row => row.status === 'settled' && row.trusted === true && row.finishReason === 'stop'))
    const finalizedBody = readProjectDb(context.projectPath, db => db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=1').get().body)
    assert.equal(finalizedBody, prose)
    assert.equal(finalized[0].contentHash, createHash('sha256').update(finalizedBody).digest('hex'))
    assert.equal(fs.readFileSync(path.join(context.projectPath, '第1章 旧港线索1.txt'), 'utf8'), `第1章 旧港线索1\n\n${finalizedBody}`)
    assert.equal(fixture.requests.filter(row => row.mode === 'auto_finalize' && row.characterStateRequest).length, 1,
      'finalized character-state request was retried or skipped')
    await assertRunCompleted(page, '批量自动定稿 · 第 1 章')
    pass('U05.A05-auto-finalize', 'U05.A05', 'stage auto-finalize confirmation produced a published chapter with complete post-processing',
      { batchId: autoBatch.batchId, chapterNumber: finalized[0].chapterNumber, finalizationId: finalized[0].finalizationId,
        postProcessComplete: confirmed.completedChapters[0].postProcessComplete })

    mark('U13.A09-finalize-seal-three-states')
    const source = { draftId: finalized[0].draftId, chapterNumber: 1,
      finalizationId: finalized[0].finalizationId, contentHash: finalized[0].contentHash }
    await stage.openChapter(page, 1)
    const successfulRun = await invoke(page, 'db:post-process-get-latest-run', 'chapter_finalize', '1', context.projectPath, batchSession)
    const successfulSteps = await invoke(page, 'db:post-process-get-steps', successfulRun.id, context.projectPath, batchSession)
    assert.equal(successfulRun.triggerSourceType, 'chapter_finalize')
    assert.equal(successfulRun.triggerSourceId, `finalization:${source.finalizationId}`)
    assert.equal(successfulRun.sourceLabel, '第1章定稿')
    assert.equal(successfulRun.allCriticalPassed, true)
    assert.deepEqual(successfulSteps.map(step => step.stepKey), ['kb_import', 'chapter_notes', 'character_cards'])
    assert.ok(successfulSteps.every(step => step.ok && step.attemptCount > 0 && !step.errorMsg))
    const labels = successfulSteps.map(step => step.label)
    const stepRows = rows => labels.map(label => rows.find(row => row.label === label))
    await waitPostProcess(page, rows => stepRows(rows).every(row => row?.state === 'success' && row.detail === '完成'), 'natural post-process success')

    const injected = await invoke(page, 'db:post-process-create-run', {
      triggerSourceType: 'chapter_finalize', triggerSourceId: '1', sourceLabel: successfulRun.sourceLabel,
      steps: successfulSteps.map(step => ({ key: step.stepKey, label: step.label, critical: step.critical })),
      finalizedSource: source,
    }, context.projectPath, batchSession)
    assert.equal(injected.success, true, injected.error)
    assert.ok(injected.id && injected.id !== successfulRun.id)
    const pendingRun = await invoke(page, 'db:post-process-get-latest-run', 'chapter_finalize', '1', context.projectPath, batchSession)
    const pendingSteps = await invoke(page, 'db:post-process-get-steps', pendingRun.id, context.projectPath, batchSession)
    assert.equal(pendingRun.id, injected.id)
    assert.equal(pendingRun.triggerSourceId, successfulRun.triggerSourceId)
    assert.deepEqual(pendingSteps.map(step => [step.stepKey, step.ok, step.attemptCount, step.errorMsg]),
      successfulSteps.map(step => [step.stepKey, false, 0, '']))
    await reopenChapterOne(page)
    await waitPostProcess(page, rows => stepRows(rows).every(row => row?.state === 'pending' && row.detail === '处理中'), 'controlled pending post-process run')

    const sentinel = 'U13_A09_CONTROLLED_POST_PROCESS_FAILURE'
    const failed = await invoke(page, 'db:post-process-mark-step-failed', injected.id, pendingSteps[0].stepKey,
      sentinel, context.projectPath, batchSession)
    assert.equal(failed.success, true, failed.error)
    const failedRun = await invoke(page, 'db:post-process-get-latest-run', 'chapter_finalize', '1', context.projectPath, batchSession)
    const failedSteps = await invoke(page, 'db:post-process-get-steps', failedRun.id, context.projectPath, batchSession)
    assert.equal(failedRun.id, injected.id)
    assert.equal(failedRun.triggerSourceId, successfulRun.triggerSourceId)
    assert.equal(failedSteps[0].ok, false)
    assert.equal(failedSteps[0].attemptCount, 1)
    assert.equal(failedSteps[0].errorMsg, sentinel)
    assert.ok(failedSteps.slice(1).every(step => !step.ok && step.attemptCount === 0 && !step.errorMsg))
    await reopenChapterOne(page)
    await waitPostProcess(page, rows => {
      const [first, ...rest] = stepRows(rows)
      return first?.state === 'failed' && first.detail === sentinel && rest.every(row => row?.state === 'pending')
    }, 'controlled failed post-process step')
    await postProcess(page).getByRole('button', { name: '重试失败步骤' }).waitFor({ state: 'visible', timeout })
    pass('U13.A09-finalize-seal-three-states', 'U13.A09',
      'the stage chapter view lists the natural finalized success and the controlled source-bound pending and failed SQLite runs under 定稿后处理',
      { finalizedSource: source, naturalSuccessRunId: successfulRun.id, controlledRunId: injected.id,
        stepKeys: successfulSteps.map(step => step.stepKey), controlledFailure: sentinel })
    }
    }
  } catch (error) {
    failure = error
    if (page) {
      await page.screenshot({ path: path.join(receiptDir, 'failure.png') }).catch(() => {})
      try {
        failureUi = await page.evaluate(() => ({
          shell: document.querySelector('[data-shell-presentation]')?.getAttribute('data-shell-presentation'),
          bridge: { configurable: Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')?.configurable ?? null,
            invokeWritable: Object.getOwnPropertyDescriptor(window.aiNovelAPI ?? {}, 'invoke')?.writable ?? null },
          dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(node => node.getClientRects().length)
            .map(node => ({ title: node.querySelector('[id][data-radix-dialog-title], h2')?.textContent?.trim().slice(0, 100) ?? '',
              text: node.textContent?.trim().slice(0, 600) ?? '' })),
          alerts: [...document.querySelectorAll('[role="alert"], [role="status"]')].filter(node => node.getClientRects().length)
            .map(node => node.textContent?.trim().slice(0, 250)),
        }))
        if (context) {
          try {
            const core = await invoke(page, 'db:project-core-get', context.projectPath, context)
            const cards = await invoke(page, 'db:character-get-all', context.projectPath, context)
            failureUi.fixtureState = { premiseLength: core?.premise?.length ?? 0,
              worldbuildingLength: core?.worldbuilding?.length ?? 0, synopsisLength: core?.synopsis?.length ?? 0,
              charactersArchLength: core?.charactersArch?.length ?? 0, characterCards: cards.length }
          } catch (diagnosticError) { failureUi.fixtureError = String(diagnosticError) }
        }
      } catch (diagnosticError) { failureUi = { diagnosticError: String(diagnosticError) } }
    }
  }
  finally {
    if (app) try { exit = await quit(app) } catch (error) { failure ??= error }
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }
  const covered = new Set(steps.filter(step => step.outcome === 'PASS').map(step => step.actionId))
  const unverified = [...Array.from({ length: 8 }, (_, index) => `U05.A${String(index + 1).padStart(2, '0')}`), 'U13.A09']
    .filter(actionId => !covered.has(actionId))
  const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U05_PACKAGED_V3_PARTIAL',
    selectedActions: selectedAction ? [selectedAction] : null,
    evidenceLevel: 'electron', shell: 'stage', testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths,
    reuseDecision: { testedSha, changedPaths, differences: changedPaths.join(', ') || 'none',
      reason: 'fixed verified executable and asar hashes match, with no committed product-input changes since build; current driver hash is recorded' },
    sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean), dirtyProductPaths,
    packageSource: { testedSha, expectedExe, expectedAsar },
    artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
    driver: { path: fileURLToPath(import.meta.url), sha256: fileHash(fileURLToPath(import.meta.url)) },
    profile: { canonical: profile.canonical, userData: profile.userData, projectRoot: profile.projects },
    project: { path: project?.projectPath ?? null }, syntheticRequests: fixture.requests, syntheticShortOutlines: fixture.outlines,
    externalModelRequests: 0, steps, unverified, failedStep: failure ? currentStep : null,
    error: failure ? String(failure) : null, failureUi, exit }
  assert.equal(JSON.stringify(receipt).includes(model.apiKey), false)
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
