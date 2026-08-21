import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseToolCalls, runAgentLoop } from '../agent-engine'
import { toolRegistry } from '../tool-registry'

const RAW_START_WORKFLOW = 'start_workflow\n{"workflow":"generate_draft","chapter_number":1}'

function registerStartWorkflow(execute = vi.fn(async () => ({ success: true, content: '工作流已登记' }))) {
  toolRegistry.register({
    name: 'start_workflow',
    description: 'test workflow launcher',
    source: 'builtin',
    inputSchema: { type: 'object', properties: {} },
    requiresConfirmation: true,
    isReadOnly: false,
    execute,
  })
  return execute
}

function callbacks(confirmed: boolean) {
  return {
    onTextChunk: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallComplete: vi.fn(),
    onToolCallConfirmRequired: vi.fn(async () => confirmed),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
}

afterEach(() => {
  toolRegistry.unregister('start_workflow')
  toolRegistry.unregister('status_probe')
})

describe('Agent raw tool-call compatibility', () => {
  it('recognizes a whole registered name-plus-JSON response without surfacing it as prose', async () => {
    const execute = registerStartWorkflow()
    const sink = callbacks(true)
    const startStatuses: string[] = []
    sink.onToolCallStart.mockImplementation(toolCall => {
      startStatuses.push(toolCall.status)
    })
    const generate = vi.fn()
      .mockResolvedValueOnce(RAW_START_WORKFLOW)
      .mockResolvedValueOnce('已开始生成第一章。')

    await runAgentLoop('system', [], '生成第一章', 'model', generate, sink)

    expect(sink.onToolCallConfirmRequired).toHaveBeenCalledOnce()
    expect(sink.onToolCallStart).toHaveBeenCalledOnce()
    expect(startStatuses).toEqual(['waiting_confirm'])
    expect(sink.onToolCallComplete).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(
      { workflow: 'generate_draft', chapter_number: 1 },
      expect.any(Object),
    )
    expect(sink.onTextChunk).toHaveBeenCalledWith('已开始生成第一章。')
    expect(sink.onTextChunk).not.toHaveBeenCalledWith(expect.stringContaining('start_workflow'))
    expect(sink.onDone).toHaveBeenCalledWith(
      '已开始生成第一章。',
      [expect.objectContaining({
        toolName: 'start_workflow',
        status: 'completed',
      })],
      [],
    )
  })

  it('does not execute a raw write command when the user declines confirmation', async () => {
    const execute = registerStartWorkflow()
    const sink = callbacks(false)
    const startStatuses: string[] = []
    const completionStatuses: string[] = []
    sink.onToolCallStart.mockImplementation(toolCall => {
      startStatuses.push(toolCall.status)
    })
    sink.onToolCallComplete.mockImplementation(toolCall => {
      completionStatuses.push(toolCall.status)
    })
    const generate = vi.fn()
      .mockResolvedValueOnce(RAW_START_WORKFLOW)
      .mockResolvedValueOnce('好的，未启动第一章。')

    await runAgentLoop('system', [], '生成第一章', 'model', generate, sink)

    expect(sink.onToolCallConfirmRequired).toHaveBeenCalledOnce()
    expect(sink.onToolCallStart).toHaveBeenCalledOnce()
    expect(startStatuses).toEqual(['waiting_confirm'])
    expect(sink.onToolCallComplete).toHaveBeenCalledOnce()
    expect(completionStatuses).toEqual(['failed'])
    expect(execute).not.toHaveBeenCalled()
    expect(sink.onTextChunk).toHaveBeenCalledWith('好的，未启动第一章。')
    expect(sink.onTextChunk).not.toHaveBeenCalledWith(expect.stringContaining('start_workflow'))
  })

  it('starts a non-confirming registered tool exactly once in the running state', async () => {
    const execute = vi.fn(async () => ({ success: true, content: '状态已读取' }))
    toolRegistry.register({
      name: 'status_probe',
      description: 'test read-only status probe',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute,
    })
    const sink = callbacks(true)
    const startStatuses: string[] = []
    sink.onToolCallStart.mockImplementation(toolCall => {
      startStatuses.push(toolCall.status)
    })
    const generate = vi.fn()
      .mockResolvedValueOnce('status_probe\n{}')
      .mockResolvedValueOnce('状态已读取。')

    await runAgentLoop('system', [], '读取状态', 'model', generate, sink)

    expect(sink.onToolCallConfirmRequired).not.toHaveBeenCalled()
    expect(sink.onToolCallStart).toHaveBeenCalledOnce()
    expect(startStatuses).toEqual(['running'])
    expect(sink.onToolCallComplete).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  })

  it('does not treat a raw name-plus-JSON block as a command unless the whole response is the registered call', () => {
    registerStartWorkflow()

    expect(parseToolCalls(`${RAW_START_WORKFLOW}\n补充说明`)).toEqual({
      textParts: [`${RAW_START_WORKFLOW}\n补充说明`],
      toolCalls: [],
    })
    expect(parseToolCalls('unregistered_tool\n{}')).toEqual({
      textParts: ['unregistered_tool\n{}'],
      toolCalls: [],
    })
  })
})
