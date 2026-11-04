import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../anthropic-provider'
import { LLMFactory } from '../llm-factory'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

interface Captured { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }

const servers: Server[] = []

async function listen(handler: (req: IncomingMessage, res: ServerResponse, captured: Captured) => void) {
  const requests: Captured[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const captured = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(captured)
      handler(req, res, captured)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, requests, server }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

function profile(baseUrl: string): ModelProfile {
  return {
    id: 'anthropic-http', name: 'Anthropic HTTP', provider: 'bigmodel-anthropic', protocol: 'anthropic',
    modelName: 'glm-5', apiKey: 'sk-local-test', baseUrl, temperature: 0.7, maxTokens: 4096, purposes: ['generation'],
  }
}

function event(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function streamCallbacks() {
  return { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
}

describe('AnthropicProvider against a local Messages server', () => {
  it('routes the anthropic protocol to {base}/v1/messages with key, version, system and max_tokens', async () => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ content: [{ type: 'text', text: '正文' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }))
    })

    const model = profile(`${upstream.origin}/api/anthropic`)
    const response = await LLMFactory.getProvider(model).generate(model, [
      { role: 'system', content: '你是小说作者' },
      { role: 'user', content: '写正文' },
    ], { temperature: 0.5, maxTokens: 512 })

    expect(response).toMatchObject({ success: true, content: '正文', finishReason: 'stop' })
    expect(upstream.requests).toHaveLength(1)
    const [request] = upstream.requests
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/api/anthropic/v1/messages')
    expect(request.headers['x-api-key']).toBe('sk-local-test')
    expect(request.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(request.body)
    expect(body).toEqual({
      model: 'glm-5', max_tokens: 512, temperature: 0.5, stream: false,
      system: '你是小说作者', messages: [{ role: 'user', content: '写正文' }],
    })
  })

  it('parses SSE frames that the server splits across network writes', async () => {
    const full = [
      event('message_start', { message: { usage: { input_tokens: 7, output_tokens: 1 } } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '第一句。' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '第二句。' } }),
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
      event('message_stop'),
    ].join('')
    const bytes = Buffer.from(full, 'utf8')
    const upstream = await listen(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (let offset = 0; offset < bytes.length; offset += 7) {
        res.write(bytes.subarray(offset, offset + 7))
        await wait(1)
      }
      res.end()
    })

    const callbacks = streamCallbacks()
    await new AnthropicProvider().generateStream(profile(upstream.origin), [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 256, signal: new AbortController().signal, ...callbacks,
    })

    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledWith('第一句。第二句。', { promptTokens: 7, completionTokens: 5, totalTokens: 12 }, 'stop')
    expect(JSON.parse(upstream.requests[0].body)).toMatchObject({ stream: true, max_tokens: 256 })
  })

  it('reports an incomplete stream when the server closes before message_stop', async () => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '半句' } }))
    })

    const callbacks = streamCallbacks()
    await new AnthropicProvider().generateStream(profile(upstream.origin), [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 256, signal: new AbortController().signal, ...callbacks,
    })

    expect(callbacks.onDone).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith('LLM_STREAM_INCOMPLETE', '半句', undefined)
  })

  it('aborts the request when generation is cancelled mid-stream and never completes', async () => {
    let closed!: () => void
    const connectionClosed = new Promise<void>(resolve => { closed = resolve })
    const upstream = await listen((_req, res) => {
      res.on('close', () => closed())
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '写到一半' } }))
    })

    const controller = new AbortController()
    const callbacks = streamCallbacks()
    callbacks.onChunk.mockImplementation(() => controller.abort())
    await new AnthropicProvider().generateStream(profile(upstream.origin), [{ role: 'user', content: '写正文' }], {
      temperature: 0.7, maxTokens: 256, signal: controller.signal, ...callbacks,
    })

    expect(callbacks.onDone).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0][0]).toBe('LLM_CANCELLED')
    await connectionClosed
  })

  it.each([
    ['generate', async (model: ModelProfile) => {
      await new AnthropicProvider().generate(model, [{ role: 'user', content: '写正文' }], { temperature: 0.7, maxTokens: 64 })
    }],
    ['generateStream', async (model: ModelProfile) => {
      await new AnthropicProvider().generateStream(model, [{ role: 'user', content: '写正文' }], {
        temperature: 0.7, maxTokens: 64, signal: new AbortController().signal, ...streamCallbacks(),
      })
    }],
  ])('%s never forwards the key to another origin the endpoint redirects to', async (_name, call) => {
    const elsewhere = await listen((_req, res) => { res.writeHead(500); res.end() })
    const configured = await listen((_req, res) => {
      res.writeHead(307, { Location: `${elsewhere.origin}/v1/messages` })
      res.end()
    })

    await call(profile(configured.origin))

    expect(configured.requests).toHaveLength(1)
    expect(elsewhere.requests.filter(request =>
      request.headers['x-api-key'] !== undefined || request.headers.authorization !== undefined)).toEqual([])
  })
})
