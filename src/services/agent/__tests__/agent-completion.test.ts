import { describe, expect, it, vi } from 'vitest'

import { requireCompleteAgentResponse } from '../agent-completion'
import { runAgentLoop } from '../agent-engine'
import { toolRegistry } from '../tool-registry'

describe('Agent completion boundary', () => {
  it('does not surface a length-truncated non-stream response as a conversation reply or artifact', async () => {
    const callbacks = {
      onTextChunk: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallComplete: vi.fn(),
      onToolCallConfirmRequired: vi.fn(async () => false),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    await runAgentLoop(
      'system',
      [],
      '请整理项目',
      'model',
      async () => requireCompleteAgentResponse({
        success: true,
        content: '<tool_call>{"name":"write_file"}</tool_call>',
        finishReason: 'length',
      }),
      callbacks,
    )

    expect(callbacks.onError).toHaveBeenCalledWith('AI 请求失败，请重试。')
    expect(JSON.stringify(callbacks.onError.mock.calls)).not.toContain('输出达到模型最大长度')
    expect(callbacks.onTextChunk).not.toHaveBeenCalled()
    expect(callbacks.onToolCallStart).not.toHaveBeenCalled()
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it('accepts a normal stop completion', () => {
    expect(requireCompleteAgentResponse({
      success: true,
      content: '完整回复',
      finishReason: 'stop',
    })).toBe('完整回复')
  })

  it('rejects a malformed response with no terminal evidence', () => {
    expect(() => requireCompleteAgentResponse({
      success: true,
      content: '看似完整但没有终止证据',
    } as never)).toThrow('AI 未正常完成生成')
  })

  it('does not execute a tool after the shared agent generation budget rejects the next model turn', async () => {
    const execute = vi.fn(async () => ({ success: true, content: 'changed' }))
    toolRegistry.register({
      name: 'budget_probe_write',
      description: 'probe',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: false,
      execute,
    })
    const callbacks = {
      onTextChunk: vi.fn(),
      onToolCallStart: vi.fn(),
      onToolCallComplete: vi.fn(),
      onToolCallConfirmRequired: vi.fn(async () => true),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    const generate = vi.fn()
      .mockResolvedValueOnce('<tool_call>{"name":"budget_probe_write","arguments":{}}</tool_call>')
      .mockRejectedValueOnce(Object.assign(new Error('agent budget exhausted'), {
        code: 'ATTEMPT_BUDGET_EXHAUSTED',
      }))

    await runAgentLoop('system', [], 'edit', 'model', generate, callbacks)

    expect(execute).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledTimes(2)
    expect(callbacks.onError).toHaveBeenCalledWith('AI 请求失败，请重试。')
    expect(JSON.stringify(callbacks.onError.mock.calls)).not.toContain('agent budget exhausted')
    expect(callbacks.onDone).not.toHaveBeenCalled()
    toolRegistry.unregister('budget_probe_write')
  })
})
