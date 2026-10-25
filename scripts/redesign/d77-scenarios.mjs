// 讨论区 #77：作者手填 64K 上下文窗口、世界观较长的作品。修复前写稿在发出首个请求前被容量预检拒绝；
// 修复后照常发出，提示词真超长时由服务商拒绝，卡片建议换用上下文更长的模型或精简本章材料。
import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

// 驱动只把 api.openai.com 改道到本机假模型，所以用 OpenAI 档案承载作者手填的 64K 上下文窗口。
const AUTHOR_64K = Object.freeze({ ...FAKE_MODEL, id: 'd77-author-64k', name: '作者 64K 上下文',
  capabilities: { contextWindowTokens: 65_536, maxOutputTokens: FAKE_MODEL.maxTokens, reasoning: false, structuredOutput: true, usage: true },
  capabilitySources: { contextWindowTokens: 'manual', maxOutputTokens: 'manual', reasoning: 'preset', structuredOutput: 'preset', usage: 'preset' } })

const SENTENCES = ['港务局的档案按潮期装订，任何不在潮期里的事都会被当作没有发生过。', '北堤外的航道每逢大潮便改一次形状，老船工靠钟声而不是海图认路。',
  '灯塔由三代守塔人轮流看管，每一代都在值班簿的最后一页留下一句没人看懂的话。', '旧港的商会与港务局互不往来，账目却总在同一天对上。']
const WORLDBUILDING_UNITS = 22_000
const longWorldbuilding = () => {
  let text = STAGE_SAMPLE.core.worldbuilding
  for (let index = 0; text.length < WORLDBUILDING_UNITS; index++) text += SENTENCES[index % SENTENCES.length]
  return text
}

const setup = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
  for (const chapterNumber of [3, 4]) {
    for (const draft of await invoke(page, 'db:draft-list', chapterNumber, path, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
    }
  }
  const core = await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, worldbuilding: longWorldbuilding(),
    totalChapters: STAGE_SAMPLE.totalChapters, wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, path, session)
  assert.equal(core.success, true, core.error)
  assert.equal((await invoke(page, 'llm:save-model', AUTHOR_64K)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', AUTHOR_64K.id)).success, true)
} })

const startDraft = async page => {
  await chapterView.open(page, 3)
  await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
  await runSheet.waitUntilOpen(page)
}

export const D77_SCENARIOS = {
  'd77-capacity': { model: true, shell: 'stage', setup, run: async ({ page, fake }) => {
    const before = fake.requests.length
    await startDraft(page)
    await runSheet.waitForRunDone(page)
    const chats = fake.requests.slice(before).filter(kind => kind !== 'embedding')
    assert.deepEqual(chats.slice(0, 2), ['outline', 'prose'], `64K 设置下短细纲与正文都发给了模型：${chats.join('、')}`)
    await chapterView.view(page).getByText(FIXTURE_PROSE.slice(0, 20)).first().waitFor({ state: 'visible', timeout: 30_000 })
    return { context: AUTHOR_64K.capabilities.contextWindowTokens, worldbuildingUnits: WORLDBUILDING_UNITS, chats }
  } },
  'd77-context-length': { model: true, shell: 'stage', setup, run: async ({ page, fake }) => {
    fake.rejectContextLength()
    const before = fake.requests.length
    await startDraft(page)
    const failure = runSheet.anyCard(page).filter({ hasText: /^上一次运行/ })
    await failure.getByText(/换用上下文更长的模型/).waitFor({ state: 'visible', timeout: 90_000 })
    const text = await failure.innerText()
    assert.doesNotMatch(text, /上下文窗口/)
    assert.doesNotMatch(text, /请调整章节要求/)
    assert.match(text, /本次未保存草稿或正文章节。/)
    const chats = fake.requests.slice(before).filter(kind => kind !== 'embedding')
    assert.deepEqual(chats, ['context-length'], `服务商拒绝后不自动重发：${chats.join('、')}`)
    return { card: text, chats }
  } },
}
