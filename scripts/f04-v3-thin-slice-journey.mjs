/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = process.argv.find(arg => arg.startsWith('--package-dir='))?.slice('--package-dir='.length)
const expectedAsar = process.argv.find(arg => arg.startsWith('--asar-sha256='))?.slice('--asar-sha256='.length)
assert(packageDir && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''), 'pass --package-dir=<fresh win-unpacked> --asar-sha256=<fresh bundle hash>')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
assert(fs.statSync(executablePath).isFile() && fs.statSync(asarPath).isFile())
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
assert.equal(sha256(asarPath), expectedAsar, 'bundle changed since build attribution')

const runId = randomUUID()
const scratch = path.join(process.env.LOCALAPPDATA ?? repository, 'VibeCodingScratch', 'an', 'f04-v3', runId.slice(0, 8))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects']
  .map(name => [name, path.join(scratch, name)]))
const receiptDir = path.join(repository, '.runtime', '.cache', 'f04-v3-thin-slice', runId)
const projectName = 'V3'
const fixtureBody = '列车抵达旧车站。'
const marker = `V3 合成正文 ${runId}`
const steps = []
const pass = (name, observed) => steps.push({ name, outcome: 'PASS', observed })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const editorBody = locator => locator.evaluate(element => Array.from(element.querySelectorAll('.cm-line'), line => {
  const copy = line.cloneNode(true)
  copy.querySelector('.cm-lp-paperhead')?.remove()
  return copy.textContent
}).join('\n'))
const Database = createRequire(import.meta.url)('better-sqlite3')

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

async function openViaShelf(page) {
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${projectName}》` }).click()
  await page.locator('.writer-project-tree').getByText(projectName, { exact: true }).waitFor({ state: 'visible' })
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F04 V3 synthetic thin slice', sourceProject: repository,
    createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'isolated real Electron and SQLite receipt review',
    cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app
  let failure = null
  let currentStep = 'launch'
  let projectPath
  let draftId
  try {
    app = (await launch()).app
    const page = await app.firstWindow()
    const startupNotice = page.locator('[role="status"].fixed.inset-x-0.top-10')
    if (await startupNotice.isVisible()) await startupNotice.getByRole('button', { name: '知道了', exact: true }).click()
    await page.screenshot({ path: path.join(receiptDir, 'v3-shelf-empty.png') })
    currentStep = 'fixture-create-via-IPC'
    const project = await invoke(page, 'project:create', { path: profile.projects, name: projectName,
      genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(project.success, true, project.error)
    projectPath = project.projectPath
    const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
    assert.equal(opened.success, true, opened.error)
    const context = { projectId: project.projectId, projectPath, leaseId: opened.project.sessionLease }
    const blueprint = await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '初始蓝图', role: '发展',
      purpose: '前往车站', keyEvents: '发现线索', characters: [] }, projectPath, context)
    assert.equal(blueprint.success, true, blueprint.error)
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
      content: fixtureBody, wordCount: 8 }, projectPath, context)
    assert.equal(draft.success, true, draft.error)
    draftId = draft.id ?? draft.draft?.id
    assert(Number.isInteger(draftId), 'fixture draft id missing')
    await app.close()
    app = null

    currentStep = 'shelf-open'
    ;({ app } = await launch())
    const editorPage = await app.firstWindow()
    await openViaShelf(editorPage)
    assert.equal(await editorPage.locator('[data-shell-variant="v3"]').count(), 1)
    pass('shelf-open', { projectName })
    currentStep = 'edit-save'
    await editorPage.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    const body = editorPage.locator('.cm-content[contenteditable="true"]')
    await body.waitFor({ state: 'visible' })
    assert.equal(await editorBody(body), fixtureBody, 'fixture body missing before edit')
    await body.click()
    await editorPage.keyboard.press('Control+End')
    await editorPage.keyboard.type(marker)
    const savedUiBody = await editorBody(body)
    assert.equal(savedUiBody, fixtureBody + marker, 'UI body changed beyond requested append')
    await editorPage.locator('button[title="保存（⌘S）"]').click()
    const dbPath = path.join(projectPath, '.ai-novel', 'project.db')
    assert.equal(path.relative(scratch, dbPath).startsWith('..'), false)
    const db = new Database(dbPath, { fileMustExist: true, readonly: true })
    const storedBody = () => db.prepare('SELECT contents.body FROM drafts JOIN contents ON contents.id = drafts.content_id WHERE drafts.id = ?').get(draftId)?.body
    try { assert.equal(storedBody(), savedUiBody, 'saved UI body differs from SQLite') }
    finally { db.close() }
    pass('edit-save', { draftId, marker })
    await editorPage.screenshot({ path: path.join(receiptDir, 'v3-editor-saved.png') })
    await app.close()
    app = null

    currentStep = 'new-process-reopen'
    ;({ app } = await launch())
    const reopenedPage = await app.firstWindow()
    await openViaShelf(reopenedPage)
    await reopenedPage.locator('.writer-project-tree').getByText('草稿_v1', { exact: true }).click()
    const reopenedBody = reopenedPage.locator('.cm-content[contenteditable="true"]')
    await reopenedBody.getByText(marker, { exact: false }).waitFor({ state: 'visible' })
    assert.equal(await editorBody(reopenedBody), savedUiBody, 'reopened UI body differs from saved UI')
    pass('new-process-reopen', { draftId, marker })
    await reopenedPage.screenshot({ path: path.join(receiptDir, 'v3-editor-reopened.png') })
  } catch (error) {
    failure = { step: currentStep, name: error?.name, message: error?.message }
  } finally {
    await app?.close().catch(() => {})
    const receipt = { outcome: failure ? 'FAIL' : 'PASS', asarSha256: expectedAsar, executableSha256: sha256(executablePath),
      driverSha256: sha256(fileURLToPath(import.meta.url)), projectPath, scratch, steps, failure }
    fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(`${path.join(receiptDir, 'receipt.json')}\n`)
  }
  if (failure) throw new Error(`${failure.step}: ${failure.message}`)
}

await main()
