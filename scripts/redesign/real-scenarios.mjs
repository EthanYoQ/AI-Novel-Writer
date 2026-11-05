// 真实模型场景（--real-model）：生成、审稿、修稿、定稿后处理与嵌入都由硅基流动的 DeepSeek 与 bge-m3 回复。
// 回复的文风与质量不评判，只断言作者看得到的软件状态与库里的数据。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

const BOOK = STAGE_SAMPLE.name
const TOTAL_CHAPTERS = 8
const WORDS_PER_CHAPTER = 800
/** 单次模型操作的上限：真实模型一次回复可能几十秒到几分钟。 */
const MODEL_WAIT = 10 * 60_000
const KEY_EVENTS = [
  '林岚抵达旧港，在石阶上遇见守塔人，得知雾钟每晚提前一刻响起。',
  '林岚走上北堤，在礁石上找到父亲离家那一年的潮位刻痕。',
  '林岚在灯室里发现钟绳上系着的纸条：别在涨潮时敲钟。',
  '守塔人终于提起林岚的父亲也曾问过钟的事。',
  '林岚对照潮汐表，发现钟声偏差与三十年前的沉船时刻吻合。',
  '港务局的档案在沉船那一年断了线，林岚找到第二盏灯的记录。',
  '盐霜覆盖的旧船坞里，林岚翻出沉船名录。',
  '风暴前夜，林岚决定在涨潮时守在雾钟旁。',
]
const FINALIZED_TEXT = { 1: STAGE_SAMPLE.finalized[1], 2: STAGE_SAMPLE.finalized[2], 3: STAGE_SAMPLE.drafts[3].text }
const RUNNING = '.stage-capsule:not([data-tone="ok"])'
const AUTHOR_NOTE = '潮水与灯光的细节再具体一些，加一处林岚对照地图的动作。'

/** 记下界面打开作品拿到的会话（包一层主进程的 project:open），驱动读库时不必重开作品。重启后要重新装。 */
async function trackOpenedSession(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('project:open')
    if (typeof original !== 'function') throw new Error('project:open 未注册，记不下界面会话')
    handlers.set('project:open', async (event, projectPath, ...rest) => {
      const result = await original(event, projectPath, ...rest)
      if (result?.success) globalThis.__driveOpened = { projectId: result.project.id, projectPath, leaseId: result.project.sessionLease }
      return result
    })
  })
}

async function uiSession(app) {
  const session = await app.evaluate(() => globalThis.__driveOpened)
  assert.ok(session?.leaseId, '记下了界面打开作品的会话')
  return session
}

/** 用界面当前的会话调主进程；读库都走它，与界面读到的是同一份数据。 */
async function read(context, channel, ...args) {
  const session = await uiSession(context.app)
  return context.invoke(context.page, channel, ...args, session.projectPath, session)
}

/** 预置作品：设定、林岚、8 章蓝图，finalized 里的章以作者原稿定稿导入；接上真实模型后从书房打开。 */
async function seedBook(context, { finalized = [] } = {}) {
  const { app, page, roots, invoke, reload } = context
  await trackOpenedSession(app)
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: BOOK, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const projectPath = created.projectPath
  context.samplePath = projectPath
  const session = { projectId: created.projectId, projectPath, leaseId: opened.project.sessionLease }
  await context.installRealModels()
  const roster = await invoke(page, 'db:character-roster-read', projectPath, session)
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
    entries: [{ characterId: `draft:${randomUUID()}`, name: '林岚', role: 'protagonist', gender: '女', age: '28', appearance: '',
      personality: '冷静、执拗', background: '旧港潮汐记录的测绘师。', abilities: '读潮位刻痕', motivation: '查明失踪地图的来源。',
      relationships: [], arc: '', notes: '' }] }, projectPath, session)).success, true)
  const core = await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, totalChapters: TOTAL_CHAPTERS, wordsPerChapter: WORDS_PER_CHAPTER }, projectPath, session)
  assert.equal(core.success, true, core.error)
  for (let chapterNumber = 1; chapterNumber <= TOTAL_CHAPTERS; chapterNumber++) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber, title: stageChapterTitle(chapterNumber), role: '发展',
      purpose: '推进灯塔与沉船的线索', keyEvents: KEY_EVENTS[chapterNumber - 1], characters: ['林岚'] }, projectPath, session)).success, true)
  }
  if (finalized.length > 0) {
    const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
      chapters: finalized.map(number => ({ chapterNumber: number, title: stageChapterTitle(number), content: FINALIZED_TEXT[number],
        wordCount: countUnits(FINALIZED_TEXT[number]) })) }, projectPath, session)
    assert.equal(imported.success, true, imported.error)
  }
  await reload()
  await stage.openFromLibrary(page, BOOK)
}

/** 页面里进行中的运行胶囊挂上来过几次；点下触发运行的按钮之前取一次，交给 untilRunEnds。 */
async function runsStarted(page) {
  return page.evaluate(() => {
    if (!window.__realRunsStarted) {
      window.__realRunsStarted = { count: 0 }
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof Element && node.matches('.stage-capsule:not([data-tone="ok"])')) window.__realRunsStarted.count++
          }
        }
      }).observe(document.body, { childList: true, subtree: true })
    }
    return window.__realRunsStarted.count
  })
}

/** 运行侧页的全文，失败时写进错误里定位。 */
async function runSheetText(page) {
  try {
    await runSheet.openFromPalette(page)
    return (await runSheet.sheet(page).innerText()).slice(0, 4000)
  } catch (error) { return `（读不到运行侧页：${error.message}）` }
}

/**
 * 等这次运行挂出胶囊、再等顶栏不再有进行中的胶囊，返回毫秒数。
 * 运行停在「等你确认」时，按作者的默认选择确认，记进 confirmations。
 */
async function untilRunEnds(page, before, what, confirmations = []) {
  const started = Date.now()
  for (;;) {
    const state = await page.evaluate(({ before, selector }) => ({
      started: window.__realRunsStarted.count > before,
      running: [...document.querySelectorAll(selector)].map(node => node.textContent ?? ''),
    }), { before, selector: RUNNING })
    if (state.started && state.running.length === 0) return Date.now() - started
    if (state.running.some(text => text.includes('等你确认'))) {
      await runSheet.openFromPalette(page)
      const confirm = runSheet.anyCard(page).filter({ hasText: '等你确认' }).getByRole('button', { name: /确认/ }).first()
      if (await confirm.isVisible()) {
        confirmations.push({ what, card: (await runSheet.anyCard(page).filter({ hasText: '等你确认' }).first().innerText()).slice(0, 600) })
        await confirm.click()
      }
    }
    if (Date.now() - started > MODEL_WAIT) throw new Error(`${what}：${MODEL_WAIT / 60_000} 分钟内运行没有结束\n${await runSheetText(page)}`)
    await page.waitForTimeout(1000)
  }
}

/** 点下 trigger 发起运行并等它结束；返回耗时。 */
async function runAndWait(page, trigger, what, confirmations) {
  const before = await runsStarted(page)
  await trigger()
  return untilRunEnds(page, before, what, confirmations)
}

async function openChapter(page, chapterNumber) {
  if (!await stage.chapterButton(page, chapterNumber).isVisible()) await stage.stageButton(page, '正文').click()
  await chapterView.open(page, chapterNumber)
}

const proseUnits = async page => countUnits(await chapterView.prose(page).innerText())

/** 在待写章的单章视图点「写作此章」，等真实模型写完、正文出现。 */
async function writeChapter(page, chapterNumber, confirmations) {
  await openChapter(page, chapterNumber)
  const ms = await runAndWait(page, () => chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click(),
    `写第 ${chapterNumber} 章`, confirmations)
  await chapterView.prose(page).filter({ hasText: /\S/ }).first().waitFor({ state: 'visible', timeout: 30_000 })
    .catch(async () => { throw new Error(`第 ${chapterNumber} 章写完后正文没有出现\n${await runSheetText(page)}`) })
  return { ms, units: await proseUnits(page) }
}

/** 定稿后处理每一行都结束（成功或失败），且没有进行中的运行。 */
async function postProcessSettled(page, chapterNumber) {
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[aria-label="定稿后处理"] li')]
    return rows.length > 0 && rows.every(row => row.dataset.state === 'success' || row.dataset.state === 'failed')
      && !document.querySelector('.stage-capsule:not([data-tone="ok"])')
  }, null, { timeout: MODEL_WAIT, polling: 1000 }).catch(async () => {
    throw new Error(`第 ${chapterNumber} 章定稿后处理 ${MODEL_WAIT / 60_000} 分钟内没有结束：${JSON.stringify(await chapterView.postProcessSteps(page))}\n${await runSheetText(page)}`)
  })
  return chapterView.postProcessSteps(page)
}

/** 定稿并等后处理各行（正文文件、知识库、要点、角色状态）在真实回复下结束；任何一行失败都判失败，正文文件没写入也算。 */
async function finalizeAndPostProcess(page, chapterNumber) {
  const started = Date.now()
  await chapterView.finalize(page, chapterNumber)
  await chapterView.postProcess(page).waitFor({ state: 'visible', timeout: 60_000 })
  const steps = await postProcessSettled(page, chapterNumber)
  const failed = steps.filter(step => step.state !== 'success')
  if (failed.length > 0) {
    const details = await chapterView.postProcess(page).innerText()
    throw new Error(`第 ${chapterNumber} 章定稿后处理有失败：${JSON.stringify(steps)}\n${details}\n${await runSheetText(page)}`)
  }
  return { ms: Date.now() - started, steps }
}

/** 审稿、按意见修稿、全部用修稿、完成合并；审稿没有可修的意见时主按钮直接是「定稿」，改由作者添一条意见再修稿。 */
async function reviewReviseMerge(page, chapterNumber, confirmations) {
  const measured = {}
  measured.reviewMs = await runAndWait(page, () => chapterView.view(page).getByRole('button', { name: 'AI 审稿', exact: true }).click(),
    `第 ${chapterNumber} 章审稿`, confirmations)
  await chapterView.reviewSheet(page).waitFor({ state: 'visible', timeout: 30_000 })
    .catch(async () => { throw new Error(`第 ${chapterNumber} 章审稿结束后审稿侧页没有出现\n${await runSheetText(page)}`) })
  const revise = chapterView.reviseButton(page)
  const finalizeNow = chapterView.view(page).getByRole('button', { name: '定稿', exact: true })
  await revise.or(finalizeNow).first().waitFor({ state: 'visible' })
  if (await revise.count() > 0) {
    measured.reviewIssues = Number((await revise.innerText()).match(/\d+/)[0])
    assert.ok(measured.reviewIssues > 0 && await revise.isEnabled(), `有修稿按钮时它按至少 1 项意见修稿且可点：${await revise.innerText()}`)
  } else {
    // 审稿没提可修的意见时修稿走作者自己的意见：这也是作者能走的路，修稿与合并照样由真实模型完成。
    measured.reviewIssues = 0
    measured.nothingToReviseHint = await chapterView.hint(page).innerText()
    assert.match(measured.nothingToReviseHint, /这次审稿没有需要修改的意见/u)
    await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' }).click()
    await chapterView.reviewSheet(page).getByRole('textbox', { name: '审稿问题' }).fill(AUTHOR_NOTE)
    await chapterView.view(page).getByRole('button', { name: '按 1 项意见修稿' }).waitFor({ state: 'visible' })
    assert.equal(await finalizeNow.count(), 0, '添了意见后主按钮换成修稿')
    measured.authorNote = true
  }
  measured.reviseMs = await runAndWait(page, () => revise.click(), `第 ${chapterNumber} 章修稿`, confirmations)
  await chapterView.merge(page).waitFor({ state: 'visible', timeout: 30_000 })
    .catch(async () => { throw new Error(`第 ${chapterNumber} 章修稿结束后没有出现修稿合并\n${await runSheetText(page)}`) })
  await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
  const before = await runsStarted(page)
  await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
  await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: MODEL_WAIT })
  // 完成合并只在需要复验时才起运行：起了就等它结束。
  if (await page.evaluate(b => window.__realRunsStarted.count > b, before)) measured.recheckMs = await untilRunEnds(page, before, `第 ${chapterNumber} 章合并后复验`, confirmations)
  return measured
}

/** 知识库里没有缺向量的块：嵌入失败时应用会静默降级为只按字词检索，这里要分辨出来。 */
async function assertAllVectors(context, what) {
  const vectorless = await read(context, 'kb:get-vectorless-count')
  assert.equal(vectorless?.count, 0, `${what}后知识库有缺向量的块：${JSON.stringify(vectorless)}`)
  const degraded = context.diagnostics.filter(line => /FTS-only|embedding failed/iu.test(line))
  assert.deepEqual(degraded, [], `${what}时嵌入降级为只按字词检索`)
  return vectorless.count
}

async function chapterFacts(context, chapterNumber) {
  const drafts = await read(context, 'db:draft-list', chapterNumber)
  return drafts.map(draft => ({ version: draft.version, status: draft.status }))
}

async function postProcessRecord(context, chapterNumber) {
  const session = await uiSession(context.app)
  const run = await context.invoke(context.page, 'db:post-process-get-latest-run', 'chapter_finalize', String(chapterNumber), session.projectPath, session)
  const steps = run ? await context.invoke(context.page, 'db:post-process-get-steps', run.id, session.projectPath, session) : []
  return steps.map(step => ({ key: step.stepKey, ok: Boolean(step.ok) })).sort((a, b) => a.key.localeCompare(b.key))
}

/** 重启后重新进入作品：重新装会话记录，从书房或落点打开，等流程脊出现。 */
async function restartAndOpen(context) {
  await context.restart()
  await trackOpenedSession(context.app)
  await stage.openAfterRestart(context.page, BOOK)
  await stage.chapterList(context.page).or(stage.stageButton(context.page, '正文')).first().waitFor({ state: 'visible', timeout: 60_000 })
  if (!await stage.chapterList(context.page).isVisible()) await stage.stageButton(context.page, '正文').click()
  // 重启后界面可能落在上次的页面而没有重新打开作品；没有记下会话时用 Ctrl K 重开一次。
  if (!await context.app.evaluate(() => globalThis.__driveOpened)) await stage.openFromPalette(context.page, BOOK)
  // 流程脊可能早于 project:open 返回就已可见：等会话记下再往下走，免得读库时还没有租约。
  const deadline = Date.now() + 60_000
  while (!await context.app.evaluate(() => Boolean(globalThis.__driveOpened?.leaseId))) {
    if (Date.now() > deadline) throw new Error('重启后 60 秒内没有记下界面打开作品的会话')
    await context.page.waitForTimeout(250)
  }
}

const REFERENCE_NOVEL = [
  ['第1章 雾港', '雾港的码头在清晨总是安静的。老船匠周伯把刨子搁在膝头，看着海面上一层层退去的白雾。他说这片海记得每一条沉下去的船，只是从不开口。'],
  ['第2章 铜铃', '镇上的孩子都知道，渡口的铜铃只在退潮时响。可那一夜它在涨潮时响了三声，第二天，周伯的徒弟阿远再也没回来。'],
  ['第3章 旧账', '阿远的姐姐翻出周伯的旧账本，发现每一页的潮位都被人用红笔改过。她顺着那些红字，一路找到了废弃的灯塔。'],
]

/** 往运行侧页的可恢复区里找这一批：重启后没有进行中的批量运行，批次才列为可恢复。 */
async function batchRecovery(page) {
  await runSheet.openFromPalette(page)
  const card = runSheet.recovery(page).getByRole('article').filter({ hasText: /批量正文：/ })
  await card.first().waitFor({ state: 'visible', timeout: 30_000 })
  const button = card.first().getByRole('button', { name: '继续此批次' })
  return { text: await card.first().innerText(), continueEnabled: await button.isEnabled() }
}

export const REAL_SCENARIOS = {
  /** 主流程：第 1～3 章逐章写作、AI 审稿、按意见修稿并合并、定稿，后处理三步在真实回复下完成，知识库每块都有向量。 */
  'real-main': { real: true, setup: context => seedBook(context), run: async context => {
    const { page, shoot } = context
    const confirmations = []
    const chapters = {}
    for (const chapterNumber of [1, 2, 3]) {
      const write = await writeChapter(page, chapterNumber, confirmations)
      assert.ok(write.units > 0, `第 ${chapterNumber} 章写出了正文`)
      await shoot(`real-main-ch${chapterNumber}-written`)
      const review = await reviewReviseMerge(page, chapterNumber, confirmations)
      await shoot(`real-main-ch${chapterNumber}-merged`)
      const finalize = await finalizeAndPostProcess(page, chapterNumber)
      await shoot(`real-main-ch${chapterNumber}-finalized`)
      chapters[chapterNumber] = { write, review, finalize }
    }
    const db = {}
    for (const chapterNumber of [1, 2, 3]) {
      db[chapterNumber] = { drafts: await chapterFacts(context, chapterNumber), postProcess: await postProcessRecord(context, chapterNumber) }
      assert.ok(db[chapterNumber].drafts.some(draft => draft.status === 'finalized'), `第 ${chapterNumber} 章在库里已定稿`)
      assert.ok(db[chapterNumber].postProcess.length > 0 && db[chapterNumber].postProcess.every(step => step.ok), `第 ${chapterNumber} 章后处理各步在库里都成功`)
    }
    const documents = await read(context, 'kb:list-documents')
    assert.ok(Array.isArray(documents), JSON.stringify(documents))
    assert.deepEqual([1, 2, 3].filter(number => documents.some(document => document.finalizedChapter === number)), [1, 2, 3], '三章定稿都进了知识库')
    const vectorless = await assertAllVectors(context, '三章定稿')
    const search = await read(context, 'kb:search', '雾钟提前响起', 5)
    assert.ok(Array.isArray(search) && search.length > 0, `知识库检索没有结果：${JSON.stringify(search)}`)
    // 知识库页：配了检索模型时写着可以按意思查找，按字词查得到定稿章。
    await refs.open(page, 'knowledge')
    await page.getByText('可以按意思和字词查找。', { exact: true }).waitFor({ state: 'visible' })
    await refs.search(page, '林岚')
    await shoot('real-main-knowledge')
    const resultCount = await refs.results(page).getByRole('listitem').count()
    await openChapter(page, 3)
    await chapterView.postProcess(page).waitFor({ state: 'visible' })
    return { chapters, db, knowledge: { documents: documents.length, vectorless, searchHits: search.length, uiResults: resultCount }, confirmations }
  } },

  /** #578 与重启：删掉已定稿的第 2 章，重启后第 2 章不在、其余都在；第 4 章照常写；第 2 章蓝图未保存时不给写作入口，保存后在原位置重写并定稿。 */
  'real-gap': { real: true, setup: context => seedBook(context, { finalized: [1, 2, 3] }), run: async context => {
    const { shoot } = context
    let { page } = context
    const confirmations = []
    const measured = {}
    await openChapter(page, 2)
    await chapterView.more(page, '删除正文…')
    await page.getByRole('button', { name: '删除', exact: true }).click()
    const legacy = page.getByRole('button', { name: '我已人工核对/清理，继续删除' })
    if (await legacy.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await legacy.click()
    await page.waitForFunction(() => !document.querySelector('.stage-ch')?.textContent?.includes('已定稿，只读'), null, { timeout: 60_000 })
    measured.afterDelete = { rows: await stage.chapterRows(page), chapter2: await chapterFacts(context, 2) }
    assert.deepEqual(measured.afterDelete.chapter2.filter(draft => draft.status === 'finalized'), [], '第 2 章的定稿删掉了')
    await shoot('real-gap-deleted')

    await restartAndOpen(context)
    page = context.page
    const rows = await stage.chapterRows(page)
    const phase = number => rows.find(row => row.number === number)?.phase
    measured.afterRestart = { rows }
    for (const number of [1, 3]) {
      const drafts = await chapterFacts(context, number)
      assert.ok(drafts.some(draft => draft.status === 'finalized'), `重启后第 ${number} 章仍是定稿`)
      measured.afterRestart[`chapter${number}`] = drafts
    }
    measured.afterRestart.chapter2 = await chapterFacts(context, 2)
    assert.deepEqual(measured.afterRestart.chapter2, [], '重启后第 2 章没有任何稿')
    assert.notEqual(phase(2), phase(1), `重启后第 2 章的状态与定稿章不同：${JSON.stringify(rows)}`)
    assert.equal(phase(1), phase(3), `重启后第 1、3 章同为定稿：${JSON.stringify(rows)}`)
    const blueprints = await read(context, 'db:blueprint-get-all')
    assert.equal(blueprints.length, TOTAL_CHAPTERS, '重启后蓝图都在')
    await shoot('real-gap-restarted')

    measured.chapter4 = await writeChapter(page, 4, confirmations)
    assert.ok(measured.chapter4.units > 0, '删掉中间一章后第 4 章照常写出正文')
    await shoot('real-gap-ch4-written')

    await blueprint.open(page)
    const gap = page.locator('.pi-notice').filter({ hasText: '第 2 章的正文已删除' })
    await gap.waitFor({ state: 'visible' })
    await blueprint.planItem(page, 2).click()
    await blueprint.titleInput(page).fill(`${stageChapterTitle(2)}（重写）`)
    await gap.getByText('先保存第 2 章蓝图，再写这一章。').waitFor({ state: 'visible' })
    measured.unsavedNotice = await gap.innerText()
    assert.equal(await gap.getByRole('button', { name: '写第 2 章', exact: true }).count(), 0, '蓝图未保存时缺口提示里没有写作入口')
    await shoot('real-gap-unsaved-blueprint')
    await blueprint.card(page).getByRole('button', { name: '保存此章' }).click()
    const writeGap = gap.getByRole('button', { name: '写第 2 章', exact: true })
    await writeGap.waitFor({ state: 'visible' })
    measured.savedNotice = await gap.innerText()
    // 缺口章的写作入口把作者带到第 2 章的单章视图，由那里的写作按钮接手。
    const before = await runsStarted(page)
    await writeGap.click()
    const started = await page.waitForFunction(b => window.__realRunsStarted.count > b, before, { timeout: 15_000 }).then(() => true, () => false)
    if (!started) await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    measured.chapter2RewriteMs = await untilRunEnds(page, before, '重写第 2 章', confirmations)
    await openChapter(page, 2)
    await chapterView.prose(page).filter({ hasText: /\S/ }).first().waitFor({ state: 'visible', timeout: 30_000 })
    measured.chapter2Rewrite = await chapterFacts(context, 2)
    assert.ok(measured.chapter2Rewrite.length > 0, '第 2 章在原位置写出了新稿')
    await shoot('real-gap-ch2-rewritten')
    measured.chapter2Finalize = await finalizeAndPostProcess(page, 2)
    await blueprint.open(page)
    measured.gapNoticeAfterFinalize = await page.locator('.pi-notice').filter({ hasText: '第 2 章的正文已删除' }).count()
    assert.equal(measured.gapNoticeAfterFinalize, 0, '第 2 章重写定稿后缺口提示消失')
    await openChapter(page, 2)
    await chapterView.postProcess(page).waitFor({ state: 'visible' })
    return { ...measured, confirmations }
  } },

  /** #582：批量写第 3、4 章，第 3 章写完后暂停（暂停中点定稿立即提示还不能定稿）；取消后批次可续，作者定稿第 3 章后批次列为来源已变化、不能继续，第 3 章可以重新打开；再重启仍不能继续。 */
  'real-batch': { real: true, setup: context => seedBook(context, { finalized: [1, 2] }), run: async context => {
    const { shoot } = context
    let { page } = context
    const measured = {}
    await blueprint.open(page)
    const before = await runsStarted(page)
    await blueprint.startBatch(page, 2)
    await runSheet.waitUntilOpen(page)
    // 暂停按钮一出现就点：第一次点就生效。
    await runSheet.sheet(page).getByRole('button', { name: '暂停批量创作' }).click()
    await runSheet.sheet(page).getByText(/本章写完后暂停$/).waitFor({ state: 'visible', timeout: 5000 })
      .catch(async () => { throw new Error(`侧页出现即点暂停批量创作，没有进入「本章写完后暂停」\n${await runSheetText(page)}`) })
    const started = Date.now()
    await runSheet.sheet(page).getByText(/· 已暂停$/).waitFor({ state: 'visible', timeout: MODEL_WAIT })
      .catch(async () => { throw new Error(`批量创作 ${MODEL_WAIT / 60_000} 分钟内没有停在第 3 章之后\n${await runSheetText(page)}`) })
    measured.chapter3WrittenMs = Date.now() - started
    measured.runsStarted = await page.evaluate(b => window.__realRunsStarted.count - b, before)
    measured.paused = { chapter3: await chapterFacts(context, 3), chapter4: await chapterFacts(context, 4) }
    assert.ok(measured.paused.chapter3.length > 0, '批次写出了第 3 章')
    assert.deepEqual(measured.paused.chapter4, [], '暂停后没有写第 4 章')
    await shoot('real-batch-paused')

    // 暂停中的批次仍占着第 3、4 章：点定稿立即提示还不能定稿，不打开确认框。
    await openChapter(page, 3)
    const finalizeButton = chapterView.view(page).getByRole('button', { name: '定稿', exact: true })
    if (await finalizeButton.count() > 0) await finalizeButton.click()
    else await chapterView.more(page, '定稿…')
    const blocked = page.locator('.pi-toast').filter({ hasText: '第 3 章还不能定稿' })
    await blocked.waitFor({ state: 'visible', timeout: 10_000 })
      .catch(async () => { throw new Error(`批次暂停时点定稿没有提示「第 3 章还不能定稿」：${JSON.stringify(await page.locator('.pi-toast').allInnerTexts())}`) })
    measured.finalizeWhilePaused = {
      toast: await blocked.innerText(),
      dialogs: await chapterView.finalizeDialog(page, 3).count(),
      finalizedInDb: (await chapterFacts(context, 3)).some(draft => draft.status === 'finalized'),
    }
    await shoot('real-batch-finalize-while-paused')
    assert.equal(measured.finalizeWhilePaused.dialogs, 0, '批次占着本章时不打开定稿确认框')
    assert.equal(measured.finalizeWhilePaused.finalizedInDb, false, '批次暂停时第 3 章不会被定稿')

    // 暂停中的批次挡着退出（「创作任务仍在运行」），作者能走的路是在运行侧页取消它；取消后批次列为可恢复，这时定稿第 3 章（#582 的情形）。
    await runSheet.openFromPalette(page)
    const batchTitle = (await runSheet.activeTitles(page)).find(title => title.startsWith('批量草稿待审'))
    assert.ok(batchTitle, `运行侧页里有这一批：${await runSheetText(page)}`)
    await runSheet.sheet(page).getByRole('button', { name: `取消「${batchTitle}」` }).click()
    await page.waitForFunction(() => !document.querySelector('.stage-capsule:not([data-tone="ok"])'), null, { timeout: 60_000 })
    measured.recoveryBeforeFinalize = await batchRecovery(page)
    assert.equal(measured.recoveryBeforeFinalize.continueEnabled, true, '未定稿任何章的批次照旧可续')
    await openChapter(page, 3)
    measured.finalize = await finalizeAndPostProcess(page, 3)
    measured.recoveryAfterFinalize = await batchRecovery(page)
    assert.equal(measured.recoveryAfterFinalize.continueEnabled, false, '定稿其中一章后批次不能继续')
    assert.match(measured.recoveryAfterFinalize.text, /批次来源已变化，不能继续此批次/u)
    await openChapter(page, 3)
    await chapterView.view(page).getByRole('button', { name: '重新打开修改', exact: true }).click()
    await page.getByRole('dialog', { name: '重新打开第 3 章？' }).getByRole('button', { name: '重新打开', exact: true }).click()
    await chapterView.view(page).getByText('正在修改已定稿的第 3 章').waitFor({ state: 'visible', timeout: 60_000 })
      .catch(async () => { throw new Error(`第 3 章没能重新打开\n${await chapterView.view(page).innerText()}`) })
    measured.reopened = await chapterFacts(context, 3)
    await shoot('real-batch-reopened')

    await restartAndOpen(context)
    page = context.page
    measured.recovery = await batchRecovery(page)
    assert.equal(measured.recovery.continueEnabled, false, '作者定稿过其中一章的批次不能继续')
    assert.match(measured.recovery.text, /批次来源已变化，不能继续此批次/u)
    return measured
  } },

  /** #580：参考小说导入当前作品，真实 bge-m3 嵌入写进 LanceDB，每块都有向量，按意思能检索到参考原文。 */
  'real-refs': { real: true, setup: context => seedBook(context, { finalized: [1, 2] }), run: async context => {
    const { app, page, roots, shoot } = context
    const file = path.join(roots.temp, '雾港.txt')
    fs.writeFileSync(file, REFERENCE_NOVEL.map(([title, body]) => `${title}\n${body}\n`).join('\n'))
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, file)
    await stage.workMenuButton(page, BOOK).click()
    await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '小说拆解与仿写' })
    await dialog.getByTestId('import-target-current').click()
    await dialog.getByRole('button', { name: '选择', exact: true }).click()
    const confirmations = []
    const ms = await runAndWait(page, async () => {
      await dialog.getByRole('button', { name: `导入当前项目（${REFERENCE_NOVEL.length} 章）`, disabled: false }).click()
      await dialog.waitFor({ state: 'hidden' })
    }, '参考小说导入', confirmations)
    const sheet = await runSheetText(page)
    assert.match(sheet, /上一次运行[\s\S]*已完成/u, `参考小说导入没有完成：\n${sheet}`)
    await shoot('real-refs-imported')

    const vectorless = await assertAllVectors(context, '参考小说导入')
    const stats = await read(context, 'kb:stats')
    const hits = await read(context, 'kb:search', '渡口的铃在不该响的时候响了', 5)
    assert.ok(Array.isArray(hits) && hits.length > 0, `按意思检索没有结果：${JSON.stringify(hits)}`)
    const top = JSON.stringify(hits.slice(0, 3))
    assert.match(top, /铜铃|雾港|周伯|阿远/u, `按意思检索的前三条没有参考原文：${top}`)

    await refs.open(page, 'knowledge')
    await page.getByText('可以按意思和字词查找。', { exact: true }).waitFor({ state: 'visible' })
    await refs.search(page, '铜铃')
    const uiResults = await refs.results(page).innerText()
    assert.match(uiResults, /铜铃/u, '知识库页按字词查得到参考原文')
    return { importMs: ms, vectorless, stats, semanticTop: hits.slice(0, 3).map(hit => ({ score: hit.score, text: String(hit.text ?? hit.content ?? '').slice(0, 60) })),
      uiResults: uiResults.slice(0, 400), confirmations }
  } },
}
