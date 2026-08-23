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

/**
 * The one active dedicated-preset mask for a live agent.
 *
 * The V1 and V2 entry points are separate bundles, so module-local state is
 * not shared when the Loader recomposes a blank session. A private registry
 * symbol on the live Agent is shared by both entries without becoming a Host
 * service or persisted state.
 */
const DEDICATED_SURFACE_INSTALLATION = Symbol.for('@ethanyoq/dsh-ai-novel-writer/dedicated-surface-installation')
type DedicatedSurfaceInstallation = { readonly presetId: string; readonly dispose: () => void }

function dedicatedSurfaceInstallationFor(agent: Agent): DedicatedSurfaceInstallation | undefined {
  return Reflect.get(agent, DEDICATED_SURFACE_INSTALLATION) as DedicatedSurfaceInstallation | undefined
}

function setDedicatedSurfaceInstallation(agent: Agent, installation: DedicatedSurfaceInstallation): void {
  Reflect.set(agent, DEDICATED_SURFACE_INSTALLATION, installation)
}

function clearDedicatedSurfaceInstallation(agent: Agent, dispose: () => void): void {
  if (dedicatedSurfaceInstallationFor(agent)?.dispose === dispose) {
    Reflect.deleteProperty(agent, DEDICATED_SURFACE_INSTALLATION)
  }
}
const V2_PROPOSAL_PROTOCOL_SECTION = 'ai-novel-writer-v2:proposal-protocol'
const V2_PROJECT_NEXT_VALUE_CONTRACT = '项目设置 aggregate.kind "project" 的 nextValue 必须且只能包含 title、language、genre、plannedChapters、targetWordsPerChapter、creativeStrategy、structureMode、narrativePov、globalGuidance、createdAt、updatedAt；不得包含 revision 或遗漏任何字段。createdAt 与 updatedAt 都必须从刚读取的 state 原样复制为 canonical ISO-8601 UTC 时间戳，即使本轮未修改时间也不可遗漏、改写或编造。'
const V2_CHAPTER_BLUEPRINT_NEXT_VALUE_CONTRACT = '章节蓝图 aggregate.kind "chapter" 的 nextValue 必须且只能包含 chapter、title、purpose、plotBeats、characters、keyEvents、suspense、status；chapter 为正整数，且必须等于 aggregate.chapter 与作者请求的章节；title 和 purpose 为非空字符串；plotBeats、characters、keyEvents 都是字符串数组，characters 中的字符串必须唯一；suspense 为字符串；status 只能是 "planned"、"drafting"、"reviewing"、"revising" 或 "finalized"；不得遗漏字段、加入 revision 或其他字段，也不得用字符串代替任一列表。'
const V2_CHAPTER_BLUEPRINT_CHARACTER_IDS_CONTRACT = '章节蓝图的 nextValue.characters 是角色 ID 列表：只能从刚读取的 state.characters.items[].characterId 逐字复制已存在的值。不得写 display name、角色姓名、别名或 role；例如 state 中 name 为“阿澈”、characterId 为“ache”时，characters 必须写 "ache"，不能写 "阿澈"。'
const V2_PROPOSAL_PROTOCOL = [
  'AI 小说作家 V2 使用宿主的原生函数调用：每个工具的完整输入就是直接传给工具的 JSON 对象；不得写标签式工具调用文本，也不得在顶层包一层 "arguments"。每次创作请求先调用 novel_read，novel_read 的完整输入必须严格为 {"kind":"state"}，不得附加字段。',
  '只有在已读取状态且确实需要上一章定稿连续性时，才可额外调用 novel_read，其完整输入必须严格为 {"kind":"chapter-context","chapter":N}；同样不得包一层 "arguments"。',
  '随后至多调用一次 novel_propose_change。novel_propose_change 的直接输入必须严格为 {"changes":[...]}。只有刚由 Host 返回 regenerationTicket 时，直接输入必须为 {"changes":[...],"regenerationTicket":"<opaque ticket>"}；不得将输入整体字符串化，也不得在输入内嵌套名为 arguments 的属性；不要加入 sessionId、callId、argsHash、operation 或 provenance。',
  '发出常规 novel_propose_change 前，先做 JSON 括号配对检查：直接输入文本必须以 {"changes":[ 开始，并按顺序以 ]} 结束；唯一 changes 命令的 } 后必须紧跟 ] 关闭数组，再跟 } 关闭直接输入。',
  '每次 novel_propose_change 的 changes 必须恰好包含一个命令；同一 Proposal 禁止提交两个或更多 changes，也不得包含当前阶段以外的聚合或正文版本命令。',
  '作者请求中的当前阶段决定唯一允许命令：项目设定优化 → aggregate.kind "project"；架构设计 → aggregate.kind "architecture"；角色设定 → aggregate.kind "characters"；全书大纲 → aggregate.kind "architecture" 且只更新完整架构中的 plotOutline；章节蓝图 → aggregate.kind "chapter" 且 chapter 必须等于作者请求的章节；章节初稿 → artifact/draft 且 chapter 必须等于作者请求的章节；章节修订 → artifact/revision 且 chapter 必须等于作者请求的章节；选择定稿 → chapter/select-final 且 chapter 必须等于作者请求的章节。绝不因其它阶段内容追加第二个 changes 项。',
  '聚合替换的每个 changes 项必须且只能包含 changeSetId、aggregate、baseAggregateRevision、baseGlobalRevision、nextValue。aggregate.kind 只能是 "project"、"architecture"、"characters"、"chapter" 或 "task"；chapter 必须额外带正整数 chapter，task 必须额外带 taskId。',
  'baseAggregateRevision 和 baseGlobalRevision 必须原样取自刚读取的状态；不得猜测、沿用旧值或编造。nextValue 必须是读取到的完整聚合值，且不得包含 revision；它不是补丁，也不能省略未修改字段。',
  V2_PROJECT_NEXT_VALUE_CONTRACT,
  '项目设置阶段可复制的单一 Proposal JSON：{"changes":[{"changeSetId":"project-example","aggregate":{"kind":"project"},"baseAggregateRevision":0,"baseGlobalRevision":0,"nextValue":{"title":"灯塔小队","language":"zh-CN","genre":"少儿冒险","plannedChapters":2,"targetWordsPerChapter":300,"creativeStrategy":"auto","structureMode":"three-act","narrativePov":"third-limited","globalGuidance":"温暖轻快，强调勇气、友谊与互助。","createdAt":"2026-08-22T00:00:00.000Z","updatedAt":"2026-08-22T00:00:00.000Z"}}]}',
  'characters 的 nextValue 必须且只能是 {"items":[...],"relationships":[...]}：每个 items 项必须且只能包含 characterId、name、role、summary、goal、currentState、notes；每个 relationships 项必须且只能包含 fromCharacterId、toCharacterId、relation、notes。items 覆盖完整角色集合且 characterId 唯一；relationships 只引用 items 中的 characterId；不要加入 revision、characters 包装或其他字段。',
  '人物阶段可复制的单一 Proposal JSON：{"changes":[{"changeSetId":"characters-example","aggregate":{"kind":"characters"},"baseAggregateRevision":0,"baseGlobalRevision":0,"nextValue":{"items":[{"characterId":"hero","name":"小澄","role":"主角","summary":"守护灯塔的孩子","goal":"让灯塔重新发光","currentState":"正在寻找修复线索","notes":""},{"characterId":"friend","name":"阿风","role":"伙伴","summary":"擅长修理的小伙伴","goal":"帮助小澄","currentState":"带着修理工具","notes":""}],"relationships":[{"fromCharacterId":"hero","toCharacterId":"friend","relation":"伙伴","notes":"互相支持"}]}}]}',
  '人物阶段只替换该示例中的值为刚读取的完整状态，不得改变 JSON 结构。relationships 只保留必要且不重复的关系：同一方向角色对最多一条，relation 简短，notes 只写必要补充。relationships 数组结束后依次闭合 nextValue、唯一 change、changes 和直接输入，即 ]}}]}。',
  V2_CHAPTER_BLUEPRINT_NEXT_VALUE_CONTRACT,
  V2_CHAPTER_BLUEPRINT_CHARACTER_IDS_CONTRACT,
  '章节蓝图阶段可复制的单一 Proposal JSON：{"changes":[{"changeSetId":"chapter-1-example","aggregate":{"kind":"chapter","chapter":1},"baseAggregateRevision":0,"baseGlobalRevision":0,"nextValue":{"chapter":1,"title":"灯塔熄灭","purpose":"让孩子们发现危机并决定行动","plotBeats":["阿澈发现灯塔没有亮起","伙伴们约定寻找修复线索"],"characters":["ache","xiaoman"],"keyEvents":["海爷爷说明灯塔需要修理","阿澈和小满出发寻找零件"],"suspense":"仓库门后传来陌生的响声。","status":"planned"}}]}',
  '正文版本命令只能使用以下精确字段，禁止添加或改名字段：artifact/draft: kind、artifactId、chapter、content、summary；artifact/review: kind、artifactId、chapter、parentArtifactId、report、summary；artifact/revision: kind、artifactId、chapter、parentArtifactId、content、summary；chapter/select-final: kind、chapter、artifactId、summary。',
  '章节初稿阶段可复制的单一 Proposal JSON：{"changes":[{"kind":"artifact/draft","artifactId":"draft-1-example","chapter":1,"content":"第一章正文示例。","summary":"第一章初稿。"}]}',
  'artifact/draft 的唯一 changes 项必须且只能包含 kind、artifactId、chapter、content、summary；绝不包含 changeSetId、aggregate、baseAggregateRevision、baseGlobalRevision 或 nextValue。',
  '人工修改提交不会单独改变阶段命令：章节初稿阶段的本地待审核初稿尚未应用，作者在此基础上提交替换全文时仍使用 artifact/draft；不得使用 parentArtifactId。',
  '只有作者明确选择已应用的章节正文版本并提交该版本的人工全文时，才使用 artifact/revision；parentArtifactId 必须逐字复制该已应用版本的 artifactId。artifact/revision 命令必须且只能含 kind、artifactId、chapter、parentArtifactId、content、summary；content 必须逐字保留用户手动全文，不得摘要、改写或截断。',
  '一次请求只提交一个 proposal。若 novel_read 或 novel_propose_change 失败，立即停止本次创作，不要猜测、探测或重试，也不要发起另一种写入调用；向用户说明无法完成。',
].join('\n\n')

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
      const prior = dedicatedSurfaceInstallationFor(agent)
      if (prior?.presetId === presetId) return
      // `tools.restrict()` intersects inherited names. A blank-session preset
      // switch must first remove its predecessor's mask or V2 loses
      // novel_propose_change to V1's allow-list.
      prior?.dispose()
      const disposeRestriction = agent.ctx.tools.restrict({ allow: [...toolNames] })
      let disposeOwner = (): void => undefined
      let agentDisposing = false
      const clearInstallation = (): void => {
        clearDedicatedSurfaceInstallation(agent, disposeOwner)
        installed.delete(agent)
      }
      const disposeAgentCleanup = agent.ctx.effect(() => () => {
        clearInstallation()
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
        clearInstallation()
      }, 'dsh-ai-novel-writer.agent-surface-isolation')
      installed.set(agent, disposeOwner)
      setDedicatedSurfaceInstallation(agent, { presetId, dispose: disposeOwner })
    }
    presetCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      // Preset selection can recompose a still-live blank agent without a new
      // `agent/created` delivery to this standing mount. Repair that lifecycle
      // edge before the request continues, then derive this request's schemas
      // from the now-current ToolRuntime view rather than its stale collection.
      if (owns(context.agent)) install(context.agent)
      const result = await next()
      if (!owns(context.agent)) return result
      const tools = context.agent.ctx.tools.schemas(context.agent)
        .filter(tool => toolNames.has(tool.name))
      if (tools.length !== toolNames.size
        || tools.some((tool, index) => tools.findIndex(candidate => candidate.name === tool.name) !== index)) {
        throw new Error(`${displayName} requires exactly ${[...toolNames].sort().join(' and ')} in every model request`)
      }
      return {
        ...result,
        sections: presetId === NOVEL_V2_PRESET_ID
          ? [...result.sections, { name: V2_PROPOSAL_PROTOCOL_SECTION, text: V2_PROPOSAL_PROTOCOL }]
          : result.sections,
        tools,
      }
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
  kind: { type: 'string', enum: ['state', 'chapter-context'], required: true },
  chapter: { type: 'integer', description: 'Required only when kind is chapter-context; returns only the selected final from the immediately preceding chapter.' },
} as const

const v2ProposeParameters = {
  changes: {
    type: 'array',
    required: true,
    description: `Exactly one complete typed command. The native function-call input must be the direct JSON object {"changes":[...]}; never JSON-encode the input, add a top-level "arguments" wrapper, or nest an "arguments" property. Aggregate replacements use changeSetId, aggregate, baseAggregateRevision, baseGlobalRevision, nextValue. A characters aggregate nextValue is exactly {items:[{characterId,name,role,summary,goal,currentState,notes}],relationships:[{fromCharacterId,toCharacterId,relation,notes}]}. ${V2_CHAPTER_BLUEPRINT_NEXT_VALUE_CONTRACT} A first draft uses exactly {"changes":[{"kind":"artifact/draft","artifactId":"draft-1-example","chapter":1,"content":"第一章正文示例。","summary":"第一章初稿。"}]}; never add changeSetId, aggregate, baseAggregateRevision, baseGlobalRevision, or nextValue. Other artifact commands use their closed fields and a non-empty summary.`,
  },
  regenerationTicket: {
    type: 'string',
    description: 'Optional opaque Host ticket returned after a user requests regeneration of one prior proposal item. Include it only for the subsequent single-item replacement proposal.',
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

function parseProposalArgs(args: Record<string, unknown>): { readonly changes: readonly unknown[]; readonly regenerationTicket?: string } {
  rejectUnexpected(args, ['changes', 'regenerationTicket'])
  try {
    validateNovelProposalPayload(args)
  } catch (error) {
    if (error instanceof Error) throw new ToolArgsError([error.message])
    throw error
  }
  return args as { readonly changes: readonly unknown[]; readonly regenerationTicket?: string }
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
    description: 'Read authoritative V2 state, or request bounded chapter-context. chapter-context returns only the selected final prose and final-selection summary from the immediately preceding chapter; it returns an explicit empty context when no final is selected.',
    parameters: v2ReadParameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = args as Record<string, unknown>
      const kind = input.kind
      if (kind === 'state') rejectUnexpected(input, ['kind'])
      else if (kind === 'chapter-context') {
        rejectUnexpected(input, ['kind', 'chapter'])
        if (!Number.isSafeInteger(input.chapter) || (input.chapter as number) <= 0) {
          throw new ToolArgsError(['novel_read property "chapter" must be a positive integer for chapter-context'])
        }
      } else throw new ToolArgsError(['novel_read property "kind" must be "state" or "chapter-context"'])
      const workspace = await resolveWorkspace(exec)
      const store = await openNovelStore(workspace.path, workspace.id, options)
      try {
        return (kind === 'state'
          ? projectNovelStateRead(await store.read(exec.signal))
          : await store.readChapterContext(input.chapter as number, exec.signal)) as unknown as JsonValue
      } finally {
        await store.dispose()
      }
    },
    presentCall: () => ({ card: 'generic', title: '读取小说项目', kind: 'read', rawInput: { kind: 'state' } }),
  })
  const propose = defineTool({
    name: 'novel_propose_change',
    description: 'Persist one non-authoritative proposal bundle for user review. Changes may contain aggregate replacements or closed artifact version commands, but this tool never writes authoritative project state. Proposal session, call, and canonical args identity are supplied by the Host; only a later user-approved proposal apply can create versions or select a final.',
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
