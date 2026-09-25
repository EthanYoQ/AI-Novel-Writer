/* global process */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = option('package-dir')
const buildSha = option('build-sha')
const expectedExe = option('exe-sha256')
const expectedAsar = option('asar-sha256')
assert(packageDir && /^[a-f0-9]{40}$/u.test(buildSha ?? '')
  && /^[a-f0-9]{64}$/u.test(expectedExe ?? '') && /^[a-f0-9]{64}$/u.test(expectedAsar ?? ''),
  'Pass --package-dir=<win-unpacked> --build-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
assert(process.env.LOCALAPPDATA, 'LOCALAPPDATA is required for an isolated Windows profile')

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = file => sha256(fs.readFileSync(file))
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const testedSha = git('rev-parse', '--verify', `${buildSha}^{commit}`)
assert.equal(testedSha, buildSha, 'Build SHA must be the full package source commit')
const productInputs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml',
  'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
const packageInput = name => !name.includes('/__tests__/') && !name.includes('/__screenshots__/')
const changedProductPaths = git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productInputs)
  .split('\n').filter(Boolean).filter(packageInput)
const dirtyProductPaths = git('status', '--porcelain', '--untracked-files=all', '--', ...productInputs)
  .split('\n').filter(Boolean).filter(line => packageInput(line.slice(3)))
assert.deepEqual(changedProductPaths, [], 'Packaged product source changed after the fixed build SHA')
assert.deepEqual(dirtyProductPaths, [], 'Dirty packaged product inputs make this run unbound')
const exe = path.join(packageDir, 'AI小说作家.exe')
const asar = path.join(packageDir, 'resources', 'app.asar')
assert.equal(fileHash(exe), expectedExe, 'Executable hash does not match the fixed package')
assert.equal(fileHash(asar), expectedAsar, 'ASAR hash does not match the fixed package')

const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u15-original-copy', runId)
const scratch = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel', `u15-original-${runId.slice(0, 8)}`)
const roots = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData']
  .map(name => [name, path.join(scratch, name)]))
// Keep the actual project root within the existing Windows native-storage path limit.
roots.projects = scratch
const projectName = 'U15'
const oldToken = `oldbeacon${runId.replaceAll('-', '')}`
const newToken = `newbeacon${runId.replaceAll('-', '')}`
const snippetToken = `snippetbeacon${runId.replaceAll('-', '')}`
const originalText = `# 合成世界设定\n\n第一节：旧港灯塔 ${oldToken}。\n\n第二节：守塔人的航海日志完整保留。\n\n第三节：结尾仅用于核对完整原文。`
const editedText = originalText.replace(oldToken, newToken).replace('守塔人的航海日志', '作者修订后的航海日志')
const sources = [
  { name: '完整原文.md', content: originalText },
  { name: '仅有片段.md', content: `旧资料片段 ${snippetToken}，没有可恢复的完整原文。` },
].map(source => ({ ...source, path: path.join(scratch, 'external', source.name) }))
const steps = []
const pass = (stepId, assertion) => steps.push({ stepId, actionId: 'U15.A02', outcome: 'PASS', assertion })
const invoke = (page, channel, ...args) => page.evaluate(
  ({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const invokeProject = (page, session, channel, ...args) => invoke(page, channel, ...args, session)
const writer = page => page.locator('.writer-shell[data-shell-presentation="writer"][data-shell-variant="v3"]')
let app
let phase = 'setup'

async function launch() {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  app = await electron.launch({ executablePath: exe, cwd: packageDir,
    args: [`--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  const page = await app.firstWindow({ timeout: 30_000 })
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
  return page
}

async function quit() {
  if (!app) return
  const child = app.process()
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await app.evaluate(({ app: electronApp }) => { setTimeout(() => electronApp.quit(), 0); return true })
  assert.deepEqual(await Promise.race([exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Electron did not exit')), 10_000))]),
  { code: 0, signal: null })
  app = null
}

async function openProject(page, expectedPath) {
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  if (!await page.locator('.writer-welcome').isVisible()) await page.locator('.writer-left-rail button[title="欢迎页"]').click()
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('project:open')
    if (!original) throw new Error('project:open handler missing')
    globalThis.__u15OriginalOpen = original
    globalThis.__u15OpenedProject = null
    ipcMain.removeHandler('project:open')
    ipcMain.handle('project:open', async (event, ...args) => {
      const result = await original(event, ...args)
      if (result?.success) globalThis.__u15OpenedProject = result.project
      return result
    })
  })
  let project
  try {
    await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
    await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
    project = await app.evaluate(() => globalThis.__u15OpenedProject)
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const original = globalThis.__u15OriginalOpen
      ipcMain.removeHandler('project:open')
      ipcMain.handle('project:open', original)
      delete globalThis.__u15OriginalOpen
      delete globalThis.__u15OpenedProject
    })
  }
  assert(project?.id && project.sessionLease, 'V3 open did not return a project session')
  assert.equal(path.resolve(project.path), path.resolve(expectedPath))
  await page.locator('.writer-left-rail button[title="小说"]').click()
  await page.getByRole('heading', { name: '知识库', exact: true }).waitFor({ state: 'visible' })
  return { projectId: project.id, leaseId: project.sessionLease, projectPath: project.path }
}

async function search(page, session, token, expectedCount) {
  const field = page.getByPlaceholder('输入查询内容，如：主角的能力体系、世界观核心设定...')
  await field.fill(token)
  await page.getByRole('button', { name: '检索', exact: true }).click()
  const resultHeading = page.getByText('检索结果（', { exact: false })
  await resultHeading.waitFor({ state: expectedCount ? 'visible' : 'hidden' })
  const results = await invokeProject(page, session, 'kb:search', token, 10, session.projectPath)
  assert.equal(results.length, expectedCount, `Unexpected FTS results for ${token}`)
  const writing = await invokeProject(page, session, 'kb:search-writing-context', token, 10, session.projectPath)
  assert.equal(writing.length, expectedCount, `Unexpected writing-context results for ${token}`)
  if (expectedCount) assert(results.some(row => row.text.includes(token)), `FTS result omitted ${token}`)
}

async function main() {
  assert.equal(fs.existsSync(scratch), false, 'Refusing to reuse an existing U15 scratch path')
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(path.join(scratch, 'external'), { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u15-original-copy',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    retainReason: 'Packaged V3 original-copy source and project evidence',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  for (const source of sources) fs.writeFileSync(source.path, source.content, { encoding: 'utf8', flag: 'wx' })
  const sourceHashes = Object.fromEntries(sources.map(source => [source.name, fileHash(source.path)]))
  let projectPath
  let snippetDocId
  let snippetCopyRemoved = false
  let failure
  try {
    phase = 'fixture-project'
    let page = await launch()
    const created = await invoke(page, 'project:create', { path: roots.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(created.success, true, created.error)
    projectPath = created.projectPath
    assert.equal(path.relative(scratch, projectPath).startsWith('..'), false)
    const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    await quit()

    phase = 'writer-import-and-save'
    page = await launch()
    let projectSession = await openProject(page, projectPath)
    await app.evaluate(({ dialog }, selected) => {
      globalThis.__u15KnowledgePickerCalls = []
      dialog.showOpenDialog = async options => {
        globalThis.__u15KnowledgePickerCalls.push(options)
        assertKnowledgePicker(options)
        return { canceled: false, filePaths: selected }
      }
      function assertKnowledgePicker(options) {
        if (options.title !== '选择要导入的文档') throw new Error(`Unexpected native picker: ${options.title}`)
      }
    }, sources.map(source => source.path))
    await page.getByRole('button', { name: '导入创作资料' }).click()
    const originals = page.getByRole('heading', { name: '知识库原文' }).locator('..')
    for (const source of sources) await originals.getByRole('button', { name: source.name }).waitFor({ state: 'visible', timeout: 30_000 })
    const pickerCalls = await app.evaluate(() => globalThis.__u15KnowledgePickerCalls)
    assert.equal(pickerCalls.length, 1)
    const documents = await invokeProject(page, projectSession, 'kb:list-documents', projectPath)
    assert.equal(documents.length, 2)
    snippetDocId = documents.find(document => document.fileName === sources[1].name)?.id
    assert(snippetDocId)
    await originals.getByRole('button', { name: sources[0].name }).click()
    const editor = page.getByRole('textbox', { name: '项目副本内容' })
    assert.equal(await editor.inputValue(), originalText, 'UI showed a chunk instead of the full imported source')
    await search(page, projectSession, oldToken, 1)
    pass('U15.A02-full-original-and-import', 'V3 import kept complete source text and current FTS/writing-context results')
    await editor.fill(editedText)
    await page.getByRole('button', { name: '保存项目副本' }).click()
    await page.getByText('索引待更新；旧内容已停止参与新检索和生成').waitFor({ state: 'visible' })
    assert.equal(await editor.inputValue(), editedText)
    await search(page, projectSession, oldToken, 0)
    await search(page, projectSession, newToken, 0)
    assert.equal(fileHash(sources[0].path), sourceHashes[sources[0].name], 'External original changed after editing')
    pass('U15.A02-save-stale', 'V3 save changed only the project copy; stale FTS and writing-context chunks were excluded')
    await page.screenshot({ path: path.join(receiptDir, 'v3-stale-copy.png'), fullPage: true })
    await quit()

    // This second isolated document models an old chunk-only project: its indexed
    // snippets survive, but no full-text copy exists for the UI to reconstruct.
    const snippetCopy = path.join(projectPath, '.ai-novel', 'knowledge-copies', `${sha256(snippetDocId)}.json`)
    assert(fs.existsSync(snippetCopy), 'Snippet fixture did not first have a full-text copy')
    fs.rmSync(snippetCopy)
    snippetCopyRemoved = true
    phase = 'writer-reopen-and-reindex'
    page = await launch()
    projectSession = await openProject(page, projectPath)
    const originalsAfterReopen = page.getByRole('heading', { name: '知识库原文' }).locator('..')
    await originalsAfterReopen.getByRole('button', { name: sources[0].name }).click()
    const editorAfterReopen = page.getByRole('textbox', { name: '项目副本内容' })
    assert.equal(await editorAfterReopen.inputValue(), editedText, 'Saved project copy was lost after process reopen')
    await page.getByText('索引待更新；旧内容已停止参与新检索和生成').waitFor({ state: 'visible' })
    await search(page, projectSession, oldToken, 0)
    await originalsAfterReopen.getByRole('button', { name: sources[1].name }).click()
    await page.getByText('完整原文不可用，请重新导入').waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('textbox', { name: '项目副本内容' }).count(), 0)
    await page.screenshot({ path: path.join(receiptDir, 'v3-snippet-only.png'), fullPage: true })
    pass('U15.A02-reopen-and-snippet-only', 'Process reopen retained the edited copy; chunk-only fixture showed reimport guidance without a fabricated editor')
    await originalsAfterReopen.getByRole('button', { name: sources[0].name }).click()
    await page.getByRole('button', { name: '更新本地全文索引' }).click()
    await page.getByText('索引待更新；旧内容已停止参与新检索和生成').waitFor({ state: 'hidden' })
    assert.equal(await editorAfterReopen.inputValue(), editedText)
    await search(page, projectSession, newToken, 1)
    await search(page, projectSession, oldToken, 0)
    for (const source of sources) assert.equal(fileHash(source.path), sourceHashes[source.name], `External file changed: ${source.name}`)
    await page.screenshot({ path: path.join(receiptDir, 'v3-current-copy.png'), fullPage: true })
    pass('U15.A02-explicit-reindex', 'Explicit local rebuild indexed the latest copy; old text stayed absent and external source bytes stayed unchanged')
    await quit()
  } catch (error) {
    failure = error
    if (app) { await app.close().catch(() => {}); app = null }
  }
  const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', sliceOutcome: failure ? 'FAIL' : 'PASS',
    qualification: 'F05_U15_A02_WIN_V3_ORIGINAL_COPY', testedSha, executionHead: git('rev-parse', 'HEAD'),
    packageDir, packageHashes: { exe: expectedExe, asar: expectedAsar },
    driver: { path: fileURLToPath(import.meta.url), sha256: fileHash(fileURLToPath(import.meta.url)) },
    profile: { canonical: roots.canonical, userData: roots.userData, projectPath },
    sourceFiles: sources.map(source => ({ path: source.path, beforeSha256: sourceHashes[source.name],
      afterSha256: fileHash(source.path) })), snippetFixture: { docId: snippetDocId, fullCopyRemovedFromIsolatedProject: snippetCopyRemoved },
    changedProductPaths, dirtyProductPaths, steps, failedPhase: failure ? phase : null,
    error: failure ? String(failure) : null, remainingGaps: ['F05 and release qualification remain outside this U15.A02 receipt'] }
  const receiptPath = path.join(receiptDir, 'receipt.json')
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
  process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, sliceOutcome: receipt.sliceOutcome,
    testedSha, steps: steps.map(step => step.stepId), receipt: path.relative(repository, receiptPath) })}\n`)
  if (failure) throw failure
}

main().catch(error => { console.error(error); process.exitCode = 1 })
