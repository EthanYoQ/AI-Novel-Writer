import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { OpenAIProvider } from '../../electron/llm/openai-provider'
import { createAttemptSupervisor, qualificationBridgeWindows, productionScenario, continuityCaseOperations } from '../quality-modernization-driver.mjs'
import { forwardReasoningFor, forwardQualificationWindowFor } from '../quality-modernization-run.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const fixture = fs.readFileSync(path.join(root, 'scripts/fixtures/quality-modernization-production.fixture.mjs'), 'utf8')
const open = '        streamSettlements.push((async () => {'
const close = '        })())'
const start = fixture.indexOf(open), end = fixture.indexOf(close, start) + close.length
assert.ok(start >= 0 && end > start && fixture.indexOf(open, start + 1) < 0)
// Execute the production fixture's anonymous consumer, with only its lexical inputs supplied.
const consume = new Function('ledgerBody', 'supervisor', 'attemptId', 'physicalOutputPath',
  'requestReceipt', 'streamSettlements', 'fs', 'sha', 'dispatchAt', fixture.slice(start, end))
const sha = value => createHash('sha256').update(value).digest('hex')
const event = payload => `data: ${JSON.stringify(payload)}\n\n`
const content = text => event({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
const reasoning = event({ choices: [{ delta: { reasoning_content: 'offline reasoning' }, finish_reason: null }] })
const done = 'data: [DONE]\n\n'
const model = { id: 'offline', name: 'offline', provider: 'openai', protocol: 'openai',
  modelName: 'offline-model', baseUrl: 'https://network-denied.invalid/v1', apiKey: 'synthetic-never-network',
  temperature: 0, maxTokens: 2672, purposes: ['generation'] }

test('the actual tee consumer settles a complete DONE without waiting for body EOF', async () => {
  const deny = () => { throw new Error('NETWORK_FORBIDDEN') }
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(deny)
  vi.spyOn(tls, 'connect').mockImplementation(deny)
  vi.spyOn(http, 'request').mockImplementation(deny)
  vi.spyOn(http, 'get').mockImplementation(deny)
  vi.spyOn(https, 'request').mockImplementation(deny)
  vi.spyOn(https, 'get').mockImplementation(deny)
  syncBuiltinESMExports()
  const directory = fs.mkdtempSync(path.join(root, '.runtime/.cache/novel-quality-modernization/stream-settlement-'))
  const encoder = new TextEncoder()
  const cases = [
    { name: 'complete-held-open', parts: [content('正文'), done], close: false, terminal: 'settle', output: '正文', finish: 'stop' },
    { name: 'complete-closed', parts: [content('正文'), done], close: true, terminal: 'settle', output: '正文', finish: 'stop' },
    { name: 'headers-only', parts: [], close: false, terminal: 'unknown', output: '', finish: null },
    { name: 'reasoning-heartbeat', parts: [reasoning, ': heartbeat\n\n'], close: false, terminal: 'unknown', output: '', finish: null },
    { name: 'stop-without-done', parts: [content('正文')], close: true, terminal: 'unknown', output: '正文', finish: null },
    { name: 'literal-done-in-content', parts: [content('正文 [DONE]')], close: true, terminal: 'unknown', output: '正文 [DONE]', finish: null },
    { name: 'comment-done', parts: [content('正文'), ': [DONE]\n\n'], close: true, terminal: 'unknown', output: '正文', finish: null },
    { name: 'trailing-space-done-held-open', parts: [content('正文'), 'data: [DONE] \n\n'], close: false, terminal: 'settle', output: '正文', finish: 'stop' },
    { name: 'trailing-space-done-closed', parts: [content('正文'), 'data: [DONE] \n\n'], close: true, terminal: 'settle', output: '正文', finish: 'stop' },
    { name: 'pending-done-at-eof', parts: [content('正文'), 'data: [DONE]\n'], close: true, terminal: 'settle', output: '正文', finish: 'stop' },
    { name: 'pending-done-held-open', parts: [content('正文'), 'data: [DONE]\n'], close: false, terminal: 'unknown', output: '正文', finish: null },
    { name: 'split-crlf-done', parts: [content('正文').replaceAll('\n', '\r\n'), 'data: [DO', 'NE]\r\n', '\r\n'], close: false, terminal: 'settle', output: '正文', finish: 'stop' },
    { name: 'malformed-before-done', parts: ['data: {bad-json}\n\n', content('正文'), done], close: true,
      terminal: 'unknown', output: '正文', finish: null },
  ]
  try {
    for (const item of cases) {
      const id = `synthetic:${item.name}`, events = [], receipt = {}, owner = { chunks: [], reasoning: [] }
      const supervisor = createAttemptSupervisor({ deadlineMs: 120, record: value => events.push(value) })
      const abort = new AbortController()
      let streamController
      const body = new ReadableStream({ start(controller) {
        streamController = controller
        for (const part of item.parts) controller.enqueue(encoder.encode(part))
        if (item.close) controller.close()
      } })
      const [providerBody, ledgerBody] = body.tee()
      let fetches = 0
      vi.stubGlobal('fetch', async (_url, options) => {
        if (++fetches !== 1 || String(_url) !== 'https://network-denied.invalid/v1/chat/completions') deny()
        options.signal?.addEventListener('abort', () => {
          try { streamController.error(new DOMException('Probe deadline', 'AbortError')) } catch { /* closed */ }
        }, { once: true })
        return new Response(providerBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      })
      events.push({ type: 'reserve', attemptId: id }, { type: 'dispatch', attemptId: id })
      supervisor.watch(id, abort)
      const outputPath = path.join(directory, `${item.name}.txt`), settlements = []
      consume(ledgerBody, supervisor, id, outputPath, receipt, settlements, fs, sha, performance.now())
      await Promise.all([new OpenAIProvider().generateStream(model, [{ role: 'user', content: 'offline' }], {
        maxTokens: 2672, temperature: 0, visibleOnly: true, signal: abort.signal,
        onChunk: value => owner.chunks.push(value), onReasoning: value => owner.reasoning.push(value),
        onDone: value => { owner.done = value }, onError: error => { owner.error = error },
      }), ...settlements])
      supervisor.dispose()
      vi.unstubAllGlobals()
      assert.equal(fetches, 1, item.name)
      assert.deepEqual(events.map(value => value.type), ['reserve', 'dispatch', item.terminal], item.name)
      assert.equal(fs.readFileSync(outputPath, 'utf8'), item.output, item.name)
      assert.equal(receipt.finishReason, item.finish, item.name)
      assert.deepEqual(receipt.streamProgress && Object.keys(receipt.streamProgress).sort(),
        ['bodyBytes', 'contentEvents', 'firstByteMs', 'lastByteMs', 'reasoningEvents', 'sawDone', 'sawFinish'], item.name)
      assert.equal(receipt.streamProgress.bodyBytes > 0, item.parts.length > 0, item.name)
      assert.equal(receipt.streamProgress.contentEvents, item.parts.some(part => /"content":/u.test(part)) ? 1 : 0, item.name)
      assert.equal(receipt.streamProgress.reasoningEvents, item.name === 'reasoning-heartbeat' ? 1 : 0, item.name)
      assert.equal(receipt.streamProgress.sawDone, item.terminal === 'settle' || item.name === 'malformed-before-done', item.name)
      assert.equal(receipt.streamProgress.sawFinish, item.parts.some(part => part.includes('finish_reason":"stop')), item.name)
      if (item.parts.length) {
        assert.ok(Number.isFinite(receipt.streamProgress.firstByteMs) && receipt.streamProgress.firstByteMs >= 0, item.name)
        assert.ok(receipt.streamProgress.lastByteMs >= receipt.streamProgress.firstByteMs, item.name)
      } else assert.deepEqual([receipt.streamProgress.firstByteMs, receipt.streamProgress.lastByteMs], [null, null], item.name)
      assert.equal(owner.done, item.terminal === 'settle' ? '正文' : undefined, item.name)
      if (item.name === 'reasoning-heartbeat') assert.equal(owner.reasoning.length, 1)
    }
  } finally {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the registered watchdog permits a controlled 600000ms completion through the actual stream consumer', async () => {
  const deny = () => { throw new Error('NETWORK_FORBIDDEN') }
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(deny)
  vi.spyOn(tls, 'connect').mockImplementation(deny)
  vi.spyOn(http, 'request').mockImplementation(deny)
  vi.spyOn(http, 'get').mockImplementation(deny)
  vi.spyOn(https, 'request').mockImplementation(deny)
  vi.spyOn(https, 'get').mockImplementation(deny)
  syncBuiltinESMExports()
  const protocol = JSON.parse(fs.readFileSync(path.join(root, 'docs/research/novel-quality-modernization/protocol.json')))
  const scenario = productionScenario('c16-c18', 'final')
  const request = { action: 'execute', phase: 'c16-c18', milestone: 'final', caseId: 'C16-A', arm: 'candidate',
    operations: continuityCaseOperations('C16-A'), attemptPolicy: scenario.attemptPolicy,
    scenarioRevision: scenario.scenarioRevision, evaluationPolicy: scenario.evaluationPolicy,
    forwardReasoning: forwardReasoningFor(protocol, 'c16-c18', 'final'),
    forwardQualificationWindow: forwardQualificationWindowFor(protocol, 'c16-c18', 'final') }
  const windows = qualificationBridgeWindows(request)
  assert.equal(windows.attemptMs, 3_660_000)
  const directory = fs.mkdtempSync(path.join(root, '.runtime/.cache/novel-quality-modernization/stream-window-'))
  const events = [], receipt = {}, owner = {}, id = 'synthetic:600000ms'
  const watchdog = new AbortController(), native = new AbortController()
  const supervisor = createAttemptSupervisor({ deadlineMs: windows.attemptMs, record: value => events.push(value) })
  const encoder = new TextEncoder()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(reasoning))
    setTimeout(() => {
      controller.enqueue(encoder.encode(content('正文')))
      controller.enqueue(encoder.encode(done))
      controller.close()
    }, 600_000)
  } })
  const [providerBody, ledgerBody] = body.tee()
  let fetches = 0
  try {
    vi.stubGlobal('fetch', async url => {
      if (++fetches !== 1 || String(url) !== 'https://network-denied.invalid/v1/chat/completions')
        throw new Error('NETWORK_FORBIDDEN')
      return new Response(providerBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    events.push({ type: 'reserve', attemptId: id }, { type: 'dispatch', attemptId: id })
    supervisor.watch(id, watchdog)
    const settlements = [], outputPath = path.join(directory, 'output.txt')
    consume(ledgerBody, supervisor, id, outputPath, receipt, settlements, fs, sha, 0)
    const generated = new OpenAIProvider().generateStream(model, [{ role: 'user', content: 'offline' }], {
      maxTokens: 2672, temperature: 0, visibleOnly: true, signal: AbortSignal.any([watchdog.signal, native.signal]),
      onChunk: () => {}, onDone: value => { owner.done = value }, onError: error => { owner.error = error },
    })
    await vi.advanceTimersByTimeAsync(600_000)
    await Promise.all([generated, ...settlements])
    assert.equal(fetches, 1)
    assert.deepEqual(events.map(value => value.type), ['reserve', 'dispatch', 'settle'])
    assert.equal(owner.done, '正文')
    assert.equal(receipt.finishReason, 'stop')
    assert.equal(fs.readFileSync(outputPath, 'utf8'), '正文')
    assert.equal(watchdog.signal.aborted, false)
    assert.equal(native.signal.aborted, false)
  } finally {
    supervisor.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
