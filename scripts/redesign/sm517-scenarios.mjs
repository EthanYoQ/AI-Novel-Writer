import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import { dismissCompletionToasts, waitForCompletionToast } from './pages/shell.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import { seedStageSample } from './scenarios.mjs'
import { openChapter, openInUi } from './f491-scenarios.mjs'

const MINI = Object.freeze({ ...FAKE_MODEL, id: 'sm517-mini', name: '驱动夹具小模型', modelName: 'gpt-4.1-mini' })
const STAGE_PAGE = '分工模型'

async function invokeOk(context, channel, ...args) {
  const result = await context.invoke(context.page, channel, ...args)
  assert.equal(result.success, true, `${channel}: ${result.error}`)
}

async function reloadAndOpen(context) {
  await context.reload()
  await openInUi(context, context.samplePath)
}

async function openStagePage(page) {
  await stage.openSettings(page)
  await stage.showSettingsPage(page, STAGE_PAGE)
}

async function assign(page, stageName, modelId) {
  await openStagePage(page)
  const select = page.getByLabel(stageName, { exact: true })
  await select.selectOption(modelId)
  await page.waitForFunction(({ label, value }) => {
    const element = [...document.querySelectorAll('label')].find(node => node.textContent === label)?.control
    return element instanceof HTMLSelectElement && !element.disabled && element.value === value
  }, { label: stageName, value: modelId }, { timeout: 10_000 })
}

async function nextChat(fake, before, kind, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const chat = fake.chats.slice(before).find(candidate => !kind || candidate.kind === kind)
    if (chat) return chat
    assert.ok(Date.now() < deadline, `${timeoutMs} ms 内假模型没有收到${kind ?? '新的'}请求`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export const SM517_SCENARIOS = {
  'sm517-stage-models': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async context => {
    const { page, fake } = context

    await openStagePage(page)
    assert.match(await stage.root(page).innerText(), /只有一个生成模型时，各环节都用它/u)
    await context.shoot('sm517-one-model')
    await stage.closeSettings(page)

    await invokeOk(context, 'llm:save-model', MINI)
    await reloadAndOpen(context)
    await assign(page, '审稿', MINI.id)
    await context.shoot('sm517-settings-zh')
    await stage.closeSettings(page)

    await blueprint.open(page)
    const beforeWrite = fake.chats.length
    await blueprint.writeNext(page)
    const prose = await nextChat(fake, beforeWrite, 'prose')
    await stage.waitForProse(page, FIXTURE_PROSE.split('\n')[0])

    await openChapter(page, 3)
    const beforeReview = fake.chats.length
    await chapterView.view(page).getByRole('button', { name: /^(AI 审稿|重新审稿)$/u }).click()
    const review = await nextChat(fake, beforeReview, 'review')

    await reloadAndOpen(context)
    await assign(page, '规划', MINI.id)
    await stage.closeSettings(page)
    await blueprint.open(page)
    const beforePlan = fake.chats.length
    await blueprint.generateRange(page, 13, 16)
    const plan = await nextChat(fake, beforePlan)

    assert.equal(prose.model, FAKE_MODEL.modelName, '没给写稿环节指定模型时，写稿用默认模型')
    assert.equal(review.model, MINI.modelName, 'AI 审稿用审稿环节指定的模型')
    assert.equal(plan.model, MINI.modelName, '生成蓝图用规划环节指定的模型')

    await invokeOk(context, 'llm:save-model', { ...MINI, purposes: ['embedding'] })
    await reloadAndOpen(context)
    await openStagePage(page)
    for (const assigned of ['review', 'planning']) {
      assert.match(await stage.root(page).locator(`[data-stage="${assigned}"]`).innerText(), /现按默认模型运行/u, `${assigned} 行提示按默认运行`)
    }
    await context.shoot('sm517-stale')
    await stage.closeSettings(page)

    await invokeOk(context, 'llm:delete-model', MINI.id)
    await invokeOk(context, 'llm:delete-model', FAKE_MODEL.id)
    await context.reload()
    await openStagePage(page)
    assert.match(await stage.root(page).innerText(), /还没有生成模型/u)
    await context.shoot('sm517-no-model')
    await stage.closeSettings(page)

    await invokeOk(context, 'llm:save-model', FAKE_MODEL)
    await invokeOk(context, 'llm:set-default-model', FAKE_MODEL.id)
    await invokeOk(context, 'llm:save-model', MINI)
    await invokeOk(context, 'llm:set-stage-model', { stage: 'review', modelId: MINI.id })
    await context.reload()
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '外观')
    await page.getByLabel('界面语言').selectOption('en-US')
    const englishNav = stage.root(page).getByRole('navigation', { name: 'Settings sections' })
    await englishNav.getByRole('button', { name: 'Models by stage', exact: true }).click()
    await stage.root(page).getByRole('heading', { level: 1, name: 'Models by stage', exact: true }).waitFor({ state: 'visible' })
    await context.shoot('sm517-settings-en')

    return { proseModel: prose.model, reviewModel: review.model, planningModel: plan.model, planningKind: plan.kind }
  } },
  'sm517-stage-dialogs': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke }) => {
    for (const [channel, request] of [
      ['llm:save-model', MINI],
      ['llm:set-stage-model', { stage: 'refinement', modelId: MINI.id }],
      ['llm:set-stage-model', { stage: 'planning', modelId: MINI.id }],
    ]) {
      const result = await invoke(page, channel, request)
      assert.equal(result.success, true, `${channel} ${JSON.stringify(request.stage ?? request.id)}: ${result.error}`)
    }
  } }), run: async context => {
    const { page, fake } = context

    fake.replyPlotTree()
    await refs.open(page, 'plot')
    const plotModel = page.getByLabel('本次整理用的模型', { exact: true })
    await plotModel.waitFor({ state: 'visible' })
    assert.equal(await plotModel.inputValue(), MINI.id, '剧情树预选规划环节指定的模型')
    await context.shoot('sm517-plot-tree-planning-model')
    const beforePlot = fake.chats.length
    await refs.buildPlotTree(page)
    const plot = await nextChat(fake, beforePlot, 'plot-tree')

    await openChapter(page, 3)
    const beforeReview = fake.chats.length
    await chapterView.view(page).getByRole('button', { name: '重新审稿', exact: true }).click()
    const review = await nextChat(fake, beforeReview, 'review')
    await stage.root(page).locator('.stage-capsule:not([data-tone="ok"])').waitFor({ state: 'detached', timeout: 90_000 })
    await waitForCompletionToast(page)
    await dismissCompletionToasts(page)
    assert.equal(await chapterView.reviseButton(page).isEnabled(), true, '重新审稿写回后才能按意见修稿')
    await page.getByRole('button', { name: '修稿选项', exact: true }).click()
    await page.getByRole('dialog', { name: '修稿选项' }).waitFor({ state: 'visible' })
    const reviseModel = page.getByLabel(/本次修稿模型/u)
    await reviseModel.waitFor({ state: 'visible' })
    assert.equal(await reviseModel.inputValue(), MINI.id, '修稿选项预选修稿环节指定的模型')
    await context.shoot('sm517-revise-refinement-model')
    await page.keyboard.press('Escape')
    const beforeRevise = fake.chats.length
    await chapterView.reviseButton(page).click()
    const revision = await nextChat(fake, beforeRevise, 'revision')

    assert.equal(plot.model, MINI.modelName, '生成剧情树用规划环节指定的模型')
    assert.equal(review.model, FAKE_MODEL.modelName, '审稿没有另外指定，仍用默认模型')
    assert.equal(revision.model, MINI.modelName, '按意见修稿用修稿环节指定的模型')
    return { plotModel: plot.model, reviewModel: review.model, revisionModel: revision.model }
  } },
}
