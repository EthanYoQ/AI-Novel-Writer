// #491 实机场景：旧版本（--app-root 指向 1.3.2 的构建）里把示例作品导出、恢复两轮，角色当前状态变成「历史派生」、
// 最新章定稿的角色状态更新报来源冲突；再用本工作树的构建打开同一份数据，字段恢复为定稿派生、可编辑，重试后定稿后处理完成。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as architecture from './pages/architecture.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as stage from './pages/stage.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { seedStageSample } from './scenarios.mjs'

const HEAD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 第 3 章写进地点、道具与近况；第 4 章再改地点与近况，道具留着第 3 章的值。证据都是该章里只出现一次的原句。 */
const CHAPTER_UPDATES = [
  { marker: '灯室的门没有锁', evidence: '林岚把纸条夹进父亲的地图里。',
    currentState: { location: '灯塔顶层灯室', keyItems: '父亲的地图、钟绳上的纸条', recentEvents: '在灯室找到「别在涨潮时敲钟」的纸条' } },
  { marker: '守塔人的屋子在灯塔背风的一侧', evidence: '「你父亲也问过钟的事。」',
    currentState: { location: '守塔人的屋子', recentEvents: '守塔人说父亲也问过钟的事' } },
]

export function characterStateReply(prompt) {
  const id = /"characterId": "([^"]+)",\s*"name": "林岚"/u.exec(prompt)?.[1]
  const update = CHAPTER_UPDATES.find(item => prompt.includes(item.marker))
  if (!id || !update) return '{"updates":[]}'
  return JSON.stringify({ updates: [{ characterId: id, currentState: update.currentState, evidence: { text: update.evidence } }] })
}

/** 驱动自己打开作品拿会话；界面上的会话随之失效，之后由界面重新打开。 */
async function openForDriver({ page, invoke }, projectPath) {
  const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  return { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
}

async function stubDialogs(app, { save, open }) {
  await app.evaluate(({ dialog }, paths) => {
    globalThis.__f491Dialogs ??= { save: dialog.showSaveDialog, open: dialog.showOpenDialog }
    if (paths.save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.save })
    if (paths.open) dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.open] })
  }, { save, open })
}

/** 用界面同一组 IPC 导出 .ainovel 再恢复成新副本，返回副本所在目录。 */
export async function exportAndRestore(context, projectPath, label) {
  const { app, page, invoke, roots } = context
  const session = await openForDriver(context, projectPath)
  const archive = path.join(roots.projects, `${label}.ainovel`)
  await stubDialogs(app, { save: archive })
  const exportGrant = await invoke(page, 'dialog:select-project-archive-export', STAGE_SAMPLE.name)
  const exported = await invoke(page, 'project:archive-export', { targetArchiveGrantId: exportGrant.grantId, projectSession: session })
  assert.equal(exported.success, true, JSON.stringify(exported))
  await stubDialogs(app, { open: archive })
  const archiveGrant = await invoke(page, 'dialog:select-project-archive')
  const parent = path.join(roots.projects, label)
  fs.mkdirSync(parent)
  await stubDialogs(app, { open: parent })
  const targetGrant = await invoke(page, 'dialog:select-project-restore-target', STAGE_SAMPLE.name)
  const restored = await invoke(page, 'project:archive-restore', { archiveGrantId: archiveGrant.grantId, targetGrantId: targetGrant.grantId })
  assert.equal(restored.success, true, JSON.stringify(restored))
  return restored.receipt.targetProjectRoot
}

/** 界面按 Ctrl O 打开指定文件夹里的作品。 */
export async function openInUi({ app, page }, projectPath) {
  await stubDialogs(app, { open: projectPath })
  await page.keyboard.press('Control+O')
  await stage.spine(page).waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForTimeout(2000)
}

export async function openCharacterState(page) {
  await architecture.open(page)
  await architecture.openCast(page)
  await architecture.castRow(page, '林岚').click()
  await stage.root(page).getByRole('group', { name: '档案视图' }).getByRole('button', { name: '当前状态', exact: true }).click()
}

export async function stateFields(page) {
  return stage.root(page).locator('.cast-grid .cast-field').evaluateAll(fields => fields.map(field => ({
    label: field.querySelector('label')?.textContent?.trim(),
    hint: field.querySelector('.cast-field-hint')?.textContent?.trim() ?? null,
    value: field.querySelector('textarea')?.value ?? null,
    history: field.querySelector('.cast-field-history')?.textContent?.trim() ?? null,
  })))
}

/** 定稿后处理列出了角色状态更新，每一步都已成功或失败，且没有进行中的运行。 */
const settled = page => page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('[aria-label="定稿后处理"] li')]
  return rows.some(row => row.querySelector('b')?.textContent === '角色状态更新')
    && rows.every(row => row.dataset.state === 'success' || row.dataset.state === 'failed')
    && !document.querySelector('.stage-capsule:not([data-tone="ok"])')
}, null, { timeout: 90_000 })

export async function openChapter(page, chapterNumber) {
  if (!await stage.chapterButton(page, chapterNumber).isVisible()) await stage.stageButton(page, '正文').click()
  await chapterView.open(page, chapterNumber)
}

export async function finalizeChapter(page, chapterNumber) {
  await openChapter(page, chapterNumber)
  await chapterView.finalize(page, chapterNumber)
  await settled(page)
}

/** 角色状态更新这一行的说明；正文文件一行在发布未完成时也标失败，不能取「第一条失败」。 */
export const postDetail = page => chapterView.postProcess(page).locator('li[data-state="failed"]').filter({ has: page.locator('b', { hasText: /^角色状态更新$/u }) })
  .locator('.stage-ch-post-detail')

export const F491_SCENARIOS = {
  'f491-backup-roundtrip': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    context.fake.replyCharacterState(characterStateReply)
    const measured = {}
    await finalizeChapter(context.page, 3)
    measured.chapter3 = await chapterView.postProcessSteps(context.page)

    const first = await exportAndRestore(context, context.samplePath, 'round-1')
    const second = await exportAndRestore(context, first, 'round-2')
    await context.reload()
    await openInUi(context, second)
    await openCharacterState(context.page)
    measured.damaged = await stateFields(context.page)
    await context.shoot('f491-1-damaged-historical')

    await finalizeChapter(context.page, 4)
    measured.damagedFinalize = { steps: await chapterView.postProcessSteps(context.page), detail: await postDetail(context.page).innerText() }
    await context.shoot('f491-2-damaged-finalize-error')
    assert.match(measured.damagedFinalize.detail, /FINALIZED_CHARACTER_SOURCE_CONFLICT/u, '旧版本复现了来源冲突')

    await context.restart({ appRoot: HEAD_ROOT })
    const { page } = context
    await stage.spine(page).or(stage.shelf(page)).first().waitFor({ state: 'visible', timeout: 60_000 })
    await openInUi(context, second)
    await openChapter(page, 4)
    await postDetail(page).waitFor({ state: 'visible', timeout: 30_000 })
    measured.repairedError = await postDetail(page).innerText()
    assert.match(measured.repairedError, /^正文定稿已保存，但角色卡没有自动更新/u, '新构建显示可读说明')
    assert.doesNotMatch(measured.repairedError, /Error invoking|FINALIZED_CHARACTER/u, '新构建不显示原始错误码')
    await context.shoot('f491-3-fixed-readable-error')
    await chapterView.postProcess(page).getByRole('button', { name: '重试失败步骤' }).click()
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[aria-label="定稿后处理"] li')]
      return rows.some(row => row.querySelector('b')?.textContent === '角色状态更新') && rows.every(row => row.dataset.state === 'success')
    }, null, { timeout: 90_000 })
    measured.repairedFinalize = await chapterView.postProcessSteps(page)
    await context.shoot('f491-4-fixed-finalize-done')

    await openCharacterState(page)
    measured.repaired = await stateFields(page)
    const keyItems = stage.root(page).getByRole('textbox', { name: /^关键道具/u })
    await keyItems.fill('父亲的地图、钟绳上的纸条、守塔人的茶杯')
    await stage.root(page).getByRole('button', { name: '保存角色' }).click()
    await stage.root(page).locator('.cast-save-state').getByText('已保存', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
    measured.edited = await stateFields(page)
    const pick = (fields, label) => fields.find(field => field.label.startsWith(label))
    const view = fields => ['当前位置', '关键道具', '最近重要事件'].map(label => {
      const { hint, value, history } = pick(fields, label)
      return { label, hint, value, history }
    })
    const historical = '历史派生（非当前）', note = '历史记录（来源已失效或未核验）：'
    assert.deepEqual(view(measured.damaged), [
      { label: '当前位置', hint: historical, value: '', history: `${note}灯塔顶层灯室` },
      { label: '关键道具', hint: historical, value: '', history: `${note}父亲的地图、钟绳上的纸条` },
      { label: '最近重要事件', hint: historical, value: '', history: `${note}在灯室找到「别在涨潮时敲钟」的纸条` },
    ], '旧版本两轮往返后三项都是历史派生、输入框为空')
    assert.deepEqual(view(measured.repaired), [
      { label: '当前位置', hint: '定稿派生', value: '守塔人的屋子', history: null },
      { label: '关键道具', hint: '定稿派生', value: '父亲的地图、钟绳上的纸条', history: null },
      { label: '最近重要事件', hint: '定稿派生', value: '守塔人说父亲也问过钟的事', history: null },
    ], '新构建打开后三项为定稿派生：第 4 章更新地点与近况，道具保留第 3 章的值')
    assert.deepEqual(view(measured.edited)[1], { label: '关键道具', hint: '作者输入', value: '父亲的地图、钟绳上的纸条、守塔人的茶杯', history: null },
      '手改后保存为作者输入')
    assert.ok(measured.repairedFinalize.every(step => step.state === 'success'), JSON.stringify(measured))
    return measured
  } },
}
