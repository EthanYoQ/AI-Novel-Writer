// 讨论区 #77：DeepSeek 官方端点、作者手填 64K 上下文窗口、世界观较长的作品，写稿在发出首个请求前被容量预检拒绝。
import assert from 'node:assert/strict'

import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

// 预检在发请求之前就拒绝，所以端点可以是真实的 api.deepseek.com：驱动的外部请求拦截会证明一个请求都没发出。
const DEEPSEEK = Object.freeze({ id: 'd77-deepseek', name: 'DeepSeek', provider: 'deepseek', protocol: 'openai',
  modelName: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'd77-offline-key', maxTokens: 65_536,
  temperature: 0.7, purposes: ['generation'],
  capabilities: { contextWindowTokens: 65_536, maxOutputTokens: 384_000, reasoning: true, structuredOutput: true, usage: true },
  capabilitySources: { contextWindowTokens: 'manual', maxOutputTokens: 'preset', reasoning: 'preset', structuredOutput: 'preset', usage: 'preset' } })

const SENTENCES = ['港务局的档案按潮期装订，任何不在潮期里的事都会被当作没有发生过。', '北堤外的航道每逢大潮便改一次形状，老船工靠钟声而不是海图认路。',
  '灯塔由三代守塔人轮流看管，每一代都在值班簿的最后一页留下一句没人看懂的话。', '旧港的商会与港务局互不往来，账目却总在同一天对上。']
const WORLDBUILDING_UNITS = 22_000
const longWorldbuilding = () => {
  let text = STAGE_SAMPLE.core.worldbuilding
  for (let index = 0; text.length < WORLDBUILDING_UNITS; index++) text += SENTENCES[index % SENTENCES.length]
  return text
}

export const D77_SCENARIOS = {
  'd77-capacity': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
    for (const chapterNumber of [3, 4]) {
      for (const draft of await invoke(page, 'db:draft-list', chapterNumber, path, session)) {
        assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
      }
    }
    const core = await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, worldbuilding: longWorldbuilding(),
      totalChapters: STAGE_SAMPLE.totalChapters, wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, path, session)
    assert.equal(core.success, true, core.error)
    assert.equal((await invoke(page, 'llm:save-model', DEEPSEEK)).success, true)
    assert.equal((await invoke(page, 'llm:set-default-model', DEEPSEEK.id)).success, true)
    // 没有单独的检索模型时知识库检索会回退到默认生成模型；指到夹具，免得检索请求打到 DeepSeek。
    assert.equal((await invoke(page, 'llm:set-default-embedding-model', FAKE_MODEL.id)).success, true)
  } }), run: async ({ page, fake }) => {
    const before = fake.requests.length
    await chapterView.open(page, 3)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await runSheet.waitUntilOpen(page)
    const failure = runSheet.anyCard(page).filter({ hasText: /^上一次运行/ })
    await failure.getByText(/TASK_BUDGET_CAPACITY_CONFLICT/).waitFor({ state: 'visible', timeout: 90_000 })
    const text = await failure.innerText()
    assert.match(text, /裁决依据：任务完整范围、输入估计上界、上下文安全余量、用户上下文设置、模型上下文剩余空间、父任务剩余额度、必需输入与输出空间冲突/)
    assert.deepEqual(fake.requests.slice(before).filter(kind => kind !== 'embedding'), [], '预检拒绝前没有生成请求到达模型')
    return { context: DEEPSEEK.capabilities.contextWindowTokens, worldbuildingUnits: WORLDBUILDING_UNITS, card: text }
  } },
}
