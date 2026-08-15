import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createPresetInstaller } from '../src/preset-installer.ts'
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
    expect(ctx.tools.schemas()).toEqual([])
    await ctx.fiber.dispose()
  })
})
