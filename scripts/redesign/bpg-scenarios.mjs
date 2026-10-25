import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const GUIDANCE = '这一章只写雨夜，不要提前揭底。'
const NOTES = '作者先手写的要点：林岚已经拿到父亲的信。'
const REGENERATED = 3
const regeneratedTitle = chapterNumber => `重生成第${chapterNumber}章`

const SYNTAX_REPAIR_CHAPTER_LIST = /本次必须且只能完整返回以下 chapterNumber：([\d、]+)。/u
const COMPACT_SINGLE_CHAPTER = /必须且只能返回 chapterNumber=(\d+) 的一项/u
const BATCH_CHAPTER_RANGE = /为接下来的 第(\d+)章到第(\d+)章/u

function requestedChapters(prompt) {
  const listed = SYNTAX_REPAIR_CHAPTER_LIST.exec(prompt)
  if (listed) return listed[1].split('、').map(Number)
  const single = COMPACT_SINGLE_CHAPTER.exec(prompt)
  if (single) return [Number(single[1])]
  const range = BATCH_CHAPTER_RANGE.exec(prompt)
  if (!range) return null
  return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, index) => Number(range[1]) + index)
}

function blueprintReply(prompt) {
  const chapters = requestedChapters(prompt)
  if (!chapters) return null
  return JSON.stringify({ blueprints: chapters.map(chapterNumber => ({
    chapterNumber, title: regeneratedTitle(chapterNumber), role: '发展', purpose: '林岚确认钟声提前的原因',
    keyEvents: `第${chapterNumber}章：林岚在灯塔里找到新的线索`, characters: ['林岚'], relationships: [],
    suspenseHook: '钟声又一次提前响起',
  })) })
}

const withEmptyAuthorFields = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path, session }) => {
  for (let chapterNumber = 1; chapterNumber <= REGENERATED; chapterNumber++) {
    const current = await invoke(page, 'db:blueprint-get', chapterNumber, path, session)
    assert.ok(current, `示例作品有第 ${chapterNumber} 章蓝图`)
    assert.equal((await invoke(page, 'db:blueprint-upsert', { ...current, userGuidance: '', notes: '', notesUpdatedAt: '' }, path, session)).success, true)
  }
} })

const chapterCard = (page, chapterNumber) => page.getByRole('region', { name: `第 ${chapterNumber} 章蓝图` })

async function readChapter(page, chapterNumber) {
  await blueprint.planItem(page, chapterNumber).click()
  const card = chapterCard(page, chapterNumber)
  await card.waitFor({ state: 'visible' })
  return {
    title: await card.getByRole('textbox', { name: '章节标题' }).inputValue(),
    userGuidance: await card.getByRole('textbox', { name: /^作者微操指导/ }).inputValue(),
    notes: await card.getByRole('textbox', { name: /^章节要点/ }).inputValue(),
  }
}

async function fillAndSave(page, chapterNumber, field, value) {
  await blueprint.planItem(page, chapterNumber).click()
  await chapterCard(page, chapterNumber).getByRole('textbox', { name: field }).fill(value)
  await stage.saveStatus(page).getByText('未保存').waitFor({ state: 'visible' })
  await page.keyboard.press('ControlOrMeta+s')
  await stage.saveStatus(page).getByText('已保存').waitFor({ state: 'visible' })
}

export const BPG_SCENARIOS = {
  'bpg-regenerate-keeps-guidance': { model: true, shell: 'stage', setup: withEmptyAuthorFields, run: async ({ page, fake }) => {
    await blueprint.open(page)
    await fillAndSave(page, 1, /^章节要点/, NOTES)
    await fillAndSave(page, 2, /^作者微操指导/, GUIDANCE)
    const before = { 1: await readChapter(page, 1), 2: await readChapter(page, 2) }
    assert.deepEqual([before[1].notes, before[2].userGuidance], [NOTES, GUIDANCE], '作者字段在重新生成前已保存')

    fake.replyReview(blueprintReply)
    await blueprint.openGenerate(page)
    const dialog = blueprint.generateDialog(page)
    await dialog.getByLabel('本次蓝图章数').fill(String(REGENERATED))
    await dialog.getByRole('button', { name: '覆盖' }).click()
    await dialog.getByRole('button', { name: '开始生成' }).click()
    await blueprint.confirmDialog(page, '覆盖已有蓝图？').getByRole('button', { name: '覆盖并生成' }).click()
    await blueprint.continuePastArchitectureWarning(page)
    await runSheet.waitUntilOpen(page)
    await runSheet.waitForRunDone(page)
    assert.ok(fake.chats.some(chat => chat.kind === 'review'), '目录生成请求拿到了夹具蓝图')

    await blueprint.pageMenu(page, '重新加载蓝图')
    await blueprint.planItem(page, REGENERATED).getByText(regeneratedTitle(REGENERATED)).waitFor({ state: 'visible' })
    const after = { 1: await readChapter(page, 1), 2: await readChapter(page, 2) }
    assert.deepEqual(after, {
      1: { ...before[1], title: regeneratedTitle(1) },
      2: { ...before[2], title: regeneratedTitle(2) },
    }, '重新生成只换 AI 字段，作者微操指导与章节要点保留')
    await chapterCard(page, 2).getByRole('textbox', { name: /^作者微操指导/ }).scrollIntoViewIfNeeded()
    return { before, after }
  } },
}
