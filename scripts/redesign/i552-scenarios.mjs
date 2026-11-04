// #552：角色状态更新的模型回复始终不合合同时，定稿后处理卡给出人话说明；作者重试与首跑一样发 3 次请求；
// 在设置里给「定稿后处理」换了分工模型后，重试发给新模型，运行卡也显示新模型。
import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { seedStageSample } from './scenarios.mjs'
import { finalizeChapter } from './f491-scenarios.mjs'

const MINI = Object.freeze({ ...FAKE_MODEL, id: 'i552-mini', name: '驱动夹具小模型', modelName: 'gpt-4.1-mini' })
/** 首跑与每次重试都发 3 次：首发加 2 次修正。 */
const REQUESTS_PER_RUN = 3

const BAD = {
  // 引文改了一个字，正文里精确匹配 0 次。
  paraphrase: id => ({ updates: [{ characterId: id, currentState: { recentEvents: '在灯室找到纸条' }, evidence: { text: '林岚把那张纸条夹进了父亲的地图里。' } }] }),
  // 字段平铺在 update 上，没有 currentState 对象。
  flat: id => ({ updates: [{ characterId: id, name: '林岚', recentEvents: '在灯室找到纸条', evidence: { text: '林岚把纸条夹进父亲的地图里。' } }] }),
}

const settled = page => page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('[aria-label="定稿后处理"] li')]
  return rows.some(row => row.querySelector('b')?.textContent === '角色状态更新')
    && rows.every(row => ['success', 'failed', 'retired'].includes(row.dataset.state))
    && !document.querySelector('.stage-capsule:not([data-tone="ok"])')
}, null, { timeout: 120_000 })

const castRow = page => chapterView.postProcess(page).locator('li').filter({ has: page.locator('b', { hasText: /^角色状态更新$/u }) })
const readRow = async page => ({ state: await castRow(page).getAttribute('data-state'), detail: (await castRow(page).locator('.stage-ch-post-detail').innerText()).trim() })
const castChats = fake => fake.chats.filter(chat => chat.kind === 'character-state')

function assertExplained(row, label) {
  assert.equal(row.state, 'failed', `${label}：角色状态更新记为失败`)
  assert.match(row.detail, /正文定稿已保存/u, `${label}：说明正文已保存`)
  assert.match(row.detail, /「分工模型」.*「定稿后处理」/u, `${label}：告诉作者可以换「定稿后处理」的模型`)
  assert.doesNotMatch(row.detail, /FINALIZED_CHARACTER|Error invoking/u, `${label}：不露原始错误码`)
}

async function waitChats(fake, count) {
  const deadline = Date.now() + 90_000
  while (castChats(fake).length < count) {
    assert.ok(Date.now() < deadline, `90 秒内角色状态请求没有达到 ${count} 次`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function assignFinalization(page, modelId) {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '分工模型')
  await page.locator('select[id$="-finalization"]').selectOption(modelId)
  await page.waitForFunction(value => {
    const element = [...document.querySelectorAll('label')].find(node => node.textContent === '定稿后处理')?.control
    // 下拉先显示新选择、再保存；aria-busy 结束才算真正存好。
    return element instanceof HTMLSelectElement && !element.disabled && element.value === value && element.getAttribute('aria-busy') !== 'true'
  }, modelId, { timeout: 10_000 })
  await stage.closeSettings(page)
}

async function retryOnce(context, button, label) {
  const { page, fake } = context
  const before = castChats(fake).length
  await button.click()
  await waitChats(fake, before + REQUESTS_PER_RUN)
  await settled(page)
  // 多等一会儿，确认没有第 4 次请求。
  await page.waitForTimeout(1500)
  const row = await readRow(page)
  await context.shoot(label)
  return { row, newChats: castChats(fake).slice(before).map(chat => chat.model) }
}

/** 运行侧页「上一次运行」卡片的说明行：开始时间 · 模型 · 状态。 */
async function lastRunMeta(page) {
  await runSheet.openFromPalette(page)
  const card = runSheet.anyCard(page).filter({ hasText: /^上一次运行/u })
  await card.waitFor({ state: 'visible', timeout: 10_000 })
  return (await card.locator('.run-card-meta').innerText()).trim()
}

const scenario = variant => ({ model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
  const saved = await invoke(page, 'llm:save-model', MINI)
  assert.equal(saved.success, true, saved.error)
} }), run: async context => {
  const { page, fake } = context
  fake.replyCharacterState(prompt => {
    const id = /"characterId": "([^"]+)",\s*"name": "林岚"/u.exec(prompt)?.[1]
    return id ? JSON.stringify(BAD[variant](id)) : '{"updates":[]}'
  })
  await finalizeChapter(page, 3)
  await waitChats(fake, REQUESTS_PER_RUN)
  await settled(page)
  await page.waitForTimeout(1500)
  const first = { row: await readRow(page), chats: castChats(fake).map(chat => chat.model) }
  await context.shoot(`i552-${variant}-1-finalized`)
  assertExplained(first.row, '首跑')
  assert.deepEqual(first.chats, Array(REQUESTS_PER_RUN).fill(FAKE_MODEL.modelName), '首跑发 3 次，用默认模型')

  const retrySameModel = await retryOnce(context, castRow(page).getByRole('button'), `i552-${variant}-2-retry`)
  assertExplained(retrySameModel.row, '原模型重试')
  assert.deepEqual(retrySameModel.newChats, Array(REQUESTS_PER_RUN).fill(FAKE_MODEL.modelName), '重试与首跑一样发 3 次')

  await assignFinalization(page, MINI.id)
  if (!await castRow(page).isVisible()) await chapterView.open(page, 3)
  const retryAfterSwitch = await retryOnce(context, castRow(page).getByRole('button'), `i552-${variant}-3-retry-after-switch`)
  assertExplained(retryAfterSwitch.row, '换模型后重试')
  assert.deepEqual(retryAfterSwitch.newChats, Array(REQUESTS_PER_RUN).fill(MINI.modelName), '换了「定稿后处理」的模型后，重试发给新模型')
  const runMeta = await lastRunMeta(page)
  await context.shoot(`i552-${variant}-4-run-card-after-switch`)
  assert.match(runMeta, new RegExp(MINI.name, 'u'), '运行卡显示新模型')

  await chapterView.open(page, 3)
  const cardRetry = await retryOnce(context, chapterView.postProcess(page).getByRole('button', { name: '重试失败步骤' }), `i552-${variant}-5-card-retry`)
  assertExplained(cardRetry.row, '整卡重试')
  assert.deepEqual(cardRetry.newChats, Array(REQUESTS_PER_RUN).fill(MINI.modelName), '整卡重试也用新模型、发 3 次')
  return { variant, first, retrySameModel, retryAfterSwitch, runMeta, cardRetry }
} })

export const I552_SCENARIOS = {
  'i552-paraphrase': scenario('paraphrase'),
  'i552-flat': scenario('flat'),
}
