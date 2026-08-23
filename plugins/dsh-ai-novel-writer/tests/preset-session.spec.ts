import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { standingMountFor } from '@deepseek-ai/dsh-agent-presets'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createBundledPresetInstaller, createPresetInstaller } from '../src/preset-installer.ts'
import { makeTestWorkspace } from './test-workspace.ts'

const packageRoot = resolve(import.meta.dirname, '..')
const templateRoot = join(packageRoot, 'presets', 'ai-novel-writer')

describe('installed AI 小说作家 preset session', () => {
  it('is discovered from the user root and gives one agent only the two novel tools', async () => {
    const presetRoot = await makeTestWorkspace('preset-session-')
    await createPresetInstaller(templateRoot, presetRoot).install()

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(packageRoot).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    for (const toolName of ['describe_image', 'ssh_exec']) {
      ctx.tools.register(defineTool({
        name: toolName,
        description: 'global integration probe',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => toolName,
      }))
    }
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, {
      default: 'ai-novel-writer',
      roots: [{ path: presetRoot, trust: 'user' }],
      includeUserRoot: false,
    })

    const listed = await ctx.agentPresets.list()
    expect(listed).toContainEqual(expect.objectContaining({ id: 'ai-novel-writer', trust: 'user' }))
    const handle = await ctx.agents.create({
      sessionId: SessionId('ai-novel-isolated'),
      setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'ai-novel-writer'),
    })

    expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort())
      .toEqual(['novel_apply_change', 'novel_read'])
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['describe_image', 'ssh_exec'])

    handle.agent.ctx.systemPrompt.tools(() => ({
      schemas: [{ name: 'late_global', description: 'late model surface', parameters: {} }],
    }))
    handle.agent.ctx.tools.register(defineTool({
      name: 'late_global',
      description: 'late execution surface',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'leaked',
    }))
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['novel_apply_change', 'novel_read'])
    await expect(ctx.tools.execute({
      callId: CallId('late-global'), name: 'late_global', arguments: {}, agent: handle.agent,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: true, error: { message: expect.stringContaining('dedicated') } })

    const mount = standingMountFor(handle.agent.ctx)
    if (mount === undefined) throw new Error('test agent did not join the installed novel Preset')
    await mount.fiber.dispose()
    expect((await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))).tools.map(tool => tool.name).sort())
      .toEqual(['describe_image', 'late_global', 'late_global', 'ssh_exec'])
    await expect(ctx.tools.execute({
      callId: CallId('late-global-after-preset-unload'), name: 'late_global', arguments: {}, agent: handle.agent,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: false, value: 'leaked' })
    await ctx.fiber.dispose()
  })

  it('isolates an existing blank agent after the Web surface selects the novel preset', async () => {
    const presetRoot = await makeTestWorkspace('preset-recompose-')
    await createPresetInstaller(templateRoot, presetRoot).install()

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(packageRoot).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(defineTool({
      name: 'ssh_exec',
      description: 'global integration probe',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'ssh_exec',
    }))
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, {
      default: 'ai-novel-writer',
      roots: [{ path: presetRoot, trust: 'user' }],
      includeUserRoot: false,
    })

    let selectedEvents = 0
    ctx.on('agent-preset/selected', () => { selectedEvents += 1 })
    const handle = await ctx.agents.create({ sessionId: SessionId('ai-novel-recomposed') })
    await ctx.agentPresets.recompose(handle.agent.ctx, 'ai-novel-writer')

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['novel_apply_change', 'novel_read'])
    await expect(ctx.tools.execute({
      callId: CallId('recomposed-before-selection-event'), name: 'ssh_exec', arguments: {}, agent: handle.agent,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: true, error: { message: expect.stringContaining('dedicated') } })

    handle.agent.session.append('agent-preset/selected', { agentPreset: 'ai-novel-writer' })
    expect(selectedEvents).toBe(1)
    expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort())
      .toEqual(['novel_apply_change', 'novel_read'])
    await expect(ctx.tools.execute({
      callId: CallId('recomposed-global'), name: 'ssh_exec', arguments: {}, agent: handle.agent,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: true, error: { message: expect.stringContaining('dedicated') } })
    await ctx.fiber.dispose()
  })

  it('gives the independent V2 preset only the read-and-proposal tool surface', async () => {
    const presetRoot = await makeTestWorkspace('preset-session-v2-')
    await createBundledPresetInstaller(join(packageRoot, 'presets'), presetRoot).install()

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(packageRoot).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    ctx.provide('workspaceRegistry' as never, {
      resolveByPath: async () => undefined,
    } as never)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, {
      default: 'ai-novel-writer-v2',
      roots: [{ path: presetRoot, trust: 'user' }],
      includeUserRoot: false,
    })

    const listed = await ctx.agentPresets.list()
    expect(listed.map(preset => preset.id)).toContain('ai-novel-writer-v2')
    expect(listed.map(preset => preset.id)).toContain('ai-novel-writer')
    const handle = await ctx.agents.create({
      sessionId: SessionId('ai-novel-v2-isolated'),
      setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'ai-novel-writer-v2'),
    })

    expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort())
      .toEqual(['novel_propose_change', 'novel_read'])
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    expect(assembly.tools.map(tool => tool.name).sort())
      .toEqual(['novel_propose_change', 'novel_read'])

    const protocol = assembly.sections.find(section => section.name === 'ai-novel-writer-v2:proposal-protocol')?.text
    expect(protocol).toEqual(expect.any(String))
    if (protocol === undefined) throw new Error('V2 proposal protocol is missing')
    const assembledPrompt = assembly.sections.map(section => section.text).join('\n')
    expect(assembledPrompt).not.toContain('A proposal can contain multiple changes')
    expect(assembledPrompt).toContain('A proposal must contain exactly one typed change')
    expect(assembledPrompt).toContain('If novel_read or novel_propose_change fails, stop this request; do not retry')
    expect(protocol).toContain('原生函数调用')
    expect(protocol).not.toContain('<tool_call>')
    expect(protocol).toContain('不得在顶层包一层 "arguments"')
    expect(protocol).toContain('novel_read 的完整输入必须严格为 {"kind":"state"}')
    expect(protocol).toContain('novel_propose_change 的直接输入必须严格为 {"changes":[...]}')
    expect(protocol).toContain('{"changes":[...],"regenerationTicket":"<opaque ticket>"}')
    expect(protocol).toContain('不得将输入整体字符串化')
    expect(protocol).toContain('不得在输入内嵌套名为 arguments 的属性')
    expect(protocol).toContain('直接输入文本必须以 {"changes":[ 开始，并按顺序以 ]} 结束')
    expect(protocol).toContain('唯一 changes 命令的 } 后必须紧跟 ] 关闭数组，再跟 } 关闭直接输入')
    expect(protocol).toContain('aggregate.kind 只能是 "project"、"architecture"、"characters"、"chapter" 或 "task"')
    expect(protocol).toContain('nextValue 必须是读取到的完整聚合值，且不得包含 revision')
    expect(protocol).toContain('baseAggregateRevision 和 baseGlobalRevision 必须原样取自刚读取的状态')
    expect(protocol).toContain('characters 的 nextValue 必须且只能是 {"items":[...],"relationships":[...]}')
    expect(protocol).toContain('characterId、name、role、summary、goal、currentState、notes')
    expect(protocol).toContain('fromCharacterId、toCharacterId、relation、notes')
    expect(protocol).toContain('state.characters.items[].characterId')
    expect(protocol).toContain('不得写 display name、角色姓名、别名或 role')
    const chapterBlueprintProposalExample = protocol
      .split('章节蓝图阶段可复制的单一 Proposal JSON：')[1]
      ?.split('\n')[0]
    expect(chapterBlueprintProposalExample).toEqual(expect.any(String))
    const chapterBlueprintProposal = JSON.parse(chapterBlueprintProposalExample!)
    expect(chapterBlueprintProposal).toEqual({
      changes: [{
        changeSetId: 'chapter-1-example',
        aggregate: { kind: 'chapter', chapter: 1 },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: {
          chapter: 1,
          title: '灯塔熄灭',
          purpose: '让孩子们发现危机并决定行动',
          plotBeats: ['阿澈发现灯塔没有亮起', '伙伴们约定寻找修复线索'],
          characters: ['ache', 'xiaoman'],
          keyEvents: ['海爷爷说明灯塔需要修理', '阿澈和小满出发寻找零件'],
          suspense: '仓库门后传来陌生的响声。',
          status: 'planned',
        },
      }],
    })
    expect(chapterBlueprintProposal.changes[0].nextValue.characters).not.toContain('阿澈')
    expect(chapterBlueprintProposal.changes[0].nextValue.characters).not.toContain('小满')
    const characterProposalExample = protocol
      .split('人物阶段可复制的单一 Proposal JSON：')[1]
      ?.split('\n')[0]
    expect(characterProposalExample).toEqual(expect.any(String))
    expect(JSON.parse(characterProposalExample!)).toEqual({
      changes: [{
        changeSetId: 'characters-example',
        aggregate: { kind: 'characters' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: {
          items: [
            {
              characterId: 'hero',
              name: '小澄',
              role: '主角',
              summary: '守护灯塔的孩子',
              goal: '让灯塔重新发光',
              currentState: '正在寻找修复线索',
              notes: '',
            },
            {
              characterId: 'friend',
              name: '阿风',
              role: '伙伴',
              summary: '擅长修理的小伙伴',
              goal: '帮助小澄',
              currentState: '带着修理工具',
              notes: '',
            },
          ],
          relationships: [{
            fromCharacterId: 'hero',
            toCharacterId: 'friend',
            relation: '伙伴',
            notes: '互相支持',
          }],
        },
      }],
    })
    expect(characterProposalExample).toMatch(/\]}}\]}$/)
    expect(protocol).toContain('relationships 只保留必要且不重复的关系')
    const projectProposalExample = protocol
      .split('项目设置阶段可复制的单一 Proposal JSON：')[1]
      ?.split('\n')[0]
    expect(projectProposalExample).toEqual(expect.any(String))
    const projectProposal = JSON.parse(projectProposalExample!)
    expect(projectProposal).toMatchObject({
      changes: [{
        changeSetId: 'project-example',
        aggregate: { kind: 'project' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
      }],
    })
    expect(Object.keys(projectProposal.changes[0].nextValue).sort()).toEqual([
      'title', 'language', 'genre', 'plannedChapters', 'targetWordsPerChapter',
      'creativeStrategy', 'structureMode', 'narrativePov', 'globalGuidance', 'createdAt', 'updatedAt',
    ].sort())
    expect(protocol).toContain('artifact/draft: kind、artifactId、chapter、content、summary')
    expect(protocol).toContain('artifact/review: kind、artifactId、chapter、parentArtifactId、report、summary')
    expect(protocol).toContain('artifact/revision: kind、artifactId、chapter、parentArtifactId、content、summary')
    expect(protocol).toContain('chapter/select-final: kind、chapter、artifactId、summary')
    expect(protocol).toContain('人工修改提交不会单独改变阶段命令')
    expect(protocol).toContain('章节初稿阶段的本地待审核初稿尚未应用')
    expect(protocol).toContain('仍使用 artifact/draft；不得使用 parentArtifactId')
    expect(protocol).toContain('只有作者明确选择已应用的章节正文版本并提交该版本的人工全文时，才使用 artifact/revision')
    expect(protocol).toContain('parentArtifactId 必须逐字复制该已应用版本的 artifactId')
    expect(protocol).toContain('artifact/revision 命令必须且只能含 kind、artifactId、chapter、parentArtifactId、content、summary')
    expect(protocol).toContain('content 必须逐字保留用户手动全文')
    expect(protocol).toContain('一次请求只提交一个 proposal')
    expect(protocol).toContain('changes 必须恰好包含一个命令')
    expect(protocol).toContain('当前阶段以外的聚合或正文版本命令')
    for (const stageMapping of [
      '项目设定优化 → aggregate.kind "project"',
      '架构设计 → aggregate.kind "architecture"',
      '角色设定 → aggregate.kind "characters"',
      '全书大纲 → aggregate.kind "architecture" 且只更新完整架构中的 plotOutline',
      '章节蓝图 → aggregate.kind "chapter"',
      '章节初稿 → artifact/draft',
      '章节修订 → artifact/revision',
      '选择定稿 → chapter/select-final',
    ]) expect(protocol).toContain(stageMapping)
    expect(protocol).toContain('不要猜测、探测或重试')

    const v1Handle = await ctx.agents.create({
      sessionId: SessionId('ai-novel-v1-no-v2-protocol'),
      setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'ai-novel-writer'),
    })
    const v1Assembly = await ctx.systemPrompt.assemble(assembleContextFor(v1Handle.agent))
    expect(v1Assembly.sections.some(section => section.name === 'ai-novel-writer-v2:proposal-protocol')).toBe(false)
    await ctx.fiber.dispose()
  })
})
