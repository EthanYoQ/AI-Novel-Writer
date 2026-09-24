/* global process */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { assertEditorReceipt, checkEditorExecutionBinding, checkEditorReceipt, isEditorEnvironmentInvalid,
  recordEditorAttempt, resolveEditorProtocol } from '../docs/plans/novel-quality-program-v3-2026-09-13/checks/feature-union-check.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const performanceMode = process.argv.includes('--performance')
const imeMode = process.argv.includes('--ime')
const historicalClassicMode = process.argv.includes('--historical-classic')
const phaseDiagnostic = process.argv.includes('--phase-diagnostic')
const selectionDiagnostic = process.argv.includes('--selection-diagnostic')
const pairedSelectionDiagnostic = process.argv.includes('--paired-selection-diagnostic')
assert([performanceMode, imeMode, historicalClassicMode].filter(Boolean).length <= 1, 'choose one U06 journey mode')
assert(!selectionDiagnostic || historicalClassicMode, 'selection diagnostic requires historical Classic mode')
assert(!selectionDiagnostic || !phaseDiagnostic, 'selection diagnostic cannot combine with phase diagnostic')
assert(!selectionDiagnostic || !process.argv.includes('--rerun'), 'selection diagnostic cannot be a qualification rerun')
assert(!pairedSelectionDiagnostic || historicalClassicMode, 'paired selection diagnostic requires historical Classic mode')
assert(!pairedSelectionDiagnostic || !phaseDiagnostic && !selectionDiagnostic && !process.argv.includes('--rerun'),
  'paired selection diagnostic cannot combine with other diagnostics or qualification rerun')
assert(!phaseDiagnostic || performanceMode || historicalClassicMode, 'phase diagnostic requires performance or historical Classic mode')
assert(!phaseDiagnostic || !process.argv.includes('--rerun'), 'phase diagnostic cannot be a qualification rerun')
const option = name => {
  const index = process.argv.indexOf(`--${name}`)
  assert(index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `--${name} is required`)
  return process.argv[index + 1]
}
const packageOptions = ['package-dir', 'source-sha', 'exe-sha256', 'asar-sha256', 'build-receipt']
const candidatePackage = !historicalClassicMode && packageOptions.some(name => process.argv.includes(`--${name}`))
assert(!candidatePackage || packageOptions.every(name => process.argv.includes(`--${name}`)),
  'candidate package override requires --package-dir --source-sha --exe-sha256 --asar-sha256 --build-receipt together')
assert(!performanceMode || candidatePackage, '--performance requires the current merged V3 package and its build receipt')
assert(!process.argv.includes('--prior-receipt') || performanceMode && process.argv.includes('--rerun'), '--prior-receipt requires --performance --rerun')
assert(!process.argv.includes('--rerun') || performanceMode && process.argv.includes('--prior-receipt'), '--rerun requires --performance --prior-receipt <path>')
if (candidatePackage) {
  assert.match(option('source-sha'), /^[a-f0-9]{40}$/u)
  assert.match(option('exe-sha256'), /^[a-f0-9]{64}$/u)
  assert.match(option('asar-sha256'), /^[a-f0-9]{64}$/u)
}
const rerunIndex = performanceMode && process.argv.includes('--rerun') ? 1 : 0
const priorReceipt = rerunIndex ? path.resolve(option('prior-receipt')) : null
const packageDir = candidatePackage ? path.resolve(option('package-dir')) :
  path.join(repository, '.runtime', '.cache', 'f04-v3-build', imeMode ? 'world-rail-1' : 's13-core-1')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const testedSha = candidatePackage ? option('source-sha') : imeMode ? '6cf79d36d8c9348911232b312cd852e60654f655' :
  '7110f53d5ce173d70bc0dcef90209bccb38d9fff'
const expectedExe = candidatePackage ? option('exe-sha256') : imeMode ? '183d7f5956495445d22c53e487232dedd20b6e29b5d9f06e15384732b72daa30' :
  'c3864b55649358e6acae5e828861dc231521f75e5bfa0422212d86b3349f6669'
const expectedAsar = candidatePackage ? option('asar-sha256') : imeMode ? 'a184d35de87eddcea44465da40b17a3727205c8e3e80455c47a9237565ebcf38' :
  'bf2f5c95ae8b72e377710759bfdb392cd0344f9e4c2d67fb0ef0ecbfb7b37b66'
const scriptPath = fileURLToPath(import.meta.url)
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const Database = createRequire(import.meta.url)('better-sqlite3')
const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', 'u06', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const receiptDir = path.join(repository, '.runtime', '.cache', historicalClassicMode ? 'f05-u06-historical-classic' : imeMode ? 'f05-u06-editor-ime' : performanceMode ? 'f05-u06-editor-performance' : 'f05-u06-editor', runId)
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
const storedBody = (projectPath, draftId, historicalClassic = false) => {
  const db = new Database(path.join(projectPath, historicalClassic ? '.vela' : '.ai-novel',
    historicalClassic ? 'vela.db' : 'project.db'), { fileMustExist: true, readonly: true })
  try { return db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?').get(draftId)?.body }
  finally { db.close() }
}

function verifyCandidateBuildReceipt(receipt, receiptPath) {
  const sourceRoot = path.resolve(packageDir, '..', '..', '..')
  const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  const sourceGit = (...args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
  const executionGit = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
  const receiptRelative = path.relative(sourceRoot, receiptPath).replaceAll('\\', '/')
  assert.match(receiptRelative, /^\.runtime\/\.cache\/f05-u16-packaged\/[0-9a-f-]{36}\/receipt\.json$/u, 'not a U16 build receipt path')
  const version = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version
  assert(samePath(packageDir, path.join(sourceRoot, 'release', version, 'win-unpacked')), 'non-canonical candidate package path')
  assert(samePath(sourceGit('rev-parse', '--show-toplevel'), sourceRoot), 'candidate source root mismatch')
  assert.equal(sourceGit('rev-parse', 'HEAD'), testedSha, 'candidate source HEAD mismatch')
  assert.equal(sourceGit('status', '--porcelain', '--untracked-files=all'), '', 'candidate source dirty after build')
  const executionHead = executionGit('rev-parse', 'HEAD'), sourceHead = sourceGit('rev-parse', 'HEAD')
  const executionDirty = executionGit('status', '--porcelain', '--untracked-files=all') !== ''
  const sourceDirty = sourceGit('status', '--porcelain', '--untracked-files=all') !== ''
  const executionBinding = checkEditorExecutionBinding({ driverRepository:repository, sourceRoot,
    executionHead, sourceHead, testedSha, executionDirty, sourceDirty })
  if (performanceMode || imeMode) {
    assert(executionBinding.ok, `U06 driver execution tree is not the clean U16 source: ${executionBinding.errors.join('; ')}`)
  } else {
    const editorPaths = ['src/components/editor/CodeMirrorEditor.tsx', 'src/components/editor/DraftEditor.tsx',
      'src/components/panels/EditorArea.tsx', 'src/styles/redesign/v3-magazine.css']
    assert.equal(sourceDirty, false, 'candidate package source is dirty')
    assert.equal(executionGit('diff', '--name-only', `${testedSha}..HEAD`, '--', ...editorPaths), '',
      'editor code changed since candidate package')
    assert.equal(executionGit('diff', '--name-only', '--', ...editorPaths), '', 'editor code is dirty')
  }
  assert.equal(receipt.outcome, 'PARTIAL')
  assert.equal(receipt.failedStep, null)
  assert.equal(receipt.error, null)
  assert.equal(receipt.sourceDirty, false)
  assert.equal(receipt.testedSha, testedSha)
  assert.equal(receipt.build?.command, 'pnpm run build:win-dir')
  assert.equal(receipt.build?.buildSha, testedSha)
  assert.equal(receipt.build?.reusedFromReceipt, undefined, 'reused package is not a fresh build')
  assert.equal(receipt.build?.reuseDecision, undefined, 'reused package is not a fresh build')
  assert.deepEqual(receipt.build?.dirtyPathsBefore, [])
  assert.deepEqual(receipt.build?.dirtyPathsAfter, [])
  assert.equal(receipt.steps?.filter(step => step.stepId === 'fresh-package-build' && step.outcome === 'PASS').length, 1)
  const startedAt = Date.parse(receipt.build?.startedAt)
  const completedAt = Date.parse(receipt.build?.completedAt)
  assert(Number.isFinite(startedAt) && Number.isFinite(completedAt) && startedAt <= completedAt && completedAt <= Date.now() + 2_000,
    'invalid fresh build time')
  for (const file of [executablePath, asarPath]) {
    const mtime = fs.statSync(file).mtimeMs
    assert(mtime >= startedAt - 2_000 && mtime <= completedAt + 2_000, 'package bytes are outside fresh build window')
  }
  const inputHash = createHash('sha256')
  const names = execFileSync('git', ['ls-files', '-z', '--', 'src', 'electron', 'scripts', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'],
  { cwd: sourceRoot, maxBuffer: 8 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean)
  for (const name of names) { inputHash.update(name); inputHash.update(fs.readFileSync(path.join(sourceRoot, name))) }
  const inputSha256 = inputHash.digest('hex')
  assert.equal(receipt.build?.inputSha256, inputSha256, 'stale build inputs')
  assert.equal(receipt.artifact?.source, 'fresh build:win-dir in this driver run')
  assert.equal(receipt.artifact?.buildSha, testedSha)
  assert.equal(receipt.artifact?.inputSha256, inputSha256)
  assert(samePath(receipt.artifact?.executablePath, executablePath), 'build executable path mismatch')
  assert(samePath(receipt.artifact?.asarPath, asarPath), 'build asar path mismatch')
  assert.equal(receipt.artifact?.executableSha256, expectedExe)
  assert.equal(receipt.artifact?.asarSha256, expectedAsar)
  assert(samePath(receipt.driver?.path, path.join(sourceRoot, 'scripts', 'f05-u16-packaged-journey.mjs')), 'U16 driver path mismatch')
  assert.equal(receipt.driver?.sha256, fileHash(receipt.driver.path), 'U16 driver bytes changed')
  return { path: receiptPath, sha256: fileHash(receiptPath), executionBinding: {
    repository, sourceRoot, executionHead, sourceHead, testedSha, clean:!executionDirty && !sourceDirty,
    mode: performanceMode || imeMode ? 'strict' : 'editor-code-unchanged' } }
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

async function openCpuProfiler(page) {
  let session
  try {
    session = await page.context().newCDPSession(page)
    await session.send('Profiler.enable')
    if (!await page.evaluate(() => typeof console.profile === 'function' && typeof console.profileEnd === 'function')) {
      throw new Error('CONSOLE_PROFILE_UNSUPPORTED')
    }
    return { session }
  } catch (error) {
    await session?.detach().catch(() => {})
    return { error: String(error) }
  }
}

function waitForCpuProfile(session, title) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { session.off('Profiler.consoleProfileFinished', onProfile); reject(new Error('CPU_PROFILE_TIMEOUT')) }, 5_000)
    const onProfile = event => {
      if (event.title !== title) return
      clearTimeout(timer)
      session.off('Profiler.consoleProfileFinished', onProfile)
      resolve(event.profile)
    }
    session.on('Profiler.consoleProfileFinished', onProfile)
  })
}

function topCpuStacks(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const stacks = new Map()
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    const frames = []
    for (let node = nodes.get(profile.samples[index]); node; node = nodes.get(node.parent)) {
      const frame = node.callFrame
      frames.push(`${frame.functionName || '(anonymous)'}@${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`)
    }
    const stack = frames.reverse().join(' -> ')
    stacks.set(stack, (stacks.get(stack) ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1_000)
  }
  return [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([stack, sampledMs]) => ({ stack, sampledMs }))
}

async function measureEditorAction(page, action, editorSelector = '.writer-editor-content .cm-content[contenteditable="true"]', diagnostic = false, cpuProfileTitle = null) {
  await page.evaluate(({ action, editorSelector, diagnostic, cpuProfileTitle }) => {
    const editor = document.querySelector(editorSelector)
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
    let firstVisibleAt = null
    let frameChecks = 0
    let profileStarted = false
    const eventType = action === 'input' ? 'beforeinput' : 'keydown'
    const finish = (error, end) => {
      clearTimeout(timeout)
      document.removeEventListener(eventType, onEvent, true)
      longTasks.push(...observer.takeRecords())
      observer.disconnect()
      if (error && profileStarted) console.profileEnd(cpuProfileTitle)
      if (error) fail(error)
      else settle({ elapsedMs: end - start, longTasksMs: longTasks.filter(entry =>
        entry.startTime <= end && entry.startTime + entry.duration >= start).map(entry => entry.duration),
        trusted: true, eventType,
        ...(diagnostic ? { phase: action === 'input' ? { totalMs: end - start,
          beforeInputToVisibleFrameMs: firstVisibleAt - start,
          visibleFrameToNextFrameMs: end - firstVisibleAt, frameChecks } : { totalMs: end - start,
          eventToFirstVisibleRafMs: firstVisibleAt - start,
          firstVisibleToNextRafMs: end - firstVisibleAt, frameChecks } } : {}) })
    }
    const nextFrame = () => requestAnimationFrame(() => {
      if (diagnostic) frameChecks++
      const visible = action === 'input' ? firstLine().startsWith('测') : window.getSelection()?.toString() === '春'
      if (!visible) return nextFrame()
      if (diagnostic) firstVisibleAt = performance.now()
      if (profileStarted) { console.profileEnd(cpuProfileTitle); profileStarted = false }
      requestAnimationFrame(() => finish(null, performance.now()))
    })
    const onEvent = event => {
      if (start !== null || !event.isTrusted || (action === 'input' ? event.data !== '测' : !(event.key === 'ArrowRight' && event.shiftKey))) return
      start = performance.now()
      if (cpuProfileTitle) { console.profile(cpuProfileTitle); profileStarted = true }
      nextFrame()
    }
    const timeout = setTimeout(() => finish(new Error(`PERF_${action.toUpperCase()}_EVENT_OR_DOM_TIMEOUT`)), 10_000)
    document.addEventListener(eventType, onEvent, true)
  }, { action, editorSelector, diagnostic, cpuProfileTitle })
  if (action === 'input') await page.keyboard.insertText('测')
  else await page.keyboard.press('Shift+ArrowRight')
  const result = await page.evaluate(() => window.__u06EditorProbe)
  assert.equal(result.trusted, true)
  if (action === 'input') {
    await page.keyboard.press('Control+z')
    await page.waitForFunction(selector => {
      const line = document.querySelector(`${selector} .cm-line`)?.cloneNode(true)
      line?.querySelector('.cm-lp-paperhead')?.remove()
      return !line?.textContent?.startsWith('测')
    }, editorSelector)
  } else await page.keyboard.press('ArrowLeft')
  return result
}

async function measureEditorInteractionV2(page, action, expectedDocument, editorSelector = '.writer-editor-content .cm-content[contenteditable="true"]', diagnostic = false, cpuProfileTitle = null) {
  await page.evaluate(({ action, expectedDocument, editorSelector, diagnostic, cpuProfileTitle }) => {
    const editor = document.querySelector(editorSelector)
    if (!editor) throw new Error('PERF_EDITOR_MISSING')
    const view = editor.cmTile?.root?.view
    if (!view?.state?.doc || !view.state.selection?.main) throw new Error('PERF_EDITOR_STATE_UNAVAILABLE')
    const firstLine = () => {
      const line = editor.querySelector('.cm-line')?.cloneNode(true)
      line?.querySelector('.cm-lp-paperhead')?.remove()
      return line?.textContent ?? ''
    }
    const before = view.state.selection.main
    const nativeSelection = window.getSelection()
    if (!document.hasFocus()) throw new Error('PERF_WINDOW_NOT_FOCUSED')
    if (view.state.doc.toString() !== expectedDocument || before.anchor !== 0 || before.head !== 0 || nativeSelection?.toString()) {
      throw new Error('PERF_PRESTATE_MISMATCH')
    }
    let settle, fail
    window.__u06EditorProbe = new Promise((resolve, reject) => { settle = resolve; fail = reject })
    const longTasks = []
    const observer = PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver(list => longTasks.push(...list.getEntries())) : null
    observer?.observe({ entryTypes: ['longtask'] })
    let start = null
    let firstVisibleAt = null
    let frameChecks = 0
    let profileStarted = false
    const eventType = action === 'input' ? 'beforeinput' : 'keydown'
    const terminal = () => {
      const selection = view.state.selection.main
      const browserSelection = window.getSelection()
      const documentMatches = action === 'input'
        ? view.state.doc.toString() === `测${expectedDocument}`
        : view.state.doc.toString() === expectedDocument
      const caretOrSelectionMatches = action === 'input'
        ? selection.anchor === 1 && selection.head === 1 && !!browserSelection?.isCollapsed
        : selection.anchor === 0 && selection.head === 1 && view.state.sliceDoc(0, 1) === '春' && browserSelection?.toString() === '春'
      const line = editor.querySelector('.cm-line')
      const lineText = firstLine()
      const editorRect = editor.getBoundingClientRect()
      const lineRect = line?.getBoundingClientRect()
      const browserRange = browserSelection?.rangeCount ? browserSelection.getRangeAt(0) : null
      const rangeRect = browserRange?.getBoundingClientRect()
      let nativeAnchor = null, nativeHead = null, nativeRangeStart = null, nativeRangeEnd = null
      if (browserSelection?.anchorNode && browserSelection.focusNode) {
        try {
          nativeAnchor = view.posAtDOM(browserSelection.anchorNode, browserSelection.anchorOffset)
          nativeHead = view.posAtDOM(browserSelection.focusNode, browserSelection.focusOffset)
          if (browserRange) {
            nativeRangeStart = view.posAtDOM(browserRange.startContainer, browserRange.startOffset)
            nativeRangeEnd = view.posAtDOM(browserRange.endContainer, browserRange.endOffset)
          }
        } catch { /* an unmappable native selection is a failed terminal state */ }
      }
      const focused = document.hasFocus()
      const visible = document.visibilityState === 'visible'
      const editorStyle = getComputedStyle(editor)
      const lineInViewport = !!lineRect && lineRect.top < innerHeight && lineRect.bottom > 0 && lineRect.left < innerWidth && lineRect.right > 0
      const visibleDomMatches = visible && editorStyle.visibility !== 'hidden' && Number(editorStyle.opacity) > 0 &&
        editorRect.width > 0 && editorRect.height > 0 && lineInViewport && lineRect.width > 0 && lineRect.height > 0 &&
        (action === 'input' ? lineText.startsWith('测') : lineText.startsWith('春') && !!rangeRect && rangeRect.height > 0)
      return { documentMatches, caretOrSelectionMatches, visibleDomMatches, secondRaf:true, nativeAnchor, nativeHead,
        nativeRangeStart, nativeRangeEnd, focused, visible,
        documentLength: view.state.doc.length, anchor: selection.anchor, head: selection.head, visiblePrefix: lineText.slice(0, 8) }
    }
    const finish = (error, end, observation) => {
      clearTimeout(timeout)
      document.removeEventListener(eventType, onEvent, true)
      if (observer) {
        longTasks.push(...observer.takeRecords())
        observer.disconnect()
      }
      if (error && profileStarted) console.profileEnd(cpuProfileTitle)
      if (error) fail(error)
      else settle({ elapsedMs: end - start, longTasksMs: longTasks.filter(entry =>
        entry.startTime <= end && entry.startTime + entry.duration >= start).map(entry => entry.duration),
        trusted: true, eventType, observation,
        ...(diagnostic ? { phase: action === 'input' ? { totalMs: end - start,
          beforeInputToVisibleFrameMs: firstVisibleAt - start,
          visibleFrameToNextFrameMs: end - firstVisibleAt, frameChecks } : { totalMs: end - start,
          eventToFirstVisibleRafMs: firstVisibleAt - start,
          firstVisibleToNextRafMs: end - firstVisibleAt, frameChecks } } : {}) })
    }
    const nextFrame = () => requestAnimationFrame(() => {
      if (diagnostic) frameChecks++
      const observed = terminal()
      if (!observed.focused || !observed.visible) return finish(new Error('PERF_WINDOW_NOT_FOCUSED_AFTER_EVENT'))
      if (!observed.documentMatches || !observed.caretOrSelectionMatches || !observed.visibleDomMatches) return nextFrame()
      if (diagnostic) firstVisibleAt = performance.now()
      if (profileStarted) { console.profileEnd(cpuProfileTitle); profileStarted = false }
      requestAnimationFrame(() => {
        const finalState = terminal()
        if (!finalState.focused || !finalState.visible) return finish(new Error('PERF_WINDOW_NOT_FOCUSED_AFTER_EVENT'))
        if (!finalState.documentMatches || !finalState.caretOrSelectionMatches || !finalState.visibleDomMatches) return nextFrame()
        finish(null, performance.now(), { eventCapturedInRenderer:true, trustedEvent:true, targetIsEditor:true,
          capturePhase:true, preStateMatched:true, terminal:finalState })
      })
    })
    const onEvent = event => {
      const expectedEvent = action === 'input' ? event.type === 'beforeinput' && event.data === '测' && event.inputType === 'insertText'
        : event.type === 'keydown' && event.key === 'ArrowRight' && event.shiftKey
      if (start !== null || !event.isTrusted || !editor.contains(event.target) || !expectedEvent) return
      start = performance.now()
      if (cpuProfileTitle) { console.profile(cpuProfileTitle); profileStarted = true }
      nextFrame()
    }
    const timeout = setTimeout(() => finish(new Error(start === null ? `PERF_${action.toUpperCase()}_EVENT_NOT_CAPTURED`
      : `PERF_${action.toUpperCase()}_TERMINAL_STATE_TIMEOUT`)), 10_000)
    document.addEventListener(eventType, onEvent, true)
  }, { action, expectedDocument, editorSelector, diagnostic, cpuProfileTitle })
  if (action === 'input') await page.keyboard.insertText('测')
  else await page.keyboard.press('Shift+ArrowRight')
  const result = await page.evaluate(() => window.__u06EditorProbe)
  assert.equal(result.trusted, true)
  if (action === 'input') {
    await page.keyboard.press('Control+z')
    await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.cmTile?.root?.view?.state?.doc.toString() === expected,
      { selector: editorSelector, expected: expectedDocument })
  } else await page.keyboard.press('ArrowLeft')
  return result
}

async function measureClassicSelectionDiagnostic(page) {
  const idleFrameMs = await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(first => requestAnimationFrame(second => resolve(second - first)))))
  await page.evaluate(() => {
    const editor = document.querySelector('.cm-content[contenteditable="true"]')
    if (!editor) throw new Error('SELECTION_EDITOR_MISSING')
    let settle, fail, started = false, keydownAt = null, microtask = null, bubbleReached = false
    const snapshot = () => {
      const selected = window.getSelection()
      const bubble = document.querySelector('.fixed.z-50.select-none')
      return { editorFocused: editor.contains(document.activeElement), selectedText: selected?.toString() ?? null,
        selectionCollapsed: selected?.isCollapsed ?? null, anchorInEditor: editor.contains(selected?.anchorNode),
        bubbleVisible: !!bubble && bubble.getClientRects().length > 0 && getComputedStyle(bubble).visibility !== 'hidden' }
    }
    const finish = (error, result) => {
      clearTimeout(timeout)
      document.removeEventListener('keydown', onCapture, true)
      document.removeEventListener('keydown', onBubble)
      if (error) fail(error)
      else settle(result)
    }
    const onCapture = event => {
      if (started || !event.isTrusted || event.key !== 'ArrowRight' || !event.shiftKey) return
      started = true
      keydownAt = performance.now()
      const before = snapshot()
      requestAnimationFrame(() => {
        const firstRaf = { atMs: performance.now() - keydownAt, ...snapshot() }
        requestAnimationFrame(() => finish(null, { before, bubbleReached, microtaskObserved: microtask !== null, microtask,
          firstRaf, secondRaf: { atMs: performance.now() - keydownAt, ...snapshot() } }))
      })
    }
    const onBubble = event => {
      if (!started || !event.isTrusted || event.key !== 'ArrowRight' || !event.shiftKey) return
      bubbleReached = true
      queueMicrotask(() => { microtask = { atMs: performance.now() - keydownAt, ...snapshot() } })
    }
    const timeout = setTimeout(() => finish(new Error('SELECTION_EVENT_OR_FRAMES_TIMEOUT')), 10_000)
    window.__u06SelectionProbe = new Promise((resolve, reject) => { settle = resolve; fail = reject })
    document.addEventListener('keydown', onCapture, true)
    document.addEventListener('keydown', onBubble)
  })
  await page.keyboard.press('Shift+ArrowRight')
  const result = await page.evaluate(() => window.__u06SelectionProbe)
  await page.keyboard.press('ArrowLeft')
  return { idleFrameMs, ...result }
}

async function measurePairedSelectionArm(page, control) {
  await page.evaluate(control => {
    const editor = document.querySelector('.cm-content[contenteditable="true"]')
    if (!editor) throw new Error('SELECTION_EDITOR_MISSING')
    const ready = () => window.getSelection()?.toString() === '春'
    if (ready() !== control) throw new Error('SELECTION_PAIR_PRESTATE_MISMATCH')
    let settle, fail, started = false
    window.__u06PairedSelectionProbe = new Promise((resolve, reject) => { settle = resolve; fail = reject })
    const finish = (error, result) => {
      clearTimeout(timeout)
      document.removeEventListener('keydown', onKeydown, true)
      if (error) fail(error)
      else settle(result)
    }
    const onKeydown = event => {
      if (started || !event.isTrusted || event.key !== 'ArrowRight' || !event.shiftKey) return
      started = true
      if (control) event.preventDefault()
      const t0 = performance.now()
      let readiness = null
      queueMicrotask(() => { if (ready()) readiness = performance.now() })
      requestAnimationFrame(() => {
        const rAF1 = performance.now()
        if (!ready()) return finish(new Error('SELECTION_PAIR_RAF1_NOT_READY'))
        readiness ??= rAF1
        requestAnimationFrame(() => finish(null, { t0, readiness, rAF1, rAF2: performance.now() }))
      })
    }
    const timeout = setTimeout(() => finish(new Error('SELECTION_PAIR_EVENT_OR_FRAMES_TIMEOUT')), 10_000)
    document.addEventListener('keydown', onKeydown, true)
  }, control)
  await page.keyboard.press('Shift+ArrowRight')
  return page.evaluate(() => window.__u06PairedSelectionProbe)
}

async function performanceMain() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U06 editor performance',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48,
    retainedReason: 'isolated packaged editor performance evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app, page, failure, exit, buildReceipt = null, previous = null, currentSample = null
  let currentStep = 'package'
  const frozenProtocol = JSON.parse(fs.readFileSync(path.join(repository, 'docs/plans/novel-quality-program-v3-2026-09-13/feature-union.json'), 'utf8')).editorProtocol
  const protocol = resolveEditorProtocol(frozenProtocol, 'editor-interaction-v2')
  const samples = {}, sampleAttempts = [], phaseSamples = {}, cpuProfiles = [], fixtures = {}, fixtureBodies = {}, environment = {}
  let measurementConditions = null
  try {
    assert.equal(fileHash(executablePath), expectedExe)
    assert.equal(fileHash(asarPath), expectedAsar)
    if (candidatePackage) {
      const receiptPath = path.resolve(option('build-receipt'))
      buildReceipt = verifyCandidateBuildReceipt(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), receiptPath)
    }
    previous = priorReceipt ? JSON.parse(fs.readFileSync(priorReceipt, 'utf8')) : null
    if (previous) {
      assert.equal(previous.outcome, 'INVALID', 'only an environment INVALID may be rerun')
      assert.equal(previous.artifact.executableSha256, expectedExe)
      assert.equal(previous.artifact.asarSha256, expectedAsar)
      assert.equal(previous.testedSha, testedSha)
      assert.equal(previous.driver.sha256, fileHash(scriptPath), 'driver changed since invalid sample')
    }
    const launched = await launch()
    app = launched.app
    page = launched.page
    for (const units of protocol.units) {
      currentStep = `fixture-${units}`
      const name = `U06-${units}`
      const body = ('春'.repeat(100) + '\n').repeat(units / 100).trimEnd()
      assert.equal((body.match(/春/g) ?? []).length, units)
      fixtureBodies[units] = body
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
      window.focus()
    })
    await page.bringToFront()
    environment.window = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { width: window.getSize()[0], height: window.getSize()[1], zoomLevel: window.webContents.getZoomLevel(),
        zoomFactor: window.webContents.getZoomFactor(), visible: window.isVisible(), minimized: window.isMinimized(),
        focused: window.isFocused(), webContentsFocused: window.webContents.isFocused() }
    })
    assert.deepEqual(environment.window, { width: 1440, height: 900, zoomLevel: 0, zoomFactor: 1,
      visible: true, minimized: false, focused: true, webContentsFocused: true })
    environment.display = await page.evaluate(() => ({ devicePixelRatio: window.devicePixelRatio, width: screen.width,
      height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight }))
    if (previous) assert.deepEqual(environment.window, previous.environment.window)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      globalThis.__u06WindowEvents = []
      window.on('blur', () => globalThis.__u06WindowEvents.push({ type:'blur', at:Date.now() }))
      window.on('minimize', () => globalThis.__u06WindowEvents.push({ type:'minimize', at:Date.now() }))
    })
    for (const units of protocol.units) {
      currentStep = `U06.${units === 3000 ? 'A08' : 'A09'}`
      await page.locator('.writer-shelf').getByRole('button', { name: `打开《U06-${units}》` }).click()
      await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
      const editor = page.locator('.writer-editor-content .cm-content[contenteditable="true"]')
      await editor.waitFor({ state: 'visible' })
      await editor.locator('.cm-lp-dropcap-char').waitFor({ state: 'visible' })
      await page.locator('.writer-editor-content').getByText(`${units.toLocaleString('zh-CN')} 字`, { exact: true }).waitFor({ state: 'visible' })
      const font = await page.locator('.writer-editor-content .cm-scroller').evaluate(element => getComputedStyle(element).fontFamily)
      const fontLoad = await editor.evaluate(async () => {
        await document.fonts.ready
        const faces = [...document.fonts].filter(face => face.family.replaceAll('"', '').includes('LXGW WenKai'))
        return { check:document.fonts.check('16px "LXGW WenKai"'), faces:faces.map(face => ({ family:face.family, status:face.status })) }
      })
      const fontLoaded = fontLoad.check && fontLoad.faces.some(face => face.status === 'loaded')
      environment.font ??= font
      assert.equal(font, environment.font, 'font drift between fixed fixtures')
      environment.fontLoadedByUnits ??= {}
      environment.fontLoadedByUnits[units] = { loaded:fontLoaded, ...fontLoad }
      assert.equal(fontLoaded, true, 'V3 LXGW WenKai font not loaded')
      if (previous) assert.equal(font, previous.environment.font)
      if (!measurementConditions) {
        measurementConditions = { protocolId:protocol.protocolId, testedSha, driverSha256:fileHash(scriptPath),
          executableSha256:expectedExe, asarSha256:expectedAsar, window:environment.window, display:environment.display, font, fontLoaded }
        if (previous) {
          const sameConditions = JSON.stringify(previous.measurementConditions) === JSON.stringify(measurementConditions)
          assert(sameConditions, 'rerun test machine, window, display, font, package, driver, or protocol changed')
        }
      }
      await page.bringToFront()
      assert.equal(createHash('sha256').update(storedBody(fixtures[units].projectPath, fixtures[units].draftId)).digest('hex'),
        fixtures[units].bodySha256, 'fixture changed before measurement')
      if (!phaseDiagnostic) samples[units] = { writer: {} }
      if (phaseDiagnostic) phaseSamples[units] = { warmup: [], raw: [] }
      const expectedDocument = fixtureBodies[units]
      assert.equal(typeof expectedDocument, 'string', 'performance fixture body is unavailable')
      assert(expectedDocument.length > 0, 'performance fixture body is empty')
      assert.equal(createHash('sha256').update(expectedDocument).digest('hex'), fixtures[units].bodySha256,
        'performance fixture body differs from its recorded source hash')
      const cpuProfiler = phaseDiagnostic && units === 200000 ? await openCpuProfiler(page) : null
      if (cpuProfiler) environment.cpuProfiler = { supported: !!cpuProfiler.session, error: cpuProfiler.error ?? null }
      for (let index = 0; index < protocol.warmupCount + protocol.sampleCount; index++) {
        for (const action of protocol.actions) {
          const phase = index < protocol.warmupCount ? 'warmup' : 'raw'
          currentSample = { units, action, index, phase }
          await editor.click()
          await page.keyboard.press('Control+Home')
          const windowState = await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]
            return { focused:window.isFocused(), visible:window.isVisible(), minimized:window.isMinimized(), eventCount:globalThis.__u06WindowEvents.length }
          })
          if (!windowState.focused || !windowState.visible || windowState.minimized) throw new Error('PERF_WINDOW_NOT_FOCUSED')
          const cpuTitle = cpuProfiler?.session && action === 'input' && index >= protocol.warmupCount ? `U06-${units}-${index}` : null
          const pendingProfile = cpuTitle ? waitForCpuProfile(cpuProfiler.session, cpuTitle).catch(error => error) : null
          let result
          try {
            result = await measureEditorInteractionV2(page, action, expectedDocument, undefined,
              phaseDiagnostic && action === 'input', cpuTitle)
          } catch (error) {
            if (!phaseDiagnostic) {
              const attempt = recordEditorAttempt(samples, sampleAttempts, { ...currentSample, error })
              attempt.windowEvents = await app.evaluate(({ start }) => globalThis.__u06WindowEvents.slice(start), { start:windowState.eventCount })
            }
            throw error
          }
          let attempt
          if (!phaseDiagnostic) attempt = recordEditorAttempt(samples, sampleAttempts, { ...currentSample, result })
          const windowEvents = await app.evaluate(({ start }) => globalThis.__u06WindowEvents.slice(start), { start:windowState.eventCount })
          if (attempt) attempt.windowEvents = windowEvents
          if (windowEvents.some(event => event.type === 'blur' || event.type === 'minimize')) {
            if (attempt) attempt.outcome = 'INVALID'
            throw new Error('PERF_WINDOW_NOT_FOCUSED_AFTER_EVENT')
          }
          if (pendingProfile) {
            const profile = await pendingProfile
            if (profile instanceof Error) {
              environment.cpuProfiler = { supported: false, error: String(profile) }
              await cpuProfiler.session.detach()
              cpuProfiler.session = null
            } else {
              const rawPath = path.join(receiptDir, `cpu-profile-${units}-${index}.json`)
              fs.writeFileSync(rawPath, JSON.stringify(profile))
              cpuProfiles.push({ units, index, rawPath, sha256: fileHash(rawPath), topStacks: topCpuStacks(profile) })
            }
          }
          if (phaseDiagnostic && action === 'input') phaseSamples[units][index < protocol.warmupCount ? 'warmup' : 'raw'].push({
            ...result.phase, trusted: result.trusted, eventType: result.eventType })
          currentSample = null
        }
      }
      await cpuProfiler?.session?.detach()
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
    if (!phaseDiagnostic) {
      const sameConditions = !!previous && JSON.stringify(previous.measurementConditions) === JSON.stringify(measurementConditions)
      const receiptForCheck = { protocolId: protocol.protocolId,
        measurementSource: protocol.measurementSource, production: true, writerLivePreview: true,
        imeExactMatch: false, imeLossCount: null, imeDuplicateCount: null, selectionUndoExact: false,
        rerunIndex, ...(previous ? { priorReceipt: { outcome:previous.outcome, invalidReason:previous.invalidReason?.message ?? '',
          sameConditions, rerunIndex:previous.rerunIndex } } : {}), samples }
      const checked = checkEditorReceipt(protocol, receiptForCheck)
      environment.checker = checked
      if (!checked.ok) {
        currentStep = 'checker'
        assertEditorReceipt(protocol, receiptForCheck)
      }
      for (const units of protocol.units) steps.push({ stepId: `editor-performance-${units}`, actionId: units === 3000 ? 'U06.A08' : 'U06.A09',
        outcome: checked.ok ? 'PASS' : 'FAIL', assertion: 'editor-interaction-v2 renderer event to complete editor/visible-DOM terminal state',
        observed: checked.statistics })
    }
  } catch (error) {
    if (currentSample && !sampleAttempts.some(attempt => attempt.units === currentSample.units && attempt.action === currentSample.action &&
      attempt.index === currentSample.index && attempt.phase === currentSample.phase)) {
      recordEditorAttempt(samples, sampleAttempts, { ...currentSample, error })
    }
    failure = { step: currentStep, ...(currentSample ? { sample:currentSample } : {}), name: error?.name, message: error?.message }
  } finally {
    if (app) try { exit = await quit(app) } catch (error) { failure ??= { step: 'exit', message: String(error) } }
    const invalidReason = isEditorEnvironmentInvalid(failure, sampleAttempts)
      ? { kind:'environment', message:failure.message } : null
    const receipt = phaseDiagnostic ? { outcome: failure ? 'FAIL' : 'DIAGNOSTIC_ONLY', qualification: 'DIAGNOSTIC_ONLY',
      checker: 'NOT_RUN', sampleUse: 'NOT_ELIGIBLE_FOR_EDITOR_GATE', testedSha,
      ...(candidatePackage ? { buildReceipt } : {}), executionHead: git('rev-parse', 'HEAD'),
      measurement: 'trusted beforeinput handler to first rAF with visible .cm-line text to next rAF; DOM check, not painted pixels',
      artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
      driver: { path: scriptPath, sha256: fileHash(scriptPath) }, profile: { ...profile, scratch },
      fixtures, environment, phaseSamples, cpuProfiles, failure, exit } : {
      outcome: failure ? (invalidReason ? 'INVALID' : 'FAIL') : environment.checker?.ok ? 'PASS' : 'FAIL',
      qualification: 'F05_U06_EDITOR_INTERACTION_V2_RESPONSIVENESS',
      testedSha, ...(candidatePackage ? { buildReceipt } : {}),
      protocolId: 'editor-interaction-v2',
      measurementSource: protocol.measurementSource, rerunIndex, priorReceipt, priorReceiptSha256: priorReceipt ? fileHash(priorReceipt) : null,
      executionHead: git('rev-parse', 'HEAD'), changedPaths: git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean),
      sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
      measurementConditions, invalidReason,
      artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
      driver: { path: scriptPath, sha256: fileHash(scriptPath) }, profile: { ...profile, scratch },
      measurement: 'trusted user input at renderer capture to full document and caret or selection plus visible DOM state after the second rAF; conservative readiness proxy, not painted pixels',
      fixtures, environment, samples, sampleAttempts, activeSample:currentSample, steps, unverifiedActions: ['U06.A03'], failure, exit }
    const receiptPath = path.join(receiptDir, phaseDiagnostic ? 'phase-diagnostic-receipt.json' : 'receipt.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${receiptPath}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

async function historicalClassicMain() {
  const sourceRoot = path.resolve(option('source-root'))
  const historicalPackageDir = path.resolve(option('package-dir'))
  const sourceSha = option('source-sha')
  const executableSha256 = option('exe-sha256')
  const asarSha256 = option('asar-sha256')
  const driverSha256 = option('driver-sha256')
  const historicalExe = path.join(historicalPackageDir, 'AI小说作家.exe')
  const historicalAsar = path.join(historicalPackageDir, 'resources', 'app.asar')
  const oldGit = (...args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim()
  const invokeClassic = (page, channel, ...args) => page.evaluate(({ channel, args }) =>
    window.velaAPI.invoke(channel, ...args), { channel, args })
  const protocolPath = path.join(repository, 'docs/plans/novel-quality-program-v3-2026-09-13/feature-union.json')
  const protocol = JSON.parse(fs.readFileSync(protocolPath, 'utf8')).editorProtocol
  let app, failure, exit, sourceExecutionHead = null, sourceDirty = null
  const assertSourceClean = () => assert(sourceDirty === '' || (phaseDiagnostic || selectionDiagnostic || pairedSelectionDiagnostic) && sourceDirty === 'M plugins/dsh-ai-novel-writer/AGENTS.md',
    'historical source must be clean except the preserved diagnostic-only plugin AGENTS edit')
  let currentStep = 'preflight'
  const fixtures = {}, samples = {}, phaseSamples = {}, selectionSamples = {}, pairedSelectionSamples = [], cpuProfiles = [], environment = { measuredAt: new Date().toISOString(), preview: {
    classicLivePreviewSupported: false, writerV3LivePreviewRequired: true,
    source: 'historical Classic DraftEditor uses CodeMirror prose without livePreview extension' } }
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel U06 historical Classic baseline candidate',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48,
    retainedReason: 'isolated packaged historical editor raw samples',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const waitForMarker = async markerPath => {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (fs.existsSync(markerPath)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out waiting for historical smoke marker: ${markerPath}`)
  }
  const launchClassic = async projectPath => {
    const markerPath = projectPath ? path.join(scratch, `smoke-open-${randomUUID()}.json`) : null
    const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy,
      AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home,
      APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
    if (projectPath) { env.AI_NOVEL_SMOKE_OPEN_PROJECT = projectPath; env.AI_NOVEL_SMOKE_PROJECT_MARKER = markerPath }
    const launchStartedAt = Date.now()
    const launched = await electron.launch({ executablePath: historicalExe, cwd: historicalPackageDir,
      args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
    const page = await launched.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(15_000)
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await page.evaluate(() => typeof window.velaAPI?.invoke), 'function', 'historical preload unavailable')
    return { launched, page, markerPath, launchStartedAt }
  }
  try {
    assert.equal(protocol.id, 'editor-absolute-v1')
    assert.deepEqual(protocol.units, [3000, 200000])
    assert.equal(protocol.warmupCount, 3)
    assert.equal(protocol.sampleCount, 7)
    assert.deepEqual(protocol.actions, ['input', 'selection'])
    assert.equal(sourceSha, '2264390d6fb8b052cc14736d544df0cc74516649', 'unexpected historical Classic source')
    assert.equal(path.resolve(oldGit('rev-parse', '--show-toplevel')).toLowerCase(), sourceRoot.toLowerCase(), 'source root mismatch')
    sourceExecutionHead = oldGit('rev-parse', 'HEAD')
    sourceDirty = oldGit('status', '--porcelain', '--untracked-files=all')
    assert.equal(sourceExecutionHead, sourceSha, 'historical source HEAD changed')
    assertSourceClean()
    assert.equal(path.relative(sourceRoot, historicalPackageDir).replaceAll('\\', '/'), 'release/1.1.0/win-unpacked', 'package is outside historical release dir')
    assert.match(executableSha256, /^[0-9a-f]{64}$/)
    assert.match(asarSha256, /^[0-9a-f]{64}$/)
    assert.equal(fileHash(historicalExe), executableSha256, 'historical executable hash mismatch')
    assert.equal(fileHash(historicalAsar), asarSha256, 'historical asar hash mismatch')
    assert.equal(fileHash(scriptPath), driverSha256, 'U06 driver hash mismatch')
    environment.protocolSha256 = fileHash(protocolPath)
    environment.host = { computerName: process.env.COMPUTERNAME ?? null, platform: process.platform,
      arch: process.arch, node: process.version }

    currentStep = 'fixture'
    let page
    ;({ launched: app, page } = await launchClassic())
    for (const units of pairedSelectionDiagnostic ? [3000] : protocol.units) {
      const body = ('春'.repeat(100) + '\n').repeat(units / 100).trimEnd()
      assert.equal((body.match(/春/g) ?? []).length, units)
      const created = await invokeClassic(page, 'project:create', { path: profile.projects, name: `U06-${units}`,
        genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID())
      assert.equal(created.success, true, created.error)
      const opened = await invokeClassic(page, 'project:open', created.projectPath, randomUUID())
      assert.equal(opened.success, true, opened.error)
      assert.equal(opened.project?.id, created.projectId, 'historical project identity changed')
      assert.equal(path.resolve(opened.project.path), path.resolve(created.projectPath), 'historical project path changed')
      assert(typeof opened.project.sessionLease === 'string' && opened.project.sessionLease, 'historical project lease missing')
      const context = { projectId: opened.project.id, projectPath: opened.project.path, leaseId: opened.project.sessionLease }
      const draft = await invokeClassic(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
        content: body, wordCount: units }, created.projectPath, context)
      assert.equal(draft.success, true, draft.error)
      const draftId = draft.id ?? draft.draft?.id
      assert(Number.isInteger(draftId))
      assert.equal(storedBody(created.projectPath, draftId, true), body)
      fixtures[units] = { projectPath: created.projectPath, draftId, bodySha256: createHash('sha256').update(body).digest('hex'), units }
    }
    exit = await quit(app)
    assert.equal(exit.forced, false)
    app = null

    for (const units of pairedSelectionDiagnostic ? [3000] : protocol.units) {
      currentStep = `U06.${units === 3000 ? 'A08' : 'A09'}`
      let markerPath, launchStartedAt
      ;({ launched: app, page, markerPath, launchStartedAt } = await launchClassic(fixtures[units].projectPath))
      await waitForMarker(markerPath)
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
      assert.equal(marker.projectPath.toLowerCase(),
        path.resolve(fixtures[units].projectPath).toLowerCase(), 'historical smoke-open confirmation mismatch')
      assert(Date.parse(marker.openedAt ?? '') >= launchStartedAt - 1_000, 'historical smoke-open marker is stale')
      await page.getByText('草稿_v1', { exact: true }).click()
      const editor = page.locator('.cm-content[contenteditable="true"]')
      await editor.waitFor({ state: 'visible' })
      assert.equal(await editor.count(), 1, 'historical draft editor must be unique')
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.setSize(1440, 900)
        window.webContents.setZoomLevel(0)
      })
      const windowState = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return { width: window.getSize()[0], height: window.getSize()[1], zoomLevel: window.webContents.getZoomLevel(),
          zoomFactor: window.webContents.getZoomFactor() }
      })
      assert.deepEqual(windowState, { width: 1440, height: 900, zoomLevel: 0, zoomFactor: 1 })
      environment.window ??= windowState
      const font = await editor.locator('xpath=..').evaluate(async element => {
        await document.fonts.ready
        return { family: getComputedStyle(element).fontFamily, loaded: document.fonts.check('16px "LXGW WenKai"') }
      })
      assert.match(font.family, /LXGW WenKai/)
      assert.equal(font.loaded, true, 'LXGW WenKai did not load')
      environment.font ??= font
      assert.deepEqual(font, environment.font, 'font drift between historical fixtures')
      assert.equal(createHash('sha256').update(storedBody(fixtures[units].projectPath, fixtures[units].draftId, true)).digest('hex'),
        fixtures[units].bodySha256, 'historical fixture changed before measurement')
      const actionSamples = { input: { warmupSamplesMs: [], rawSamplesMs: [], longTasksMs: [] },
        selection: { warmupSamplesMs: [], rawSamplesMs: [], longTasksMs: [] } }
      if (phaseDiagnostic) phaseSamples[units] = { warmup: [], raw: [], selection: { warmup: [], raw: [] } }
      const cpuProfiler = phaseDiagnostic && units === 200000 ? await openCpuProfiler(page) : null
      if (cpuProfiler) environment.cpuProfiler = { supported: !!cpuProfiler.session, error: cpuProfiler.error ?? null }
      fixtures[units].measuredAt = new Date().toISOString()
      if (pairedSelectionDiagnostic) {
        for (let index = 0; index < 8; index++) {
          await editor.click()
          await page.keyboard.press('Control+Home')
          const real = await measurePairedSelectionArm(page, false)
          const control = await measurePairedSelectionArm(page, true)
          assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '春', 'control changed editor selection')
          pairedSelectionSamples.push({ pair: index + 1, real, control })
          await page.keyboard.press('ArrowLeft')
        }
      }
      if (selectionDiagnostic) selectionSamples[units] = []
      for (let index = 0; index < (pairedSelectionDiagnostic ? 0 : selectionDiagnostic ? protocol.sampleCount : protocol.warmupCount + protocol.sampleCount); index++) {
        if (selectionDiagnostic) {
          await editor.click()
          await page.keyboard.press('Control+Home')
          selectionSamples[units].push(await measureClassicSelectionDiagnostic(page))
          continue
        }
        for (const action of protocol.actions) {
          await editor.click()
          await page.keyboard.press('Control+Home')
          const cpuTitle = cpuProfiler?.session && action === 'input' && index >= protocol.warmupCount ? `U06-${units}-${index}` : null
          const pendingProfile = cpuTitle ? waitForCpuProfile(cpuProfiler.session, cpuTitle).catch(error => error) : null
          const result = await measureEditorAction(page, action, '.cm-content[contenteditable="true"]', phaseDiagnostic, cpuTitle)
          if (pendingProfile) {
            const profile = await pendingProfile
            if (profile instanceof Error) {
              environment.cpuProfiler = { supported: false, error: String(profile) }
              await cpuProfiler.session.detach()
              cpuProfiler.session = null
            } else {
              const rawPath = path.join(receiptDir, `cpu-profile-${units}-${index}.json`)
              fs.writeFileSync(rawPath, JSON.stringify(profile))
              cpuProfiles.push({ units, index, rawPath, sha256: fileHash(rawPath), topStacks: topCpuStacks(profile) })
            }
          }
          if (phaseDiagnostic && action === 'input') phaseSamples[units][index < protocol.warmupCount ? 'warmup' : 'raw'].push({
            ...result.phase, trusted: result.trusted, eventType: result.eventType })
          if (phaseDiagnostic && action === 'selection') phaseSamples[units].selection[index < protocol.warmupCount ? 'warmup' : 'raw'].push({
            ...result.phase, trusted: result.trusted, eventType: result.eventType })
          if (!phaseDiagnostic) {
            actionSamples[action][index < protocol.warmupCount ? 'warmupSamplesMs' : 'rawSamplesMs'].push(result.elapsedMs)
            actionSamples[action].longTasksMs.push(...result.longTasksMs)
          }
        }
      }
      await cpuProfiler?.session?.detach()
      if (!phaseDiagnostic && !selectionDiagnostic && !pairedSelectionDiagnostic) samples[units] = actionSamples
      fixtures[units].measuredUntil = new Date().toISOString()
      assert.equal(createHash('sha256').update(storedBody(fixtures[units].projectPath, fixtures[units].draftId, true)).digest('hex'),
        fixtures[units].bodySha256, 'historical measurement changed SQLite')
      if (!selectionDiagnostic && !pairedSelectionDiagnostic) {
        const save = page.locator('button[title="保存（⌘S）"]')
        await save.click()
        await save.waitFor({ state: 'hidden' })
      }
      assert.equal(createHash('sha256').update(storedBody(fixtures[units].projectPath, fixtures[units].draftId, true)).digest('hex'),
        fixtures[units].bodySha256, 'historical save changed fixed fixture')
      exit = await quit(app)
      assert.equal(exit.forced, false)
      app = null
    }
    sourceExecutionHead = oldGit('rev-parse', 'HEAD')
    sourceDirty = oldGit('status', '--porcelain', '--untracked-files=all')
    assert.equal(sourceExecutionHead, sourceSha, 'historical source moved during measurement')
    assertSourceClean()
    assert.equal(fileHash(historicalExe), executableSha256, 'historical executable changed during measurement')
    assert.equal(fileHash(historicalAsar), asarSha256, 'historical asar changed during measurement')
    assert.equal(fileHash(scriptPath), driverSha256, 'U06 driver changed during measurement')
    environment.measuredUntil = new Date().toISOString()
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
  } finally {
    if (app) try { exit = await quit(app) } catch (error) { failure ??= { step: 'exit', message: String(error) } }
    const receipt = pairedSelectionDiagnostic ? { outcome: failure ? 'FAIL' : 'DIAGNOSTIC_ONLY', qualification: 'DIAGNOSTIC_ONLY',
      checker: 'NOT_RUN', sampleUse: 'NOT_ELIGIBLE_FOR_EDITOR_GATE',
      measurement: '8 predeclared pairs at 3000 units; trusted Shift+ArrowRight, same selected-text readiness predicate and two rAF endpoints; control prevents default editor mutation after real selection',
      limitation: 'control starts with the real arm selected text already present; this is a measurement-only scheduling floor, not a strict counterfactual',
      source: { root: sourceRoot, testedSha: sourceSha,
        executionHead: sourceExecutionHead, clean: sourceDirty === '', sourceDirty }, candidateExecutionHead: git('rev-parse', 'HEAD'),
      artifact: { executablePath: historicalExe, executableSha256: fs.existsSync(historicalExe) ? fileHash(historicalExe) : null,
        expectedExecutableSha256: executableSha256, asarPath: historicalAsar,
        asarSha256: fs.existsSync(historicalAsar) ? fileHash(historicalAsar) : null, expectedAsarSha256: asarSha256 },
      driver: { path: scriptPath, sha256: fileHash(scriptPath), expectedSha256: driverSha256 },
      protocol: { id: protocol.id, sha256: fileHash(protocolPath) }, profile: { ...profile, scratch }, fixtures, environment,
      pairedSelectionSamples, failure, exit } : selectionDiagnostic ? { outcome: failure ? 'FAIL' : 'DIAGNOSTIC_ONLY', qualification: 'DIAGNOSTIC_ONLY',
      checker: 'NOT_RUN', sampleUse: 'NOT_ELIGIBLE_FOR_EDITOR_GATE',
      measurement: 'trusted keydown capture pre-state; document bubble microtask when observable; first and second rAF DOM states; adjacent idle rAF interval; not painted pixels',
      source: { root: sourceRoot, testedSha: sourceSha,
        executionHead: sourceExecutionHead, clean: sourceDirty === '', sourceDirty }, candidateExecutionHead: git('rev-parse', 'HEAD'),
      artifact: { executablePath: historicalExe, executableSha256: fs.existsSync(historicalExe) ? fileHash(historicalExe) : null,
        expectedExecutableSha256: executableSha256, asarPath: historicalAsar,
        asarSha256: fs.existsSync(historicalAsar) ? fileHash(historicalAsar) : null, expectedAsarSha256: asarSha256 },
      driver: { path: scriptPath, sha256: fileHash(scriptPath), expectedSha256: driverSha256 },
      protocol: { id: protocol.id, sha256: fileHash(protocolPath) }, profile: { ...profile, scratch }, fixtures, environment,
      selectionSamples, failure, exit } : phaseDiagnostic ? { outcome: failure ? 'FAIL' : 'DIAGNOSTIC_ONLY', qualification: 'DIAGNOSTIC_ONLY',
      checker: 'NOT_RUN', sampleUse: 'NOT_ELIGIBLE_FOR_EDITOR_GATE',
      measurement: 'trusted beforeinput/keydown handler to first rAF with visible DOM state to next rAF; DOM check, not painted pixels',
      source: { root: sourceRoot, testedSha: sourceSha,
        executionHead: sourceExecutionHead, clean: sourceDirty === '', sourceDirty }, candidateExecutionHead: git('rev-parse', 'HEAD'),
      artifact: { executablePath: historicalExe, executableSha256: fs.existsSync(historicalExe) ? fileHash(historicalExe) : null,
        expectedExecutableSha256: executableSha256, asarPath: historicalAsar,
        asarSha256: fs.existsSync(historicalAsar) ? fileHash(historicalAsar) : null, expectedAsarSha256: asarSha256 },
      driver: { path: scriptPath, sha256: fileHash(scriptPath), expectedSha256: driverSha256 },
      protocol: { id: protocol.id, sha256: fileHash(protocolPath) }, profile: { ...profile, scratch }, fixtures, environment,
      phaseSamples, cpuProfiles, failure, exit } : { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'HISTORICAL_CLASSIC_BASELINE_CANDIDATE_ONLY',
      relativeGate: 'NOT_EVALUATED', source: { root: sourceRoot, testedSha: sourceSha,
        executionHead: sourceExecutionHead, clean: sourceDirty === '', sourceDirty },
      candidateExecutionHead: git('rev-parse', 'HEAD'), artifact: { executablePath: historicalExe,
        executableSha256: fs.existsSync(historicalExe) ? fileHash(historicalExe) : null, expectedExecutableSha256: executableSha256,
        asarPath: historicalAsar, asarSha256: fs.existsSync(historicalAsar) ? fileHash(historicalAsar) : null,
        expectedAsarSha256: asarSha256 }, driver: { path: scriptPath, sha256: fileHash(scriptPath), expectedSha256: driverSha256 },
      protocol: { id: protocol.id, sha256: fileHash(protocolPath) }, profile: { ...profile, scratch }, fixtures, environment,
      samples, failure, exit }
    const receiptPath = path.join(receiptDir, pairedSelectionDiagnostic ? 'paired-selection-diagnostic-receipt.json' : selectionDiagnostic ? 'selection-diagnostic-receipt.json' : phaseDiagnostic ? 'phase-diagnostic-receipt.json' : 'receipt.json')
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${receiptPath}\n`)
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
  let app, page, projectPath, draftId, failure, exit, events = [], buildReceipt = null
  let currentStep = 'package'
  try {
    assert.equal(fileHash(executablePath), expectedExe)
    assert.equal(fileHash(asarPath), expectedAsar)
    if (candidatePackage) {
      const receiptPath = path.resolve(option('build-receipt'))
      buildReceipt = verifyCandidateBuildReceipt(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), receiptPath)
    }
    const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
    if (!candidatePackage) assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productInputs), '', 'product input changed since fixed package')
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
      testedSha, ...(candidatePackage ? { buildReceipt } : {}), executionHead: git('rev-parse', 'HEAD'), changedPaths: git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean),
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
  let app, page, projectPath, draftId, failure, exit, buildReceipt = null
  let currentStep = 'package'
  try {
    assert.equal(fileHash(executablePath), expectedExe)
    assert.equal(fileHash(asarPath), expectedAsar)
    if (candidatePackage) {
      const receiptPath = path.resolve(option('build-receipt'))
      buildReceipt = verifyCandidateBuildReceipt(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), receiptPath)
    }
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
      do { node = walker.nextNode() } while (node && !node.textContent.includes('旧港'))
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

    currentStep = 'U06.A07-reopen'
    exit = await quit(app)
    assert.equal(exit.forced, false, 'saved editor did not close normally')
    app = null
    ;({ app, page } = await launch())
    const reopenNotice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await reopenNotice.isVisible()) await reopenNotice.getByRole('button', { name: '知道了', exact: true }).click()
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await page.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    const reopenedBody = page.locator('.writer-editor-content .cm-content[contenteditable="true"]')
    await reopenedBody.waitFor({ state: 'visible' })
    await reopenedBody.locator('.cm-line').filter({ hasText: '旧港码头' }).waitFor({ state: 'visible' })
    await reopenedBody.locator('.cm-lp-strong').getByText('回声', { exact: true }).waitFor({ state: 'visible' })
    await page.locator('.writer-editor-content').getByText('17 字', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await storedBody(projectPath, draftId), finalBody, 'reopened SQLite draft differs from saved Markdown source')
    pass('saved-draft-reopen', 'U06.A07', 'new packaged process reopened the exact saved draft with its V3 text and 17-unit count')
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
  } finally {
    if (app) try { exit = await quit(app) } catch (error) { failure ??= { step: 'exit', message: String(error) } }
    const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U06_PACKAGED_V3_PARTIAL',
      testedSha, ...(candidatePackage ? { buildReceipt } : {}), executionHead: git('rev-parse', 'HEAD'), changedPaths: git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean),
      sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean),
      artifact: { executablePath, executableSha256: fileHash(executablePath), asarPath, asarSha256: fileHash(asarPath) },
      driver: { path: scriptPath, sha256: fileHash(scriptPath) }, profile: { ...profile, scratch }, projectPath, draftId,
      steps, unverifiedActions: ['U06.A03', 'U06.A08', 'U06.A09'], failure, exit }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${path.join(receiptDir, 'receipt.json')}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

if (historicalClassicMode) await historicalClassicMain()
else if (imeMode) await imeMain()
else if (performanceMode) await performanceMain()
else await main()
