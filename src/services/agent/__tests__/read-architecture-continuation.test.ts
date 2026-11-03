import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentGenerationClient } from '../agent-generation-client'
import { runAgentLoop } from '../agent-engine'
import { toolRegistry } from '../tool-registry'
import { readArchitectureTool } from '../tools/read-architecture.tool'
import { AgentHostFixture } from './agent-generation.fixture'
import { useProjectStore } from '../../../stores/project-store'

const session = { projectId: 'arch-project', leaseId: 'arch-lease', projectPath: 'C:/synthetic/arch-agent' }
const project = { id: session.projectId, sessionLease: session.leaseId, path: session.projectPath, name: 'Synthetic', novelConfig: {} }
const LIMIT = 3000
const TRUNCATION_NOTE = /\n\n…（内容已截断[\s\S]*$/u

type Core = { premise: string; worldbuilding: string; charactersArch: string; synopsis: string }
let fixture: AgentHostFixture
let core: Core

function longText(length: number, seed: string): string {
  let text = ''
  for (let index = 0; text.length < length; index++) text += `${seed}${index}。`
  return text.slice(0, length)
}

function toolCall(args: Record<string, unknown>) {
  return `<tool_call>${JSON.stringify({ name: 'read_architecture', arguments: args })}</tool_call>`
}

/** A model that keeps reading while the last observation tells it where the next part starts. */
function followContinuation(firstArgs: Record<string, unknown>) {
  fixture.response = async index => {
    if (index === 0) return toolCall(firstArgs)
    const last = fixture.recovery.rounds.find(round => round.index === index - 1)?.actions.at(-1)?.observation ?? ''
    const next = /offset=(\d+)/u.exec(last)
    return next ? toolCall({ ...firstArgs, offset: Number(next[1]) }) : '已读完。'
  }
}

async function runHosted() {
  const host = new AgentGenerationClient(session)
  await host.begin({ uiActionNonce: 'synthetic-user-action', modelId: 'frozen-model', input: { mode: 'fast', uiLocale: 'zh-CN',
    historyMessages: [], userMessage: '读架构', tools: [{ name: readArchitectureTool.name, description: readArchitectureTool.description,
      inputSchema: { ...structuredClone(readArchitectureTool.inputSchema) }, source: 'builtin', requiresConfirmation: false, isReadOnly: true }] } })
  let index = 0
  const ui = { onTextChunk: vi.fn(), onToolCallStart: vi.fn(), onToolCallComplete: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
    onToolCallConfirmRequired: vi.fn(async () => true) }
  await runAgentLoop('system', [], '读架构', 'frozen-model', vi.fn(async () => host.round(index++)), ui, undefined,
    { projectSession: session, selectedModelId: 'frozen-model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', agentGeneration: host })
  expect(ui.onError).not.toHaveBeenCalled()
  return fixture.recovery.rounds.flatMap(round => round.actions).map(action => action.observation ?? '')
}

function joinSegments(observations: readonly string[]): string {
  return observations.map(observation => observation.replace(TRUNCATION_NOTE, '')).join('')
}

describe('read_architecture 超过工具结果上限时可以续读（#557）', () => {
  beforeEach(() => {
    core = { premise: '', worldbuilding: '', charactersArch: '', synopsis: '' }
    useProjectStore.setState({ currentProject: structuredClone(project) as never })
    fixture = new AgentHostFixture(session).install()
    const hostInvoke = fixture.invoke.getMockImplementation()!
    fixture.invoke.mockImplementation(async (channel: string, ...args: unknown[]) => (
      channel === 'db:project-core-get' ? structuredClone(core) : hostInvoke(channel, ...args)))
    toolRegistry.register(readArchitectureTool)
  })
  afterEach(() => {
    toolRegistry.unregister(readArchitectureTool.name)
    vi.unstubAllGlobals(); vi.restoreAllMocks()
    useProjectStore.setState({ currentProject: null })
  })

  it('7000 字剧情大纲按截断提示连续读三次，拼起来与存储内容逐字相等', async () => {
    core.synopsis = longText(7000, '主角在雨夜离开故乡')
    followContinuation({ file_name: '剧情大纲' })

    const observations = await runHosted()

    expect(observations).toHaveLength(3)
    expect(observations.slice(0, -1).every(observation => /offset=\d+/u.test(observation))).toBe(true)
    const joined = joinSegments(observations)
    expect(joined).toBe(`📐 架构文件：剧情大纲\n\n${core.synopsis}`)
    expect(joined.slice(joined.indexOf('\n\n') + 2)).toBe(core.synopsis)
  })

  it('不传 file_name 读四段、合计超过上限时，同样能逐段读完全部架构', async () => {
    core = { premise: longText(1200, '前提'), worldbuilding: longText(1500, '世界'), charactersArch: longText(1400, '角色'), synopsis: longText(1800, '大纲') }
    followContinuation({})

    const observations = await runHosted()

    expect(observations.length).toBeGreaterThan(1)
    const joined = joinSegments(observations)
    for (const section of Object.values(core)) expect(joined).toContain(section)
    expect(joined).toBe([
      '📐 故事架构（4 个文件）\n\n',
      `## 📄 premise.md\n\n${core.premise}`,
      `\n\n---\n\n## 📄 worldbuilding.md\n\n${core.worldbuilding}`,
      `\n\n---\n\n## 📄 characters.md\n\n${core.charactersArch}`,
      `\n\n---\n\n## 📄 synopsis.md\n\n${core.synopsis}`,
    ].join(''))
  })

  it('不超过上限的读取，结果与原来逐字相同，也不带续读提示', async () => {
    core.synopsis = longText(800, '短大纲')
    followContinuation({ file_name: '剧情大纲' })

    const observations = await runHosted()

    expect(observations).toEqual([`📐 架构文件：剧情大纲\n\n${core.synopsis}`])
  })

  it('截断点落在代理对中间时不切开字符，每段都是合法文本且拼回原文', async () => {
    const header = '📐 架构文件：剧情大纲\n\n'
    core.synopsis = `${longText(LIMIT - header.length - 1, '甲')}𠀀${longText(500, '乙')}`
    followContinuation({ file_name: '剧情大纲' })

    const observations = await runHosted()

    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    expect(observations.filter(observation => loneSurrogate.test(observation))).toEqual([])
    expect(joinSegments(observations)).toBe(`${header}${core.synopsis}`)
  })

  it('offset 超出内容长度时返回说明而不抛错', async () => {
    core.synopsis = longText(7000, '大纲')
    const result = await readArchitectureTool.execute({ file_name: '剧情大纲', offset: 999_999 },
      { projectSession: session, selectedModelId: null, writingLanguage: 'zh-CN', uiLocale: 'zh-CN' })

    expect(result.success).toBe(true)
    expect(result.content).not.toContain(core.synopsis.slice(0, 20))
    expect(result.content).toContain(String('📐 架构文件：剧情大纲\n\n'.length + 7000))
  })

  it.each([-1, 1.5, 'abc'])('offset=%s 不是非负整数时报错而不是静默从头读', async offset => {
    core.synopsis = longText(7000, '大纲')
    const result = await readArchitectureTool.execute({ file_name: '剧情大纲', offset },
      { projectSession: session, selectedModelId: null, writingLanguage: 'zh-CN', uiLocale: 'zh-CN' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/offset/u)
  })

  it('旧版（非宿主）循环也给出同样有效的续读提示', async () => {
    core.synopsis = longText(7000, '大纲')
    const observations: string[] = []
    const generate = vi.fn(async (messages: { role: string; content: string }[]) => {
      const last = messages.at(-1)!
      if (last.role === 'user' && last.content.includes('<tool_result')) observations.push(last.content)
      const next = /offset=(\d+)/u.exec(observations.at(-1) ?? '')
      if (generate.mock.calls.length === 1) return toolCall({ file_name: '剧情大纲' })
      return next ? toolCall({ file_name: '剧情大纲', offset: Number(next[1]) }) : '已读完。'
    })
    const ui = { onTextChunk: vi.fn(), onToolCallStart: vi.fn(), onToolCallComplete: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
      onToolCallConfirmRequired: vi.fn(async () => true) }

    await runAgentLoop('system', [], '读架构', 'model', generate, ui, undefined,
      { projectSession: session, selectedModelId: 'model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN' })

    const segments = observations.map(observation => /<tool_result name="read_architecture">\n([\s\S]*)\n<\/tool_result>/u.exec(observation)![1])
    expect(segments).toHaveLength(3)
    expect(joinSegments(segments)).toBe(`📐 架构文件：剧情大纲\n\n${core.synopsis}`)
  })
})
