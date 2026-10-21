import assert from 'node:assert/strict'
import { afterEach, it } from 'vitest'
import { FAKE_MODEL, startFakeModel, streamingProse } from '../fake-model.mjs'

let fake
afterEach(async () => { await fake?.close() })

/** 按模型客户端的方式请求一次正文，返回各块的 finish_reason 与拼出的正文。 */
async function writeProse() {
  const response = await fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FAKE_MODEL.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FAKE_MODEL.modelName, stream: true, messages: [{ role: 'user', content: '写第 3 章正文。' }] }),
  })
  const chunks = (await response.text()).split('\n\n')
    .filter(line => line.startsWith('data: {'))
    .flatMap(line => JSON.parse(line.slice('data: '.length)).choices)
  return { finish: chunks.map(choice => choice.finish_reason), text: chunks.map(choice => choice.delta.content ?? '').join('') }
}

it('failProse 之后流式正文也以 content_filter 结束', async () => {
  fake = await startFakeModel([])
  const chunks = streamingProse(2, 12)
  fake.streamProse({ chunks, intervalMs: 0 })
  fake.failProse()
  assert.deepEqual(await writeProse(), { finish: [null, null, 'content_filter'], text: chunks.join('') })
})

it('failProse(false) 恢复后流式正文照常以 stop 结束', async () => {
  fake = await startFakeModel([])
  const chunks = streamingProse(2, 12)
  fake.streamProse({ chunks, intervalMs: 0 })
  fake.failProse()
  fake.failProse(false)
  assert.deepEqual((await writeProse()).finish, [null, null, 'stop'])
})
