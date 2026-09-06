import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgentLoop } from '../agent-engine'
import { toolRegistry, type AgentExecutionContext, type ToolResult } from '../tool-registry'

function callbacks() {
  return {
    onTextChunk: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallComplete: vi.fn(),
    onToolCallConfirmRequired: vi.fn(async () => true),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
}

function context(): AgentExecutionContext {
  return {
    projectSession: null,
    selectedModelId: 'model',
    uiLocale: 'en-US',
    writingLanguage: 'en-US',
  }
}

afterEach(() => {
  vi.useRealTimers()
  toolRegistry.unregister('timeout_read_probe')
  toolRegistry.unregister('timeout_write_probe')
  toolRegistry.unregister('delayed_write_probe')
  toolRegistry.unregister('cancelled_write_probe')
  toolRegistry.unregister('unknown_write_probe')
  toolRegistry.unregister('returned_unknown_write_probe')
  toolRegistry.unregister('returned_not_committed_write_probe')
  toolRegistry.unregister('precommit_failure_probe')
  toolRegistry.unregister('read_failure_probe')
})

describe('Agent tool timeout boundary', () => {
  it('aborts a timed-out read-only tool and clears its lifecycle as a timeout', async () => {
    vi.useFakeTimers()
    let observedAbort = false
    toolRegistry.register({
      name: 'timeout_read_probe', description: 'probe', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: true,
      execute: async (_args, execution) => new Promise<ToolResult>((resolve) => {
        execution?.abortSignal?.addEventListener('abort', () => {
          observedAbort = true
          resolve({ success: false, content: '', error: 'cancelled' })
        }, { once: true })
      }),
    })
    const ui = callbacks()
    const run = runAgentLoop(
      'system', [], 'read', 'model',
      vi.fn()
        .mockResolvedValueOnce('<tool_call>{"name":"timeout_read_probe","arguments":{}}</tool_call>')
        .mockResolvedValueOnce('done'),
      ui,
      undefined,
      context(),
    )

    await vi.advanceTimersByTimeAsync(30_000)
    await run

    expect(observedAbort).toBe(true)
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('timed out'),
    }))
  })

  it('aborts a timed-out write before it crosses the commit point', async () => {
    vi.useFakeTimers()
    let observedAbort = false
    let finishWrite: ((result: ToolResult) => void) | undefined
    toolRegistry.register({
      name: 'timeout_write_probe', description: 'probe', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: false,
      execute: async (_args, execution) => new Promise<ToolResult>((resolve) => {
        finishWrite = resolve
        execution?.abortSignal?.addEventListener('abort', () => {
          observedAbort = true
        }, { once: true })
      }),
    })
    const ui = callbacks()
    const run = runAgentLoop(
      'system', [], 'write', 'model',
      vi.fn()
        .mockResolvedValueOnce('<tool_call>{"name":"timeout_write_probe","arguments":{}}</tool_call>')
        .mockResolvedValueOnce('done'),
      ui,
      undefined,
      context(),
    )

    await vi.advanceTimersByTimeAsync(30_000)
    const abortedAtDeadline = observedAbort
    finishWrite?.({ success: true, content: 'late receipt' })
    await run

    expect(abortedAtDeadline).toBe(true)
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: expect.stringContaining('timed out'),
    }))
  })

  it('bounds foreground waiting after a write is dispatched and keeps a late receipt on the old operation', async () => {
    vi.useFakeTimers()
    let finishWrite: ((result: ToolResult) => void) | undefined
    const execute = vi.fn(async (_args: Record<string, unknown>, execution?: AgentExecutionContext) => (
      new Promise<ToolResult>((resolve) => {
        expect(execution?.abortSignal).toBeInstanceOf(AbortSignal)
        execution?.markSideEffectStarted?.()
        finishWrite = resolve
      })
    ))
    toolRegistry.register({
      name: 'delayed_write_probe', description: 'probe', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: false,
      execute,
    })
    const ui = callbacks()
    const run = runAgentLoop(
      'system', [], 'write', 'model',
      vi.fn()
        .mockResolvedValueOnce('<tool_call>{"name":"delayed_write_probe","arguments":{}}</tool_call>')
        .mockResolvedValueOnce('done'),
      ui,
      undefined,
      context(),
    )
    await vi.advanceTimersByTimeAsync(30_000)

    expect(ui.onDone).toHaveBeenCalledWith(
      expect.stringContaining('stopped to avoid a duplicate write'),
      expect.anything(),
      expect.anything(),
    )
    expect(execute).toHaveBeenCalledOnce()
    finishWrite?.({ success: true, content: 'committed once' })
    await run

    expect(execute).toHaveBeenCalledOnce()
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'result_unknown',
    }))
  })

  it('propagates stop to a write tool so it can refuse before its commit point', async () => {
    let reachCommitBoundary: (() => void) | undefined
    let writes = 0
    toolRegistry.register({
      name: 'cancelled_write_probe', description: 'probe', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: false,
      execute: async (_args, execution) => {
        await new Promise<void>((resolve) => { reachCommitBoundary = resolve })
        if (execution?.abortSignal?.aborted) {
          return { success: false, content: '', error: 'cancelled before commit' }
        }
        writes++
        return { success: true, content: 'committed' }
      },
    })
    const controller = new AbortController()
    const ui = callbacks()
    const run = runAgentLoop(
      'system', [], 'write', 'model',
      vi.fn().mockResolvedValue('<tool_call>{"name":"cancelled_write_probe","arguments":{}}</tool_call>'),
      ui,
      controller.signal,
      context(),
    )
    await vi.waitFor(() => expect(reachCommitBoundary).toBeTypeOf('function'))

    controller.abort()
    reachCommitBoundary?.()
    await run

    expect(writes).toBe(0)
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(ui.onDone).toHaveBeenCalledWith(expect.stringContaining('Generation stopped'), expect.anything(), expect.anything())
  })

  it('stops the Agent instead of automatically retrying a write whose receipt is unknown', async () => {
    const execute = vi.fn(async (_args: Record<string, unknown>, execution?: AgentExecutionContext) => {
      execution?.markSideEffectStarted?.()
      throw new Error('transport closed after commit')
    })
    toolRegistry.register({
      name: 'unknown_write_probe', description: 'probe', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: false,
      execute,
    })
    const ui = callbacks()
    const generate = vi.fn()
      .mockResolvedValueOnce('<tool_call>{"name":"unknown_write_probe","arguments":{}}</tool_call>')
      .mockResolvedValueOnce('<tool_call>{"name":"unknown_write_probe","arguments":{}}</tool_call>')

    await runAgentLoop('system', [], 'write', 'model', generate, ui, undefined, context())

    expect(execute).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledOnce()
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'result_unknown',
      commitState: 'unknown',
      error: expect.stringContaining('result is unknown'),
    }))
    expect(ui.onDone).toHaveBeenCalledWith(
      expect.stringContaining('stopped to avoid a duplicate write'),
      expect.anything(),
      expect.anything(),
    )
  })

  it('treats a normally returned unknown write result the same as a rejected receipt', async () => {
    const execute = vi.fn(async (_args: Record<string, unknown>, execution?: AgentExecutionContext) => {
      execution?.markSideEffectStarted?.()
      return {
        success: false,
        content: '',
        error: 'receipt unavailable',
        commitState: 'unknown',
      } as ToolResult & { commitState: 'unknown' }
    })
    toolRegistry.register({
      name: 'returned_unknown_write_probe', description: 'probe', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: false,
      execute,
    })
    const ui = callbacks()
    const generate = vi.fn()
      .mockResolvedValueOnce('<tool_call>{"name":"returned_unknown_write_probe","arguments":{}}</tool_call>')
      .mockResolvedValueOnce('<tool_call>{"name":"returned_unknown_write_probe","arguments":{}}</tool_call>')

    await runAgentLoop('system', [], 'write', 'model', generate, ui, undefined, context())

    expect(execute).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledOnce()
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'result_unknown',
      commitState: 'unknown',
    }))
  })

  it('continues after a normally returned write failure is known not to have committed', async () => {
    const execute = vi.fn(async () => ({
      success: false,
      content: '',
      error: 'validation rejected',
      commitState: 'not_committed',
    } as ToolResult & { commitState: 'not_committed' }))
    toolRegistry.register({
      name: 'returned_not_committed_write_probe', description: 'probe', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: false,
      execute,
    })
    const ui = callbacks()
    const generate = vi.fn()
      .mockResolvedValueOnce('<tool_call>{"name":"returned_not_committed_write_probe","arguments":{}}</tool_call>')
      .mockResolvedValueOnce('handled')

    await runAgentLoop('system', [], 'write', 'model', generate, ui, undefined, context())

    expect(generate).toHaveBeenCalledTimes(2)
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      commitState: 'not_committed',
    }))
  })

  it('marks rejected writes before dispatch as not committed', async () => {
    toolRegistry.register({
      name: 'precommit_failure_probe', description: 'probe', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: false,
      execute: async () => { throw new Error('validation failed before dispatch') },
    })
    const ui = callbacks()
    await runAgentLoop(
      'system', [], 'write', 'model',
      vi.fn()
        .mockResolvedValueOnce('<tool_call>{"name":"precommit_failure_probe","arguments":{}}</tool_call>')
        .mockResolvedValueOnce('handled'),
      ui,
      undefined,
      context(),
    )

    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      commitState: 'not_committed',
    }))
  })

  it('does not invent a commit state for a rejected read-only tool', async () => {
    toolRegistry.register({
      name: 'read_failure_probe', description: 'probe', source: 'builtin',
      inputSchema: { type: 'object', properties: {} }, requiresConfirmation: false, isReadOnly: true,
      execute: async () => { throw new Error('read failed') },
    })
    const ui = callbacks()
    await runAgentLoop(
      'system', [], 'read', 'model',
      vi.fn()
        .mockResolvedValueOnce('<tool_call>{"name":"read_failure_probe","arguments":{}}</tool_call>')
        .mockResolvedValueOnce('handled'),
      ui,
      undefined,
      context(),
    )

    const completed = ui.onToolCallComplete.mock.calls[0]?.[0]
    expect(completed).toMatchObject({ status: 'failed' })
    expect(completed).not.toHaveProperty('commitState')
  })
})
