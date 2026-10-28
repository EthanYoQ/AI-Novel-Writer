import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL, FIXTURE_CONFIG, FIXTURE_PROSE } from './fake-model.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as bookshelf from './pages/bookshelf.mjs'
import * as chapter from './pages/chapter.mjs'
import * as materials from './pages/materials.mjs'
import * as project from './pages/project.mjs'
import * as runPanel from './pages/run-panel.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as settings from './pages/settings.mjs'
import * as shell from './pages/shell.mjs'
import * as stage from './pages/stage.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

export const SAMPLE = Object.freeze({ name: '灯塔', chapterNumber: 1, blueprints: [[1, '旧港'], [2, '北堤']] })

/** 系统打开对话框直接返回 selected，文件夹与文件通用。 */
async function stubOpenDialog(app, selected) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, selected)
}

/** 用公开 IPC 预置示例作品，然后重载，让界面从书房重新打开它。 */
async function seedSample({ app, page, roots, invoke, reload }, { withDraft }) {
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: SAMPLE.name, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  const roster = await invoke(page, 'db:character-roster-read', created.projectPath, session)
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
    entries: [{ characterId: `draft:${randomUUID()}`, name: '林岚', role: 'protagonist', gender: '', age: '', appearance: '',
      personality: '', background: '旧港潮汐记录的测绘师。', abilities: '', motivation: '查明失踪地图的来源。',
      relationships: [], arc: '', notes: '' }] }, created.projectPath, session)).success, true)
  for (const [chapterNumber, title] of SAMPLE.blueprints) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber, title, role: '发展', purpose: '核对地图与潮位',
      keyEvents: '林岚在灯塔下见到守塔人', characters: [] }, created.projectPath, session)).success, true)
  }
  if (withDraft) {
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: SAMPLE.chapterNumber, version: 1, source: 'write',
      content: FIXTURE_PROSE, wordCount: FIXTURE_PROSE.length }, created.projectPath, session)
    assert.equal(draft.success, true, draft.error)
  }
  await reload()
  await openSample(page)
}

/** 从书房打开示例作品，等项目树的统一刷新结束；之前的画面随刷新进度变化。 */
async function openSample(page) {
  await bookshelf.openProject(page, SAMPLE.name)
  await project.waitForTreeRefreshed(page, SAMPLE.blueprints.length)
}

const seedWithDraft = context => seedSample(context, { withDraft: true })
export const seedWithoutDraft = context => seedSample(context, { withDraft: false })

async function openLatestDraft(page) {
  await project.openLatestDraft(page)
  await chapter.editor(page).getByText(FIXTURE_PROSE.slice(0, 12)).waitFor({ state: 'visible' })
}

async function writeChapter({ page }) {
  await project.openBlueprints(page)
  await chapter.writeThisChapter(page, 100)
  await runPanel.waitForWorkflowDone(page)
  await chapter.editor(page).getByText(FIXTURE_PROSE.slice(0, 12)).waitFor({ state: 'visible' })
}

async function reviewLatestDraft({ page }) {
  await openLatestDraft(page)
  await chapter.review(page)
  await runPanel.waitForWorkflowDone(page)
}

/**
 * setup 是单跑该场景时的前置；run 从前置状态走到截图状态；after 在截图后执行。
 * baseline-all 按 BASELINE_SESSIONS 串联：只跑首个场景的 setup，之后每个场景的 run 接着上一个截图点的状态。
 */
export const SCENARIOS = {
  'new-project': { model: false, run: async ({ app, page, roots }) => {
    await stubOpenDialog(app, roots.projects)
    await bookshelf.createProject(page, SAMPLE.name)
    await page.getByText('小说配置', { exact: true }).first().waitFor({ state: 'visible' })
  } },
  'open-sample': { model: false, setup: seedWithDraft, run: async ({ page }) => {
    await project.tree(page).getByText('草稿_v1', { exact: true }).waitFor({ state: 'visible' })
  } },
  'write-chapter': { model: true, setup: seedWithoutDraft, run: writeChapter },
  review: { model: true, setup: seedWithDraft, run: reviewLatestDraft },
  'revise-merge': { model: true,
    setup: async context => { await seedWithDraft(context); await reviewLatestDraft(context) },
    run: async ({ page }) => {
      await chapter.reviseFromReview(page, FAKE_MODEL.id)
      await chapter.mergeDialog(page).waitFor({ state: 'visible', timeout: 60_000 })
    },
    after: ({ page }) => chapter.completeMerge(page) },
  finalize: { model: true, setup: seedWithDraft, run: async ({ page }) => {
    await openLatestDraft(page)
    await chapter.finalize(page, SAMPLE.chapterNumber)
    await runPanel.waitForWorkflowDone(page)
  } },
  'run-panel': { model: true,
    setup: async context => { await seedWithoutDraft(context); await writeChapter(context) },
    run: async ({ page, reload }) => {
      await reload()
      await openSample(page)
      await runPanel.open(page)
      await runPanel.waitForPersistedRun(page, `第${SAMPLE.chapterNumber}章候选`)
    } },
  settings: { model: false, run: ({ page }) => settings.open(page), after: ({ page }) => settings.close(page) },
}

async function assertRunPanelHiddenThenOpens(page, open) {
  await runPanel.waitUntilOpen(page)
  await shell.hideRunPanel(page)
  assert.equal(await runPanel.isOpen(page), false, '收起后 AI 输出应隐藏')
  await open()
  await runPanel.waitUntilOpen(page)
}

async function assertBottomOpensOn(page, start) {
  await shell.closeBottomPanel(page)
  await start()
  await page.waitForFunction(() => !document.querySelector('#writer-bottom')?.hasAttribute('hidden'))
  await shell.bottomTabLabel(page, '任务').waitFor({ state: 'visible', timeout: 5_000 })
}

/** 作品文件夹里的文件（相对路径），数据库这类每次内容不同的文件只比名字。 */
function projectFiles(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

/** 去掉每次都不同的取值（标识、时间、路径），只留键与稳定的值，用来比较两边建出的清单。 */
function stableShape(value, key = '') {
  if (Array.isArray(value)) return value.map(item => stableShape(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(name => [name, stableShape(value[name], name)]))
  return /(Id|At)$|^(id|path)$|[Tt]ime|[Ll]ease|[Hh]ash/.test(key) ? typeof value : value
}

/**
 * 不进 baseline-all 的场景：性能测量，以及 RD-2 导航意图在旧外壳上的回归。run 的返回值写进结果的 measured。
 * nav- 场景对 trunk 与 head 各跑一次（--app-root 指向 trunk），两边都通过即行为一致。
 */
export const EXTRA_SCENARIOS = {
  /** 计划 RD-5 lane 1：两种外壳、trunk 与 head 各跑一次新建作品，比较作品文件夹里建出的文件。 */
  'new-project-files': { model: false, run: async ({ app, page, roots }) => {
    await stubOpenDialog(app, roots.projects)
    await bookshelf.createProject(page, SAMPLE.name)
    const created = path.join(roots.projects, SAMPLE.name)
    const deadline = Date.now() + 10_000
    while (!fs.existsSync(path.join(created, '.ai-novel', 'project.json'))) {
      assert.ok(Date.now() < deadline, '新建作品没有建出作品文件夹')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await page.waitForTimeout(1500)
    const manifest = JSON.parse(fs.readFileSync(path.join(created, '.ai-novel', 'project.json'), 'utf8'))
    return { files: projectFiles(created), manifest: stableShape(manifest) }
  } },
  'write-latency': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await project.openBlueprints(page)
    // RD-4 起旧外壳右栏默认就是 AI 输出；trunk 默认收着。只在开着时收起，两边从同一状态开始计时。
    if (await runPanel.isOpen(page)) {
      await shell.hideRunPanel(page)
      await runPanel.waitUntilClosed(page)
    }
    const writeToOutputMs = await runPanel.msFromClickToOpen(page, '开始创作', () => chapter.writeThisChapter(page, 100))
    await runPanel.waitForWorkflowDone(page)
    return { writeToOutputMs }
  } },
  'nav-switch-project': { model: false, setup: seedWithDraft, run: async ({ app, page, roots, invoke }) => {
    const other = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
      name: '雾岛', genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(other.success, true, other.error)
    await shell.clickRail(page, '角色')
    await shell.toggleImmersion(page)
    assert.equal(await shell.isImmersive(page), true)
    await stubOpenDialog(app, other.projectPath)
    await shell.switchProject(page)
    await project.tree(page).getByText('雾岛', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await shell.isImmersive(page), false, '切换项目后应退出沉浸')
    assert.equal((await shell.panels(page)).sidebar, true, '切换项目后侧栏应显示')
    await project.tree(page).waitFor({ state: 'visible' })
  } },
  'nav-toast-open': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await project.openBlueprints(page)
    await chapter.writeThisChapter(page, 100)
    await runPanel.waitForWorkflowDone(page)
    await assertRunPanelHiddenThenOpens(page, () => runPanel.openFromCompletionToast(page))
    await runPanel.waitForPersistedRun(page, `第${SAMPLE.chapterNumber}章候选`)
  } },
  'nav-status-capsule': { model: true, setup: seedWithoutDraft, run: async ({ page, fake }) => {
    fake.gate.hold()
    await project.openBlueprints(page)
    await chapter.writeThisChapter(page, 100)
    await runPanel.waitForStatusCapsule(page)
    await assertRunPanelHiddenThenOpens(page, () => runPanel.openFromStatusCapsule(page))
  }, after: async ({ page, fake }) => {
    fake.gate.release()
    await runPanel.waitForWorkflowDone(page)
  } },
  'nav-settings-model': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await shell.openBackupSettings(page)
    await settings.waitForSection(page, '项目备份')
    await settings.close(page)
    await shell.clickStatusBarModel(page)
    await settings.waitForSection(page, 'AI 生成模型')
  }, after: ({ page }) => settings.close(page) },
  'nav-kb-import': { model: true, setup: seedWithoutDraft, run: async ({ app, page, roots }) => {
    const file = path.join(roots.temp, '灯塔资料.txt')
    fs.writeFileSync(file, '林岚：旧港潮汐记录的测绘师，追查失踪地图的来源。')
    await stubOpenDialog(app, file)
    await shell.clickRail(page, '小说')
    await assertBottomOpensOn(page, () => materials.importPlanningMaterial(page))
  }, after: ({ page }) => runPanel.cancelActiveRuns(page) },
  'nav-card-import': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await shell.clickRail(page, '角色')
    await assertBottomOpensOn(page, () => materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。'))
  }, after: ({ page }) => runPanel.cancelActiveRuns(page) },
  // 卡住模型让截图停在「批量创作运行中」，与 verify/SKILL.md 的说明一致；不卡时截图可能已是完成后的画面。
  'nav-batch': { model: true, setup: seedWithoutDraft, run: async ({ page, fake }) => {
    fake.gate.hold()
    await project.openBlueprints(page)
    await assertBottomOpensOn(page, () => chapter.startBatch(page, FAKE_MODEL.id, 100))
    await untilGateHolds(fake.gate)
  }, after: async ({ page, fake }) => {
    fake.gate.release()
    await runPanel.waitForWorkflowDone(page)
  } },
  'nav-home-import': { model: true, setup: seedWithoutDraft, run: async ({ app, page, roots, fake }) => {
    const file = path.join(roots.temp, '参考小说.txt')
    fs.writeFileSync(file, `第1章 旧港\n${FIXTURE_PROSE}\n\n第2章 北堤\n${FIXTURE_PROSE}\n`)
    await stubOpenDialog(app, file)
    await shell.clickRail(page, '首页')
    await shell.shelf(page).waitFor({ state: 'visible' })
    assert.equal(await project.tree(page).isVisible(), false, '首页不显示项目树')
    assert.equal(await runPanel.isOpen(page), false, '首页不显示 AI 输出')
    fake.gate.hold({ embeddings: true })
    await materials.importReferenceNovelIntoCurrentProject(page, 2)
    await project.tree(page).waitFor({ state: 'visible' })
    await runPanel.waitUntilOpen(page)
    assert.equal(await shell.shelf(page).isVisible(), false, '启动导入后应离开首页')
    await project.waitForTreeRefreshed(page, SAMPLE.blueprints.length)
    await untilGateHolds(fake.gate)
  }, after: async ({ page, fake }) => {
    fake.gate.release()
    await runPanel.waitForStatusCapsuleGone(page)
  } },
  'settings-appearance': { model: false, run: async ({ page }) => {
    await settings.open(page)
    await settings.showSection(page, '外观')
  }, after: ({ page }) => settings.close(page) },
  'nav-immersive-twice': { model: false, setup: seedWithDraft, run: async ({ page }) => {
    await shell.closeBottomPanel(page)
    const before = await shell.panels(page)
    await shell.toggleImmersion(page)
    assert.deepEqual(await shell.panels(page), { sidebar: false, assistant: false, bottom: false })
    await shell.toggleImmersion(page)
    assert.deepEqual(await shell.panels(page), before, '两次切换后面板应恢复到切换前')
    assert.equal(await shell.isImmersive(page), false)
  } },
  'nav-plot-blueprint-source': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    const title = page.getByPlaceholder('引人入胜的章节标题')
    const selectedChapter = () => page.locator('input[type="number"][aria-readonly="true"]').inputValue()
    const openSourceOf = async chapterNumber => {
      await project.openNode(page, '伏笔与叙事线索')
      await page.getByRole('tab', { name: '剧情树' }).click()
      await page.getByRole('button', { name: /^已计划/ }).nth(chapterNumber - 1).click()
      await page.getByText(`第 ${chapterNumber} 章 · 已计划`).waitFor({ state: 'visible' })
      await page.getByRole('button', { name: `第 ${chapterNumber} 章蓝图` }).click()
      await title.waitFor({ state: 'visible' })
    }
    await project.openNode(page, '伏笔与叙事线索')
    await page.getByRole('tab', { name: '剧情树' }).click()
    await page.getByRole('button', { name: '生成剧情树' }).click()
    await page.getByRole('button', { name: /^已计划/ }).nth(SAMPLE.blueprints.length - 1).waitFor({ state: 'visible', timeout: 60_000 })

    await openSourceOf(1)
    assert.equal(await selectedChapter(), '1')
    await title.fill('旧港（未保存的改动）')
    await openSourceOf(2)
    assert.equal(await selectedChapter(), '2', '从剧情树打开第 2 章蓝图应选中第 2 章')
    await openSourceOf(1)
    assert.equal(await selectedChapter(), '1')
    assert.equal(await title.inputValue(), '旧港（未保存的改动）', '切换选中后第 1 章未保存的改动仍在')
    await page.getByText('北堤', { exact: true }).click()
    assert.equal(await selectedChapter(), '2')
    await openSourceOf(1)
    assert.equal(await selectedChapter(), '1', '再次打开同一来源应重新选中第 1 章')
    assert.equal(await title.inputValue(), '旧港（未保存的改动）')
  } },
}

export const firstLine = text => text.split('\n')[0].slice(0, 16)

/** 等到有请求卡在假模型的门上：截图停在运行卡住的那一步，而不是它前后某个随机时刻。 */
export async function untilGateHolds(gate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (gate.waiting === 0) {
    assert.ok(Date.now() < deadline, `${timeoutMs} ms 内没有请求卡在假模型的门上`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * 用公开 IPC 预置新外壳示例作品：12 章蓝图，1、2 章定稿，3 章已审稿，4 章草稿；架构四节齐全。
 * totalChapters 改规划总章数；beforeReload 在重载前再写入数据；landOnChapter3 为 false 时只等流程脊，落点由场景自己断言。
 * beforeReload 另写了蓝图时用 blueprintCount 告诉旧外壳要等项目树显示几章。
 */
export async function seedStageSample(context,
  { totalChapters = STAGE_SAMPLE.totalChapters, beforeReload, landOnChapter3 = true, open = true, blueprintCount = STAGE_SAMPLE.titles.length } = {}) {
  const { app, page, roots, invoke, reload } = context
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: STAGE_SAMPLE.name, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const path = created.projectPath
  context.samplePath = path
  const session = { projectId: created.projectId, projectPath: path, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  const roster = await invoke(page, 'db:character-roster-read', path, session)
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
    entries: [{ characterId: `draft:${randomUUID()}`, name: '林岚', role: 'protagonist', gender: '', age: '', appearance: '',
      personality: '', background: '旧港潮汐记录的测绘师。', abilities: '', motivation: '查明失踪地图的来源。',
      relationships: [], arc: '', notes: '' }] }, path, session)).success, true)
  const core = await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, totalChapters,
    wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, path, session)
  assert.equal(core.success, true, core.error)
  for (const [index, title] of STAGE_SAMPLE.titles.entries()) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: index + 1, title, role: '发展', purpose: '推进灯塔与沉船的线索',
      keyEvents: '林岚在灯塔里找到新的线索', characters: [] }, path, session)).success, true)
  }
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
    chapters: Object.entries(STAGE_SAMPLE.finalized).map(([number, content]) => ({ chapterNumber: Number(number),
      title: stageChapterTitle(Number(number)), content, wordCount: countUnits(content) })) }, path, session)
  assert.equal(imported.success, true, imported.error)
  for (const [number, { status, text, review }] of Object.entries(STAGE_SAMPLE.drafts)) {
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: Number(number), version: 1, source: 'write',
      content: text, wordCount: countUnits(text) }, path, session)
    assert.equal(draft.success, true, draft.error)
    if (status !== 'draft') assert.equal((await invoke(page, 'db:draft-update-status', draft.id, status, undefined, path, session)).success, true)
    if (review) {
      const expectedSource = { id: draft.id, chapterNumber: Number(number), version: 1, status, content: text }
      const created = await invoke(page, 'db:review-create', { baseDraftId: draft.id, content: review, expectedSource }, path, session)
      assert.equal(created.success, true, created.error)
    }
  }
  await beforeReload?.({ page, invoke, path, session })
  await reload()
  if (!open) return
  if (await stage.root(page).count() > 0) {
    await stage.openFromLibrary(page, STAGE_SAMPLE.name)
    if (landOnChapter3) await moveToChapter3(page)
    return
  }
  await bookshelf.openProject(page, STAGE_SAMPLE.name)
  await project.waitForTreeRefreshed(page, blueprintCount)
  if (!landOnChapter3) return
  await project.draftOfChapter(page, 3).click()
  await chapter.editor(page).getByText(firstLine(STAGE_SAMPLE.drafts[3].text)).waitFor({ state: 'visible' })
}

/**
 * 示例作品第 3、4 章都在写，打开时落在最后一章在写的那章（用户决定）：示例本身落第 4 章，种子另建更后面的稿时落那一章。
 * 各场景从第 3 章开始：等任一章正文出现，不在第 3 章就切过去，再关掉其他所有标签，与原先只开着第 3 章一样。
 * 对照用的旧构建落在第 3 章，不用切。
 */
async function moveToChapter3(page) {
  const chapter3Text = firstLine(STAGE_SAMPLE.drafts[3].text)
  const chapter3 = stage.prose(page).getByText(chapter3Text)
  await stage.prose(page).filter({ hasText: /\S/ }).first().waitFor({ state: 'visible', timeout: 20_000 })
  const otherTabs = stage.closeOtherTabButtons(page, `第 3 章 · ${stageChapterTitle(3)}`)
  if (await chapter3.count() > 0 && await otherTabs.count() === 0) return
  await stage.chapterButton(page, 3).click()
  await stage.waitForProse(page, chapter3Text)
  while (await otherTabs.count() > 0) {
    const closing = otherTabs.first()
    const name = await closing.getAttribute('aria-label')
    assert.ok(name, '标签的关闭按钮带 aria-label，才能等这一个消失')
    await closing.click()
    // 等刚点的这个标签消失，不等某个下标：关掉一个后下标会前移，旧下标的等待会立即通过。
    await stage.tabList(page).getByRole('button', { name, exact: true }).waitFor({ state: 'detached' })
  }
  // 只剩一个标签与一个都不剩时标签条都会收起，所以还要确认留下的是第 3 章。
  await stage.tabList(page).waitFor({ state: 'detached' })
  assert.equal(await chapter3.isVisible(), true, '关掉其他标签后第 3 章仍开着')
}

/**
 * 夹具更新源：替换主进程的更新 IPC，并推一次「发现 1.2.3」。下载时先推 40% 进度，400 ms 后变为待重启；
 * 重启安装只记次数，不会真的退出。
 */
async function stubUpdates(app) {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const base = { currentVersion: '1.2.2', availableVersion: '1.2.3', updateAction: 'download', releaseName: '1.2.3', isReminderDeferred: false }
    const fixture = globalThis.__driveUpdate = { state: { ...base, status: 'available' }, installs: 0 }
    const publish = state => {
      fixture.state = state
      BrowserWindow.getAllWindows()[0]?.webContents.send('update:state', state)
    }
    for (const channel of ['update:get-state', 'update:check', 'update:download', 'update:open-release', 'update:defer-reminder', 'update:quit-and-install']) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.handle('update:get-state', () => fixture.state)
    ipcMain.handle('update:check', () => ({ success: true, checked: true, updateAvailable: true, state: fixture.state }))
    ipcMain.handle('update:download', () => {
      publish({ ...base, status: 'downloading', downloadProgress: { percent: 40, transferred: 40, total: 100, bytesPerSecond: 100 } })
      setTimeout(() => publish({ ...base, status: 'downloaded' }), 400)
      return { success: true, state: fixture.state }
    })
    ipcMain.handle('update:open-release', () => ({ success: true, state: fixture.state }))
    ipcMain.handle('update:defer-reminder', () => ({ success: true, state: fixture.state }))
    ipcMain.handle('update:quit-and-install', () => {
      fixture.installs += 1
      return { success: true, state: fixture.state }
    })
    publish(fixture.state)
  })
}

/** 设定页保存失败时页脚的说明。 */
const SETUP_SAVE_FAILED = '没能保存。设定还在这一页，没有丢，可以再保存一次。'

/** 让主进程的 project:save 返回失败（模拟磁盘写不进去）；fail 为 false 时换回原来的处理函数。 */
async function failProjectSaves(app, fail) {
  await app.evaluate(({ ipcMain }, fail) => {
    const handlers = ipcMain._invokeHandlers
    if (!handlers?.has('project:save')) throw new Error('取不到 project:save 的处理函数')
    if (fail) {
      globalThis.__driveSave ??= handlers.get('project:save')
      handlers.set('project:save', async () => ({ success: false, error: 'DRIVE_DISK_FULL' }))
    } else handlers.set('project:save', globalThis.__driveSave)
  }, fail)
}

/** 在主进程拦下文件名含 pattern 的代码块请求（模拟磁盘读失败）；把 pattern 清空即放行。请求都记进 log。 */
async function blockChunks(app, pattern) {
  await app.evaluate(({ session }, initial) => {
    globalThis.__driveChunkBlock = { pattern: initial, log: [] }
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
      const { pattern: blocked, log } = globalThis.__driveChunkBlock
      const name = details.url.slice(details.url.lastIndexOf('/') + 1)
      if (!name.endsWith('.js') && !name.includes('.js?')) return callback({})
      const cancel = blocked !== null && name.includes(blocked)
      if (name.includes('Stage')) log.push(`${cancel ? 'cancel' : 'allow'} ${name}`)
      callback({ cancel })
    })
  }, pattern)
}

/** 在渲染进程里计时：从点击 trigger 指向的元素到正文编辑区出现 text，单位毫秒，帧粒度。 */
export async function msFromClickToProse(page, target, proseSelector, text, deadlineMs = 20_000) {
  const handle = await target.elementHandle()
  await page.evaluate(({ element, proseSelector, text, deadlineMs }) => {
    let clickedAt = null
    element.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
    window.__driveProseLatency = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`正文在 ${deadlineMs} ms 内未出现`)), deadlineMs)
      const tick = () => {
        const shown = [...document.querySelectorAll(proseSelector)].some(node => node.textContent.includes(text) && node.getClientRects().length > 0)
        if (clickedAt !== null && shown) {
          clearTimeout(deadline)
          resolve(Math.round(performance.now() - clickedAt))
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { element: handle, proseSelector, text, deadlineMs })
  await target.click()
  return page.evaluate(() => window.__driveProseLatency)
}

/**
 * 文字与它实际落在的底色之间的对比度。checks 是 [选择器, 最低比值]：普通字号的文字（说明文字也算）4.5，图标等非文字元素 3；scope 是加在每个选择器前的祖先。
 * 底色沿祖先逐层叠加半透明背景求出，与画面上的颜色一致。
 */
export async function contrastFailures(page, checks, scope = '') {
  return page.evaluate(({ checks, scope }) => {
    // color-mix 的结果以 color(srgb r g b / a) 给出，通道是 0–1；rgb()/rgba() 是 0–255
    const parse = value => {
      const numbers = value.match(/[\d.]+/g).map(Number)
      const [r, g, b] = value.startsWith('color(') ? numbers.slice(0, 3).map(channel => channel * 255) : numbers.slice(0, 3)
      return { r, g, b, a: numbers[3] ?? 1 }
    }
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
    const backdrop = element => {
      const layers = []
      for (let node = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor)
        if (color.a > 0) layers.push(color)
        if (color.a === 1) break
      }
      return layers.reverse().reduce((bottom, top) => over(top, bottom), { r: 255, g: 255, b: 255, a: 1 })
    }
    const luminance = ({ r, g, b }) => [r, g, b].map(value => value / 255)
      .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const ratio = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (high + 0.05) / (low + 0.05)
    }
    return checks.flatMap(([selector, minimum]) => [...document.querySelectorAll(`${scope}${selector}`)].map(element => {
      const value = ratio(parse(getComputedStyle(element).color), backdrop(element))
      return { selector, text: element.textContent, ratio: Math.round(value * 100) / 100, minimum }
    }).filter(result => result.ratio < result.minimum))
  }, { checks, scope })
}

const CHROME_CONTRAST = [
  ['.stage-row-name', 4.5], ['.stage-row-label', 4.5], ['.stage-chapter:not([data-phase="todo"]) .stage-chapter-title', 4.5],
  ['.stage-work-title', 4.5], ['.stage-row-meta', 4.5], ['.stage-chapter-status', 4.5], ['.stage-chapter[data-phase="todo"] .stage-chapter-title', 4.5],
  ['.stage-crumb', 4.5], ['.stage-search-hint', 4.5], ['.stage-saved', 4.5], ['.stage-spine-label', 4.5], ['.stage-chapter-no', 4.5],
  ['.stage-library-title', 4.5], ['.stage-eyebrow', 4.5], ['.stage-start-text > b', 4.5], ['.stage-start-text > span', 4.5],
  ['.stage-shelf-title', 4.5], ['.stage-shelf-hint', 4.5], ['.stage-book-title', 4.5], ['.stage-book-name', 4.5], ['.stage-book-meta', 4.5],
  ['.stage-ov-title', 4.5], ['.stage-ov-meta', 4.5], ['.stage-ov-bar-label', 4.5], ['.stage-ov .pi-stat-label', 4.5],
  ['.stage-setup-title', 4.5], ['.stage-setup-lede', 4.5], ['.stage-setup-label', 4.5], ['.stage-setup-hint', 4.5], ['.stage-chip', 4.5],
  ['.stage-setup-panel-title', 4.5], ['.stage-setup-panel-desc', 4.5], ['.stage-setup-outline-foot', 4.5],
  ['.stage-set-title', 4.5], ['.stage-set-lede', 4.5], ['.stage-set-link', 4.5], ['.stage-set-required', 4.5], ['.stage-set-group-label', 4.5], ['.stage-set-row-title', 4.5],
  ['.stage-set-row-desc', 4.5], ['.stage-set-model-name', 4.5], ['.stage-set-model-meta', 4.5], ['.stage-badge', 4.5], ['.stage-set-theme-name', 4.5],
  ['.stage-set-theme-desc', 4.5], ['.pi-empty-title', 4.5], ['.pi-empty-text', 4.5],
  ['.stage-update-title', 4.5], ['.stage-update-text', 4.5], ['.stage-library .pi-btn:not(.pi-btn--icon)', 4.5], ['.stage-library .pi-btn--icon', 3], ['.pi-notice-title', 4.5], ['.pi-notice-text', 4.5],
]

/** 新外壳里的文字对比度：checks 默认查外壳文字，页面场景传自己的选择器。 */
export const chromeContrastFailures = (page, checks = CHROME_CONTRAST) => contrastFailures(page, checks, '[data-shell-presentation="stage"] ')

async function assertSpineMatchesSample(page) {
  assert.deepEqual(await stage.stageStates(page), { setup: 'done', architecture: 'done', blueprint: 'done', manuscript: 'active' })
  const rows = await stage.chapterRows(page)
  assert.deepEqual(rows.map(row => row.number), STAGE_SAMPLE.titles.map((_, index) => index + 1))
  assert.deepEqual(rows.slice(0, 5).map(row => row.phase), ['final', 'final', 'reviewed', 'draft', 'todo'])
  assert.deepEqual(rows.filter(row => row.current).map(row => row.number), [3], '预置后停在第 3 章')
}

/** 新外壳场景只在 head 上跑（trunk 没有新外壳）；chapter-switch 两种外壳都能跑，用于性能对照。 */
/** 设置页里改了模型名、没有保存：作品里从流程脊、书房里从顶栏的设置按钮打开。 */
async function dirtyModelName(page) {
  if (!(await stage.settingsNav(page).count())) {
    if (await stage.spine(page).count()) await stage.openSettings(page)
    else {
      await stage.root(page).getByRole('banner').getByRole('button', { name: '设置', exact: true }).click()
      await stage.settingsNav(page).waitFor({ state: 'visible' })
    }
  }
  if (await stage.currentSettingsPage(page) !== 'AI 模型') await stage.showSettingsPage(page, 'AI 模型')
  const name = stage.root(page).getByPlaceholder('如：DeepSeek 主力 / GPT-4o 备用')
  if (!(await name.count())) await page.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」` }).click()
  await name.fill('还没保存的名字')
}

const discardDialog = page => page.getByRole('dialog', { name: '放弃未保存的修改？' })

/** 离开设置页的确认出现；选「继续编辑」后设置页还在、输入还在。 */
async function keepEditing(page, entry, context) {
  await discardDialog(page).waitFor({ state: 'visible' })
  assert.equal(await stage.settingsNavElement(page).isVisible(), true, `${entry}：确认出现时设置页还在`)
  await context.shoot?.(`leave-${entry}`)
  await discardDialog(page).getByRole('button', { name: '继续编辑', exact: true }).click()
  await discardDialog(page).waitFor({ state: 'detached' })
  assert.equal(await stage.settingsNav(page).isVisible(), true, `${entry}：继续编辑后不导航`)
  assert.equal(await stage.root(page).getByPlaceholder('如：DeepSeek 主力 / GPT-4o 备用').inputValue(), '还没保存的名字', `${entry}：继续编辑后输入还在`)
}

async function discardChanges(page) {
  await discardDialog(page).getByRole('button', { name: '放弃修改', exact: true }).click()
  await stage.settingsNav(page).waitFor({ state: 'detached' })
}

async function pickFromPalette(page, query, option) {
  await page.keyboard.press('Control+K')
  await stage.paletteInput(page).fill(query)
  await stage.palette(page).getByRole('option', { name: option }).first().click()
}

/**
 * 等打开作品整个做完：落到该写的那一章，并且收尾的资源载入也结束了。打开作品收尾时还会回到作品一次，
 * 没等它就回书房，晚到的这一下会再次离开书房。
 */
function bookOpened(page) {
  const loaded = page.waitForEvent('console', { predicate: message => message.text().includes('项目数据加载完成'), timeout: 30_000 })
  // 场景在等它之前抛错时没人接这个拒绝，未处理的拒绝会让 Node 直接退出、诊断 JSON 写不出来
  loaded.catch(() => {})
  return async () => {
    await loaded
    await page.getByRole('navigation', { name: '位置' }).getByText('第 4 章').waitFor({ state: 'visible' })
  }
}

/** 书房里当前作品的概览：「继续写作」回到作品。 */
async function continueBook(page) {
  await stage.overview(page, STAGE_SAMPLE.name).getByRole('button', { name: /^继续写作/ }).click()
  await stage.spine(page).waitFor({ state: 'visible' })
}

async function closeDialog(page, name) {
  const dialog = page.getByRole('dialog', { name })
  await dialog.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
}

export const STAGE_SCENARIOS = {
  'stage-open-sample': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await assertSpineMatchesSample(page)
    assert.equal(await stage.tabList(page).count(), 0, '只有一个标签时标签条收起')
    assert.deepEqual(await chromeContrastFailures(page), [], '外壳文字对比度不足')
  } },
  'stage-tabs': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.tabList(page).waitFor({ state: 'visible' })
    await stage.stageButton(page, '蓝图').click()
    await stage.tab(page, '蓝图').waitFor({ state: 'visible' })
    assert.equal(await stage.tabList(page).getByRole('tab').count(), 3)
    await stage.closeTabButton(page, '设定').click()
    await stage.tab(page, '设定').waitFor({ state: 'detached' })
    assert.equal(await stage.tabList(page).getByRole('tab').count(), 2, '关掉一个后还剩两个，标签条仍在')
  }, after: async ({ page }) => {
    await stage.closeTabButton(page, '蓝图').click()
    await stage.tabList(page).waitFor({ state: 'detached' })
  } },
  'stage-dirty-close': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.dirtySetup(page)
    await stage.closeTabButton(page, '设定').click()
    await page.getByRole('dialog', { name: '放弃未保存的修改？' }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await page.getByRole('dialog', { name: '放弃未保存的修改？' }).waitFor({ state: 'hidden' })
    assert.equal(await stage.tab(page, '设定').getAttribute('aria-selected'), 'true', '取消后标签仍在')
    assert.equal(await stage.setupOutline(page).inputValue(), `${STAGE_SAMPLE.core.coreOutline}还有一盏灯没有熄灭。`, '取消后修改保留')
  } },
  'stage-save': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.dirtySetup(page)
    await page.keyboard.press('Control+S')
    await stage.saveStatus(page).filter({ hasText: '已保存' }).waitFor({ state: 'visible' })
  } },
  'stage-find-chapter': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '蓝图').click()
    await stage.tab(page, '蓝图').waitFor({ state: 'visible' })
    await stage.stageButton(page, '设定').click()
    await stage.findChapter(page, '4')
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[4].text))
    assert.deepEqual((await stage.chapterRows(page)).filter(row => row.current).map(row => row.number), [4])
    await stage.findChapter(page, '第3章')
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[3].text))
    assert.deepEqual((await stage.chapterRows(page)).filter(row => row.current).map(row => row.number), [3])
  } },
  'stage-focus': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.focusToggle(page).click()
    await stage.spine(page).waitFor({ state: 'detached' })
    assert.equal(await stage.tabList(page).count(), 0)
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[3].text))
    await page.getByRole('button', { name: /^按 \d+ 项意见修稿$/ }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await stage.spine(page).waitFor({ state: 'visible' })
  } },
  'stage-1280': { model: false, shell: 'stage', setup: async context => {
    await context.page.setViewportSize({ width: 1280, height: 900 })
    await seedStageSample(context)
  }, run: async ({ page }) => {
    const overflow = await page.evaluate(() => {
      const scroller = document.scrollingElement
      const clipped = [...document.querySelectorAll('.stage-row-name, .stage-chapter-title, .stage-crumb, .stage-work-title, .stage-search-hint, .stage-saved')]
        .filter(node => node.scrollWidth > node.clientWidth + 1 || node.getClientRects().length > 1)
        .map(node => node.textContent)
      return { horizontal: scroller.scrollWidth - scroller.clientWidth, clipped }
    })
    assert.deepEqual(overflow, { horizontal: 0, clipped: [] })
  } },
  'stage-palette': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('灯')
    await stage.palette(page).getByRole('option', { name: /第二盏灯/ }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await stage.palette(page).waitFor({ state: 'hidden' })
  } },
  'stage-library': { model: false, shell: 'stage', run: async ({ page }) => {
    await page.getByRole('heading', { name: '书架还是空的' }).waitFor({ state: 'visible' })
    assert.equal(await stage.spine(page).count(), 0, '书房没有流程脊')
    assert.deepEqual(await stage.primaryButtons(page), ['新建作品'], '空书房唯一的主按钮是新建作品')
    await stage.modelMissingNotice(page).waitFor({ state: 'visible' })
    assert.deepEqual(await chromeContrastFailures(page), [], '空书房文字对比度不足')
  } },
  'stage-library-preview': { model: false, shell: 'stage', setup: context => seedStageSample(context, { open: false }), run: async ({ page }) => {
    await stage.previewBook(page, STAGE_SAMPLE.name)
    const bars = await stage.overviewBars(page, STAGE_SAMPLE.name)
    assert.deepEqual({ architecture: bars.architecture, blueprint: bars.blueprint, manuscript: bars.manuscript },
      { architecture: 'done', blueprint: 'done', manuscript: 'active' }, '预览的概览按阶段显示进度')
    assert.equal(await stage.spine(page).count(), 0, '预览不会打开作品')
    assert.deepEqual(await stage.primaryButtons(page), [`打开《${STAGE_SAMPLE.name}》`], '预览时唯一的主按钮是打开这部作品')
    assert.deepEqual(await chromeContrastFailures(page), [], '书房预览文字对比度不足')
  } },
  'stage-library-remove': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    assert.deepEqual(await chromeContrastFailures(page), [], '书房文字对比度不足')
    await stage.bookMenu(page, STAGE_SAMPLE.name, '从最近项目移除…')
    await page.getByRole('dialog', { name: `从书架移除《${STAGE_SAMPLE.name}》？` }).waitFor({ state: 'visible' })
  }, after: async ({ page, samplePath }) => {
    await page.getByRole('dialog', { name: `从书架移除《${STAGE_SAMPLE.name}》？` }).getByRole('button', { name: '移除记录', exact: true }).click()
    await stage.cover(page, STAGE_SAMPLE.name).waitFor({ state: 'detached' })
    assert.equal(fs.existsSync(samplePath), true, '移除书架记录后作品文件夹仍在')
  } },
  'stage-library-delete': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await stage.bookMenu(page, STAGE_SAMPLE.name, '删除作品…')
    const dialog = page.getByRole('dialog', { name: `删除《${STAGE_SAMPLE.name}》？` })
    await dialog.getByRole('textbox').fill('灯')
    assert.equal(await dialog.getByRole('button', { name: '删除作品', exact: true }).isDisabled(), true, '作品名不一致时删除按钮保持禁用')
  }, after: async ({ page, samplePath }) => {
    const dialog = page.getByRole('dialog', { name: `删除《${STAGE_SAMPLE.name}》？` })
    await dialog.getByRole('textbox').fill(STAGE_SAMPLE.name)
    assert.equal(await dialog.getByRole('button', { name: '删除作品', exact: true }).isEnabled(), true, '输入完整作品名后才能删除')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(fs.existsSync(samplePath), true, '取消删除后作品文件夹仍在')
  } },
  'stage-update-card': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stubUpdates(app)
    await stage.stageButton(page, '设定').click()
    await stage.dirtySetup(page)
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    const card = stage.updateCard(page)
    await card.getByRole('button', { name: '下载更新' }).click()
    await card.getByRole('button', { name: '立即重启更新' }).click()
    await page.getByRole('dialog', { name: '请先处理未保存的修改' }).getByRole('button', { name: '返回保存' }).waitFor({ state: 'visible' })
  }, after: async ({ app, page }) => {
    await page.getByRole('dialog', { name: '请先处理未保存的修改' }).getByRole('button', { name: '返回保存' }).click()
    assert.equal(await app.evaluate(() => globalThis.__driveUpdate.installs), 0, '有未保存修改时不会重启安装')
  } },
  'stage-setup-required': { model: false, shell: 'stage', run: async ({ app, page, roots }) => {
    await stubOpenDialog(app, roots.projects)
    await bookshelf.createProject(page, '雾岛')
    await stage.setupOutline(page).fill('一个收到匿名信的年轻人，在一座本该拆除的车站登上末班车。')
    await stage.setupField(page, '类型').selectOption('悬疑')
    assert.equal(await stage.setupNext(page).isDisabled(), true, '目标读者没选时下一步不可用')
    assert.equal(await stage.setupHint(page).innerText(), '选好目标读者就能继续')
    assert.equal(await stage.setupNext(page).getAttribute('aria-describedby'), await stage.setupHint(page).getAttribute('id'), '主按钮由提示说明缺什么')
    assert.deepEqual(await stage.primaryButtons(page), ['下一步：故事架构'], '设定页唯一的主按钮是下一步')
    assert.deepEqual(await stage.stageStates(page), { setup: 'active', architecture: 'todo', blueprint: 'todo', manuscript: 'todo' })
    assert.deepEqual(await chromeContrastFailures(page), [], '设定页文字对比度不足')
  }, after: async ({ page }) => {
    await stage.setupField(page, '目标读者').selectOption('全龄')
    await stage.setupHint(page).filter({ hasText: '设定已齐' }).waitFor({ state: 'visible' })
    await stage.setupNext(page).click()
    await page.getByRole('navigation', { name: '位置' }).getByText('架构', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await stage.saveStatus(page).innerText(), '已保存', '下一步先保存设定')
  } },
  'stage-setup-short': { model: false, shell: 'stage', run: async ({ app, page, roots }) => {
    await stubOpenDialog(app, roots.projects)
    await bookshelf.createProject(page, '雾岛')
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    assert.equal(await stage.missingSetupLabels(page).count(), 0, '新作品的必填项先不标红')
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1280, height: 720 }]) {
      await page.setViewportSize(size)
      const foot = await stage.setupFoot(page).boundingBox()
      for (const name of ['类型', '目标读者']) {
        const box = await stage.setupField(page, name).boundingBox()
        assert.ok(box.y + box.height <= foot.y, `${size.width}×${size.height} 首屏看得到「${name}」：底边 ${box.y + box.height}，底栏 ${foot.y}`)
      }
    }
  }, after: async ({ page }) => {
    await stage.setupChip(page, '全局写作要求').click()
    const panel = stage.setupPanel(page, '全局写作要求')
    await panel.waitFor({ state: 'visible' })
    const foot = await stage.setupFoot(page).boundingBox()
    const box = await panel.boundingBox()
    assert.ok(box.y + box.height <= foot.y + 1, `点开的面板滚进视野，不在底栏后面：底边 ${box.y + box.height}，底栏 ${foot.y}`)
    assert.equal(await panel.getByRole('textbox').evaluate(node => node === document.activeElement), true, '焦点落在面板的输入框里')
    await page.setViewportSize({ width: 1440, height: 900 })
  } },
  'stage-setup-fill': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.setupFill(page).click()
    const confirm = page.getByRole('dialog', { name: '扩写已有的设定？' })
    await confirm.getByRole('button', { name: '继续扩写', exact: true }).click()
    await stage.setupChip(page, '世界观').and(page.locator('[data-filled]')).waitFor({ state: 'visible', timeout: 20_000 })
    await stage.setupChip(page, '世界观').click()
    const world = stage.setupPanel(page, '世界观').getByRole('textbox')
    assert.equal(await world.inputValue(), FIXTURE_CONFIG.worldSetting, 'AI 补全写进了世界观')
    assert.ok((await stage.setupOutline(page).inputValue()).startsWith(STAGE_SAMPLE.core.coreOutline), 'AI 补全保留了作者写的核心大纲')
    await world.fill('旧港以潮汐计时。')
    await stage.saveStatus(page).filter({ hasText: '未保存' }).waitFor({ state: 'visible' })
    assert.deepEqual(await chromeContrastFailures(page), [], '设定页文字对比度不足')
  } },
  'stage-settings-groups': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.openSettings(page)
    assert.deepEqual(await stage.settingsGroups(page), [
      { group: '常用', pages: ['AI 模型', '检索模型', '外观'] },
      { group: '高级', pages: ['分工模型', '网络代理', '提示词模板', '写作 Skills'] },
      { group: '其他', pages: ['项目备份', '关于与更新'] },
    ], '设置按常用、高级、其他三组')
    assert.equal(await stage.currentSettingsPage(page), 'AI 模型', '从流程脊打开时落在 AI 模型')
    assert.deepEqual(await page.getByRole('navigation', { name: '位置' }).locator('span').allInnerTexts(), ['设置', 'AI 模型'])
    await stage.showSettingsPage(page, '外观')
    const zoom = page.getByRole('group', { name: '界面缩放' })
    await zoom.getByRole('button', { name: '放大' }).click()
    await zoom.getByText('105%').waitFor({ state: 'visible' })
    await zoom.getByRole('button', { name: '还原' }).click()
    await zoom.getByText('100%').waitFor({ state: 'visible' })
    assert.deepEqual(await stage.primaryButtons(page), [], '外观页没有主按钮')
    assert.deepEqual(await chromeContrastFailures(page), [], '设置页文字对比度不足')
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await stage.settingsNav(page).waitFor({ state: 'detached' })
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[3].text))
  } },
  'stage-settings-required': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await stage.openSettings(page)
    const mark = name => stage.settingsLink(page, name).locator('.stage-set-required').innerText()
    assert.deepEqual([await mark('AI 模型'), await mark('检索模型')], ['必需', '未配置'], '导航标出必需页，检索模型还没配默认')
    assert.equal(await stage.settingsLink(page, '检索模型').getAttribute('aria-description'), '未配置', '读屏能听到未配置')
    await shoot('settings-llm-required')
    await stage.showSettingsPage(page, '检索模型')
    await stage.root(page).getByText('检索模型是必需配置', { exact: true }).waitFor({ state: 'visible' })
    assert.deepEqual(await stage.primaryButtons(page), ['添加检索模型'], '没有检索模型时唯一的主按钮是添加')
    assert.equal(await stage.root(page).getByRole('button', { name: '去 SiliconFlow 免费注册' }).isVisible(), true, '去注册是一枚完整按钮')
    assert.deepEqual(await chromeContrastFailures(page), [], '检索模型页文字对比度不足')
    await shoot('settings-embedding-missing')
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await stage.settingsNav(page).waitFor({ state: 'detached' })
  } },
  'stage-settings-about': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '关于与更新')
    await stage.root(page).getByText('书童 Pagekin', { exact: true }).waitFor({ state: 'visible' })
    await stage.root(page).getByText('原名「AI小说作家」', { exact: true }).waitFor({ state: 'visible' })
    const marks = await page.evaluate(() => ['.stage-brand', '.stage-set-about-mark'].map(selector => {
      const mark = document.querySelector(selector)
      return mark ? getComputedStyle(mark, '::before').maskImage : 'missing'
    }))
    assert.ok(marks.every(image => image.includes('pagekin-mark')), `顶栏与关于页都用书页精灵标识：${marks.join(' | ')}`)
    assert.deepEqual(await chromeContrastFailures(page), [], '关于页文字对比度不足')
  } },
  'stage-settings-dark': { model: false, shell: 'stage', setup: seedStageSample, run: async context => {
    await stage.openSettings(context.page)
    await stage.showSettingsPage(context.page, '外观')
    await context.page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: /^深色/ }).click()
    await stage.root(context.page).and(context.page.locator('[data-theme="dark"]')).waitFor({ state: 'visible' })
    await context.restart()
    const { page } = context
    await stage.root(page).waitFor({ state: 'visible' })
    assert.equal(await stage.root(page).getAttribute('data-theme'), 'dark', '退出重启后仍是深色')
    await stage.openFromLibrary(page, STAGE_SAMPLE.name)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    assert.equal(await page.getByRole('radio', { name: /^深色/ }).getAttribute('aria-checked'), 'true')
    assert.deepEqual(await chromeContrastFailures(page), [], '深色设置页文字对比度不足')
  } },
  'stage-settings-model': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.openSettings(page)
    const models = page.getByRole('list', { name: 'AI 模型' })
    await models.getByText(FAKE_MODEL.name, { exact: true }).waitFor({ state: 'visible' })
    await models.getByRole('button', { name: `「${FAKE_MODEL.name}」更多操作` }).click()
    await page.getByRole('menuitem', { name: '删除模型…' }).click()
    await page.getByRole('dialog', { name: `删除「${FAKE_MODEL.name}」？` }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    await page.getByRole('dialog', { name: `删除「${FAKE_MODEL.name}」？` }).getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('list', { name: 'AI 模型' }).getByText(FAKE_MODEL.name, { exact: true }).waitFor({ state: 'visible' })
  } },
  'stage-first-model': { model: false, shell: 'stage', run: async ({ page }) => {
    await stage.modelMissingNotice(page).getByRole('button', { name: '添加模型' }).click()
    await stage.settingsNav(page).waitFor({ state: 'visible' })
    assert.equal(await stage.currentSettingsPage(page), 'AI 模型')
    await stage.root(page).getByRole('heading', { name: '还没有添加模型' }).waitFor({ state: 'visible' })
    assert.deepEqual(await stage.primaryButtons(page), ['添加模型'], '没有模型时设置页唯一的主按钮是添加模型')
    assert.deepEqual(await chromeContrastFailures(page), [], '首次使用的设置页文字对比度不足')
  } },
  'stage-lazy-retry': { model: false, shell: 'stage', setup: context => seedStageSample(context, { open: false }), run: async context => {
    await blockChunks(context.app, 'StageSetup-')
    await context.reload()
    const { page } = context
    await stage.openFromLibrary(page, STAGE_SAMPLE.name)
    await stage.stageButton(page, '设定').click()
    await stage.root(page).getByRole('heading', { name: '页面没有载入' }).waitFor({ state: 'visible' })
    await page.waitForTimeout(500)
    assert.equal(await stage.setupOutline(page).count(), 0, '拦下设定页代码时只显示失败态')
  }, after: async ({ app, page }) => {
    await app.evaluate(() => { globalThis.__driveChunkBlock.pattern = null })
    await stage.root(page).getByRole('button', { name: '重试', exact: true }).click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    const requests = await app.evaluate(() => globalThis.__driveChunkBlock.log)
    assert.ok(requests.some(entry => entry.startsWith('allow StageSetup-') && entry.includes('.js?retry=')), `重试重新读取了设定页代码：${requests.join(' | ')}`)
  } },
  'stage-setup-save-fail': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.dirtySetup(page)
    await failProjectSaves(app, true)
    const failed = stage.setupFoot(page).getByRole('alert')
    await page.keyboard.press('Control+S')
    await failed.filter({ hasText: SETUP_SAVE_FAILED }).waitFor({ state: 'visible' })
    await stage.setupOutline(page).focus()
    await stage.setupNext(page).click()
    await failed.filter({ hasText: SETUP_SAVE_FAILED }).waitFor({ state: 'visible' })
    assert.deepEqual(await page.getByRole('navigation', { name: '位置' }).locator('span').allInnerTexts(), ['设定'], '保存失败时下一步不离开设定页')
    assert.equal(await stage.saveStatus(page).innerText(), '未保存')
  }, after: async ({ app, page }) => {
    await failProjectSaves(app, false)
    await stage.setupFoot(page).getByRole('button', { name: /^保存/ }).click()
    await stage.saveStatus(page).filter({ hasText: '已保存' }).waitFor({ state: 'visible' })
    assert.equal(await stage.setupFoot(page).getByRole('alert').count(), 0, '再保存成功后失败说明消失')
  } },
  /**
   * 主进程的错误码在显示处按界面语言说明（#474）。先试把打开着的作品文件夹改名（真实触发，结果记进 measured.rename）；
   * 改不动时让 kb:clear-all 返回会话失效码（与作品切换后守卫拒绝的返回同形）。中文、英文各从知识库清空一次并截图：
   * 提示是登记的说明，不出现裸错误码。
   */
  'stage-error-code-display': { model: false, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke, path, session }) => {
    const imported = await invoke(page, 'kb:import-planning-text', '灯塔建于旧港北岸，守塔人每晚记录潮汐。', '灯塔资料.txt', path, session)
    assert.equal(imported.success, true, imported.error)
  } }), run: async context => {
    const { app, page, invoke, reload, shoot } = context
    const measured = {}
    // 新建作品：选好上级文件夹后它被换成同名的新文件夹，主进程按授权目标已变化拒绝（#478 CodeRabbit 提的路径）。
    const parent = path.join(context.roots.projects, 'replaced-parent')
    fs.mkdirSync(parent)
    const grant = await chooseProjectDirectoryGrant(app, page, parent)
    fs.renameSync(parent, `${parent}-old`)
    fs.mkdirSync(parent)
    const created = await invoke(page, 'project:create', { parentGrantId: grant.grantId, name: '雾岛', genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    measured.createAfterParentReplaced = created.success ? 'created' : created.error
    assert.equal(measured.createAfterParentReplaced, 'Error: EXTERNAL_FILE_GRANT_TARGET_CHANGED', '主进程按授权目标已变化拒绝新建')
    // 只记录真实触发能否成立；改得动也立刻改回，下面一律用替换的返回，画面每次相同。
    try {
      fs.renameSync(context.samplePath, `${context.samplePath}-moved`)
      fs.renameSync(`${context.samplePath}-moved`, context.samplePath)
      measured.rename = 'moved'
    } catch (error) {
      measured.rename = error.code ?? String(error)
    }
    await app.evaluate(({ ipcMain }) => {
      ipcMain._invokeHandlers.set('kb:clear-all', async () => ({ success: false, error: 'PROJECT_SESSION_STALE' }))
    })
    const openKnowledge = async name => {
      await page.keyboard.press('Control+K')
      const input = page.getByRole('dialog').getByRole('combobox')
      await input.waitFor({ state: 'visible' })
      await page.keyboard.type(name)
      await page.keyboard.press('Enter')
      await input.waitFor({ state: 'hidden' })
    }
    for (const [locale, knowledge, open, confirm, expected] of [
      ['zh-CN', '知识库', '清空知识库…', '清空知识库', '项目已切换或重新打开'],
      ['en-US', 'Knowledge base', 'Clear knowledge base…', 'Clear knowledge base', 'The project was switched or reopened'],
    ]) {
      if (locale === 'en-US') {
        assert.equal((await invoke(page, 'config:set', { locale })).success, true)
        await reload()
        await page.getByRole('list', { name: 'Recent books' }).waitFor({ state: 'visible' })
        await stage.openFromLibraryEn(page, STAGE_SAMPLE.name)
        await page.getByRole('navigation', { name: 'Writing flow' }).waitFor({ state: 'visible' })
      }
      await openKnowledge(knowledge)
      await page.getByRole('button', { name: open, exact: true }).click()
      await page.getByRole('button', { name: confirm, exact: true }).click()
      const toast = page.locator('.pi-toast').last()
      await toast.waitFor({ state: 'visible' })
      measured[locale] = (await toast.innerText()).trim()
      await shoot(`stage-error-code-display-${locale === 'zh-CN' ? 'zh' : 'en'}`)
      assert.doesNotMatch(measured[locale], /PROJECT_SESSION_STALE|Error invoking remote method/u, `${locale} 提示里是裸错误码：${measured[locale]}`)
      assert.ok(measured[locale].includes(expected), `${locale} 提示不是登记的说明：${measured[locale]}`)
    }
    return measured
  } },
  'stage-settings-legacy': { model: false, shell: 'stage', setup: seedStageSample, run: async context => {
    const { page } = context
    await stage.openSettings(page)
    await page.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」` }).click()
    const heights = selector => stage.legacySettings(page).locator(selector).evaluateAll(nodes => nodes
      .filter(node => node.getClientRects().length > 0).map(node => Math.round(node.getBoundingClientRect().height)))
    assert.deepEqual([...new Set(await heights('input:not([type="checkbox"]):not([type="radio"]):not([type="range"])'))], [40], '模型编辑的输入框与新页一样 40px 高')
    await context.shoot('stage-settings-legacy-model')
    await stage.root(page).getByRole('button', { name: '取消', exact: true }).click()
    for (const [name, slug] of [['提示词模板', 'prompts'], ['写作 Skills', 'skills']]) {
      await stage.showSettingsPage(page, name)
      await context.shoot(`stage-settings-legacy-${slug}`)
    }
    await stage.showSettingsPage(page, '项目备份')
    await stage.root(page).getByText('WebDAV', { exact: true }).waitFor({ state: 'visible' })
    // RD-V 起新外壳里的旧按钮变体换成纸墨按钮，旧 default 成了 pi-btn--primary
    const solid = await stage.legacySettings(page).locator(stage.PRIMARY_BUTTON).evaluateAll(buttons => buttons.map(button => button.textContent.trim()))
    assert.deepEqual(solid, ['导出本地存档'], '项目备份页只有一个实心主按钮')
  } },
  'stage-settings-leave': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.openSettings(page)
    await page.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」` }).click()
    const name = stage.root(page).getByPlaceholder('如：DeepSeek 主力 / GPT-4o 备用')
    await name.fill('主力模型')
    await page.keyboard.press('Escape')
    assert.equal(await stage.settingsNav(page).isVisible(), true, '输入框里的 Esc 不关闭设置页')
    await stage.root(page).getByRole('heading', { level: 1, name: 'AI 模型' }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '放弃未保存的修改？' }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
    await discard.getByRole('button', { name: '继续编辑', exact: true }).click()
    await discard.waitFor({ state: 'detached' })
    assert.equal(await stage.root(page).getByPlaceholder('如：DeepSeek 主力 / GPT-4o 备用').inputValue(), '主力模型', '继续编辑时修改还在')
    await stage.settingsNav(page).getByRole('button', { name: '返回作品' }).click()
    await discard.getByRole('button', { name: '放弃修改', exact: true }).click()
    await stage.settingsNav(page).waitFor({ state: 'detached' })
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[3].text))

    await stage.openSettings(page)
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).click()
    await stage.settingsNav(page).waitFor({ state: 'detached' })
    await stage.tab(page, '角色').and(page.locator('[aria-selected="true"]')).waitFor({ state: 'visible' })
  } },
  'stage-settings-leave-work': { model: false, shell: 'stage', setup: seedStageSample, run: async context => {
    const { page } = context
    await stage.stageButton(page, '蓝图').click()
    await stage.tab(page, '蓝图').waitFor({ state: 'visible' })
    const crumbs = () => page.getByRole('navigation', { name: '位置' }).locator('span').allInnerTexts()
    const entries = [
      ['流程脊阶段', () => stage.stageButton(page, '架构').click(), async () => assert.deepEqual(await crumbs(), ['架构'])],
      ['流程脊资料', () => stage.stageButton(page, '剧情与伏笔').click(), async () => assert.deepEqual(await crumbs(), ['作品资料', '剧情与伏笔'])],
      ['命令面板阶段', () => pickFromPalette(page, '蓝图', /^蓝图/), async () => assert.deepEqual(await crumbs(), ['蓝图'])],
      ['Ctrl P 章节', () => stage.findChapter(page, '旧港'), () => stage.waitForProse(page, firstLine(STAGE_SAMPLE.finalized[1]))],
      ['命令面板回到书房', () => pickFromPalette(page, '回到书房', /^回到书房/), () => stage.shelf(page).waitFor({ state: 'visible' })],
    ]
    for (const [name, go, arrived] of entries) {
      if (await stage.shelf(page).count()) await continueBook(page)
      await dirtyModelName(page)
      assert.equal(await stage.tabList(page).count(), 0, `${name}：设置页开着时没有标签条可切换`)
      await go()
      await keepEditing(page, name, context)
      await go()
      await discardChanges(page)
      await arrived()
    }
    await continueBook(page)
    await dirtyModelName(page)
    await stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '回到书房')
    await keepEditing(page, '作品菜单回到书房', context)
    await stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '回到书房')
    await discardChanges(page)
    await stage.shelf(page).waitFor({ state: 'visible' })
  } },
  'stage-settings-leave-library': { model: false, shell: 'stage', setup: context => seedStageSample(context, { open: false }), run: async context => {
    const { app, page } = context
    const entries = [
      ['命令面板打开作品', () => pickFromPalette(page, STAGE_SAMPLE.name, new RegExp(`打开《${STAGE_SAMPLE.name}》`)), null],
      ['Ctrl O 打开作品', async () => {
        await stubOpenDialog(app, context.samplePath)
        await page.keyboard.press('Control+O')
      }, null],
      ['命令面板打开文件夹', async () => {
        await stubOpenDialog(app, context.samplePath)
        await pickFromPalette(page, '打开作品', /^打开作品$/)
      }, null],
      ['Ctrl N 新建作品', () => page.keyboard.press('Control+N'), () => closeDialog(page, '新建作品')],
      ['命令面板新建作品', () => pickFromPalette(page, '新建作品', /^新建作品$/), () => closeDialog(page, '新建作品')],
      ['命令面板拆解与仿写', () => pickFromPalette(page, '小说拆解与仿写', /^小说拆解与仿写$/), () => closeDialog(page, /小说拆解/)],
    ]
    // arrived 为空的几项会打开作品，等打开整个做完再进下一项。
    for (const [name, go, arrived] of entries) {
      if (await stage.spine(page).count()) await stage.backToLibrary(page, STAGE_SAMPLE.name)
      await dirtyModelName(page)
      await go()
      await keepEditing(page, name, context)
      const opened = arrived ? null : bookOpened(page)
      await go()
      await discardChanges(page)
      await (arrived ?? opened)()
      await context.shoot(`arrived-${name}`)
    }
  } },
  'stage-run': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    fake.gate.hold()
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await page.getByRole('heading', { name: '运行', exact: true }).waitFor({ state: 'visible' })
    await stage.root(page).getByRole('button', { expanded: true }).filter({ hasText: '%' }).waitFor({ state: 'visible' })
  }, after: async ({ page, fake }) => {
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await stage.palette(page).waitFor({ state: 'hidden' })
    fake.gate.release()
    await runSheet.waitForRunDone(page)
    await stage.waitForProse(page, firstLine(FIXTURE_PROSE))
  } },
  /**
   * RD-10 之前的外观配置只在旧键里：去掉 v3 键、写入旧键后重载，按旧主题迁成深色或浅色，不阻塞启动，旧键逐字节不变（供回滚）。
   * galaxy 与 paper 各走一遍，外壳偏好写成旧外壳也照样进纸墨外壳。
   */
  'stage-migrate': { model: false, run: async ({ page, reload }) => {
    const previousKey = 'ai-novel-writer-appearance'
    const v3Key = 'ai-novel-writer-appearance-v3'
    const observed = []
    for (const [schemaVersion, colorTheme, shellPreference, expected] of [[1, 'galaxy', 'writer', 'dark'], [2, 'paper', 'classic', 'light']]) {
      const previous = JSON.stringify({ schemaVersion, revision: 7, shellPreference, colorTheme, zoom: 1.1,
        writingFont: 'noto-serif-sc', uiFont: 'inter', origin: 'author', legacyImportCompleted: true, legacyFontDefaultsVersion: 1 })
      await page.evaluate(([v3, key, raw]) => { localStorage.removeItem(v3); localStorage.setItem(key, raw) }, [v3Key, previousKey, previous])
      await reload()
      await stage.root(page).waitFor({ state: 'visible' })
      const stored = await page.evaluate(([v3, key]) => ({ v3: JSON.parse(localStorage.getItem(v3) ?? 'null'), previous: localStorage.getItem(key) }), [v3Key, previousKey])
      observed.push({
        from: colorTheme,
        theme: await stage.root(page).getAttribute('data-theme'),
        dark: await page.evaluate(() => document.documentElement.classList.contains('dark')),
        v3: { schemaVersion: stored.v3?.schemaVersion, colorTheme: stored.v3?.colorTheme, zoom: stored.v3?.zoom },
        previousUnchanged: stored.previous === previous,
        blocked: await page.getByRole('heading', { name: '启动尚未完成' }).count() > 0,
      })
      assert.equal(observed.at(-1).theme, expected)
    }
    assert.deepEqual(observed, [
      { from: 'galaxy', theme: 'dark', dark: true, v3: { schemaVersion: 3, colorTheme: 'dark', zoom: 1.1 }, previousUnchanged: true, blocked: false },
      { from: 'paper', theme: 'light', dark: false, v3: { schemaVersion: 3, colorTheme: 'light', zoom: 1.1 }, previousUnchanged: true, blocked: false },
    ], '旧主题迁成纸墨的深色或浅色，旧键原样保留')
  } },
  'stage-modal-layers': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.dirtySetup(page)
    await stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '导出…')
    const exportDialog = page.getByRole('dialog', { name: '导出项目' })
    await exportDialog.waitFor({ state: 'visible' })
    const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' })
    const observed = {}
    await page.keyboard.press('Control+K')
    await page.waitForTimeout(300)
    observed.paletteUnderDialog = await stage.palette(page).count() > 0
    if (observed.paletteUnderDialog) await page.keyboard.press('Escape')
    await page.keyboard.press('Control+W')
    await page.waitForTimeout(300)
    observed.discardUnderDialog = await discard.count() > 0
    if (observed.discardUnderDialog) await page.keyboard.press('Escape')
    await shell.requestWindowClose(app)
    const exit = stage.exitDialog(page)
    await exit.waitFor({ state: 'visible' })
    observed.exitOnTop = await stage.isTopmost(exit)
    assert.deepEqual(observed, { paletteUnderDialog: false, discardUnderDialog: false, exitOnTop: true },
      '旧对话框开着时 Ctrl K、Ctrl W 不在它下面开层，关窗时退出确认盖在它之上')
  }, after: async ({ page }) => {
    await stage.exitDialog(page).getByText('取消', { exact: true }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '导出项目' }).waitFor({ state: 'hidden' })
  } },
  /**
   * 应用菜单里有 CommandOrControl+W 的「关闭」，页面没拦下的 Ctrl W 会关窗。驱动注入的按键到不了菜单快捷键，
   * 所以这里断言页面把 Ctrl W 拦下了（defaultPrevented），并确认应用仍在。
   */
  'stage-close-key': { model: false, shell: 'stage', run: async ({ app, page }) => {
    await shell.firstInteractiveControl(page).waitFor({ state: 'visible' })
    await page.evaluate(() => {
      window.__driveCloseKey = []
      window.addEventListener('keydown', event => { if (event.code === 'KeyW') window.__driveCloseKey.push(event.defaultPrevented) })
    })
    const pressCloseKey = async () => {
      await page.keyboard.press('Control+W')
      return page.evaluate(() => window.__driveCloseKey.at(-1))
    }
    const observed = { library: await pressCloseKey() }
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).waitFor({ state: 'visible' })
    observed.palette = await pressCloseKey()
    observed.alive = !page.isClosed() && app.windows().length > 0
    assert.deepEqual(observed, { library: true, palette: true, alive: true }, 'Ctrl W 在书房与对话框里都由页面拦下，不落到菜单的「关闭」')
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await stage.palette(page).waitFor({ state: 'hidden' })
  } },
  'stage-reopen': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await stage.openFromPalette(page, STAGE_SAMPLE.name)
    await stage.prose(page).getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    assert.deepEqual(await stage.landing(page), { crumbs: ['正文', '第 4 章'], empty: false }, '重开同一部作品再次落到最后一章在写的第 4 章')
  } },
  'stage-partial-blueprint': { model: false, shell: 'stage',
    setup: context => seedStageSample(context, { totalChapters: 100, landOnChapter3: false }),
    run: async ({ page }) => {
      await stage.prose(page).getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      assert.deepEqual({ ...(await stage.landing(page)), blueprint: (await stage.stageStates(page)).blueprint },
        { crumbs: ['正文', '第 4 章'], empty: false, blueprint: 'done' }, '规划 100 章只写了 12 章蓝图时，蓝图已完成，落点仍是正文第 4 章')
    } },
  /** 第 1 章回到了草稿，但最后一章在写的仍是第 4 章，所以打开作品落在第 4 章；从章节列表点第 1 章打开的是这份新草稿。 */
  'stage-revert-after-final': { model: false, shell: 'stage',
    setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
      const version = await invoke(page, 'db:draft-next-version', 1, path, session)
      const created = await invoke(page, 'db:draft-create', { chapterNumber: 1, version, source: 'rewrite',
        content: STAGE_SAMPLE.reverted, wordCount: countUnits(STAGE_SAMPLE.reverted) }, path, session)
      assert.equal(created.success, true, created.error)
    } }),
    run: async ({ page }) => {
      await stage.prose(page).getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      assert.deepEqual(await stage.landing(page), { crumbs: ['正文', '第 4 章'], empty: false }, '第 1 章回到草稿后，落点仍是最后一章在写的第 4 章')
      await stage.chapterList(page).waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      await stage.chapterButton(page, 1).click()
      const reverted = stage.prose(page).getByText(firstLine(STAGE_SAMPLE.reverted)).first()
      await reverted.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      const row = (await stage.chapterRows(page)).find(candidate => candidate.number === 1)
      assert.deepEqual({ phase: row.phase, opened: await reverted.isVisible() }, { phase: 'draft', opened: true },
        '定稿后回退出的新草稿按草稿显示，打开的是这份草稿')
    } },
  'stage-new-project': { model: false, shell: 'stage', run: async ({ app, page, roots }) => {
    await stubOpenDialog(app, roots.projects)
    await bookshelf.createProject(page, '雾岛')
    await stage.stageButton(page, '正文').waitFor({ state: 'visible' })
    assert.deepEqual(await stage.stageStates(page), { setup: 'active', architecture: 'todo', blueprint: 'todo', manuscript: 'todo' })
    assert.deepEqual(await chromeContrastFailures(page), [], '新作品首屏外壳文字对比度不足')
    assert.deepEqual(await stage.spineLayout(page), { ringRadius: '8.5', setupMetaBelowName: true, resourceIconsFollowRow: true })
  } },
  'stage-focus-search': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.focusToggle(page).click()
    await stage.spine(page).waitFor({ state: 'detached' })
    await stage.prose(page).click()
    await page.keyboard.press('Control+F')
    await stage.proseSearch(page).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert.deepEqual({ searchOpen: await stage.proseSearch(page).count() > 0, focus: await stage.spine(page).count() === 0 },
      { searchOpen: false, focus: true }, '沉浸写作里 Esc 先关正文搜索框，不退出沉浸')
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await stage.spine(page).waitFor({ state: 'visible' })
  } },
  /** RD-5 评审导览：空书房、新建作品进入设定页、补齐必填、设置三组与深色、回书房看书架与删除确认。配 --video 录评审视频。 */
  'stage-rd5-tour': { model: false, shell: 'stage', run: async ({ app, page, roots }) => {
    const pause = ms => page.waitForTimeout(ms)
    await stubOpenDialog(app, roots.projects)
    await pause(2500)
    await page.getByRole('button', { name: '新建作品', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建作品' })
    await dialog.getByRole('textbox').first().pressSequentially('雾岛', { delay: 180 })
    await dialog.getByRole('button', { name: '选择', exact: true }).click()
    await pause(700)
    await dialog.getByRole('button', { name: '创建作品', exact: true }).click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    await pause(1800)
    await stage.setupOutline(page).pressSequentially('一个收到匿名信的年轻人，在一座本该拆除的车站登上末班车。', { delay: 45 })
    await pause(600)
    await stage.setupField(page, '类型').selectOption('悬疑')
    await pause(1800)
    await stage.setupField(page, '目标读者').selectOption('全龄')
    await pause(1500)
    await stage.setupChip(page, '文风').click()
    await pause(1500)
    await stage.setupChip(page, '文风').click()
    await pause(600)
    await stage.setupNext(page).click()
    await page.getByRole('navigation', { name: '位置' }).getByText('架构', { exact: true }).waitFor({ state: 'visible' })
    await pause(1500)
    await stage.openSettings(page)
    await pause(1800)
    await stage.showSettingsPage(page, '外观')
    await pause(1200)
    await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: /^深色/ }).click()
    await pause(2000)
    await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: /^浅色/ }).click()
    await pause(1200)
    await stage.showSettingsPage(page, '关于与更新')
    await pause(1500)
    await stage.closeSettings(page)
    await pause(800)
    await stage.backToLibrary(page, '雾岛')
    await pause(2500)
    await stage.bookMenu(page, '雾岛', '删除作品…')
    const confirm = page.getByRole('dialog', { name: '删除《雾岛》？' })
    await confirm.getByRole('textbox').pressSequentially('雾', { delay: 200 })
    await pause(1800)
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await pause(1500)
  } },
  'stage-tour': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    const pause = ms => page.waitForTimeout(ms)
    await pause(1500)
    for (const name of ['设定', '架构', '蓝图']) {
      await stage.stageButton(page, name).click()
      await pause(1500)
    }
    await stage.stageButton(page, '正文').click()
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[4].text))
    await pause(1500)
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).waitFor({ state: 'visible' })
    await pause(700)
    await stage.paletteInput(page).pressSequentially('雾钟', { delay: 220 })
    await pause(900)
    await page.keyboard.press('Enter')
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[3].text))
    await pause(1500)
    await page.keyboard.press('Control+P')
    await stage.paletteInput(page).waitFor({ state: 'visible' })
    await pause(500)
    await stage.paletteInput(page).pressSequentially('1', { delay: 200 })
    await pause(700)
    await page.keyboard.press('Enter')
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.finalized[1]))
    await pause(1500)
    await stage.closeTabButton(page, `第 1 章 · ${stageChapterTitle(1)}`).click()
    await pause(1000)
    await stage.focusToggle(page).click()
    await pause(2500)
    await page.keyboard.press('Escape')
    await pause(1200)
    fake.gate.hold()
    await blueprint.open(page)
    await pause(1200)
    await blueprint.writeNext(page)
    await page.getByRole('heading', { name: '运行', exact: true }).waitFor({ state: 'visible' })
    await pause(3000)
    fake.gate.release()
    await runSheet.waitForRunDone(page)
    await pause(2000)
  } },
  'chapter-switch': { model: false, setup: seedStageSample, run: async ({ page }) => {
    const target = firstLine(STAGE_SAMPLE.drafts[4].text)
    if (await stage.root(page).count() > 0) {
      return { chapterSwitchMs: await msFromClickToProse(page, stage.chapterButton(page, 4), '.stage-content .cm-content', target) }
    }
    return { chapterSwitchMs: await msFromClickToProse(page, project.draftOfChapter(page, 4), chapter.EDITOR, target) }
  } },
}

/** new-project 与示例作品都建「灯塔」，同一项目目录里不能共存，所以分两个会话。 */
export const BASELINE_SESSIONS = {
  shelf: ['settings', 'new-project'],
  sample: ['open-sample', 'write-chapter', 'run-panel', 'review', 'revise-merge', 'finalize'],
}
