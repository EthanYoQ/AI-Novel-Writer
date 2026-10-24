// #504 实机场景：角色页开着时定稿一章，定稿后处理写入的角色状态不用重开作品就出现在角色页上；作者没保存的改动留着。
import assert from 'node:assert/strict'

import * as architecture from './pages/architecture.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const UPDATE = { marker: '灯室的门没有锁', evidence: '林岚把纸条夹进父亲的地图里。',
  currentState: { location: '灯塔顶层灯室', keyItems: '父亲的地图、钟绳上的纸条', recentEvents: '在灯室找到「别在涨潮时敲钟」的纸条' } }
const AUTHOR_DRAFT = '作者没保存的心事：怕涨潮'

function characterStateReply(prompt) {
  const id = /"characterId": "([^"]+)",\s*"name": "林岚"/u.exec(prompt)?.[1]
  if (!id || !prompt.includes(UPDATE.marker)) return '{"updates":[]}'
  return JSON.stringify({ updates: [{ characterId: id, currentState: UPDATE.currentState, evidence: { text: UPDATE.evidence } }] })
}

async function openCharacterState(page) {
  await architecture.open(page)
  await architecture.openCast(page)
  await architecture.castRow(page, '林岚').click()
  await stage.root(page).getByRole('group', { name: '档案视图' }).getByRole('button', { name: '当前状态', exact: true }).click()
}

async function stateFields(page) {
  return stage.root(page).locator('.cast-grid .cast-field').evaluateAll(fields => fields.map(field => ({
    label: field.querySelector('label')?.textContent?.trim(),
    hint: field.querySelector('.cast-field-hint')?.textContent?.trim() ?? null,
    value: field.querySelector('textarea')?.value ?? null,
  })))
}

const settled = page => page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('[aria-label="定稿后处理"] li')]
  return rows.some(row => row.querySelector('b')?.textContent === '角色状态更新')
    && rows.every(row => row.dataset.state === 'success' || row.dataset.state === 'failed')
    && !document.querySelector('.stage-capsule:not([data-tone="ok"])')
}, null, { timeout: 90_000 })

/** 在页面里记下「角色状态更新」一行变成成功的时刻，与之后角色页显示新值的时刻用同一时钟。 */
const watchCastStep = page => page.evaluate(() => {
  const done = () => [...document.querySelectorAll('[aria-label="定稿后处理"] li')]
    .some(row => row.querySelector('b')?.textContent === '角色状态更新' && row.dataset.state === 'success')
  const observer = new MutationObserver(() => {
    if (!done()) return
    window.__st504CastStepSucceededAt = performance.now()
    observer.disconnect()
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] })
})

async function finalizeChapter(page, chapterNumber) {
  if (!await stage.chapterButton(page, chapterNumber).isVisible()) await stage.stageButton(page, '正文').click()
  await chapterView.open(page, chapterNumber)
  await chapterView.finalize(page, chapterNumber)
  await settled(page)
}

const pick = (fields, label) => {
  const field = fields.find(item => item.label?.startsWith(label))
  assert.ok(field, `没有找到「${label}」一行`)
  return { hint: field.hint, value: field.value }
}

async function showEnglish(page) {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '外观')
  await page.getByLabel('界面语言').selectOption('en-US')
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
}

/** 角色页打开后每 10 毫秒看一次新地点是否已显示，不受截图耗时影响。返回角色页打开的时刻。 */
const watchNewLocation = page => page.evaluate(location => {
  const shown = () => [...document.querySelectorAll('.cast-grid .cast-field textarea')].some(field => field.value === location)
  const timer = setInterval(() => {
    if (!shown()) return
    window.__st504NewLocationShownAt = performance.now()
    clearInterval(timer)
  }, 10)
  setTimeout(() => clearInterval(timer), 15_000)
  return performance.now()
}, UPDATE.currentState.location)

async function finalizeAndReadCast(context, { authorDraft, prefix }) {
  const { page, fake } = context
  fake.replyCharacterState(characterStateReply)
  await openCharacterState(page)
  const before = await stateFields(page)
  if (authorDraft) await stage.root(page).getByRole('textbox', { name: /^心理状态/u }).fill(AUTHOR_DRAFT)

  await watchCastStep(page)
  await finalizeChapter(page, 3)
  const settledAt = await page.evaluate(() => performance.now())
  const steps = await chapterView.postProcessSteps(page)
  await openCharacterState(page)
  const castOpenedAt = await watchNewLocation(page)
  const after = await stateFields(page)
  await context.shoot(`${prefix}-zh`)
  const shownAt = await page.waitForFunction(() => window.__st504NewLocationShownAt, null, { timeout: 15_000 })
    .then(handle => handle.jsonValue(), () => null)
  const stepSucceededAt = await page.evaluate(() => window.__st504CastStepSucceededAt ?? null)
  const since = at => stepSucceededAt === null || at === null ? null : Math.round(at - stepSucceededAt)
  const timing = { stepToSettledMs: since(settledAt), stepToCastOpenMs: since(castOpenedAt), stepToNewValueShownMs: since(shownAt) }

  await showEnglish(page)
  await page.getByRole('group', { name: 'Profile view' }).waitFor({ state: 'visible' })
  const english = await stateFields(page)
  await context.shoot(`${prefix}-en`)
  return { before, steps, after, english, timing }
}

function expectRefreshed(measured, { authorDraft }) {
  const { before, steps, after, english } = measured
  try {
    assert.ok(steps.every(step => step.state === 'success'), '后处理每一步都成功')
    assert.deepEqual(pick(before, '当前位置'), { hint: '来源未知', value: '' }, '定稿前没有地点')
    assert.deepEqual(pick(after, '当前位置'), { hint: '定稿派生', value: UPDATE.currentState.location }, '定稿完成后马上读，就是新地点')
    assert.deepEqual(pick(after, '关键道具'), { hint: '定稿派生', value: UPDATE.currentState.keyItems }, '定稿完成后马上读，就是新道具')
    assert.deepEqual(pick(after, '心理状态'), authorDraft ? { hint: '作者输入', value: AUTHOR_DRAFT } : pick(before, '心理状态'),
      authorDraft ? '作者没保存的改动留着' : '没改过的心理状态不变')
    assert.deepEqual(pick(english, 'Location'), { hint: 'Derived from finalized prose', value: UPDATE.currentState.location }, '英文界面同样显示新地点')
  } catch (error) {
    error.message += `
${JSON.stringify(measured)}`
    throw error
  }
  return measured
}

export const ST504_SCENARIOS = {
  'st504-finalize-refreshes-cast': { model: true, shell: 'stage', setup: seedStageSample, run: async context => (
    expectRefreshed(await finalizeAndReadCast(context, { authorDraft: true, prefix: 'st504-draft' }), { authorDraft: true })
  ) },
  'st504-finalize-refreshes-cast-nodraft': { model: true, shell: 'stage', setup: seedStageSample, run: async context => (
    expectRefreshed(await finalizeAndReadCast(context, { authorDraft: false, prefix: 'st504-nodraft' }), { authorDraft: false })
  ) },
}
