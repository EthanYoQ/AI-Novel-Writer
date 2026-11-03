import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import * as chapterView from './pages/chapter-view.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const AUTHOR_64K = Object.freeze({ ...FAKE_MODEL, id: 'd77-author-64k', name: '作者 64K 上下文', modelName: 'gpt-4.1-mini',
  capabilities: { contextWindowTokens: 65_536, maxOutputTokens: FAKE_MODEL.maxTokens, reasoning: false, structuredOutput: true, usage: true },
  capabilitySources: { contextWindowTokens: 'manual', maxOutputTokens: 'manual', reasoning: 'preset', structuredOutput: 'preset', usage: 'preset' } })

const SENTENCES = ['港务局的档案按潮期装订，任何不在潮期里的事都会被当作没有发生过。', '北堤外的航道每逢大潮便改一次形状，老船工靠钟声而不是海图认路。',
  '灯塔由三代守塔人轮流看管，每一代都在值班簿的最后一页留下一句没人看懂的话。', '旧港的商会与港务局互不往来，账目却总在同一天对上。']
// 只看世界观就超过作者填的 64K：主进程的输入上界按 UTF-8 字节计。
const WORLDBUILDING_BYTES = 96 * 1024
const longWorldbuilding = () => {
  let text = STAGE_SAMPLE.core.worldbuilding, bytes = Buffer.byteLength(text, 'utf8')
  for (let index = 0; bytes < WORLDBUILDING_BYTES; index++) {
    const sentence = SENTENCES[index % SENTENCES.length]
    text += sentence
    bytes += Buffer.byteLength(sentence, 'utf8')
  }
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

const NOT_CHAT = new Set(['embedding', 'models'])
const modelCallKindsSince = (fake, before) => fake.requests.slice(before).filter(kind => !NOT_CHAT.has(kind))

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
    const chats = modelCallKindsSince(fake, before)
    assert.deepEqual(chats, ['outline', 'prose'], `64K 设置下短细纲与正文各发一次：${chats.join('、')}`)
    const prose = fake.chats.filter(chat => chat.kind === 'prose').at(-1)
    assert.equal(prose.model, AUTHOR_64K.modelName, '正文请求用的是作者 64K 的模型档案')
    const promptBytes = Buffer.byteLength(JSON.stringify(prose.messages), 'utf8')
    assert.ok(promptBytes > AUTHOR_64K.capabilities.contextWindowTokens, `发出的正文提示词 ${promptBytes} 字节，超过作者填的上下文窗口`)
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 30_000 })
    return { context: AUTHOR_64K.capabilities.contextWindowTokens, promptBytes, chats }
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
    assert.doesNotMatch(text, /maximum context length|request_id/u)
    const chats = modelCallKindsSince(fake, before)
    assert.deepEqual(chats, ['context-length'], `服务商拒绝后不自动重发：${chats.join('、')}`)
    return { card: text, chats }
  } },
  // 模型设置的「有效输出额度」：有值时说明新开始的生成每次最多发这么多、旧运行可能按 32,768 封顶；
  // 把作者设置和模型输出容量清成 0 后，这句改说还没有额度，不出现「为 未设置」。不保存。
  'd77-output-allowance': { model: true, shell: 'stage', setup, run: async ({ page, shoot }) => {
    await stage.openSettings(page)
    await page.getByRole('button', { name: `编辑「${AUTHOR_64K.name}」`, exact: true }).click()
    await page.getByRole('button', { name: '高级设置', exact: true }).click()
    const allowance = page.locator('p').filter({ hasText: /有效输出额度/u }).first()
    await allowance.evaluate(element => element.scrollIntoView({ block: 'center' }))
    const set = await allowance.innerText()
    await shoot('d77-output-allowance-set')
    await page.getByLabel('最大输出 Tokens', { exact: true }).fill('0')
    await page.getByLabel('模型输出容量', { exact: true }).fill('0')
    await allowance.evaluate(element => element.scrollIntoView({ block: 'center' }))
    const unset = await allowance.innerText()
    await shoot('d77-output-allowance-unset')
    assert.match(set, /新开始的生成每次请求最多发这么多/u)
    assert.match(set, /32,768/u)
    assert.match(unset, /还没有有效输出额度/u)
    assert.doesNotMatch(unset, /未设置/u)
    return { set, unset }
  } },
}
