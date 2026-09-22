/* global process */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { verifyWindowsPackage, verifyPackagedBetterSqliteLoad, verifyPackagedLanceLoad } from './verify-win-package.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const packageArgs = ['package-dir', 'package-source-sha', 'exe-sha256', 'asar-sha256'].map(argument)
assert(packageArgs.every(Boolean) || packageArgs.every(value => value === undefined), 'package override requires --package-dir, --package-source-sha, --exe-sha256 and --asar-sha256')
const packageDir = path.resolve(repository, packageArgs[0] ?? '.runtime/.cache/f04-v3-build/s13-core-1')
const executablePath = path.join(packageDir, 'AI小说作家.exe')
const asarPath = path.join(packageDir, 'resources', 'app.asar')
const packageSourceSha = packageArgs[1] ?? '7110f53d5ce173d70bc0dcef90209bccb38d9fff'
const expectedExeSha = packageArgs[2] ?? 'c3864b55649358e6acae5e828861dc231521f75e5bfa0422212d86b3349f6669'
const expectedAsarSha = packageArgs[3] ?? 'bf2f5c95ae8b72e377710759bfdb392cd0344f9e4c2d67fb0ef0ecbfb7b37b66'
assert(/^[a-f0-9]{40}$/.test(packageSourceSha) && [expectedExeSha, expectedAsarSha].every(value => /^[a-f0-9]{64}$/.test(value)), 'invalid package source or artifact SHA')
const Database = createRequire(import.meta.url)('better-sqlite3')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = file => sha256(fs.readFileSync(file))
const scriptPath = fileURLToPath(import.meta.url)
const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const testedSha = packageSourceSha
const driverSha256 = fileHash(scriptPath)
const immersionOnly = process.argv.includes('--immersion-only')
const columnsOnly = process.argv.includes('--columns-only')
const productPathArgs = ['src', 'electron', 'public', 'build', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'electron-builder.json5']
const changedPaths = git('diff', '--name-only', `${testedSha}..HEAD`).split('\n').filter(Boolean)
const readProjectCore = projectPath => {
  const database = new Database(path.join(projectPath, '.ai-novel', 'project.db'), { fileMustExist: true, readonly: true })
  try {
    const row = database.prepare("SELECT * FROM project_core WHERE id='main'").get()
    assert(row, 'project_core main row is missing')
    return JSON.stringify(row)
  } finally { database.close() }
}
const runId = randomUUID()
const receiptDir = path.join(repository, '.runtime', '.cache', 'f05-u07-dirty-tabs', runId)
const scratch = path.join(process.env.LOCALAPPDATA ?? path.dirname(repository), 'VibeCodingScratch', 'an', 'u7d', runId.slice(0, 6))
const profile = Object.fromEntries(['canonical', 'legacy', 'userData', 'home', 'appData', 'localAppData', 'projects'].map(name => [name, path.join(scratch, name)]))
const steps = []
const pass = (stepId, actionId, assertion) => steps.push({ stepId, actionId, outcome: 'PASS', assertion })
const invoke = (page, channel, ...args) => page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })
const writer = page => page.locator('[data-shell-presentation="writer"][data-shell-variant="v3"]')
const tabBar = page => page.locator('.writer-editor-content .skin-workspace-page > .no-select')
const tabByName = (page, name) => tabBar(page).getByText(name, { exact: true }).locator('xpath=..')
const assertActiveTab = async (page, name, actionId) => {
  const tab = tabByName(page, name)
  await tab.waitFor({ state: 'visible' })
  assert.equal(await tab.evaluate(element => getComputedStyle(element).boxShadow !== 'none'), true, `${actionId}: ${name} tab is not active`)
}
const placeholder = '在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置...'
const assertWriter = async (page, actionId) => {
  const shell = writer(page)
  await shell.waitFor({ state: 'visible' })
  assert.equal(await writer(page).getAttribute('data-shell-presentation'), 'writer', `${actionId}: current shell is not writer`)
  assert.equal(await writer(page).getAttribute('data-shell-variant'), 'v3', `${actionId}: current shell is not V3`)
}
const waitHome = async page => {
  await assertWriter(page, 'U07.home')
  const notice = page.locator('[role="status"].fixed.inset-x-0.top-10')
  if (await notice.isVisible()) { await notice.getByRole('button', { name: '知道了', exact: true }).click(); await notice.waitFor({ state: 'detached' }) }
  if (!await page.locator('.writer-welcome').isVisible()) await page.locator('.writer-left-rail button[title="欢迎页"]').click()
  await page.locator('.writer-shelf').waitFor({ state: 'visible' })
}

async function main() {
  fs.mkdirSync(receiptDir, { recursive: true })
  for (const directory of Object.values(profile)) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(scratch, '.vibe-owner.json'), JSON.stringify({ owner: 'AI Novel F05 U07 dirty tabs', sourceProject: repository, createdAt: new Date().toISOString(), ttlHours: 48, retainedReason: 'review packaged Writer dirty-tab receipt', cleanupCommand: `Remove-Item -LiteralPath '${scratch.replaceAll("'", "''")}' -Recurse -Force` }, null, 2))
  let app
  let failure
  let currentStep = 'setup'
  let projectCreateObservation = null
  let projectCoreBefore = null
  let projectCoreAfter = null
  let uiObservation = null
  const visualEvidence = []
  const captureVisual = async (page, name, target) => {
    const file = path.join(receiptDir, `v3-${name}-1440x900.png`)
    const png = await page.screenshot({ path: file })
    const windowMetrics = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { windowSize: window.getSize(), contentSize: window.getContentSize(), zoomFactor: window.webContents.getZoomFactor() }
    })
    const rendering = await page.locator(target).evaluate(element => ({
      viewport: [window.innerWidth, window.innerHeight],
      bodyFontFamily: getComputedStyle(document.body).fontFamily,
      targetFontFamily: getComputedStyle(element).fontFamily,
    }))
    const evidence = { name, path: file, sha256: fileHash(file), pixels: [png.readUInt32BE(16), png.readUInt32BE(20)], ...windowMetrics, ...rendering }
    assert.deepEqual(evidence.pixels, [1440, 900])
    assert.deepEqual(evidence.contentSize, [1440, 900])
    assert.deepEqual(evidence.viewport, [1440, 900])
    assert.equal(evidence.zoomFactor, 1)
    visualEvidence.push(evidence)
    pass(`U07.A01-${name}-visual`, 'U07.A01', `Fresh-profile V3 ${name} screenshot: ${evidence.sha256}, 1440×900, zoom=1, font=${evidence.targetFontFamily}`)
  }
  const marker = `U07 dirty tab ${runId}`
  const env = { ...process.env, AI_NOVEL_APP_DATA_HOME: profile.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: profile.legacy, AI_NOVEL_VELA_HOME: profile.legacy, HOME: profile.home, USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  try {
    currentStep = 'packaged-native-load'
    assert.equal(git('diff', '--name-only', `${testedSha}..HEAD`, '--', ...productPathArgs), '', 'product source changed since fixed package SHA')
    const dirtyProductPaths = git('status', '--porcelain', '--', ...productPathArgs).split('\n').filter(Boolean)
    assert(dirtyProductPaths.every(line => /^\?\? src\/components\/(?:dialogs|editor|layout\/v2|pages\/v2|panels)\/__tests__\/__screenshots__\/$/.test(line)), 'product source dirty beyond test screenshots')
    assert.equal(fileHash(executablePath), expectedExeSha)
    assert.equal(fileHash(asarPath), expectedAsarSha)
    const verified = verifyWindowsPackage(packageDir)
    assert(verified.nativeBinding && verified.betterSqliteBinding)
    assert.equal(verifyPackagedBetterSqliteLoad(packageDir), 'PACKAGED_BETTER_SQLITE3_LOAD_OK')
    assert.equal(verifyPackagedLanceLoad(packageDir), 'PACKAGED_LANCEDB_LOAD_OK')
    pass('packaged-native-load', null, 'fixed package artifact hashes and packaged native bindings verified')
    app = await electron.launch({ executablePath, cwd: packageDir, args: [`--user-data-dir=${profile.userData}`], env, timeout: 30_000 })
    const page = await app.firstWindow({ timeout: 30_000 })
    page.setDefaultTimeout(12_000)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    await page.locator('.app-skin-root').waitFor({ state: 'visible', timeout: 30_000 })
    if (columnsOnly) await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(1440, 900)
      window.webContents.setZoomFactor(1)
    })

    currentStep = 'fixture-project'
    const project = await invoke(page, 'project:create', { path: profile.projects, name: 'U07-dirty-tabs', genre: 'fixture', targetAudience: 'fixture', writingLanguage: 'zh-CN' }, randomUUID(), null)
    projectCreateObservation = { success: project.success, stale: project.stale ?? 'absent', error: project.error ?? null, projectPath: project.projectPath ?? null }
    assert.equal(project.success, true, JSON.stringify(projectCreateObservation))
    projectCoreBefore = readProjectCore(project.projectPath)
    await page.evaluate(() => { const key = 'ai-novel-writer-appearance'; const old = JSON.parse(localStorage.getItem(key) ?? '{}'); localStorage.setItem(key, JSON.stringify({ ...old, shellPreference: 'writer', revision: Number(old.revision ?? 0) + 1, origin: 'author' })) })
    await page.reload()
    await assertWriter(page, 'U07.A02')
    await waitHome(page)
    if (columnsOnly) {
      currentStep = 'U07.A01-shelf-visual'
      await captureVisual(page, 'shelf', '.writer-welcome')
    }
    await page.locator('.writer-shelf').getByRole('button', { name: '打开《U07-dirty-tabs》' }).click()
    await page.locator('.writer-project-tree').getByText('U07-dirty-tabs', { exact: true }).waitFor({ state: 'visible' })

    if (!immersionOnly && !columnsOnly) {
    currentStep = 'U07.A02-dirty-indicator'
    await assertWriter(page, 'U07.A02')
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
    const field = page.getByPlaceholder(placeholder)
    await field.fill(marker)
    assert.equal(await field.inputValue(), marker)
    assert.equal(readProjectCore(project.projectPath), projectCoreBefore, 'unsaved config edit must not change the SQLite project_core snapshot')
    await page.getByText('未保存', { exact: true }).first().waitFor({ state: 'visible' })
    const dirtyClose = page.locator('[title="有未保存的修改，点击关闭"]')
    await dirtyClose.waitFor({ state: 'visible' })
    pass('U07.A02-dirty-indicator', 'U07.A02', 'V3 config edit shows the visible 未保存 status, the dirty close affordance, and the SQLite project_core remains at its original snapshot')

    currentStep = 'U07.A03-cancel-close'
    await assertWriter(page, 'U07.A03')
    await dirtyClose.click()
    const dialog = page.getByRole('dialog').filter({ hasText: '关闭未保存的文件' })
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByText('有未保存的修改').waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await field.inputValue(), marker)
    assert.equal(readProjectCore(project.projectPath), projectCoreBefore, 'canceling close must leave the SQLite project_core snapshot unchanged')
    await dirtyClose.waitFor({ state: 'visible' })
    pass('U07.A03-cancel-close', 'U07.A03', 'Canceling the close confirmation keeps the V3 dirty tab and edited value visible without changing SQLite project_core')

    currentStep = 'U07.A03-discard-close'
    await assertWriter(page, 'U07.A03')
    await dirtyClose.click()
    const discardDialog = page.getByRole('dialog').filter({ hasText: '关闭未保存的文件' })
    await discardDialog.waitFor({ state: 'visible' })
    await discardDialog.getByRole('button', { name: '放弃修改', exact: true }).click()
    await discardDialog.waitFor({ state: 'detached' })
    await dirtyClose.waitFor({ state: 'detached' })
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '小说配置' }).first().click()
    assert.notEqual(await field.inputValue(), marker, 'discarded config draft must not reappear when the tab is reopened')
    projectCoreAfter = readProjectCore(project.projectPath)
    assert.equal(projectCoreAfter, projectCoreBefore, 'discarding close must preserve the original SQLite project_core snapshot')
    pass('U07.A03-discard-close', 'U07.A03', 'Discarding the close confirmation closes the V3 dirty tab, removes the draft on reopen, and preserves the original SQLite project_core snapshot')

    currentStep = 'U07.A04-tab-prev-next'
    await assertWriter(page, 'U07.A04')
    const architectureEntry = page.locator('.writer-project-tree').getByTitle('打开故事架构编辑器（可生成架构文档）')
    const architectureEntryCount = await architectureEntry.count()
    uiObservation = {
      action: 'U07.A04',
      architectureEntryCount,
      architectureEntryTitle: architectureEntryCount > 0 ? await architectureEntry.first().getAttribute('title') : null,
      tabLabelsBeforeClick: await tabBar(page).locator('span').allTextContents(),
    }
    await architectureEntry.click()
    uiObservation.tabLabelsAfterClick = await tabBar(page).locator('span').allTextContents()
    await assertActiveTab(page, '故事架构', 'U07.A04')
    await tabBar(page).getByTitle('上一个编辑器').click()
    await assertActiveTab(page, '小说配置', 'U07.A04.previous')
    await field.waitFor({ state: 'visible' })
    await tabBar(page).getByTitle('下一个编辑器').click()
    await assertActiveTab(page, '故事架构', 'U07.A04.next')
    pass('U07.A04-tab-prev-next', 'U07.A04', 'V3 previous/next editor controls move between the open 小说配置 and 故事架构 tabs and activate the corresponding editor')

    currentStep = 'U07.A05-open-tab-list'
    await assertWriter(page, 'U07.A05')
    await tabBar(page).getByTitle('已打开的编辑器').click()
    const configFromList = page.getByRole('button', { name: '小说配置', exact: true })
    const architectureFromList = page.getByRole('button', { name: '故事架构', exact: true })
    await configFromList.waitFor({ state: 'visible' })
    await architectureFromList.waitFor({ state: 'visible' })
    await configFromList.click()
    await assertActiveTab(page, '小说配置', 'U07.A05')
    await field.waitFor({ state: 'visible' })
    pass('U07.A05-open-tab-list', 'U07.A05', 'V3 已打开的编辑器 list exposes both open tabs and selecting 小说配置 returns to its editor')

    currentStep = 'U07.A06-rail-tab-sync'
    await assertWriter(page, 'U07.A06')
    await page.locator('.writer-project-tree .tree-item').filter({ hasText: '章节蓝图' }).first().click()
    await assertActiveTab(page, '章节蓝图', 'U07.A06.blueprint')
    const blueprintRail = page.locator('.writer-left-rail button[title="章节蓝图"]')
    await blueprintRail.waitFor({ state: 'visible' })
    assert((await blueprintRail.getAttribute('class') ?? '').includes('is-active'), 'U07.A06: blueprint rail item is not active for the blueprint tab')
    await tabByName(page, '小说配置').click()
    await assertActiveTab(page, '小说配置', 'U07.A06.config')
    const projectRail = page.locator('.writer-left-rail button[title="项目"]')
    await projectRail.waitFor({ state: 'visible' })
    assert((await projectRail.getAttribute('class') ?? '').includes('is-active'), 'U07.A06: project rail item is not active for the config tab')
    pass('U07.A06-rail-tab-sync', 'U07.A06', 'V3 tab selection and the Writer 栏目 highlight stay synchronized for 章节蓝图 and 小说配置')
    }

    if (!columnsOnly) {
    currentStep = 'U07.A07-enter-exit-immersion'
    await assertWriter(page, 'U07.A07')
    const shell = writer(page)
    const sidebar = page.locator('aside[aria-label="作品资料"]')
    const assistant = page.locator('aside[aria-label="写作助手"]')
    const bottom = page.locator('section[aria-label="任务与日志"]')
    const assistantInput = page.getByPlaceholder('输入消息，@ 提及，/ 使用工作流...')
    const inputMarker = `未发送助手输入 ${runId}`
    await sidebar.waitFor({ state: 'visible' })
    await assistant.waitFor({ state: 'visible' })
    await bottom.waitFor({ state: 'visible' })
    await assistantInput.fill(inputMarker)
    assert.equal(await assistantInput.inputValue(), inputMarker)
    const enterImmersion = page.getByRole('button', { name: '进入沉浸写作', exact: true })
    await enterImmersion.click()
    assert.equal(await shell.getAttribute('data-writer-immersive'), 'true')
    await sidebar.waitFor({ state: 'hidden' })
    await assistant.waitFor({ state: 'hidden' })
    await bottom.waitFor({ state: 'hidden' })
    const exitImmersion = page.getByRole('button', { name: '退出沉浸写作', exact: true })
    await exitImmersion.click()
    assert.equal(await shell.getAttribute('data-writer-immersive'), 'false')
    await sidebar.waitFor({ state: 'visible' })
    await assistant.waitFor({ state: 'visible' })
    await bottom.waitFor({ state: 'visible' })
    assert.equal(await assistantInput.inputValue(), inputMarker)
    pass('U07.A07-enter-exit-immersion', 'U07.A07', 'V3 titlebar enters immersion, hides all three panels, and exits with their visible state restored')

    currentStep = 'U07.A08-open-panel-preserves-input'
    await enterImmersion.click()
    assert.equal(await shell.getAttribute('data-writer-immersive'), 'true')
    await assistant.waitFor({ state: 'hidden' })
    await page.locator('.writer-rail-host button[title="AI Agent 面板"]').click()
    assert.equal(await shell.getAttribute('data-writer-immersive'), 'false')
    await assistant.waitFor({ state: 'visible' })
    assert.equal(await assistantInput.inputValue(), inputMarker, 'opening the agent panel must preserve the exact unsent input')
    pass('U07.A08-open-panel-preserves-input', 'U07.A08', 'V3 right-rail Agent button exits immersion, opens the assistant, and preserves the exact unsent input')
    }

    if (columnsOnly) {
      const leftRail = page.locator('.writer-left-rail')
      const reference = page.locator('aside[aria-label="作品资料"]')
      const tasks = page.locator('section[aria-label="任务与日志"]')
      const visit = async (id, title, visible) => {
        currentStep = `U07.A01-${id}`
        const button = leftRail.locator(`button[title="${title}"]`)
        await button.click()
        await visible.waitFor({ state: 'visible' })
        assert((await button.getAttribute('class') ?? '').includes('is-active'), `${title} rail button is not active`)
        pass(currentStep, 'U07.A01', `Clicked ${title}; visible result: ${(await visible.textContent()).trim()}`)
      }
      await visit('home', '欢迎页', page.locator('.writer-shelf h2'))
      await visit('project', '项目', reference.locator('.writer-project-tree').getByText('U07-dirty-tabs', { exact: true }))
      await visit('novel', '小说', reference.getByText('已入库章节', { exact: true }))
      await visit('characters', '角色', reference.getByText(/^角色列表（\d+）$/))
      await visit('blueprint', '章节蓝图', page.locator('.writer-editor-content').getByText('暂无蓝图，可点击右上角「+」手动新建，或用「AI 生成蓝图」批量创建。', { exact: true }))
      await assertActiveTab(page, '章节蓝图', 'U07.A01.blueprint')
      await visit('world', '世界观', page.locator('.writer-editor-content').getByText(/^\d+\/4 已生成$/))
      await assertActiveTab(page, '故事架构', 'U07.A01.world')
      currentStep = 'U07.A01-world-editor-visual'
      await captureVisual(page, 'world-editor', '.writer-editor-content')
      await visit('plot-tree', '剧情树', page.locator('.writer-editor-content').getByRole('heading', { name: '剧情树与叙事线索' }))
      await assertActiveTab(page, '剧情树与叙事线索', 'U07.A01.plot-tree')
      await visit('tasks', '任务', tasks.getByText('暂无任务，AI 工作流启动后会在这里展示进度', { exact: true }))
      await visit('log', '日志', tasks.getByText('日志', { exact: true }).first())
      await visit('models', '模型', tasks.getByText('模型调用', { exact: true }).first())
      await visit('settings', '设置', page.getByRole('heading', { name: 'AI 生成模型' }))
      await page.getByRole('button', { name: '关闭设置' }).click()
      for (const [id, title, visibleText] of [
        ['ai-output', 'AI 输出', 'AI 输出'],
        ['agent', 'AI Agent 面板', 'AI 写作助手'],
      ]) {
        currentStep = `U07.A01-${id}`
        await page.locator(`.writer-rail-host button[title="${title}"]`).click()
        const visible = page.locator('aside[aria-label="写作助手"]').getByText(visibleText, { exact: true }).first()
        await visible.waitFor({ state: 'visible' })
        pass(currentStep, 'U07.A01', `Clicked ${title}; visible result: ${(await visible.textContent()).trim()}`)
      }
      pass('U07.A01-all-columns', 'U07.A01', 'All 13 current V3 left/right rail business entries were clicked and reached their visible owner; 世界观 opens the 故事架构 editor and active tab')
    }
  } catch (error) { failure = error }
  finally { await app?.close() }
  const artifactHashes = { executable: fileHash(executablePath), asar: fileHash(asarPath) }
  const verifiedActions = [...new Set(steps.map(step => step.actionId).filter(Boolean))].filter(id => id !== 'U07.A01' || steps.some(step => step.stepId === 'U07.A01-all-columns'))
  const receipt = { outcome: failure ? 'FAIL' : 'PARTIAL', qualification: 'F05_U07_V3_PARTIAL', evidenceLevel: 'electron', shell: 'writer-v3', testedSha, executionHead: git('rev-parse', 'HEAD'), changedPaths, packageRoot: packageDir, artifactHashes, driver: { path: scriptPath, sha256: fileHash(scriptPath) }, sourceDirty: git('status', '--porcelain').split('\n').filter(Boolean), dirtyProductPaths: git('status', '--porcelain', '--', ...productPathArgs).split('\n').filter(Boolean), profile: { canonical: profile.canonical, userData: profile.userData, projectRoot: profile.projects }, steps, visualEvidence, projectCreateObservation, projectCore: { table: 'project_core', key: "id='main'", originalSha256: projectCoreBefore ? sha256(Buffer.from(projectCoreBefore)) : null, afterDiscardSha256: projectCoreAfter ? sha256(Buffer.from(projectCoreAfter)) : null, unchanged: Boolean(projectCoreBefore && projectCoreAfter && projectCoreBefore === projectCoreAfter) }, uiObservation, scope: { mode: columnsOnly ? 'columns-only' : immersionOnly ? 'immersion-only' : 'full', verifiedActions, unverifiedActions: ['U07.A01', 'U07.A02', 'U07.A03', 'U07.A04', 'U07.A05', 'U07.A06', 'U07.A07', 'U07.A08'].filter(id => !verifiedActions.includes(id)).concat('full F05 and release qualification') }, failedStep: failure ? currentStep : null, error: failure ? String(failure) : null }
  fs.writeFileSync(path.join(receiptDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ outcome: receipt.outcome, receipt: path.join(receiptDir, 'receipt.json'), steps: steps.length }) + '\n')
  if (failure) throw failure
}

await main()
