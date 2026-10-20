/* global process */
import assert from 'node:assert/strict'
import { chooseProjectDirectoryGrant } from './project-directory-grant.mjs'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import * as stage from './redesign/pages/stage.mjs'
import { resolveWindowsExecutable } from './product-identity.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const priorReceiptPath = path.join(repository, '.runtime', '.cache', 'f05-u08-shelf', '6eb816db-a9b0-4b89-af50-0ee934a427dd', 'receipt.json')
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageDir = argument('package-dir')
const packageSourceSha = argument('package-source-sha')
const expectedExe = argument('exe-sha256')
const expectedAsar = argument('asar-sha256')
assert(packageDir && packageSourceSha && /^[a-f0-9]{64}$/.test(expectedExe ?? '') && /^[a-f0-9]{64}$/.test(expectedAsar ?? ''),
  'pass --package-dir=<win-unpacked> --package-source-sha=<sha> --exe-sha256=<hash> --asar-sha256=<hash>')
const executablePath = resolveWindowsExecutable(packageDir)
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
  // 旧外壳时期的历史回执只在当年的机器上：有就核对 PASS，没有就记下缺席。
  const prior = fs.existsSync(priorReceiptPath) ? JSON.parse(fs.readFileSync(priorReceiptPath, 'utf8')) : null
  if (prior) assert.equal(prior.outcome, 'PASS')
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
    priorReceipt: prior ? { path: priorReceiptPath, sha256: sha256(priorReceiptPath), testedSha: prior.testedSha } : { path: priorReceiptPath, missing: true },
    reuseReason: 'Historical Writer UI is not reused; the fixed package and current stage UI are exercised independently.' }
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
    await stage.waitForStage(page)
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
/** 书房：纸墨外壳就绪，收起迁移通知（文案照旧核对），打开着作品时回到书房。 */
const home = async page => {
  await stage.waitForStage(page)
  const migrationNotice = page.locator('.startup-migration-notice')
  if (await migrationNotice.isVisible()) {
    assert.match(await migrationNotice.innerText(), /旧来源已保留，后续修改需明确导入，当前不会自动回灌。|未导入的内容已保留在原处。/)
    await migrationNotice.getByRole('button', { name: '知道了', exact: true }).click()
    await migrationNotice.waitFor({ state: 'detached' })
  }
  await stage.showLibrary(page)
}
/** 概览卡的统计：正文字数、定稿章节、角色。 */
// 统计格是带 aria-label 的 <dl>，按 ARIA 没有 list 角色，按标签找；找不到就让这一步失败。
const stats = overview => overview.getByLabel('统计', { exact: true }).innerText()
const statOf = (text, label) => Number(new RegExp(`${label}\\s*([\\d,]+)`).exec(text)?.[1]?.replaceAll(',', '') ?? NaN)
const bars = overview => overview.getByRole('list', { name: '阶段进度' }).locator('[data-stage]')
  .evaluateAll(rows => rows.map(row => ({ stage: row.dataset.stage, state: row.dataset.state, label: row.textContent?.trim() ?? '' })))

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

async function seed(app, page, roots) {
  const projects = {}
  for (const key of ['a', 'b', 'c']) {
    const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId, name: names[key],
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
    const projects = await seed(session.app, session.page, roots)
    await quit(session.app)
    session = null
    // A deliberately unreadable synthetic recent project stays outside the active project database.
    fs.writeFileSync(path.join(projects.c.path, '.ai-novel', 'project.db'), 'invalid synthetic SQLite fixture')
    session = await launch(roots)
    const { page } = session
    await home(page)

    // 纸墨书房：点封面只预览（右侧概览「预览」），概览里的主按钮「打开《书名》」才打开；打开着的书在概览里是「继续」。
    currentStep = 'U01.A02'
    await stage.openFromLibrary(page, names.a)
    await stage.waitForWork(page, names.a)
    await home(page)
    const overviewA = stage.overview(page, names.a)
    await overviewA.waitFor({ state: 'visible' })
    assert.match(await overviewA.innerText(), /^继续/)
    assert.equal(await overviewA.locator('blockquote').innerText(), excerpt)
    pass('library-open-authorized-project', 'U01.A02', 'Library overview button opens the selected project; its current overview shows the latest passage')

    currentStep = 'U08.A01'
    const statsA = await stats(overviewA)
    assert.deepEqual([statOf(statsA, '正文字数'), statOf(statsA, '定稿章节'), statOf(statsA, '角色')], [12, 0, 1], statsA)
    pass('library-current-real-statistics', 'U08.A01', 'Current project overview shows seeded draft units, active character and no finalized chapter')

    currentStep = 'U08.A04'
    // 旧欢迎页的六行（配置、架构、蓝图、正文、审稿、定稿）在纸墨外壳是与流程脊同源的四段，审稿与定稿并进正文。
    const barsA = await bars(overviewA)
    // 与流程脊同一口径：设定差一项、架构四节有一节（角色）、蓝图有 1 章即完成、正文 0 章定稿。
    assert.deepEqual(barsA.map(item => [item.stage, item.state, item.label]), [['setup', 'active', '设定 还差 1 项'], ['architecture', 'active', '架构 1 / 4'],
      ['blueprint', 'done', '蓝图 1 章'], ['manuscript', 'active', '正文 0 / 100']], JSON.stringify(barsA))
    pass('library-four-stage-real-progress', 'U08.A04', 'All four stage bars reflect seeded project facts: setup one item short, one of four architecture sections, one planned chapter, no finalized chapter of 100')

    currentStep = 'U08.A02'
    const before = sourceInventory(projects.b.path)
    await stage.previewBook(page, names.b)
    const overviewB = stage.overview(page, names.b)
    assert.match(await overviewB.innerText(), /^预览/)
    assert.equal(await overviewB.locator('blockquote').count(), 0)
    assert.deepEqual(await invoke(page, 'project:get-runtime-context'), { activeProjectPath: projects.a.path, dbReady: true })
    pass('library-other-project-preview', 'U08.A02', 'Cover click previews another authorized project without opening it or exposing an excerpt')

    currentStep = 'U08.A05'
    const barsB = await bars(overviewB)
    assert.deepEqual(barsB.map(item => item.stage), ['setup', 'architecture', 'blueprint', 'manuscript'])
    assert.notEqual(barsB[2].state, 'done', 'blank project blueprint must not look complete')
    assert.equal(barsB[3].state, 'todo', 'unset chapter target must not show manuscript progress')
    assert.equal(barsB[3].label, '正文 0 章定稿', 'unset chapter target must not invent a planned total')
    pass('library-unknown-plan', 'U08.A05', 'A saved unset chapter target shows no planned total and no false completion')

    currentStep = 'U08.A07'
    assert.deepEqual(sourceInventory(projects.b.path), before, 'Preview changed another project source files')
    assert.equal(fs.existsSync(path.join(projects.b.path, '.vela')), false)
    assert.equal(fs.existsSync(path.join(projects.b.path, '.ai-novel-migration')), false)
    assert.deepEqual(await invoke(page, 'project:peek-overview', projects.b.path), { state: 'unavailable' })
    pass('library-preview-source-zero-write', 'U08.A07', 'Library preview leaves source bytes and metadata unchanged, creates no migration files, and raw path is refused')

    currentStep = 'U08.A03'
    const beforeSwitchCaps = await invoke(page, 'project:recent-list')
    const oldCapability = beforeSwitchCaps.find(project => project.path === projects.a.path)?.previewCapabilityId
    assert(oldCapability)
    assert.equal((await invoke(page, 'project:peek-overview', oldCapability)).state, 'ready', 'A preview capability was invalid before the switch')
    await overviewB.getByRole('button', { name: `打开《${names.b}》` }).click()
    await stage.waitForWork(page, names.b)
    currentStep = 'U08.A06-switch-revocation'
    assert.deepEqual(await invoke(page, 'project:peek-overview', oldCapability), { state: 'unavailable' }, 'Switching to B kept an old A preview capability alive')
    currentStep = 'U08.A03'
    await home(page)
    assert.match(await stage.overview(page, names.b).innerText(), /^继续/)
    assert.deepEqual(await invoke(page, 'project:get-runtime-context'), { activeProjectPath: projects.b.path, dbReady: true })
    pass('library-preview-open-button-opens', 'U08.A03', 'The previewed book opens from its overview button with a new main current session')
    pass('library-recent-project-entry', 'U01.A03', 'Recent shelf item enters its authorized project and the current overview resolves to that project')

    currentStep = 'U08.A05-unreadable'
    await stage.cover(page, names.c).click()
    const overviewC = stage.overview(page, names.c)
    await overviewC.getByText('暂时读不到这部作品的概览', { exact: false }).waitFor({ state: 'visible' })
    assert.doesNotMatch(await overviewC.innerText(), /100%|正文字数\s*0/)
    pass('library-unreadable-project-unknown', 'U08.A05', 'Unreadable authorized recent project shows unavailable instead of invented zero or completion')

    currentStep = 'U08.A06'
    const keys = await page.evaluate(() => [...Array(localStorage.length)].map((_, index) => localStorage.key(index)))
    assert(keys.every(key => !key.startsWith('vela:overview:')))
    assert.equal(await page.evaluate(marker => Object.values(localStorage).some(value => String(value).includes(marker)), excerpt), false)
    assert.equal(await overviewC.locator('blockquote').count(), 0)
    pass('library-switch-revoke-private-summary', 'U08.A06', 'Switching preview shows no excerpt; old capability is revoked and no overview prose enters localStorage')
    await stage.previewBook(page, names.a)
    const statsAgain = await stats(stage.overview(page, names.a))
    assert.equal(statOf(statsAgain, '正文字数'), 12, statsAgain)
    assert.deepEqual(await invoke(page, 'project:get-runtime-context'), { activeProjectPath: projects.b.path, dbReady: true })
    pass('library-switch-reissued-shelf-preview', 'U08.A06', 'After switch, the library uses a fresh A preview capability without reopening A')

    await quit(session.app)
    session = null
    assert.equal(sha256(fileURLToPath(import.meta.url)), driverSha256)
    assert.deepEqual(provenance().artifactHashes, source.artifactHashes)
    const requiredSteps = {
      'U08.A01': ['library-current-real-statistics'],
      'U08.A02': ['library-other-project-preview'],
      'U08.A03': ['library-preview-open-button-opens'],
      'U08.A04': ['library-four-stage-real-progress'],
      'U08.A05': ['library-unknown-plan', 'library-unreadable-project-unknown'],
      'U08.A06': ['library-switch-revoke-private-summary', 'library-switch-reissued-shelf-preview'],
      'U08.A07': ['library-preview-source-zero-write'],
    }
    const verifiedActions = Object.entries(requiredSteps).filter(([, ids]) => ids.every(id => steps.some(step => step.stepId === id && step.outcome === 'PASS')))
      .map(([actionId]) => actionId)
    assert.equal(verifiedActions.length, Object.keys(requiredSteps).length, 'required U08 action missing')
    const receipt = { outcome: 'PARTIAL', qualification: 'F05_U08_STAGE_LIBRARY_ONLY', evidenceLevel: 'electron', shell: 'stage', ...source,
      driverSha256, releaseDefaultQualified: false, physicalModelRequests: 0,
      auxiliaryEvidence: ['src/components/stage/library/__tests__', 'electron/services/__tests__/project-peek-readonly.test.ts'], steps, verifiedActions,
      unverifiedActions: ['F05 whole-product qualification, release default and physical model gates'] }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    process.stdout.write(`${JSON.stringify({ outcome: receipt.outcome, testedSha: source.testedSha, executionHead: source.executionHead,
      driverSha256, receipt: path.relative(repository, receiptPath), steps: steps.map(step => step.stepId) })}\n`)
  } catch (error) {
    if (session) {
      await session.page.screenshot({ path: path.join(path.dirname(receiptPath), 'failure.png') }).catch(() => {})
      await session.app.close().catch(() => {})
    }
    fs.writeFileSync(receiptPath, JSON.stringify({ outcome: 'FAIL', ...source, driverSha256, failedStep: currentStep,
      steps, error: String(error) }, null, 2))
    throw error
  }
}

if (process.argv.includes('--help')) process.stdout.write('Pass fixed Windows package directory, source SHA, exe SHA-256 and asar SHA-256.\n')
else main().catch(error => { console.error(error); process.exitCode = 1 })
