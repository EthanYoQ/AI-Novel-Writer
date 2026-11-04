import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'

const anthropicModel = port => ({ ...FAKE_MODEL, id: 'a573-anthropic', name: '智谱 Anthropic 夹具', provider: 'bigmodel-anthropic',
  protocol: 'anthropic', modelName: 'glm-5', baseUrl: `http://127.0.0.1:${port}/api/anthropic` })

const setup = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
  for (const chapterNumber of [3, 4]) {
    for (const draft of await invoke(page, 'db:draft-list', chapterNumber, path, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
    }
  }
  const model = anthropicModel(context.fake.port)
  assert.equal((await invoke(page, 'llm:save-model', model)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', model.id)).success, true)
} })

const formSelectOptions = page => page.locator('select').evaluateAll(selects =>
  selects.map(select => Array.from(select.options).map(option => option.value)))

export const A573_SCENARIOS = {
  // 选 Anthropic 协议的生成模型写完第 3 章：假服务只从 /v1/messages 收到对话请求，带 x-api-key 与 anthropic-version；
  // 中途拍设置页里这份模型的表单；检索模型的新建表单里没有 Anthropic 协议与对应服务商。
  'a573-anthropic-generation': { model: true, shell: 'stage', setup, run: async ({ page, fake, shoot }) => {
    const model = anthropicModel(fake.port)
    await stage.openSettings(page)
    await page.getByRole('button', { name: `编辑「${model.name}」`, exact: true }).click()
    const selects = await formSelectOptions(page)
    const chosen = await page.locator('select').evaluateAll(list => list.map(select => select.value))
    await page.locator('select').last().evaluate(element => element.scrollIntoView({ block: 'center' }))
    await shoot('a573-settings-anthropic')
    assert.ok(chosen.includes('anthropic') && chosen.includes('bigmodel-anthropic'), `表单选中 Anthropic 协议与智谱 Anthropic：${chosen.join('、')}`)
    assert.ok(selects.some(options => options.includes('anthropic')), '生成模型的协议下拉有 Anthropic')

    await page.getByRole('button', { name: '取消', exact: true }).click()
    await stage.showSettingsPage(page, '检索模型')
    await page.getByRole('button', { name: '添加检索模型', exact: true }).click()
    const embeddingOptions = (await formSelectOptions(page)).flat()
    await shoot('a573-embedding-form')
    assert.ok(embeddingOptions.includes('gemini'), `检索模型表单已打开：${embeddingOptions.join('、')}`)
    assert.ok(!embeddingOptions.includes('anthropic') && !embeddingOptions.includes('bigmodel-anthropic'), `检索模型表单不提供 Anthropic：${embeddingOptions.join('、')}`)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    const before = fake.chats.length
    await chapterView.open(page, 3)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await runSheet.waitUntilOpen(page)
    await runSheet.waitForRunDone(page)
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 30_000 })
    const chats = fake.chats.slice(before)
    assert.ok(chats.some(chat => chat.kind === 'prose'), `写出了正文：${chats.map(chat => chat.kind).join('、')}`)
    assert.ok(chats.every(chat => chat.protocol === 'anthropic' && chat.model === model.modelName && chat.anthropicVersion === '2023-06-01'
      && Number.isInteger(chat.maxTokens) && chat.maxTokens > 0), JSON.stringify(chats.map(({ messages: _, ...rest }) => rest)))
    return { chats: chats.map(({ kind, stream, maxTokens, anthropicVersion, system }) => ({ kind, stream, maxTokens, anthropicVersion, hasSystem: Boolean(system) })) }
  } },
}
