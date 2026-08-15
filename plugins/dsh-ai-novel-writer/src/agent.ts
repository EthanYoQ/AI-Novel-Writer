/** Agent-scoped novel tools and their native approval policy. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  canonicalNovelAssetText, canonicalNovelInitialization, novelAssetSource, openNovelProject,
} from './novel-project.ts'
import type { NovelProjectOptions } from './novel-project.ts'
import type { AssetRef, NovelApplyRequest, NovelReadRequest } from './types.ts'

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

const assetRef = {
  oneOf: [
    { type: 'object', properties: { kind: { type: 'string', const: 'project', required: true } }, additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'characters', required: true } }, additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'story-blueprint', required: true } }, additionalProperties: false },
    {
      type: 'object', properties: {
        kind: { type: 'string', const: 'chapter-blueprint', required: true },
        chapter: { type: 'integer', required: true },
      }, additionalProperties: false,
    },
    {
      type: 'object', properties: {
        kind: { type: 'string', const: 'chapter-draft', required: true },
        chapter: { type: 'integer', required: true },
      }, additionalProperties: false,
    },
  ],
} as const

const readRequest = {
  oneOf: [
    {
      type: 'object',
      properties: { kind: { type: 'string', const: 'asset', required: true }, target: { ...assetRef, required: true } },
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { type: 'string', const: 'working-set', required: true }, chapter: { type: 'integer' } },
      additionalProperties: false,
    },
    {
      type: 'object', properties: {
        kind: { type: 'string', const: 'query', required: true },
        text: { type: 'string', required: true }, limit: { type: 'integer' },
      }, additionalProperties: false,
    },
  ],
} as const

const applyRequest = {
  oneOf: [
    {
      type: 'object', properties: {
        kind: { type: 'string', const: 'initialize', required: true },
        projectId: { type: 'string', required: true },
        title: { type: 'string', required: true }, language: { type: 'string', required: true },
        genre: { type: 'string', required: true }, plannedChapters: { type: 'integer', required: true },
        targetWordsPerChapter: { type: 'integer', required: true },
        creativeStrategy: {
          type: 'string', enum: ['auto', 'fluent-drafting', 'consistency-first', 'deep-planning'], required: true,
        },
        createdAt: { type: 'string', required: true }, updatedAt: { type: 'string', required: true },
      }, additionalProperties: false,
    },
    {
      type: 'object', properties: {
        kind: { type: 'string', const: 'replace', required: true }, target: { ...assetRef, required: true },
        baseRevision: { type: 'string', required: true }, baseText: { type: 'string', required: true },
        replacement: { type: 'string', required: true }, summary: { type: 'string', required: true },
      }, additionalProperties: false,
    },
  ],
} as const

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
    description: 'Read a bounded, revisioned projection of the current Harness novel project.',
    parameters: { request: { ...readRequest, required: true } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const value = await openNovelProject(workspaceRoot(exec.agent), options)
        .read(args.request as NovelReadRequest, exec.signal)
      return value as unknown as JsonValue
    },
    presentCall: args => ({
      card: 'generic', title: args.request.kind === 'query' ? '查询小说上下文' : '读取小说上下文',
      kind: args.request.kind === 'query' ? 'search' : 'read', rawInput: args.request,
    }),
  })
  const applyDefinition = defineTool({
    name: 'novel_apply_change',
    description: 'Propose one revision-checked novel asset change. The user must approve it before execution.',
    parameters: { request: { ...applyRequest, required: true } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const value = await openNovelProject(workspaceRoot(exec.agent), options)
        .apply(args.request as NovelApplyRequest, exec.signal)
      return value as unknown as JsonValue
    },
    presentCall: args => presentNovelChange(args.request as NovelApplyRequest),
    presentResult: (args, result) => result.isError
      ? { card: 'generic', content: result.content }
      : presentNovelChange(args.request as NovelApplyRequest),
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
  ctx.on('tools/pre-execute', (exec, next) => novelApprovalGate(exec, next))
}
