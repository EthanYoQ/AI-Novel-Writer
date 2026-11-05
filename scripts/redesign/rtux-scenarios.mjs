// 本批真实模型实测缺陷的实机场景（假模型）：批次暂停时定稿给出说明、取消的批次标已取消、审稿没有可修意见时直接定稿、已保存的审稿候选不标可恢复。
import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { seedStageSample, untilGateHolds } from './scenarios.mjs'
import { openChapter } from './f491-scenarios.mjs'

const NOTHING_TO_REVISE = JSON.stringify({ summary: '未发现客观问题。', items: [
  { category: '措辞', severity: 'pass', description: '语言自然。' },
  { category: '节奏', severity: 'pass', description: '节奏合适。' },
  { category: '人物', severity: 'pass', description: '人物行为前后一致。' },
  { category: '连续性', severity: 'pass', description: '与前文没有矛盾。' },
], goalReviews: [] })

/** 第 3、4 章没有稿，批量创作从第 3 章写起。 */
const withoutChapters3And4 = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
  for (const chapterNumber of [3, 4]) {
    for (const draft of await invoke(page, 'db:draft-list', chapterNumber, projectPath, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
    }
  }
} })

export const RTUX_SCENARIOS = {
  'rtux-realtest-ux': { model: true, shell: 'stage', setup: withoutChapters3And4, run: async context => {
    const { page, fake } = context
    fake.gate.hold()
    await blueprint.open(page)
    await blueprint.startBatch(page, 2)
    await runSheet.waitUntilOpen(page)
    await untilGateHolds(fake.gate)
    await runSheet.sheet(page).getByRole('button', { name: '暂停批量创作' }).click()
    await runSheet.sheet(page).getByText(/本章写完后暂停$/).waitFor({ state: 'visible' })
    fake.gate.release()
    await runSheet.sheet(page).getByText(/· 已暂停$/).waitFor({ state: 'visible', timeout: 60_000 })

    // 暂停中的批次仍占着第 3 章：「定稿…」点了立即说明，不打开确认框。
    await openChapter(page, 3)
    await chapterView.more(page, '定稿…')
    const blocked = page.locator('.pi-toast').filter({ hasText: '第 3 章还不能定稿' })
    await blocked.waitFor({ state: 'visible', timeout: 10_000 })
    const finalizeBlocked = { toast: await blocked.innerText(), dialogs: await chapterView.finalizeDialog(page, 3).count() }
    assert.equal(finalizeBlocked.dialogs, 0, '批次占着本章时不打开定稿确认框')
    await context.shoot('rtux-finalize-blocked')

    // 从提示里取消批量创作：上一次运行写已取消，不写失败。
    await blocked.getByRole('button', { name: '取消批量创作' }).click()
    await runSheet.lastRun(page).waitFor({ state: 'visible', timeout: 30_000 })
    const cancelledRun = await runSheet.lastRun(page).innerText()
    assert.match(cancelledRun, /已取消/, '作者取消的批次写已取消')
    assert.doesNotMatch(cancelledRun, /失败|未完成/, '作者取消的批次不写失败')
    await context.shoot('rtux-batch-cancelled')

    // 审稿全部通过：主按钮直接是定稿，添加我的意见还在。
    fake.replyReview(NOTHING_TO_REVISE)
    await chapterView.review(page)
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const nothingToRevise = {
      hint: await chapterView.hint(page).innerText(),
      reviseButtons: await chapterView.reviseButton(page).count(),
      addNote: await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' }).count(),
    }
    assert.deepEqual({ reviseButtons: nothingToRevise.reviseButtons, addNote: nothingToRevise.addNote }, { reviseButtons: 0, addNote: 1 })
    await context.shoot('rtux-review-nothing-to-revise')

    // 运行侧页的审稿候选：已保存，条数不把通过项算成意见。
    await runSheet.openFromPalette(page)
    const card = runSheet.recovery(page).getByRole('article').filter({ hasText: '第3章审稿候选' })
    await card.waitFor({ state: 'visible', timeout: 30_000 })
    await card.scrollIntoViewIfNeeded()
    const reviewCandidate = await card.innerText()
    assert.match(reviewCandidate, /^已保存/, '已保存的审稿候选不标可恢复')
    assert.match(reviewCandidate, /0 条意见，4 项通过/)
    return { finalizeBlocked, cancelledRun, nothingToRevise, reviewCandidate }
  } },
}
