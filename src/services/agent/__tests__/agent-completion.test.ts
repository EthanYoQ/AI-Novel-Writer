import { describe, expect, it, vi } from 'vitest'

import { requireCompleteAgentResponse } from '../agent-completion'
import { runAgentLoop } from '../agent-engine'

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

    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('输出达到模型最大长度'))
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
})
