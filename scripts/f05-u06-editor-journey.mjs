/* global process */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { checkEditorReceipt } from '../docs/plans/novel-quality-program-v3-2026-09-13/checks/feature-union-check.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const performanceMode = process.argv.includes('--performance')
const imeMode = process.argv.includes('--ime')
assert(!(performanceMode && imeMode), 'choose one U06 journey mode')
const rerunIndex = performanceMode && process.argv.includes('--rerun') ? 1 : 0
const priorReceipt = rerunIndex ? path.join(repository, '.runtime', '.cache', 'f05-u06-editor-performance',
  '0a2c4de3-913b-4c2a-ae31-67977f2fbfc0', 'receipt.json') : null
const packageDir = path.join(repository, '.runtime', '.cache', 'f04-v3-build', performanceMode || imeMode ? 'world-rail-1' : 's13-core-1')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const testedSha = performanceMode || imeMode ? '6cf79d36d8c9348911232b312cd852e60654f655' : '7110f53d5ce173d70bc0dcef90209bccb38d9fff'
const expectedExe = performanceMode || imeMode ? '183d7f5956495445d22c53e487232dedd20b6e29b5d9f06e15384732b72daa30' : 'c3864b55649358e6acae5e828861dc231521f75e5bfa0422212d86b3349f6669'
const expectedAsar = performanceMode || imeMode ? 'a184d35de87eddcea44465da40b17a3727205c8e3e80455c47a9237565ebcf38' : 'bf2f5c95ae8b72e377710759bfdb392cd0344f9e4c2d67fb0ef0ecbfb7b37b66'
const scriptPath = fileURLToPath(import.meta.url)
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const Database = createRequire(import.meta.url)('better-sqlite3')
const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', 'u06', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const receiptDir = path.join(repository, '.runtime', '.cache', imeMode ? 'f05-u06-editor-ime' : performanceMode ? 'f05-u06-editor-performance' : 'f05-u06-editor', runId)
const projectName = 'U06'
const fixtureBody = '# 雨夜\n\n林岚在旧港看见 **灯火**。\n\n尾声'
const imeFixtureBody = '雨夜\n\n林岚在旧港看见灯火。\n\n尾声'
const finalBody = '# 雨夜\n\n\u2003\u2003林岚在旧港码头看见 **灯火**。\n\n尾声\n\n**回声**'
const steps = []
const pass = (stepId, actionId, assertion, observed) => steps.push({ stepId, actionId, outcome: 'PASS', assertion, observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const editorText = body => body.evaluate(element => Array.from(element.querySelectorAll('.cm-line'), line => {
  const copy = line.cloneNode(true)
  copy.querySelector('.cm-lp-paperhead')?.remove()
  return copy.textContent
}).join('\n'))
const storedBody = (projectPath, draftId) => {
  const db = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
  try { return db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(draftId)?.body }
  finally { db.close() }
}

async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
    AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
    APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  const page = await app.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(15_000)
  await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
  assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
  await page.evaluate(() => {
    const key = 'ai-novel-writer-appearance'
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...value, shellPreference: 'writer', revision: Number(value.revision ?? 0) + 1, origin: 'author' }))
  })
  await page.reload()
  await page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible' })
  return { app, page }
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

async function measureEditorAction(page, action) {
  await page.evaluate(action => {
    const editor = document.querySelector('.writer-editor-content .cm-content[contenteditable="true"]')
    if (!editor) throw new Error('PERF_EDITOR_MISSING')
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) throw new Error('PERF_LONG_TASK_UNSUPPORTED')
    const firstLine = () => {
      const line = editor.querySelector('.cm-line')?.cloneNode(true)
      line?.querySelector('.cm-lp-paperhead')?.remove()
      return line?.textContent ?? ''
    }
    if (action === 'input' && firstLine().startsWith('测')) throw new Error('PERF_INPUT_NOT_RESET')
    if (action === 'selection' && window.getSelection()?.toString()) throw new Error('PERF_SELECTION_NOT_RESET')
    let settle, fail
    window.__u06EditorProbe = new Promise((resolve, reject) => { settle = resolve; fail = reject })
    const longTasks = []
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries()))
    observer.observe({ entryTypes: ['longtask'] })
    let start = null
    const eventType = action === 'input' ? 'beforeinput' : 'keydown'
    const finish = (error, end) => {
      clearTimeout(timeout)
      document.removeEventListener(eventType, onEvent, true)
      longTasks.push(...observer.takeRecords())
      observer.disconnect()
      if (error) fail(error)
      else settle({ elapsedMs: end - start, longTasksMs: longTasks.filter(entry =>
        entry.startTime <= end && entry.startTime + entry.duration >= start).map(entry => entry.duration),
        trusted: true, eventType })
    }
    const nextFrame = () => requestAnimationFrame(() => {
      const visible = action === 'input' ? firstLine().startsWith('测') : window.getSelection()?.toString() === '春'
      if (!visible) return nextFrame()
      requestAnimationFrame(() => finish(null, performance.now()))
    })
    const onEvent = event => {
      if (start !== null || !event.isTrusted || (action === 'input' ? event.data !== '测' : !(event.key === 'ArrowRight' && event.shiftKey))) return
      start = performance.now()
      nextFrame()
    }
    const timeout = setTimeout(() => finish(new Error(`PERF_${action.toUpperCase()}_EVENT_OR_DOM_TIMEOUT`)), 10_000)
    document.addEventListener(eventType, onEvent, true)
  }, action)
  if (action === 'input') await page.keyboard.insertText('测')
  else await page.keyboard.press('Shift+ArrowRight')
  const result = await page.evaluate(() => window.__u06EditorProbe)
  assert.equal(result.trusted, true)
  if (action === 'input') {
    await page.keyboard.press('Control+z')
    await page.waitForFunction(() => {
      const line = document.querySelector('.writer-editor-content .cm-content .cm-line')?.cloneNode(true)
      line?.querySelector('.cm-lp-paperhead')?.remove()
      return !line?.textContent?.startsWith('测')
    })
  } else await page.keyboard.press('ArrowLeft')
  return result
}

async function performanceMain() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U06 editor performance',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48,
    retainedReason: 'isolated packaged editor performance evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app, page, failure, exit
  let currentStep = 'package'
  const samples = {}, fixtures = {}, environment = {}
  try {
    assert.equal(fileHash(executablePath), expectedExe)
    assert.equal(fileHash(asarPath), expectedAsar)
    const previous = priorReceipt ? JSON.parse(fs.readFileSync(priorReceipt, 'utf8')) : null
    if (previous) {
      assert.equal(previous.artifact.executableSha256, expectedExe)
      assert.equal(previous.artifact.asarSha256, expectedAsar)
      assert.equal(previous.testedSha, testedSha)
    }
    const protocol = JSON.parse(fs.readFileSync(path.join(repository, 'docs/plans/novel-quality-program-v3-2026-09-13/feature-union.json'), 'utf8')).editorProtocol
    assert.equal(protocol.id, 'editor-absolute-v1')
    ;({ app, page } = await launch())
    for (const units of protocol.units) {
      currentStep = `fixture-${units}`
      const name = `U06-${units}`
      const body = ('春'.repeat(100) + '\n').repeat(units / 100).trimEnd()
      assert.equal((body.match(/春/g) ?? []).length, units)
      const created = await invoke(page, 'project:create', { path: profile.projects, name,
        genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
      assert.equal(created.success, true, created.error)
      const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
      assert.equal(opened.success, true, opened.error)
      const context = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
      const draft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
        content: body, wordCount: units }, created.projectPath, context)
      assert.equal(draft.success, true, draft.error)
      const draftId = draft.id ?? draft.draft?.id
      assert(Number.isInteger(draftId))
      assert.equal(storedBody(created.projectPath, draftId), body)
      fixtures[units] = { projectPath: created.projectPath, draftId, bodySha256: createHash('sha256').update(body).digest('hex'), units }
      if (previous) assert.equal(fixtures[units].bodySha256, previous.fixtures[units].bodySha256)
    }
    exit = await quit(app)
    assert.equal(exit.forced, false)
    app = null
    ;({ app, page } = await launch())
    const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(1440, 900)
      window.webContents.setZoomLevel(0)
    })
    environment.window = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { width: window.getSize()[0], height: window.getSize()[1], zoomLevel: window.webContents.getZoomLevel(),
        zoomFactor: window.webContents.getZoomFactor() }
    })
    assert.deepEqual(environment.window, { width: 1440, height: 900, zoomLevel: 0, zoomFactor: 1 })
    if (previous) assert.deepEqual(environment.window, previous.environment.window)
    for (const units of protocol.units) {
      currentStep = `U06.${units === 3000 ? 'A08' : 'A09'}`
      await page.locator('.writer-shelf').getByRole('button', { name: `打开《U06-${units}》` }).click()
      await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
      const editor = page.locator('.writer-editor-content .cm-content[contenteditable="true"]')
      await editor.waitFor({ state: 'visible' })
      await editor.locator('.cm-lp-dropcap-char').waitFor({ state: 'visible' })
      await page.locator('.writer-editor-content').getByText(`${units.toLocaleString('zh-CN')} 字`, { exact: true }).waitFor({ state: 'visible' })
      const font = await page.locator('.writer-editor-content .cm-scroller').evaluate(element => getComputedStyle(element).fontFamily)
      environment.font ??= font
      assert.equal(font, environment.font, 'font drift between fixed fixtures')
      if (previous) assert.equal(font, previous.environment.font)
      assert.equal(createHash('sha256').update(storedBody(fixtures[units].projectPath, fixtures[units].draftId)).digest('hex'),
        fixtures[units].bodySha256, 'fixture changed before measurement')
      const actionSamples = { input: { warmupSamplesMs: [], rawSamplesMs: [], longTasksMs: [] },
        selection: { warmupSamplesMs: [], rawSamplesMs: [], longTasksMs: [] } }
      for (let index = 0; index < protocol.warmupCount + protocol.sampleCount; index++) {
        for (const action of protocol.actions) {
          await editor.click()
          await page.keyboard.press('Control+Home')
          const result = await measureEditorAction(page, action)
          actionSamples[action][index < protocol.warmupCount ? 'warmupSamplesMs' : 'rawSamplesMs'].push(result.elapsedMs)
          actionSamples[action].longTasksMs.push(...result.longTasksMs)
        }
      }
      samples[units] = { writer: actionSamples }
      assert.equal(createHash('sha256').update(storedBody(fixtures[units].projectPath, fixtures[units].draftId)).digest('hex'),
        fixtures[units].bodySha256, 'unsaved measurements changed SQLite')
      // Undo restores the source text, but editor-store keeps the tab dirty until Save.
      await page.locator('button[title="保存（⌘S）"]').click()
      await page.locator('.writer-editor-content').getByRole('status').filter({ hasText: '已保存' }).waitFor({ state: 'visible' })
      assert.equal(createHash('sha256').update(storedBody(fixtures[units].projectPath, fixtures[units].draftId)).digest('hex'),
        fixtures[units].bodySha256, 'post-measurement save changed the fixed fixture')
      await page.locator('.writer-left-rail button[title="欢迎页"]').click()
      await page.locator('.writer-shelf').waitFor({ state: 'visible' })
    }
    const checked = checkEditorReceipt(protocol, { production: true, writerLivePreview: true,
      imeExactMatch: false, imeLossCount: null, imeDuplicateCount: null, selectionUndoExact: false,
      rerunIndex, samples })
    environment.checker = checked
    for (const units of protocol.units) steps.push({ stepId: `editor-performance-${units}`, actionId: units === 3000 ? 'U06.A08' : 'U06.A09',
      outcome: 'PARTIAL', assertion: 'packaged Writer raw input/selection samples captured; historical Classic baseline and OS IME unavailable',
      observed: checked.statistics })
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
  } finally {
    if (app) try { exit = await quit(app) } catch (error) { failure ??= { step: 'exit', message: String(error) } }
    const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U06_EDITOR_PERFORMANCE_PARTIAL',
      testedSha, rerunIndex, priorReceipt, priorReceiptSha256: priorReceipt ? fileHash(priorReceipt) : null,
      executionHead: git('rev-parse', 'HEAD'), changedPaths: git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean),
      sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
      artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
      driver: { path: scriptPath, sha256: fileHash(scriptPath) }, profile: { ...profile, scratch },
      fixtures, environment, samples, steps, unverifiedActions: ['U06.A03', 'U06.A08', 'U06.A09'], failure, exit }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${path.join(receiptDir, 'receipt.json')}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

async function imeMain() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U06 OS IME',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48,
    retainedReason: 'isolated packaged OS IME evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const awaitSky = async label => {
    process.stdout.write(`SKY_${label}\n`)
    process.stdin.resume()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SKY_${label}_TIMEOUT`)), 180_000)
      process.stdin.once('data', () => { clearTimeout(timer); resolve() })
    })
  }
  let app, page, projectPath, draftId, failure, exit, events = []
  let currentStep = 'package'
  try {
    assert.equal(fileHash(executablePath), expectedExe)
    assert.equal(fileHash(asarPath), expectedAsar)
    const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
    assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productInputs), '', 'product input changed since fixed package')
    assert.equal(git('diff', '--name-only', '--', ...productInputs), '', 'dirty product input changed since fixed package')
    currentStep = 'fixture'
    ;({ app, page } = await launch())
    const created = await invoke(page, 'project:create', { path: profile.projects, name: 'U06-IME',
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    projectPath = created.projectPath
    const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
      content: imeFixtureBody, wordCount: 13 }, projectPath, context)
    assert.equal(draft.success, true, draft.error)
    draftId = draft.id ?? draft.draft?.id
    assert(Number.isInteger(draftId))
    assert.equal(storedBody(projectPath, draftId), imeFixtureBody)
    exit = await quit(app)
    assert.equal(exit.forced, false)
    app = null

    currentStep = 'editor-open'
    ;({ app, page } = await launch())
    const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await page.locator('.writer-shelf').getByRole('button', { name: '打开《U06-IME》' }).click()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    const body = page.locator('.writer-editor-content .cm-content[contenteditable="true"]')
    await body.waitFor({ state: 'visible' })
    const baseline = await editorText(body)
    await body.evaluate(element => {
      window.__u06ImeEvents = []
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
        element.addEventListener(type, event => window.__u06ImeEvents.push({ type, trusted: event.isTrusted,
          data: 'data' in event ? event.data : null }), true)
      }
    })
    await awaitSky('IME_INPUT_READY')
    currentStep = 'U06.A03-compose'
    events = await page.evaluate(() => window.__u06ImeEvents)
    assert(events.some(event => event.type === 'compositionstart' && event.trusted), 'real OS IME compositionstart absent')
    assert(events.some(event => event.type === 'compositionend' && event.data === '你好'), 'real OS IME compositionend absent')
    assert(events.some(event => event.type === 'compositionupdate' && event.trusted && event.data === '你好'), 'trusted OS IME candidate absent')
    assert(events.some(event => event.type === 'input' && event.trusted && event.data === '你好'), 'trusted OS IME commit absent')
    assert.equal(await editorText(body), `${baseline}你好`, 'committed Chinese text is lost or duplicated')
    assert.equal(storedBody(projectPath, draftId), imeFixtureBody, 'IME composition wrote SQLite before Save')
    pass('os-ime-composition', 'U06.A03', 'sky SendInput produced trusted OS composition updates and committed input in packaged CodeMirror; compositionend was observed but not trusted',
      { committedText: '你好', events })

    await awaitSky('SELECTION_READY')
    currentStep = 'U06.A03-selection'
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '好', 'OS Shift+Left did not select the last committed character')
    pass('os-ime-selection', 'U06.A03', 'OS Shift+Left selected exactly the last committed Chinese character')

    await awaitSky('COLLAPSE_READY')
    assert.equal(await page.evaluate(() => window.getSelection()?.isCollapsed), true, 'OS Right did not collapse selection')
    await awaitSky('UNDO_READY')
    currentStep = 'U06.A03-undo'
    assert.equal(await editorText(body), baseline, 'OS undo did not remove the exact IME commit')
    await awaitSky('REDO_READY')
    currentStep = 'U06.A03-redo'
    assert.equal(await editorText(body), `${baseline}你好`, 'OS redo did not restore the exact IME commit')
    pass('os-ime-undo-redo', 'U06.A03', 'OS Ctrl+Z and Ctrl+Y removed and restored the exact committed Chinese text')

    await awaitSky('SAVE_READY')
    currentStep = 'U06.A03-save'
    await page.locator('.writer-editor-content').getByRole('status').filter({ hasText: '已保存' }).waitFor({ state: 'visible' })
    assert.equal(storedBody(projectPath, draftId), `${imeFixtureBody}你好`, 'saved SQLite draft differs from committed IME text')
    pass('os-ime-save', 'U06.A03', 'OS Ctrl+S persisted exact IME text through the packaged save path', { draftId })
    await page.screenshot({ path: path.join(receiptDir, 'v3-ime-saved.png') })
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
  } finally {
    process.stdin.pause()
    if (app) try { exit = await quit(app) } catch (error) { failure ??= { step: 'exit', message: String(error) } }
    const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U06_OS_IME_PARTIAL',
      testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths: git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean),
      sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
      artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
      driver: { path: scriptPath, sha256: fileHash(scriptPath) }, profile: { ...profile, scratch }, projectPath, draftId,
      inputMethod: '@oai/sky target-window OS key presses for IME, selection, undo, redo and save; Playwright only fixture, navigation and readback',
      events, steps, unverifiedActions: [...(steps.some(step => step.actionId === 'U06.A03' && step.stepId === 'os-ime-save') ? [] : ['U06.A03']), 'U06.A08', 'U06.A09'], failure, exit }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${path.join(receiptDir, 'receipt.json')}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U06 editor journey',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48,
    retainedReason: 'isolated packaged editor receipt review',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app, page, projectPath, draftId, failure, exit
  let currentStep = 'package'
  try {
    assert.equal(fileHash(executablePath), expectedExe)
    assert.equal(fileHash(asarPath), expectedAsar)
    pass('package-bytes', null, 'fixed Windows executable and asar match their source attribution')
    currentStep = 'fixture'
    ;({ app, page } = await launch())
    const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
    const created = await invoke(page, 'project:create', { path: profile.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    projectPath = created.projectPath
    const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
    const blueprint = await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '雨夜', role: '发展',
      purpose: '前往旧港', keyEvents: '发现灯火', characters: [] }, projectPath, context)
    assert.equal(blueprint.success, true, blueprint.error)
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
      content: fixtureBody, wordCount: 13 }, projectPath, context)
    assert.equal(draft.success, true, draft.error)
    draftId = draft.id ?? draft.draft?.id
    assert(Number.isInteger(draftId))
    exit = await quit(app)
    assert.equal(exit.forced, false, 'fixture setup did not close normally')
    app = null

    currentStep = 'editor-open'
    ;({ app, page } = await launch())
    const homeNotice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await homeNotice.isVisible()) await homeNotice.getByRole('button', { name: '知道了', exact: true }).click()
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    const body = page.locator('.cm-content[contenteditable="true"]')
    await body.waitFor({ state: 'visible' })
    assert.equal(await editorText(body), '# 雨夜\n\n林岚在旧港看见 灯火。\n\n尾声')

    currentStep = 'U06.A01'
    await body.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText('**回声**')
    await page.keyboard.press('Control+Home')
    await body.locator('.cm-lp-strong').getByText('回声', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await body.locator('.cm-lp-h1').count(), 1)
    assert.equal(await storedBody(projectPath, draftId), fixtureBody, 'preview edit wrote SQLite before save')
    pass('live-markdown-preview', 'U06.A01', 'real V3 CodeMirror rendered newly typed Markdown emphasis before saving')

    currentStep = 'U06.A02'
    const paper = body.locator('.cm-lp-paperhead')
    assert.equal(await paper.locator('h2').innerText(), '雨夜')
    assert.equal(await body.locator('.cm-lp-dropcap-char').innerText(), '林')
    assert.equal(await body.locator('.cm-lp-dropcap-char').evaluate(element =>
      parseFloat(getComputedStyle(element).fontSize) > parseFloat(getComputedStyle(element.closest('.cm-content')).fontSize)), true)
    pass('paper-head-dropcap', 'U06.A02', 'V3 prose paper head and enlarged first body character are visible in the live editor')

    currentStep = 'U06.A04'
    const points = await body.evaluate(element => {
      const line = [...element.querySelectorAll('.cm-line')].find(candidate => candidate.textContent.includes('旧港'))
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode()) && !node.textContent.includes('旧港')) {}
      const from = node.textContent.indexOf('旧港')
      const range = document.createRange()
      range.setStart(node, from); range.collapse(true)
      const start = range.getBoundingClientRect()
      range.setStart(node, from + 2); range.collapse(true)
      const end = range.getBoundingClientRect()
      return { start: { x: start.x, y: start.y + start.height / 2 }, end: { x: end.x, y: end.y + end.height / 2 } }
    })
    await page.mouse.move(points.start.x, points.start.y)
    await page.mouse.down()
    await page.mouse.move(points.end.x, points.end.y, { steps: 8 })
    await page.mouse.up()
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '旧港')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.insertText('码头')
    assert.match(await editorText(body), /旧港码头看见/)
    pass('drag-selection-caret', 'U06.A04', 'mouse drag selected exact Chinese text and caret insertion stayed at its right edge')

    currentStep = 'U06.A05'
    await page.keyboard.press('Control+z')
    assert.doesNotMatch(await editorText(body), /旧港码头看见/)
    await page.keyboard.press('Control+y')
    assert.match(await editorText(body), /旧港码头看见/)
    pass('undo-redo', 'U06.A05', 'real CodeMirror keyboard undo and redo restored the same insertion')

    currentStep = 'U06.A06'
    await body.locator('.cm-line').filter({ hasText: '林岚在旧港码头' }).click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Tab')
    assert.equal(await body.locator('.cm-line').filter({ hasText: '林岚在旧港码头' }).evaluate(element => element.textContent.startsWith('\u2003\u2003林岚')), true)
    await page.locator('.writer-left-rail button[title="设置"]').click()
    const modal = page.locator('.skin-solid-surface').first()
    await modal.locator('aside button').filter({ hasText: '编辑器' }).click()
    const writingField = modal.getByText('写作字体', { exact: true }).locator('xpath=ancestor::div[contains(@class,"space-y-1.5")][1]')
    await writingField.getByRole('button').first().click()
    await writingField.getByRole('button').filter({ hasText: '思源宋体' }).last().click()
    await modal.getByRole('button', { name: '关闭设置' }).click()
    assert.match(await page.locator('.writer-editor-content .cm-scroller').evaluate(element => getComputedStyle(element).fontFamily), /Noto Serif SC/)
    pass('indent-and-font', 'U06.A06', 'Tab inserted two em spaces and V3 font choice reached the live CodeMirror scroller')

    currentStep = 'U06.A07'
    await page.locator('.writer-editor-content').getByText('17 字', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await storedBody(projectPath, draftId), fixtureBody, 'editor changes persisted before Save')
    await page.locator('button[title="保存（⌘S）"]').click()
    await page.locator('.writer-editor-content').getByRole('status').filter({ hasText: '已保存' }).waitFor({ state: 'visible' })
    assert.equal(await storedBody(projectPath, draftId), finalBody, 'saved Markdown source differs from real editor changes')
    pass('draft-units-and-save', 'U06.A07', 'visible 17-unit count agrees with exact persisted Markdown source', { draftId, units: 17 })
    await page.screenshot({ path: path.join(receiptDir, 'v3-editor-preview.png') })
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
  } finally {
    if (app) try { exit = await quit(app) } catch (error) { failure ??= { step: 'exit', message: String(error) } }
    const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U06_PACKAGED_V3_PARTIAL',
      testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths: git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean),
      sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
      artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
      driver: { path: scriptPath, sha256: fileHash(scriptPath) }, profile: { ...profile, scratch }, projectPath, draftId,
      steps, unverifiedActions: ['U06.A03', 'U06.A08', 'U06.A09'], failure, exit }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${path.join(receiptDir, 'receipt.json')}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

if (imeMode) await imeMain()
else if (performanceMode) await performanceMain()
else await main()
