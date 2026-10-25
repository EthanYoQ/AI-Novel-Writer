// #512 实机场景：定稿后处理提交时项目数据已变的码要给作者可读说明并按实测摆重试；旧版本跑批里留下的步骤不再给重试。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import * as architecture from './pages/architecture.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { finalizeChapter, openChapter, openInUi } from './f491-scenarios.mjs'

const COMMIT = 'finalization-generation:commit'
const RETRY_BUTTONS = /^(重试|重试失败步骤|Retry|Retry failed steps)$/u

function characterStateReply(prompt) {
  const id = /"characterId": "([^"]+)",\s*"name": "林岚"/u.exec(prompt)?.[1]
  if (!id) return '{"updates":[]}'
  return JSON.stringify({ updates: [{ characterId: id, currentState: { location: '灯塔顶层灯室' }, evidence: { text: '林岚把潮汐表压在值班室的窗台上' } }] })
}

/**
 * 角色状态这一步的前两次提交（本流程第 2、3 次提交）按断线失败，第三次（自动重试的最后一次）卡住，等驱动放行。
 * 前两次失败只为让变化落在最后一次自动尝试上：更早发生的变化在之后的自动尝试里会先按来源已变拒绝。
 */
async function failTwiceThenHold(app) {
  assert.ok(await app.evaluate(({ ipcMain }, channel) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get(channel)
    if (!original) return false
    const gate = Promise.withResolvers()
    globalThis.__f512Commit = { calls: 0, held: false, release: gate.resolve }
    handlers.set(channel, async (...args) => {
      const state = globalThis.__f512Commit
      const call = ++state.calls
      if (call === 2 || call === 3) throw new Error('network error: synthetic lost commit')
      if (call === 4) { state.held = true; await gate.promise }
      return original(...args)
    })
    return true
  }, COMMIT), '能在主进程里替换定稿后处理的提交')
}

/** 直接 app.evaluate 取值时，Windows 上的 Electron 41 偶发报「Promise was collected」；先取句柄再读值、读完释放就不会（同 f484）。 */
async function waitHeld(app) {
  const held = async () => {
    const handle = await app.evaluateHandle(() => globalThis.__f512Commit.held)
    try { return await handle.jsonValue() } finally { await handle.dispose() }
  }
  for (const deadline = Date.now() + 90_000; !await held(); await new Promise(resolve => setTimeout(resolve, 100))) {
    assert.ok(Date.now() < deadline, '90 秒内角色状态的第三次提交没有卡在门上')
  }
}

async function deleteCharacter(page, name) {
  await architecture.open(page)
  await architecture.openCast(page)
  await architecture.castRow(page, name).click()
  await stage.root(page).getByRole('button', { name: '角色的更多操作' }).click()
  await page.getByRole('menuitem', { name: `删除角色「${name}」…` }).click()
  await page.getByRole('dialog', { name: `删除角色「${name}」？` }).getByRole('button', { name: '删除角色', exact: true }).click()
  await architecture.castRow(page, name).waitFor({ state: 'detached', timeout: 20_000 })
}

async function switchToEnglish(page) {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, '外观')
  await page.getByLabel('界面语言').selectOption('en-US')
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Settings sections' }).waitFor({ state: 'detached' })
}

const postRegion = (page, locale) => page.getByRole('region', { name: locale === 'en-US' ? 'Post-finalization steps' : '定稿后处理' })
/** 步骤名按定稿时的界面语言存下，切到英文后仍是中文。 */
const stepRow = (page, locale, label) => postRegion(page, locale).locator('li').filter({ has: page.locator('b', { hasText: new RegExp(`^${label}$`, 'u') }) })

async function readCard(page, locale, label) {
  const row = stepRow(page, locale, label)
  await row.waitFor({ state: 'visible', timeout: 60_000 })
  return {
    state: await row.getAttribute('data-state'),
    detail: await row.locator('.stage-ch-post-detail').innerText(),
    rowRetry: await row.getByRole('button', { name: RETRY_BUTTONS }).count(),
    cardRetry: await postRegion(page, locale).getByRole('button', { name: RETRY_BUTTONS }).count(),
    count: await postRegion(page, locale).locator('h2 small').innerText(),
  }
}

/** 驱动自己打开作品拿会话，用应用同一组 IPC 往第 3 章最新的跑批旁写一份旧版本的跑批：四步，文风自动学习按 legacyOk 成败。 */
async function writeLegacyRun({ page, invoke }, projectPath, legacyOk) {
  const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
  const draft = await invoke(page, 'db:draft-get-finalized', 3, projectPath, session)
  assert.ok(draft, '第 3 章没有定稿记录')
  const source = await invoke(page, 'db:continuity-read-source', draft.id, projectPath, session)
  assert.equal(source.status, 'valid', JSON.stringify(source))
  const created = await invoke(page, 'db:post-process-create-run', {
    triggerSourceType: 'chapter_finalize', triggerSourceId: '3', sourceLabel: '第3章定稿', finalizedSource: source.snapshot.source,
    steps: [
      { key: 'kb_import', label: '导入知识库', critical: true },
      { key: 'chapter_notes', label: '章节剧情要点', critical: true },
      { key: 'character_cards', label: '角色状态更新', critical: true },
      { key: 'style_analysis', label: '文风自动学习', critical: false },
    ],
  }, projectPath, session)
  assert.equal(created.success, true, JSON.stringify(created))
  for (const key of ['kb_import', 'chapter_notes', 'character_cards']) {
    assert.equal((await invoke(page, 'db:post-process-mark-step-ok', created.id, key, projectPath, session)).success, true)
  }
  const legacy = legacyOk
    ? await invoke(page, 'db:post-process-mark-step-ok', created.id, 'style_analysis', projectPath, session)
    : await invoke(page, 'db:post-process-mark-step-failed', created.id, 'style_analysis', '模型长时间没有响应', projectPath, session)
  assert.equal(legacy.success, true)
}

/** 旧版本的跑批不论文风自动学习当时成败，卡上都说明它已不再运行，不摆重试，完成数只算现在的三步。 */
const legacyStep = (legacyOk, name) => async context => {
  const { page } = context
  await finalizeChapter(page, 3)
  await writeLegacyRun(context, context.samplePath, legacyOk)
  await context.reload()
  await openInUi(context, context.samplePath)
  await openChapter(page, 3)
  const zh = await readCard(page, 'zh-CN', '文风自动学习')
  await context.shoot(`${name}-zh`)
  await switchToEnglish(page)
  const en = await readCard(page, 'en-US', '文风自动学习')
  await context.shoot(`${name}-en`)

  for (const card of [zh, en]) {
    assert.deepEqual({ rowRetry: card.rowRetry, cardRetry: card.cardRetry }, { rowRetry: 0, cardRetry: 0 }, '旧步骤不摆重试，整卡也没有可重试的步骤')
    assert.equal(card.state, 'retired', '旧步骤既不按失败标红，也不按完成计数')
  }
  assert.match(zh.detail, /旧版本/u, JSON.stringify(zh))
  assert.match(en.detail, /earlier version/u, JSON.stringify(en))
  assert.doesNotMatch(en.detail, /\p{Script=Han}/u, '英文说明不带汉字')
  assert.equal(zh.count, '3 / 3 完成', '完成数只算现在流程里的步骤')
  return { zh, en }
}

export const F512_SCENARIOS = {
  'f512-retired-character': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page, fake } = context
    fake.replyCharacterState(characterStateReply)
    await failTwiceThenHold(app)
    try {
      await openChapter(page, 3)
      await chapterView.finalize(page, 3)
      await waitHeld(app)
      assert.ok(fake.requests.includes('character-state'), '卡住的是角色状态生成之后的提交')
      await deleteCharacter(page, '林岚')
    } finally {
      await app.evaluate(() => globalThis.__f512Commit.release())
    }
    await page.waitForFunction(() => document.querySelectorAll('.stage-capsule:not([data-tone="ok"])').length === 0, null, { timeout: 90_000 })

    await openChapter(page, 3)
    const zh = await readCard(page, 'zh-CN', '角色状态更新')
    await context.shoot('f512-retired-character-zh')
    await switchToEnglish(page)
    const en = await readCard(page, 'en-US', '角色状态更新')
    await context.shoot('f512-retired-character-en')

    assert.equal(zh.state, 'failed', JSON.stringify(zh))
    for (const card of [zh, en]) {
      assert.doesNotMatch(card.detail, /Error invoking|FINALIZED_CHARACTER|GENERATION_/u, '不显示原始错误码')
      assert.deepEqual({ rowRetry: card.rowRetry, cardRetry: card.cardRetry }, { rowRetry: 0, cardRetry: 0 }, '重试也过不去，不摆重试')
    }
    assert.match(zh.detail, /有的后来被删除了.*重新定稿本章/u, JSON.stringify(zh))
    assert.match(en.detail, /has since been deleted.*Finalize this chapter again/u, JSON.stringify(en))
    assert.doesNotMatch(en.detail, /\p{Script=Han}/u, '英文说明不带汉字')
    return { zh, en, requests: fake.requests }
  } },
  'f512-legacy-step': { model: true, shell: 'stage', setup: seedStageSample, run: legacyStep(false, 'f512-legacy-step') },
  'f512-legacy-step-done': { model: true, shell: 'stage', setup: seedStageSample, run: legacyStep(true, 'f512-legacy-step-done') },
}
