/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const priorReceiptPath = path.join(repository, '.runtime', '.cache', 'f05-u08-shelf', '6eb816db-a9b0-4b89-af50-0ee934a427dd', 'receipt.json')
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = argument('package-dir')
const packageSourceSha = argument('package-source-sha')
const expectedExe = argument('exe-sha256')
const expectedAsar = argument('asar-sha256')
assert(packageDir && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const runId = randomUUID()
const receiptPath = path.join(repository, '.runtime', '.cache', 'f05-u08-shelf', runId, 'receipt.json')
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const driverSha256 = sha256(fileURLToPath(import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trimEnd()
const steps = []
let currentStep = 'setup'
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, assertion, outcome: 'PASS' })
const names = { a: '雨夜来信', b: '空白计划', c: '不可读副本' }
const excerpt = '第1章正文：雨落在旧车站。'

function provenance() {
  assert(fs.existsSync(priorReceiptPath), 'Historical U08 receipt missing')
  const prior = JSON.parse(fs.readFileSync(priorReceiptPath, 'utf8'))
  assert.equal(prior.outcome, 'PASS')
  const testedSha = git('rev-parse', `${packageSourceSha}^{commit}`)
  const executionHead = git('rev-parse', 'HEAD')
  const changedPaths = git('diff', '--name-only', `${testedSha}..${executionHead}`).split('\n').filter(Boolean)
  assert.equal(git('diff', '--name-only', `${testedSha}..${executionHead}`, '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5'), '',
  'product source changed since fixed package SHA')
  const dirtyProductPaths = git('status', '--porcelain', '--', 'src', 'electron', 'public', 'build',
    'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5').split('\n').filter(Boolean)
  assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|pages\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)),
    'Product build inputs changed beyond test screenshots')
  const artifactHashes = { executable: sha256(executablePath), asar: sha256(asarPath) }
  assert.deepEqual(artifactHashes, { executable: expectedExe, asar: expectedAsar })
  return { testedSha, executionHead, changedPaths, dirtyProductPaths, artifactHashes,
    priorReceipt: { path: priorReceiptPath, sha256: sha256(priorReceiptPath), testedSha: prior.testedSha },
    reuseReason: 'Historical Writer UI is not reused; fixed V3 package and current UI are exercised independently.' }
}

function fixture() {
  assert(process.env.LOCALAPPDATA, 'Short LOCALAPPDATA scratch is required')
  const scratch = path.join(process.env.LOCALAPPDATA, 'VibeCodingScratch', 'AI-Novel', `u08-${runId.slice(0, 8)}`)
  const roots = Object.fromEntries(['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'projects']
    .map(key => [key, path.join(scratch, key)]))
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'codex/f05-u08',
    sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 72,
    cleanupCommand: `Remove-Item -LiteralPath '${scratch}' -Recurse -Force`,
    retainReason: 'Synthetic shelf projects for receipt inspection' }, null, 2))
  return roots
}

async function launch(roots) {
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: roots.canonical,
    AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy, AI_NOVEL_VELA_HOME: roots.legacy,
    HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData, LOCALAPPDATA: roots.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[key]
  const app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${roots.userData}`], env, timeout: 30_000 })
  try {
    const page = await app.firstWindow({ timeout: 30_000 })
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), roots.userData)
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    return { app, page }
  } catch (error) { await app.close(); throw error }
}

async function quit(app) {
  const child = app.process()
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); return true })
  assert.deepEqual(await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Electron did not exit')), 10_000))]),
    { code: 0, signal: null })
}

const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const writer = page => page.locator('.writer-shell[data-shell-presentation="writer"][data-shell-variant="v3"]').waitFor({ state: 'visible', timeout: 30_000 })
const home = async page => {
  await writer(page)
  const migrationNotice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await migrationNotice.isVisible()) {
    assert.match(await migrationNotice.innerText(), /旧来源已保留，后续修改需明确导入，当前不会自动回灌。|未导入的内容已保留在原处。/)
    await migrationNotice.getByRole('button', { name: '知道了', exact: true }).click()
    await migrationNotice.waitFor({ state: 'detached' })
  }
  if (!await page.locator('.writer-welcome').isVisible()) await page.locator('.writer-left-rail button[title="欢迎页"]').click()
  await page.locator('.writer-welcome').waitFor({ state: 'visible', timeout: 30_000 })
}

function sourceInventory(projectPath) {
  const result = {}
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) {
        const stat = fs.statSync(file)
        result[path.relative(projectPath, file).replaceAll('\\', '/')] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(file) }
      }
    }
  }
  visit(projectPath)
  return result
}

async function seed(page, roots) {
  const projects = {}
  for (const key of ['a', 'b', 'c']) {
    const created = await invoke(page, 'project:create', { path: roots.projects, name: names[key],
      genre: key === 'a' ? '悬疑' : '', targetAudience: key === 'a' ? '成年读者' : '', writingLanguage: 'zh-CN' }, randomUUID())
    assert.equal(created.success, true, created.error)
    projects[key] = { path: created.projectPath, id: created.projectId }
  }
  const opened = await invoke(page, 'project:open', projects.a.path, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const context = { projectId: projects.a.id, projectPath: projects.a.path, leaseId: opened.project.sessionLease }
  const blueprint = await invoke(page, 'db:blueprint-upsert', { chapterNumber: 1, title: '旧车站', role: '发展',
    purpose: '调查来信', keyEvents: '发现线索', characters: [] }, projects.a.path, context)
  assert.equal(blueprint.success, true, blueprint.error)
  const draft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write',
    content: excerpt, wordCount: 12 }, projects.a.path, context)
  assert.equal(draft.success, true, draft.error)
  const roster = await invoke(page, 'db:character-roster-read', projects.a.path, context)
  const character = { characterId: `draft:${randomUUID()}`, name: '林舟', role: 'protagonist', gender: '', age: '', appearance: '', personality: '',
    background: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }
  const committed = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries: [character] }, projects.a.path, context)
  assert.equal(committed.success, true, committed.error)
  const openedBlank = await invoke(page, 'project:open', projects.b.path, randomUUID(), null)
  assert.equal(openedBlank.success, true, openedBlank.error)
  const blankContext = { projectId: projects.b.id, projectPath: projects.b.path, leaseId: openedBlank.project.sessionLease }
  const unsetTarget = await invoke(page, 'project:save', projects.b.id,
    { path: projects.b.path, novelConfig: { ...openedBlank.project.novelConfig, totalChapters: 0 } }, projects.b.path, blankContext)
  assert.equal(unsetTarget.success, true, unsetTarget.error)
  await page.evaluate(key => {
    const previous = JSON.parse(localStorage.getItem(key))
    localStorage.setItem(key, JSON.stringify({ ...previous, shellPreference: 'writer', revision: previous.revision + 1, origin: 'author' }))
  }, 'ai-novel-writer-appearance')
  return projects
}

async function main() {
  const source = provenance()
  const roots = fixture()
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  let session
  try {
    currentStep = 'synthetic-fixture'
    session = await launch(roots)
    const projects = await seed(session.page, roots)
    await quit(session.app)
    session = null
    // A deliberately unreadable synthetic recent project stays outside the active project database.
    fs.writeFileSync(path.join(projects.c.path, '.ai-novel', 'project.db'), 'invalid synthetic SQLite fixture')
    session = await launch(roots)
    const { page } = session
    await writer(page)
    await home(page)
    const shelf = page.locator('.writer-shelf')

    currentStep = 'U01.A02'
    await shelf.getByRole('button', { name: `打开《${names.a}》` }).click()
    await page.locator('.writer-project-tree').getByText(names.a, { exact: true }).waitFor({ state: 'visible' })
    await home(page)
    const overview = page.getByRole('region', { name: '作品概览' })
    await page.locator('.writer-welcome-heading h1').getByText(names.a, { exact: true }).waitFor()
    assert.match(await overview.innerText(), new RegExp(excerpt))
    pass('writer-open-authorized-project', 'U01.A02', 'Writer shelf open binds the selected project and main current overview session')

    currentStep = 'U08.A01'
    assert.match(await overview.innerText(), /正文字数\s*12/)
    assert.match(await overview.innerText(), /已定稿章节\s*0/)
    assert.match(await overview.innerText(), /人物\s*1/)
    pass('writer-current-real-statistics', 'U08.A01', 'Current main-owned project overview shows seeded draft units, active character and no finalized chapter')

    currentStep = 'U08.A04'
    const stages = overview.locator('.writer-stage-list li')
    assert.equal(await stages.count(), 6)
    for (const [index, label, status, count] of [[0, '配置', '进行中', '2'], [1, '架构', '进行中', '1'],
      [2, '蓝图', '进行中', '1'], [3, '正文', '进行中', '1'], [4, '审稿', '未开始', '0'], [5, '定稿', '未开始', '0']]) {
      const row = await stages.nth(index).innerText()
      assert(row.includes(label) && row.includes(status) && row.includes(count), `Stage ${label} mismatched: ${row}`)
    }
    pass('writer-six-stage-real-counts', 'U08.A04', 'All six stage rows reflect seeded project facts and the configured chapter target')

    currentStep = 'U08.A02'
    const before = sourceInventory(projects.b.path)
    await shelf.getByRole('button', { name: `预览《${names.b}》` }).click()
    await page.locator('.writer-welcome-heading h1').getByText(names.b, { exact: true }).waitFor()
    assert.equal(await overview.locator('blockquote').count(), 0)
    assert.deepEqual(await invoke(page, 'project:get-runtime-context'), { activeProjectPath: projects.a.path, dbReady: true })
    pass('writer-other-project-preview', 'U08.A02', 'First Writer cover click previews another authorized project without opening it or exposing current excerpt')

    currentStep = 'U08.A05'
    const unknownRows = overview.locator('.writer-stage-list li')
    assert.equal(await unknownRows.count(), 6)
    for (const [index, label, status] of [[0, '配置', '未开始'], [1, '架构', '未开始'],
      [2, '蓝图', '待读取'], [3, '正文', '待读取'], [4, '审稿', '待读取'], [5, '定稿', '待读取']]) {
      const row = await unknownRows.nth(index).innerText()
      assert(row.includes(label) && row.includes(status) && row.includes('0'), `Blank stage ${label} mismatched: ${row}`)
    }
    pass('writer-unknown-plan', 'U08.A05', 'A saved unset chapter target renders four dependent stages as unknown, without false completion')

    currentStep = 'U08.A07'
    assert.deepEqual(sourceInventory(projects.b.path), before, 'Preview changed another project source files')
    assert.equal(fs.existsSync(path.join(projects.b.path, '.vela')), false)
    assert.equal(fs.existsSync(path.join(projects.b.path, '.ai-novel-migration')), false)
    assert.deepEqual(await invoke(page, 'project:peek-overview', projects.b.path), { state: 'unavailable' })
    pass('writer-preview-source-zero-write', 'U08.A07', 'Writer preview leaves source bytes and metadata unchanged, creates no migration files, and raw path is refused')

    currentStep = 'U08.A03'
    const beforeSwitchCaps = await invoke(page, 'project:recent-list')
    const oldCapability = beforeSwitchCaps.find(project => project.path === projects.a.path)?.previewCapabilityId
    assert(oldCapability)
    assert.equal((await invoke(page, 'project:peek-overview', oldCapability)).state, 'ready', 'A preview capability was invalid before the switch')
    await shelf.getByRole('button', { name: `预览《${names.b}》` }).click()
    await page.locator('.writer-project-tree').getByText(names.b, { exact: true }).waitFor({ state: 'visible' })
    currentStep = 'U08.A06-switch-revocation'
    assert.deepEqual(await invoke(page, 'project:peek-overview', oldCapability), { state: 'unavailable' }, 'Switching to B kept an old A preview capability alive')
    currentStep = 'U08.A03'
    await home(page)
    await page.locator('.writer-welcome-heading h1').getByText(names.b, { exact: true }).waitFor()
    assert.deepEqual(await invoke(page, 'project:get-runtime-context'), { activeProjectPath: projects.b.path, dbReady: true })
    pass('writer-preview-second-click-opens', 'U08.A03', 'Second Writer cover click opens previewed project with a new main current session')
    pass('writer-recent-project-entry', 'U01.A03', 'Recent shelf item enters its authorized project and current overview resolves to that project')

    currentStep = 'U08.A05-unreadable'
    await shelf.getByRole('button', { name: `预览《${names.c}》` }).click()
    assert.match(await overview.innerText(), /暂时无法读取这部作品/)
    assert.doesNotMatch(await overview.innerText(), /100%|正文字数\s*0/)
    pass('writer-unreadable-project-unknown', 'U08.A05', 'Unreadable authorized recent project shows unavailable instead of invented zero or completion')

    currentStep = 'U08.A06'
    const keys = await page.evaluate(() => [...Array(localStorage.length)].map((_, index) => localStorage.key(index)))
    assert(keys.every(key => !key.startsWith('vela:overview:')))
    assert.equal(await page.evaluate(marker => Object.values(localStorage).some(value => String(value).includes(marker)), excerpt), false)
    assert.equal(await overview.locator('blockquote').count(), 0)
    pass('writer-switch-revoke-private-summary', 'U08.A06', 'Switching preview clears current excerpt; old capability is revoked and no overview prose enters localStorage')
    await shelf.getByRole('button', { name: `预览《${names.a}》` }).click()
    await page.locator('.writer-welcome-heading h1').getByText(names.a, { exact: true }).waitFor()
    assert.match(await overview.innerText(), /正文字数\s*12/)
    assert.deepEqual(await invoke(page, 'project:get-runtime-context'), { activeProjectPath: projects.b.path, dbReady: true })
    pass('writer-switch-reissued-shelf-preview', 'U08.A06', 'After switch, the shelf uses a fresh A preview capability without reopening A')

    await quit(session.app)
    session = null
    assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256)
    assert.deepEqual(provenance().artifactHashes, source.artifactHashes)
    const requiredSteps = {
      'U08.A01': ['writer-current-real-statistics'],
      'U08.A02': ['writer-other-project-preview'],
      'U08.A03': ['writer-preview-second-click-opens'],
      'U08.A04': ['writer-six-stage-real-counts'],
      'U08.A05': ['writer-unknown-plan', 'writer-unreadable-project-unknown'],
      'U08.A06': ['writer-switch-revoke-private-summary', 'writer-switch-reissued-shelf-preview'],
      'U08.A07': ['writer-preview-source-zero-write'],
    }
    const verifiedActions = Object.entries(requiredSteps).filter(([, ids]) => ids.every(id => steps.some(step => step.stepId === id && step.outcome === 'PASS')))
      .map(([actionId]) => actionId)
    assert.equal(verifiedActions.length, Object.keys(requiredSteps).length, 'required U08 action missing')
    const receipt = { outcome: 'PARTIAL', qualification: 'F05_U08_V3_SHELF_ONLY', evidenceLevel: 'electron', shell: 'writer-v3', ...source,
      driverSha256, releaseDefaultQualified: false, physicalModelRequests: 0,
      auxiliaryEvidence: ['src/components/pages/v2/__tests__/writer-project-overview.browser.tsx',
        'electron/services/__tests__/project-peek-readonly.test.ts'], steps, verifiedActions,
      unverifiedActions: ['F05 whole-product qualification, release default and physical model gates'] }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, testedSha: source.testedSha, executionHead: source.executionHead,
      driverSha256, receipt: path.relative(repository, receiptPath), steps: steps.map(step => step.stepId) })}\n`)
  } catch (error) {
    if (session) await session.app.close().catch(() => {})
    fs.writeFileSync(receiptPath, JSON.stringify({ outcome: 'FAIL', ...source, driverSha256, failedStep: currentStep,
      steps, error: String(error) }, null, 2))
    throw error
  }
}

if (process.argv.includes('--help')) process.stdout.write('Pass fixed Windows package directory, source SHA, exe SHA-256 and asar SHA-256.\n')
else main().catch(error => { console.error(error); process.exitCode = 1 })
