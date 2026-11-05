import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, it } from 'vitest'
import { changedFiles, fetchRoute, filesContaining, fileStamps, guardFetch, realModelProfiles, redactSecret, removeModelConfigs, removePath,
  summarizeModelRequests }
  from '../real-model.mjs'

const REAL = { fakePort: null, realOrigin: 'https://api.siliconflow.cn' }
const FAKE = { fakePort: 4567, realOrigin: null }
const NONE = { fakePort: null, realOrigin: null }

const parents = []
afterEach(() => { for (const parent of parents.splice(0)) fs.rmSync(parent, { recursive: true, force: true }) })
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-model-')); parents.push(dir); return dir }

it('真实模式只放行 https 的硅基流动 /v1/，其余一律拒绝', () => {
  assert.equal(fetchRoute('https://api.siliconflow.cn/v1/chat/completions', REAL), 'pass')
  assert.equal(fetchRoute('https://api.siliconflow.cn/v1/embeddings', REAL), 'pass')
  for (const href of ['https://api.openai.com/v1/chat/completions', 'http://api.siliconflow.cn/v1/chat/completions',
    'https://api.siliconflow.cn/models', 'https://api.siliconflow.com/v1/chat/completions', 'https://cloud.siliconflow.cn/v1/x',
    'http://127.0.0.1:4567/v1/chat/completions', 'https://api.siliconflow.cn.evil.example/v1/x']) {
    assert.equal(fetchRoute(href, REAL), 'refuse', href)
  }
})

it('假模型与无夹具的去向与原来一致', () => {
  assert.equal(fetchRoute('http://127.0.0.1:4567/v1/embeddings', FAKE), 'pass')
  assert.equal(fetchRoute('https://api.openai.com/v1/chat/completions', FAKE), 'fake')
  assert.equal(fetchRoute('https://api.openai.com/models', FAKE), 'refuse')
  assert.equal(fetchRoute('https://api.siliconflow.cn/v1/chat/completions', FAKE), 'refuse')
  assert.equal(fetchRoute('https://api.openai.com/v1/chat/completions', NONE), 'refuse')
})

it('源码在主进程里重建后行为不变', () => {
  const rebuilt = (0, eval)(`(${fetchRoute.toString()})`)
  assert.equal(rebuilt('https://api.siliconflow.cn/v1/embeddings', REAL), 'pass')
  assert.equal(rebuilt('https://api.openai.com/v1/embeddings', REAL), 'refuse')
})

it('两个档案都指向硅基流动，Key 只出现在 apiKey 字段', () => {
  const profiles = realModelProfiles('sk-test-secret')
  for (const profile of Object.values(profiles)) {
    assert.equal(profile.baseUrl, 'https://api.siliconflow.cn/v1')
    assert.equal(profile.apiKey, 'sk-test-secret')
    assert.equal(JSON.stringify({ ...profile, apiKey: '' }).includes('sk-test-secret'), false)
  }
  assert.deepEqual([profiles.generation.purposes, profiles.embedding.purposes], [['generation'], ['embedding']])
})

it('逐字节找出含密钥的文件，空密钥直接报错', () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, 'nested'))
  fs.writeFileSync(path.join(dir, 'clean.json'), '{"apiKey":""}')
  fs.writeFileSync(path.join(dir, 'nested', 'leak.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('xx sk-test-secret yy')]))
  const result = filesContaining([dir, path.join(dir, 'missing')], 'sk-test-secret')
  assert.equal(result.scanned, 2)
  assert.deepEqual(result.hits, [path.join(dir, 'nested', 'leak.bin')])
  assert.throws(() => filesContaining([dir], ''), /密钥为空/)
})

it('删掉数据目录里各代的模型配置与写入时的临时文件，别的文件不动', () => {
  const dir = tempDir()
  const generation = path.join(dir, 'generations', 'g1')
  fs.mkdirSync(generation, { recursive: true })
  for (const name of ['models.json', '.models.json.123.abc.tmp', 'config.json']) fs.writeFileSync(path.join(generation, name), '{}')
  fs.writeFileSync(path.join(dir, 'models.json'), '{}')
  fs.writeFileSync(path.join(dir, 'recent-projects.json'), '{}')
  assert.deepEqual(removeModelConfigs(dir).removed.map(file => path.relative(dir, file)).sort(),
    [path.join('generations', 'g1', '.models.json.123.abc.tmp'), path.join('generations', 'g1', 'models.json'), 'models.json'])
  assert.deepEqual(fs.readdirSync(generation), ['config.json'])
  assert.deepEqual(fs.readdirSync(dir).sort(), ['generations', 'recent-projects.json'])
  assert.deepEqual(removeModelConfigs(path.join(dir, 'missing')), { removed: [], failures: [] })
})

it('请求汇总按路径计数，非 200 记为失败', () => {
  const summary = summarizeModelRequests([{ path: '/v1/chat/completions', status: 200, ms: 30 }, { path: '/v1/chat/completions', status: 429, ms: 5 },
    { path: '/v1/embeddings', status: 200, ms: 7 }])
  assert.equal(summary.count, 3)
  assert.deepEqual(summary.byPath['/v1/chat/completions'], { count: 2, failed: 1, maxMs: 30, totalMs: 35 })
  assert.deepEqual(summary.failures, [{ path: '/v1/chat/completions', status: 429, ms: 5 }])
})

it('结果里出现密钥时整体遮蔽并标记，没有时原样返回', () => {
  const result = { error: 'Bearer sk-test-secret 被拒', nested: [{ log: 'x sk-test-secret y' }], ok: 1 }
  const masked = redactSecret(result, 'sk-test-secret')
  assert.equal(masked.redacted, true)
  assert.equal(JSON.stringify(masked.value).includes('sk-test-secret'), false)
  assert.equal(masked.value.ok, 1)
  assert.deepEqual(redactSecret({ ok: 1 }, 'sk-test-secret'), { value: { ok: 1 }, redacted: false })
})

it('只列出本次运行新建或改过的文件，事先就有且没动过的不算', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, '.env'), 'SILICONFLOW_API_KEY=sk-test-secret')
  fs.writeFileSync(path.join(dir, 'old.json'), '{}')
  const before = fileStamps(dir)
  fs.writeFileSync(path.join(dir, 'old.json'), '{"changed":true}')
  fs.mkdirSync(path.join(dir, 'shots'))
  fs.writeFileSync(path.join(dir, 'shots', 'new.png'), 'png')
  assert.deepEqual(changedFiles(dir, before).map(file => path.relative(dir, file)).sort(), ['old.json', path.join('shots', 'new.png')])
})

it('真实模式不跟随重定向：302 指向别的源时拒绝，目标源收不到请求并记进外部请求', async () => {
  const targetHits = []
  const target = http.createServer((request, response) => { targetHits.push(request.url); response.end('{}') })
  const redirect = http.createServer((request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/v1/steal` })
    response.end()
  })
  await Promise.all([target, redirect].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
  try {
    const sink = { externalRequests: [], modelRequests: [] }
    const realOrigin = `http://127.0.0.1:${redirect.address().port}`
    const guarded = guardFetch(fetch, fetchRoute, { fakePort: null, realOrigin }, sink)
    await assert.rejects(guarded(`${realOrigin}/v1/chat/completions`, { method: 'POST', body: '{"messages":[]}' }), /DRIVE_EXTERNAL_FETCH_REFUSED/)
    assert.deepEqual(targetHits, [])
    assert.deepEqual(sink.externalRequests, [`http://127.0.0.1:${target.address().port}`])
    assert.deepEqual(sink.modelRequests.map(entry => [entry.path, entry.status]), [['/v1/chat/completions', 302]])
  } finally {
    await Promise.all([target, redirect].map(server => new Promise(resolve => server.close(resolve))))
  }
})

it('包装的源码在主进程里重建后同样拒绝不在名单里的请求', async () => {
  const rebuilt = (0, eval)(`(${guardFetch.toString()})`)
  const sink = { externalRequests: [], modelRequests: [] }
  const guarded = rebuilt(() => { throw new Error('不应发出') }, fetchRoute, REAL, sink)
  await assert.rejects(guarded('https://api.openai.com/v1/chat/completions'), /DRIVE_EXTERNAL_FETCH_REFUSED/)
  assert.deepEqual(sink.externalRequests, ['https://api.openai.com'])
})

it('删不掉的模型配置记下路径与错误码，其余照删，不抛', () => {
  const dir = tempDir()
  for (const name of ['a', 'b']) {
    fs.mkdirSync(path.join(dir, name))
    fs.writeFileSync(path.join(dir, name, 'models.json'), '{}')
  }
  const stuck = path.join(dir, 'a', 'models.json')
  const result = removeModelConfigs(dir, file => file === stuck ? 'EBUSY' : removePath(file))
  assert.deepEqual(result.failures, [{ file: stuck, reason: 'EBUSY' }])
  assert.deepEqual(result.removed, [path.join(dir, 'b', 'models.json')])
  assert.equal(removePath(path.join(dir, 'missing')), null)
})

it('有文件读不了时记下路径与错误码，其余文件照查', () => {
  const dir = tempDir()
  const locked = path.join(dir, 'locked.log')
  const leak = path.join(dir, 'leak.log')
  fs.writeFileSync(locked, 'x')
  fs.writeFileSync(leak, 'sk-test-secret')
  const read = file => {
    if (file === locked) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return fs.readFileSync(file)
  }
  assert.deepEqual(filesContaining([dir], 'sk-test-secret', read), { scanned: 2, hits: [leak], unreadable: [{ file: locked, reason: 'EBUSY' }] })
})

it('产出目录是目录链接（Windows junction）时照样列出本次写进去的文件', () => {
  const target = tempDir()
  const link = path.join(tempDir(), 'out-link')
  fs.symlinkSync(target, link, 'junction')
  const before = fileStamps(link)
  fs.writeFileSync(path.join(link, 'leak.log'), 'sk-test-secret')
  assert.deepEqual(changedFiles(link, before).map(file => path.basename(file)), ['leak.log'])
})
