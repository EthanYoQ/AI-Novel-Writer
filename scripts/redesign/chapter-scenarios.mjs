// RD-8 正文单章视图的实机场景：对应计划 RD-8 的 live lane 1～10、perf 的 chapter-open 与 typing-latency，以及评审导览。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import * as chapter from './pages/chapter.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as project from './pages/project.mjs'
import * as runPanel from './pages/run-panel.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { contrastFailures, firstLine, seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'

const isStage = async page => await stage.root(page).count() > 0

/** 单章视图的文字对比度：正文与要对照阅读的合并栏 4.5，说明文字 3（design-system 第 9 条）。 */
const CONTRAST = {
  page: [['.stage-ch-title', 4.5], ['.stage-ch .stage-ch-prose .cm-content', 4.5], ['.stage-ch-eyebrow', 3], ['.stage-ch-hint', 3], ['.stage-ch-version', 3]],
  sheet: [['.stage-ch-issue-text', 4.5], ['.stage-ch-sheet-summary', 4.5], ['.stage-ch-issue-tag', 3], ['.stage-ch-issue-quote', 3], ['.stage-ch-issue-meta', 3], ['.stage-ch-sheet-count', 3]],
  merge: [['.stage-ch-hunk-col', 4.5], ['.stage-ch-hunk-col:not([data-chosen="true"])', 4.5], ['.stage-ch-same', 3], ['.stage-ch-merge-legend', 3], ['.stage-ch-merge-note', 3]],
  post: [['.stage-ch-post-step b', 4.5], ['.stage-ch-post-detail', 3], ['.stage-ch-post-title small', 3]],
  focus: [['.stage-ch .stage-ch-prose .cm-content', 4.5], ['.stage-ch-title', 4.5], ['.stage-ch-focusbar > span:not([role])', 3]],
}
const assertContrast = async (page, checks, what) => assert.deepEqual(await contrastFailures(page, checks), [], `${what}文字对比度不足`)

/** 纸面与侧页的位置：侧页（运行或审稿）不盖住纸面，同一时间只开一个。 */
async function sheetLayout(page) {
  return page.evaluate(() => {
    const paper = document.querySelector('.stage-ch-page')?.getBoundingClientRect()
    const sheets = [...document.querySelectorAll('.pi-sheet')].filter(node => node.getClientRects().length > 0)
    return {
      sheets: sheets.map(node => node.querySelector('.pi-sheet-title')?.textContent),
      overlap: sheets.some(node => paper && node.getBoundingClientRect().left < paper.right - 1),
    }
  })
}

/**
 * 打开作品的流程在文件树读完后才回到作品页，那一步会收起运行侧页，比落点晚约半秒（实测落点 440ms、收起 1004ms），界面上没有可等的信号。
 * 场景要开运行侧页时先等它过去；审稿侧页不受它影响。
 */
const afterProjectOpenSettles = page => page.waitForTimeout(2000)

/** 预置示例作品；remember 把作品路径记进场景上下文，结束时据此重新打开作品读数据库。 */
const seed = ({ deleteChapters = [], extra } = {}) => context => seedStageSample(context, {
  landOnChapter3: deleteChapters.length === 0,
  beforeReload: async args => {
    const { page, invoke, path, session } = args
    context.projectPath = path
    for (const chapterNumber of deleteChapters) {
      for (const draft of await invoke(page, 'db:draft-list', chapterNumber, path, session)) {
        assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
      }
    }
    await extra?.(args)
  },
})

async function createDraft({ page, invoke, path, session }, chapterNumber, version, text) {
  const created = await invoke(page, 'db:draft-create', { chapterNumber, version, source: version > 1 ? 'rewrite' : 'write', content: text, wordCount: countUnits(text) }, path, session)
  assert.equal(created.success, true, created.error)
}

/** 界面打开作品后会话租约换了新的；核对数据库时回到书房，由驱动自己再打开一次拿会话。 */
async function reopenForReading({ page, invoke, reload, projectPath }) {
  await reload()
  const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  return { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
}

/** 第 n 章定稿正文的摘要与后处理各步的成败，两种外壳都从数据库读。 */
async function finalizedFacts(context, chapterNumber) {
  const { page, invoke, projectPath } = context
  const session = await reopenForReading(context)
  const drafts = await invoke(page, 'db:draft-list', chapterNumber, projectPath, session)
  const finalized = drafts.find(draft => draft.status === 'finalized')
  assert.ok(finalized, `第 ${chapterNumber} 章已定稿`)
  const full = await invoke(page, 'db:draft-get-full', finalized.id, projectPath, session)
  const run = await invoke(page, 'db:post-process-get-latest-run', 'chapter_finalize', String(chapterNumber), projectPath, session)
  const steps = run ? await invoke(page, 'db:post-process-get-steps', run.id, projectPath, session) : []
  return {
    contentSha256: createHash('sha256').update(full.content).digest('hex'),
    content: full.content,
    steps: steps.map(step => ({ key: step.stepKey, ok: Boolean(step.ok) })).sort((a, b) => a.key.localeCompare(b.key)),
  }
}

/**
 * 页面里进行中的运行胶囊挂上来过几次。点下触发运行的按钮之前取一次，交给 waitRunDone：
 * 只等「没有进行中的胶囊」会在运行还没挂出胶囊时空过。第一次调用时装上计数。
 */
async function runsStarted(page) {
  return page.evaluate(() => {
    if (!window.__rdRunsStarted) {
      window.__rdRunsStarted = { count: 0 }
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof Element && node.matches('.stage-capsule:not([data-tone="ok"])')) window.__rdRunsStarted.count++
          }
        }
      }).observe(document.body, { childList: true, subtree: true })
    }
    return window.__rdRunsStarted.count
  })
}

/**
 * 审稿或修稿结果送到单章视图时运行侧页已收起：等这次运行的胶囊挂上来过、且顶栏不再有进行中的胶囊（完成后的胶囊带 data-tone="ok"）。
 * 不一定起运行的步骤（完成合并只在需要复验时才起）不给 startedBefore，只等没有进行中的胶囊。
 */
async function waitRunDone(page, startedBefore) {
  if (!await isStage(page)) return runPanel.waitForWorkflowDone(page)
  if (await runSheet.sheet(page).isVisible()) return runSheet.waitForRunDone(page)
  const running = '.stage-capsule:not([data-tone="ok"])'
  if (startedBefore === undefined) return stage.root(page).locator(running).waitFor({ state: 'detached', timeout: 90_000 })
  await page.waitForFunction(({ before, selector }) => window.__rdRunsStarted.count > before && !document.querySelector(selector), { before: startedBefore, selector: running }, { timeout: 90_000 })
}

/** 两种外壳各自写第 3 章：新外壳在待写章的单章视图点「写作此章」，旧外壳从章节蓝图的「写作第3章」对话框直接开始。 */
async function writeChapter3(page) {
  if (await isStage(page)) {
    await chapterView.open(page, 3)
    const started = await runsStarted(page)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await runSheet.waitUntilOpen(page)
    await waitRunDone(page, started)
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 30_000 })
    return
  }
  await project.openNode(page, '章节蓝图')
  await page.getByRole('button', { name: /^写作第3章$/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
  await waitRunDone(page)
  await chapter.editor(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 30_000 })
}

/** 新外壳：审稿、按意见修稿、等合并视图。 */
async function reviewAndRevise(page) {
  const reviewing = await runsStarted(page)
  await chapterView.review(page)
  await waitRunDone(page, reviewing)
  const revising = await runsStarted(page)
  await chapterView.reviseButton(page).click()
  await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
  await waitRunDone(page, revising)
}

/** 两种外壳各自走完审稿、按意见修稿、全部用修稿合并、等合并后复验、定稿。 */
async function reviewReviseMergeFinalize(page) {
  if (await isStage(page)) {
    await reviewAndRevise(page)
    await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await waitRunDone(page)
    const finalizing = await runsStarted(page)
    await chapterView.finalize(page, 3)
    await chapterView.postProcess(page).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page, finalizing)
    return
  }
  await chapter.review(page)
  await chapter.reviseFromReview(page, FAKE_MODEL.id)
  await chapter.mergeDialog(page).waitFor({ state: 'visible', timeout: 60_000 })
  await chapter.completeMerge(page)
  await waitRunDone(page)
  await project.draftOfChapter(page, 3).click()
  await chapter.finalize(page, 3)
  await waitRunDone(page)
}

/** 计时：点击 target 到正文出现 text 且所在滚动区可以滚动，毫秒，不取整。frameMs 按动画帧检查，domMs 在 DOM 变化回调里记，不依赖动画帧。 */
async function openTiming(page, target, text) {
  const handle = await target.elementHandle()
  await page.evaluate(({ element, text }) => {
    let clickedAt = null
    let domMs = null
    element.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
    const ready = () => {
      const content = [...document.querySelectorAll('.cm-content')].find(node => node.textContent.includes(text) && node.getClientRects().length > 0)
      if (!content) return false
      for (let node = content; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) return true
      }
      return false
    }
    const observer = new MutationObserver(() => {
      if (clickedAt !== null && domMs === null && ready()) domMs = performance.now() - clickedAt
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    window.__driveOpen = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('20 秒内正文没有出现')), 20_000)
      const tick = () => {
        if (clickedAt !== null && ready()) {
          clearTimeout(deadline)
          observer.disconnect()
          const frameMs = performance.now() - clickedAt
          resolve({ frameMs, domMs: domMs ?? frameMs })
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { element: handle, text })
  await target.click()
  return page.evaluate(() => window.__driveOpen)
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}

/**
 * 按键到渲染：每个按键从 beforeinput 起，到正文 DOM 里出现这个字（MutationObserver 回调，domMs），
 * 再到其后第一帧（frameMs）。屏幕外窗口的动画帧可能被节流，两种口径都报。
 */
async function typingLatency(page, content, keys) {
  await content.evaluate(element => {
    window.__driveTyping = []
    let pending = null
    element.addEventListener('beforeinput', () => { pending = { start: performance.now() } }, { capture: true })
    new MutationObserver(() => {
      if (!pending || pending.dom !== undefined) return
      const current = pending
      current.dom = performance.now() - current.start
      requestAnimationFrame(() => {
        window.__driveTyping.push({ domMs: current.dom, frameMs: performance.now() - current.start })
      })
    }).observe(element, { childList: true, subtree: true, characterData: true })
  })
  for (const key of keys) {
    await page.keyboard.type(key)
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(300)
  const samples = await page.evaluate(() => window.__driveTyping)
  assert.ok(samples.length >= keys.length * 0.9, `只记到 ${samples.length} 次按键`)
  const round = value => Math.round(value * 10) / 10
  return {
    keys: samples.length,
    domP95Ms: round(percentile(samples.map(sample => sample.domMs), 0.95)),
    frameP95Ms: round(percentile(samples.map(sample => sample.frameMs), 0.95)),
    domMedianMs: round(percentile(samples.map(sample => sample.domMs), 0.5)),
    frameMedianMs: round(percentile(samples.map(sample => sample.frameMs), 0.5)),
  }
}

/** 正文里第一段长段落的第一个视觉行放了几个字：逐字取位置，换行时停。 */
function charsPerLine(page) {
  return chapterView.prose(page).evaluate(content => {
    const line = [...content.querySelectorAll('.cm-line')].find(node => (node.textContent ?? '').length > 60)
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let top = null
    let count = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let index = 0; index < node.textContent.length; index++) {
        range.setStart(node, index)
        range.setEnd(node, index + 1)
        const rect = range.getBoundingClientRect()
        if (top === null) top = rect.top
        if (rect.top > top + 4) return count
        count++
      }
    }
    return count
  })
}

const LONG_CHAPTER = 5
/** 1 万字的第 5 章草稿：50 段，每段 200 字，段首带段号便于定位。 */
const longParagraphHead = index => `第${index + 1}段。`
const LONG_TEXT = Array.from({ length: 50 }, (_, index) => {
  const head = longParagraphHead(index)
  return head + '雾是从海面上一层一层爬上来的林岚把潮汐表压在值班室的窗台上用铅笔圈出昨夜的那一格钟声比往常早了一刻潮水却没有任何变化'.repeat(4).slice(0, 200 - head.length)
}).join('\n\n')
/** 长章第 1 段的段首，用来判断长章正文是否已显示；与 LONG_TEXT 同源，改了正文守卫不会静默失效。 */
const LONG_TEXT_HEAD = longParagraphHead(0)

/** 打开 1 万字的第 5 章：新外壳点流程脊里的章，旧外壳点草稿箱里的草稿。 */
async function openLongChapter(page) {
  const target = await isStage(page) ? stage.chapterButton(page, LONG_CHAPTER) : project.draftOfChapter(page, LONG_CHAPTER)
  const longProse = (await proseOf(page)).getByText(LONG_TEXT_HEAD, { exact: false })
  assert.equal(await longProse.count(), 0, '点击前第 5 章没有打开，计时从点击算起')
  await target.scrollIntoViewIfNeeded()
  await target.hover()
  await page.waitForTimeout(300)
  return openTiming(page, target, LONG_TEXT_HEAD)
}

const proseOf = async page => await isStage(page) ? chapterView.prose(page) : chapter.editor(page)

/** 合并视图里每处改动当前选中的那一栏的文字。 */
const chosenTexts = page => chapterView.merge(page).locator('[data-chosen="true"]').allInnerTexts()

/**
 * 双侧页：第 3 章已审稿，默认展开审稿侧页；打开运行侧页时审稿侧页让出，从「更多」打开审稿报告时运行侧页让出。
 * 两种状态下都只有一个侧页、纸面不被盖住、正文一行不少于 24 字、页面没有横向滚动。
 */
async function sheetsAt(page, width) {
  await page.setViewportSize({ width, height: 900 })
  await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
  await afterProjectOpenSettles(page)
  await runSheet.openFromPalette(page)
  await page.waitForTimeout(500)
  const run = { ...await sheetLayout(page), chars: await charsPerLine(page) }
  await chapterView.more(page, '审稿报告')
  await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  const review = { ...await sheetLayout(page), chars: await charsPerLine(page) }
  const horizontal = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  assert.deepEqual([run.sheets, run.overlap, review.sheets, review.overlap, horizontal], [['运行'], false, ['审稿报告'], false, false], '同一时间只开一个侧页，纸面不被盖住')
  assert.ok(run.chars >= 24 && review.chars >= 24, `侧页打开时正文一行 ${run.chars} / ${review.chars} 字`)
  return { width, charsWithRunSheet: run.chars, charsWithReviewSheet: review.chars }
}

export const CHAPTER_SCENARIOS = {
  /** lane 1：同一章在 trunk（旧外壳，--app-root）与 head（新外壳，--shell stage）走完写作、审稿、修稿、合并、定稿；两边 measured 相同即通过。 */
  'chapter-regression': { model: true, setup: seed({ deleteChapters: [3, 4] }), run: async context => {
    await writeChapter3(context.page)
    await reviewReviseMergeFinalize(context.page)
    const shell = await isStage(context.page) ? 'stage' : 'writer'
    const facts = await finalizedFacts(context, 3)
    // 读数据库要回到书房重新打开作品；新外壳再打开一次作品与第 3 章，截图停在定稿视图。
    if (shell === 'stage') {
      await stage.openFromLibrary(context.page, STAGE_SAMPLE.name)
      await chapterView.open(context.page, 3)
      await chapterView.postProcess(context.page).waitFor({ state: 'visible', timeout: 30_000 })
    }
    return { shell, ...facts }
  } },

  /** lane 2：草稿状态的主按钮是 AI 审稿，生命周期停在审稿。 */
  'chapter-draft': { model: false, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 4)
    await chapterView.prose(page).getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).waitFor({ state: 'visible' })
    assert.equal(await chapterView.primary(page).innerText(), 'AI 审稿')
    assert.equal(await chapterView.lifecycleCurrent(page).innerText(), '审稿')
    assert.match(await chapterView.versionButton(page).innerText(), /^草稿 v1 · \d+ 字/)
    await assertContrast(page, CONTRAST.page, '单章视图')
  } },

  /** lane 3：审稿后侧页展开，勾选数与主按钮「按 N 项意见修稿」、侧页底部计数同步。 */
  'chapter-review': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 4)
    const started = await runsStarted(page)
    await chapterView.review(page)
    await waitRunDone(page, started)
    const sheet = chapterView.reviewSheet(page)
    const counts = async () => ({ button: await chapterView.reviseButton(page).innerText(), footer: await sheet.locator('.stage-ch-sheet-count').innerText() })
    const total = await sheet.getByRole('checkbox').count()
    const before = await counts()
    await sheet.getByRole('checkbox').first().uncheck({ force: true })
    const unchecked = await counts()
    await sheet.getByRole('checkbox').first().check({ force: true })
    const rechecked = await counts()
    assert.deepEqual({ before, unchecked, rechecked }, {
      before: { button: '按 1 项意见修稿', footer: `1 / ${total}` },
      unchecked: { button: '按 0 项意见修稿', footer: `0 / ${total}` },
      rechecked: { button: '按 1 项意见修稿', footer: `1 / ${total}` },
    }, '勾选数与主按钮、侧页计数同步')
    assert.equal(await chapterView.reviseButton(page).isEnabled(), true)
    assert.deepEqual(await sheetLayout(page), { sheets: ['审稿报告'], overlap: false }, '审稿完成后只开审稿侧页，不盖住纸面')
    await assertContrast(page, CONTRAST.sheet, '审稿侧页')
  } },

  /**
   * #438：「留作草稿」批次里第 4 章以第 3 章候选稿为前驱写成；作者随后改了第 3 章，再把 3、4 章逐章定稿。
   * 写第 5 章时模型照常出稿，保存不能因为第 4 章当初依据的第 3 章旧稿而被拒。
   */
  'chapter-write-after-edited-chain': { model: true, shell: 'stage', setup: seed({ extra: async ({ page, invoke, path, session }) => {
    const [third] = await invoke(page, 'db:draft-list', 3, path, session)
    assert.ok(third, '示例作品有第 3 章稿')
    const original = (await invoke(page, 'db:draft-get-full', third.id, path, session))?.content
    assert.equal(typeof original, 'string', '读到第 3 章正文')
    const fourth = STAGE_SAMPLE.drafts[4].text
    const created = await invoke(page, 'db:draft-create', { chapterNumber: 4, version: 2, source: 'rewrite', content: fourth, wordCount: countUnits(fourth),
      sourceDependencies: [{ kind: 'candidate', draftId: third.id, contentHash: createHash('sha256').update(original, 'utf8').digest('hex') }] }, path, session)
    assert.equal(created.success, true, created.error)
    const edited = `${original}\n\n作者审稿时补的一句：雾钟停了。`
    assert.equal((await invoke(page, 'db:draft-update-content', third.id, edited, countUnits(edited), path, session)).success, true)
  } }), run: async context => {
    const { page, fake, invoke, projectPath } = context
    for (const chapterNumber of [3, 4]) {
      await chapterView.open(page, chapterNumber)
      await chapterView.more(page, '定稿…')
      const finalizing = await runsStarted(page)
      await chapterView.finalizeDialog(page, chapterNumber).getByRole('button', { name: '确认定稿', exact: true }).click()
      await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
      await waitRunDone(page, finalizing)
      await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })
    }
    await chapterView.open(page, 5)
    const proseBefore = fake.chats.filter(chat => chat.kind === 'prose').length
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    // 运行侧页可能还停在第 4 章定稿那张「已完成」卡上，不能据它判断写完；只认第 5 章正文出现在纸面上。
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 90_000 })
    await runSheet.openFromPalette(page)
    const proseRequests = fake.chats.filter(chat => chat.kind === 'prose').length - proseBefore
    const rawIpcError = await runSheet.sheet(page).getByText(/Error invoking remote method|GENERATION_/).count()
    // 纸面出字只说明生成过；#438 是保存被拒，要从库里读回第 5 章的稿才算保存了。
    const session = await reopenForReading(context)
    const saved = await invoke(page, 'db:draft-list', 5, projectPath, session)
    const contents = await Promise.all(saved.map(async draft => (await invoke(page, 'db:draft-get-full', draft.id, projectPath, session))?.content ?? ''))
    const after = { proseRequests, rawIpcError, savedDrafts: saved.length, savedHasFixtureProse: contents.some(content => content.includes(FIXTURE_PROSE)) }
    assert.deepEqual(after, { proseRequests: 1, rawIpcError: 0, savedDrafts: 1, savedHasFixtureProse: true }, '第 5 章写完并存进库，运行侧页没有原始错误')
    await stage.openFromLibrary(page, STAGE_SAMPLE.name)
    await chapterView.open(page, 5)
    return after
  } },

  /** #411：第 3 章是旧版本留下的 reviewed 稿，重新审稿要真的请求模型并写回审稿，运行侧页不露原始 IPC 错误。 */
  'chapter-rereview-legacy': { model: true, shell: 'stage', setup: seed(), run: async ({ page, fake }) => {
    await chapterView.open(page, 3)
    const reviewsBefore = fake.chats.filter(chat => chat.kind === 'review').length
    const started = await runsStarted(page)
    await chapterView.view(page).getByRole('button', { name: '重新审稿', exact: true }).click()
    await waitRunDone(page, started)
    const reportShown = await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' })
      .waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false)
    await runSheet.openFromPalette(page)
    const after = {
      reviewRequests: fake.chats.filter(chat => chat.kind === 'review').length - reviewsBefore,
      reportShown,
      rawIpcError: await runSheet.sheet(page).getByText(/Error invoking remote method|GENERATION_/).count(),
    }
    assert.deepEqual(after, { reviewRequests: 1, reportShown: true, rawIpcError: 0 }, '重新审稿请求了模型并写回审稿报告，运行侧页没有原始 IPC 错误')
    return after
  } },

  /** lane 4：添加作者意见后修稿，修稿请求里带着这条意见。 */
  'chapter-manual': { model: true, shell: 'stage', setup: seed(), run: async ({ page, fake }) => {
    await chapterView.open(page, 4)
    const reviewing = await runsStarted(page)
    await chapterView.review(page)
    await waitRunDone(page, reviewing)
    const note = '守塔人的咳嗽要提前到第一段出现。'
    await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' }).click()
    await chapterView.reviewSheet(page).getByRole('textbox', { name: '审稿问题' }).fill(note)
    assert.equal(await chapterView.reviseButton(page).innerText(), '按 2 项意见修稿')
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    const revision = fake.chats.find(chat => chat.kind === 'revision')
    assert.ok(revision, '假模型收到了修稿请求')
    assert.ok(JSON.stringify(revision.messages).includes(note), '人工意见进入了修稿输入')
  } },

  /** lane 5：合并视图逐段选择后完成合并，草稿正文里是选中的那些文字。 */
  'chapter-merge': { model: true, shell: 'stage', setup: seed(), run: async context => {
    const { page } = context
    await chapterView.open(page, 4)
    await reviewAndRevise(page)
    const groups = chapterView.merge(page).getByRole('group', { name: /用哪一版$/ })
    const hunks = await groups.count()
    assert.ok(hunks >= 1, '修稿至少有一处改动')
    await groups.first().getByRole('button', { name: '用修稿' }).click()
    const manual = '（作者手改的一段。）'
    if (hunks > 1) {
      await groups.nth(1).getByRole('button', { name: '手动编辑' }).click()
      await chapterView.merge(page).getByRole('textbox').first().fill(manual)
    }
    context.chosen = await chosenTexts(page)
    context.manual = hunks > 1 ? manual : null
    await assertContrast(page, CONTRAST.merge, '合并视图')
    return { hunks, chosen: context.chosen }
  }, after: async ({ page, chosen, manual }) => {
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const merged = (await chapterView.prose(page).innerText()).replace(/\s+/g, '')
    for (const text of chosen) assert.ok(merged.includes(text.replace(/\s+/g, '')), `合并结果含选中的「${text.slice(0, 12)}」`)
    if (manual) assert.ok(merged.includes(manual), '合并结果含手动编辑的文字')
  } },

  /** lane 6：定稿确认后正文只读，定稿视图列出后处理四步（正文文件与三步后处理）。 */
  'chapter-finalize': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 3)
    await chapterView.more(page, '定稿…')
    await chapterView.finalizeDialog(page, 3).waitFor({ state: 'visible' })
    const finalizing = await runsStarted(page)
    await chapterView.finalizeDialog(page, 3).getByRole('button', { name: '确认定稿', exact: true }).click()
    await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page, finalizing)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(await chapterView.prose(page).getAttribute('contenteditable'), 'false', '定稿后正文只读')
    await assertContrast(page, CONTRAST.post, '定稿后处理')
    return { steps: await chapterView.postProcessSteps(page) }
  } },

  /** lane 7：后处理里角色状态更新失败（夹具回复不是 JSON），点重试只重跑这一步：之后只有角色状态请求，没有章节要点与入库。 */
  'chapter-retry': { model: true, shell: 'stage', setup: seed(), run: async ({ page, fake }) => {
    fake.breakCharacterState()
    await chapterView.open(page, 3)
    const finalizing = await runsStarted(page)
    await chapterView.finalize(page, 3)
    await waitRunDone(page, finalizing)
    const failed = chapterView.postProcess(page).locator('li[data-state="failed"]')
    await failed.first().waitFor({ state: 'visible', timeout: 60_000 })
    const before = await chapterView.postProcessSteps(page)
    fake.breakCharacterState(false)
    const from = fake.requests.length
    const retrying = await runsStarted(page)
    await chapterView.postProcess(page).getByRole('button', { name: '重试失败步骤' }).click()
    await waitRunDone(page, retrying)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })
    const retried = fake.requests.slice(from)
    assert.deepEqual([...new Set(retried)], ['character-state'], '只重试了失败的角色状态更新')
    return { before, after: await chapterView.postProcessSteps(page), retried }
  } },

  /**
   * #420：角色状态请求断流两次。自动后处理只发一次请求、失败说明不含错误码；重开应用后点「重试失败步骤」恰好再发一次，
   * 仍断流时说明换成「没有返回完整结果」；再点这一步的「重试」第三次请求成功，后处理回到 3 / 3（重开后不再列正文文件一行）。
   */
  'chapter-retry-stream': { model: true, shell: 'stage', setup: seed(), run: async context => {
    const { fake } = context
    const characterRequests = () => fake.requests.filter(kind => kind === 'character-state').length
    const detail = () => chapterView.postProcess(context.page).locator('li[data-state="failed"] .stage-ch-post-detail').first()
    fake.dropCharacterState(2)
    await chapterView.open(context.page, 3)
    const finalizing = await runsStarted(context.page)
    await chapterView.finalize(context.page, 3)
    await waitRunDone(context.page, finalizing)
    await detail().waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(characterRequests(), 1, '自动后处理只发了一次角色状态请求')
    const firstError = await detail().innerText()
    await context.restart()
    // 重启后可能直接回到作品，也可能停在书房：用一个组合定位等其一出现，不留下没人接的等待。
    await stage.spine(context.page).or(stage.cover(context.page, STAGE_SAMPLE.name)).first().waitFor({ state: 'visible', timeout: 60_000 })
    if (!await stage.spine(context.page).isVisible()) await stage.openFromLibrary(context.page, STAGE_SAMPLE.name)
    await afterProjectOpenSettles(context.page)
    await chapterView.open(context.page, 3)
    await detail().waitFor({ state: 'visible', timeout: 60_000 })
    const retrying = await runsStarted(context.page)
    await chapterView.postProcess(context.page).getByRole('button', { name: '重试失败步骤' }).click()
    await waitRunDone(context.page, retrying)
    assert.equal(characterRequests(), 2, '重开后点重试恰好发出一次新请求')
    await detail().filter({ hasText: '没有返回完整结果' }).waitFor({ state: 'visible', timeout: 60_000 })
    const secondError = await detail().innerText()
    for (const error of [firstError, secondError]) assert.doesNotMatch(error, /[A-Z]+_[A-Z_]+/, '失败说明不应是原始错误码')
    await context.shoot('chapter-retry-stream-failed')
    const fixing = await runsStarted(context.page)
    await chapterView.postProcess(context.page).locator('li[data-state="failed"]').getByRole('button', { name: '重试' }).click()
    await waitRunDone(context.page, fixing)
    await chapterView.postProcess(context.page).getByText('3 / 3 完成').waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(characterRequests(), 3, '第二次重试发出第三次请求并成功')
    return { firstError, secondError, characterRequests: characterRequests(), steps: await chapterView.postProcessSteps(context.page) }
  } },

  /** lane 8：选中一段正文用选区工具条润色，预览后替换；再选一段润色后取消，正文不变。 */
  'chapter-selection': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 4)
    const prose = chapterView.prose(page)
    const line = prose.getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).first()
    await line.click({ clickCount: 3 })
    const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
    await toolbar.waitFor({ state: 'visible' })
    assert.deepEqual(await toolbar.getByRole('button').allInnerTexts(), ['润色', '扩写', '续写', '改成对话'])
    await toolbar.getByRole('button', { name: '润色' }).click()
    await toolbar.getByText(firstLine(FIXTURE_PROSE)).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await toolbar.getByRole('button', { name: '替换' }).isEnabled(), true, '预览后可以替换')
    await toolbar.getByRole('button', { name: '替换' }).click()
    await prose.getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible' })
    const second = prose.getByText('你父亲也问过钟的事').first()
    await second.click({ clickCount: 3 })
    await toolbar.getByRole('button', { name: '润色' }).click()
    await toolbar.getByRole('button', { name: '取消' }).waitFor({ state: 'visible' })
    await toolbar.getByRole('button', { name: '取消' }).click()
    await toolbar.waitFor({ state: 'hidden' })
    assert.ok((await prose.innerText()).includes('你父亲也问过钟的事'), '取消后原文不变')
    await prose.getByText(firstLine(FIXTURE_PROSE)).first().click({ clickCount: 3 })
    await toolbar.waitFor({ state: 'visible' })
  } },

  /** lane 9：第 4 章有两稿，删除当前这一稿要危险确认，之后版本切换器只剩另一稿。 */
  'chapter-delete': { model: false, shell: 'stage', setup: seed({ extra: args => createDraft(args, 4, 2, `${STAGE_SAMPLE.drafts[4].text}\n\n这是改写的第二稿，林岚决定先不问钟的事。`) }), run: async ({ page }) => {
    await chapterView.open(page, 4)
    assert.deepEqual(await chapterView.versions(page), ['草稿 v2 · 当前', '草稿 v1'])
    await chapterView.more(page, '删除这一稿…')
    const confirm = page.getByRole('dialog', { name: '删除第 4 章 v2？' })
    await confirm.getByText('删除后无法恢复；本章其他版本不受影响。').waitFor({ state: 'visible' })
    return { confirm: true }
  }, after: async ({ page }) => {
    await page.getByRole('dialog', { name: '删除第 4 章 v2？' }).getByRole('button', { name: '删除这一稿' }).click()
    await chapterView.versionButton(page).getByText(/^草稿 v1/).waitFor({ state: 'visible' })
    assert.deepEqual(await chapterView.versions(page), ['草稿 v1 · 当前'], '版本切换器不再列出删掉的那一稿')
  } },

  /** lane 10：1280 宽深色（--theme dark）下正文一行约 34 字；运行侧页打开后纸面收窄，正文一行仍不少于 24 字，页面没有横向滚动。 */
  'chapter-1280': { model: false, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    // 第 3 章已审稿，打开时默认展开审稿侧页；先收起它量纸面单独时的一行字数。
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '关闭审稿报告' }).click()
    const alone = await charsPerLine(page)
    await afterProjectOpenSettles(page)
    await runSheet.openFromPalette(page)
    await page.waitForTimeout(500)
    assert.equal(await runSheet.sheet(page).isVisible(), true, '运行侧页开着')
    const withSheet = await charsPerLine(page)
    const horizontal = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    assert.ok(alone >= 32 && alone <= 35, `1280 宽正文一行约 34 字，实际 ${alone}`)
    assert.ok(withSheet >= 24, `运行侧页打开后正文一行 ${withSheet} 字，被挤得太窄`)
    assert.equal(horizontal, false, '页面没有横向滚动')
    await assertContrast(page, CONTRAST.page, '单章视图')
    return { charsPerLine: alone, charsPerLineWithRunSheet: withSheet }
  } },

  /**
   * 审稿侧页属于展开它的那一稿：打开作品落在已审稿的第 3 章，侧页刚出现与 4 秒后一样展开（不再先开后收）；
   * 换到带历史审稿的已定稿第 2 章不跟过去，回到第 3 章仍展开。删掉第 4 章的稿，落点（最后一章在写的）就是第 3 章。
   */
  'chapter-sheet-landing': { model: false, shell: 'stage', setup: seed({ extra: async ({ page, invoke, path, session }) => {
    const [finalized] = (await invoke(page, 'db:draft-list', 2, path, session)).filter(draft => draft.status === 'finalized')
    const full = await invoke(page, 'db:draft-get-full', finalized.id, path, session)
    const expectedSource = { id: full.id, chapterNumber: 2, version: full.version, status: full.status, content: full.content }
    const created = await invoke(page, 'db:review-create', { baseDraftId: full.id, content: STAGE_SAMPLE.drafts[3].review, expectedSource }, path, session)
    assert.equal(created.success, true, created.error)
    for (const draft of await invoke(page, 'db:draft-list', 4, path, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
    }
  } }), run: async ({ page }) => {
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    const landing0s = (await sheetLayout(page)).sheets
    await page.waitForTimeout(4000)
    const landing4s = (await sheetLayout(page)).sheets
    await chapterView.open(page, 2)
    await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible' })
    const finalChapter = (await sheetLayout(page)).sheets
    await chapterView.view(page).getByRole('button', { name: '更多操作' }).click()
    const reportInMore = await page.getByRole('menuitem', { name: '审稿报告' }).isVisible()
    await page.keyboard.press('Escape')
    await chapterView.open(page, 3)
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    const backToReviewed = (await sheetLayout(page)).sheets
    assert.deepEqual({ landing0s, landing4s, finalChapter, reportInMore, backToReviewed },
      { landing0s: ['审稿报告'], landing4s: ['审稿报告'], finalChapter: [], reportInMore: true, backToReviewed: ['审稿报告'] },
      '审稿侧页只在已审稿的那一稿上展开，打开作品后不被收起')
    return { landing0s, landing4s, finalChapter, backToReviewed }
  } },

  'chapter-sheets-1280': { model: false, shell: 'stage', setup: seed(), run: ({ page }) => sheetsAt(page, 1280) },
  'chapter-sheets-1440': { model: false, shell: 'stage', setup: seed(), run: ({ page }) => sheetsAt(page, 1440) },

  /** 沉浸写作（Focus.dc.html）：纸面铺满内容区，底部写字数、设定里的每章目标与进度。截图浅深各一张。 */
  'chapter-focus': { model: false, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await chapterView.open(page, 4)
    await chapterView.prose(page).getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).waitFor({ state: 'visible' })
    await stage.focusToggle(page).click()
    const bar = chapterView.view(page).locator('.stage-ch-focusbar')
    await bar.waitFor({ state: 'visible' })
    const panel = await page.locator('.stage-panel').evaluate(node => {
      const style = getComputedStyle(node)
      return { margin: style.margin, radius: style.borderTopLeftRadius, shadow: style.boxShadow }
    })
    assert.deepEqual(panel, { margin: '0px', radius: '0px', shadow: 'none' }, '纸面全出血')
    const words = countUnits(STAGE_SAMPLE.drafts[4].text)
    assert.equal(await bar.locator('span').first().innerText(), `${words} / ${STAGE_SAMPLE.wordsPerChapter} 字`)
    assert.equal(await bar.getByRole('progressbar').getAttribute('aria-valuenow'), String(Math.min(words, STAGE_SAMPLE.wordsPerChapter)))
    const indent = await chapterView.prose(page).locator('.cm-line').first().evaluate(node => getComputedStyle(node).textIndent)
    assert.equal(indent, '36px', '正文首行缩进两字')
    await assertContrast(page, CONTRAST.focus, '沉浸写作')
    return { words, target: STAGE_SAMPLE.wordsPerChapter }
  } },

  /** 评审导览：草稿审稿、侧页勾选、按意见修稿、逐段合并、定稿后处理。配 --video 录 30～60 秒。 */
  'chapter-tour': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    const pause = ms => page.waitForTimeout(ms)
    await pause(1200)
    await chapterView.open(page, 4)
    await pause(2000)
    await chapterView.view(page).getByRole('button', { name: '检查维度' }).click()
    await pause(2000)
    await page.keyboard.press('Escape')
    const reviewing = await runsStarted(page)
    await chapterView.review(page)
    await waitRunDone(page, reviewing)
    await pause(3000)
    await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' }).click()
    await chapterView.reviewSheet(page).getByRole('textbox', { name: '审稿问题' }).pressSequentially('守塔人的咳嗽提前出现。', { delay: 90 })
    await pause(1500)
    const revising = await runsStarted(page)
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page, revising)
    await pause(2500)
    await chapterView.merge(page).getByRole('group', { name: /用哪一版$/ }).first().getByRole('button', { name: '用修稿' }).click()
    await pause(2000)
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await waitRunDone(page)
    await pause(2000)
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).click()
    await pause(3000)
    await chapterView.finalizeDialog(page, 4).getByRole('button', { name: '再看看' }).click()
    await pause(800)
    await chapterView.open(page, 3)
    await pause(1500)
    const finalizing = await runsStarted(page)
    await chapterView.finalize(page, 3)
    await waitRunDone(page, finalizing)
    await pause(3000)
  } },

  /** perf：从点击第 5 章（1 万字）到正文出现且纸面可以滚动。两种外壳都能跑。 */
  'chapter-open': { model: false, setup: seed({ extra: args => createDraft(args, LONG_CHAPTER, 1, LONG_TEXT) }), run: async ({ page }) => {
    return { ...await openLongChapter(page), shell: await isStage(page) ? 'stage' : 'writer' }
  } },

  /** perf：在 1 万字的第 5 章里连续输入 40 个字母，按键到渲染的 p95。两种外壳都能跑。 */
  'typing-latency': { model: false, setup: seed({ extra: args => createDraft(args, LONG_CHAPTER, 1, LONG_TEXT) }), run: async ({ page }) => {
    await openLongChapter(page)
    const content = await proseOf(page)
    await content.getByText(LONG_TEXT_HEAD, { exact: false }).first().click()
    await page.keyboard.press('End')
    const keys = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'.split('')
    return { ...await typingLatency(page, content, keys), shell: await isStage(page) ? 'stage' : 'writer' }
  } },
}
