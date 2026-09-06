import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanAgentVisibleText, parseToolCalls, runAgentLoop } from '../agent-engine'
import { toolRegistry } from '../tool-registry'
import { requireAgentProject } from '../tools/project-context'

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
  toolRegistry.unregister('read_blueprint')
  toolRegistry.unregister('list_chapters')
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

  it('keeps prose with trailing JSON inert even when it names a registered write tool', async () => {
    const execute = registerStartWorkflow()
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce('好的，我来启动。\n\n{"name":"start_workflow","arguments":{"workflow":"generate_draft","chapter_number":1}}')

    await runAgentLoop('system', [], '生成第一章', 'model', generate, sink)

    expect(generate).toHaveBeenCalledOnce()
    expect(sink.onToolCallConfirmRequired).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(sink.onTextChunk).toHaveBeenCalledWith(
      expect.stringContaining('"start_workflow"'),
    )
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

  it('executes a registered tool when the provider nests name and arguments tags', async () => {
    const execute = vi.fn(async () => ({ success: true, content: 'Four finalized chapters' }))
    toolRegistry.register({
      name: 'list_chapters',
      description: 'list chapters',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute,
    })
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce(`I'll inspect the completed chapters first.
<tool_call>
<name>list_chapters</name>
<arguments>
{}
</arguments>
</tool_call>`)
      .mockResolvedValueOnce('All four chapters are finalized.')

    await runAgentLoop('system', [], 'Inspect all four chapters', 'model', generate, sink)

    expect(execute).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledTimes(2)
    expect(sink.onDone).toHaveBeenCalledWith(
      "I'll inspect the completed chapters first.All four chapters are finalized.",
      [expect.objectContaining({ toolName: 'list_chapters', status: 'completed' })],
      [],
    )
  })

  it('executes a registered no-argument tool from one empty direct child tag', async () => {
    const execute = vi.fn(async () => ({ success: true, content: 'Blueprints loaded' }))
    toolRegistry.register({
      name: 'read_blueprint',
      description: 'read blueprints',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute,
    })
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce(`I'll read each chapter blueprint first.
<tool_call>
<read_blueprint>
</read_blueprint>
</tool_call>`)
      .mockResolvedValueOnce('All four chapter blueprints were inspected.')

    await runAgentLoop('system', [], 'Inspect all four chapters', 'model', generate, sink)

    expect(execute).toHaveBeenCalledWith({}, expect.any(Object))
    expect(generate).toHaveBeenCalledTimes(2)
    expect(sink.onDone).toHaveBeenCalledWith(
      "I'll read each chapter blueprint first.All four chapter blueprints were inspected.",
      [expect.objectContaining({ toolName: 'read_blueprint', arguments: {}, status: 'completed' })],
      [],
    )
  })

  it.each([
    ['unknown tool', '<tool_call><unknown_tool>\n</unknown_tool></tool_call>'],
    ['non-empty content', '<tool_call><read_blueprint>chapter 1</read_blueprint></tool_call>'],
    ['tag attributes', '<tool_call><read_blueprint chapter="1">\n</read_blueprint></tool_call>'],
  ])('rejects an empty-tag tool call with %s', (_label, response) => {
    toolRegistry.register({
      name: 'read_blueprint',
      description: 'read blueprints',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute: vi.fn(),
    })

    expect(parseToolCalls(response)).toEqual({ textParts: [], toolCalls: [] })
  })

  it('uses the frozen UI locale for tool cards and writing language for model observations', async () => {
    toolRegistry.register({
      name: 'status_probe',
      description: 'test read-only status probe',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute: async (_args, context) => {
        requireAgentProject(context)
        return { success: true, content: 'unreachable' }
      },
    })
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce('status_probe\n{}')
      .mockResolvedValueOnce('The project is not open.')

    await runAgentLoop(
      'system',
      [],
      'Read the project status',
      'model',
      generate,
      sink,
      undefined,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'en-US',
        uiLocale: 'zh-CN',
      },
    )

    expect(sink.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: '工具执行失败，请重试。',
    }))
    const secondRequest = generate.mock.calls[1]?.[0] as Array<{ role: string; content: string }>
    const observation = secondRequest.at(-1)?.content ?? ''
    expect(observation).toContain('[The following are tool results. Continue answering the user based on them.]')
    expect(observation).toContain('Tool execution failed.')
    expect(observation).not.toContain('No frozen project session')
    expect(observation).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('does not expose a failed tool result while keeping its observation in the writing language', async () => {
    toolRegistry.register({
      name: 'status_probe',
      description: 'test read-only status probe',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute: async () => ({
        success: false,
        content: '',
        error: 'provider-secret-result-error',
      }),
    })
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce('status_probe\n{}')
      .mockResolvedValueOnce('已了解。')

    await runAgentLoop(
      'system',
      [],
      '读取状态',
      'model',
      generate,
      sink,
      undefined,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'zh-CN',
        uiLocale: 'en-US',
      },
    )

    expect(sink.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'Tool execution failed. Please try again.',
    }))
    const secondRequest = generate.mock.calls[1]?.[0] as Array<{ role: string; content: string }>
    const observation = secondRequest.at(-1)?.content ?? ''
    expect(observation).toContain('工具执行失败。')
    expect(observation).not.toContain('provider-secret-result-error')
    expect(JSON.stringify(sink.onToolCallComplete.mock.calls)).not.toContain('provider-secret-result-error')
  })

  it('reports provider failures with frozen safe UI copy', async () => {
    const sink = callbacks(true)

    await runAgentLoop(
      'system',
      [],
      '读取状态',
      'model',
      vi.fn(async () => { throw new Error('provider-secret-throw') }),
      sink,
      undefined,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'zh-CN',
        uiLocale: 'en-US',
      },
    )

    expect(sink.onError).toHaveBeenCalledWith('The AI request failed. Please try again.')
    expect(JSON.stringify(sink.onError.mock.calls)).not.toContain('provider-secret-throw')
  })

  it('uses the frozen UI locale for an aborted run even when the writing language differs', async () => {
    const sink = callbacks(true)
    const controller = new AbortController()
    controller.abort()

    await runAgentLoop(
      'system',
      [],
      '停止',
      'model',
      vi.fn(),
      sink,
      controller.signal,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'zh-CN',
        uiLocale: 'en-US',
      },
    )

    expect(sink.onDone).toHaveBeenCalledWith('\n\n_(Generation stopped)_', [], [])
  })

  it('keeps English UI errors separate from Chinese model observations', async () => {
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce('<tool_call>{"name":"missing_probe","arguments":{}}</tool_call>')
      .mockResolvedValueOnce('已了解。')

    await runAgentLoop(
      'system',
      [],
      '读取状态',
      'model',
      generate,
      sink,
      undefined,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'zh-CN',
        uiLocale: 'en-US',
      },
    )

    expect(sink.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'Unknown tool: missing_probe',
    }))
    const secondRequest = generate.mock.calls[1]?.[0] as Array<{ role: string; content: string }>
    const observation = secondRequest.at(-1)?.content ?? ''
    expect(observation).toContain('[以下是工具执行结果，请根据结果继续回答用户的问题]')
    expect(observation).not.toContain('The following are tool results')
  })

  it('executes a SiliconFlow DSML tool call without exposing the protocol as prose', async () => {
    const execute = vi.fn(async () => ({ success: true, content: '蓝图已读取' }))
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
    const generate = vi.fn()
      .mockResolvedValueOnce('<｜DSML｜tool_call>\n{"name":"status_probe","arguments":{}}\n</｜DSML｜tool_call>')
      .mockResolvedValueOnce('蓝图已读取。')

    await runAgentLoop('system', [], '读取蓝图', 'model', generate, sink)

    expect(execute).toHaveBeenCalledOnce()
    expect(sink.onTextChunk).toHaveBeenCalledTimes(1)
    expect(sink.onTextChunk).toHaveBeenCalledWith('蓝图已读取。')
    expect(sink.onDone).toHaveBeenCalledWith(
      '蓝图已读取。',
      [expect.objectContaining({ toolName: 'status_probe', status: 'completed' })],
      [],
    )
  })

  it('executes one registered read tool from a whole-response JSON envelope', async () => {
    const execute = vi.fn(async () => ({ success: true, content: '第 2 章蓝图已读取' }))
    toolRegistry.register({
      name: 'read_blueprint',
      description: 'read one blueprint',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute,
    })
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce('{"name": "read_blueprint", "arguments": {"chapter_number": 2}}')
      .mockResolvedValueOnce('第 2 章蓝图显示作者指导为空。')

    await runAgentLoop('system', [], '读取第2章蓝图', 'model', generate, sink)

    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith({ chapter_number: 2 }, expect.any(Object))
    expect(sink.onToolCallConfirmRequired).not.toHaveBeenCalled()
    expect(sink.onTextChunk).toHaveBeenCalledOnce()
    expect(sink.onTextChunk).toHaveBeenCalledWith('第 2 章蓝图显示作者指导为空。')
    expect(sink.onTextChunk).not.toHaveBeenCalledWith(expect.stringContaining('"read_blueprint"'))
  })

  it.each([
    ['unknown tool', '说明\n\n{"name":"unknown_tool","arguments":{}}'],
    ['malformed JSON', '说明\n\n{"name":"read_blueprint","arguments":{'],
    ['non-object arguments', '说明\n\n{"name":"read_blueprint","arguments":[] }'],
    ['JSON followed by prose', '{"name":"read_blueprint","arguments":{}}\n补充说明'],
    ['multiple JSON calls', '{"name":"read_blueprint","arguments":{}}\n{"name":"read_blueprint","arguments":{}}'],
    ['JSON envelope with extra fields', '{"name":"read_blueprint","arguments":{},"comment":"run this"}'],
    ['ordinary prose', '好的，我会读取第 2 章蓝图。'],
  ])('does not execute %s as a trailing JSON tool call', (_label, response) => {
    toolRegistry.register({
      name: 'read_blueprint',
      description: 'read one blueprint',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute: vi.fn(),
    })

    expect(parseToolCalls(response)).toEqual({ textParts: [response], toolCalls: [] })
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

  it('drops DSML protocol blocks even when their payload is invalid', () => {
    const response = '<｜DSML｜tool_call>not-json</｜DSML｜tool_call>'

    expect(parseToolCalls(response)).toEqual({ textParts: [], toolCalls: [] })
    expect(cleanAgentVisibleText(`before\n${response}\nafter`)).toBe('before\n\nafter')
  })
})
