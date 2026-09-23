/* global process */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const driverPath = fileURLToPath(import.meta.url)
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')
const hashFile = file => hashBytes(fs.readFileSync(file))
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = path.resolve(option('package-dir') ?? '')
const testedSha = git('rev-parse', '--verify', `${option('build-sha')}^{commit}`)
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
assert(packageDir && /^[a-f0-9]{64}$/u.test(expectedExe ?? '') && /^[a-f0-9]{64}$/u.test(expectedAsar ?? ''),
  'Pass fixed package directory, build SHA, executable hash and ASAR hash')

const executionHead = git('rev-parse', 'HEAD')
const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml',
  'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
const changedPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`).split('\n').filter(Boolean)
assert.equal(git('diff', '--name-only', `${testedSha}..${executionHead}`, '--', ...productInputs), '',
  'Product source changed since fixed package build')
const dirtyProductPaths = git('status', '--porcelain', '--untracked-files=all', '--', ...productInputs)
  .split('\n').filter(Boolean)
assert.deepEqual(dirtyProductPaths, [], 'Dirty product inputs since packaged build')

const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
assert.equal(hashFile(executablePath), expectedExe)
assert.equal(hashFile(asarPath), expectedAsar)
const driverSha256 = hashFile(driverPath)
const driverSourcePath = path.resolve(option('driver-source') ?? driverPath)
const driverSourceRepository = path.resolve(path.dirname(driverSourcePath), '..')
const driverSourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: driverSourceRepository, encoding: 'utf8',
}).trim()
const driverSourceSha256 = hashFile(driverSourcePath)
assert.equal(driverSha256, driverSourceSha256, 'executed driver differs from its declared source file')
const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u15-export', runId)
assert(process.env.LOCALAPPDATA, 'LOCALAPPDATA is required for isolated profile')
const scratchBase = path.resolve(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'an', 'u15-export')
const scratch = path.join(scratchBase, runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const exportRoot = path.join(scratch, 'exports')
const projectName = '合成导出'
const chapters = [
  // Independent fixture expectations for persisted draft-unit algorithm v3.
  { chapterNumber: 1, title: '雾站', content: '# 第1章 雾站\n\n**铜钥匙**在`旧信`旁。\n\n*雨声*未停。', wordCount: 16 },
  { chapterNumber: 2, title: '归途', content: '列车---驶入\n# 内文标题\n结尾', wordCount: 10 },
]
const expected = {
  merged: '# 合成导出\n\n> 悬疑 · 成年读者\n\n---\n\n# 第1章 雾站\n\n**铜钥匙**在`旧信`旁。\n\n*雨声*未停。\n\n---\n\n# 第2章 归途\n\n列车---驶入\n# 内文标题\n结尾\n\n---\n\n',
  split: [
    '# 第1章 雾站\n\n**铜钥匙**在`旧信`旁。\n\n*雨声*未停。',
    '# 第2章 归途\n\n列车---驶入\n# 内文标题\n结尾',
  ],
  txt: '合成导出\n========\n\n第1章 雾站\n\n铜钥匙在旧信旁。\n\n雨声未停。\n\n第2章 归途\n\n列车\n驶入\n内文标题\n结尾\n\n',
}
const steps = []
const pickerCalls = []
const resultObservations = []
let phase = 'setup'
let app

const invoke = (page, channel, ...args) => page.evaluate(
  ({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args),
  { channel, args },
)
const writer = page => page.locator('.writer-shell[data-shell-presentation="writer"][data-shell-variant="v3"]')
const addPass = (stepId, relatedActionId, assertion, evidence = {}) => steps.push({
  stepId, relatedActionId, outcome: 'PASS', assertion, ...evidence,
})

function fileEvidence(file, expectedText) {
  const actual = fs.readFileSync(file)
  const wanted = Buffer.from(expectedText, 'utf8')
  assert.deepEqual(actual, wanted, `${path.basename(file)} bytes differ from the expected export`)
  return { relativePath: path.relative(exportRoot, file), byteLength: actual.length, sha256: hashBytes(actual) }
}

function exportTreeEvidence(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name)
      const bytes = fs.readFileSync(file)
      return { relativePath: path.relative(directory, file), byteLength: bytes.length, sha256: hashBytes(bytes) }
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy,
    HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const opened = await electron.launch({ executablePath, cwd: packageDir,
    args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
  try {
    await opened.evaluate(({ dialog }, targetDirectory) => {
      globalThis.__f05U15ExportPickerCalls = []
      dialog.showOpenDialog = async options => {
        globalThis.__f05U15ExportPickerCalls.push(options)
        return { canceled: false, filePaths: [targetDirectory] }
      }
    }, exportRoot)
    const page = await opened.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(15_000)
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    await page.evaluate(() => {
      const key = 'ai-novel-writer-appearance'
      const previous = JSON.parse(localStorage.getItem(key) ?? '{}')
      localStorage.setItem(key, JSON.stringify({ ...previous, shellPreference: 'writer',
        revision: Number(previous.revision ?? 0) + 1, origin: 'author' }))
    })
    await page.reload()
    await writer(page).waitFor({ state: 'visible', timeout: 30_000 })
    return { opened, page }
  } catch (error) {
    await opened.close()
    throw error
  }
}

async function collectPickerCalls() {
  if (!app) return
  pickerCalls.push(...await app.evaluate(() => globalThis.__f05U15ExportPickerCalls ?? []))
}

async function quit() {
  if (!app) return
  await collectPickerCalls()
  const child = app.process()
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await app.evaluate(({ app: electronApp }) => { setTimeout(() => electronApp.quit(), 0); return true })
  assert.deepEqual(await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Electron did not exit')), 10_000)),
  ]), { code: 0, signal: null })
  app = null
}

async function openProject(page) {
  await writer(page).waitFor({ state: 'visible' })
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await page.locator('.writer-left-rail button[title="欢迎页"]').click()
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
  await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
}

async function exportThroughWriter(page, label, observationId) {
  await writer(page).waitFor({ state: 'visible' })
  await page.locator('.writer-topbar button[title="导出"]').click()
  const dialog = page.getByRole('dialog', { name: '导出项目' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByText(label, { exact: true }).click()
  const outline = dialog.getByRole('checkbox', { name: '包含故事大纲' })
  if (await outline.isChecked()) await outline.uncheck()
  await dialog.getByRole('button', { name: '选择目录并导出', exact: true }).click()
  const result = dialog.locator('.px-5.py-4.space-y-3 > .p-3.rounded-lg.text-xs')
  const observation = { observationId, label, resultText: null, dialogText: null,
    screenshot: path.relative(repository, path.join(receiptDir, `${observationId}.png`)), exportedFiles: [] }
  try {
    await result.waitFor({ state: 'visible', timeout: 30_000 })
    observation.resultText = await result.innerText()
    assert.match(observation.resultText, /^已导出到：/u, `export returned a non-success result: ${observation.resultText}`)
    return observation.resultText
  } catch (error) {
    observation.error = String(error)
    throw error
  } finally {
    try { observation.dialogText = await dialog.innerText() } catch (error) { observation.dialogTextError = String(error) }
    try { await page.screenshot({ path: path.join(repository, observation.screenshot) }) }
    catch (error) { observation.screenshotError = String(error) }
    observation.exportedFiles = exportTreeEvidence(exportRoot)
    resultObservations.push(observation)
    if (observation.resultText?.startsWith('已导出到：')) {
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
    }
  }
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  assert.equal(fs.existsSync(scratch), false, 'refusing to reuse an existing U15 export scratch path')
  for (const directory of [...Object.values(profile), exportRoot]) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u15-export',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 24,
    retainedReason: 'real packaged export bytes retained for independent review',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let failure
  let projectPath
  let firstSplitDirectory
  let secondSplitDirectory
  let artifacts = {}
  try {
    phase = 'fixture-project'
    let session = await launch()
    app = session.opened
    const created = await invoke(session.page, 'project:create', { path: profile.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    projectPath = created.projectPath
    assert.equal(path.relative(scratch, projectPath).startsWith('..'), false)
    const opened = await invoke(session.page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const projectSession = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
    const imported = await invoke(session.page, 'db:draft-import-finalized-batch', {
      operationId: `u15-export-${runId}`,
      chapters: chapters.map(chapter => ({ ...chapter })),
    }, projectPath, projectSession)
    assert.equal(imported.success, true, imported.error)
    await quit()

    phase = 'writer-merged-md'
    session = await launch()
    app = session.opened
    await openProject(session.page)
    const mergedResult = await exportThroughWriter(session.page, '合并 Markdown', 'writer-merged-md-result')
    const mergedPath = path.join(exportRoot, `${projectName}.md`)
    artifacts.merged = fileEvidence(mergedPath, expected.merged)
    addPass('writer-merged-md', 'U15.A03',
      'V3 Writer opened the production export dialog, obtained a real main-process directory grant, and wrote exact merged Markdown bytes.',
      { visibleResult: mergedResult, artifact: artifacts.merged })

    phase = 'writer-split-md-first'
    const beforeFirstSplit = new Set(fs.readdirSync(exportRoot))
    const firstSplitResult = await exportThroughWriter(session.page, '分章 Markdown', 'writer-split-md-first-result')
    firstSplitDirectory = fs.readdirSync(exportRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !beforeFirstSplit.has(entry.name))
      .map(entry => entry.name).at(0)
    assert(firstSplitDirectory, 'first split export did not create a fresh directory')
    const firstSplitRoot = path.join(exportRoot, firstSplitDirectory)
    assert.deepEqual(fs.readdirSync(firstSplitRoot).sort(), ['chapter_1.md', 'chapter_2.md'])
    artifacts.splitFirst = [
      fileEvidence(path.join(firstSplitRoot, 'chapter_1.md'), expected.split[0]),
      fileEvidence(path.join(firstSplitRoot, 'chapter_2.md'), expected.split[1]),
    ]
    addPass('writer-split-md-first', 'U15.A04',
      'V3 Writer created a fresh split directory containing only the two exact finalized chapter files.',
      { visibleResult: firstSplitResult, directory: firstSplitDirectory, artifacts: artifacts.splitFirst })
    await quit()

    const staleName = 'stale-chapter.md'
    fs.writeFileSync(path.join(exportRoot, firstSplitDirectory, staleName), 'stale sentinel', 'utf8')

    phase = 'writer-split-md-reopen-isolation'
    session = await launch()
    app = session.opened
    await openProject(session.page)
    const beforeSecondSplit = new Set(fs.readdirSync(exportRoot))
    const secondSplitResult = await exportThroughWriter(session.page, '分章 Markdown', 'writer-split-md-reopen-result')
    secondSplitDirectory = fs.readdirSync(exportRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !beforeSecondSplit.has(entry.name))
      .map(entry => entry.name).at(0)
    assert(secondSplitDirectory && secondSplitDirectory !== firstSplitDirectory,
      'reopened split export reused a previous output directory')
    const secondSplitRoot = path.join(exportRoot, secondSplitDirectory)
    assert.deepEqual(fs.readdirSync(secondSplitRoot).sort(), ['chapter_1.md', 'chapter_2.md'])
    assert.equal(fs.existsSync(path.join(secondSplitRoot, staleName)), false, 'stale file leaked into the new split export')
    assert.equal(fs.readFileSync(path.join(exportRoot, firstSplitDirectory, staleName), 'utf8'), 'stale sentinel')
    artifacts.splitSecond = [
      fileEvidence(path.join(secondSplitRoot, 'chapter_1.md'), expected.split[0]),
      fileEvidence(path.join(secondSplitRoot, 'chapter_2.md'), expected.split[1]),
    ]
    addPass('writer-split-md-reopen-isolation', 'U15.A04',
      'A fresh packaged process obtained a new grant and exported into a distinct clean directory; the prior stale sentinel was not copied or reused.',
      { visibleResult: secondSplitResult, firstDirectory: firstSplitDirectory,
        secondDirectory: secondSplitDirectory, artifacts: artifacts.splitSecond })

    phase = 'writer-txt'
    const txtResult = await exportThroughWriter(session.page, '纯文本 TXT', 'writer-txt-result')
    const txtPath = path.join(exportRoot, `${projectName}.txt`)
    artifacts.txt = fileEvidence(txtPath, expected.txt)
    addPass('writer-txt', 'U15.A05',
      'V3 Writer wrote exact plain-text bytes through the production export service after process reopen.',
      { visibleResult: txtResult, artifact: artifacts.txt })

    phase = 'history-stale-fixture'
    const reopened = await invoke(session.page, 'project:open', projectPath, randomUUID(), projectPath)
    assert.equal(reopened.success, true, reopened.error)
    const historySession = { projectId: reopened.project.id, projectPath, leaseId: reopened.project.sessionLease }
    const blueprint = await invoke(session.page, 'db:blueprint-upsert', {
      chapterNumber: 4, title: '来源追踪', role: '', purpose: '', keyEvents: '', characters: [],
      suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '',
    }, projectPath, historySession)
    assert.equal(blueprint.success, true, blueprint.error)
    const sourceBody = '旧港来信'
    const sourceDraft = await invoke(session.page, 'db:draft-create', {
      chapterNumber: 3, version: 1, source: 'write', content: sourceBody, wordCount: sourceBody.length,
    }, projectPath, historySession)
    assert.equal(sourceDraft.success, true, sourceDraft.error)
    const dependentBody = '依照旧港来信'
    const dependentDraft = await invoke(session.page, 'db:draft-create', {
      chapterNumber: 4, version: 1, source: 'write', content: dependentBody, wordCount: dependentBody.length,
      sourceDependencies: [{ draftId: sourceDraft.id, contentHash: hashBytes(Buffer.from(sourceBody, 'utf8')) }],
    }, projectPath, historySession)
    assert.equal(dependentDraft.success, true, dependentDraft.error)
    const beforeChange = await invoke(session.page, 'db:draft-list', 4, projectPath, historySession)
    assert.equal(beforeChange.find(draft => draft.id === dependentDraft.id)?.dependenciesStale, false)
    const changedSource = `${sourceBody}已改`
    const updatedSource = await invoke(session.page, 'db:draft-update-content', sourceDraft.id,
      changedSource, changedSource.length, projectPath, historySession)
    assert.equal(updatedSource.success, true, updatedSource.error)
    const afterChange = await invoke(session.page, 'db:draft-list', 4, projectPath, historySession)
    assert.equal(afterChange.find(draft => draft.id === dependentDraft.id)?.dependenciesStale, true)
    await quit()

    phase = 'writer-history-stale-reopen'
    session = await launch()
    app = session.opened
    await openProject(session.page)
    await session.page.locator('.writer-left-rail button[title="版本历史"]').click()
    await session.page.getByText('章节列表', { exact: true }).waitFor({ state: 'visible' })
    await session.page.getByTestId('writer-editor').getByText('来源追踪').click()
    const staleBadge = session.page.getByText('来源已过期', { exact: true })
    await staleBadge.waitFor({ state: 'visible' })
    assert.match(await staleBadge.getAttribute('title'), /草稿会保留.*连续性需要复核/u)
    await session.page.screenshot({ path: path.join(receiptDir, 'writer-version-history-stale.png') })
    addPass('writer-history-stale-reopen', 'U15.A01',
      'A visible Writer V3 history entry reopened the project and showed the persisted dependency-stale draft without discarding it.',
      { sourceDraftId: sourceDraft.id, dependentDraftId: dependentDraft.id,
        sourceBeforeSha256: hashBytes(Buffer.from(sourceBody, 'utf8')),
        sourceAfterSha256: hashBytes(Buffer.from(changedSource, 'utf8')),
        screenshot: path.relative(repository, path.join(receiptDir, 'writer-version-history-stale.png')) })
    await quit()

    phase = 'real-file-grant-boundary'
    assert.equal(pickerCalls.length, 4, 'each export must cross the main-process directory picker boundary')
    for (const call of pickerCalls) {
      assert.deepEqual(call.properties, ['openDirectory', 'createDirectory'])
      assert.match(call.title, /^(?:选择导出目录|Choose an export directory)$/u)
    }
    assert.equal(fs.existsSync(path.join(exportRoot, `${projectName}.md`)), true)
    assert.equal(fs.existsSync(path.join(exportRoot, `${projectName}.txt`)), true)
    addPass('real-file-grant-boundary', null,
      'All four UI actions crossed the production picker-to-grant handler; no absolute destination path was passed through the renderer export API.',
      { pickerCalls: pickerCalls.length })

    phase = 'task-owned-artifact-retention'
    assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, '.vibe-owner.json'), 'utf8')).owner,
      'codex/f05-u15-export')
    addPass('task-owned-artifact-retention', null,
      'The journey retained its exact owned Windows scratch tree and real export bytes for independent review; this is evidence handling, not an A04 product UI capability.',
      { evidenceKind: 'review-artifact-retention', productCapability: false, retainedPath: scratch, ttlHours: 24 })
  } catch (error) {
    failure = error
  }

  if (app) {
    try { await quit() } catch (error) { failure ??= error }
  }
  try {
    assert.equal(hashFile(driverPath), driverSha256, 'U15 export driver changed during run')
    assert.equal(hashFile(driverSourcePath), driverSourceSha256, 'Declared U15 export driver source changed during run')
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: driverSourceRepository, encoding: 'utf8',
    }).trim(), driverSourceHead, 'Declared U15 export driver source HEAD changed during run')
    assert.equal(hashFile(executablePath), expectedExe, 'Executable changed during run')
    assert.equal(hashFile(asarPath), expectedAsar, 'ASAR changed during run')
    assert.equal(git('rev-parse', 'HEAD'), executionHead, 'HEAD changed during run')
  } catch (error) { failure ??= error }
  const receipt = {
    outcome: failure ? 'FAIL' : 'PARTIAL',
    sliceOutcome: failure ? 'FAIL' : 'PASS',
    qualification: 'F05_U15_A01_PARTIAL_A03_A04_A05_PACKAGED_V3_SLICE',
    fullActionQualification: false,
    testedSha,
    executionHead,
    changedPaths,
    sourceDirty: git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean),
    dirtyProductPaths,
    driver: { executionPath: driverPath, executionSha256: driverSha256,
      sourcePath: driverSourcePath, sourceHead: driverSourceHead, sourceSha256: driverSourceSha256 },
    package: { directory: packageDir, executablePath, executableSha256: hashFile(executablePath),
      asarPath, asarSha256: hashFile(asarPath) },
    packageReuseReason: 'Fixed artifact hashes match and tracked or untracked product inputs do not differ from the tested SHA.',
    evidenceLevel: 'packaged-electron+real-file-grant+windows-filesystem',
    shell: 'writer-v3',
    fixture: { kind: 'synthetic-finalized-chapters', projectPath,
      chapters: chapters.map(({ chapterNumber, wordCount }) => ({ chapterNumber, wordCount })) },
    picker: { responseInjection: 'dialog.showOpenDialog only; production IPC handler issued every opaque grant', calls: pickerCalls },
    expectedArtifacts: {
      merged: { byteLength: Buffer.byteLength(expected.merged), sha256: hashBytes(Buffer.from(expected.merged)) },
      split: expected.split.map(content => ({ byteLength: Buffer.byteLength(content), sha256: hashBytes(Buffer.from(content)) })),
      txt: { byteLength: Buffer.byteLength(expected.txt), sha256: hashBytes(Buffer.from(expected.txt)) },
    },
    resultObservations,
    artifactRetention: { productCapability: false, scope: 'task-owned scratch tree only',
      reason: 'real packaged export bytes retained for independent review', ttlHours: 24 },
    artifacts,
    steps,
    remainingGaps: ['U15.A01 diff/revert, U15.A02, U15.A06 and U15.A07 are outside this receipt',
      'F05, U15 and release qualification remain incomplete'],
    retainedScratch: fs.existsSync(scratch) ? scratch : null,
    failedPhase: failure ? phase : null,
    error: failure ? String(failure) : null,
  }
  fs.writeFileSync(path.join(receiptDir, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u15-export',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${receiptDir.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  const receiptPath = path.join(receiptDir, 'receipt.json')
  const candidate = path.join(receiptDir, '.receipt-candidate.json')
  fs.writeFileSync(candidate, JSON.stringify(receipt, null, 2))
  fs.renameSync(candidate, receiptPath)
  process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, sliceOutcome: receipt.sliceOutcome, testedSha,
    steps: steps.map(step => step.stepId), receipt: path.relative(repository, receiptPath) })}\n`)
  if (failure) throw failure
}

main().catch(error => { console.error(error); process.exitCode = 1 })
