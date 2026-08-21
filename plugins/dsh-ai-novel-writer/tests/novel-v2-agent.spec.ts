import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { createNovelV2ToolDefinitions } from '../src/agent.ts'
import { openNovelStore } from '../src/novel-store.ts'
import type { NovelStoreInitializeRequest } from '../src/novel-store.ts'
import { makeTestWorkspace } from './test-workspace.ts'

const signal = new AbortController().signal
const WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174201')
const initialization: NovelStoreInitializeRequest = {
  workspaceId: WORKSPACE_ID,
  title: '潮汐来信',
  language: 'zh-CN',
  genre: '奇幻悬疑',
  plannedChapters: 12,
  targetWordsPerChapter: 3_000,
  creativeStrategy: 'consistency-first',
  structureMode: 'three-act',
  narrativePov: 'third-limited',
  globalGuidance: '保持冷峻而温柔的语气。',
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function execution(args: unknown, root: string, callId = 'call-001'): never {
  return {
    callId,
    name: 'novel_propose_change',
    arguments: args,
    signal,
    agent: { session: { id: 'session-v2', header: { cwd: root } } },
  } as never
}

describe('AI novel V2 agent tools', () => {
  it('persists proposals with Host provenance without exposing an authoritative write tool', async () => {
    const root = await makeTestWorkspace('v2-agent-')
    const setup = await openNovelStore(root, WORKSPACE_ID)
    await setup.initialize(initialization, signal)
    const setupState = await setup.read(signal)
    await setup.dispose()
    const registry = {
      resolveByPath: async (path: string) => path === root ? { id: WORKSPACE_ID, path: root } : undefined,
    }

    const tools = createNovelV2ToolDefinitions({}, registry)
    expect(tools.map(tool => tool.name)).toEqual(['novel_read', 'novel_propose_change'])
    expect(JSON.stringify(tools.map(tool => tool.parameters))).not.toContain('novel_apply_change')
    expect(JSON.stringify(tools.map(tool => tool.parameters))).not.toContain('sessionId')
    expect(JSON.stringify(tools.map(tool => tool.parameters))).not.toContain('callId')

    const { revision: _revision, ...projectValue } = setupState.project
    const proposalArgs = {
      changes: [{
        changeSetId: 'proposal-project-title',
        aggregate: { kind: 'project' },
        baseAggregateRevision: setupState.project.revision,
        baseGlobalRevision: setupState.globalRevision,
        nextValue: { ...projectValue, title: '雾中灯塔' },
      }],
    }
    const propose = tools[1]
    const first = await propose.execute(proposalArgs, execution(proposalArgs, root))
    expect(first).toMatchObject({
      duplicate: false,
      proposal: {
        sessionId: 'session-v2',
        callId: 'call-001',
        argsHash: createHash('sha256').update(canonicalJson(proposalArgs), 'utf8').digest('hex'),
        status: 'pending',
      },
    })

    const replay = await propose.execute(proposalArgs, execution(proposalArgs, root, 'call-002'))
    expect(replay).toMatchObject({ duplicate: true })

    const read = tools[0]
    const state = await read.execute({ kind: 'state' }, execution({ kind: 'state' }, root))
    expect(state).toMatchObject({ project: { title: '潮汐来信' }, globalRevision: 0 })
    expect(JSON.stringify(state)).not.toContain(root)
    expect(JSON.stringify(state)).not.toContain('workspacePath')

    const verify = await openNovelStore(root, WORKSPACE_ID)
    try {
      const verified = await verify.read(signal)
      expect(verified.globalRevision).toBe(setupState.globalRevision)
      expect(verified.changes).toEqual(setupState.changes)
      expect(verified.project).toEqual(setupState.project)
      expect(verified.proposals).toHaveLength(1)
      expect(verified.proposals[0]).toMatchObject({ sessionId: 'session-v2', callId: 'call-001' })
    } finally {
      await verify.dispose()
    }

    await expect(propose.execute({
      ...proposalArgs,
      sessionId: 'forged-session',
      callId: 'forged-call',
      argsHash: 'a'.repeat(64),
    }, execution(proposalArgs, root))).rejects.toMatchObject({ code: 'INVALID_ARGS' })
  })
})
