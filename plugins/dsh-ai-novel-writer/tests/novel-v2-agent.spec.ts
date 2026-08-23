import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { isJsonValue, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { describe, expect, it } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { createNovelV2ToolDefinitions } from '../src/agent.ts'
import * as NovelAgentV2 from '../src/agent-v2.ts'
import { createAiNovelCommandRpcHandler } from '../src/command-rpc.ts'
import { openNovelStore } from '../src/novel-store.ts'
import type { NovelProposalReceipt, NovelStoreInitializeRequest } from '../src/novel-store.ts'
import type { NovelProposalListResult } from '../src/command-rpc.ts'
import { makeTestWorkspace } from './test-workspace.ts'

const signal = new AbortController().signal
const WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174201')
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_ROOT = join(PLUGIN_ROOT, 'presets')
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

async function executeV2ReadThroughToolRuntime(root: string): Promise<unknown> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  ctx.provide('workspaceRegistry' as never, {
    resolveByPath: async (path: string) => path === root ? { id: WORKSPACE_ID, path: root } : undefined,
  } as never)
  await ctx.plugin(NovelAgentV2)
  try {
    return await ctx.tools.execute({
      callId: CallId('novel-read-json-boundary'),
      name: 'novel_read',
      arguments: { kind: 'state' },
      signal,
      agent: { ctx, session: { header: { cwd: root } } } as never,
    })
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Build a real preset recompose path, including one unrelated inherited Host tool. */
async function createV1ToV2RecomposeHarness(root: string): Promise<{ readonly ctx: Context; readonly agent: NonNullable<ReturnType<Context['agents']['roots']>[number]> }> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- id: llm\n  name: '@deepseek-ai/dsh-llm'",
    "- id: sessions\n  name: '@deepseek-ai/dsh-session'",
    "- id: system-prompt\n  name: '@deepseek-ai/dsh-system-prompt'\n  config:\n    persona: ''",
    "- id: tools\n  name: '@deepseek-ai/dsh-tools'",
    "- id: approval\n  name: '@deepseek-ai/dsh-user-approval'\n  config:\n    policy: ask",
    "- id: agents\n  name: '@deepseek-ai/dsh-agent'",
    "- id: agent-loop\n  name: '@deepseek-ai/dsh-agent-loop'\n  config:\n    agents: []",
    `- id: presets\n  name: '@deepseek-ai/dsh-agent-presets'\n  config:\n    default: ai-novel-writer\n    roots:\n      - path: ${JSON.stringify(PRESET_ROOT)}\n        trust: user\n    includeUserRoot: false`,
    '',
  ].join('\n\n'), 'utf8')
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(dirname(configPath)).href}/`
  ctx.provide('workspaceRegistry' as never, { resolveByPath: async () => undefined } as never)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  ctx.tools.register(defineTool({
    name: 'host_extra',
    description: 'Unrelated Host tool that must never reach the V2 model request.',
    parameters: {},
    output: { schema: { type: 'json' }, render: () => [] },
    isConcurrencySafe: () => true,
    execute: async () => ({}),
  }))
  await ctx.agents.create({
    sessionId: SessionId('v2-recompose-tool-surface'),
    meta: { cwd: root, agentPreset: 'ai-novel-writer' },
    agentOptions: { provider: 'qualification', model: 'qualification' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'ai-novel-writer'),
  })
  const agent = ctx.agents.roots()[0]
  if (agent === undefined) {
    await ctx.fiber.dispose()
    throw new Error('V1-to-V2 preset harness did not create an agent')
  }
  await ctx.agentPresets.recompose(agent.ctx, 'ai-novel-writer-v2')
  agent.session.append('agent-preset/selected', { agentPreset: 'ai-novel-writer-v2' })
  return { ctx, agent }
}

describe('AI novel V2 agent tools', () => {
  it('replaces a V1 tool restriction on a blank-session V2 switch and excludes foreign Host tools from the model request', async () => {
    const root = await makeTestWorkspace('v2-agent-preset-recompose-')
    const { ctx, agent } = await createV1ToV2RecomposeHarness(root)
    try {
      const visible = ctx.tools.schemas(agent).map(tool => tool.name)
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })

      expect(visible).toHaveLength(2)
      expect(new Set(visible)).toEqual(new Set(['novel_read', 'novel_propose_change']))
      expect(assembly.tools).toHaveLength(2)
      expect(new Set(assembly.tools.map(tool => tool.name))).toEqual(new Set(['novel_read', 'novel_propose_change']))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('puts one closed direct artifact/draft example in the V2 model-visible proposal protocol', async () => {
    const root = await makeTestWorkspace('v2-agent-draft-protocol-')
    const { ctx, agent } = await createV1ToV2RecomposeHarness(root)
    const directDraftExample = '{"changes":[{"kind":"artifact/draft","artifactId":"draft-1-example","chapter":1,"content":"第一章正文示例。","summary":"第一章初稿。"}]}'
    try {
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
      const protocol = assembly.sections.find(section => section.name === 'ai-novel-writer-v2:proposal-protocol')?.text
      const propose = assembly.tools.find(tool => tool.name === 'novel_propose_change')
      expect(protocol).toContain(directDraftExample)
      expect(propose?.parameters).toMatchObject({
        properties: { changes: { description: expect.stringContaining(directDraftExample) } },
      })
      const documentedDraft = protocol?.match(/章节初稿阶段可复制的单一 Proposal JSON：({.*?})\n\n/)?.[1]

      expect(documentedDraft).toBe(directDraftExample)
      for (const forbidden of ['changeSetId', 'aggregate', 'baseAggregateRevision', 'baseGlobalRevision', 'nextValue']) {
        expect(documentedDraft).not.toContain(forbidden)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a locally hydrated pending draft replacement as artifact/draft and reserves revisions for an applied selected artifact', async () => {
    const root = await makeTestWorkspace('v2-agent-pending-draft-protocol-')
    const { ctx, agent } = await createV1ToV2RecomposeHarness(root)
    try {
      const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
      const protocol = assembly.sections.find(section => section.name === 'ai-novel-writer-v2:proposal-protocol')?.text

      expect(protocol).toContain('人工修改提交不会单独改变阶段命令：章节初稿阶段的本地待审核初稿尚未应用，作者在此基础上提交替换全文时仍使用 artifact/draft；不得使用 parentArtifactId。')
      expect(protocol).toContain('只有作者明确选择已应用的章节正文版本并提交该版本的人工全文时，才使用 artifact/revision；parentArtifactId 必须逐字复制该已应用版本的 artifactId。')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a fresh V2 state lossless through the DSH novel_read render boundary', async () => {
    const root = await makeTestWorkspace('v2-agent-read-json-boundary-')
    const store = await openNovelStore(root, WORKSPACE_ID)
    try {
      await store.initialize(initialization, signal)
    } finally {
      await store.dispose()
    }

    const result = await executeV2ReadThroughToolRuntime(root)

    expect(result).toMatchObject({ isError: false, value: { project: { title: '潮汐来信' } } })
    const success = result as { readonly value: unknown; readonly content: readonly { readonly type: string; readonly text?: string }[] }
    expect(success.value).not.toHaveProperty('migration')
    expect(isJsonValue(success.value)).toBe(true)
    expect(success.content).toEqual([{ type: 'text', text: JSON.stringify(success.value, null, 2) }])
    expect(JSON.parse(success.content[0]?.text ?? '')).toEqual(success.value)
  })

  it('keeps populated optional artifact fields through the DSH novel_read render boundary', async () => {
    const root = await makeTestWorkspace('v2-agent-read-optional-json-boundary-')
    const store = await openNovelStore(root, WORKSPACE_ID)
    const draftPayload = { changes: [{
      kind: 'artifact/draft', artifactId: 'draft-1', chapter: 1,
      content: '潮水退去后，灯塔仍亮着。', summary: '第一章初稿。',
    }] }
    const reviewPayload = { changes: [{
      kind: 'artifact/review', artifactId: 'review-1', chapter: 1, parentArtifactId: 'draft-1',
      report: '保留灯塔意象，并加强来信的悬念。', summary: '第一章审稿。',
    }] }
    try {
      await store.initialize(initialization, signal)
      const initialized = await store.read(signal)
      await store.applyChange({
        changeSetId: 'optional-artifact-chapter-1', operation: 'replace', aggregate: { kind: 'chapter', chapter: 1 },
        baseAggregateRevision: 0, baseGlobalRevision: initialized.globalRevision,
        nextValue: {
          chapter: 1, title: '第一封信', purpose: '建立异常。', plotBeats: [], characters: [],
          keyEvents: ['信件抵达'], suspense: '寄信人是谁？', status: 'drafting',
        },
        provenance: { origin: 'manual' },
      }, signal)
      const draft = await store.submitProposal({
        sessionId: 'optional-session', callId: 'optional-draft',
        argsHash: createHash('sha256').update(canonicalJson(draftPayload), 'utf8').digest('hex'), payload: draftPayload,
      }, signal)
      await store.applyProposal(draft.proposal.proposalId, signal)
      const review = await store.submitProposal({
        sessionId: 'optional-session', callId: 'optional-review',
        argsHash: createHash('sha256').update(canonicalJson(reviewPayload), 'utf8').digest('hex'), payload: reviewPayload,
      }, signal)
      await store.applyProposal(review.proposal.proposalId, signal)
    } finally {
      await store.dispose()
    }

    const result = await executeV2ReadThroughToolRuntime(root)

    expect(result).toMatchObject({
      isError: false,
      value: {
        artifacts: [
          { artifactId: 'draft-1', content: '潮水退去后，灯塔仍亮着。' },
          { artifactId: 'review-1', parentArtifactId: 'draft-1', report: '保留灯塔意象，并加强来信的悬念。' },
        ],
      },
    })
    const success = result as {
      readonly value: { readonly artifacts: readonly Record<string, unknown>[] }
      readonly content: readonly { readonly type: string; readonly text?: string }[]
    }
    expect(isJsonValue(success.value)).toBe(true)
    expect(success.value.artifacts[0]).not.toHaveProperty('parentArtifactId')
    expect(success.value.artifacts[1]).not.toHaveProperty('content')
    expect(JSON.parse(success.content[0]?.text ?? '')).toEqual(success.value)
  })

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
    expect(tools[1].parameters).toMatchObject({
      properties: {
        changes: {
          description: expect.stringContaining('direct JSON object'),
        },
      },
    })

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

  it('requires a direct tool arguments object for a complete characters proposal', async () => {
    const root = await makeTestWorkspace('v2-agent-characters-')
    const setup = await openNovelStore(root, WORKSPACE_ID)
    await setup.initialize(initialization, signal)
    const state = await setup.read(signal)
    await setup.dispose()
    const registry = { resolveByPath: async (path: string) => path === root ? { id: WORKSPACE_ID, path: root } : undefined }
    const [, propose] = createNovelV2ToolDefinitions({}, registry)
    const characterProposal = {
      changes: [{
        changeSetId: 'proposal-characters', aggregate: { kind: 'characters' },
        baseAggregateRevision: state.characters.revision, baseGlobalRevision: state.globalRevision,
        nextValue: {
          items: [{
            characterId: 'lin-xia', name: '林夏', role: '主角', summary: '追查未来信件的记者。',
            goal: '找回失踪的弟弟。', currentState: '刚收到未来来信。', notes: '随身携带潮汐记录本。',
          }],
          relationships: [],
        },
      }],
    }

    await expect(propose.execute(characterProposal, execution(characterProposal, root, 'characters-call')))
      .resolves.toMatchObject({ proposal: { status: 'pending', items: [{ change: { aggregate: { kind: 'characters' } } }] } })
    const stringified = JSON.stringify(characterProposal)
    await expect(propose.execute(stringified as never, execution(stringified, root, 'characters-string-call')))
      .rejects.toMatchObject({ code: 'INVALID_ARGS' })
    const nested = { arguments: characterProposal }
    await expect(propose.execute(nested, execution(nested, root, 'characters-nested-call')))
      .rejects.toMatchObject({ code: 'INVALID_ARGS' })
  })

  it('makes the complete chapter-blueprint replacement shape unambiguous to the V2 model', () => {
    const registry = { resolveByPath: async () => ({ id: WORKSPACE_ID, path: '/workspace' }) }
    const [, propose] = createNovelV2ToolDefinitions({}, registry)
    const parameters = propose.parameters as {
      readonly properties: {
        readonly changes: { readonly description: string }
      }
    }
    const description = parameters.properties.changes.description

    expect(description).toContain('章节蓝图 aggregate.kind "chapter" 的 nextValue 必须且只能包含 chapter、title、purpose、plotBeats、characters、keyEvents、suspense、status')
    expect(description).toContain('chapter 为正整数，且必须等于 aggregate.chapter 与作者请求的章节')
    expect(description).toContain('title 和 purpose 为非空字符串')
    expect(description).toContain('plotBeats、characters、keyEvents 都是字符串数组，characters 中的字符串必须唯一')
    expect(description).toContain('suspense 为字符串；status 只能是 "planned"、"drafting"、"reviewing"、"revising" 或 "finalized"')
    expect(description).toContain('不得遗漏字段、加入 revision 或其他字段，也不得用字符串代替任一列表')
    expect(description).not.toContain('可省略')
    expect(description).not.toContain('可用字符串代替')
  })

  it('exposes an opaque regeneration ticket only to a later proposal call, which consumes it into one child bundle', async () => {
    const root = await makeTestWorkspace('v2-agent-regeneration-')
    const setup = await openNovelStore(root, WORKSPACE_ID)
    await setup.initialize(initialization, signal)
    const state = await setup.read(signal)
    const { revision: _architectureRevision, ...architecture } = state.architecture
    const sourcePayload = {
      changes: [{
        changeSetId: 'agent-regeneration-source', aggregate: { kind: 'architecture' },
        baseAggregateRevision: state.architecture.revision, baseGlobalRevision: state.globalRevision,
        nextValue: { ...architecture, premise: '等待重新生成的建议' },
      }],
    }
    const source = await setup.submitProposal({
      sessionId: 'source-session', callId: 'source-call',
      argsHash: createHash('sha256').update(canonicalJson(sourcePayload), 'utf8').digest('hex'), payload: sourcePayload,
    }, signal)
    const regeneration = await setup.requestProposalRegeneration(source.proposal.proposalId, source.proposal.items[0]!.itemId, signal)
    await setup.dispose()
    const command = createAiNovelCommandRpcHandler({
      get: () => ({ path: root }),
    }, () => {})
    const proposalList = await command('proposal/list', { workspaceId: WORKSPACE_ID }, signal)
    expect(proposalList).toMatchObject({ ok: true, value: { proposals: [{ proposalId: source.proposal.proposalId }] } })
    if (!proposalList.ok) throw new Error('proposal/list did not return a successful result')
    const proposalListValue = proposalList.value as NovelProposalListResult
    const ticketFromProposalList = proposalListValue.proposals
      .find(proposal => proposal.proposalId === source.proposal.proposalId)
      ?.items[0]?.regenerationTicket
    expect(ticketFromProposalList).toBe(regeneration.regenerationTicket)
    if (ticketFromProposalList === undefined) throw new Error('proposal/list did not expose the persisted regeneration ticket')
    const registry = { resolveByPath: async (path: string) => path === root ? { id: WORKSPACE_ID, path: root } : undefined }
    const tools = createNovelV2ToolDefinitions({}, registry)
    const propose = tools[1]
    expect(propose.parameters).toMatchObject({ properties: { regenerationTicket: { type: 'string' } } })

    const args = {
      regenerationTicket: ticketFromProposalList,
      changes: [{
        changeSetId: 'agent-regeneration-child', aggregate: { kind: 'architecture' },
        baseAggregateRevision: state.architecture.revision, baseGlobalRevision: state.globalRevision,
        nextValue: { ...architecture, premise: '由后续 agent 提交的新建议' },
      }],
    }
    const child = await propose.execute(args, execution(args, root, 'regeneration-call')) as NovelProposalReceipt
    expect(child).toMatchObject({
      proposal: {
        parentProposalId: source.proposal.proposalId,
        parentItemId: source.proposal.items[0]?.itemId,
        items: [{ itemOrder: 0, change: { changeSetId: 'agent-regeneration-child' } }],
      },
    })
    expect(JSON.stringify(child)).not.toContain(root)
    await expect(propose.execute({
      ...args,
      changes: [{ ...args.changes[0]!, changeSetId: 'agent-regeneration-ticket-reuse' }],
    }, execution({
      ...args,
      changes: [{ ...args.changes[0]!, changeSetId: 'agent-regeneration-ticket-reuse' }],
    }, root, 'regeneration-reuse-call'))).rejects.toMatchObject({ code: 'REGENERATION_TICKET_INVALID' })
    const verify = await openNovelStore(root, WORKSPACE_ID)
    try {
      expect((await verify.listProposals(signal)).find(proposal => proposal.proposalId === source.proposal.proposalId)).toMatchObject({
        status: 'superseded',
        items: [{ status: 'superseded', supersededByProposalId: child.proposal.proposalId }],
      })
    } finally {
      await verify.dispose()
    }
  })

  it('keeps artifact version commands non-authoritative and exposes bounded chapter-context through novel_read', async () => {
    const root = await makeTestWorkspace('v2-agent-artifact-')
    const setup = await openNovelStore(root, WORKSPACE_ID)
    await setup.initialize(initialization, signal)
    await setup.dispose()
    const registry = { resolveByPath: async (path: string) => path === root ? { id: WORKSPACE_ID, path: root } : undefined }
    const [read, propose] = createNovelV2ToolDefinitions({}, registry)
    expect(JSON.stringify(read.parameters)).toContain('chapter-context')

    const artifactArgs = { changes: [{
      kind: 'artifact/draft', artifactId: 'agent-draft-1', chapter: 1,
      content: '模型仅建议的第一章草稿。', summary: '提交第一章初稿建议。',
    }] }
    await expect(propose.execute(artifactArgs, execution(artifactArgs, root, 'artifact-call')))
      .resolves.toMatchObject({ proposal: { status: 'pending', items: [{ change: { kind: 'artifact/draft' } }] } })
    await expect(read.execute({ kind: 'chapter-context', chapter: 2 }, execution({ kind: 'chapter-context', chapter: 2 }, root)))
      .resolves.toEqual({ chapter: 2 })

    const verify = await openNovelStore(root, WORKSPACE_ID)
    try {
      const state = await verify.read(signal)
      expect(state.artifacts).toEqual([])
      expect(state.chapterFinals).toEqual([])
      expect(state.proposals).toHaveLength(1)
    } finally {
      await verify.dispose()
    }
  })
})
