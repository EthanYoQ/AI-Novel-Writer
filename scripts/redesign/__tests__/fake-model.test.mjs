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

async function embedWithoutKey() {
  const response = await fetch(`http://127.0.0.1:${fake.port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: ['潮位'] }),
  })
  return response.status
}

it('acceptKeylessEmbeddings 只在打开期间接受不带 Key 的嵌入请求', async () => {
  fake = await startFakeModel([])
  const refusedBefore = await embedWithoutKey()
  fake.acceptKeylessEmbeddings()
  const accepted = await embedWithoutKey()
  fake.acceptKeylessEmbeddings(false)
  assert.deepEqual({ refusedBefore, accepted, refusedAfter: await embedWithoutKey(), authorizations: fake.embeddingAuthorizations },
    { refusedBefore: 403, accepted: 200, refusedAfter: 403, authorizations: [null] })
})

it('rejectContextLength 让对话请求回 400 上下文超长错误体，记成 context-length；关掉后照常回正文', async () => {
  fake = await startFakeModel([])
  fake.rejectContextLength()
  const response = await fetch(`http://127.0.0.1:${fake.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FAKE_MODEL.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: FAKE_MODEL.modelName, stream: true, messages: [{ role: 'user', content: '写第 3 章正文。' }] }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error.message, /maximum context length is \d+ tokens/u)
  assert.deepEqual(fake.requests, ['context-length'])
  assert.deepEqual(fake.chats, [])
  fake.rejectContextLength(false)
  assert.deepEqual((await writeProse()).finish.at(-1), 'stop')
})

