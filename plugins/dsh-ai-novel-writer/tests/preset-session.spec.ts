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
    await ctx.fiber.dispose()
  })
})
