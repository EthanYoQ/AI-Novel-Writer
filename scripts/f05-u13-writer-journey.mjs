/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const markerPath = join(runRoot, 'writer-opened.json')
const projectName = '合成推理验收'
const model = { id: 'f05-u13-synthetic', name: '合成流式模型', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'f05-u13-offline-key', maxTokens: 2048, temperature: 0.7, purposes: ['generation'] }
const reasoning = '合成推理仅显示在临时区'
const firstVisible = '雨停之后，林岚沿着石阶走向灯塔。'
const restVisible = '守塔人已在门前等候，她递出手中的旧地图，指出北岸被潮水掩盖的暗门。' + '旧城的钟声响了三次，林岚决定先记录地形，再带同伴返回调查。'.repeat(2)
const visibleText = firstVisible + restVisible
const timeout = 60_000

function run(command) {
  const cli = process.env.npm_execpath
  const result = spawnSync(cli ? (process.env.npm_node_execpath || process.execPath) : 'pnpm',
    cli ? [cli, 'run', command] : ['run', command],
    { cwd: repository, stdio: 'inherit', windowsHide: true, shell: !cli && process.platform === 'win32' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `pnpm run ${command} failed`)
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function sourceState() {
  const hash = createHash('sha256')
  const files = spawnSync('git', ['ls-files', '-z', '--', 'src', 'electron', 'scripts', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'],
  { cwd: repository, encoding: 'buffer', windowsHide: true })
  assert.equal(files.status, 0, 'Could not list build inputs')
  for (const name of files.stdout.toString('utf8').split('\0').filter(Boolean)) {
    hash.update(name)
    hash.update(readFileSync(join(repository, name)))
  }
  return { head: git('rev-parse', 'HEAD'), inputSha256: hash.digest('hex'),
    dirtyPaths: git('status', '--porcelain').split('\n').filter(Boolean) }
}
function buildHash() {
  const hash = createHash('sha256')
  for (const target of ['dist', 'dist-electron']) {
    const root = join(repository, target)
    assert.ok(existsSync(root), `Missing built ${target}`)
    const visit = (directory) => {
      for (const name of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, name.name)
        if (name.isDirectory()) visit(path)
        else if (name.isFile()) { hash.update(relative(repository, path)); hash.update(readFileSync(path)) }
      }
    }
    visit(root)
  }
  return hash.digest('hex')
}

function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }
function assertRunPath() {
  const rel = relative(join(repository, '.runtime', '.cache'), runRoot)
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Run root escaped cache')
}
async function invoke(page, channel, ...args) {
  return page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
}

async function launch(projectPath, fixturePort) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: paths.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: paths.legacy, AI_NOVEL_VELA_HOME: paths.legacy,
    HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.appData, LOCALAPPDATA: paths.localAppData }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  if (projectPath) { env.AI_NOVEL_SMOKE_OPEN_PROJECT = projectPath; env.AI_NOVEL_SMOKE_PROJECT_MARKER = markerPath }
  const app = await electron.launch({ cwd: repository, args: ['.', `--user-data-dir=${paths.userData}`], env, timeout })
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
    if (projectPath) {
      await page.locator('.writer-project-tree').waitFor({ state: 'visible', timeout })
      for (let index = 0; index < 200 && !existsSync(markerPath); index++) await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
      assert.ok(existsSync(markerPath), 'Writer smoke project-open confirmation was not written')
      assert.equal(resolve(JSON.parse(readFileSync(markerPath, 'utf8')).projectPath), resolve(projectPath))
    }
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
  const beforeBuild = sourceState()
  const testedSha = beforeBuild.head
  const driverPath = fileURLToPath(import.meta.url)
  const driverSha256 = sha256File(driverPath)
  run('build')
  const afterBuild = sourceState()
  assert.deepEqual({ head: afterBuild.head, inputSha256: afterBuild.inputSha256 },
    { head: testedSha, inputSha256: beforeBuild.inputSha256 }, 'Build inputs changed during build')
  const artifactSha256 = buildHash()
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
  let nativePrepared = false
  let projectPath
  const fixtureState = { dispatches: 0, sent: 0, requests: [] }
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
    streamResponse = response
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    send({ choices: [{ delta: { reasoning_content: reasoning } }] })
  })
  let primaryError
  try {
    await new Promise((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', resolveListen) })
    const fixturePort = server.address().port
    nativePrepared = true
    run('rebuild:electron')
    let session = await launch(null)
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
    exits.push({ phase: 'setup', ...await quit(app) }); app = null

    session = await launch(projectPath, fixturePort)
    app = session.app
    const page = session.page
    await page.locator('.writer-shell').waitFor({ state: 'visible', timeout })
    const startupNotice = page.getByRole('button', { name: '知道了' })
    if (await startupNotice.isVisible()) await startupNotice.click()
    await page.locator('.writer-project-tree').getByText('章节蓝图', { exact: true }).click()
    await page.getByRole('button', { name: '写作此章' }).waitFor({ state: 'visible', timeout })
    await page.getByRole('button', { name: '写作此章' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('3000').fill('100')
    await dialog.getByRole('button', { name: '开始创作' }).click()
    const output = page.locator('.writer-ai-panel')
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
    assert.ok(durable.includes(firstVisible))
    assert.equal(durable.includes(reasoning), false)
    steps.push({ stepId: 'u13-reasoning-not-durable', actionId: 'U13.A02',
      assertion: 'Fresh project session read of generation snapshots contains visible text but no provider reasoning' })
  } catch (error) {
    primaryError = error
    console.error('F05 U13 primary failure:', error)
    throw error
  } finally {
    const errors = []
    if (app) try { exits.push({ phase: 'journey', ...await quit(app) }) } catch (error) { errors.push(error) }
    if (server.listening) try { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)) } catch (error) { errors.push(error) }
    if (nativePrepared) try { run('prepare:native-node') } catch (error) { errors.push(error) }
    try { assertRunPath(); rmSync(runRoot, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    try {
      const rel = relative(scratchRoot, projectParent)
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Project scratch escaped owner root')
      assert.equal(JSON.parse(readFileSync(join(projectParent, '.vibe-owner.json'), 'utf8')).owner, 'codex/f05-u13')
      rmSync(projectParent, { recursive: true, force: true })
    } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(primaryError ? [primaryError, ...errors] : errors,
      'F05 U13 cleanup failed; receipt not published')
  }
  const afterQualification = sourceState()
  assert.deepEqual({ head: afterQualification.head, inputSha256: afterQualification.inputSha256 },
    { head: testedSha, inputSha256: beforeBuild.inputSha256 }, 'Build inputs changed during qualification')
  assert.equal(sha256File(driverPath), driverSha256, 'Driver changed during qualification')
  assert.equal(buildHash(), artifactSha256, 'Build changed during qualification')
  const receipt = { schemaVersion: 1, qualification: 'F05_DETERMINISTIC_PREFLIGHT_SLICE', testedSha,
    sourceDirtyAtBuild: beforeBuild.dirtyPaths.length > 0, sourceDirtyAtReceipt: afterQualification.dirtyPaths.length > 0,
    inputSha256: beforeBuild.inputSha256, dirtyPathsBeforeBuild: beforeBuild.dirtyPaths,
    dirtyPathsAfterBuild: afterBuild.dirtyPaths, dirtyPathsAfterQualification: afterQualification.dirtyPaths,
    driverDirty: Boolean(git('status', '--porcelain', '--', relative(repository, driverPath))),
    buildCommand: 'pnpm run build', artifactSha256, driverSha256, evidenceLevel: 'electron', shell: 'writer',
    provider: 'loopback-synthetic-openai-sse', externalModelRequests: 0, syntheticDispatches: fixtureState.dispatches, exits, steps }
  assert.equal(JSON.stringify(receipt).includes(model.apiKey), false)
  assert.equal(JSON.stringify(receipt).includes(reasoning), false)
  mkdirSync(receiptRoot, { recursive: true })
  writeJson(join(receiptRoot, '.vibe-owner.json'), { owner: 'codex/f05-u13', sourceProject: 'AI-Novel-Writer',
    createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${receiptRoot}' -Recurse -Force` })
  writeJson(join(receiptRoot, 'receipt.json'), receipt)
  process.stdout.write(`${JSON.stringify({ outcome: 'PASS', testedSha, steps: steps.map(step => step.stepId),
    receipt: relative(repository, join(receiptRoot, 'receipt.json')) })}\n`)
}

if (process.argv.includes('--help')) process.stdout.write('F05 U13 Writer Electron UI journey with loopback synthetic provider SSE. Runs build and native ABI transitions.\n')
else main().catch(error => {
  if (error instanceof AggregateError) for (const cause of error.errors) console.error('F05 U13 cleanup cause:', cause)
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
