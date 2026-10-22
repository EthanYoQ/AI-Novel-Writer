// RD-7 蓝图阶段与写作此章弹层的实机场景：对应计划 RD-7 的 live lane 1～10、perf 的 blueprint-timing 与评审导览。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapter from './pages/chapter.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as project from './pages/project.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { contrastFailures, firstLine, seedStageSample, untilGateHolds } from './scenarios.mjs'
import { STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

/** 示例作品的下一章：1、2 章定稿，权威下一章是 3。 */
const NEXT = 3

const PAGE_CONTRAST = [
  ['.stage-bp-h1', 4.5], ['.stage-bp-plan-name', 4.5], ['.stage-bp-title', 4.5], ['.stage-bp-ctl', 4.5], ['.stage-bp-person', 4.5],
  ['.stage-bp-field > label', 4.5], ['.stage-bp-eyebrow', 3], ['.stage-bp-plan-no', 3], ['.stage-bp-plan-top', 3],
  ['.stage-bp-plan-status', 3], ['.stage-bp-card-status', 3],
  ['.stage-bp-field > label em', 3], ['.stage-bp-role select', 4.5], ['.pi-split .pi-btn', 4.5],
]

/** 第 3 章的出场人物加上守塔人：一致性预检的线索要落在本章蓝图里的人物上。 */
const withKeeperInChapter3 = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path, session }) => {
  assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 3, title: STAGE_SAMPLE.titles[2], role: '发展',
    purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: ['林岚', '守塔人'],
    userGuidance: '前半章只写钟声，不写人脸。' }, path, session)).success, true)
} })

/**
 * 主进程里改写 db:continuity-list-before：第 1 章定稿里守塔人已死，作为一致性预检的夹具。保存安排等其余通道照常走真实处理。
 * 写稿时的上下文也读这条通道，夹具的来源不是真实定稿，所以开始写之前要换回原处理函数。
 */
async function injectDeadKeeper(app) {
  const wrapped = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || !handlers.has('db:continuity-list-before')) return false
    globalThis.__driveContinuityOriginal = handlers.get('db:continuity-list-before')
    handlers.set('db:continuity-list-before', () => [{
      draftId: 1, chapterNumber: 1, chapterTitle: '旧港', chapterNotes: '守塔人死于第一章的风暴。',
      source: { draftId: 1, finalizationId: 'drive-fixture', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: [{ category: 'character-state', entities: ['守塔人'], statement: '守塔人已经死亡。', sourceChapter: 1, evidence: '守塔人在风暴里没有再回来。' }],
    }])
    return true
  })
  assert.ok(wrapped, '能在主进程里替换连续性事实的读取')
}

function restoreContinuity(app) {
  return app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.set('db:continuity-list-before', globalThis.__driveContinuityOriginal))
}

/** 两种外壳各自从蓝图写下一章：旧外壳点「写作第 3 章」后在对话框里直接开始，不改任何字段。 */
async function writeNextEitherShell(page) {
  if (await stage.root(page).count() > 0) {
    await blueprint.open(page)
    await blueprint.writeNext(page)
    return
  }
  await project.openNode(page, '章节蓝图')
  await page.getByRole('button', { name: /^写作第\d+章$/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
}

export async function proseRequest(fake, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!fake.chats.some(chat => chat.kind === 'prose')) {
    assert.ok(Date.now() < deadline, `${timeoutMs} ms 内假模型没有收到写正文的请求`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return fake.chats
}

/** 在渲染进程里计时：点击 target 到 ready 选择器出现，单位毫秒，帧粒度。 */
async function msFromClick(page, target, readySelector, readyText) {
  await page.evaluate(({ readySelector, readyText }) => {
    let clickedAt = null
    let handledMs = null
    window.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
    document.addEventListener('click', () => { handledMs ??= performance.now() - clickedAt }, { once: true })
    window.__driveReady = new Promise((resolve, reject) => {
      let expired = false
      const deadline = setTimeout(() => {
        expired = true
        reject(new Error('20 秒内没有出现'))
      }, 20_000)
      const tick = frameAt => {
        if (expired) return
        const checkAt = performance.now()
        const shown = [...document.querySelectorAll(readySelector)].some(node =>
          (readyText === null || (node instanceof HTMLInputElement ? node.value : node.textContent).includes(readyText)) && node.getClientRects().length > 0)
        if (clickedAt !== null && shown) {
          clearTimeout(deadline)
          const round = value => Math.round(value * 10) / 10
          resolve({ ms: Math.round(performance.now() - clickedAt), handledMs: round(handledMs), frameMs: round(frameAt - clickedAt), layoutMs: round(performance.now() - checkAt) })
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { readySelector, readyText })
  await target.click()
  return page.evaluate(() => window.__driveReady)
}

const TIMING_CHAPTERS = 300

/** 300 章蓝图：示例作品的 12 章之外再补到 300 章，标题带章号便于定位。 */
const withManyBlueprints = context => seedStageSample(context, { totalChapters: TIMING_CHAPTERS, blueprintCount: TIMING_CHAPTERS, beforeReload: async ({ page, invoke, path, session }) => {
  const blueprints = Array.from({ length: TIMING_CHAPTERS - STAGE_SAMPLE.titles.length }, (_, index) => {
    const chapterNumber = STAGE_SAMPLE.titles.length + index + 1
    return { chapterNumber, title: `远航之${chapterNumber}`, role: '发展', purpose: '推进灯塔与沉船的线索',
      keyEvents: '林岚在灯塔里找到新的线索', characters: ['林岚'], suspenseHook: '', userGuidance: '', notes: '' }
  })
  assert.equal((await invoke(page, 'db:blueprint-upsert-many', blueprints, path, session)).success, true)
} })

export const BLUEPRINT_SCENARIOS = {
  'blueprint-finalize-next': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke, path, session }) => {
    for (const draft of await invoke(page, 'db:draft-list', 4, path, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
    }
    assert.equal((await invoke(page, 'config:set', { autoOpenNextChapterAfterFinalize: true })).success, true)
  } }), run: async ({ page }) => {
    await chapterView.finalize(page, 3, { untilReadOnly: false })
    await blueprint.popover(page).waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(await chapterView.title(page).innerText(), stageChapterTitle(4), '定稿后落到第 4 章的单章视图')
    const write = chapterView.view(page).getByRole('button', { name: '写作此章', exact: true })
    const toggle = chapterView.view(page).getByRole('button', { name: '本次写作选项', expanded: true })
    const popoverId = await blueprint.popover(page).getAttribute('id')
    const [writeBox, toggleBox, popoverBox] = await Promise.all([write.boundingBox(), toggle.boundingBox(), blueprint.popover(page).boundingBox()])
    const attached = Math.abs(popoverBox.y - (toggleBox.y + toggleBox.height) - 6) <= 1 || Math.abs(toggleBox.y - (popoverBox.y + popoverBox.height) - 6) <= 1
    assert.deepEqual([await toggle.getAttribute('aria-controls'), Math.abs(writeBox.y - toggleBox.y) <= 1, attached], [popoverId, true, true],
      `弹层由这一章「写作此章」旁的选项按钮打开，贴着它展开：${JSON.stringify({ writeBox, toggleBox, popoverBox })}`)
    assert.equal(await page.getByRole('dialog').count(), 1, '只弹出写作弹层，不再弹旧的创作对话框')
  } },
  'blueprint-regression': { model: true, setup: withKeeperInChapter3, run: async ({ page, fake }) => {
    await writeNextEitherShell(page)
    const chats = await proseRequest(fake)
    const prose = chats.find(chat => chat.kind === 'prose')
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    if (await stage.root(page).count() > 0) await stage.waitForProse(page, firstLine(FIXTURE_PROSE))
    else await chapter.editor(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 60_000 })
    return {
      shell: await stage.root(page).count() > 0 ? 'stage' : 'writer',
      requests: chats.map(chat => ({ kind: chat.kind, model: chat.model, sha256: digest(chat.messages) })),
      proseModel: prose.model,
      proseMessages: prose.messages,
    }
  } },

  'blueprint-page': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, 5).click()
    await blueprint.titleInput(page).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), '逐章规划')
    assert.equal(await blueprint.writeButton(page).innerText(), `写第 ${NEXT} 章`)
    assert.equal(await blueprint.plan(page).getByRole('listitem').count(), STAGE_SAMPLE.titles.length)
    assert.equal(await blueprint.titleInput(page).inputValue(), STAGE_SAMPLE.titles[4])
    const primaries = await stage.root(page).locator('.stage-bp-head .pi-btn--primary').count()
    assert.equal(primaries, 2, '页头只有写下一章这一个拆分主按钮（主按钮与箭头）')
    assert.deepEqual(await contrastFailures(page, PAGE_CONTRAST), [], '蓝图页文字对比度不足')
  } },

  'blueprint-popover': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.openWriteOptions(page)
    const popover = blueprint.popover(page)
    assert.deepEqual(await popover.locator('label').allTextContents(), ['本次模型 只用于这一次', '作者微操指导 可选', '知识库检索关键词 可选'])
    assert.equal(await popover.locator('details').evaluate(node => node.open), false, '检索关键词收在折叠的「更多」里')
    assert.equal(await page.getByRole('dialog').count(), 1, '只有一个小弹层，没有大表单')
    assert.match(await popover.getByRole('combobox').inputValue(), new RegExp(FAKE_MODEL.id))
  } },

  'blueprint-preflight': { model: true, shell: 'stage', setup: withKeeperInChapter3, run: async ({ app, page, fake }) => {
    await injectDeadKeeper(app)
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await blueprint.preflight(page).waitFor({ state: 'visible' })
    await blueprint.popover(page).getByText(/“守塔人”处于死亡终态/).waitFor({ state: 'visible' })
    assert.equal(fake.chats.length, 0, '有提醒时不开始写')
    for (const name of ['保存安排', '仅本次忽略', '改蓝图后重检']) await blueprint.preflight(page).getByRole('button', { name }).waitFor({ state: 'visible' })
  }, after: async ({ app, page, fake }) => {
    await restoreContinuity(app)
    await blueprint.preflight(page).getByRole('button', { name: '仅本次忽略' }).click()
    await runSheet.waitUntilOpen(page)
    await proseRequest(fake)
    await runSheet.waitForRunDone(page)
  } },

  'blueprint-clear': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.pageMenu(page, '清空全部蓝图…')
    const confirm = blueprint.confirmDialog(page, '清空全部蓝图？')
    await confirm.getByText(`将删除全部 ${STAGE_SAMPLE.titles.length} 章蓝图`).waitFor({ state: 'visible' })
    await confirm.getByRole('button', { name: '清空全部' }).click()
    await blueprint.emptyHeading(page).waitFor({ state: 'visible' })
    assert.equal(await blueprint.plan(page).count(), 0, '清空后没有章节规划列表')
    await page.getByRole('button', { name: 'AI 生成蓝图' }).waitFor({ state: 'visible' })
  } },

  'blueprint-save': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, 6).click()
    await blueprint.titleInput(page).fill('第二盏灯亮起')
    await stage.saveStatus(page).getByText('未保存').waitFor({ state: 'visible' })
    assert.equal(await stage.root(page).getByText('未保存', { exact: true }).count(), 1, '只有顶栏一处未保存提示')
    await page.keyboard.press('Control+S')
    await stage.saveStatus(page).getByText('已保存').waitFor({ state: 'visible' })
    await blueprint.pageMenu(page, '重新加载蓝图')
    await blueprint.planItem(page, 6).getByText('第二盏灯亮起').waitFor({ state: 'visible' })
  } },

  'blueprint-overwrite': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.openGenerate(page)
    const dialog = blueprint.generateDialog(page)
    await dialog.getByRole('button', { name: '覆盖' }).click()
    await dialog.getByText('已有蓝图会被覆盖，开始前再确认一次').waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: '开始生成' }).click()
    const confirm = blueprint.confirmDialog(page, '覆盖已有蓝图？')
    await confirm.getByText(`已有的 ${STAGE_SAMPLE.titles.length} 章蓝图会被新蓝图替换`).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('dialog').count(), 1, '覆盖确认不叠在生成对话框上')
  }, after: async ({ page }) => {
    await blueprint.confirmDialog(page, '覆盖已有蓝图？').getByRole('button', { name: '取消' }).click()
    await blueprint.generateDialog(page).getByRole('button', { name: '开始生成' }).waitFor({ state: 'visible' })
    assert.equal(await blueprint.generateDialog(page).getByRole('alert').count(), 0, '取消覆盖不当作错误')
    await blueprint.generateDialog(page).getByRole('button', { name: '取消' }).click()
    assert.equal(await blueprint.plan(page).getByRole('listitem').count(), STAGE_SAMPLE.titles.length, '取消覆盖后蓝图不变')
  } },

  'blueprint-batch': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
    for (const chapterNumber of [3, 4]) {
      for (const draft of await invoke(page, 'db:draft-list', chapterNumber, path, session)) {
        assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
      }
    }
  } }), run: async ({ page, fake }) => {
    fake.gate.hold()
    await blueprint.open(page)
    await blueprint.startBatch(page, 4)
    await runSheet.waitUntilOpen(page)
    await untilGateHolds(fake.gate)
    const card = runSheet.sheet(page).getByRole('article').filter({ hasText: '批量' }).first()
    await card.waitFor({ state: 'visible' })
    await runSheet.sheet(page).getByRole('button', { name: '暂停批量创作' }).waitFor({ state: 'visible' })
    return { cards: await runSheet.activeTitles(page) }
  }, after: async ({ page, fake }) => {
    await runSheet.sheet(page).getByRole('button', { name: /^取消「/ }).click()
    fake.gate.release()
    await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).waitFor({ state: 'visible', timeout: 60_000 })
  } },

  'blueprint-recover': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.generateRange(page, 13, 16)
    await runSheet.waitUntilOpen(page)
    const notice = page.getByRole('status').filter({ hasText: '有一份蓝图恢复稿' })
    await notice.waitFor({ state: 'visible', timeout: 60_000 })
    await notice.getByRole('button', { name: '编辑恢复稿' }).click()
    await stage.tab(page, '蓝图恢复稿').waitFor({ state: 'visible' })
    const recovery = page.getByLabel('蓝图恢复')
    await recovery.getByRole('button', { name: '保存恢复蓝图' }).waitFor({ state: 'visible' })
    const proceed = recovery.getByRole('button', { name: '继续生成缺少的章节' })
    await proceed.waitFor({ state: 'visible' })
    assert.equal(await proceed.isEnabled(), true, '恢复稿里可以接着生成缺少的章节')
    // 纸墨恢复页把待完成的章节范围写在提示正文的末尾，不再单独成段。
    const remainingText = await recovery.getByText(/待完成第 \d+ 至 \d+ 章/).innerText()
    return { remaining: remainingText.match(/待完成第 \d+ 至 \d+ 章[^。]*。/)?.[0] ?? remainingText }
  }, after: async ({ page, fake }) => {
    const before = fake.chats.length
    await page.getByLabel('蓝图恢复').getByRole('button', { name: '继续生成缺少的章节' }).click()
    const deadline = Date.now() + 30_000
    while (fake.chats.length === before) {
      assert.ok(Date.now() < deadline, '继续生成没有发出模型请求')
      await page.waitForTimeout(200)
    }
  } },

  'blueprint-recover-error-en': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ page, shoot }) => {
    await blueprint.open(page)
    await blueprint.generateRange(page, 13, 16)
    await runSheet.waitUntilOpen(page)
    const notice = page.getByRole('status').filter({ hasText: '有一份蓝图恢复稿' })
    await notice.waitFor({ state: 'visible', timeout: 60_000 })
    await notice.getByRole('button', { name: '编辑恢复稿' }).click()
    await stage.tab(page, '蓝图恢复稿').waitFor({ state: 'visible' })
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
    const recovery = page.getByRole('region', { name: 'Blueprint recovery' })
    await recovery.waitFor({ state: 'visible' })
    await recovery.locator('.cm-content').click()
    await page.keyboard.press('Control+A')
    await page.keyboard.insertText('[{"chapterNumber":13,"title":"Fog"}]')
    await recovery.getByRole('button', { name: 'Save recovered blueprints' }).click()
    const alert = recovery.getByRole('alert')
    await alert.waitFor({ state: 'visible' })
    const observed = { alert: await alert.innerText(), lang: await page.evaluate(() => document.documentElement.lang) }
    await shoot('blueprint-recover-error-en')
    assert.equal(observed.lang, 'en-US')
    assert.doesNotMatch(observed.alert, /\p{Script=Han}/u, '英文界面的恢复稿报错不带中文')
    assert.match(observed.alert, /^The content does not match the expected format: /u)
    return observed
  } },

  'blueprint-tour': { model: true, shell: 'stage', setup: withKeeperInChapter3, run: async ({ app, page }) => {
    const pause = ms => page.waitForTimeout(ms)
    await pause(1200)
    await blueprint.open(page)
    await pause(1800)
    await blueprint.planItem(page, 6).click()
    await pause(1200)
    await blueprint.titleInput(page).fill('第二盏灯亮起')
    await pause(1200)
    await page.keyboard.press('Control+S')
    await stage.saveStatus(page).getByText('已保存').waitFor({ state: 'visible' })
    await pause(1500)
    await blueprint.pageMenu(page, '清空全部蓝图…')
    await pause(2500)
    await blueprint.confirmDialog(page, '清空全部蓝图？').getByRole('button', { name: '取消' }).click()
    await pause(1000)
    await blueprint.openGenerate(page)
    await pause(2500)
    await blueprint.generateDialog(page).getByRole('button', { name: '覆盖' }).click()
    await pause(1500)
    await blueprint.generateDialog(page).getByRole('button', { name: '取消' }).click()
    await pause(1000)
    await page.getByRole('button', { name: '批量创作' }).click()
    await pause(2500)
    await blueprint.batchDialog(page).getByRole('button', { name: '取消' }).click()
    await pause(1000)
    await blueprint.openWriteOptions(page)
    await pause(2500)
    await page.keyboard.press('Escape')
    await injectDeadKeeper(app)
    await blueprint.writeNext(page)
    await blueprint.preflight(page).waitFor({ state: 'visible' })
    await pause(3500)
    await restoreContinuity(app)
    await blueprint.preflight(page).getByRole('button', { name: '仅本次忽略' }).click()
    await runSheet.waitUntilOpen(page)
    await runSheet.waitForRunDone(page)
    await pause(2500)
  } },

  'blueprint-timing': { model: false, setup: withManyBlueprints, run: async ({ page }) => {
    const stageShell = await stage.root(page).count() > 0
    const open = stageShell
      ? await msFromClick(page, stage.stageButton(page, '蓝图'), '.stage-bp-plan-item', `远航之${TIMING_CHAPTERS}`)
      : await msFromClick(page, project.tree(page).getByText('章节蓝图', { exact: true }), '.truncate', `远航之${TIMING_CHAPTERS}`)
    const target = stageShell ? blueprint.planItem(page, 150) : page.getByText('远航之150', { exact: true }).first()
    await target.scrollIntoViewIfNeeded()
    // 先把指针停在目标上：只计点击换章，不计指针移入时的悬停重绘。
    await target.hover()
    await page.waitForTimeout(300)
    const change = stageShell
      ? await msFromClick(page, target, '.stage-bp-title', '远航之150')
      : await msFromClick(page, target, 'h3', '远航之150')
    return { openMs: open.ms, switchMs: change.ms, open, switch: change, shell: stageShell ? 'stage' : 'writer' }
  } },
}
