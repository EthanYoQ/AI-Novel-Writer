import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../openai-provider'
import { GeminiProvider } from '../gemini-provider'
import { VisibleStreamFilter } from '../visible-stream'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

const model: ModelProfile = { id: 'fixture', name: 'fixture', modelName: 'fixture', provider: 'custom', protocol: 'openai',
  apiKey: 'synthetic-only', baseUrl: 'https://example.invalid', temperature: 0.7, maxTokens: 100, purposes: ['generation'] }
function stream(events: string[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode(event))
    controller.close()
  } }) })))
}
function callbacks() {
  return { temperature: 0.7, maxTokens: 100, signal: new AbortController().signal, visibleOnly: true,
    onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onUsageEvidence: vi.fn() }
}
afterEach(() => vi.unstubAllGlobals())

describe('durable owner visible-only provider boundary', () => {
  it.each(Array.from({ length: 18 }, (_, index) => index))('holds split think markup at boundary %i without trimming author-visible whitespace', split => {
    const filter = new VisibleStreamFilter(), text = ' \r\n甲<think>秘密</think>乙😀 \n'
    const chunks = [text.slice(0, split), text.slice(split)]
    expect(chunks.map(chunk => filter.push(chunk)).join('')).toBe(' \r\n甲乙😀 \n')
    expect(filter.text).toBe(' \r\n甲乙😀 \n')
  })
  it('keeps unfinished thought and partial opening markup out of a terminal snapshot', () => {
    const filter = new VisibleStreamFilter()
    expect(filter.push('甲<th')).toBe('甲')
    expect(filter.push('ink>hidden')).toBe('')
    expect(filter.text).toBe('甲')
  })
  it('scans a large author chunk without blocking the main process for seconds', () => {
    const filter = new VisibleStreamFilter()
    const text = '正文'.repeat(50_000) + 'İ<THINK>隐藏</THINK>末尾'
    const started = performance.now()
    expect(filter.push(text)).toBe('正文'.repeat(50_000) + 'İ末尾')
    expect(performance.now() - started).toBeLessThan(1_000)
  })
  it.each([
    { error: { message: 'provider failure' } },
    { candidates: [{ content: { parts: [{ text: 42 }] } }] },
    { candidates: [{ content: { parts: [{ text: 'hidden', thought: 'true' }] } }] },
    { candidates: 'invalid' },
    null,
  ])('rejects malformed Gemini data after a previously observed STOP: %j', async payload => {
    stream([
      'data: {"candidates":[{"content":{"parts":[{"text":"作者正文 "}]},"finishReason":"STOP"}]}\n',
      `data: ${JSON.stringify(payload)}\n`,
    ])
    const options = callbacks()
    await new GeminiProvider().generateStream({ ...model, protocol: 'gemini' }, [], options)
    expect(options.onDone).not.toHaveBeenCalled()
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(expect.any(String), '作者正文 ', undefined)
  })
  it('never emits protocol reasoning fields or re-appends the terminal whole text', async () => {
    stream([
      'data: {"choices":[{"delta":{"reasoning_content":"protocol secret"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" 甲<th"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ink>inband secret</think>乙 \\n"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"completion_tokens_details":{"reasoning_tokens":7}}}\n\n',
      'data: [DONE]\n\n',
    ])
    const options = callbacks()
    await new OpenAIProvider().generateStream(model, [], options)
    expect(options.onError).not.toHaveBeenCalled()
    expect(options.onChunk.mock.calls.flat().join('')).toBe(' 甲乙 \n')
    expect(options.onDone).toHaveBeenCalledExactlyOnceWith(' 甲乙 \n', { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, 'stop')
    expect(options.onUsageEvidence).toHaveBeenCalledExactlyOnceWith({ usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, reasoningTokens: 7,
      accounting: 'included-in-completion', totalIncludesReasoning: true, protocol: 'openai' })
  })
  it('retains only the visible prefix after a transport failure', async () => {
    stream(['data: {"choices":[{"delta":{"reasoning_content":"hidden","content":"甲 "}}]}\n\n'])
    const options = callbacks()
    await new OpenAIProvider().generateStream(model, [], options)
    expect(options.onDone).not.toHaveBeenCalled()
    expect(options.onError).toHaveBeenCalledWith(expect.any(String), '甲 ', undefined)
    expect(options.onChunk.mock.calls.flat().join('')).toBe('甲 ')
  })
  it('collects all Gemini visible parts and records thoughts as already included in total', async () => {
    stream(['data: {"candidates":[{"content":{"parts":[{"text":"hidden","thought":true},{"text":" 甲"},{"functionCall":{"secret":"tool"}},{"text":"乙 ","thought":false}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"thoughtsTokenCount":7,"totalTokenCount":37}}\n'])
    const options = callbacks()
    await new GeminiProvider().generateStream({ ...model, protocol: 'gemini' }, [], options)
    expect(options.onError).not.toHaveBeenCalled()
    expect(options.onChunk.mock.calls.flat().join('')).toBe(' 甲乙 ')
    expect(options.onDone).toHaveBeenCalledExactlyOnceWith(' 甲乙 ', { promptTokens: 10, completionTokens: 20, totalTokens: 37 }, 'stop')
    expect(options.onUsageEvidence).toHaveBeenCalledExactlyOnceWith({ usage: { promptTokens: 10, completionTokens: 20, totalTokens: 37 }, reasoningTokens: 7,
      accounting: 'separately-billed', totalIncludesReasoning: true, protocol: 'gemini' })
  })
  it('does not turn a Gemini persistence callback failure into a successful completion', async () => {
    stream(['data: {"candidates":[{"content":{"parts":[{"text":"甲"}]},"finishReason":"STOP"}]}\n'])
    const options = callbacks()
    options.onChunk.mockImplementation(() => { throw new Error('synthetic disk full') })
    await new GeminiProvider().generateStream({ ...model, protocol: 'gemini' }, [], options)
    expect(options.onDone).not.toHaveBeenCalled()
    expect(options.onError).toHaveBeenCalledExactlyOnceWith('Error: synthetic disk full', '甲', undefined)
  })
})
