// RD-X2 外部审查修复的实机场景：页面状态与显示不对的缺陷，各按作者的操作在真实 Electron 里走一遍。
// 每个场景把作者看到的值收进 measured，最后一次性断言，对照构建上失败时能看到每一项各是什么。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { renderPlotOutlineSynopsis } from '../../src/shared/plot-outline-contract.ts'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import * as architecture from './pages/architecture.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { importMaterials } from './refs-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'
import { HARBOR, holdChannel, releaseChannel, seedHarbor, untilHeld } from './x1-scenarios.mjs'

const EMBEDDING_MODEL = Object.freeze({ ...FAKE_MODEL, id: 'x2-embedding', name: '驱动检索模型', modelName: 'text-embedding-3-small', purposes: ['embedding'] })

/** 与 chapter-scenarios 相同：运行侧页开着时等「上一次运行」完成；侧页已收起时等顶栏不再有进行中的胶囊。 */
async function waitRunDone(page) {
  if (await runSheet.sheet(page).isVisible()) return runSheet.waitForRunDone(page)
  await stage.root(page).locator('.stage-capsule:not([data-tone="ok"])').waitFor({ state: 'detached', timeout: 90_000 })
}

/** 情节大纲分批写到第 6 章（全书 12 章），尾标与主进程写入的一字不差：能从第 7 章续写，架构部分完成。 */
const partialOutline = () => renderPlotOutlineSynopsis(
  Array.from({ length: 6 }, (_, index) => `## 第${index + 1}章：${stageChapterTitle(index + 1)}\n林岚在第${index + 1}夜核对雾钟与潮位。`).join('\n\n'),
  6, { totalChapters: STAGE_SAMPLE.totalChapters, writingLanguage: 'zh-CN' })

const updateSynopsis = synopsis => async ({ page, invoke, path: projectPath, session }) => {
  const updated = await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, synopsis, totalChapters: STAGE_SAMPLE.totalChapters,
    wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, projectPath, session)
  assert.equal(updated.success, true, updated.error)
}

/**
 * 另建一部只有设定与架构（大纲分批没写完）的作品；blueprints 为 true 时再加前三章蓝图，finalized 为 true 时导入第 1 章定稿（没有蓝图），
 * emptyDraft 为 true 时给第 1 章建一份正文为空的草稿（没有蓝图）。
 */
async function seedOutlineBook(context, name, { blueprints = false, finalized = false, emptyDraft = false }) {
  const { app, page, roots, invoke } = context
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, synopsis: partialOutline(),
    totalChapters: STAGE_SAMPLE.totalChapters, wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, created.projectPath, session)).success, true)
  if (finalized) {
    const content = STAGE_SAMPLE.finalized[1]
    const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
      chapters: [{ chapterNumber: 1, title: stageChapterTitle(1), content, wordCount: countUnits(content) }] }, created.projectPath, session)
    assert.equal(imported.success, true, imported.error)
  }
  if (emptyDraft) {
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: 1, version: 1, source: 'write', content: '', wordCount: 0 }, created.projectPath, session)
    assert.equal(draft.success, true, draft.error)
  }
  if (!blueprints) return
  for (const number of [1, 2, 3]) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: number, title: stageChapterTitle(number), role: '发展',
      purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: [] }, created.projectPath, session)).success, true)
  }
}

/** 落点稳定后的位置面包屑：等到出现，再等半秒确认不再变。 */
async function settledLanding(page) {
  const deadline = Date.now() + 20_000
  let last = null
  for (;;) {
    const { crumbs } = await stage.landing(page)
    const key = crumbs.join('/')
    if (key && key === last) return crumbs
    assert.ok(Date.now() < deadline, `20 秒内落点没有稳定（最后是 ${key || '空'}）`)
    last = key
    await page.waitForTimeout(500)
  }
}

/** 从书房的「打开作品」选文件夹打开：主进程的文件夹对话框换成直接选中这部作品。 */
async function openFolder(app, page, folder) {
  await app.evaluate(({ dialog }, selected) => {
    globalThis.__x2Dialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, folder)
  try {
    await stage.root(page).getByRole('button', { name: '打开作品', exact: true }).click()
    await stage.spine(page).waitFor({ state: 'visible' })
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__x2Dialog })
  }
}

/** 把主进程 channel 之后每次调用的参数记下来（不改行为）。 */
async function recordArgs(app, channel) {
  await app.evaluate(({ ipcMain }, channel) => {
    const calls = (globalThis.__x2Args ??= {})[channel] = []
    const original = ipcMain._invokeHandlers.get(channel)
    ipcMain._invokeHandlers.set(channel, (event, ...args) => {
      calls.push(args)
      return original(event, ...args)
    })
  }, channel)
}
const recordedArgs = (app, channel) => app.evaluate((_, channel) => globalThis.__x2Args[channel], channel)

/** 数据库 datetime('now') 的时刻按本机时区显示成什么，与页面用同一组 toLocaleString 选项。 */
const localTime = (page, value, options) => page.evaluate(([value, options]) =>
  new Date(`${value.replace(' ', 'T')}Z`).toLocaleString('zh-CN', options), [value, options])

export const X2_SCENARIOS = {
  // #394 §6（用户决定 B）：大纲分批没写完时，只有蓝图与正文都没有才落在架构；有蓝图或正文就落到当前写作位置。
  // 南湾只有第 1 章定稿、没有蓝图，落在第 1 章而不是空的蓝图页。空港只有一份空的草稿，空稿不算开始，落在架构（#407 第 2 轮）。
  // 灯塔第 3、4 章都在写，落在最后一章在写的第 4 章；点「正文」与书房「继续写作」也指向第 4 章（#407 第 2 轮，用户决定）。
  // 书房打开五部作品，再用「打开作品」选文件夹打开灯塔。
  'x2-landing': { model: false, shell: 'stage', setup: async context => {
    await seedOutlineBook(context, '荒岛', { blueprints: false })
    await seedOutlineBook(context, '北堤', { blueprints: true })
    await seedOutlineBook(context, '南湾', { finalized: true })
    await seedOutlineBook(context, '空港', { emptyDraft: true })
    await seedStageSample(context, { open: false, beforeReload: updateSynopsis(partialOutline()) })
  }, run: async ({ app, page, samplePath, shoot }) => {
    const landed = {}
    for (const name of ['荒岛', '北堤', '南湾', '空港', STAGE_SAMPLE.name]) {
      await stage.openFromLibrary(page, name)
      landed[name] = (await settledLanding(page)).join(' / ')
      await shoot(`x2-landing-${name}`)
      await stage.backToLibrary(page, name)
    }
    await openFolder(app, page, samplePath)
    landed['灯塔（打开作品）'] = (await settledLanding(page)).join(' / ')
    const architectureState = (await stage.stageStates(page)).architecture
    // 对照构建上这一步可能走不通（落在架构时没有章节列表），没走通的原因记进 measured，最后一并断言。
    const manuscript = await (async () => {
      await stage.chapterButton(page, 1).click({ timeout: 5000 })
      await stage.waitForProse(page, STAGE_SAMPLE.finalized[1].split('\n')[0].slice(0, 16))
      await stage.stageButton(page, '正文').click()
      return (await settledLanding(page)).join(' / ')
    })().catch(error => `没走通：${error.message.split('\n')[0]}`)
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    const continueWriting = await stage.overview(page, STAGE_SAMPLE.name).getByRole('button', { name: /^继续写作/ }).innerText()
    await shoot('x2-landing-continue')
    const measured = { landed, architectureState, manuscript, continueWriting }
    assert.deepEqual({ landed, manuscript, continueWriting }, {
      landed: { 荒岛: '架构', 北堤: '正文 / 第 1 章', 南湾: '正文 / 第 1 章', 空港: '架构',
        [STAGE_SAMPLE.name]: '正文 / 第 4 章', '灯塔（打开作品）': '正文 / 第 4 章' },
      manuscript: '正文 / 第 4 章',
      continueWriting: '继续写作 · 第 4 章 · 待审稿',
    }, JSON.stringify(measured))
    return measured
  } },

  // #394 §1：大纲末尾带分批尾标但多了一个换行（主进程已接不上续写）不算已确认；§2：超过单批上限的范围在对话框里直接判无效。
  'x2-outline': { model: false, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: updateSynopsis(`${partialOutline()}\n`) }),
    run: async ({ page, shoot }) => {
      await architecture.open(page)
      const shown = {
        badge: await architecture.badge(page, 'synopsis').innerText(),
        progress: (await architecture.page(page).locator('.arch-progress').innerText()).trim(),
        next: await architecture.next(page).isEnabled(),
      }
      // 判为已确认时主按钮是「下一步」，生成对话框改从页头的更多操作里打开。
      if (shown.next) {
        await stage.root(page).getByRole('button', { name: '架构的更多操作' }).click()
        await page.getByRole('menuitem', { name: 'AI 生成架构…' }).click()
      } else await architecture.primary(page).click()
      await architecture.dialog(page).waitFor({ state: 'visible' })
      if (!await architecture.dialog(page).locator('[data-step="synopsis"] input[type="checkbox"]').isChecked()) await architecture.stepCheck(page, 'synopsis').click()
      await architecture.setRange(page, 1, 12)
      const range = {
        mark: await architecture.mark(page, 'synopsis').innerText(),
        submit: await architecture.dialog(page).getByRole('button', { name: /开始生成 \d 项/ }).isEnabled(),
      }
      await shoot('x2-outline-range')
      await architecture.dialog(page).getByRole('button', { name: '取消', exact: true }).click()
      const measured = { shown, range }
      assert.deepEqual(measured, { shown: { badge: '不完整', progress: '· 3 / 4 已确认', next: false }, range: { mark: '范围无效', submit: false } }, JSON.stringify(measured))
      return measured
    } },

  // #380 C3+O2：预览港口后回到灯塔，概览不停在「正在读取」；O23：正在预览的港口被移出最近项目后，灯塔名下不显示港口的统计。
  'x2-library-overview': { model: false, shell: 'stage', setup: async context => {
    await seedHarbor(context)
    await seedStageSample(context)
  }, run: async ({ page, shoot }) => {
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    const current = stage.overview(page, STAGE_SAMPLE.name)
    const excerpt = current.locator('.stage-ov-excerpt')
    await excerpt.waitFor({ state: 'visible', timeout: 15_000 })
    await stage.previewBook(page, HARBOR)
    await stage.overview(page, HARBOR).getByRole('button', { name: `打开《${HARBOR}》` }).waitFor({ state: 'visible' })
    await stage.overview(page, HARBOR).getByRole('button', { name: `回到《${STAGE_SAMPLE.name}》` }).click()
    await page.waitForTimeout(2000)
    const back = { busy: await current.getAttribute('aria-busy'), excerpt: await excerpt.isVisible() }
    await shoot('x2-library-back')

    await stage.previewBook(page, HARBOR)
    await stage.overview(page, HARBOR).getByRole('button', { name: `打开《${HARBOR}》` }).waitFor({ state: 'visible' })
    await stage.bookMenu(page, HARBOR, '从最近项目移除…')
    await page.getByRole('dialog').getByRole('button', { name: '移除记录' }).click()
    await stage.cover(page, HARBOR).waitFor({ state: 'detached' })
    await page.waitForTimeout(1500)
    const removed = { busy: await current.getAttribute('aria-busy'), excerpt: await excerpt.isVisible() }
    const measured = { back, removed }
    assert.deepEqual(measured, { back: { busy: 'false', excerpt: true }, removed: { busy: 'false', excerpt: true } }, JSON.stringify(measured))
    return measured
  } },

  // #388 T2/T12/T8：版本历史再点当前章各稿还在；换章读到之前显示正在读取；稿的时间按 UTC 换成本地时间（单章视图的版本切换器同样）。
  'x2-history': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, invoke, shoot }) => {
    await watchSession(app)
    await refs.open(page, 'history')
    const chapter3 = refs.historyChapters(page).getByRole('button', { name: /雾钟/ })
    await chapter3.click()
    await refs.timeline(page).waitFor({ state: 'visible' })
    const historyTime = (await refs.timeline(page).locator('.stage-hist-meta').last().innerText()).split(' · ').at(-1)
    await chapter3.click()
    await page.waitForTimeout(1500)
    const reclicked = { timeline: await refs.timeline(page).isVisible() }

    await holdChannel(app, 'db:draft-list')
    await refs.historyChapters(page).getByRole('button', { name: /守塔人/ }).click()
    await untilHeld(app, 'db:draft-list')
    const whileLoading = await page.getByRole('region', { name: '这一章的各稿' }).locator('.stage-hist-help').innerText()
    await shoot('x2-history-loading')
    await releaseChannel(app, 'db:draft-list')
    await page.waitForTimeout(1000)

    await stage.tab(page, /^第 3 章/).click()
    await chapterView.versionButton(page).click()
    const switcherTime = (await page.getByRole('menu', { name: '本章版本' }).getByRole('menuitemradio').first().locator('small').innerText()).split(' · ').at(-1)
    await page.keyboard.press('Escape')

    const session = await app.evaluate(() => globalThis.__x2Session)
    const [draft] = await invoke(page, 'db:draft-list', 3, session.projectPath, session)
    const expected = {
      history: await localTime(page, draft.createdAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      switcher: await localTime(page, draft.updatedAt ?? draft.createdAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    }
    const shown = { reclicked, whileLoading, times: { history: historyTime, switcher: switcherTime } }
    const measured = { ...shown, expected, stored: { createdAt: draft.createdAt, updatedAt: draft.updatedAt } }
    assert.deepEqual(shown, { reclicked: { timeline: true }, whileLoading: '正在读取…', times: expected }, JSON.stringify(measured))
    return measured
  } },

  // #484：检索模型配在本机地址、不填 Key，知识库照样认它，导入资料与补全索引都向它要向量，请求里不带 Key。
  'kb-local-keyless': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    const model = { ...EMBEDDING_MODEL, id: 'kb-local-embedding', name: '本机检索模型', provider: 'custom',
      baseUrl: `http://127.0.0.1:${context.fake.port}/v1`, apiKey: '' }
    assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', model.id)).success, true)
  } }), run: async context => {
    const { page, fake, shoot } = context
    fake.acceptKeylessEmbeddings()
    await importMaterials(context)
    // 创作资料走 kb:import-planning-text，只建全文索引、不要向量；之后的嵌入请求只能来自重建，导入时带向量由单元测试覆盖。
    const importEmbeddings = fake.embeddingAuthorizations.length
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '检索模型')
    const index = stage.root(page).getByRole('region', { name: '当前作品的检索索引' })
    const rebuild = index.getByRole('button', { name: '检查并重建向量索引' })
    const offered = await rebuild.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)
    const before = { offered, text: await index.innerText() }
    if (offered) {
      await shoot('kb-local-keyless-before-rebuild')
      await rebuild.click()
      await index.getByRole('button', { name: '检查与重建中…' }).waitFor({ state: 'detached', timeout: 30_000 })
      await index.getByRole('heading', { name: '检查当前模型的向量索引' }).waitFor({ state: 'visible', timeout: 30_000 })
    }
    const after = { text: await index.innerText(), alerts: await index.getByRole('alert').allInnerTexts() }
    const authorizations = [...new Set(fake.embeddingAuthorizations)]
    const measured = { before, after, importEmbeddings, rebuildEmbeddings: fake.embeddingAuthorizations.length - importEmbeddings, authorizations }
    assert.deepEqual({ offered, alerts: after.alerts, importEmbeddings, rebuilt: measured.rebuildEmbeddings > 0, keyless: authorizations.every(value => !(value ?? '').replace(/^Bearer\s*/u, '')) },
      { offered: true, alerts: [], importEmbeddings: 0, rebuilt: true, keyless: true }, JSON.stringify(measured))
    return measured
  } },

  // #388 T3：设置的「检索模型」页里删掉检索模型，同一页的索引区随之回到未配置，不再留着重建按钮。
  'x2-index-model': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    assert.equal((await invoke(page, 'llm:save-model', EMBEDDING_MODEL)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', EMBEDDING_MODEL.id)).success, true)
  } }), run: async context => {
    const { page, invoke, shoot } = context
    await importMaterials(context)
    // 主进程在没有默认检索模型时退回默认生成模型；去掉生成模型，删掉检索模型后才真的没有检索模型。
    assert.equal((await invoke(page, 'llm:delete-model', FAKE_MODEL.id)).success, true)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '检索模型')
    const index = stage.root(page).getByRole('region', { name: '当前作品的检索索引' })
    await index.getByRole('button').first().waitFor({ state: 'visible', timeout: 15_000 })
    const before = { buttons: await index.getByRole('button').allInnerTexts() }
    await stage.root(page).getByRole('button', { name: `「${EMBEDDING_MODEL.name}」更多操作` }).click()
    await page.getByRole('menuitem', { name: '删除模型…' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '删除模型', exact: true }).click()
    await stage.root(page).getByRole('heading', { name: '还没有检索模型' }).waitFor({ state: 'visible' })
    await page.waitForTimeout(2000)
    await shoot('x2-index-model-deleted')
    const after = { buttons: await index.getByRole('button').allInnerTexts(), text: await index.innerText() }
    const measured = { before, after }
    assert.deepEqual({ before: before.buttons.length > 0, after: after.buttons, unconfigured: after.text.includes('配置并启用检索模型后') },
      { before: true, after: [], unconfigured: true }, JSON.stringify(measured))
    return measured
  } },

  // #388 T15：知识库查找后改「最多显示」，按上次查找的词与新的条数重查。
  'x2-kb-limit': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page } = context
    await importMaterials(context)
    await recordArgs(app, 'kb:search')
    await refs.search(page, '守塔人')
    await refs.searchInput(page).fill('还没提交的字')
    await stage.root(page).locator('.stage-kb-topk').selectOption('5')
    await page.waitForTimeout(2000)
    const searches = (await recordedArgs(app, 'kb:search')).map(args => args.slice(0, 2))
    assert.deepEqual(searches, [['守塔人', 10], ['守塔人', 5]], JSON.stringify(searches))
    return { searches }
  } },

  // #389 X1+O#27：当前状态、关系图谱视图没有点了没反应的头像按钮；O#2：粘贴角色卡的全文框按 9 行高显示。
  'x2-cast': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await architecture.open(page)
    await architecture.openCast(page)
    const avatar = stage.root(page).getByRole('button', { name: /^(选择|更换)头像$/ })
    const views = {}
    for (const view of ['基础设定', '当前状态', '关系图谱']) {
      await stage.root(page).getByRole('group', { name: '档案视图' }).getByRole('button', { name: view, exact: true }).click()
      await page.waitForTimeout(300)
      views[view] = await avatar.count()
    }
    await stage.root(page).getByRole('button', { name: '粘贴 / 导入角色卡' }).click()
    const source = page.getByRole('dialog').getByRole('textbox', { name: '角色卡全文' })
    await source.waitFor({ state: 'visible' })
    const box = await source.evaluate(element => ({ rows: element.rows, height: Math.round(element.getBoundingClientRect().height),
      lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)) }))
    await shoot('x2-cast-paste')
    await page.getByRole('dialog').getByRole('button', { name: '暂不导入' }).click()
    const measured = { views, box }
    assert.deepEqual({ views, atLeastNineLines: box.lines >= 9 }, { views: { 基础设定: 1, 当前状态: 0, 关系图谱: 0 }, atLeastNineLines: true }, JSON.stringify(measured))
    return measured
  } },

  // #392 T3：第 4 章审稿、按意见修稿、全部用修稿合并，自动复验跑完后单章视图写明复验完成几项，审稿报告逐项标着复验结果。
  // 只有带正文证据的本章目标意见才进复验：审稿回第 4 章蓝图关键事件未完成，证据取自第 4 章正文。
  'x2-recheck': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake, shoot }) => {
    fake.replyReview(JSON.stringify({ summary: '本章目标还没落地。', items: [
      { category: '连续性', severity: 'warning', description: '核对钟声提前一刻与潮位的关系。', quote: '他给林岚倒了一杯很淡的茶' },
    ], goalReviews: [{ id: 'ch4:keyEvents:1', status: 'unmet', description: '林岚还没有在灯塔里找到新的线索。',
      evidence: [{ quote: '守塔人的屋子在灯塔背风的一侧' }] }] }))
    await chapterView.open(page, 4)
    await chapterView.review(page)
    await waitRunDone(page)
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page)
    await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    // 合并后的复验是第三次对话请求；等它发出、顶栏不再有进行中的运行，再读提示。
    const deadline = Date.now() + 60_000
    while (fake.chats.length < 3) {
      assert.ok(Date.now() < deadline, `60 秒内没有发出合并后的复验（对话请求 ${fake.chats.map(chat => chat.kind).join('、')}）`)
      await page.waitForTimeout(250)
    }
    await stage.root(page).locator('.stage-capsule:not([data-tone="ok"])').waitFor({ state: 'detached', timeout: 90_000 })
    await page.waitForTimeout(3000)
    const hint = await chapterView.hint(page).innerText()
    await chapterView.more(page, '审稿报告')
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await shoot('x2-recheck-sheet')
    const statuses = await chapterView.reviewSheet(page).getByText(/^复验：/).allInnerTexts()
    const measured = { hint, statuses }
    assert.match(hint, /^复验完成：\d+ \/ \d+ 项意见已解决$/, JSON.stringify(measured))
    assert.ok(statuses.length > 0, JSON.stringify(measured))
    return measured
  } },

  // #377 R1：蓝图页改了第 5 章标题并「保存此章」，流程脊的章节列表随之显示新标题。
  'x2-blueprint-save': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, 5).click()
    await blueprint.titleInput(page).fill('潮汐表的背面')
    await blueprint.card(page).getByRole('button', { name: '保存此章' }).click()
    await blueprint.card(page).getByRole('button', { name: '保存此章' }).waitFor({ state: 'visible' })
    await page.waitForTimeout(2000)
    await stage.tab(page, /^第 3 章/).click()
    const row = await stage.chapterButton(page, 5).innerText()
    assert.match(row, /潮汐表的背面/, row)
    return { row }
  } },

  // #377 R2：点了第 4 章、正文还没读完就去设定，读完后第 4 章不把标签抢回来。
  'x2-open-chapter': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await holdChannel(app, 'db:draft-get-full')
    await stage.chapterButton(page, 4).click()
    await untilHeld(app, 'db:draft-get-full')
    await stage.stageButton(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    await releaseChannel(app, 'db:draft-get-full')
    await page.waitForTimeout(2000)
    const after = { setup: await stage.setupOutline(page).isVisible(), crumbs: (await stage.landing(page)).crumbs.join(' / ') }
    assert.deepEqual(after, { setup: true, crumbs: '设定' }, JSON.stringify(after))
    return after
  } },
}

/** 记下界面发给主进程的最近一次带项目会话的调用参数，驱动用同一会话读数据库。 */
async function watchSession(app) {
  await app.evaluate(({ ipcMain }) => {
    for (const [channel, handler] of ipcMain._invokeHandlers) {
      ipcMain._invokeHandlers.set(channel, (event, ...args) => {
        const session = args.at(-1)
        if (session && typeof session === 'object' && 'leaseId' in session) globalThis.__x2Session = session
        return handler(event, ...args)
      })
    }
  })
}
