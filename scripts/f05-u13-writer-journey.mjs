/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { _electron as electron } from 'playwright'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runRoot = join(repository, '.runtime', '.cache', 'f05-u13', randomUUID())
const receiptRoot = join(repository, '.runtime', '.cache', 'f05-u13-receipts', randomUUID())
const paths = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData']
  .map(name => [name, join(runRoot, name)]))
assert.ok(process.env.LOCALAPPDATA, 'F05 U13 requires LOCALAPPDATA for short isolated project paths')
const scratchRoot = resolve(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel')
const projectParent = join(scratchRoot, `f05-u13-${randomUUID().slice(0, 4)}`)
const projectName = '合成推理验收'
const model = { id: 'f05-u13-synthetic', name: '合成流式模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'f05-u13-offline-key', maxTokens: 2048, temperature: 0.7, purposes: ['generation'] }
const reasoning = '合成推理仅显示在临时区'
const firstVisible = '雨停之后，林岚沿着石阶走向灯塔。'
const restVisible = '守塔人已在门前等候，她递出手中的旧地图，指出北岸被潮水掩盖的暗门。' + '旧城的钟声响了三次，林岚决定先记录地形，再带同伴返回调查。'.repeat(2)
const visibleText = firstVisible + restVisible
const secondChapterText = '第二天清晨，林岚带着同伴沿北岸寻找暗门。潮水已经退去，他们在礁石后发现一段刻着旧航线的石墙。' +
  '同伴核对地图上的标记，确定石墙下方留有通道。众人先固定绳索，再把发现写进航行日志，准备进入通道调查。'
const candidateVisibleText = visibleText + '她又核对了北岸岩层的走向，把潮汐刻度与地图逐一比照，并请同伴在入口留下醒目的绳结标记。'
const recoveredContinuation = '她借灯光看清石墙背面的刻字，发现通道尽头还有一处被封住的岔路。众人记下方位，决定先检查通风口，再向里面推进。'
const cancelVisible = '她在岸边抬头，看见灯塔的光束正缓缓扫过海面。'
const timeout = 60_000
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const testedSha = option('package-source-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
const diagnosticOverlay = process.argv.includes('--diagnostic-overlay')
const overlayPaths = ['electron/services/main-generation-owner.ts',
  'src/services/generation/generation-harness.ts', 'src/services/workflows/commands/generate-draft.command.ts']
const packageDir = option('package-dir') && resolve(repository, option('package-dir'))
const executablePath = packageDir && join(packageDir, 'AI小说作家.exe')
const asarPath = packageDir && join(packageDir, 'resources', 'app.asar')

function git(...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed`)
  return result.stdout.trimEnd()
}

function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }
function assertRunPath() {
  const rel = relative(join(repository, '.runtime', '.cache'), runRoot)
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Run root escaped cache')
}
async function invoke(page, channel, ...args) {
  return page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
}

async function launch(fixturePort) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: paths.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: paths.legacy, AI_NOVEL_VELA_HOME: paths.legacy,
    HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.appData, LOCALAPPDATA: paths.localAppData }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  const app = await electron.launch({ executablePath, cwd: packageDir,
    args: [`--user-data-dir=${paths.userData}`], env, timeout })
  try {
    if (fixturePort) await app.evaluate((_, port) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input, options) => {
        const url = new URL(String(input))
        if (url.origin !== 'https://api.openai.com' || !url.pathname.startsWith('/v1/')) throw new Error('F05_U13_NETWORK_REFUSED')
        return originalFetch(`http://127.0.0.1:${port}${url.pathname}`, options)
      }
    }, fixturePort)
    const page = await app.firstWindow({ timeout })
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout })
    return { app, page }
  } catch (error) { await app.close(); throw error }
}

async function quit(app) {
  const processRef = app.process()
  const closed = await Promise.race([app.close().then(() => true),
    new Promise(resolveTimeout => setTimeout(() => resolveTimeout(false), 10_000))])
  if (!closed) {
    const killed = spawnSync('taskkill', ['/PID', String(processRef.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
    assert.equal(killed.status, 0, `Could not terminate isolated Electron tree: ${killed.stderr}`)
    return { forced: true }
  }
  return { forced: false }
}

async function main() {
  assertRunPath()
  assert.ok(packageDir && testedSha && /^[a-f0-9]{64}$/i.test(expectedExe ?? '')
    && /^[a-f0-9]{64}$/i.test(expectedAsar ?? ''),
  'Pass --package-dir --package-source-sha --exe-sha256 --asar-sha256')
  assert.equal(git('rev-parse', testedSha), testedSha, 'Package source SHA is unavailable')
  assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '',
  'Product inputs changed since package build')
  const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5')
    .split('\n').filter(Boolean).map(line => line.slice(3)).sort()
  assert.deepEqual(dirtyProductPaths, diagnosticOverlay ? [...overlayPaths].sort() : [],
    'Package source has unexpected uncommitted product inputs')
  const productOverlayHashes = Object.fromEntries(dirtyProductPaths.map(path => [path, sha256File(join(repository, path))]))
  assert.ok(existsSync(executablePath) && existsSync(asarPath), 'Packaged Windows artifact is missing')
  assert.equal(sha256File(executablePath), expectedExe.toLowerCase(), 'Packaged executable changed')
  assert.equal(sha256File(asarPath), expectedAsar.toLowerCase(), 'Packaged app changed')
  const driverPath = fileURLToPath(import.meta.url)
  const driverSha256 = sha256File(driverPath)
  for (const directory of Object.values(paths)) mkdirSync(directory, { recursive: true })
  const projectRelative = relative(scratchRoot, projectParent)
  assert.ok(projectRelative && !projectRelative.startsWith('..') && !isAbsolute(projectRelative), 'Project scratch escaped owner root')
  assert.ok(join(projectParent, projectName).length <= 85, 'Project scratch path is too long')
  mkdirSync(projectParent, { recursive: true })
  writeJson(join(projectParent, '.vibe-owner.json'), { owner: 'codex/f05-u13', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 1,
    cleanupCommand: `Remove-Item -LiteralPath '${projectParent}' -Recurse -Force` })
  writeJson(join(runRoot, '.vibe-owner.json'), { owner: 'codex/f05-u13', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 1,
    cleanupCommand: `Remove-Item -LiteralPath '${runRoot}' -Recurse -Force` })
  const steps = []
  let app
  const exits = []
  let projectPath
  let currentStep = 'setup'
  const fixtureState = { dispatches: 0, sent: 0, requests: [], closedDispatches: [] }
  let streamResponse
  const send = chunk => {
    assert.ok(streamResponse && !streamResponse.writableEnded, 'synthetic SSE stream is not open')
    streamResponse.write(`data: ${JSON.stringify(chunk)}\n\n`)
    fixtureState.sent++
  }
  const server = createServer(async (request, response) => {
    const authorized = request.headers.authorization === `Bearer ${model.apiKey}`
    fixtureState.requests.push({ method: request.method, path: request.url, authorized })
    if (request.method !== 'POST' || !authorized) { response.writeHead(403).end(); return }
    if (request.url === '/v1/embeddings') {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
      const input = Array.isArray(body.input) ? body.input : [body.input]
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })),
      }))
      return
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    fixtureState.dispatches++
    request.resume()
    if ([2, 5, 8].includes(fixtureState.dispatches)) { response.writeHead(500).end('controlled provider failure'); return }
    if (fixtureState.dispatches === 10) {
      response.on('close', () => fixtureState.closedDispatches.push(10))
      streamResponse = response
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      send({ choices: [{ delta: { content: cancelVisible } }] })
      return
    }
    if (fixtureState.dispatches > 2) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const content = fixtureState.dispatches === 6 ? secondChapterText
        : fixtureState.dispatches === 7 ? candidateVisibleText
          : fixtureState.dispatches === 9 ? recoveredContinuation : visibleText
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: fixtureState.dispatches === 7 ? 'length' : 'stop' }] })}\n\n`)
      response.write('data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":120,"total_tokens":150}}\n\n')
      response.end('data: [DONE]\n\n')
      return
    }
    streamResponse = response
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    send({ choices: [{ delta: { reasoning_content: reasoning } }] })
  })
  let primaryError
  try {
    await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', resolveListen) })
    const fixturePort = server.address().port
    let session = await launch()
    app = session.app
    await session.page.waitForFunction(() => localStorage.getItem('ai-novel-writer-appearance') !== null, null, { timeout })
    // Isolated test profile selects Writer explicitly; this is not release-default qualification.
    await session.page.evaluate(() => {
      const key = 'ai-novel-writer-appearance'
      const current = JSON.parse(localStorage.getItem(key))
      localStorage.setItem(key, JSON.stringify({ ...current, shellPreference: 'writer', revision: current.revision + 1, origin: 'author' }))
    })
    const created = await invoke(session.page, 'project:create', { path: projectParent, name: projectName,
      genre: '合成测试', targetAudience: '合成读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    writeJson(join(projectParent, '.vibe-owner.json'), { owner: 'codex/f05-u13', sourceProject: repository,
      createdAt: new Date().toISOString(), ttlHours: 1,
      cleanupCommand: `Remove-Item -LiteralPath '${projectParent}' -Recurse -Force` })
    projectPath = created.projectPath
    const opened = await invoke(session.page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
    assert.equal((await invoke(session.page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(session.page, 'llm:set-default-model', model.id)).success, true)
    const roster = await invoke(session.page, 'db:character-roster-read', projectPath, context)
    const character = { characterId: `draft:${randomUUID()}`, name: '林岚', role: 'protagonist', gender: '', age: '', appearance: '', personality: '',
      background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }
    const characters = await invoke(session.page, 'db:character-roster-commit', {
      operationId: randomUUID(), expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision,
      schemaVersion: 1, intent: 'manual_edit', entries: [character],
    }, projectPath, context)
    assert.equal(characters.success, true, characters.error)
    assert.equal((await invoke(session.page, 'db:blueprint-upsert', { chapterNumber: 1, title: '灯塔', role: '发展',
      purpose: '沿岸调查', keyEvents: '发现暗门', characters: [] }, projectPath, context)).success, true)
    assert.equal((await invoke(session.page, 'db:blueprint-upsert', { chapterNumber: 2, title: '北岸', role: '发展',
      purpose: '调查暗门', keyEvents: '发现线索', characters: [] }, projectPath, context)).success, true)
    exits.push({ phase: 'setup', ...await quit(app) }); app = null

    currentStep = 'U13.A02'
    session = await launch(fixturePort)
    app = session.app
    let page = session.page
    await page.locator('.writer-shell').waitFor({ state: 'visible', timeout })
    const startupNotice = page.getByRole('button', { name: '知道了' })
    if (await startupNotice.isVisible()) await startupNotice.click()
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible', timeout })
    await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    await page.getByRole('button', { name: '写作此章' }).waitFor({ state: 'visible', timeout })
    await page.getByRole('button', { name: '写作此章' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('3000').fill('100')
    await dialog.getByRole('button', { name: '开始创作' }).click()
    let output = page.locator('.writer-ai-panel')
    const thinking = output.getByRole('button', { name: /思考中|思考过程/ }).locator('xpath=following-sibling::div[1]')
    const body = output.locator('.assistant-content')
    const waitForVisibleText = async (area, marker) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if ((await area.innerText()).includes(marker) && await area.getByText(marker, { exact: false }).isVisible()) return
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      }
      throw new Error(`Writer AI output did not display expected synthetic marker; fixture=${JSON.stringify(fixtureState)}`)
    }
    try { await waitForVisibleText(thinking, reasoning) }
    catch (error) {
      const locator = output.getByText(reasoning, { exact: false })
      const matches = await Promise.all((await locator.all()).map(async node => ({ visible: await node.isVisible(),
        box: await node.boundingBox(), ancestors: await node.evaluate(element => {
          const chain = []
          for (let current = element; current && chain.length < 20; current = current.parentElement) {
            chain.push({ tag: current.tagName, display: getComputedStyle(current).display,
              visibility: getComputedStyle(current).visibility, rect: current.getBoundingClientRect().toJSON() })
          }
          return chain
        }) })))
      const state = await output.evaluate((panel, markers) => {
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
        const textNodes = []
        while (walker.nextNode()) if (walker.currentNode.nodeValue?.includes(markers.reasoning)) {
          const parent = walker.currentNode.parentElement
          if (parent) textNodes.push({ tag: parent.tagName, display: getComputedStyle(parent).display,
            visibility: getComputedStyle(parent).visibility, rect: parent.getBoundingClientRect().toJSON() })
        }
        return { markers: Object.fromEntries(Object.entries(markers).map(([key, value]) => [key, panel.textContent?.includes(value) ?? false])),
          panelText: panel.innerText.slice(-500), textNodes }
      }, { reasoning, firstVisible, restVisible })
      throw new Error(`Reasoning not visible; fixture=${JSON.stringify(fixtureState)}; locatorMatches=${JSON.stringify(matches.map(({ visible, box }) => ({ visible, box })))}; state=${JSON.stringify({ markers: state.markers, panelText: state.panelText })}; cause=${String(error)}`)
    }
    steps.push({ stepId: 'u13-provider-reasoning-visible', actionId: 'U13.A02',
      assertion: 'Actual Writer writing button displayed intercepted provider reasoning_content only in the transient thinking area' })
    assert.equal(await body.getByText(reasoning, { exact: false }).count(), 0, 'Reasoning leaked into prose body')
    send({ choices: [{ delta: { content: firstVisible } }] })
    currentStep = 'U13.A01'
    await waitForVisibleText(body, firstVisible)
    assert.equal(await output.getByText(restVisible, { exact: false }).count(), 0)
    steps.push({ stepId: 'u13-visible-first-chunk', actionId: 'U13.A01',
      assertion: 'Actual Writer AI output displayed first visible provider chunk before later chunk arrived' })
    send({ choices: [{ delta: { content: restVisible }, finish_reason: 'stop' }] })
    send({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 120, total_tokens: 150 } })
    streamResponse.end('data: [DONE]\n\n')
    await waitForVisibleText(body, restVisible)
    assert.equal(await body.getByText(reasoning, { exact: false }).count(), 0, 'Reasoning leaked into completed prose body')
    assert.ok(fixtureState.dispatches >= 1)
    assert.ok(fixtureState.sent >= 4, 'synthetic provider did not send all stream frames')
    const reopened = await invoke(page, 'project:open', projectPath, randomUUID(), projectPath)
    assert.equal(reopened.success, true, reopened.error)
    const readContext = { projectId: created.projectId, projectPath, leaseId: reopened.project.sessionLease }
    const runs = await invoke(page, 'generation:list', readContext)
    const durable = JSON.stringify(runs)
    const draftsBeforeFailure = await invoke(page, 'db:draft-list', 1, projectPath, readContext)
    assert.equal(draftsBeforeFailure.length, 1, 'First Writer run must save one draft')
    assert.ok(durable.includes(firstVisible))
    assert.equal(durable.includes(reasoning), false)
    steps.push({ stepId: 'u13-reasoning-not-durable', actionId: 'U13.A02',
      assertion: 'Fresh project session read of generation snapshots contains visible text but no provider reasoning' })
    exits.push({ phase: 'after-stream', ...await quit(app) }); app = null

    currentStep = 'U13.A03'
    session = await launch(fixturePort)
    app = session.app
    page = session.page
    output = page.locator('.writer-ai-panel')
    await page.locator('.writer-shell').waitFor({ state: 'visible', timeout })
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    await page.getByRole('button', { name: '写作第1章' }).click()
    await page.getByRole('dialog').getByPlaceholder('3000').fill('100')
    await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
    await output.getByText('工作流未完成', { exact: true }).waitFor({ state: 'visible', timeout })
    assert.equal(fixtureState.dispatches, 2, 'Failed request must dispatch exactly once')
    const failureNotice = output.getByRole('alert').filter({ hasText: '写稿 — 第 1 章 · 灯塔' })
    await failureNotice.waitFor({ state: 'visible', timeout })
    const failureText = await failureNotice.innerText()
    assert.ok(failureText.includes('错误码：GENERATION_PROVIDER_FAILED'),
      `Normalized provider failure code is absent; notice=${JSON.stringify(failureText.slice(0, 600))}`)
    const failurePanelText = await output.innerText()
    const rawHttpStatusVisible = [failureText, failurePanelText].some(text => text.includes('500'))
    const providerBodyVisible = [failureText, failurePanelText].some(text => text.includes('controlled provider failure'))
    const apiKeyVisible = [failureText, failurePanelText].some(text => text.includes(model.apiKey))
    assert.equal(rawHttpStatusVisible, false, 'Raw HTTP 500 status leaked into Writer failure UI')
    assert.equal(providerBodyVisible, false, 'Provider response body leaked into Writer failure UI')
    assert.equal(apiKeyVisible, false, 'Synthetic API key leaked into Writer failure UI')
    const failedRead = await invoke(page, 'project:open', projectPath, randomUUID(), projectPath)
    assert.equal(failedRead.success, true, failedRead.error)
    const failedContext = { projectId: created.projectId, projectPath, leaseId: failedRead.project.sessionLease }
    const failedRuns = await invoke(page, 'generation:list', failedContext)
    assert.equal(failedRuns.length, 2, 'Controlled provider failure must create one durable main run')
    const draftsAfterFailure = await invoke(page, 'db:draft-list', 1, projectPath, failedContext)
    assert.equal(draftsAfterFailure.length, draftsBeforeFailure.length, 'Failed attempt must not save another draft')
    steps.push({ stepId: 'u13-failure-code-full-title', actionId: 'U13.A03',
      assertion: 'Writer displays exact failed chapter title and main-normalized provider failure code; one durable run, no added draft',
      observed: { fixtureHttpStatus: 500, visibleFailureCode: 'GENERATION_PROVIDER_FAILED',
        rawHttpStatusVisible, providerBodyVisible, apiKeyVisible, dedicatedErrorCodeLabelVerified: true,
        mainRunStatus: failedRuns.at(-1).status, draftCount: draftsAfterFailure.length } })

    currentStep = 'U13.A04'
    exits.push({ phase: 'after-failure', ...await quit(app) }); app = null
    session = await launch(fixturePort)
    app = session.app
    page = session.page
    output = page.locator('.writer-ai-panel')
    await page.locator('.writer-shell').waitFor({ state: 'visible', timeout })
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    await page.getByRole('button', { name: '写作第1章' }).click()
    await page.getByRole('dialog').getByPlaceholder('3000').fill('100')
    await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
    await output.getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout })
    assert.equal(fixtureState.dispatches, 3, 'Author retry must dispatch one additional physical request')
    steps.push({ stepId: 'u13-author-manual-retry', actionId: 'U13.A04',
      assertion: 'After failure author clicked Writer chapter write entry again; exactly one new request completed' })

    currentStep = 'U13.A05'
    const batchProjectName = '合成续批验收'
    const batchCreated = await invoke(page, 'project:create', { path: projectParent, name: batchProjectName,
      genre: '合成测试', targetAudience: '合成读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(batchCreated.success, true, batchCreated.error)
    const batchOpened = await invoke(page, 'project:open', batchCreated.projectPath, randomUUID(), null)
    assert.equal(batchOpened.success, true, batchOpened.error)
    const batchContext = { projectId: batchCreated.projectId, projectPath: batchCreated.projectPath,
      leaseId: batchOpened.project.sessionLease }
    const batchRoster = await invoke(page, 'db:character-roster-read', batchCreated.projectPath, batchContext)
    const batchCharacter = await invoke(page, 'db:character-roster-commit', {
      operationId: randomUUID(), expectedRevision: batchRoster.revision, expectedIdentityRevision: batchRoster.identityRevision,
      schemaVersion: 1, intent: 'manual_edit', entries: [{ ...character, characterId: `draft:${randomUUID()}` }],
    }, batchCreated.projectPath, batchContext)
    assert.equal(batchCharacter.success, true, batchCharacter.error)
    for (const [chapterNumber, title] of [[1, '潮门'], [2, '回声']]) {
      const blueprint = await invoke(page, 'db:blueprint-upsert', { chapterNumber, title, role: '发展',
        purpose: '调查潮门', keyEvents: '发现线索', characters: [] }, batchCreated.projectPath, batchContext)
      assert.equal(blueprint.success, true, blueprint.error)
    }
    exits.push({ phase: 'before-batch', ...await quit(app) }); app = null
    session = await launch(fixturePort)
    app = session.app
    page = session.page
    output = page.locator('.writer-ai-panel')
    await page.locator('.writer-shell').waitFor({ state: 'visible', timeout })
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${batchProjectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    await page.evaluate(() => {
      window.__f05BatchSnapshot = null
      window.__f05BatchDetach = window.aiNovelAPI.on('generation:snapshot', snapshot => {
        window.__f05BatchSnapshot = { projectId: snapshot.projectId, epoch: snapshot.epoch }
      })
    })
    await page.getByRole('button', { name: '批量创作' }).click()
    const batchDialog = page.getByRole('dialog')
    await batchDialog.locator('#batch-chapter-count').fill('2')
    await batchDialog.locator('#batch-chapter-words-target').fill('100')
    await batchDialog.getByRole('button', { name: '启动批量创作' }).click()
    await output.getByText('工作流未完成', { exact: true }).waitFor({ state: 'visible', timeout })
    assert.equal(fixtureState.dispatches, 5, 'Batch failure must stop after chapter 2 without extra dispatch')
    await output.getByText('批量正文：已保存 1 章，下一章 2', { exact: true }).waitFor({ state: 'visible', timeout })
    const batchSnapshot = await page.evaluate(() => {
      window.__f05BatchDetach?.()
      return window.__f05BatchSnapshot
    })
    assert.equal(batchSnapshot?.projectId, batchCreated.projectId, 'Batch snapshot must come from the open Writer project')
    const liveBatchContext = { projectId: batchCreated.projectId, projectPath: batchCreated.projectPath,
      leaseId: batchSnapshot.epoch }
    const beforeBatches = await invoke(page, 'generation:list-batches', liveBatchContext)
    const pendingBatch = beforeBatches.find(item => item.completedChapters.length === 1 && item.nextChapterNumber === 2)
    assert.ok(pendingBatch?.currentChapterRunHandle, 'Failed chapter must have one durable resume handle')
    const pendingHandle = pendingBatch.currentChapterRunHandle
    const pendingRun = await invoke(page, 'generation:read', pendingHandle, liveBatchContext)
    const pendingChapterContext = await invoke(page, 'generation:read-context', { handle: pendingHandle }, liveBatchContext)
    assert.equal(pendingRun.ledger?.physicalRequests, 2, 'Shared batch root must include chapter 1 and failed chapter 2 requests')
    assert.deepEqual(pendingChapterContext.attemptedPurposes, ['chapter-draft'],
      'Failed chapter run must have one own attempt before resume')
    const pendingAttemptIds = new Set(pendingRun.budgetDiagnostics?.map(item => item.attemptId) ?? [])
    assert.equal(pendingAttemptIds.size, 2, 'Shared root must contain two distinct attempts before resume')
    const continueBatch = output.getByRole('button', { name: '继续此批次' })
    assert.equal(await continueBatch.isEnabled(), true, 'Writer batch resume entry must be enabled')
    await continueBatch.click()
    try {
      await output.getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    } catch (error) {
      const alerts = await output.getByRole('alert').allInnerTexts()
      const panelText = (await output.innerText()).slice(-900)
      let mainState
      try {
        const debugOpen = await invoke(page, 'project:open', batchCreated.projectPath, randomUUID(), batchCreated.projectPath)
        assert.equal(debugOpen.success, true, debugOpen.error)
        const debugContext = { projectId: batchCreated.projectId, projectPath: batchCreated.projectPath,
          leaseId: debugOpen.project.sessionLease }
        const debugBatches = await invoke(page, 'generation:list-batches', debugContext)
        mainState = debugBatches.map(item => ({ nextChapterNumber: item.nextChapterNumber,
          completedChapters: item.completedChapters.map(chapter => chapter.chapterNumber),
          currentChapterRunHandle: Boolean(item.currentChapterRunHandle) }))
      } catch (debugError) { mainState = { readError: String(debugError) } }
      throw new Error(`Batch resume did not complete; dispatches=${fixtureState.dispatches}; main=${JSON.stringify(mainState)}; alerts=${JSON.stringify(alerts)}; panel=${JSON.stringify(panelText)}; cause=${String(error)}`)
    }
    assert.equal(fixtureState.dispatches, 6, 'Batch continuation must dispatch only the missing chapter')
    const batchRead = await invoke(page, 'project:open', batchCreated.projectPath, randomUUID(), batchCreated.projectPath)
    assert.equal(batchRead.success, true, batchRead.error)
    const batchReadContext = { projectId: batchCreated.projectId, projectPath: batchCreated.projectPath,
      leaseId: batchRead.project.sessionLease }
    const completedBatches = await invoke(page, 'generation:list-batches', batchReadContext)
    const completed = completedBatches.find(item => item.batchId === pendingBatch.batchId)
    assert.ok(completed, 'Resumed batch must have two durable completed chapters')
    assert.equal(completed.nextChapterNumber, null)
    assert.equal(completed.completedChapters.length, 2)
    const resumedChapter = completed.completedChapters.find(chapter => chapter.chapterNumber === 2)
    assert.ok(resumedChapter, 'Batch continuation must commit chapter 2')
    assert.equal(resumedChapter.sourceRunHandle.projectId, pendingHandle.projectId)
    assert.equal(resumedChapter.sourceRunHandle.rootActionId, pendingHandle.rootActionId)
    assert.equal(resumedChapter.sourceRunHandle.runId, pendingHandle.runId)
    const resumedRun = await invoke(page, 'generation:read', resumedChapter.sourceRunHandle, batchReadContext)
    const resumedChapterContext = await invoke(page, 'generation:read-context',
      { handle: resumedChapter.sourceRunHandle }, batchReadContext)
    assert.equal(resumedRun.ledger?.physicalRequests, 3, 'Shared batch root must add exactly one resumed physical request')
    assert.deepEqual(resumedChapterContext.attemptedPurposes, ['chapter-draft', 'chapter-draft'],
      'Same chapter run must contain the failed and resumed attempts')
    const resumedAttemptIds = new Set(resumedRun.budgetDiagnostics?.map(item => item.attemptId) ?? [])
    assert.equal(resumedAttemptIds.size, 3)
    assert.equal([...resumedAttemptIds].filter(id => !pendingAttemptIds.has(id)).length, 1,
      'Batch resume must add exactly one root attempt ID')
    assert.equal((await invoke(page, 'db:draft-list', 1, batchCreated.projectPath, batchReadContext)).length, 1)
    assert.equal((await invoke(page, 'db:draft-list', 2, batchCreated.projectPath, batchReadContext)).length, 1)
    steps.push({ stepId: 'u13-batch-resume-entry', actionId: 'U13.A05',
      assertion: 'Writer batch failure left one saved chapter and durable next chapter; Continue this batch resumed only chapter 2',
      observed: { batchId: completed.batchId, uiCompletedBefore: 1, uiNextBefore: 2, completedAfter: 2,
        chapter2RunId: pendingHandle.runId, chapter2RunAttemptsBefore: 1, chapter2RunAttemptsAfter: 2,
        rootPhysicalRequestsBefore: 2, rootPhysicalRequestsAfter: 3, newRootAttemptIds: 1,
        epochBefore: pendingHandle.epoch, epochAfter: resumedChapter.sourceRunHandle.epoch,
        syntheticDispatchesBefore: 5, syntheticDispatchesAfter: 6 } })

    currentStep = 'U13.A06'
    const candidateProjectName = '合成候选恢复验收'
    const candidateCreated = await invoke(page, 'project:create', { path: projectParent, name: candidateProjectName,
      genre: '合成测试', targetAudience: '合成读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(candidateCreated.success, true, candidateCreated.error)
    const candidateOpened = await invoke(page, 'project:open', candidateCreated.projectPath, randomUUID(), null)
    assert.equal(candidateOpened.success, true, candidateOpened.error)
    const candidateContext = { projectId: candidateCreated.projectId, projectPath: candidateCreated.projectPath,
      leaseId: candidateOpened.project.sessionLease }
    const candidateRoster = await invoke(page, 'db:character-roster-read', candidateCreated.projectPath, candidateContext)
    const candidateCharacter = await invoke(page, 'db:character-roster-commit', {
      operationId: randomUUID(), expectedRevision: candidateRoster.revision,
      expectedIdentityRevision: candidateRoster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
      entries: [{ ...character, characterId: `draft:${randomUUID()}` }],
    }, candidateCreated.projectPath, candidateContext)
    assert.equal(candidateCharacter.success, true, candidateCharacter.error)
    const candidateBlueprint = await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '石墙',
      role: '发展', purpose: '寻找暗门', keyEvents: '发现通道', characters: [] }, candidateCreated.projectPath, candidateContext)
    assert.equal(candidateBlueprint.success, true, candidateBlueprint.error)
    exits.push({ phase: 'before-candidate', ...await quit(app) }); app = null
    session = await launch(fixturePort)
    app = session.app
    page = session.page
    output = page.locator('.writer-ai-panel')
    await page.locator('.writer-shell').waitFor({ state: 'visible', timeout })
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${candidateProjectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    await page.getByRole('button', { name: '写作此章' }).click()
    await page.getByRole('dialog').getByPlaceholder('3000').fill('200')
    await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
    await output.getByText('工作流未完成', { exact: true }).waitFor({ state: 'visible', timeout })
    assert.equal(fixtureState.dispatches, 8, 'Length-ended candidate must cause exactly one failed continuation')
    const candidateRead = await invoke(page, 'project:open', candidateCreated.projectPath, randomUUID(), candidateCreated.projectPath)
    assert.equal(candidateRead.success, true, candidateRead.error)
    const candidateReadContext = { projectId: candidateCreated.projectId, projectPath: candidateCreated.projectPath,
      leaseId: candidateRead.project.sessionLease }
    const candidateRuns = await invoke(page, 'generation:list', candidateReadContext)
    assert.equal(candidateRuns.length, 1, 'Candidate must belong to one durable main run')
    const candidateRun = candidateRuns[0]
    const eligible = [...new Map([...candidateRun.artifacts, ...(candidateRun.candidates ?? [])]
      .map(artifact => [artifact.artifactId, artifact])).values()]
      .filter(artifact => artifact.compositionEligible === true && artifact.text === candidateVisibleText)
    assert.equal(eligible.length, 1, 'Main must retain one eligible candidate with exact visible text')
    assert.equal((await invoke(page, 'db:draft-list', 1, candidateCreated.projectPath, candidateReadContext)).length, 0,
      'Candidate must not be a committed draft')
    const candidateHandle = candidateRun.handle
    const candidateArtifactId = eligible[0].artifactId
    exits.push({ phase: 'before-candidate-resume', ...await quit(app) }); app = null
    session = await launch(fixturePort)
    app = session.app
    page = session.page
    output = page.locator('.writer-ai-panel')
    await page.locator('.writer-shell').waitFor({ state: 'visible', timeout })
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${candidateProjectName}》` }).click()
    await page.getByTitle('AI 输出', { exact: true }).click()
    const candidateSection = output.getByRole('region', { name: '持久正文候选' })
    try { await candidateSection.getByText('第1章候选', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 }) }
    catch (error) {
      const aiButton = page.getByTitle('AI 输出', { exact: true })
      const agentButton = page.getByTitle('AI Agent 面板', { exact: true })
      const state = { panelCount: await output.count(), panelVisible: await output.isVisible(),
        sectionCount: await candidateSection.count(), sectionVisible: await candidateSection.isVisible(),
        aiButtonCount: await aiButton.count(), aiButtonShadow: await aiButton.first().evaluate(node => node.style.boxShadow),
        agentButtonShadow: await agentButton.first().evaluate(node => node.style.boxShadow),
        projectTree: (await page.locator('.writer-project-tree').innerText()).slice(0, 300) }
      throw new Error(`Candidate UI did not appear after project open; state=${JSON.stringify(state)}; cause=${String(error)}`)
    }
    const eligibleChoice = candidateSection.locator('label').filter({ hasText: candidateVisibleText }).getByRole('checkbox')
    assert.equal(await eligibleChoice.count(), 1, 'UI must expose one selection for the durable visible-text candidate')
    assert.equal(await eligibleChoice.isEnabled(), true, 'Durable candidate must be selectable')
    await eligibleChoice.check()
    await candidateSection.getByRole('button', { name: '确认继续已选正文' }).click()
    try { await output.getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 }) }
    catch (error) {
      const alerts = await output.getByRole('alert').allInnerTexts()
      const panel = (await output.innerText()).slice(-500)
      let mainState
      try {
        const debugOpen = await invoke(page, 'project:open', candidateCreated.projectPath, randomUUID(), candidateCreated.projectPath)
        assert.equal(debugOpen.success, true, debugOpen.error)
        const debugContext = { projectId: candidateCreated.projectId, projectPath: candidateCreated.projectPath,
          leaseId: debugOpen.project.sessionLease }
        const debugRuns = await invoke(page, 'generation:list', debugContext)
        const debugDrafts = await invoke(page, 'db:draft-list', 1, candidateCreated.projectPath, debugContext)
        mainState = { runs: debugRuns.map(run => ({ status: run.status, sameHandle: run.handle.runId === candidateHandle.runId,
          physicalRequests: run.ledger?.physicalRequests, artifacts: run.artifacts.length })), draftCount: debugDrafts.length }
      } catch (debugError) { mainState = { readError: String(debugError) } }
      throw new Error(`Candidate recovery did not complete; dispatches=${fixtureState.dispatches}; main=${JSON.stringify(mainState)}; alerts=${JSON.stringify(alerts)}; panel=${JSON.stringify(panel)}; cause=${String(error)}`)
    }
    assert.equal(fixtureState.dispatches, 9, 'Candidate resume must dispatch one continuation')
    const recoveredRead = await invoke(page, 'project:open', candidateCreated.projectPath, randomUUID(), candidateCreated.projectPath)
    assert.equal(recoveredRead.success, true, recoveredRead.error)
    const recoveredContext = { projectId: candidateCreated.projectId, projectPath: candidateCreated.projectPath,
      leaseId: recoveredRead.project.sessionLease }
    const recoveredRuns = await invoke(page, 'generation:list', recoveredContext)
    assert.equal(recoveredRuns.length, 1, 'Recovery must reuse the existing durable main run')
    assert.equal(recoveredRuns[0].handle.projectId, candidateHandle.projectId)
    assert.equal(recoveredRuns[0].handle.rootActionId, candidateHandle.rootActionId)
    assert.equal(recoveredRuns[0].handle.runId, candidateHandle.runId)
    const recoveredDrafts = await invoke(page, 'db:draft-list', 1, candidateCreated.projectPath, recoveredContext)
    assert.equal(recoveredDrafts.length, 1, 'Recovered candidate must commit one draft')
    const recoveredDraft = await invoke(page, 'db:draft-get-full', recoveredDrafts[0].id,
      candidateCreated.projectPath, recoveredContext)
    assert.ok(recoveredDraft?.content.includes(candidateVisibleText))
    assert.ok(recoveredDraft.content.includes(recoveredContinuation))
    steps.push({ stepId: 'u13-main-candidate-selection', actionId: 'U13.A06',
      assertion: 'Writer main-owned durable candidate remained unsaved, then author selected it and resumed on the same handle to one draft',
      observed: { candidateArtifactId, candidateTextSha256: createHash('sha256').update(candidateVisibleText).digest('hex'),
        mainRunId: candidateHandle.runId, syntheticDispatchesBefore: 8, syntheticDispatchesAfter: 9,
        epochBefore: candidateHandle.epoch, epochAfter: recoveredRuns[0].handle.epoch,
        legacyRecoveryCandidateButtonsVerified: false } })

    currentStep = 'U13.A07'
    const cancelProjectName = '合成中止验收'
    const cancelCreated = await invoke(page, 'project:create', { path: projectParent, name: cancelProjectName,
      genre: '合成测试', targetAudience: '合成读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(cancelCreated.success, true, cancelCreated.error)
    const cancelOpened = await invoke(page, 'project:open', cancelCreated.projectPath, randomUUID(), null)
    assert.equal(cancelOpened.success, true, cancelOpened.error)
    const cancelContext = { projectId: cancelCreated.projectId, projectPath: cancelCreated.projectPath,
      leaseId: cancelOpened.project.sessionLease }
    const cancelRoster = await invoke(page, 'db:character-roster-read', cancelCreated.projectPath, cancelContext)
    const cancelCharacter = await invoke(page, 'db:character-roster-commit', {
      operationId: randomUUID(), expectedRevision: cancelRoster.revision,
      expectedIdentityRevision: cancelRoster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
      entries: [{ ...character, characterId: `draft:${randomUUID()}` }],
    }, cancelCreated.projectPath, cancelContext)
    assert.equal(cancelCharacter.success, true, cancelCharacter.error)
    const cancelBlueprint = await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '灯影',
      role: '发展', purpose: '沿岸观察', keyEvents: '发现异常', characters: [] }, cancelCreated.projectPath, cancelContext)
    assert.equal(cancelBlueprint.success, true, cancelBlueprint.error)
    exits.push({ phase: 'before-cancel', ...await quit(app) }); app = null
    session = await launch(fixturePort)
    app = session.app
    page = session.page
    output = page.locator('.writer-ai-panel')
    await page.locator('.writer-shell').waitFor({ state: 'visible', timeout })
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${cancelProjectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    await page.getByRole('button', { name: '写作此章' }).click()
    await page.getByRole('dialog').getByPlaceholder('3000').fill('100')
    await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
    await waitForVisibleText(output.locator('.assistant-content'), cancelVisible)
    assert.equal(fixtureState.dispatches, 10, 'Cancellation fixture must have one active request')
    const stopButton = output.getByRole('button', { name: '中止生成' })
    assert.equal(await stopButton.isVisible(), true, 'Writer stop button must be available while streaming')
    await stopButton.click()
    await output.getByRole('alert').filter({ hasText: '工作流已取消' }).waitFor({ state: 'visible', timeout })
    for (let attempt = 0; attempt < 50 && !fixtureState.closedDispatches.includes(10); attempt++) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    }
    assert.ok(fixtureState.closedDispatches.includes(10), 'Writer stop must abort the in-flight provider stream')
    assert.equal(fixtureState.dispatches, 10, 'Stop must not start another provider request')
    const cancelRead = await invoke(page, 'project:open', cancelCreated.projectPath, randomUUID(), cancelCreated.projectPath)
    assert.equal(cancelRead.success, true, cancelRead.error)
    const cancelReadContext = { projectId: cancelCreated.projectId, projectPath: cancelCreated.projectPath,
      leaseId: cancelRead.project.sessionLease }
    const cancelledRuns = await invoke(page, 'generation:list', cancelReadContext)
    assert.equal(cancelledRuns.length, 1, 'Writer stop must retain one durable main run')
    assert.equal(cancelledRuns[0].status, 'cancelled', 'Writer stop must persist main cancellation')
    const partialArtifacts = [...new Map([...cancelledRuns[0].artifacts, ...(cancelledRuns[0].candidates ?? [])]
      .map(artifact => [artifact.artifactId, artifact])).values()].map(artifact => ({
      status: artifact.status, compositionEligible: artifact.compositionEligible,
      textSha256: createHash('sha256').update(artifact.text).digest('hex') }))
    assert.equal((await invoke(page, 'db:draft-list', 1, cancelCreated.projectPath, cancelReadContext)).length, 0,
      'Cancelled output must not enter draft library')
    steps.push({ stepId: 'u13-writer-stop-generation', actionId: 'U13.A07',
      assertion: 'Writer Stop generation cancelled an active packaged provider stream; main run cancelled, no draft or retry',
      observed: { visibleBeforeStop: true, providerStreamClosed: true, mainRunStatus: cancelledRuns[0].status,
        syntheticDispatches: fixtureState.dispatches, draftCount: 0, partialArtifacts,
        unsavedTailCount: cancelledRuns[0].unsavedTails?.length ?? 0 } })
  } catch (error) {
    primaryError = error
    console.error('F05 U13 primary failure:', error)
  } finally {
    if (!primaryError) currentStep = 'cleanup'
    const errors = []
    if (app) try { exits.push({ phase: 'journey', ...await quit(app) }) } catch (error) { errors.push(error) }
    if (server.listening) try { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)) } catch (error) { errors.push(error) }
    try {
      assertRunPath()
      assert.equal(JSON.parse(readFileSync(join(runRoot, '.vibe-owner.json'), 'utf8')).owner, 'codex/f05-u13')
      writeJson(join(runRoot, '.vibe-owner.json'), { owner: 'codex/f05-u13', sourceProject: repository,
        createdAt: new Date().toISOString(), ttlHours: 24,
        retainedReason: 'Packaged Electron profile may hold Windows handles after app.close/taskkill; inspect receipt before cleanup',
        cleanupCommand: `Remove-Item -LiteralPath '${runRoot}' -Recurse -Force` })
    } catch (error) { errors.push(error) }
    try {
      const rel = relative(scratchRoot, projectParent)
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Project scratch escaped owner root')
      assert.equal(JSON.parse(readFileSync(join(projectParent, '.vibe-owner.json'), 'utf8')).owner, 'codex/f05-u13')
      rmSync(projectParent, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 })
    } catch (error) { errors.push(error) }
    if (errors.length) primaryError = new AggregateError(primaryError ? [primaryError, ...errors] : errors,
      'F05 U13 cleanup failed')
  }
  assert.equal(sha256File(driverPath), driverSha256, 'Driver changed during qualification')
  assert.equal(sha256File(executablePath), expectedExe.toLowerCase(), 'Packaged executable changed during qualification')
  assert.equal(sha256File(asarPath), expectedAsar.toLowerCase(), 'Packaged app changed during qualification')
  assert.deepEqual(Object.fromEntries(dirtyProductPaths.map(path => [path, sha256File(join(repository, path))])),
    productOverlayHashes, 'Product overlay changed during qualification')
  const requiredActionIds = Array.from({ length: 7 }, (_, index) => `U13.A0${index + 1}`)
  const unverifiedActions = requiredActionIds.filter(actionId => !steps.some(step => step.actionId === actionId))
  const receipt = { schemaVersion: 1, qualification: 'F05_U13_PACKAGED_WRITER_LIFECYCLE',
    outcome: primaryError ? 'FAIL' : unverifiedActions.length ? 'PARTIAL' : diagnosticOverlay ? 'DIAGNOSTIC_PASS' : 'PASS',
    validationMode: diagnosticOverlay ? 'diagnostic-uncommitted-product-overlay' : 'committed-source-qualification',
    qualificationEligible: !diagnosticOverlay,
    dirtyProductPaths, productOverlayHashes, unverifiedActions,
    firstFailure: primaryError ? { stepId: currentStep,
      message: String(primaryError instanceof AggregateError ? primaryError.errors[0] : primaryError).slice(0, 1200) } : null, testedSha,
    driverDirty: Boolean(git('status', '--porcelain', '--', relative(repository, driverPath))),
    packageDir, exeSha256: expectedExe.toLowerCase(), asarSha256: expectedAsar.toLowerCase(),
    driverSha256, profileRoot: runRoot, evidenceLevel: 'packaged-electron', shell: 'writer',
    provider: 'loopback-synthetic-openai-sse', externalModelRequests: 0, syntheticDispatches: fixtureState.dispatches, exits, steps }
  assert.equal(JSON.stringify(receipt).includes(model.apiKey), false)
  assert.equal(JSON.stringify(receipt).includes(reasoning), false)
  mkdirSync(receiptRoot, { recursive: true })
  writeJson(join(receiptRoot, '.vibe-owner.json'), { owner: 'codex/f05-u13', sourceProject: 'AI-Novel-Writer',
    createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${receiptRoot}' -Recurse -Force` })
  writeJson(join(receiptRoot, 'receipt.json'), receipt)
  process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, testedSha, steps: steps.map(step => step.stepId),
    receipt: relative(repository, join(receiptRoot, 'receipt.json')) })}\n`)
  if (primaryError) throw primaryError
}

if (process.argv.includes('--help')) process.stdout.write('F05 U13 Writer packaged Electron journey with loopback synthetic provider SSE. Pass fixed package path, source SHA, EXE SHA and ASAR SHA.\n')
else main().catch(error => {
  if (error instanceof AggregateError) for (const cause of error.errors) console.error('F05 U13 cleanup cause:', cause)
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
