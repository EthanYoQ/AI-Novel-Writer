/** Agent-scoped novel tools and their native approval policy. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  canonicalNovelAssetText, canonicalNovelInitialization, novelAssetSource, openNovelProject,
} from './novel-project.ts'
import type { NovelProjectOptions } from './novel-project.ts'
import type {
  AssetRef, CreativeStrategy, NovelApplyRequest, NovelProjectId, NovelReadRequest, Revision,
} from './types.ts'

const DEFAULT_ASSET_BYTES = 512 * 1024
const DEFAULT_WORKING_SET_BYTES = 512 * 1024
const DEFAULT_QUERY_MATCHES = 20

/** Deployment bounds for the model-facing novel tools. */
export interface Config {
  readonly assetBytes?: number
  readonly workingSetBytes?: number
  readonly queryMatches?: number
}

/** Fail-loud validation and defaults for deployment-varying tool bounds. */
export const Config: z<Config> = z.object({
  assetBytes: z.number().step(1).min(1).default(DEFAULT_ASSET_BYTES),
  workingSetBytes: z.number().step(1).min(1).default(DEFAULT_WORKING_SET_BYTES),
  queryMatches: z.number().step(1).min(1).max(20).default(DEFAULT_QUERY_MATCHES),
})

const TARGET_KINDS = ['project', 'characters', 'story-blueprint', 'chapter-blueprint', 'chapter-draft'] as const
const CREATIVE_STRATEGIES = ['auto', 'fluent-drafting', 'consistency-first', 'deep-planning'] as const

const readParameters = {
  kind: { type: 'string', enum: ['asset', 'working-set', 'query'], required: true },
  targetKind: { type: 'string', enum: TARGET_KINDS },
  chapter: { type: 'integer' },
  text: { type: 'string' },
  limit: { type: 'integer' },
} as const

const applyParameters = {
  kind: { type: 'string', enum: ['initialize', 'replace'], required: true },
  targetKind: { type: 'string', enum: TARGET_KINDS },
  chapter: { type: 'integer' },
  projectId: { type: 'string' },
  title: { type: 'string' },
  language: { type: 'string' },
  genre: { type: 'string' },
  plannedChapters: { type: 'integer' },
  targetWordsPerChapter: { type: 'integer' },
  creativeStrategy: { type: 'string', enum: CREATIVE_STRATEGIES },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
  baseRevision: { type: 'string' },
  baseText: { type: 'string' },
  replacement: { type: 'string' },
  summary: { type: 'string' },
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
      'kind', 'targetKind', 'chapter', 'baseRevision', 'baseText', 'replacement', 'summary',
    ])
    return {
      kind: 'replace', target: targetFrom(args),
      baseRevision: requiredString(args, 'baseRevision') as Revision,
      baseText: requiredString(args, 'baseText'),
      replacement: requiredString(args, 'replacement'),
      summary: requiredString(args, 'summary'),
    }
  }
  return invalid('property "kind" must be "initialize" or "replace"')
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

/**
 * Render one proposed mutation as a deterministic Harness diff card.
 *
 * @param request Initialization or one-asset replacement proposed by the model.
 * @returns A presentation containing the affected project-relative location and before/after text.
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
      oldText: request.baseRevision === 'absent' ? null : normalizeLineEndings(request.baseText),
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
    description: 'Propose one revision-checked novel asset change with shallow arguments. Initialize before any replacement. Native user approval is required before execution.',
    parameters: applyParameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
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

/** Stable Cordis plugin name. */
export const name = 'dsh-ai-novel-writer-agent'

/** Required host service for registering scoped tools and policy. */
export const inject = ['tools']

/**
 * Register the two domain tools and their mandatory one-shot approval policy.
 *
 * @param ctx Agent preset scope that owns registrations and lifecycle cleanup.
 * @param config Deployment-specific read, write, working-set, and query limits.
 * @returns Nothing.
 */
export function apply(ctx: Context, config: Config = {}): void {
  for (const definition of createNovelToolDefinitions(config)) ctx.tools.register(definition)
  if (scopeOf(ctx) !== undefined) {
    if (ctx.agent === undefined) {
      ctx.on('agent/created', ({ agent }) => {
        ctx.effect(
          () => agent.ctx.tools.restrict({ allow: ['novel_read', 'novel_apply_change'] }),
          'dsh-ai-novel-writer.agent-tool-restriction',
        )
      })
    } else {
      ctx.tools.restrict({ allow: [] })
    }
  }
  ctx.on('tools/pre-execute', (exec, next) => novelApprovalGate(exec, next))
}
