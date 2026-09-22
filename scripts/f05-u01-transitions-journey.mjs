/* global process */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = fileURLToPath(import.meta.url)
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const driverSha256 = hash(scriptPath)
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trimEnd()
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = argument('package-dir')
const packageSourceSha = argument('package-source-sha')
const expectedExe = argument('exe-sha256')
const expectedAsar = argument('asar-sha256')
assert(packageDir && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const priorPath = path.join(repository, '.runtime', '.cache', 'f05-u01-transitions', 'e0d1c6ed-4358-4840-98b1-155776f151a2', 'receipt.json')
const runId = randomUUID()
const receiptPath = path.join(repository, '.runtime', '.cache', 'f05-u01-transitions', runId, 'receipt.json')
const screenshotPath = path.join(path.dirname(receiptPath), 'v3-shelf-1440x900.png')
const nativePickerHelper = path.join(repository, 'scripts', 'f05-u16-native-picker.ps1')
const deleteEntryScreenshotPath = path.join(path.dirname(receiptPath), 'v3-delete-entry-1440x900.png')
const scratch = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel', `u01-${runId.slice(0, 8)}`)
const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(key => [key, path.join(scratch, key)]))
const names = { a: '转场甲', b: '转场乙', c: '转场丙' }
const Database = createRequire(import.meta.url)('better-sqlite3')
const fixtureConfig = { a: `甲配置 ${runId}`, b: `乙配置 ${runId}` }
const fixtureBody = { a: `甲正文 ${runId}`, b: `乙正文 ${runId}` }
const editorBody = locator => locator.evaluate(element => Array.from(element.querySelectorAll('.cm-line'), line => {
  const copy = line.cloneNode(true)
  copy.querySelector('.cm-lp-paperhead')?.remove()
  return copy.textContent
}).join('\n'))
const steps = []
let currentStep = 'setup'
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, assertion, outcome: 'PASS' })
async function invoke(page, channel, ...args) {
  let timer
  try {
    return await Promise.race([
      page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`IPC timeout: ${channel}`)), 20_000) }),
    ])
  } finally { clearTimeout(timer) }
}
const writer = page => page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible', timeout: 30_000 })

function provenance() {
  assert(fs.existsSync(priorPath), 'prior U01 receipt missing')
  const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'))
  assert.equal(prior.outcome, 'PARTIAL')
  const testedSha = packageSourceSha
  const executionHead = git('rev-parse', 'HEAD')
  const changedPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`).split('\n').filter(Boolean)
  assert.equal(git('diff', '--name-only', `${testedSha}..${executionHead}`, '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '',
  'product inputs changed since package source SHA')
  const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
  const deleteEntrySource = new Set(['src/components/pages/v2/WelcomePageV2.tsx',
    'src/components/pages/v2/use-project-overview.tsx', 'src/components/panels/sidebar/HomeSidebarPanel.tsx',
    'src/styles/redesign/v3-magazine.css', 'src/components/project-delete-action.ts',
    'src/components/pages/v2/__tests__/writer-project-overview.browser.tsx'])
  assert(dirtyProductPaths.every(line => deleteEntrySource.has(line.slice(3))
    || /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|panels|pages\/v2)\/__tests__\/__screenshots__\/$/.test(line)),
  'Product inputs changed beyond the frozen delete-entry patch and test screenshots')
  assert.equal(hash(executablePath), expectedExe)
  assert.equal(hash(asarPath), expectedAsar)
  const priorOwnerChanges = git('diff', '--name-only', `${prior.testedSha}..${testedSha}`, '--', 'src/stores/project-store.ts',
    'src/services/project-transition.ts', 'src/stores/editor-store.ts', 'electron/controllers/project-controller.ts').split('\n').filter(Boolean)
  return { testedSha, executionHead, changedPaths, dirtyProductPaths,
    packageSourceNote: dirtyProductPaths.some(line => deleteEntrySource.has(line.slice(3)))
      ? 'Package base commit plus uncommitted delete-entry patch; exe and asar hashes identify the tested artifact'
      : 'Package built from the tested source commit; exe and asar hashes identify the tested artifact',
    artifactHashes: { executable: hash(executablePath), asar: hash(asarPath) },
    priorReceipt: { path: priorPath, sha256: hash(priorPath), testedSha: prior.testedSha, ownerChanges: priorOwnerChanges },
    reuseReason: 'Old Writer UI is not reused; current V3 shell is exercised. Prior core proof is bounded by owner changes, including project-store.' }
}

async function launch(fixturePort) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  if (fixturePort) await app.evaluate((_, port) => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input))
      if (url.origin !== 'https://api.openai.com' || !url.pathname.startsWith('/v1/')) throw new Error('F05_U01_NETWORK_REFUSED')
      return originalFetch(`http://127.0.0.1:${port}${url.pathname}`, options)
    }
  }, fixturePort)
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(12_000)
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), roots.userData)
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  return { app, page }
}

async function quit(app) {
  const child = app.process()
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); return true })
  assert.deepEqual(await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Electron did not exit')), 10_000))]),
    { code: 0, signal: null })
}

async function home(page) {
  await writer(page)
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) {
    await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await notice.waitFor({ state: 'detached' })
  }
  if (!await page.locator('.writer-welcome').isVisible()) await page.locator('.writer-left-rail button[title="欢迎页"]').click()
  await page.locator('.writer-shelf').waitFor({ state: 'visible' })
}

async function open(page, name) {
  await home(page)
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${name}》` }).click()
  await page.locator('.writer-project-tree').getByText(name, { exact: true }).waitFor({ state: 'visible' })
}
function chooseNativeFile(target) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nativePickerHelper,
    '-Target', target, '-ExpectedExe', executablePath, '-DialogTitle', '选择作者原稿文件'],
  { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, `native picker: ${result.stderr || result.stdout || result.error}`)
  const evidence = JSON.parse(result.stdout.trim())
  assert.equal(evidence.typedExact, true)
  assert.equal(evidence.submitted, true)
  return evidence
}
async function assertProjectFacts(page, projectPath, config, body) {
  assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projectPath)
  await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
  assert.equal(await page.getByPlaceholder('在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置...').inputValue(), config)
  await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
  assert.equal(await editorBody(page.locator('.cm-content[contenteditable="true"]')), body)
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
  try {
    assert.equal(db.prepare("SELECT core_outline FROM project_core WHERE id = 'main'").get().core_outline, config)
    assert.equal(db.prepare('SELECT contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id WHERE drafts.chapter_number = 1').get().body, body)
  } finally { db.close() }
}

async function edit(page, marker) {
  await writer(page)
  await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
  const field = page.getByPlaceholder('在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置...')
  await field.fill(marker)
  assert.equal(await field.inputValue(), marker)
  await page.getByText('未保存', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
}

async function decision(page, save, discard) {
  const first = page.getByRole('dialog').filter({ hasText: '处理未保存内容' })
  await first.waitFor({ state: 'visible' })
  await first.getByRole('button', { name: save ? '保存并继续' : '其他选项' }).click()
  if (!save) {
    const second = page.getByRole('dialog').filter({ hasText: '放弃未保存内容' })
    await second.waitFor({ state: 'visible' })
    await second.getByRole('button', { name: discard ? '放弃并继续' : '取消' }).click()
  }
}
async function waitForOpenGate(app, state) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await app.evaluate((_, key) => globalThis.__u01OpenGate?.[key] === true, state)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`U01.A09: project open did not reach ${state}`)
}

async function main() {
  const source = provenance()
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u01',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${scratch}' -Recurse -Force`,
    retainReason: 'Synthetic Writer project transition receipt' }, null, 2))
  let session
  let shelfScreenshot
  let deleteEntryScreenshot
  const rendererLogs = []
  const a10Only = process.argv.includes('--a10-only')
  const model = { id: 'f05-u01-synthetic', name: 'U01 离线合成模型', provider: 'openai', protocol: 'openai',
    modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'f05-u01-offline-only',
    maxTokens: 4096, temperature: 0.7, purposes: ['generation'] }
  const modelRequests = []
  let fixtureServer
  let fixturePort
  try {
    if (a10Only) {
      fixtureServer = createServer(async (request, response) => {
        const authorized = request.headers.authorization === `Bearer ${model.apiKey}`
        const accepted = request.method === 'POST'
          && ['/v1/chat/completions', '/v1/embeddings'].includes(request.url) && authorized
        const kind = request.url === '/v1/embeddings' ? 'embedding'
          : modelRequests.filter(item => item.path === '/v1/chat/completions').length === 0 ? 'chapter-notes' : 'character-cards'
        modelRequests.push({ method: request.method, path: request.url, authorized, accepted, kind })
        if (!accepted) { response.writeHead(403).end(); return }
        if (kind === 'embedding') {
          let body = ''
          for await (const chunk of request) body += chunk
          const input = JSON.parse(body).input
          const texts = Array.isArray(input) ? input : [input]
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ data: texts.map((_, index) => ({ index,
            embedding: Array.from({ length: 1536 }, (_, dimension) => dimension === index % 1536 ? 1 : 0) })) }))
          return
        }
        request.resume()
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const content = kind === 'chapter-notes'
          ? '第1章剧情要点：合成作者原稿按原文字节导入，权威章节已经定稿。'
          : '{"updates":[]}'
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })
      await new Promise((resolve, reject) => { fixtureServer.once('error', reject); fixtureServer.listen(0, '127.0.0.1', resolve) })
      fixturePort = fixtureServer.address().port
    }
    currentStep = 'fixture'
    session = await launch(fixturePort)
    if (a10Only) {
      assert.equal((await invoke(session.page, 'llm:save-model', model)).success, true)
      assert.equal((await invoke(session.page, 'llm:set-default-model', model.id)).success, true)
    }
    const projects = {}
    const projectIds = {}
    for (const key of ['a', 'b']) {
      const created = await invoke(session.page, 'project:create', { path: roots.projects, name: names[key],
        genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID())
      assert.equal(created.success, true, created.error)
      projects[key] = created.projectPath
      projectIds[key] = created.projectId
      const opened = await invoke(session.page, 'project:open', projects[key], randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const context = { projectId: projectIds[key], projectPath: projects[key], leaseId: opened.project.sessionLease }
      const saved = await invoke(session.page, 'project:save', projectIds[key],
        { ...opened.project, novelConfig: { ...opened.project.novelConfig, coreOutline: fixtureConfig[key] } }, projects[key], context)
      assert.equal(saved.success, true, saved.error)
      const draft = await invoke(session.page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
        content: fixtureBody[key], wordCount: fixtureBody[key].length }, projects[key], context)
      assert.equal(draft.success, true, draft.error)
    }
    const dbA = new Database(path.join(projects.a, '.ai-novel', 'project.db'), { fileMustExist: true })
    const coreOutline = () => dbA.prepare("SELECT core_outline FROM project_core WHERE id = 'main'").get().core_outline
    const projectFile = path.join(projects.a, '.ai-novel', 'project.json')
    const initialCore = coreOutline()
    await session.page.evaluate(key => {
      const previous = JSON.parse(localStorage.getItem(key) ?? '{}')
      localStorage.setItem(key, JSON.stringify({ ...previous, shellPreference: 'writer', revision: Number(previous.revision ?? 0) + 1, origin: 'author' }))
    }, 'ai-novel-writer-appearance')
    await quit(session.app)
    session = await launch(fixturePort)
    const { page } = session
    page.on('console', message => rendererLogs.push(message.text()))
    await writer(page)
    const shelfWindow = await session.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1440, 900)
      window.webContents.setZoomFactor(1)
      return { windowSize: window.getSize(), contentSize: window.getContentSize(), zoomFactor: window.webContents.getZoomFactor() }
    })
    await home(page)
    const shelfPng = await page.screenshot({ path: screenshotPath })
    shelfScreenshot = { path: screenshotPath, sha256: hash(screenshotPath),
      pixels: [shelfPng.readUInt32BE(16), shelfPng.readUInt32BE(20)], ...shelfWindow,
      profile: roots.userData, artifactHashes: source.artifactHashes }
    assert.deepEqual(shelfScreenshot.pixels, [1440, 900])
    assert.deepEqual(shelfWindow.contentSize, [1440, 900])
    assert.equal(shelfWindow.zoomFactor, 1)

    if (a10Only) {
      currentStep = 'U01.A10-cancel'
      const sourceFile = path.join(scratch, `第1章-合成原稿-${runId}.txt`)
      const invalidFile = path.join(scratch, `第1章-无正文-${runId}.txt`)
      const sourceBody = `合成作者原稿正文 ${runId}`
      fs.writeFileSync(sourceFile, `第1章 合成原稿\n${sourceBody}\n`, 'utf8')
      fs.writeFileSync(invalidFile, '第1章 只有标题\n', 'utf8')
      const originalSha = hash(sourceFile)
      const invalidSha = hash(invalidFile)
      const aDbPath = path.join(projects.a, '.ai-novel', 'project.db')
      const bDbPath = path.join(projects.b, '.ai-novel', 'project.db')
      const dbFacts = dbPath => {
        const db = new Database(dbPath, { fileMustExist: true, readonly: true })
        try {
          return {
            drafts: db.prepare('SELECT drafts.id, chapter_number, version, status, source, contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id ORDER BY drafts.id').all(),
            runs: db.prepare('SELECT id, purpose, stage, status, last_error FROM import_runs ORDER BY id').all(),
            outbox: db.prepare('SELECT draft_id, chapter_number, content_snapshot, target_file_name, publication_status FROM finalization_outbox ORDER BY draft_id').all(),
            core: db.prepare("SELECT core_outline FROM project_core WHERE id = 'main'").get().core_outline,
          }
        } finally { db.close() }
      }
      const beforeA = dbFacts(aDbPath)
      const beforeB = dbFacts(bDbPath)
      const bProjectHash = hash(path.join(projects.b, '.ai-novel', 'project.json'))
      const openAuthorDialog = async () => {
        await home(page)
        await page.getByRole('button', { name: '小说拆解', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByTestId('import-purpose-author').click()
        assert.equal(await dialog.getByTestId('import-current-project-name').textContent(), `当前项目：${names.a}`)
        assert.equal(await dialog.getByTestId('import-target-current').getAttribute('aria-pressed'), 'true')
        return dialog
      }
      await open(page, names.a)
      let dialog = await openAuthorDialog()
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      assert.deepEqual(dbFacts(aDbPath), beforeA)
      assert.deepEqual(dbFacts(bDbPath), beforeB)
      pass('v3-author-import-cancel', 'U01.A10', 'V3 author-import dialog cancellation writes neither current A nor unrelated B')

      currentStep = 'U01.A10-invalid-source'
      dialog = await openAuthorDialog()
      await dialog.getByTestId('import-source-choose').click()
      const invalidPickerEvidence = chooseNativeFile(invalidFile)
      await dialog.getByText(/只有章节标题，没有可导入的正文/).waitFor({ state: 'visible', timeout: 30_000 })
      assert.deepEqual(dbFacts(aDbPath), beforeA)
      assert.deepEqual(dbFacts(bDbPath), beforeB)
      assert.equal(hash(invalidFile), invalidSha)
      pass('v3-author-import-invalid-source', 'U01.A10', 'native-selected title-only source is rejected visibly without creating a run or changing A/B')

      currentStep = 'U01.A10-author-preview'
      await dialog.getByTestId('import-source-choose').click()
      const pickerEvidence = chooseNativeFile(sourceFile)
      await dialog.getByTestId('author-preview-target-1').waitFor({ state: 'visible', timeout: 30_000 })
      assert.match(await dialog.getByTestId('author-preview-target-1').textContent(), /目标：权威正文章节 \/ 定稿/)
      assert.match(await dialog.getByTestId('author-import-confirmation-summary').textContent(), /确认后将新增 1 章权威定稿/)
      assert.deepEqual(dbFacts(aDbPath), beforeA, 'author preview wrote A before confirmation')
      assert.deepEqual(dbFacts(bDbPath), beforeB)
      assert.equal(hash(sourceFile), originalSha)
      pass('v3-author-native-picker-preview', 'U01.A10', 'V3 native picker selects exact synthetic source; visible authoritative preview leaves SQLite unchanged until confirmation')

      currentStep = 'U01.A10-author-commit'
      await dialog.getByRole('button', { name: '确认导入（1 章）' }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
      const deadline = Date.now() + 30_000
      let committedA
      while (Date.now() < deadline) {
        committedA = dbFacts(aDbPath)
        if (committedA.runs.some(run => run.purpose === 'author-manuscript' && run.status === 'completed')) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      assert(committedA.runs.some(run => run.purpose === 'author-manuscript' && run.status === 'completed'),
        `author import did not complete: ${JSON.stringify(committedA.runs)}`)
      assert.deepEqual(committedA.drafts[0], beforeA.drafts[0], 'original A draft changed')
      assert.equal(committedA.drafts.length, beforeA.drafts.length + 1)
      assert.deepEqual(committedA.drafts.at(-1), { id: committedA.drafts.at(-1).id, chapter_number: 1, version: 2,
        status: 'finalized', source: 'write', body: sourceBody })
      assert.equal(committedA.outbox.length, 1)
      assert.equal(committedA.outbox[0].content_snapshot, sourceBody)
      assert.equal(committedA.outbox[0].publication_status, 'published')
      assert.equal(fs.readFileSync(path.join(projects.a, committedA.outbox[0].target_file_name), 'utf8'),
        `第1章 合成原稿\n\n${sourceBody}`)
      assert(modelRequests.some(request => request.kind === 'chapter-notes' && request.accepted),
        'author postprocess never reached the isolated model fixture')
      assert(modelRequests.every(request => request.accepted), 'unexpected provider request reached fixture')
      assert.deepEqual(dbFacts(bDbPath), beforeB)
      assert.equal(hash(path.join(projects.b, '.ai-novel', 'project.json')), bProjectHash)
      assert.equal(hash(sourceFile), originalSha)
      assert.equal(hash(invalidFile), invalidSha)
      pass('v3-author-import-committed', 'U01.A10', 'V3 confirmation completes import run, creates exact v2 finalized body and published file, preserves v1, B and original bytes')

      currentStep = 'U01.A10-duplicate'
      dialog = await openAuthorDialog()
      await dialog.getByTestId('import-source-choose').click()
      const duplicatePickerEvidence = chooseNativeFile(sourceFile)
      await dialog.getByTestId('author-preview-target-1').waitFor({ state: 'visible', timeout: 30_000 })
      assert.match(await dialog.getByTestId('author-preview-target-1').textContent(), /相同定稿（跳过）/)
      assert.match(await dialog.getByTestId('author-import-confirmation-summary').textContent(), /全部章节已存在且内容相同/)
      await dialog.getByRole('button', { name: '确认导入（1 章）' }).click()
      await dialog.getByText(/未重复发布，也未创建任务/).waitFor({ state: 'visible', timeout: 30_000 })
      assert.deepEqual(dbFacts(aDbPath), committedA)
      assert.deepEqual(dbFacts(bDbPath), beforeB)
      assert.equal(hash(sourceFile), originalSha)
      pass('v3-author-import-exact-duplicate', 'U01.A10', 'same source visibly classified as identical and confirmation creates no run, draft or publication')

      await quit(session.app)
      session = null
      assert.equal(hash(scriptPath), driverSha256)
      assert.deepEqual(provenance().artifactHashes, source.artifactHashes)
      const receipt = { outcome: 'PARTIAL', qualification: 'F05_U01_V3_A10_ONLY', evidenceLevel: 'electron',
        shell: 'writer-v3', ...source, driverSha256, releaseDefaultQualified: false, physicalModelRequests: 0,
        nativePickerHelperSha256: hash(nativePickerHelper), modelFixture: { kind: 'intercepted-main-fetch-to-loopback-SSE',
          physicalExternalRequests: 0, requests: modelRequests }, pickerEvidence: { invalid: invalidPickerEvidence,
          source: pickerEvidence, duplicate: duplicatePickerEvidence }, sourceFiles: [{ path: sourceFile, sha256: originalSha },
          { path: invalidFile, sha256: invalidSha }], beforeA, committedA, beforeB,
        steps, verifiedActions: ['U01.A10'], shelfScreenshot,
        unverifiedActions: ['U01.A01–A09/A11–A12 are not reverified in this run; full F05/product qualification remains open'] }
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
      process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, receipt: path.relative(repository, receiptPath),
        testedSha: source.testedSha, driverSha256, steps: steps.map(step => step.stepId) })}\n`)
      return
    }

    const a12Only = process.argv.includes('--a12-only')
    let expectedBConfig = fixtureConfig.b
    let expectedAConfig = fixtureConfig.a
    let cFile
    if (!a12Only) {
    currentStep = 'U01.A01'
    await page.getByRole('button', { name: '新建作品', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: '新建小说项目' })
    await createDialog.getByPlaceholder('如：斗破苍穹').fill(names.c)
    await createDialog.getByPlaceholder('选择项目保存目录').fill(roots.projects)
    await createDialog.getByRole('button', { name: '创建项目', exact: true }).click()
    const expectedC = path.join(roots.projects, names.c)
    await page.locator('.writer-project-tree').getByText(names.c, { exact: true }).waitFor({ state: 'visible' })
    projects.c = (await invoke(page, 'project:get-runtime-context')).activeProjectPath
    assert.equal(projects.c.toLowerCase(), expectedC.toLowerCase(), 'new project opened outside the isolated root')
    const dbC = new Database(path.join(projects.c, '.ai-novel', 'project.db'), { fileMustExist: true })
    const cCore = dbC.prepare("SELECT project_name, core_outline FROM project_core WHERE id = 'main'").get()
    assert.equal(cCore.project_name, names.c)
    cFile = hash(path.join(projects.c, '.ai-novel', 'project.json'))
    dbC.close()
    pass('v3-create-project', 'U01.A01', 'V3 new-work dialog creates C, binds C in renderer and main, and initializes its SQLite project')

    currentStep = 'U01.A02'
    await home(page)
    await session.app.evaluate(({ ipcMain }, selectedPath) => {
      const channel = 'dialog:select-folder'
      const original = ipcMain._invokeHandlers.get(channel)
      if (!original) throw new Error('folder picker IPC handler missing')
      globalThis.__u01PickerHandler = original
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async () => selectedPath)
    }, projects.a)
    try {
      await page.getByRole('button', { name: '打开作品', exact: true }).click()
      await page.locator('.writer-project-tree').getByText(names.a, { exact: true }).waitFor({ state: 'visible' })
    } finally {
      await session.app.evaluate(({ ipcMain }) => {
        const original = globalThis.__u01PickerHandler
        ipcMain.removeHandler('dialog:select-folder')
        ipcMain.handle('dialog:select-folder', original)
        delete globalThis.__u01PickerHandler
      })
    }
    await assertProjectFacts(page, projects.a, fixtureConfig.a, fixtureBody.a)
    const reopenedC = new Database(path.join(projects.c, '.ai-novel', 'project.db'), { fileMustExist: true })
    try { assert.deepEqual(reopenedC.prepare("SELECT project_name, core_outline FROM project_core WHERE id = 'main'").get(), cCore) }
    finally { reopenedC.close() }
    assert.equal(hash(path.join(projects.c, '.ai-novel', 'project.json')), cFile, 'opening A rewrote C project file')
    pass('v3-open-project', 'U01.A02', 'V3 Open project action uses a controlled folder choice and binds A without writing C')

    currentStep = 'U01.A03'
    const aFileBeforeRecent = hash(projectFile)
    await home(page)
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${names.b}》` }).click()
    await page.locator('.writer-project-tree').getByText(names.b, { exact: true }).waitFor({ state: 'visible' })
    await assertProjectFacts(page, projects.b, fixtureConfig.b, fixtureBody.b)
    assert.equal(coreOutline(), fixtureConfig.a)
    assert.equal(hash(projectFile), aFileBeforeRecent, 'recent B entry rewrote A project file')
    pass('v3-recent-project-entry', 'U01.A03', 'V3 recent-work Enter button binds B without writing A')

    currentStep = 'U01.A04'
    await home(page)
    await page.locator('.writer-shelf').getByRole('button', { name: `预览《${names.a}》` }).click()
    await page.locator('.writer-welcome-heading h1').getByText(names.a, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('region', { name: '作品概览' }).locator('blockquote').count(), 0, 'read-only preview exposed draft body')
    assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projects.b, 'preview switched the active project')
    assert.equal(coreOutline(), fixtureConfig.a, 'preview changed A configuration')
    assert.equal(hash(projectFile), aFileBeforeRecent, 'preview rewrote A project file')
    await page.locator('.writer-shelf').getByRole('button', { name: `预览《${names.a}》` }).click()
    await page.locator('.writer-project-tree').getByText(names.a, { exact: true }).waitFor({ state: 'visible' })
    await assertProjectFacts(page, projects.a, fixtureConfig.a, fixtureBody.a)
    pass('v3-preview-then-enter', 'U01.A04', 'V3 first cover click previews A without switching or writing; second click enters A')

    await open(page, names.a)
    assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projects.a)

    currentStep = 'U01.A07'
    const cancelMarker = `取消保留 ${runId}`
    await edit(page, cancelMarker)
    await home(page)
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${names.b}》` }).click()
    await decision(page, false, false)
    assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projects.a)
    assert.equal(coreOutline(), initialCore, 'cancel wrote A configuration')
    await page.locator('.writer-left-rail button[title="项目"]').click()
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
    assert.equal(await page.getByPlaceholder('在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置...').inputValue(), cancelMarker)
    await page.getByText('未保存', { exact: true }).first().waitFor({ state: 'visible' })
    pass('writer-cancel-retains-dirty', 'U01.A07', 'Second confirmation cancellation keeps A active and the author config edit visible')

    currentStep = 'U01.A05'
    await home(page)
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${names.b}》` }).click()
    await decision(page, true)
    await page.locator('.writer-project-tree').getByText(names.b, { exact: true }).waitFor({ state: 'visible' })
    assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projects.b)
    assert.equal(coreOutline(), cancelMarker, 'save-before-switch did not persist A configuration')
    pass('writer-save-before-switch', 'U01.A05', 'Writer save confirmation persists A config and binds B main current session')

    currentStep = 'U01.A11'
    await open(page, names.a)
    const saved = page.getByPlaceholder('在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置...')
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
    assert.equal(await saved.inputValue(), cancelMarker)
    pass('writer-reopen-saved-project', 'U01.A11', 'Reopen A in Writer retains persisted config after the intervening B session')

    currentStep = 'U01.A06'
    const discardMarker = `放弃内容 ${runId}`
    await edit(page, discardMarker)
    await home(page)
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${names.b}》` }).click()
    await decision(page, false, true)
    await page.locator('.writer-project-tree').getByText(names.b, { exact: true }).waitFor({ state: 'visible' })
    assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projects.b)
    assert.equal(coreOutline(), cancelMarker, 'discard changed A persisted configuration')
    await open(page, names.a)
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
    assert.equal(await saved.inputValue(), cancelMarker)
    pass('writer-discard-before-switch', 'U01.A06', 'Writer discard confirmation switches to B; reopening A shows saved content, not discarded draft')

    currentStep = 'U01.A08'
    const failedMarker = `失败保留 ${runId}`
    await edit(page, failedMarker)
    const beforeFailureFile = hash(projectFile)
    dbA.exec("CREATE TRIGGER u01_fail_core BEFORE UPDATE ON project_core BEGIN SELECT RAISE(ABORT, 'U01_INJECTED_SAVE_FAILURE'); END")
    try {
      await home(page)
      await page.locator('.writer-shelf').getByRole('button', { name: `打开《${names.b}》` }).click()
      await decision(page, true)
      await page.getByRole('dialog').filter({ hasText: '处理未保存内容' }).waitFor({ state: 'hidden' })
      const saveError = page.getByRole('alertdialog', { name: '打开项目异常' })
      await saveError.waitFor({ state: 'visible' })
      assert((await saveError.innerText()).includes('项目配置未能写入磁盘'), 'save failure was not visible to the author')
      await saveError.getByRole('button', { name: '确定' }).click()
      await saveError.waitFor({ state: 'hidden' })
      assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projects.a,
        'failed save switched the main-process project')
      assert.equal(coreOutline(), cancelMarker, 'failed save changed A persisted configuration')
      assert.equal(hash(projectFile), beforeFailureFile, 'failed save changed A project file')
      await page.locator('.writer-left-rail button[title="项目"]').click()
      await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
      assert.equal(await saved.inputValue(), failedMarker, 'failed save lost A author draft ledger')
      await page.getByText('保存失败', { exact: true }).first().waitFor({ state: 'visible' })
      assert(await page.locator('.writer-topbar [title="有未保存的修改"]').isVisible(), 'failed transition save cleared A dirty state')
      pass('v3-failed-save-stays-on-a', 'U01.A08', 'failed V3 save leaves A active, persisted config and project file unchanged, and author draft dirty')
    } finally { dbA.exec('DROP TRIGGER IF EXISTS u01_fail_core') }

    currentStep = 'U01.A08-retry'
    await home(page)
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${names.b}》` }).click()
    await decision(page, true)
    await page.locator('.writer-project-tree').getByText(names.b, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(coreOutline(), failedMarker, 'save retry did not persist the retained author edit')
    expectedAConfig = failedMarker
    pass('v3-failed-save-retry', 'U01.A08', 'retry saved the retained author edit and switched to B')
    dbA.close()

    currentStep = 'U01.A09'
    const bMarker = `迟到回包隔离 ${runId}`
    await session.app.evaluate(({ ipcMain }, aPath) => {
      const channel = 'project:open'
      const original = ipcMain._invokeHandlers.get(channel)
      if (!original) throw new Error('project open IPC handler missing')
      const gate = { original, aHeld: false, bCommitted: false, release: null }
      globalThis.__u01OpenGate = gate
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        const result = await original(event, ...args)
        if (args[0] === aPath && !gate.aHeld) {
          gate.aHeld = true
          await new Promise(resolve => { gate.release = resolve })
        } else if (args[0] !== aPath && result?.success) gate.bCommitted = true
        return result
      })
    }, projects.a)
    try {
      await home(page)
      await page.locator('.writer-shelf').getByRole('button', { name: `打开《${names.a}》` }).click()
      await waitForOpenGate(session.app, 'aHeld')
      assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projects.a,
        'held A open did not commit in main process')
      const newerReply = page.waitForEvent('console', { predicate: message => message.text().includes('[ipc-client.invoke] 调用完成: project:open') })
      await page.locator('.writer-shelf').getByRole('button', { name: `打开《${names.b}》` }).click()
      await waitForOpenGate(session.app, 'bCommitted')
      await newerReply
      assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projects.b,
        'newer B open did not restore main process to B')
      const lateReply = page.waitForEvent('console', { predicate: message => message.text().includes('[ipc-client.invoke] 调用完成: project:open') })
      await session.app.evaluate(() => globalThis.__u01OpenGate.release())
      await lateReply
      await page.locator('.writer-project-tree').getByText(names.b, { exact: true }).waitFor({ state: 'visible' })
      assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, projects.b)
      await edit(page, bMarker)
      await page.getByRole('heading', { name: '小说配置' }).locator('xpath=../..').getByRole('button', { name: '保存', exact: true }).click()
      await page.getByText('已保存', { exact: true }).first().waitFor({ state: 'visible' })
      const dbB = new Database(path.join(projects.b, '.ai-novel', 'project.db'), { fileMustExist: true })
      try {
        assert.equal(dbB.prepare("SELECT core_outline FROM project_core WHERE id = 'main'").get().core_outline, bMarker)
      } finally { dbB.close() }
      expectedBConfig = bMarker
      const verifyA = new Database(path.join(projects.a, '.ai-novel', 'project.db'), { fileMustExist: true })
      try {
        assert.equal(verifyA.prepare("SELECT core_outline FROM project_core WHERE id = 'main'").get().core_outline, failedMarker)
      } finally { verifyA.close() }
      pass('v3-late-open-response-isolated', 'U01.A09', 'observed old A IPC reply after newer B reply; V3 stayed on B and a subsequent edit persisted only to B')
    } finally {
      await session.app.evaluate(({ ipcMain }) => {
        const gate = globalThis.__u01OpenGate
        if (!gate) return
        gate.release?.()
        ipcMain.removeHandler('project:open')
        ipcMain.handle('project:open', gate.original)
        delete globalThis.__u01OpenGate
      })
    }

    await quit(session.app)
    session = null

    currentStep = 'U01.A11-new-process'
    session = await launch()
    await writer(session.page)
    await open(session.page, names.b)
    await assertProjectFacts(session.page, projects.b, bMarker, fixtureBody.b)
    const verifyOldA = new Database(path.join(projects.a, '.ai-novel', 'project.db'), { fileMustExist: true })
    try {
      assert.equal(verifyOldA.prepare("SELECT core_outline FROM project_core WHERE id = 'main'").get().core_outline, failedMarker)
      assert.equal(verifyOldA.prepare('SELECT contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id WHERE drafts.chapter_number = 1').get().body, fixtureBody.a)
    } finally { verifyOldA.close() }
    pass('v3-new-process-reopen', 'U01.A11', 'new installed process reopened B with exact saved config and draft body while old A remained unchanged')
    } else {
      currentStep = 'U01.A12-setup'
      dbA.close()
      assert(await page.getByRole('button', { name: '新建作品', exact: true }).isVisible())
      assert(await page.getByRole('button', { name: '打开作品', exact: true }).isVisible())
      const aFileBeforeShelf = hash(projectFile)
      const previewA = page.locator('.writer-shelf').getByRole('button', { name: `预览《${names.a}》` })
      await previewA.click()
      await page.locator('.writer-welcome-heading h1').getByText(names.a, { exact: true }).waitFor({ state: 'visible' })
      assert.equal((await invoke(page, 'project:get-runtime-context')).activeProjectPath, null)
      await previewA.click()
      await page.locator('.writer-project-tree').getByText(names.a, { exact: true }).waitFor({ state: 'visible' })
      await assertProjectFacts(page, projects.a, fixtureConfig.a, fixtureBody.a)
      pass('v3-delete-entry-shelf-preview', 'U01.A04', 'new package V3 shelf previews A read-only, then opens A with exact configuration and draft')
      await open(page, names.b)
      await assertProjectFacts(page, projects.b, expectedBConfig, fixtureBody.b)
      assert.equal(hash(projectFile), aFileBeforeShelf, 'recent B entry rewrote A')
      pass('v3-delete-entry-recent-open', 'U01.A03', 'new package V3 recent-work entry opens B without writing A; new/open controls remain visible')
    }

    currentStep = 'U01.A12'
    const owner = JSON.parse(fs.readFileSync(path.join(scratch, '.vibe-owner.json'), 'utf8'))
    assert.equal(owner.sourceProject, repository)
    assert.equal(path.resolve(projects.b).toLowerCase(), path.join(roots.projects, names.b).toLowerCase())
    assert.equal(fs.realpathSync.native(path.dirname(projects.b)).toLowerCase(), fs.realpathSync.native(roots.projects).toLowerCase())
    assert.equal(fs.lstatSync(projects.b).isSymbolicLink(), false)
    const bProjectFile = path.join(projects.b, '.ai-novel', 'project.json')
    const bProjectFileHash = hash(bProjectFile)
    const aFileBeforeDelete = hash(projectFile)
    const deleteEntryWindow = await session.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1440, 900)
      window.webContents.setZoomFactor(1)
      return { windowSize: window.getSize(), contentSize: window.getContentSize(), zoomFactor: window.webContents.getZoomFactor() }
    })
    await session.page.locator('.writer-left-rail button[title="欢迎页"]').click()
    const deleteEntryButton = session.page.getByRole('region', { name: '作品概览' }).getByRole('button', { name: '删除项目' })
    await deleteEntryButton.waitFor({ state: 'visible' })
    const deleteEntryPng = await session.page.screenshot({ path: deleteEntryScreenshotPath })
    deleteEntryScreenshot = { path: deleteEntryScreenshotPath, sha256: hash(deleteEntryScreenshotPath),
      pixels: [deleteEntryPng.readUInt32BE(16), deleteEntryPng.readUInt32BE(20)], ...deleteEntryWindow,
      profile: roots.userData, artifactHashes: source.artifactHashes }
    assert.deepEqual(deleteEntryScreenshot.pixels, [1440, 900])
    assert.deepEqual(deleteEntryWindow.contentSize, [1440, 900])
    assert.equal(deleteEntryWindow.zoomFactor, 1)
    await deleteEntryButton.click()
    const deleteDialog = session.page.getByRole('dialog').filter({ hasText: `确认删除项目「${names.b}」` })
    await deleteDialog.waitFor({ state: 'visible' })
    await deleteDialog.getByRole('button', { name: '取消' }).click()
    await deleteDialog.waitFor({ state: 'hidden' })
    assert.equal((await invoke(session.page, 'project:get-runtime-context')).activeProjectPath, projects.b)
    assert.equal(hash(bProjectFile), bProjectFileHash, 'cancelled deletion changed B project file')
    await session.page.locator('.writer-left-rail button[title="项目"]').click()
    await assertProjectFacts(session.page, projects.b, expectedBConfig, fixtureBody.b)
    pass('v3-delete-cancel', 'U01.A12', 'V3 current-project delete confirmation cancelled without changing B identity, configuration or draft')

    currentStep = 'U01.A12-denied'
    const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/"(S-1-[\d-]+)"\s*$/)?.[1]
    assert(sid, 'Windows user SID unavailable for the isolated ACL test')
    await session.app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('project:delete')
      if (!original) throw new Error('project delete IPC handler missing')
      globalThis.__u01DeleteCapture = { original, calls: [] }
      ipcMain.removeHandler('project:delete')
      ipcMain.handle('project:delete', async (event, ...args) => {
        const result = await original(event, ...args)
        globalThis.__u01DeleteCapture.calls.push({ context: args[3], result })
        return result
      })
    })
    let currentDeleteContext
    try {
      execFileSync('icacls', [projects.b, '/deny', `*${sid}:(OI)(CI)(D,DC)`], { encoding: 'utf8' })
      try {
        await session.page.locator('.writer-left-rail button[title="欢迎页"]').click()
        await session.page.getByRole('region', { name: '作品概览' }).getByRole('button', { name: '删除项目' }).click()
        await deleteDialog.waitFor({ state: 'visible' })
        await deleteDialog.getByRole('button', { name: '删除项目' }).click()
        const deleteError = session.page.getByRole('alertdialog', { name: '删除项目失败' })
        await deleteError.waitFor({ state: 'visible' })
        await deleteError.getByRole('button', { name: '确定' }).click()
        const captured = await session.app.evaluate(() => globalThis.__u01DeleteCapture.calls.at(-1))
        assert(captured?.context?.leaseId, 'V3 delete did not pass a current project lease')
        assert.equal(captured.result.success, false, 'NTFS-denied deletion unexpectedly succeeded')
        assert.equal(captured.result.directoryDeleted, false)
        assert.equal(captured.result.databaseRestored, true)
        currentDeleteContext = captured.context
        assert.equal((await invoke(session.page, 'project:get-runtime-context')).activeProjectPath, projects.b)
      } finally {
        if (fs.existsSync(projects.b)) execFileSync('icacls', [projects.b, '/remove:d', `*${sid}`, '/T', '/C'], { encoding: 'utf8' })
      }
      assert.equal(hash(bProjectFile), bProjectFileHash, 'NTFS-denied deletion changed B project file')
      await session.page.locator('.writer-left-rail button[title="项目"]').click()
      await assertProjectFacts(session.page, projects.b, expectedBConfig, fixtureBody.b)
      pass('v3-delete-permission-denied', 'U01.A12', 'real Windows ACL denial leaves B directory, active DB, configuration and draft intact')
      const crossProject = await invoke(session.page, 'project:delete', projects.a, projectIds.a, currentDeleteContext.leaseId, currentDeleteContext)
      assert.equal(crossProject.success, false)
      assert.equal(crossProject.directoryDeleted, false)
      assert.match(crossProject.error, /删除目标不是当前项目根目录/)
      const staleContext = { ...currentDeleteContext, leaseId: 'expired-u01-fixture-lease' }
      const staleDelete = await invoke(session.page, 'project:delete', projects.b, projectIds.b, staleContext.leaseId, staleContext)
      assert.equal(staleDelete.success, false)
      assert.equal(staleDelete.directoryDeleted, false)
      assert.match(staleDelete.error, /会话已失效/)
      await assertProjectFacts(session.page, projects.b, expectedBConfig, fixtureBody.b)
      assert.equal(hash(bProjectFile), bProjectFileHash)
      assert.equal(fs.existsSync(projects.a), true, 'cross-project delete removed A')
      pass('v3-delete-cross-session-rejected', 'U01.A12', 'current B lease cannot delete A; expired B lease cannot delete B; both projects remain intact')
    } finally {
      await session.app.evaluate(({ ipcMain }) => {
        const capture = globalThis.__u01DeleteCapture
        if (!capture) return
        ipcMain.removeHandler('project:delete')
        ipcMain.handle('project:delete', capture.original)
        delete globalThis.__u01DeleteCapture
      })
    }

    currentStep = 'U01.A12-authorized'
    await session.page.locator('.writer-left-rail button[title="欢迎页"]').click()
    await session.page.getByRole('region', { name: '作品概览' }).getByRole('button', { name: '删除项目' }).click()
    await deleteDialog.waitFor({ state: 'visible' })
    await deleteDialog.getByRole('button', { name: '删除项目' }).click()
    await session.page.getByText(`项目「${names.b}」已删除`).waitFor({ state: 'visible' })
    assert.equal(fs.existsSync(projects.b), false, 'authorized V3 delete left B directory and database on disk')
    assert.equal((await invoke(session.page, 'project:get-runtime-context')).activeProjectPath, null)
    assert.equal(await session.page.locator('.writer-shelf').getByRole('button', { name: `打开《${names.b}》` }).count(), 0)
    assert.equal(hash(projectFile), aFileBeforeDelete, 'deleting B rewrote A project file')
    const afterDeleteA = new Database(path.join(projects.a, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
    try {
      assert.equal(afterDeleteA.prepare("SELECT core_outline FROM project_core WHERE id = 'main'").get().core_outline, expectedAConfig)
      assert.equal(afterDeleteA.prepare('SELECT contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id WHERE drafts.chapter_number = 1').get().body, fixtureBody.a)
    } finally { afterDeleteA.close() }
    if (cFile) assert.equal(hash(path.join(projects.c, '.ai-novel', 'project.json')), cFile, 'deleting B rewrote C project file')
    pass('v3-delete-authorized', 'U01.A12', 'V3 UI-confirmed authorized delete removes only B directory/DB and recent entry, then clears the active project')
    await quit(session.app)
    session = null
    assert.equal(hash(scriptPath), driverSha256)
    assert.deepEqual(provenance().artifactHashes, source.artifactHashes)
    const allSteps = {
      'U01.A01': ['v3-create-project'],
      'U01.A02': ['v3-open-project'],
      'U01.A03': ['v3-recent-project-entry'],
      'U01.A04': ['v3-preview-then-enter'],
      'U01.A05': ['writer-save-before-switch'],
      'U01.A06': ['writer-discard-before-switch'],
      'U01.A07': ['writer-cancel-retains-dirty'],
      'U01.A08': ['v3-failed-save-stays-on-a', 'v3-failed-save-retry'],
      'U01.A09': ['v3-late-open-response-isolated'],
      'U01.A11': ['v3-new-process-reopen'],
      'U01.A12': ['v3-delete-cancel', 'v3-delete-permission-denied', 'v3-delete-cross-session-rejected', 'v3-delete-authorized'],
    }
    const requiredSteps = a12Only ? {
      'U01.A03': ['v3-delete-entry-recent-open'],
      'U01.A04': ['v3-delete-entry-shelf-preview'],
      'U01.A12': allSteps['U01.A12'],
    } : allSteps
    const verifiedActions = Object.entries(requiredSteps).filter(([, ids]) => ids.every(id => steps.some(step => step.stepId === id && step.outcome === 'PASS')))
      .map(([actionId]) => actionId)
    assert.equal(verifiedActions.length, Object.keys(requiredSteps).length, 'required transition step missing')
    const receipt = { outcome: 'PARTIAL', qualification: a12Only ? 'F05_U01_V3_A03_A04_A12_ONLY' : 'F05_U01_V3_A01_A09_A11_A12_ONLY', evidenceLevel: 'electron', shell: 'writer-v3',
      ...source, driverSha256, releaseDefaultQualified: false, physicalModelRequests: 0,
      steps, verifiedActions, shelfScreenshot, deleteEntryScreenshot, pickerFixture: 'A02 uses the real V3 Open project action and main IPC with an isolated controlled folder choice; OS picker permission is not claimed',
      unverifiedActions: a12Only ? ['U01.A01–A02, A05–A11 and final product qualification are not reverified in this run'] : ['U01.A10 import and final product qualification'] }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, receipt: path.relative(repository, receiptPath),
      testedSha: source.testedSha, executionHead: source.executionHead, driverSha256, steps: steps.map(step => step.stepId) })}\n`)
  } catch (error) {
    const diagnostic = session?.page ? await session.page.evaluate(() => ({
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(e => e.textContent?.slice(0, 160)),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent?.slice(0, 160)),
      shell: document.querySelector('[data-shell-variant]')?.getAttribute('data-shell-variant'),
    })).catch(() => null) : null
    if (session) {
      const closed = await Promise.race([session.app.close().then(() => true).catch(() => false), new Promise(resolve => setTimeout(() => resolve(false), 5_000))])
      if (!closed) { try { session.app.process()?.kill() } catch { /* already closed */ } }
    }
    fs.writeFileSync(receiptPath, JSON.stringify({ outcome: 'FAIL', ...source, driverSha256, shelfScreenshot, deleteEntryScreenshot,
      failedStep: currentStep, steps, error: String(error), diagnostic, modelRequests, rendererLogs: rendererLogs.slice(-20) }, null, 2))
    throw error
  } finally {
    if (fixtureServer?.listening) await new Promise(resolve => fixtureServer.close(resolve))
  }
}

if (process.argv.includes('--help')) process.stdout.write('Pass fixed Windows package hashes and source SHA; exercises isolated V3 project transitions.\n')
else main().catch(error => { console.error(error); process.exitCode = 1 })
