// RD-9 作品资料页（剧情与伏笔、知识库、版本历史）的实机场景：对应计划 RD-9 的 live lane 1～10、perf 的 refs-timing 与评审视频。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as shell from './pages/shell.mjs'
import * as stage from './pages/stage.mjs'
import { chromeContrastFailures, msFromClickToProse, seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'
import { FAKE_MODEL, FIXTURE_ENDPOINT_MODELS } from './fake-model.mjs'

async function openFixtureModelSuggestions({ page, fake }, locale) {
  await stage.openSettings(page)
  const english = locale === 'en-US'
  if (english) {
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI models', exact: true }).click()
  }
  await page.getByRole('button', { name: english ? `Edit “${FAKE_MODEL.name}”` : `编辑「${FAKE_MODEL.name}」`, exact: true }).click()
  await page.getByRole('button', { name: english ? 'Show model suggestions' : '展开候选模型', exact: true }).click()
  const status = page.getByText(english ? /^Fetched \d+ models from the endpoint\.$/u : /^已从端点获取 \d+ 个模型。$/u)
  await status.waitFor({ state: 'visible', timeout: 15_000 })
  const listbox = page.getByRole('listbox', { name: english ? 'Model suggestions' : '候选模型' })
  await listbox.evaluate(element => element.scrollIntoView({ block: 'center' }))
  await page.mouse.move(0, 0)
  const options = listbox.getByRole('option')
  return { options: await options.allInnerTexts(), status: await status.innerText(), requests: fake.requests.filter(kind => kind === 'models').length }
}

async function openNewModelForm(page) {
  await stage.openSettings(page)
  await stage.root(page).getByRole('button', { name: '添加模型', exact: true }).first().click()
}

const THREAD = Object.freeze({ title: '雾钟为何提前', type: '主线', targetStartChapter: 1, targetEndChapter: 6, authorIntent: '钟声提前一刻与三十年前的沉船有关。' })
const SECOND_DRAFT = `${STAGE_SAMPLE.drafts[3].text}\n\n林岚把纸条又读了一遍，决定等到下一次大潮再上灯室。`
const IMPLEMENTATION_TERMS = /LanceDB|FTS|BM25|Embedding|向量|query|MCP|token/i
export const MATERIALS = Object.freeze({
  '守塔人小传.txt': '守塔人姓周，在灯塔守了三十年，记得每一次雾钟提前的夜晚。',
  '沉船名录.txt': '三十年前北堤外沉没的货船名叫启明号，船上的测绘员姓林。',
})

/**
 * 资料页的文字与它实际落在的底色之间的对比度：标题与正文 4.5:1，说明 3:1。
 * 选中行的底色更深，选中章的序号与选中稿的说明是小字，按 4.5:1 查；对比里删去的字与正文同字号，也按 4.5:1。
 */
const REFS_CONTRAST = [
  ['.stage-plot-title', 4.5], ['.stage-plot-note', 4.5], ['.stage-plot-lane b', 4.5], ['.stage-plot-event[data-state="occurred"]', 4.5],
  ['.stage-plot-event[data-state="planned"]', 4.5], ['.stage-plot-chapter', 4.5], ['.stage-plot-help', 4.5], ['.stage-plot-stamp', 4.5],
  ['.stage-kb-title', 4.5], ['.stage-kb-doc', 4.5], ['.stage-kb-help', 4.5], ['.stage-kb-result p', 4.5], ['.stage-kb-result-source', 4.5],
  ['.stage-hist-title', 4.5], ['.stage-hist-name', 4.5], ['.stage-hist-chapter small', 4.5], ['.stage-hist-version-name', 4.5],
  ['.stage-hist-meta', 4.5], ['.stage-hist-page span', 4.5], ['.stage-hist-page ins', 4.5], ['.stage-hist-page del', 4.5],
  ['.stage-hist-chapter[aria-current="true"] .stage-hist-no', 4.5], ['.stage-hist-chapter[aria-current="true"] small', 4.5],
  ['.stage-hist-version[aria-pressed="true"] .stage-hist-meta', 4.5],
]

/** 示例作品加一条伏笔线索与第 3 章的第二稿（v1 已审稿，v2 是新草稿）。 */
const seedRefs = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
  const plan = await invoke(page, 'db:narrative-thread-plan-create', THREAD, projectPath, session)
  assert.equal(plan.success, true, plan.error)
  const draft = await invoke(page, 'db:draft-create', { chapterNumber: 3, version: 2, source: 'write', content: SECOND_DRAFT,
    wordCount: countUnits(SECOND_DRAFT) }, projectPath, session)
  assert.equal(draft.success, true, draft.error)
} })

/** 系统打开对话框直接返回这些文件，不弹窗。 */
async function stubOpenFiles(app, files) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected })
  }, files)
}

/** 记下界面发给主进程的最近一次带项目会话的调用参数，驱动用同一会话读数据库，不必重开作品。 */
async function watchSession(app) {
  await app.evaluate(({ ipcMain }) => {
    for (const [channel, handler] of ipcMain._invokeHandlers) {
      ipcMain._invokeHandlers.set(channel, (event, ...args) => {
        const session = args.at(-1)
        if (session && typeof session === 'object' && 'leaseId' in session) globalThis.__driveSession = session
        return handler(event, ...args)
      })
    }
  })
}

const lastSession = app => app.evaluate(() => globalThis.__driveSession ?? null)

/** 整个窗口里的可见文字，加上可访问名称、提示与占位。 */
function everyWord(page) {
  return page.evaluate(() => [document.body.innerText, ...[...document.querySelectorAll('[aria-label], [title], [placeholder]')]
    .map(node => `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''} ${node.getAttribute('placeholder') ?? ''}`)].join('\n'))
}

export async function importMaterials({ app, page, roots }) {
  const files = Object.entries(MATERIALS).map(([name, content]) => {
    const file = path.join(roots.temp, name)
    fs.writeFileSync(file, content)
    return file
  })
  await stubOpenFiles(app, files)
  await refs.open(page, 'knowledge')
  await refs.materials(page).getByRole('button', { name: '导入创作资料' }).click()
  await refs.dialog(page).getByRole('button', { name: '取消', exact: true }).click()
  for (const name of Object.keys(MATERIALS)) await refs.materialButton(page, name.replace(/\.txt$/, '')).waitFor({ state: 'visible', timeout: 30_000 })
}

async function openChapterThreeVersions(page) {
  await refs.open(page, 'history')
  await refs.historyChapters(page).getByRole('button', { name: /雾钟/ }).click()
  await refs.versionButton(page, '草稿 v2').waitFor({ state: 'visible' })
}

async function assertComparisonReadOnly(page) {
  await refs.versionButton(page, '草稿 v1').click()
  await refs.diffPage(page).waitFor({ state: 'visible' })
  assert.equal(await refs.diffPage(page).getAttribute('aria-readonly'), 'true')
  assert.equal(await refs.comparison(page).locator('textarea, input, [contenteditable="true"], .cm-editor').count(), 0, '对比里没有可编辑的地方')
  assert.ok(await refs.diffPage(page).locator('ins').count() > 0, '对比标出了新增')
  assert.equal(await page.getByText('完成合并').count(), 0, '不再打开修稿合并')
}

/**
 * perf 的 refs-timing 用：100 章、每章 5 稿，再用夹具模型整理出剧情树（剧情树只能经生成保存）。
 * 两种外壳都停在剧情树页上，计时从别的资料页点回来开始。
 */
async function seedHundred(context) {
  await seedHundredChapters(context)
  const { page, fake } = context
  fake.replyPlotTree()
  if (await stage.root(page).count() > 0) {
    await refs.open(page, 'plot')
    await refs.buildPlotTree(page)
  } else {
    await shell.clickRail(page, '剧情')
    await page.getByRole('button', { name: '生成剧情树' }).click()
  }
  await page.getByRole('button', { name: '刷新剧情树' }).waitFor({ state: 'visible', timeout: 60_000 })
}

const seedHundredChapters = context => seedStageSample(context, { totalChapters: 100, blueprintCount: 100, landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
  for (let chapterNumber = STAGE_SAMPLE.titles.length + 1; chapterNumber <= 100; chapterNumber++) {
    const upserted = await invoke(page, 'db:blueprint-upsert', { chapterNumber, title: `潮汐第${chapterNumber}夜`, role: '发展', purpose: '推进灯塔与沉船的线索',
      keyEvents: '林岚在灯塔里找到新的线索', characters: [] }, projectPath, session)
    assert.equal(upserted.success, true, upserted.error)
  }
  for (let chapterNumber = 1; chapterNumber <= 100; chapterNumber++) {
    const existing = (await invoke(page, 'db:draft-list', chapterNumber, projectPath, session)).length
    const content = STAGE_SAMPLE.drafts[chapterNumber]?.text ?? STAGE_SAMPLE.drafts[4].text
    for (let version = existing + 1; version <= 5; version++) {
      const created = await invoke(page, 'db:draft-create', { chapterNumber, version, source: 'write', content, wordCount: countUnits(content) }, projectPath, session)
      assert.equal(created.success, true, created.error)
    }
  }
} })

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 元素里的文字排成了几行；标签与标题在窄宽度下不该逐字折行。 */
function lineCount(locator) {
  return locator.evaluate(node => {
    const range = document.createRange()
    range.selectNodeContents(node)
    return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size
  })
}

/**
 * 运行侧页开着时资料页的布局（计划 RD-9 的窄内容宽度）：1440 宽时内容区约 770px，1280 宽时约 620px。
 * 导入资料会让侧页自动展开；之后确认侧页仍开着，再看各页有没有被挤坏。
 */
const narrowSetup = width => async context => {
  await context.page.setViewportSize({ width, height: 900 })
  await seedRefs(context)
  await importMaterials(context)
  await runSheet.openFromPalette(context.page)
}

const NARROW = Object.fromEntries([1280, 1440].flatMap(width => [
  [`refs-narrow-plot-${width}`, { model: true, shell: 'stage', setup: narrowSetup(width), run: async ({ page, fake }) => {
    fake.replyPlotTree()
    await refs.open(page, 'plot')
    await refs.buildPlotTree(page)
    const tops = await page.locator('.stage-plot-actions').evaluate(group => [...group.children].map(child => Math.round(child.getBoundingClientRect().top + child.getBoundingClientRect().height / 2)))
    assert.equal(new Set(tops).size, 1, `模型、生成与「更多」在同一行：${tops}`)
    await refs.plotView(page, '伏笔线索').click()
    assert.equal(await lineCount(page.locator('.stage-thread-name b').filter({ hasText: THREAD.title })), 1, '线索名称不折行')
    const route = await refs.threadRoute(page, THREAD.title).boundingBox()
    const more = await refs.threadMore(page, THREAD.title).boundingBox()
    assert.ok(Math.abs((route.y + route.height / 2) - (more.y + more.height / 2)) < route.height, '「更多」与线索路线在同一行')
    return { contentWidth: await page.locator('.stage-content').evaluate(node => node.clientWidth) }
  } }],
  [`refs-narrow-kb-${width}`, { model: true, shell: 'stage', setup: narrowSetup(width), run: async ({ page }) => {
    await refs.open(page, 'knowledge')
    await refs.materialButton(page, '守塔人小传').click()
    await refs.copyEditor(page).waitFor({ state: 'visible' })
    await refs.search(page, '雾钟')
    const editor = await refs.copyEditor(page).boundingBox()
    assert.ok(editor.width >= 300, `原文编辑区有可读的宽度：${editor.width}`)
    return { contentWidth: await page.locator('.stage-content').evaluate(node => node.clientWidth), editorWidth: Math.round(editor.width) }
  } }],
  [`refs-narrow-history-${width}`, { model: true, shell: 'stage', setup: narrowSetup(width), run: async ({ page }) => {
    await openChapterThreeVersions(page)
    await refs.versionButton(page, '草稿 v1').click()
    await refs.diffPage(page).waitFor({ state: 'visible' })
    for (const tag of await page.locator('.stage-hist-tag').all()) assert.equal(await lineCount(tag), 1, `对比头的标签不折行：${await tag.innerText()}`)
    const diff = await refs.diffPage(page).boundingBox()
    assert.ok(diff.width >= 420, `对比正文有可读的宽度：${diff.width}`)
    return { contentWidth: await page.locator('.stage-content').evaluate(node => node.clientWidth), diffWidth: Math.round(diff.width) }
  } }],
]))

export const REFS_SCENARIOS = {
  ...NARROW,
  'refs-kb-finalized': { model: true, shell: 'stage', setup: seedRefs, run: async ({ page }) => {
    await chapterView.finalize(page, 3, { untilReadOnly: false })
    await runSheet.waitForRunDone(page)
    await refs.open(page, 'knowledge')
    const shelves = page.getByRole('group', { name: '资料来源' })
    await shelves.getByRole('button', { name: '定稿章节 1' }).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await shelves.getByRole('button', { name: /^我导入的/ }).innerText(), '我导入的 0', '定稿章节不进「我导入的」')
    await shelves.getByRole('button', { name: '定稿章节 1' }).click()
    await refs.materialButton(page, /雾钟/).click()
    await page.getByText('这一章由定稿自动收入').waitFor({ state: 'visible' })
    assert.equal(await refs.copyEditor(page).count(), 0, '定稿章节在知识库里只读')
  } },
  'refs-regression': { model: true, setup: seedRefs, run: async ({ app, page, fake, invoke }) => {
    fake.replyPlotTree()
    await watchSession(app)
    if (await stage.root(page).count() > 0) {
      await refs.open(page, 'plot')
      await refs.buildPlotTree(page)
    } else {
      await shell.clickRail(page, '剧情')
      await page.getByRole('button', { name: '生成剧情树' }).click()
    }
    await page.getByRole('button', { name: '刷新剧情树' }).waitFor({ state: 'visible', timeout: 60_000 })
    const session = await lastSession(app)
    const { snapshot } = await invoke(page, 'db:plot-tree-read', session.projectPath, session)
    assert.ok(snapshot, '剧情树已保存')
    return { tracks: snapshot.tracks }
  } },
  'refs-plot': { model: true, shell: 'stage', setup: seedRefs, run: async ({ page, fake }) => {
    fake.replyPlotTree()
    await refs.open(page, 'plot')
    await refs.buildPlotTree(page)
    const lanes = await refs.plotLanes(page)
    assert.deepEqual(lanes.map(lane => lane.lane), ['主线雾钟与沉船', '支线父亲的地图'], '主线与支线两轨')
    assert.ok(lanes[0].events.some(event => event.startsWith('occurred:')), '主线有已定稿发生的事件')
    assert.match(await page.getByText(/不参与写作/).innerText(), /只读快照/)
    await refs.plotTable(page).getByRole('button', { name: '旧港' }).click()
    await page.getByRole('button', { name: '打开来源：第 1 章定稿' }).waitFor({ state: 'visible' })
  } },
  'refs-clear': { model: true, shell: 'stage', setup: seedRefs, run: async ({ page, fake }) => {
    fake.replyPlotTree()
    await refs.open(page, 'plot')
    await refs.buildPlotTree(page)
    await refs.plotMore(page).click()
    await refs.menuItem(page, '清除剧情树…').click()
    await refs.dialog(page).getByRole('heading', { name: '清除剧情树？' }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    await refs.dialog(page).getByRole('button', { name: '取消', exact: true }).click()
    await refs.plotTable(page).waitFor({ state: 'visible' })
  } },
  'refs-threads': { model: false, shell: 'stage', setup: seedRefs, run: async ({ page }) => {
    await refs.open(page, 'plot')
    await refs.plotView(page, '伏笔线索').click()
    assert.deepEqual(await refs.routeStates(page, THREAD.title), ['todo', 'none', 'todo'])
    await refs.threadMore(page, THREAD.title).click()
    await refs.menuItem(page, '记录定稿里的变化').click()
    await page.getByLabel('定稿章节').selectOption({ label: '第 1 章 · 定稿 v1' })
    await page.getByLabel('定稿里的原文').fill('潮水刚退')
    await page.getByLabel('理由').fill('林岚第一次听说钟声提前')
    await page.getByRole('button', { name: '记入线索' }).click()
    await page.getByRole('list', { name: '已确认的定稿事件' }).waitFor({ state: 'visible' })
    assert.deepEqual(await refs.routeStates(page, THREAD.title), ['done', 'none', 'todo'], '确认后埋设一站变成已发生')
  } },
  /** 版本历史点一稿时它已被删掉（列表还没刷新）：对比区说明这一稿已不存在，列表重读后去掉它（#414）。 */
  'refs-history-missing': { model: false, shell: 'stage', setup: seedRefs, run: async ({ app, page, invoke }) => {
    await watchSession(app)
    await openChapterThreeVersions(page)
    const session = await lastSession(app)
    assert.ok(session?.leaseId, '记下了界面的作品会话')
    const first = (await invoke(page, 'db:draft-list', 3, session.projectPath, session)).find(draft => draft.version === 1)
    assert.ok(first, '第 3 章预置了 v1 稿')
    const deleted = await invoke(page, 'db:draft-delete', first.id, session.projectPath, session)
    assert.equal(deleted.success, true, deleted.error)
    await refs.versionButton(page, '草稿 v1').click()
    await refs.comparison(page).getByText('这一稿已不存在，可能已被删除，请另选一稿。').waitFor({ state: 'visible' })
    await refs.versionButton(page, '草稿 v1').waitFor({ state: 'detached' })
    await refs.versionButton(page, '草稿 v2').waitFor({ state: 'visible' })
    await refs.historyChapters(page).getByRole('button', { name: /雾钟/ }).getByText('1 稿').waitFor({ state: 'visible' })
  } },
  // #474 B2：主进程只交 NARRATIVE_THREAD_EVIDENCE_NOT_IN_SOURCE，英文界面在记录表单里按码说明，不带汉字与错误码。
  'refs-thread-evidence-en': { model: false, shell: 'stage', setup: seedRefs, run: async ({ page, shoot }) => {
    await refs.open(page, 'plot')
    await refs.plotView(page, '伏笔线索').click()
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
    await page.getByRole('button', { name: `More actions for “${THREAD.title}”` }).click()
    await refs.menuItem(page, 'Record a change from a final').click()
    await page.getByLabel('Final chapter').selectOption({ label: 'Chapter 1 · final v1' })
    await page.getByLabel('Quote from the final').fill('这句话不在定稿里')
    await page.getByLabel('Why').fill('Testing a quote that is not in the final.')
    await page.getByRole('button', { name: 'Record', exact: true }).click()
    const alert = page.locator('.stage-plot-error[role="alert"]')
    await alert.waitFor({ state: 'visible' })
    const observed = { alert: await alert.innerText(), lang: await page.evaluate(() => document.documentElement.lang) }
    await shoot('refs-thread-evidence-en')
    assert.equal(observed.lang, 'en-US')
    assert.equal(observed.alert, 'Paste a short excerpt that appears in the selected finalized chapter.')
    assert.equal(await page.getByLabel('Quote from the final').inputValue(), '这句话不在定稿里', '表单留着作者的输入，改完能直接重试')
    return observed
  } },
  // #474 B3：主进程只交知识库错误码。英文界面下项目副本在别处被改后保存、检索索引登记文件损坏时读状态，
  // 提示都是英文、不带汉字与错误码。
  'refs-kb-errors-en': { model: true, shell: 'stage', setup: seedRefs, run: async context => {
    const { page, shoot } = context
    const englishOnly = (observed, key) => assert.doesNotMatch(observed[key], /[A-Z]{3,}_|\p{Script=Han}/u, JSON.stringify(observed))
    await importMaterials(context)
    await refs.materialButton(page, '守塔人小传').click()
    await refs.copyEditor(page).waitFor({ state: 'visible' })
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })

    const editor = page.getByRole('textbox', { name: 'Project copy content' })
    await editor.waitFor({ state: 'visible' })
    const copies = path.join(context.samplePath, '.ai-novel', 'knowledge-copies')
    const copyFile = fs.readdirSync(copies).filter(name => name.endsWith('.json')).map(name => path.join(copies, name))
      .find(file => JSON.parse(fs.readFileSync(file, 'utf8')).content === MATERIALS['守塔人小传.txt'])
    assert.ok(copyFile, '找到守塔人小传的项目副本')
    const stored = JSON.parse(fs.readFileSync(copyFile, 'utf8'))
    fs.writeFileSync(copyFile, JSON.stringify({ ...stored, content: `${stored.content}（另一处改动）`, edited: true, indexDirty: true }))
    await editor.fill(`${MATERIALS['守塔人小传.txt']}He never let anyone into the lamp room.`)
    await page.getByRole('button', { name: 'Save copy', exact: true }).click()
    const toast = page.locator('.pi-toast[data-tone="danger"]:not([data-exiting]) .pi-toast-body').first()
    await toast.waitFor({ state: 'visible', timeout: 30_000 })
    const saved = { toast: await toast.innerText(), lang: await page.evaluate(() => document.documentElement.lang) }
    await shoot('refs-kb-copy-changed-en')
    assert.equal(saved.lang, 'en-US')
    assert.match(saved.toast, /The project copy was changed elsewhere/)
    englishOnly(saved, 'toast')

    fs.writeFileSync(path.join(context.samplePath, '.ai-novel', 'embedding-spaces.json'), '{ "damaged": ')
    await stage.root(page).getByRole('button', { name: 'Settings', exact: true }).first().click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Retrieval model', exact: true }).click()
    const alert = stage.root(page).getByRole('region', { name: 'Search index of the current book' }).getByRole('alert')
    await alert.waitFor({ state: 'visible', timeout: 15_000 })
    const index = { alert: await alert.innerText() }
    await shoot('refs-kb-index-damaged-en')
    assert.match(index.alert, /search index records of this book are damaged/)
    englishOnly(index, 'alert')
    return { saved, index }
  } },
  // #474 B6：provider 只交 LLM_REQUEST_FAILED 与 HTTP 状态，连接测试由主进程按界面语言写成说明。
  // 英文界面把夹具模型的 API Key 改错后测试连接，假服务回 403，模型表单的结果是英文、不带汉字与错误码。
  'models-test-connection-en': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    const nav = page.getByRole('navigation', { name: 'Settings sections' })
    await nav.getByRole('button', { name: 'AI models', exact: true }).click()
    await page.getByRole('button', { name: `Edit “${FAKE_MODEL.name}”`, exact: true }).click()
    await page.getByPlaceholder('sk-...').fill('wrong-key-for-connection-test')
    const before = fake.requests.length
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    const result = page.getByText(/^Connection failed: /u)
    await result.waitFor({ state: 'visible', timeout: 15_000 })
    const observed = { result: await result.innerText(), lang: await page.evaluate(() => document.documentElement.lang) }
    await shoot('models-test-connection-en')
    assert.equal(observed.lang, 'en-US')
    assert.equal(observed.result, 'Connection failed: Model request failed (HTTP 403). Check the Base URL, API key, and model name.')
    assert.doesNotMatch(observed.result, /[A-Z]{3,}_|\p{Script=Han}/u)
    assert.equal(fake.requests.length, before, '假服务在鉴权前就回 403，不算一次模型请求')
    return observed
  } },
  'models-name-empty': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    await openNewModelForm(page)
    const combobox = page.locator('input[role="combobox"]')
    const fieldOrder = await combobox.evaluate(input => {
      const form = input.closest('.rounded-xl')
      return Array.from(form?.querySelectorAll('label') ?? []).map(label => label.textContent?.trim())
        .filter(label => ['服务商', '调用协议', 'base_url', 'API Key', 'model（模型名称）'].includes(label))
    })
    await combobox.evaluate(element => element.closest('.rounded-xl')?.scrollIntoView({ block: 'start' }))
    const draft = { modelName: await combobox.inputValue(), saveHint: await page.getByText(/^保存前还需填写：/u).innerText() }
    await shoot('models-name-new')
    assert.deepEqual(fieldOrder, ['服务商', '调用协议', 'base_url', 'API Key', 'model（模型名称）'])
    assert.equal(draft.modelName, '', '新建配置的模型名留空')
    assert.equal(draft.saveHint, '保存前还需填写：API Key、模型名称。')
    await page.getByRole('button', { name: '展开候选模型', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '获取模型列表' }).waitFor({ state: 'visible' })
    await combobox.evaluate(element => element.closest('.rounded-xl')?.scrollIntoView({ block: 'start' }))
    await page.mouse.move(0, 0)
    const observed = { fieldOrder, ...draft, options: await page.getByRole('listbox', { name: '候选模型' }).getByRole('option').count(),
      status: await page.getByRole('status').filter({ hasText: '获取模型列表' }).innerText(),
      requests: fake.requests.filter(kind => kind === 'models').length }
    await shoot('models-name-empty')
    assert.equal(observed.requests, 0, '没填 API Key 不请求端点模型列表')
    assert.equal(observed.options, 0, '没拉取前没有任何候选')
    assert.equal(observed.status, '填写 base_url 和 API Key 后获取模型列表。')
    return observed
  } },
  'models-name-auto': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    await openNewModelForm(page)
    await page.getByPlaceholder('sk-...').fill(FAKE_MODEL.apiKey)
    const status = page.getByText(/^已从端点获取 \d+ 个模型。$/u)
    await status.waitFor({ state: 'visible', timeout: 15_000 })
    const combobox = page.locator('input[role="combobox"]')
    const beforeOpen = { expanded: await combobox.getAttribute('aria-expanded'), requests: fake.requests.filter(kind => kind === 'models').length }
    await page.getByRole('button', { name: '展开候选模型', exact: true }).click()
    const listbox = page.getByRole('listbox', { name: '候选模型' })
    await listbox.evaluate(element => element.scrollIntoView({ block: 'center' }))
    await page.mouse.move(0, 0)
    const observed = { beforeOpen, status: await status.innerText(), options: await listbox.getByRole('option').allInnerTexts(),
      requests: fake.requests.filter(kind => kind === 'models').length }
    await shoot('models-name-auto')
    assert.deepEqual(beforeOpen, { expanded: 'false', requests: 1 }, '填好 Key 就自动获取一次，不需要展开')
    assert.equal(observed.requests, 1, '展开不重复获取')
    assert.deepEqual(observed.options.map(text => text.trim()), [...FIXTURE_ENDPOINT_MODELS], '候选只来自端点，按端点顺序')
    assert.equal(observed.status, `已从端点获取 ${FIXTURE_ENDPOINT_MODELS.length} 个模型。`)
    return observed
  } },
  'models-name-failed': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await openNewModelForm(page)
    await page.getByPlaceholder('sk-...').fill('wrong-key-for-model-list')
    const status = page.getByText('鉴权失败：请检查 API Key。手工模型 ID 仍可使用。', { exact: true })
    await status.waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByRole('button', { name: '展开候选模型', exact: true }).click()
    await page.locator('input[role="combobox"]').evaluate(element => element.closest('.rounded-xl')?.scrollIntoView({ block: 'start' }))
    await page.mouse.move(0, 0)
    const observed = { status: await status.innerText(),
      options: await page.getByRole('listbox', { name: '候选模型' }).getByRole('option').count() }
    await shoot('models-name-failed')
    assert.equal(observed.options, 0, '获取失败时没有候选')
    return observed
  } },
  'models-name-endpoint': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const observed = await openFixtureModelSuggestions(context, 'zh-CN')
    await context.shoot('models-name-endpoint')
    assert.equal(observed.requests, 1, '展开时自动获取一次')
    assert.equal(observed.options[0].trim(), FIXTURE_ENDPOINT_MODELS[0], JSON.stringify(observed))
    assert.ok(observed.options.some(text => text.startsWith('gateway/novel-writer-pro')), JSON.stringify(observed))
    assert.ok(observed.options.every(text => !/推荐/u.test(text)), JSON.stringify(observed))
    assert.equal(observed.status, `已从端点获取 ${FIXTURE_ENDPOINT_MODELS.length} 个模型。`)
    await context.page.getByRole('button', { name: '收起候选模型', exact: true }).click()
    await context.page.getByRole('button', { name: '展开候选模型', exact: true }).click()
    await context.page.getByRole('listbox', { name: '候选模型' }).getByRole('option').first().waitFor({ state: 'visible' })
    assert.equal(context.fake.requests.filter(kind => kind === 'models').length, 1, '再次展开不重复获取')
    return observed
  } },
  'models-name-en': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const observed = await openFixtureModelSuggestions(context, 'en-US')
    await context.shoot('models-name-en')
    assert.equal(observed.options[0].trim(), FIXTURE_ENDPOINT_MODELS[0], JSON.stringify(observed))
    assert.ok(observed.options.every(text => !/Recommended/u.test(text)), JSON.stringify(observed))
    assert.equal(observed.status, `Fetched ${FIXTURE_ENDPOINT_MODELS.length} models from the endpoint.`)
    return observed
  } },
  'models-name-narrow': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    await context.page.setViewportSize({ width: 1024, height: 700 })
    const observed = await openFixtureModelSuggestions(context, 'zh-CN')
    const layout = await context.page.evaluate(() => {
      const list = document.querySelector('[role="listbox"]')?.getBoundingClientRect()
      const input = document.querySelector('input[role="combobox"]')
      const form = input?.closest('.rounded-xl')?.getBoundingClientRect()
      const refresh = document.querySelector('button[aria-label="获取模型列表"]')
      const option = document.querySelector('[role="option"]')
      return { listRight: list?.right, listHeight: list?.height, formRight: form?.right, pageScrollWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth, inputHeight: input?.getBoundingClientRect().height, refreshHeight: refresh?.getBoundingClientRect().height,
        inputRadius: input && getComputedStyle(input).borderRadius, refreshRadius: refresh && getComputedStyle(refresh).borderRadius,
        listRadius: document.querySelector('[role="listbox"]') && getComputedStyle(document.querySelector('[role="listbox"]')).borderRadius,
        optionFontSize: option && getComputedStyle(option).fontSize }
    })
    await context.shoot('models-name-narrow')
    const listbox = context.page.getByRole('listbox', { name: '候选模型' })
    const box = await listbox.boundingBox()
    const scrollbarX = box.x + box.width - 1 - await listbox.evaluate(element => (element.offsetWidth - element.clientWidth) / 2)
    await context.page.mouse.move(scrollbarX, box.y + 12)
    await context.page.mouse.down()
    await context.page.mouse.move(scrollbarX, box.y + 120, { steps: 6 })
    await context.page.mouse.up()
    const afterDrag = await listbox.evaluate(element => ({ scrollTop: element.scrollTop,
      expanded: document.querySelector('input[role="combobox"]')?.getAttribute('aria-expanded') }))
    assert.ok(afterDrag.scrollTop > 0, `拖动滚动条能滚动列表：${JSON.stringify(afterDrag)}`)
    assert.equal(afterDrag.expanded, 'true', '拖动滚动条后列表仍展开')
    assert.ok(layout.pageScrollWidth <= layout.viewport, JSON.stringify(layout))
    assert.ok(layout.listHeight <= 240.5, JSON.stringify(layout))
    assert.ok(layout.listRight <= layout.formRight, '超长模型 ID 不把列表撑出表单')
    assert.equal(layout.refreshHeight, layout.inputHeight, '刷新按钮与输入框同高')
    assert.equal(layout.refreshRadius, layout.inputRadius, '刷新按钮与输入框同圆角')
    assert.equal(layout.listRadius, layout.inputRadius, '列表与输入框同圆角')
    assert.ok(Number.parseFloat(layout.optionFontSize) >= 13, '列表行字号不小于 13px')
    return { ...observed, layout, afterDrag }
  } },
  // 没填 Key 的新配置切到 Gemini，不会去请求 Google；手填与预设同名的模型，仍带上 Gemini 3 的思考映射。
  'models-gemini-thinking-off': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await openNewModelForm(page)
    await page.locator('select').filter({ has: page.locator('option[value="gemini"]') }).first().selectOption('gemini')
    assert.equal(await page.locator('input[role="combobox"]').inputValue(), '', '切换服务商后模型名留空')
    await page.locator('input[role="combobox"]').fill('gemini-3.8-flash')
    await page.getByRole('button', { name: '高级设置', exact: true }).click()
    await page.getByLabel('模型推理覆盖', { exact: true }).selectOption('off')
    const settings = page.locator('[data-model-reasoning-override-settings]')
    await settings.evaluate(element => element.scrollIntoView({ block: 'center' }))
    const observed = { modelName: await page.locator('input[role="combobox"]').inputValue(), text: await settings.innerText(),
      wire: await settings.locator('[data-reasoning-wire]').first().innerText() }
    await shoot('models-gemini-thinking-off')
    assert.equal(observed.modelName, 'gemini-3.8-flash')
    assert.match(observed.text, /Gemini 3 无法完全关闭思考/u)
    assert.match(observed.text, /关闭 → 低/u)
    assert.equal(observed.wire, 'thinking_level=low')
    return observed
  } },
  'models-test-connection-timeout': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    fake.gate.hold()
    await stage.openSettings(page)
    await page.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」`, exact: true }).click()
    const started = Date.now()
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    const result = page.getByText(/^连接失败：/u)
    await result.waitFor({ state: 'visible', timeout: 60_000 })
    const observed = { result: await result.innerText(), elapsedMs: Date.now() - started, waiting: fake.gate.waiting }
    await shoot('models-test-connection-timeout')
    assert.equal(observed.result, '连接失败：连接测试 30 秒内没有完成，已停止等待。请检查网络或代理设置后重试。')
    assert.ok(observed.elapsedMs >= 29_000 && observed.elapsedMs < 45_000, JSON.stringify(observed))
    return observed
  }, after: async ({ fake }) => { fake.gate.release() } },
  'refs-delete': { model: false, shell: 'stage', setup: seedRefs, run: async ({ page }) => {
    await refs.open(page, 'plot')
    await refs.plotView(page, '伏笔线索').click()
    await refs.threadMore(page, THREAD.title).click()
    await refs.menuItem(page, '删除线索…').click()
    await refs.dialog(page).getByRole('heading', { name: '删除这条线索？' }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    await refs.dialog(page).getByRole('button', { name: '取消', exact: true }).click()
    await refs.threadRoute(page, THREAD.title).waitFor({ state: 'visible' })
  } },
  'refs-kb': { model: true, shell: 'stage', setup: seedRefs, run: async context => {
    const { page } = context
    await importMaterials(context)
    await refs.materialButton(page, '守塔人小传').click()
    await refs.copyEditor(page).waitFor({ state: 'visible' })
    await refs.search(page, '雾钟')
    assert.ok((await refs.results(page).locator('mark').allInnerTexts()).includes('雾钟'), '结果片段里标出了查找词')
    assert.doesNotMatch(await everyWord(page), IMPLEMENTATION_TERMS, '知识库页不出现实现术语')
  } },
  'refs-kb-dirty': { model: true, shell: 'stage', setup: seedRefs, run: async context => {
    const { page } = context
    await importMaterials(context)
    await refs.materialButton(page, '守塔人小传').click()
    await refs.copyEditor(page).fill(`${MATERIALS['守塔人小传.txt']}他从不让人上灯室。`)
    await page.getByText('有未保存的修改').waitFor({ state: 'visible' })
    await refs.materialButton(page, '沉船名录').click()
    await refs.dialog(page).getByRole('heading', { name: '放弃未保存的修改？' }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    await refs.dialog(page).getByRole('button', { name: '继续编辑' }).click()
    assert.match(await refs.copyEditor(page).inputValue(), /他从不让人上灯室。$/, '继续编辑后修改还在')
    await page.keyboard.press('Control+S')
    await page.getByText('有未保存的修改').waitFor({ state: 'detached' })
  } },
  'refs-diff': { model: false, shell: 'stage', setup: seedRefs, run: async ({ page }) => {
    await openChapterThreeVersions(page)
    await assertComparisonReadOnly(page)
  } },
  'refs-revert': { model: false, shell: 'stage', setup: seedRefs, run: async ({ page }) => {
    await openChapterThreeVersions(page)
    await refs.versionButton(page, '草稿 v1').click()
    await page.getByRole('button', { name: '回退到此版本…' }).click()
    assert.match(await refs.dialog(page).innerText(), /新建一份草稿 v3/)
    await refs.dialog(page).getByRole('button', { name: '新建回滚草稿' }).click()
    await refs.versionButton(page, '草稿 v3').waitFor({ state: 'visible' })
    assert.deepEqual(await refs.versionNames(page), ['草稿 v3', '草稿 v2', '草稿 v1'], '新建 v3，v1 与 v2 都保留')
    await refs.versionButton(page, '草稿 v3').click()
    await page.getByText('与当前稿相同').waitFor({ state: 'visible' })
  } },
  'refs-dark': { model: true, shell: 'stage', setup: seedRefs, run: async context => {
    const { page, fake } = context
    fake.replyPlotTree()
    await importMaterials(context)
    await refs.materialButton(page, '守塔人小传').click()
    await refs.search(page, '雾钟')
    assert.deepEqual(await chromeContrastFailures(page, REFS_CONTRAST), [], '知识库对比度不足')
    await openChapterThreeVersions(page)
    await assertComparisonReadOnly(page)
    assert.deepEqual(await chromeContrastFailures(page, REFS_CONTRAST), [], '版本历史对比度不足')
    await refs.open(page, 'plot')
    await refs.buildPlotTree(page)
    assert.deepEqual(await chromeContrastFailures(page, REFS_CONTRAST), [], '剧情树对比度不足')
    assert.deepEqual(await chromeContrastFailures(page), [], '外壳对比度不足')
  } },
  'refs-tour': { model: true, shell: 'stage', setup: seedRefs, run: async context => {
    const { page, fake } = context
    fake.replyPlotTree()
    await refs.open(page, 'plot')
    await pause(2500)
    await refs.buildPlotTree(page)
    await pause(2500)
    await refs.plotTable(page).getByRole('button', { name: '旧港' }).click()
    await pause(3000)
    await refs.plotMore(page).click()
    await refs.menuItem(page, '清除剧情树…').click()
    await pause(2500)
    await refs.dialog(page).getByRole('button', { name: '取消', exact: true }).click()
    await refs.plotView(page, '伏笔线索').click()
    await pause(2500)
    await importMaterials(context)
    await refs.materialButton(page, '守塔人小传').click()
    await pause(2500)
    await refs.search(page, '雾钟')
    await pause(2500)
    await openChapterThreeVersions(page)
    await refs.versionButton(page, '草稿 v1').click()
    await refs.diffPage(page).waitFor({ state: 'visible' })
    await pause(3000)
    await page.getByRole('button', { name: '回退到此版本…' }).click()
    await pause(2500)
    await refs.dialog(page).getByRole('button', { name: '新建回滚草稿' }).click()
    await refs.versionButton(page, '草稿 v3').waitFor({ state: 'visible' })
    await pause(3000)
    await stage.tab(page, '剧情与伏笔').click()
    await pause(3000)
  } },
  'refs-timing': { model: true, setup: seedHundred, run: async ({ page }) => {
    const onStage = await stage.root(page).count() > 0
    const rail = name => page.locator('.writer-left-rail').getByRole('button', { name: new RegExp(`^${name}`) })
    const historyOpenMs = await msFromClickToProse(page, onStage ? refs.resourceButton(page, 'history') : rail('历史'),
      '.stage-hist-chapter, .cursor-pointer', '潮汐第100夜')
    const plotOpenMs = await msFromClickToProse(page, onStage ? refs.resourceButton(page, 'plot') : rail('剧情'), 'table button', STAGE_SAMPLE.titles[0])
    return { plotOpenMs, historyOpenMs }
  } },
}
