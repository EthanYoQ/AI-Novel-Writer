/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const testedSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
const packageDir = option('package-dir') && path.resolve(repository, option('package-dir'))
assert(packageDir && testedSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
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
assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|pages\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)),
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
const proseTwo = '守塔人到北堤寻找钟锤，盐仓船票揭示去向。林岚查出船票上的日期晚于地图失踪之夜，于是先封存票据，再请港务员核对出航簿。北堤钟楼传来三声短响，二人决定追查最后一艘离港货船。'
const steps = []
const timeout = 60_000
const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
  AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
  APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]

const pass = (stepId, actionId, assertion, observed) => steps.push({ stepId, actionId, outcome: 'PASS', assertion, observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
async function assertWriter(page, step) {
  const shell = page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]')
  await shell.waitFor({ state: 'visible', timeout })
  assert.equal(await shell.getAttribute('data-shell-variant'), 'v3', `${step}: not V3 Writer`)
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
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout })
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
async function selectWriter(page) {
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const previous = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...previous, shellPreference: 'writer',
      revision: Number(previous.revision ?? 0) + 1, origin: 'author' }))
  })
  await page.reload()
  await assertWriter(page, 'writer-test-profile-selection')
}
async function openProject(page, name = projectName) {
  await assertWriter(page, 'project-open')
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  if (!await page.locator('.writer-shelf').isVisible()) {
    await page.locator('.writer-left-rail button[title="欢迎页"]').click()
  }
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${name}》` }).click()
  await page.locator('.writer-project-tree').getByText(name, { exact: true }).waitFor({ state: 'visible' })
}
async function blueprintPage(page) {
  await assertWriter(page, 'blueprint-page')
  await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
  await page.getByRole('button', { name: 'AI 生成蓝图' }).waitFor({ state: 'visible' })
}
async function requestBlueprints(page, count) {
  await assertWriter(page, `blueprints-${count}`)
  await page.getByRole('button', { name: 'AI 生成蓝图' }).click()
  const dialog = page.getByRole('dialog', { name: '生成章节蓝图' })
  await dialog.locator('input[type="number"]').first().fill(String(count))
  await dialog.getByRole('button', { name: '开始生成' }).click()
  await dialog.waitFor({ state: 'hidden', timeout })
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
async function batchDialog(page, count, mode) {
  await assertWriter(page, `batch-${mode}`)
  await blueprintPage(page)
  await page.getByRole('button', { name: '批量创作' }).click()
  const dialog = page.getByRole('dialog', { name: '批量创作任务' })
  await dialog.locator('#batch-chapter-count').fill(String(count))
  await dialog.locator('#batch-chapter-words-target').fill('100')
  await dialog.locator(`input[name="batch-completion-mode"][value="${mode}"]`).check()
  await dialog.locator('#batch-writing-model').selectOption(model.id)
  await dialog.getByRole('button', { name: mode === 'draft_review' ? '启动批量创作' : '继续确认自动定稿' }).click()
  if (mode === 'auto_finalize') await dialog.getByRole('button', { name: '确认自动定稿并启动' }).click()
  await dialog.waitFor({ state: 'hidden', timeout })
}
async function createConfiguredProject(page, name) {
  const created = await invoke(page, 'project:create', { path: profile.projects, name,
    genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'db:project-core-update', { premise, worldbuilding, synopsis }, created.projectPath, session)).success, true)
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
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'review Writer U05 receipt',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const fixture = { requests: [], chapters: [], mode: 'blueprint', blueprintQueue: [1], releaseFirst: null }
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
  let app, page, failure, failureUi, currentStep = 'setup', context, project, exit
  const mark = step => { currentStep = step; process.stderr.write(`${step}\n`) }
  try {
    verifyWindowsPackage(packageDir)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    ;({ app, page } = await launch(server.address().port))
    assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
    await selectWriter(page)
    ;({ created: project, session: context } = await createConfiguredProject(page, projectName))

    mark('U05.A01-single-blueprint')
    await requestBlueprints(page, 1)
    const first = await waitBlueprints(page, context, [1])
    assert.equal(first[0].title, '旧港线索1')
    assert.deepEqual(fixture.chapters, [1])
    assert.deepEqual(fixture.blueprintQueue, [])
    assertTrustedAttempts(context.projectPath, 1)
    pass('U05.A01-single-blueprint', 'U05.A01', 'Writer button produced and persisted exactly chapter 1 blueprint',
      { chapterNumbers: first.map(row => row.chapterNumber), requests: [...fixture.chapters] })

    mark('U05.A02-batch-blueprints')
    fixture.blueprintQueue = [2, 3]
    await requestBlueprints(page, 2)
    let continuedOperationId = null
    const appendDeadline = Date.now() + timeout
    while (Date.now() < appendDeadline) {
      const saved = readProjectDb(context.projectPath, db => db.prepare('SELECT chapter_number FROM blueprints ORDER BY chapter_number').all().map(row => row.chapter_number))
      if (JSON.stringify(saved) === '[1,2,3]') break
      if (JSON.stringify(saved) === '[1,2]' && await page.locator('[role="alert"],[role="status"]').filter({ hasText: 'DIRECTORY_PARTIAL_COMMIT' }).isVisible()) {
        const progress = readProjectDb(context.projectPath, db => db.prepare('SELECT usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
          .map(row => JSON.parse(row.usage_receipt_json).directoryProgress)
          .find(row => row?.requestedRange?.startChapter === 2 && row.requestedRange.endChapter === 3))
        assert.deepEqual(progress?.committedRange, { startChapter: 2, endChapter: 2 })
        assert.deepEqual(progress?.remainingRange, { startChapter: 3, endChapter: 3 })
        assert.ok(progress.operationId && !progress.continuationHandle)
        continuedOperationId = progress.operationId
        await assertWriter(page, 'blueprint-partial-continuation')
        await page.getByRole('button', { name: 'AI 生成蓝图' }).click()
        const dialog = page.getByRole('dialog', { name: '生成章节蓝图' })
        const card = dialog.getByText('已保存第 2–2 章蓝图。', { exact: true }).locator('..')
        const continueButton = card.getByRole('button', { name: '继续第 3–3 章（沿用原预算）', exact: true })
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
    pass('U05.A02-batch-blueprints', 'U05.A02', 'Writer append persisted ordered chapters 2–3 once and preserved chapter 1',
      { chapterNumbers: all.map(row => row.chapterNumber), requests: [...fixture.chapters], continuedOperationId })

    mark('U05.A03-single-draft')
    fixture.mode = 'draft'
    await assertWriter(page, 'single-draft')
    await page.getByRole('button', { name: '写作第1章' }).click()
    const writing = page.getByRole('dialog', { name: /创作/ })
    await writing.locator('#chapter-writing-model').selectOption(model.id)
    await writing.getByPlaceholder('3000').fill('100')
    await writing.getByRole('button', { name: '开始创作' }).click()
    await writing.waitFor({ state: 'hidden', timeout })
    const drafts = await waitDrafts(page, context, 1)
    assert.equal(drafts.length, 1)
    const savedDraft = readProjectDb(context.projectPath, db => db.prepare('SELECT c.body AS content FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(drafts[0].id))
    assert.equal(savedDraft.content, prose)
    assert.equal(drafts[0].status, 'draft', 'single write must remain an unfinalized draft')
    const draftRequests = fixture.requests.filter(row => row.mode === 'draft')
    assert.ok(draftRequests.length > 0)
    assert.ok(draftRequests.every(row => row.model === model.modelName && row.synopsisChapterOne && !row.synopsisChapterTwo))
    assertTrustedAttempts(context.projectPath, 4)
    pass('U05.A03-single-draft', 'U05.A03', 'Writer write button persisted chapter 1 prose from selected provider with current chapter synopsis',
      { draftId: drafts[0].id, chapterNumber: drafts[0].chapterNumber, units: prose.length, providerCalls: draftRequests.length })

    mark('U05.A04-batch-review')
    ;({ created: project, session: context } = await createConfiguredProject(page, 'U05B'))
    fixture.mode = 'blueprint'
    fixture.blueprintQueue = [1, 2]
    const blueprintRequestOffset = fixture.chapters.length
    await requestBlueprints(page, 2)
    await waitBlueprints(page, context, [1, 2])
    assert.deepEqual(fixture.chapters.slice(blueprintRequestOffset), [1, 2])
    assert.deepEqual(fixture.blueprintQueue, [])
    fixture.mode = 'draft_review'
    await batchDialog(page, 2, 'draft_review')
    const batch = await waitBatch(page, context, 2, 'draft_review')
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
    const batchRequests = fixture.requests.filter(row => row.mode === 'draft_review')
    assert.ok(batchRequests.some(row => row.blueprintOne && row.synopsisChapterOne && !row.synopsisChapterTwo))
    assert.ok(batchRequests.some(row => row.blueprintTwo && row.synopsisChapterTwo && !row.synopsisChapterOne))
    assert.deepEqual(batchRequests.map(row => row.responseSha256), [createHash('sha256').update(prose).digest('hex'), createHash('sha256').update(proseTwo).digest('hex')])
    assertTrustedAttempts(context.projectPath, 4)
    await page.locator('.writer-ai-panel').getByRole('button', { name: /第1–2章/ }).last().click()
    await page.locator('.writer-ai-panel').getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout })
    pass('U05.A04-batch-review', 'U05.A04', 'V3 batch review froze mode/range/model/budget and persisted two distinct unfinalized drafts',
      { batchId: batch.batchId, range: batch.range, targetUnits: batch.targetUnits,
        draftIds: batchDrafts.map(row => row.id), requestCount: batchRequests.length })

    if (!process.argv.includes('--stop-after-a04')) {
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
      .map(row => JSON.parse(row.receipt).budgetDecision))
    assert.equal(budgetReceipts.length, 2)
    assert.ok(budgetReceipts.every(receipt => receipt?.decision === 'ready' && receipt.reservationLiabilityTokens > 0))
    assert.deepEqual(batchRequests.map(row => [row.synopsisChapterOne, row.synopsisChapterTwo]), [[true, false], [false, true]])
    pass('U05.A08-current-chapter-source-budget', 'U05.A08', 'two Writer batch chapters used their own frozen blueprint, synopsis and one shared bounded root',
      { runIds: frozen.map(row => row.runId), rootActionId: frozen[0].rootActionId,
        requestedOutputTokens: budgetReceipts.map(row => row.requestedOutputTokens) })

    mark('U05.A06-stop-batch')
    ;({ created: project, session: context } = await createConfiguredProject(page, 'U05C'))
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
    await assertWriter(page, 'batch-cancel')
    await page.getByTitle('取消任务', { exact: true }).last().click()
    fixture.releaseFirst()
    fixture.releaseFirst = null
    await page.getByTitle('取消任务', { exact: true }).waitFor({ state: 'hidden', timeout })
    const cancelRequests = fixture.requests.filter(row => row.mode === 'cancel_request')
    assert.equal(cancelRequests.length, 1)
    assert.ok(cancelRequests[0].synopsisChapterOne && !cancelRequests[0].synopsisChapterTwo)
    const cancelState = readProjectDb(context.projectPath, db => ({
      roots: db.prepare('SELECT action_json FROM generation_roots').all().map(row => JSON.parse(row.action_json)).filter(row => row.operation === 'batch-chapters'),
      drafts: db.prepare('SELECT chapter_number FROM drafts ORDER BY chapter_number').all(),
    }))
    assert.equal(cancelState.roots.length, 1)
    assert.equal(cancelState.roots[0].status, 'cancelled')
    assert.ok(cancelState.drafts.every(row => row.chapter_number !== 2))
    pass('U05.A06-stop-batch', 'U05.A06', 'Writer cancel stopped the active batch before chapter 2 dispatch or write',
      { rootActionId: cancelState.roots[0].rootActionId, status: cancelState.roots[0].status,
        requests: cancelRequests.length, savedChapters: cancelState.drafts.map(row => row.chapter_number) })

    mark('U05.A07-failure-stops-before-next')
    ;({ created: project, session: context } = await createConfiguredProject(page, 'U05D'))
    fixture.mode = 'blueprint'
    fixture.blueprintQueue = [1, 2]
    await requestBlueprints(page, 2)
    await waitBlueprints(page, context, [1, 2])
    assert.deepEqual(fixture.blueprintQueue, [])
    fixture.mode = 'fail_request'
    await batchDialog(page, 2, 'draft_review')
    await page.getByTitle('取消任务', { exact: true }).waitFor({ state: 'visible', timeout })
    await page.getByTitle('取消任务', { exact: true }).waitFor({ state: 'hidden', timeout })
    const failedRequests = fixture.requests.filter(row => row.mode === 'fail_request')
    assert.ok(failedRequests.length > 0)
    assert.ok(failedRequests.every(row => row.synopsisChapterOne && !row.synopsisChapterTwo))
    const failedDrafts = readProjectDb(context.projectPath, db => db.prepare('SELECT chapter_number FROM drafts ORDER BY chapter_number').all())
    assert.deepEqual(failedDrafts, [])
    const failedRuns = readProjectDb(context.projectPath, db => db.prepare('SELECT r.run_id AS runId,r.binding_json AS binding,a.attempt_json AS attempt,a.usage_receipt_json AS receipt FROM generation_runs r LEFT JOIN generation_attempts a ON a.run_id=r.run_id').all()
      .map(row => ({ ...row, source: JSON.parse(row.binding).sourceManifest })))
      .filter(row => row.source.operation === 'chapter-draft')
    assert.deepEqual(failedRuns.map(row => row.source.chapterNumber), [1], 'failed batch opened a later chapter run')
    assert.equal(JSON.parse(failedRuns[0].attempt).status, 'unknown')
    assert.equal(JSON.parse(failedRuns[0].receipt).result?.failureCode, 'GENERATION_PROVIDER_FAILED')
    pass('U05.A07-failure-stops-before-next', 'U05.A07', 'controlled first-chapter provider failure ended Writer batch with no later dispatch or draft',
      { attemptedRequests: failedRequests.length, attemptedChapters: [1], savedChapters: [] })

    mark('U05.A05-auto-finalize')
    ;({ created: project, session: context } = await createConfiguredProject(page, 'U05E'))
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
    let finalized, confirmed
    const finalizeDeadline = Date.now() + timeout
    while (Date.now() < finalizeDeadline) {
      finalized = readProjectDb(context.projectPath, db => db.prepare('SELECT d.id AS draftId,d.chapter_number AS chapterNumber,d.status,o.finalization_id AS finalizationId,o.content_hash AS contentHash,o.publication_status AS publicationStatus FROM drafts d LEFT JOIN finalization_outbox o ON o.draft_id=d.id ORDER BY d.chapter_number').all())
      confirmed = await invoke(page, 'generation:read-batch', { batchId: autoBatch.batchId }, batchSession)
      if (finalized[0]?.publicationStatus === 'published' && confirmed.completedChapters[0]?.postProcessComplete) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.equal(finalized.length, 1)
    assert.equal(finalized[0].status, 'finalized')
    assert.ok(finalized[0].finalizationId && finalized[0].publicationStatus === 'published')
    assert.equal(confirmed.completedChapters[0]?.postProcessComplete, true)
    const autoAttempts = readProjectDb(context.projectPath, db => db.prepare('SELECT r.binding_json AS binding,a.attempt_json AS attempt,a.usage_receipt_json AS receipt FROM generation_runs r JOIN generation_attempts a ON a.run_id=r.run_id').all()
      .map(row => ({ operation: JSON.parse(row.binding).sourceManifest.operation,
        status: JSON.parse(row.attempt).status,
        trusted: JSON.parse(row.receipt).result?.usage?.trusted,
        finishReason: JSON.parse(row.receipt).result?.finishReason }))
      .filter(row => ['chapter-draft', 'finalized-chapter-notes', 'finalized-character-state'].includes(row.operation)))
    assert.deepEqual(autoAttempts.map(row => row.operation).sort(), ['chapter-draft', 'finalized-chapter-notes', 'finalized-character-state'])
    assert.ok(autoAttempts.every(row => row.status === 'settled' && row.trusted === true && row.finishReason === 'stop'))
    const finalizedBody = readProjectDb(context.projectPath, db => db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=1').get().body)
    assert.equal(finalizedBody, prose)
    assert.equal(finalized[0].contentHash, createHash('sha256').update(finalizedBody).digest('hex'))
    assert.equal(fs.readFileSync(path.join(context.projectPath, '第1章 旧港线索1.txt'), 'utf8'), `第1章 旧港线索1\n\n${finalizedBody}`)
    assert.equal(fixture.requests.filter(row => row.mode === 'auto_finalize' && row.characterStateRequest).length, 1,
      'finalized character-state request was retried or skipped')
    await page.locator('.writer-ai-panel').getByRole('button', { name: /第1–1章/ }).last().click()
    await page.locator('.writer-ai-panel').getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout })
    pass('U05.A05-auto-finalize', 'U05.A05', 'Writer auto-finalize confirmation produced a published chapter with complete post-processing',
      { batchId: autoBatch.batchId, chapterNumber: finalized[0].chapterNumber, finalizationId: finalized[0].finalizationId,
        postProcessComplete: confirmed.completedChapters[0].postProcessComplete })

    mark('U13.A09-finalize-seal-three-states')
    const source = { draftId: finalized[0].draftId, chapterNumber: 1,
      finalizationId: finalized[0].finalizationId, contentHash: finalized[0].contentHash }
    const manuscript = page.locator('.writer-project-tree .tree-item[title="点击打开 — 第1章 旧港线索1"]')
    await manuscript.click()
    await page.getByText('第1章定稿 完成（3/3）', { exact: true }).waitFor({ state: 'visible', timeout })
    const successfulRun = await invoke(page, 'db:post-process-get-latest-run', 'chapter_finalize', '1', context.projectPath, batchSession)
    const successfulSteps = await invoke(page, 'db:post-process-get-steps', successfulRun.id, context.projectPath, batchSession)
    assert.equal(successfulRun.triggerSourceType, 'chapter_finalize')
    assert.equal(successfulRun.triggerSourceId, `finalization:${source.finalizationId}`)
    assert.equal(successfulRun.sourceLabel, '第1章定稿')
    assert.equal(successfulRun.allCriticalPassed, true)
    assert.deepEqual(successfulSteps.map(step => step.stepKey), ['kb_import', 'chapter_notes', 'character_cards'])
    assert.ok(successfulSteps.every(step => step.ok && step.attemptCount > 0 && !step.errorMsg))

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
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
    await manuscript.click()
    await page.getByText('第1章定稿 正在处理（0/3）', { exact: true }).waitFor({ state: 'visible', timeout })

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
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
    await manuscript.click()
    await page.getByText('第1章定稿 — 1 个步骤失败', { exact: true }).click()
    await page.getByText(successfulSteps[0].label, { exact: true }).waitFor({ state: 'visible', timeout })
    await page.getByText(sentinel, { exact: true }).waitFor({ state: 'visible', timeout })
    pass('U13.A09-finalize-seal-three-states', 'U13.A09',
      'V3 DraftEditor projects the natural finalized success and controlled source-bound pending/failure SQLite runs',
      { finalizedSource: source, naturalSuccessRunId: successfulRun.id, controlledRunId: injected.id,
        stepKeys: successfulSteps.map(step => step.stepKey), controlledFailure: sentinel })
    }
  } catch (error) {
    failure = error
    if (page) {
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
    evidenceLevel: 'electron', testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths,
    reuseDecision: { testedSha, changedPaths, differences: changedPaths.join(', ') || 'none',
      reason: 'fixed verified V3 executable and asar hashes match, with no committed product-input changes since build; current driver hash is recorded' },
    sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean), dirtyProductPaths,
    packageSource: { testedSha, expectedExe, expectedAsar },
    artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
    driver: { path: fileURLToPath(import.meta.url), sha256: fileHash(fileURLToPath(import.meta.url)) },
    profile: { canonical: profile.canonical, userData: profile.userData, projectRoot: profile.projects },
    project: { path: project?.projectPath ?? null }, syntheticRequests: fixture.requests,
    externalModelRequests: 0, steps, unverified, failedStep: failure ? currentStep : null,
    error: failure ? String(failure) : null, failureUi, exit }
  assert.equal(JSON.stringify(receipt).includes(model.apiKey), false)
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
