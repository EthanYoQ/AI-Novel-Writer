// #484 实机场景：定稿后处理的角色状态更新在提交前，作者在角色页改了同一个字段，提交按字段冲突拒写。
// 步骤详情要用中英文说明原因和作者能做什么，不显示原始错误码。
import assert from 'node:assert/strict'

import * as architecture from './pages/architecture.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const EVIDENCE = '林岚把纸条夹进父亲的地图里。'

function characterStateReply(prompt) {
  const id = /"characterId": "([^"]+)",\s*"name": "林岚"/u.exec(prompt)?.[1]
  if (!id || !prompt.includes(EVIDENCE)) return '{"updates":[]}'
  return JSON.stringify({ updates: [{ characterId: id, currentState: { location: '灯塔顶层灯室', recentEvents: '在灯室找到纸条' }, evidence: { text: EVIDENCE } }] })
}

/** 卡住第 n 次 finalization-generation:commit（本流程第 1 次是章节要点，第 2 次是角色状态），放行前不进主进程的提交。 */
async function holdCommit(app, nth) {
  assert.ok(await app.evaluate(({ ipcMain }, target) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('finalization-generation:commit')
    if (!original) return false
    const gate = Promise.withResolvers()
    globalThis.__f484Commit = { calls: 0, held: false, release: gate.resolve }
    handlers.set('finalization-generation:commit', async (...args) => {
      const state = globalThis.__f484Commit
      if (++state.calls === target) { state.held = true; await gate.promise }
      return original(...args)
    })
    return true
  }, nth), '能在主进程里卡住定稿后处理的提交')
}

async function waitHeld(app) {
  for (const deadline = Date.now() + 60_000; !await app.evaluate(() => globalThis.__f484Commit.held); await new Promise(resolve => setTimeout(resolve, 100))) {
    assert.ok(Date.now() < deadline, '60 秒内角色状态的提交没有卡在门上')
  }
}

async function editLocationOnCastPage(page, value) {
  await architecture.open(page)
  await architecture.openCast(page)
  await architecture.castRow(page, '林岚').click()
  await stage.root(page).getByRole('group', { name: '档案视图' }).getByRole('button', { name: '当前状态', exact: true }).click()
  await stage.root(page).getByRole('textbox', { name: /^当前位置/u }).fill(value)
  await stage.root(page).getByRole('button', { name: '保存角色' }).click()
  await stage.root(page).locator('.cast-save-state').getByText('已保存', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
}

const failedDetail = page => chapterView.postProcess(page).locator('li[data-state="failed"] .stage-ch-post-detail')
const failedDetailEn = page => page.getByRole('region', { name: 'Post-finalization steps' }).locator('li[data-state="failed"] .stage-ch-post-detail')

export const F484_SCENARIOS = {
  'f484-field-conflict': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page, fake } = context
    fake.replyCharacterState(characterStateReply)
    await holdCommit(app, 2)
    if (!await stage.chapterButton(page, 3).isVisible()) await stage.stageButton(page, '正文').click()
    await chapterView.open(page, 3)
    await chapterView.finalize(page, 3)
    await waitHeld(app)
    assert.ok(fake.requests.includes('character-state'), '卡住的是角色状态生成之后的提交')
    await editLocationOnCastPage(page, '作者改的位置：码头')
    await app.evaluate(() => globalThis.__f484Commit.release())

    await stage.stageButton(page, '正文').click()
    await chapterView.open(page, 3)
    await failedDetail(page).first().waitFor({ state: 'visible', timeout: 60_000 })
    const zh = await failedDetail(page).first().innerText()
    await context.shoot('f484-field-conflict-zh')

    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    await page.keyboard.press('Escape')
    await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
    await failedDetailEn(page).first().waitFor({ state: 'visible', timeout: 30_000 })
    const en = await failedDetailEn(page).first().innerText()
    await context.shoot('f484-field-conflict-en')

    assert.match(zh, /^正文定稿已保存，但角色卡没有自动更新：生成期间/u, '中文说明字段在生成期间被改动')
    assert.match(en, /^The finalized chapter text is saved, but the character card was not updated: this character's current state changed while this step was running/u, '英文说明')
    for (const text of [zh, en]) assert.doesNotMatch(text, /Error invoking|FINALIZED_CHARACTER/u, '不显示原始错误码')
    assert.doesNotMatch(en, /\p{Script=Han}/u, '英文说明不带汉字')
    return { zh, en, commits: await app.evaluate(() => globalThis.__f484Commit.calls), requests: fake.requests }
  } },
}
