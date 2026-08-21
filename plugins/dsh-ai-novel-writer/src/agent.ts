/** Agent-scoped novel tools and their native approval policy. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  canonicalNovelAssetText, canonicalNovelInitialization, novelAssetSource, openNovelProject,
} from './novel-project.ts'
import type { NovelProjectOptions } from './novel-project.ts'
import {
  novelProposalArgsHash,
  openNovelStore,
  validateNovelProposalPayload,
  type NovelStore,
} from './novel-store.ts'
import { projectNovelStateRead } from './command-rpc.ts'
import type {
  AssetRef, CreativeStrategy, NovelApplyRequest, NovelProjectId, NovelReadRequest, Revision,
} from './types.ts'

const DEFAULT_ASSET_BYTES = 512 * 1024
const DEFAULT_WORKING_SET_BYTES = 512 * 1024
const DEFAULT_QUERY_MATCHES = 20
const NOVEL_PRESET_ID = 'ai-novel-writer'
const NOVEL_TOOL_NAMES: ReadonlySet<string> = new Set(['novel_read', 'novel_apply_change'])
const NOVEL_V2_PRESET_ID = 'ai-novel-writer-v2'
const NOVEL_V2_TOOL_NAMES: ReadonlySet<string> = new Set(['novel_read', 'novel_propose_change'])

/** Deployment bounds for the model-facing novel tools. */
export interface Config {
  readonly assetBytes?: number
  readonly workingSetBytes?: number
  readonly queryMatches?: number
  readonly maxProposalBytes?: number
  readonly maxPendingProposals?: number
}

/** Fail-loud validation and defaults for deployment-varying tool bounds. */
export const Config: z<Config> = z.object({
  assetBytes: z.number().step(1).min(1).default(DEFAULT_ASSET_BYTES),
  workingSetBytes: z.number().step(1).min(1).default(DEFAULT_WORKING_SET_BYTES),
  queryMatches: z.number().step(1).min(1).max(20).default(DEFAULT_QUERY_MATCHES),
  maxProposalBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  maxPendingProposals: z.number().step(1).min(1).default(20),
})

/** Deployment bounds for the V2 read-and-proposal agent surface. */
export interface NovelV2Config {
  readonly maxProposalBytes?: number
  readonly maxPendingProposals?: number
}

/** Fail-loud validation and defaults for V2 proposal inbox bounds. */
export const NovelV2Config: z<NovelV2Config> = z.object({
  maxProposalBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  maxPendingProposals: z.number().step(1).min(1).default(20),
})

/** Read-only Workspace resolution face used by V2 novel tools. */
export interface NovelV2WorkspaceRegistry {
  resolveByPath(path: string): Promise<Pick<Workspace, 'id' | 'path'> | undefined>
}

const TARGET_KINDS = ['project', 'characters', 'story-blueprint', 'chapter-blueprint', 'chapter-draft'] as const
const CREATIVE_STRATEGIES = ['auto', 'fluent-drafting', 'consistency-first', 'deep-planning'] as const

/** Keep inherited host plugins out of every agent composed from the dedicated novel Preset. */
function installDedicatedPresetSurface(
  ctx: Context,
  presetId: string,
  toolNames: ReadonlySet<string>,
  displayName: string,
): void {
  ctx.inject(['agentPresets'], (presetCtx) => {
    const installed = new Map<Agent, () => void>()
    const owns = (agent: Agent | undefined): agent is Agent => agent !== undefined
      && presetCtx.agentPresets.composedPreset(agent.ctx) === presetId
    const install = (agent: Agent): void => {
      if (installed.has(agent)) return
      const disposeRestriction = agent.ctx.tools.restrict({ allow: [...toolNames] })
      let disposeOwner = (): void => undefined
      let agentDisposing = false
      const disposeAgentCleanup = agent.ctx.effect(() => () => {
        installed.delete(agent)
        agentDisposing = true
        try {
          disposeOwner()
        } finally {
          agentDisposing = false
        }
      }, 'dsh-ai-novel-writer.agent-surface-agent-lifecycle')
      disposeOwner = presetCtx.effect(() => () => {
        if (!agentDisposing) disposeAgentCleanup()
        disposeRestriction()
        installed.delete(agent)
      }, 'dsh-ai-novel-writer.agent-surface-isolation')
      installed.set(agent, disposeOwner)
    }
    presetCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      if (!owns(context.agent)) return result
      const tools = result.tools.filter(tool => toolNames.has(tool.name))
      if (tools.length !== toolNames.size
        || tools.some((tool, index) => tools.findIndex(candidate => candidate.name === tool.name) !== index)) {
        throw new Error(`${displayName} requires exactly ${[...toolNames].sort().join(' and ')} in every model request`)
      }
      return { ...result, tools }
    }, { prepend: true, global: true })
    presetCtx.on('tools/pre-execute', (exec, next) => {
      if (!owns(exec.agent) || toolNames.has(exec.name)) return next()
      return Promise.resolve({
        kind: 'deny',
        reason: `${displayName} is dedicated to ${[...toolNames].sort().join(' and ')}`,
      })
    }, { prepend: true, global: true })
    presetCtx.on('agent/created', ({ agent }) => {
      if (owns(agent)) install(agent)
    }, { global: true })
    presetCtx.on('agent-preset/selected', (sessionId) => {
      const agent = presetCtx.agents.get(sessionId)
      if (owns(agent)) install(agent)
    }, { global: true })
  })
}

const readParameters = {
  kind: { type: 'string', enum: ['asset', 'working-set', 'query'], required: true },
  targetKind: { type: 'string', enum: TARGET_KINDS },
  chapter: { type: 'integer' },
  text: { type: 'string' },
  limit: { type: 'integer' },
} as const

const applyParameters = {
  kind: {
    type: 'string', enum: ['initialize', 'replace'], required: true,
    description: 'Use initialize only after novel_read reports NOT_INITIALIZED. Otherwise use replace.',
  },
  targetKind: {
    type: 'string', enum: TARGET_KINDS,
    description: 'Required only when kind is replace. Forbidden when kind is initialize.',
  },
  chapter: {
    type: 'integer',
    description: 'Required only for a replace whose targetKind is chapter-blueprint or chapter-draft.',
  },
  projectId: { type: 'string', description: 'Required only when kind is initialize. Forbidden when kind is replace.' },
  title: { type: 'string', description: 'Required only when kind is initialize. Forbidden when kind is replace.' },
  language: { type: 'string', description: 'Required only when kind is initialize. Forbidden when kind is replace.' },
  genre: { type: 'string', description: 'Required only when kind is initialize. Forbidden when kind is replace.' },
  plannedChapters: { type: 'integer', description: 'Required only when kind is initialize. Forbidden when kind is replace.' },
  targetWordsPerChapter: { type: 'integer', description: 'Required only when kind is initialize. Forbidden when kind is replace.' },
  creativeStrategy: {
    type: 'string', enum: CREATIVE_STRATEGIES,
    description: 'Required only when kind is initialize. Forbidden when kind is replace.',
  },
  createdAt: { type: 'string', description: 'Required only when kind is initialize. Use canonical UTC YYYY-MM-DDTHH:mm:ss.sssZ, including milliseconds. Forbidden when kind is replace.' },
  updatedAt: { type: 'string', description: 'Required only when kind is initialize. Use the exact same canonical UTC YYYY-MM-DDTHH:mm:ss.sssZ value as createdAt. Forbidden when kind is replace.' },
  baseRevision: {
    type: 'string',
    description: 'Required only when kind is replace. Copy the revision from novel_read; use absent for a missing non-manifest asset.',
  },
  replacement: {
    type: 'string',
    description: 'Required only when kind is replace. The complete replacement text for exactly one asset.',
  },
  summary: { type: 'string', description: 'Required only when kind is replace. A concise description for the approval diff.' },
} as const

const v2ReadParameters = {
  kind: { type: 'string', enum: ['state'], required: true },
} as const

const v2ProposeParameters = {
  changes: {
    type: 'array',
    required: true,
    description: 'One or more complete single-aggregate replacement commands. Each item uses exactly changeSetId, aggregate, baseAggregateRevision, baseGlobalRevision, and nextValue.',
  },
} as const

function invalid(message: string): never {
  throw new ToolArgsError([message])
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  return typeof value === 'string' ? value : invalid(`missing required property "${name}"`)
}

function requiredInteger(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  return Number.isInteger(value) ? value as number : invalid(`missing required property "${name}"`)
}

function rejectUnexpected(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(args).filter(key => !allowed.includes(key))
  if (unexpected.length > 0) invalid(`unexpected propert${unexpected.length === 1 ? 'y' : 'ies'} ${unexpected.map(key => `"${key}"`).join(', ')}`)
}

function targetFrom(args: Record<string, unknown>): AssetRef {
  const targetKind = requiredString(args, 'targetKind')
  if (targetKind === 'chapter-blueprint' || targetKind === 'chapter-draft') {
    return { kind: targetKind, chapter: requiredInteger(args, 'chapter') }
  }
  if (targetKind === 'project' || targetKind === 'characters' || targetKind === 'story-blueprint') {
    if (args.chapter !== undefined) invalid('property "chapter" is only valid for chapter assets')
    return { kind: targetKind }
  }
  return invalid('property "targetKind" must name a supported novel asset')
}

function parseReadRequest(args: Record<string, unknown>): NovelReadRequest {
  if (args.kind === 'asset') {
    rejectUnexpected(args, ['kind', 'targetKind', 'chapter'])
    return { kind: 'asset', target: targetFrom(args) }
  }
  if (args.kind === 'working-set') {
    rejectUnexpected(args, ['kind', 'chapter'])
    return args.chapter === undefined
      ? { kind: 'working-set' }
      : { kind: 'working-set', chapter: requiredInteger(args, 'chapter') }
  }
  if (args.kind === 'query') {
    rejectUnexpected(args, ['kind', 'text', 'limit'])
    const text = requiredString(args, 'text')
    return args.limit === undefined
      ? { kind: 'query', text }
      : { kind: 'query', text, limit: requiredInteger(args, 'limit') }
  }
  return invalid('property "kind" must be "asset", "working-set", or "query"')
}

function parseApplyRequest(args: Record<string, unknown>): NovelApplyRequest {
  if (args.kind === 'initialize') {
    rejectUnexpected(args, [
      'kind', 'projectId', 'title', 'language', 'genre', 'plannedChapters', 'targetWordsPerChapter',
      'creativeStrategy', 'createdAt', 'updatedAt',
    ])
    return {
      kind: 'initialize',
      projectId: requiredString(args, 'projectId') as NovelProjectId,
      title: requiredString(args, 'title'),
      language: requiredString(args, 'language'),
      genre: requiredString(args, 'genre'),
      plannedChapters: requiredInteger(args, 'plannedChapters'),
      targetWordsPerChapter: requiredInteger(args, 'targetWordsPerChapter'),
      creativeStrategy: requiredString(args, 'creativeStrategy') as CreativeStrategy,
      createdAt: requiredString(args, 'createdAt'),
      updatedAt: requiredString(args, 'updatedAt'),
    }
  }
  if (args.kind === 'replace') {
    rejectUnexpected(args, [
      'kind', 'targetKind', 'chapter', 'baseRevision', 'replacement', 'summary',
    ])
    return {
      kind: 'replace', target: targetFrom(args),
      baseRevision: requiredString(args, 'baseRevision') as Revision,
      replacement: requiredString(args, 'replacement'),
      summary: requiredString(args, 'summary'),
    }
  }
  return invalid('property "kind" must be "initialize" or "replace"')
}

function parseProposalArgs(args: Record<string, unknown>): { readonly changes: readonly unknown[] } {
  rejectUnexpected(args, ['changes'])
  try {
    validateNovelProposalPayload(args)
  } catch (error) {
    if (error instanceof Error) throw new ToolArgsError([error.message])
    throw error
  }
  return args as { readonly changes: readonly unknown[] }
}

function resolvedOptions(config: Config): NovelProjectOptions {
  return {
    assetBytes: config.assetBytes ?? DEFAULT_ASSET_BYTES,
    workingSetBytes: config.workingSetBytes ?? DEFAULT_WORKING_SET_BYTES,
    queryMatches: config.queryMatches ?? DEFAULT_QUERY_MATCHES,
  }
}

function workspaceRoot(agent: Agent | undefined): string {
  const cwd = agent?.session.header.cwd
  if (cwd === undefined) throw new Error('AI novel tools require a session with a workspace cwd')
  return cwd
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function displayReplacement(target: AssetRef, text: string): string {
  const normalized = normalizeLineEndings(text)
  try {
    return canonicalNovelAssetText(target, normalized)
  } catch {
    return normalized
  }
}

function initializePreview(request: Extract<NovelApplyRequest, { kind: 'initialize' }>): string {
  return canonicalNovelInitialization(request)
}

function commitReceiptMeta(value: JsonValue): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const newRevision = value.newRevision
  return typeof newRevision === 'string' && /^[0-9a-f]{64}$/.test(newRevision)
    ? { newRevision }
    : {}
}

/**
 * Render one proposed mutation as a deterministic Harness diff card.
 *
 * @param request Initialization or one-asset replacement proposed by the model.
 * @returns A presentation containing the affected project-relative location and complete final text.
 */
export function presentNovelChange(request: NovelApplyRequest) {
  if (request.kind === 'initialize') {
    return {
      card: 'diff' as const, title: `创建小说项目：${request.title}`,
      diffs: [{ path: '.ai-novel/project.json', oldText: null, newText: initializePreview(request) }],
      locations: [{ path: '.ai-novel/project.json' }],
    }
  }
  const path = novelAssetSource(request.target)
  return {
    card: 'diff' as const, title: request.summary,
    diffs: [{
      path,
      oldText: null,
      newText: displayReplacement(request.target, request.replacement),
    }],
    locations: [{ path }],
  }
}

/**
 * Require native approval for the mutation tool and delegate every other tool decision.
 *
 * @param exec Tool execution identity.
 * @param next Remaining scoped approval listeners.
 * @returns An approval request for `novel_apply_change`, otherwise the delegated decision.
 */
export function novelApprovalGate(
  exec: Pick<{ name: string }, 'name'>,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  if (exec.name !== 'novel_apply_change') return next()
  return Promise.resolve({ kind: 'ask', reason: '批准后仅修改这一个小说资产。' })
}

/**
 * Construct the two model-visible novel tool definitions.
 *
 * @param config Deployment-specific read, write, working-set, and query limits.
 * @returns The read tool followed by the approval-gated single-asset mutation tool.
 */
export function createNovelToolDefinitions(config: Config = {}): readonly [ToolDefinition, ToolDefinition] {
  const options = resolvedOptions(config)
  const read = defineTool({
    name: 'novel_read',
    description: 'Read a bounded, revisioned projection of the current Harness novel project. Pass kind and its branch fields directly; do not nest or stringify them.',
    parameters: readParameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const request = parseReadRequest(args)
      const value = await openNovelProject(workspaceRoot(exec.agent), options)
        .read(request, exec.signal)
      return value as unknown as JsonValue
    },
    presentCall: args => {
      const request = parseReadRequest(args)
      return {
        card: 'generic', title: request.kind === 'query' ? '查询小说上下文' : '读取小说上下文',
        kind: request.kind === 'query' ? 'search' : 'read', rawInput: request,
      }
    },
  })
  const applyDefinition = defineTool({
    name: 'novel_apply_change',
    description: 'Propose one revision-checked novel asset change with shallow arguments. Use initialize only when novel_read reports NOT_INITIALIZED. For every existing project, including project-setting changes, use replace. Missing non-manifest assets also use replace with baseRevision absent. Never mix branch fields: initialize fields: kind, projectId, title, language, genre, plannedChapters, targetWordsPerChapter, creativeStrategy, createdAt, updatedAt; replace fields: kind, targetKind, chapter only for chapter assets, baseRevision, replacement, summary. Native user approval is required before execution.',
    parameters: applyParameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => commitReceiptMeta(value),
    },
    async execute(args, exec) {
      const request = parseApplyRequest(args)
      const value = await openNovelProject(workspaceRoot(exec.agent), options)
        .apply(request, exec.signal)
      return value as unknown as JsonValue
    },
    presentCall: args => presentNovelChange(parseApplyRequest(args)),
    presentResult: (args, result) => result.isError
      ? { card: 'generic', content: result.content }
      : presentNovelChange(parseApplyRequest(args)),
  })
  return [read, applyDefinition]
}

/**
 * Construct the model-visible V2 novel tools.
 *
 * `novel_read` exposes only the authoritative V2 state projection, while
 * `novel_propose_change` persists a typed non-authoritative bundle. Proposal
 * identity is derived from `ToolRunContext`; model arguments cannot supply the
 * session, call, or args hash.
 *
 * @param config Deployment-specific proposal inbox bounds.
 * @param workspaces Host Workspace registry used to resolve the session cwd.
 * @returns The read tool followed by the persistent proposal tool.
 */
export function createNovelV2ToolDefinitions(
  config: NovelV2Config,
  workspaces: NovelV2WorkspaceRegistry,
): readonly [ToolDefinition, ToolDefinition] {
  const resolved = NovelV2Config(config)
  const options = {
    create: false as const,
    maxProposalBytes: resolved.maxProposalBytes,
    maxPendingProposals: resolved.maxPendingProposals,
  }
  const resolveWorkspace = async (exec: { readonly agent?: Agent }): Promise<Pick<Workspace, 'id' | 'path'>> => {
    const workspace = await workspaces.resolveByPath(workspaceRoot(exec.agent))
    if (workspace === undefined) throw new ToolArgsError(['AI novel V2 tools require a registered Workspace'])
    return workspace
  }
  const read = defineTool({
    name: 'novel_read',
    description: 'Read the current authoritative V2 novel project state. The result omits local workspace paths.',
    parameters: v2ReadParameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      rejectUnexpected(args as Record<string, unknown>, ['kind'])
      if ((args as { kind?: unknown }).kind !== 'state') {
        throw new ToolArgsError(['novel_read property "kind" must be "state"'])
      }
      const workspace = await resolveWorkspace(exec)
      const store = await openNovelStore(workspace.path, workspace.id, options)
      try {
        return projectNovelStateRead(await store.read(exec.signal)) as unknown as JsonValue
      } finally {
        await store.dispose()
      }
    },
    presentCall: () => ({ card: 'generic', title: '读取小说项目', kind: 'read', rawInput: { kind: 'state' } }),
  })
  const propose = defineTool({
    name: 'novel_propose_change',
    description: 'Persist one non-authoritative proposal bundle for user review. Changes may contain multiple complete single-aggregate replacements, but this tool never writes authoritative project state. Proposal session, call, and canonical args identity are supplied by the Host.',
    parameters: v2ProposeParameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      parseProposalArgs(args as Record<string, unknown>)
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) throw new ToolArgsError(['AI novel V2 tools require a session identity'])
      const workspace = await resolveWorkspace(exec)
      const store: NovelStore = await openNovelStore(workspace.path, workspace.id, options)
      try {
        return await store.submitProposal({
          sessionId: String(sessionId),
          callId: String(exec.callId),
          argsHash: novelProposalArgsHash(exec.arguments),
          payload: exec.arguments,
        }, exec.signal) as unknown as JsonValue
      } finally {
        await store.dispose()
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: '提交小说修改建议',
      kind: 'read',
      rawInput: parseProposalArgs(args as Record<string, unknown>),
    }),
  })
  return [read, propose]
}

/** Stable Cordis plugin name. */
export const name = 'dsh-ai-novel-writer-agent'

/** Required host services for agent lookup, scoped tools, prompt projection, and policy. */
export const inject = ['agents', 'systemPrompt', 'tools']

/**
 * Register the two domain tools and their mandatory one-shot approval policy.
 *
 * @param ctx Agent preset scope that owns registrations and lifecycle cleanup.
 * @param config Deployment-specific read, write, working-set, and query limits.
 * @returns Nothing.
 */
export function apply(ctx: Context, config: Config = {}): void {
  for (const definition of createNovelToolDefinitions(config)) ctx.tools.register(definition)
  installDedicatedPresetSurface(ctx, NOVEL_PRESET_ID, NOVEL_TOOL_NAMES, 'AI 小说作家')
  ctx.on('tools/pre-execute', (exec, next) => novelApprovalGate(exec, next))
}

/** Register V2's read-and-proposal surface after its dedicated entry injects the Workspace registry. */
export function applyV2(ctx: Context, config: NovelV2Config = {}): void {
  const workspaces = ctx.get('workspaceRegistry') as NovelV2WorkspaceRegistry | undefined
  if (workspaces === undefined) throw new Error('AI 小说作家 V2 requires the Workspace registry')
  for (const definition of createNovelV2ToolDefinitions(config, workspaces)) ctx.tools.register(definition)
  installDedicatedPresetSurface(ctx, NOVEL_V2_PRESET_ID, NOVEL_V2_TOOL_NAMES, 'AI 小说作家 V2')
}
