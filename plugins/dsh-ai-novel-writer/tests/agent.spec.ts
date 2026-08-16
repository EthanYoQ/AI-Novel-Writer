import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { CallId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import * as NovelAgent from '../src/agent.ts'
import { createNovelToolDefinitions, novelApprovalGate, presentNovelChange } from '../src/agent.ts'
import { openNovelProject } from '../src/novel-project.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

describe('AI novel agent tools', () => {
  it('publishes exactly two path-free tools and asks before every mutation', async () => {
    const [read, apply] = createNovelToolDefinitions()
    expect([read.name, apply.name]).toEqual(['novel_read', 'novel_apply_change'])
    const schemas = JSON.stringify([read.parameters, apply.parameters])
    expect(schemas).not.toContain('file_path')
    expect(schemas).not.toContain('workspacePath')
    expect(schemas).not.toContain('"request"')
    expect(read.parameters).toMatchObject({
      properties: {
        kind: { enum: ['asset', 'working-set', 'query'] },
        targetKind: { enum: ['project', 'characters', 'story-blueprint', 'chapter-blueprint', 'chapter-draft'] },
      },
      required: ['kind'],
    })
    expect(apply.parameters).toMatchObject({
      properties: {
        kind: { enum: ['initialize', 'replace'] },
        targetKind: { enum: ['project', 'characters', 'story-blueprint', 'chapter-blueprint', 'chapter-draft'] },
      },
      required: ['kind'],
    })

    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(novelApprovalGate({ name: 'novel_read' }, next)).resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledOnce()
    next.mockClear()
    await expect(novelApprovalGate({ name: 'novel_apply_change' }, next)).resolves.toEqual({
      kind: 'ask',
      reason: '批准后仅修改这一个小说资产。',
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('renders a replay-safe single-file diff directly from replace arguments', () => {
    const apply = createNovelToolDefinitions()[1]
    expect(apply.presentCall?.({
      kind: 'replace',
      targetKind: 'chapter-draft',
      chapter: 2,
      baseRevision: 'a'.repeat(64),
      baseText: '旧正文\r\n',
      replacement: '新正文\r\n',
      summary: '重写第二章开场',
    })).toEqual({
      card: 'diff',
      title: '重写第二章开场',
      diffs: [{ path: 'chapters/0002.md', oldText: '旧正文\n', newText: '新正文\n' }],
      locations: [{ path: 'chapters/0002.md' }],
    })
  })

  it('resolves the project only from the approved session cwd', async () => {
    const root = await makeTestWorkspace('tool-')
    const apply = createNovelToolDefinitions()[1]
    const signal = new AbortController().signal
    const value = await apply.execute({
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize', title: '潮汐信', language: 'zh-CN', genre: '奇幻',
      plannedChapters: 6, targetWordsPerChapter: 2_000, creativeStrategy: 'auto',
    }, {
      signal,
      agent: { session: { header: { cwd: root } } },
    } as never)

    expect(value).toMatchObject({ target: { kind: 'project' }, oldRevision: 'absent' })
  })

  it('rejects one stringified nested request without touching the workspace', async () => {
    const root = await makeTestWorkspace('stringified-request-')
    const apply = createNovelToolDefinitions()[1]

    await expect(apply.execute({
      request: JSON.stringify({ kind: 'initialize', title: '错误嵌套' }),
    } as never, {
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: root } } },
    } as never)).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    await expect(access(join(root, '.ai-novel', 'project.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects replacement drift while the project is uninitialized', async () => {
    const root = await makeTestWorkspace('uninitialized-replace-')
    const apply = createNovelToolDefinitions()[1]

    await expect(apply.execute({
      kind: 'replace', targetKind: 'characters', baseRevision: 'absent', baseText: '',
      replacement: '{"characters":[]}', summary: '不能越过初始化',
    }, {
      signal: new AbortController().signal,
      agent: { session: { header: { cwd: root } } },
    } as never)).rejects.toMatchObject({ code: 'NOT_INITIALIZED' })
    await expect(access(join(root, '.ai-novel', 'project.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shows exactly the canonical bytes that a structured replacement commits', async () => {
    const root = await makeTestWorkspace('canonical-diff-')
    const project = openNovelProject(root)
    const signal = new AbortController().signal
    await project.apply({
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize', title: '潮汐信', language: 'zh-CN', genre: '奇幻',
      plannedChapters: 6, targetWordsPerChapter: 2_000, creativeStrategy: 'auto',
    }, signal)
    const request = {
      kind: 'replace' as const,
      target: { kind: 'story-blueprint' as const },
      baseRevision: 'absent' as const,
      baseText: '',
      replacement: JSON.stringify({
        endingGoal: '潮汐退去', mainPlot: '寻找失踪的信使', world: '浮岛群',
        themes: ['记忆'], premise: '信件来自明天',
      }),
      summary: '建立故事蓝图',
    }

    const card = presentNovelChange(request)
    await project.apply(request, signal)
    const asset = await project.read({ kind: 'asset', target: request.target }, signal)

    expect(card.diffs[0]?.newText).toBe(asset.kind === 'asset' ? asset.text : undefined)
  })

  it('shows exactly the initialized manifest bytes that approval commits', async () => {
    const root = await makeTestWorkspace('initialize-diff-')
    const project = openNovelProject(root)
    const signal = new AbortController().signal
    const request = {
      ...TEST_INITIALIZATION_IDENTITY,
      kind: 'initialize' as const,
      title: '  潮汐信  ',
      language: ' zh-CN ',
      genre: ' 奇幻 ',
      plannedChapters: 6,
      targetWordsPerChapter: 2_000,
      creativeStrategy: 'auto' as const,
    }

    const card = presentNovelChange(request)
    await project.apply(request, signal)
    const asset = await project.read({ kind: 'asset', target: { kind: 'project' } }, signal)

    expect(card.diffs[0]?.newText).toBe(asset.kind === 'asset' ? asset.text : undefined)
  })

  it('removes its tools and approval listener when the plugin fiber unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = ctx.plugin(NovelAgent)
    await fiber
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['novel_read', 'novel_apply_change'])

    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    ctx.tools.register(defineTool({
      name: 'novel_apply_change',
      description: 'lifecycle probe',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'unloaded',
    }))

    await expect(ctx.tools.execute({
      callId: CallId('after-unload'), name: 'novel_apply_change', arguments: {},
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: false, value: 'unloaded' })
    await ctx.fiber.dispose()
  })

  it('restores inherited tools when an agent-scoped plugin fiber unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    for (const toolName of ['describe_image', 'ssh_exec']) {
      ctx.tools.register(defineTool({
        name: toolName,
        description: 'global lifecycle probe',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => toolName,
      }))
    }
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const presetKey = { agentPreset: 'ai-novel-writer' }
    const presetScope = createScope(ctx, presetKey)
    const fiber = presetScope.ctx.plugin(NovelAgent)
    await fiber
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId('novel-agent-hmr'),
        setup: (agentCtx) => {
          const agentKey = scopeOf(agentCtx)
          if (agentKey === undefined) throw new Error('agent creation did not publish a scope key')
          bindScopeParent(agentKey, presetKey)
        },
      })
      try {
        expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort())
          .toEqual(['novel_apply_change', 'novel_read'])
        await fiber.dispose()
        expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()).toEqual(['describe_image', 'ssh_exec'])
      } finally {
        await handle.dispose()
      }
    } finally {
      await presetScope.dispose()
      await ctx.fiber.dispose()
    }
  })
})
