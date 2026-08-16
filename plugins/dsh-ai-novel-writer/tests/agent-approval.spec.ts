import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/agent.ts'
import { openNovelProject } from '../src/novel-project.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

const initialize = {
  ...TEST_INITIALIZATION_IDENTITY,
  kind: 'initialize' as const,
  title: '潮汐信',
  language: 'zh-CN',
  genre: '奇幻',
  plannedChapters: 6,
  targetWordsPerChapter: 2_000,
  creativeStrategy: 'auto' as const,
}

function fakeAgent(root: string): Agent {
  return {
    session: {
      header: { cwd: root },
      events: [{ type: 'turn/start' }],
      append: () => ({}),
    },
  } as unknown as Agent
}

async function setup(policy: 'ask' | 'never' = 'ask'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy })
  apply(ctx)
  return ctx
}

async function executeInitialize(ctx: Context, root: string) {
  return ctx.tools.execute({
    callId: CallId('novel-init'),
    name: 'novel_apply_change',
    arguments: initialize,
    agent: fakeAgent(root),
    signal: new AbortController().signal,
  })
}

describe('AI novel native approval integration', () => {
  it('executes exactly once after an allowed-once answer', async () => {
    const root = await makeTestWorkspace('approved-')
    const ctx = await setup()
    let answers = 0
    ctx.on('approval/request', () => {
      answers += 1
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })

    const result = await executeInitialize(ctx, root)

    expect(result).toMatchObject({
      isError: false,
      value: { oldRevision: 'absent', newRevision: expect.stringMatching(/^[0-9a-f]{64}$/) },
      meta: { newRevision: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
    expect(answers).toBe(1)
    await expect(access(join(root, '.ai-novel', 'project.json'))).resolves.toBeUndefined()
  })

  it.each([
    ['rejected', 'rejected'],
    ['cancelled', 'cancelled'],
  ] as const)('leaves disk unchanged when approval is %s', async (_label, outcome) => {
    const root = await makeTestWorkspace(`${outcome}-`)
    const ctx = await setup()
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(outcome))

    const result = await executeInitialize(ctx, root)

    expect(result.isError).toBe(true)
    await expect(access(join(root, '.ai-novel', 'project.json'))).rejects.toThrow()
  })

  it('leaves disk unchanged when no approval answerer is available', async () => {
    const root = await makeTestWorkspace('unavailable-')
    const result = await executeInitialize(await setup(), root)

    expect(result.isError).toBe(true)
    await expect(access(join(root, '.ai-novel', 'project.json'))).rejects.toThrow()
  })

  it('leaves disk unchanged and never consults an answerer under the never policy', async () => {
    const root = await makeTestWorkspace('never-')
    const ctx = await setup('never')
    let consulted = false
    ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })

    const result = await executeInitialize(ctx, root)

    expect(result.isError).toBe(true)
    expect(consulted).toBe(false)
    await expect(access(join(root, '.ai-novel', 'project.json'))).rejects.toThrow()
  })

  it('rechecks the asset revision after approval before writing', async () => {
    const root = await makeTestWorkspace('approval-race-')
    await openNovelProject(root).apply(initialize, new AbortController().signal)
    const ctx = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<ApprovalOutcome>()
    ctx.on('approval/request', () => {
      entered.resolve()
      return release.promise
    })
    const filename = join(root, 'chapters', '0001.md')
    const pending = ctx.tools.execute({
      callId: CallId('novel-race'),
      name: 'novel_apply_change',
      arguments: {
        kind: 'replace', targetKind: 'chapter-draft', chapter: 1,
        baseRevision: 'absent', replacement: '模型提案\n', summary: '写入第一章',
      },
      agent: fakeAgent(root),
      signal: new AbortController().signal,
    })

    await entered.promise
    await mkdir(join(root, 'chapters'), { recursive: true })
    await writeFile(filename, '审批期间的外部修改\n')
    release.resolve('allowed-once')
    const result = await pending

    expect(result).toMatchObject({ isError: true, error: { info: { code: 'STALE_REVISION' } } })
    await expect(readFile(filename, 'utf8')).resolves.toBe('审批期间的外部修改\n')
  })
})
