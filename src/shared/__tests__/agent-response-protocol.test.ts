import { describe, expect, it, vi } from 'vitest'
import { cleanAgentProtocolVisibleText, parseAgentResponseProtocol } from '../agent-response-protocol'

const registered = Object.freeze(['start_workflow', 'read_blueprint', 'list_chapters'])
const args = { workflow: 'generate_draft', chapter_number: 2 }
const json = JSON.stringify({ name: 'start_workflow', arguments: args })
const parse = (text: string) => parseAgentResponseProtocol(text, registered)

describe('Agent response control and visible projection', () => {
  it.each([
    ['XML', `<tool_call>${json}</tool_call>`],
    ['DSML', `<｜DSML｜tool_call>${json}</｜DSML｜tool_call>`],
    ['raw name and JSON', `start_workflow\n${JSON.stringify(args)}`],
    ['whole JSON envelope', json],
    ['nested provider tags', `<tool_call><name>start_workflow</name><arguments>${JSON.stringify(args)}</arguments></tool_call>`],
    ['extra text inside a protocol block', `<tool_call>调用如下：${json}。结束。</tool_call>`],
  ])('keeps %s as a control action without visible JSON', (_name, response) => {
    expect(parse(response)).toEqual({ textParts: [], toolCalls: [{ name: 'start_workflow', arguments: args }], visibleText: '' })
    expect(cleanAgentProtocolVisibleText(response, registered)).toBe('')
  })

  it('preserves the empty direct child form', () => {
    expect(parse('<tool_call><list_chapters></list_chapters></tool_call>').toolCalls)
      .toEqual([{ name: 'list_chapters', arguments: {} }])
  })

  it('keeps action ordering and the historical text-part concatenation', () => {
    const response = `先检查。<tool_call>${json}</tool_call>再核对。<｜DSML｜tool_call>{"name":"read_blueprint","arguments":{"chapter_number":2}}</｜DSML｜tool_call>完成。`
    const result = parse(response)
    expect(result.textParts).toEqual(['先检查。', '再核对。', '完成。'])
    expect(result.visibleText).toBe('先检查。再核对。完成。')
    expect(result.toolCalls.map(call => call.name)).toEqual(['start_workflow', 'read_blueprint'])
  })

  it.each([
    `说明\n${json}`, `${json}\n补充说明`, `${json}\n${json}`,
    '{"name":"start_workflow","arguments":{},"comment":"仅作示例"}',
    'unregistered_tool\n{}', '{"name":"unregistered_tool","arguments":{}}',
    'start_workflow\n{}\n这是例子', '{"name":"start_workflow","arguments":[]}',
  ])('keeps ordinary prose or non-executable JSON inert: %s', response => {
    expect(parse(response)).toEqual({ textParts: [response], toolCalls: [], visibleText: response })
  })

  it('uses only the supplied frozen names for whole-response compatibility', () => {
    const names = ['read_blueprint']
    const frozenNames = Object.freeze([...names])
    names.push('start_workflow')
    expect(parseAgentResponseProtocol(json, frozenNames).toolCalls).toEqual([])
    expect(parse(json).toolCalls).toHaveLength(1)
    expect(frozenNames).toEqual(['read_blueprint'])
  })

  it('retains tagged unknown actions for the existing host unknown-tool observation', () => {
    expect(parse('<tool_call>{"name":"not_registered"}</tool_call>').toolCalls)
      .toEqual([{ name: 'not_registered', arguments: {} }])
  })

  it.each(['[]', 'null', '"secret"', 'false', '3'])('rejects non-object argument payload %s', value => {
    const response = `<tool_call>{"name":"start_workflow","arguments":${value}}</tool_call>`
    // Historical null/missing arguments mean no arguments, not a primitive payload.
    expect(parse(response).toolCalls).toEqual(value === 'null' ? [{ name: 'start_workflow', arguments: {} }] : [])
    expect(parse(response).visibleText).toBe('')
  })

  it.each(['think', 'thinking', 'analysis', 'reasoning'])('never projects or executes hidden %s content', tag => {
    const response = `可见前文<${tag}>机密推理<tool_call>${json}</tool_call></${tag}>可见后文`
    expect(parse(response)).toEqual({ textParts: ['可见前文可见后文'], toolCalls: [], visibleText: '可见前文可见后文' })
  })

  it('handles nested hidden reasoning without exposing an inner close suffix', () => {
    expect(parse('<think>秘密一<analysis>秘密二</analysis>秘密三</think>回答。').visibleText).toBe('回答。')
    expect(parse('<think>秘密</analysis>仍是秘密').visibleText).toBe('')
  })

  it('removes orphan closing reasoning prefixes before considering tools visible or executable', () => {
    expect(parse(`秘密<tool_call>${json}</tool_call></think>答复。`))
      .toEqual({ textParts: ['答复。'], toolCalls: [], visibleText: '答复。' })
  })

  it.each([
    `<tool_call>${json}`, `<｜DSML｜tool_call>${json}`, '<tool_result name="read_blueprint">机密工具结果',
    '<think>机密推理', '<analysis>机密推理', '<tool_call', '<tool_cal', '<｜DSML｜tool_call', '<tool_call\tsecret',
  ])('hides an unclosed or partial protocol tail: %s', tail => {
    const response = `可见答复。${tail}`
    expect(parse(response)).toEqual({ textParts: ['可见答复。'], toolCalls: [], visibleText: '可见答复。' })
    expect(cleanAgentProtocolVisibleText(response, registered)).toBe('可见答复。')
  })

  it('never interprets actions echoed inside a tool result', () => {
    expect(parse(`<tool_result name="read_blueprint"><tool_call>${json}</tool_call></tool_result>答复。`))
      .toEqual({ textParts: ['答复。'], toolCalls: [], visibleText: '答复。' })
  })

  it('does not promote an inner tool block when its outer block was never closed', () => {
    expect(parse(`<tool_call><tool_call>${json}</tool_call>`))
      .toEqual({ textParts: [], toolCalls: [], visibleText: '' })
  })

  it('preserves literal argument bytes instead of rewriting strings as visible prose', () => {
    const content = '<think>引用文本</think>🙂 中文\n原始空白'
    const call = { name: 'start_workflow', arguments: { content } }
    expect(parse(JSON.stringify(call)).toolCalls).toEqual([call])
    expect(parse(`<tool_call>${JSON.stringify(call)}</tool_call>`).toolCalls).toEqual([call])
  })

  it('cleans prose whitespace without leaking malformed payload into diagnostics', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = 'before\n<｜DSML｜tool_call>secret-not-json</｜DSML｜tool_call>\nafter'
      expect(cleanAgentProtocolVisibleText(response, registered)).toBe('before\n\nafter')
      expect(parse(response).visibleText).toBe('beforeafter')
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    } finally { warn.mockRestore(); error.mockRestore() }
  })
})

it.each([
 ['普通正文', '海港静下来。\n\n钟声响起。', '海港静下来。\n\n钟声响起。'],
 ['XML未闭合', '海港静下来。<tool_call>{"name":"start_workflow"', '海港静下来。'],
 ['DSML未闭合', '海港静下来。<｜DSML｜tool_call>{"name":', '海港静下来。'],
 ['analysis未闭合', '海港静下来。<analysis>隐藏推理', '海港静下来。'],
 ['reasoning未闭合', '海港静下来。<reasoning>隐藏推理', '海港静下来。'],
 ['raw name JSON', 'start_workflow\n{"workflow":', ''],
 ['JSON envelope', '{"name":"start_workflow","arguments":', ''],
 ['partial tag', '海港静下来。<tool_ca', '海港静下来。'],
] as const)('中断投影 %s 仅保留可证明正文', async (_name, raw, expected) => {
 const { projectInterruptedAgentVisibleText } = await import('../agent-response-protocol')
 expect(projectInterruptedAgentVisibleText(raw, registered)).toBe(expected)
})
