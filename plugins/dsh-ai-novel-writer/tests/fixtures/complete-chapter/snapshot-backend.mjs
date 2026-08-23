/** Deterministic model and approval boundary for the complete-chapter composition. */
import { createHash } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000'
const PROJECT_TIME = '2026-08-16T00:00:00.000Z'
const PROJECT_MANIFEST = `${JSON.stringify({
  formatVersion: 1,
  kind: 'harness-novel-project',
  projectId: PROJECT_ID,
  title: '潮汐来信',
  language: 'zh-CN',
  genre: '奇幻悬疑',
  plannedChapters: 6,
  targetWordsPerChapter: 2_000,
  creativeStrategy: 'consistency-first',
  createdAt: PROJECT_TIME,
  updatedAt: PROJECT_TIME,
}, null, 2)}\n`
const PROJECT_REVISION = createHash('sha256').update(PROJECT_MANIFEST).digest('hex')

function v2ProposalScript() {
  return [
    rawToolCall('v2-read-state', 'novel_read', { kind: 'state' }),
    rawToolCall('v2-propose-architecture', 'novel_propose_change', {
      changes: [{
        changeSetId: 'v2-architecture-proposal',
        aggregate: { kind: 'architecture' },
        baseAggregateRevision: 0,
        baseGlobalRevision: 0,
        nextValue: {
          premise: '信件来自明天',
          characterGraph: '林夏与弟弟通过未来信件互相牵引。',
          world: '被永夜潮汐包围的群岛。',
          plotOutline: '林夏沿未来信件追踪弟弟的下落。',
          styleConstraints: '冷峻而温柔的短句。',
          referenceWorks: [],
        },
      }],
    }),
    textResponse('修改建议已进入待审提案队列，尚未改变权威小说项目。'),
  ]
}

const CHAIN_MANUAL_ARCHITECTURE = {
  premise: 'fixture-architecture-premise-manual',
  characterGraph: 'fixture-character-graph-manual',
  world: 'fixture-world-manual',
  plotOutline: 'fixture-outline-manual',
  styleConstraints: 'fixture-style-manual',
  referenceWorks: [],
}
const CHAIN_MANUAL_REVISION = 'fixture-revision-content-manual'

function v2AuthoringChainProposal(stage) {
  const aggregate = (changeSetId, kind, baseAggregateRevision, baseGlobalRevision, nextValue) => ({
    changes: [{ changeSetId, aggregate: { kind }, baseAggregateRevision, baseGlobalRevision, nextValue }],
  })
  if (stage === 'project-refine') {
    return aggregate('chain-project-refine', 'project', 0, 0, {
      title: 'fixture-project-title', language: 'zh-CN', genre: 'fixture-genre', plannedChapters: 2,
      targetWordsPerChapter: 2_000, creativeStrategy: 'consistency-first', structureMode: 'three-act',
      narrativePov: 'third-limited', globalGuidance: 'fixture-project-guidance-manual',
      createdAt: PROJECT_TIME, updatedAt: '2026-08-22T00:00:00.000Z',
    })
  }
  if (stage === 'architecture') {
    return aggregate('chain-architecture-ai', 'architecture', 0, 1, {
      premise: 'fixture-architecture-premise-ai',
      characterGraph: 'fixture-character-graph-ai',
      world: 'fixture-world-ai',
      plotOutline: 'fixture-outline-ai',
      styleConstraints: 'fixture-style-ai',
      referenceWorks: [],
    })
  }
  if (stage === 'architecture-manual') {
    return aggregate('chain-architecture-manual', 'architecture', 1, 2, CHAIN_MANUAL_ARCHITECTURE)
  }
  if (stage === 'characters') {
    return aggregate('chain-characters-ai', 'characters', 0, 3, {
      items: [{
        characterId: 'fixture-character-1', name: 'fixture-name-1', role: 'fixture-role-1', summary: 'fixture-character-summary-1',
        goal: 'fixture-character-goal-1', currentState: 'fixture-character-state-1', notes: 'fixture-character-notes-1',
      }],
      relationships: [],
    })
  }
  if (stage === 'outline') {
    return aggregate('chain-outline-ai', 'architecture', 2, 4, {
      ...CHAIN_MANUAL_ARCHITECTURE,
      plotOutline: 'chapter-1-fixture-outline\nchapter-2-fixture-outline',
    })
  }
  if (stage === 'chapter-blueprint-1') {
    return {
      changes: [{
        changeSetId: 'chain-chapter-1-blueprint', aggregate: { kind: 'chapter', chapter: 1 },
        baseAggregateRevision: 0, baseGlobalRevision: 5,
        nextValue: {
          chapter: 1, title: 'fixture-chapter-1-title', purpose: 'fixture-chapter-1-purpose',
          plotBeats: ['fixture-chapter-1-beat-1', 'fixture-chapter-1-beat-2'], characters: ['fixture-character-1'],
          keyEvents: ['fixture-chapter-1-event-1'], suspense: 'fixture-chapter-1-suspense', status: 'drafting',
        },
      }],
    }
  }
  if (stage === 'draft-1') {
    return {
      changes: [{
        kind: 'artifact/draft', artifactId: 'chain-chapter-1-draft', chapter: 1,
        content: 'fixture-draft-content-1', summary: 'fixture-draft-summary-1',
      }],
    }
  }
  if (stage === 'revision-1-manual') {
    return {
      changes: [{
        kind: 'artifact/revision', artifactId: 'chain-chapter-1-revision', chapter: 1,
        parentArtifactId: 'chain-chapter-1-draft', content: CHAIN_MANUAL_REVISION, summary: 'fixture-revision-summary-1',
      }],
    }
  }
  if (stage === 'select-final-1') {
    return {
      changes: [{
        kind: 'chapter/select-final', chapter: 1, artifactId: 'chain-chapter-1-revision', summary: 'fixture-final-summary-1',
      }],
    }
  }
  if (stage === 'chapter-blueprint-2') {
    return {
      changes: [{
        changeSetId: 'chain-chapter-2-blueprint', aggregate: { kind: 'chapter', chapter: 2 },
        baseAggregateRevision: 0, baseGlobalRevision: 6,
        nextValue: {
          chapter: 2, title: 'fixture-chapter-2-title', purpose: 'fixture-chapter-2-purpose',
          plotBeats: ['fixture-chapter-2-beat-1', 'fixture-chapter-2-beat-2'], characters: ['fixture-character-1'],
          keyEvents: ['fixture-chapter-2-event-1'], suspense: 'fixture-chapter-2-suspense', status: 'drafting',
        },
      }],
    }
  }
  if (stage === 'draft-2') {
    return {
      changes: [{
        kind: 'artifact/draft', artifactId: 'chain-chapter-2-draft', chapter: 2,
        content: 'fixture-draft-content-2', summary: 'fixture-draft-summary-2',
      }],
    }
  }
  throw new Error(`unsupported V2 authoring qualification stage: ${stage}`)
}

function v2AuthoringChainScript(stage) {
  const readCallIds = [`chain-${stage}-read-state`]
  const reads = [rawToolCall(readCallIds[0], 'novel_read', { kind: 'state' })]
  if (stage === 'draft-2') {
    readCallIds.push('chain-draft-2-read-context')
    reads.push(rawToolCall(readCallIds[1], 'novel_read', { kind: 'chapter-context', chapter: 2 }))
  }
  return [
    ...reads,
    options => successfulAuthoringReads(options, readCallIds)
      ? rawToolCall(
          `chain-${stage}-propose`,
          'novel_propose_change',
          v2AuthoringChainProposal(stage),
        )
      : textResponse('权威 novel_read 未成功完成；本轮停止，未创建 Proposal。'),
    textResponse('提案已记录，等待用户在提案收件箱中审核并应用。'),
  ]
}

/** Require the exact preceding ToolRuntime results before this deterministic model may propose. */
function successfulAuthoringReads(options, callIds) {
  const outcomes = new Map()
  for (const message of options.messages ?? []) {
    if (message?.source?.kind !== 'tool' || !callIds.includes(message.source.callId)) continue
    const block = message.content?.[0]
    if (block?.type === 'tool-result' && block.toolCallId === message.source.callId) {
      outcomes.set(message.source.callId, block.isError === false)
    }
  }
  return callIds.every(callId => outcomes.get(callId) === true)
}

function assertV2AuthoringChainPrompt(options, stage) {
  const prompt = JSON.stringify((options.messages ?? []).filter(message => message?.source?.kind === 'user'))
  const stageLabel = stage.startsWith('chapter-blueprint')
    ? '章节蓝图'
    : stage.startsWith('draft')
      ? '章节初稿'
      : stage.startsWith('revision')
        ? '章节修订'
        : stage.startsWith('select-final')
          ? '选择定稿'
          : stage === 'architecture-manual'
            ? '架构设计'
            : stage === 'project-refine'
              ? '项目设定优化'
              : stage === 'architecture'
                ? '架构设计'
                : stage === 'characters'
                  ? '角色设定'
                  : '全书大纲'
  const requestKind = stage === 'architecture-manual' || stage === 'revision-1-manual'
    ? '人工修改提交'
    : ' AI 起草'
  const requiredAuthoringClauses = [
    '请先阅读当前小说内容，确认建议符合作者要求。',
    '当前请求信息已足够。',
    '请在本回合直接完成一份完整、待审核的创作建议。',
    '将建议提交到审核队列。',
    '不要追问、给出选项或要求作者确认。',
    '不要只在对话文字中写出建议。',
    '不要直接改写小说内容。',
  ]
  if (!prompt.includes(`次${requestKind}请求。`)
    || !prompt.includes(`“${stageLabel}”`)
    || requiredAuthoringClauses.some(clause => !prompt.includes(clause))) {
    throw new Error(`V2 authoring qualification did not receive the expected ${stage} author request`)
  }
  const requestWithoutAuthorValues = [
    ...Object.values(CHAIN_MANUAL_ARCHITECTURE),
    CHAIN_MANUAL_REVISION,
  ].reduce((text, value) => text.replaceAll(value, ''), prompt)
  if (/JSON|revision|artifactId|characterId|Host|command|tool|工具|命令|Proposal Bundle|baseAggregate|nextValue|AI_NOVEL|novel_(?:read|propose_change|apply_change)/i.test(requestWithoutAuthorValues)) {
    throw new Error(`V2 authoring qualification exposed implementation detail in the ${stage} author request`)
  }
  const expectedTools = ['novel_propose_change', 'novel_read']
  const actualTools = (options.tools ?? []).map(tool => tool.name).sort()
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`V2 authoring qualification exposed an invalid tool surface: ${actualTools.join(', ')}`)
  }
  if (stage === 'architecture-manual' && (!prompt.includes('作者已完成以下人工修改。')
    || !prompt.includes(CHAIN_MANUAL_ARCHITECTURE.premise)
    || !prompt.includes(CHAIN_MANUAL_ARCHITECTURE.styleConstraints))) {
    throw new Error('V2 authoring qualification lost the complete manual architecture draft')
  }
  if (stage === 'revision-1-manual' && (!prompt.includes('作者已完成以下人工修改。') || !prompt.includes(CHAIN_MANUAL_REVISION))) {
    throw new Error('V2 authoring qualification lost the complete manual revision draft')
  }
  if (stage === 'revision-1-manual' && !prompt.includes('请根据第 1 个版本（第 1 章初稿）提出修订建议；人工将在提案中核对目标版本后再应用。')) {
    throw new Error('V2 authoring qualification lost the author-facing revision guidance')
  }
  if (stage === 'select-final-1' && !prompt.includes('请根据第 2 个版本（第 1 章修订稿）提出定稿建议；人工将在提案中核对目标版本后再应用。')) {
    throw new Error('V2 authoring qualification lost the author-facing final guidance')
  }
}

function assertV2ProposalProtocol(options) {
  const system = options.system
  const required = [
    'AI 小说作家 V2 使用宿主的原生函数调用',
    '每个工具的完整输入就是直接传给工具的 JSON 对象',
    '不得写标签式工具调用文本',
    '不得在顶层包一层 "arguments"',
    'novel_read 的完整输入必须严格为 {"kind":"state"}',
    'novel_propose_change 的直接输入必须严格为 {"changes":[...]}',
    '不得将输入整体字符串化',
    '不得在输入内嵌套名为 arguments 的属性',
    'changes 必须恰好包含一个命令',
    'aggregate.kind 只能是 "project"、"architecture"、"characters"、"chapter" 或 "task"',
    'artifact/revision: kind、artifactId、chapter、parentArtifactId、content、summary',
    '若 novel_read 或 novel_propose_change 失败，立即停止本次创作',
    '不要猜测、探测或重试',
  ]
  const forbidden = ['<tool_call>', '"arguments":{"changes":']
  if (typeof system !== 'string' || required.some(fragment => !system.includes(fragment)) || forbidden.some(fragment => system.includes(fragment))) {
    throw new Error('V2 authoring qualification did not receive the required proposal protocol in its first model system prompt')
  }
}

function initializationCall(callId) {
  return toolCall(callId, {
    kind: 'initialize', projectId: PROJECT_ID, createdAt: PROJECT_TIME, updatedAt: PROJECT_TIME,
    title: '潮汐来信', language: 'zh-CN', genre: '奇幻悬疑', plannedChapters: 6,
    targetWordsPerChapter: 2_000, creativeStrategy: 'consistency-first',
  })
}

function staleRevisionScript() {
  const replacement = `${JSON.stringify({
    ...JSON.parse(PROJECT_MANIFEST),
    title: '已提交的新标题',
    updatedAt: '2026-08-16T01:00:00.000Z',
  }, null, 2)}\n`
  return [
    initializationCall('stale-init'),
    toolCall('stale-read-project', { kind: 'asset', target: { kind: 'project' } }),
    toolCall('stale-replace-project', {
      kind: 'replace', target: { kind: 'project' }, baseRevision: PROJECT_REVISION,
      replacement, summary: '调整项目标题',
    }),
    textResponse('项目 revision 已变化，修改未覆盖外部内容。'),
  ]
}

function requestName(request) {
  return request.kind === 'initialize' || request.kind === 'replace'
    ? 'novel_apply_change'
    : 'novel_read'
}

function toolCall(callId, request) {
  const { target, ...fields } = request
  return rawToolCall(callId, requestName(request), target === undefined
    ? fields
    : { ...fields, targetKind: target.kind, ...(target.chapter === undefined ? {} : { chapter: target.chapter }) })
}

function rawToolCall(callId, name, args) {
  const id = CallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function firstRunScript() {
  const characters = JSON.stringify({ characters: [{
    id: 'lin-xia', name: '林夏', role: '灯塔守望人', summary: '能听见潮汐中的旧日回声。',
    goal: '找回失踪的弟弟。', relationships: [], notes: '害怕深水，却从不离开灯塔。',
  }] })
  const story = JSON.stringify({
    premise: '退潮后的海床会浮现来自未来的信件。', themes: ['记忆', '选择'],
    world: '被永夜潮汐包围的群岛。', mainPlot: '林夏循着未来信件寻找失踪者。',
    endingGoal: '林夏决定保留真实记忆并点亮全部灯塔。',
  })
  const blueprint = JSON.stringify({
    chapter: 1, title: '退潮来信', purpose: '让林夏收到第一封未来信件。',
    beats: ['夜潮退去', '海床显出信匣', '信上写着弟弟明日的求救'],
    characterIds: ['lin-xia'], continuityNotes: ['灯塔主灯在午夜熄灭'], status: 'planned',
  })
  const draft = '# 退潮来信\n\n午夜，灯塔的主灯第一次熄灭。\n\n林夏在退去的潮水里捡到一封尚未寄出的信。\n'
  return [
    initializationCall('chapter-01-init'),
    toolCall('chapter-01-read-characters', { kind: 'asset', target: { kind: 'characters' } }),
    toolCall('chapter-01-write-characters', {
      kind: 'replace', target: { kind: 'characters' }, baseRevision: 'absent',
      replacement: characters, summary: '建立主要人物',
    }),
    toolCall('chapter-01-read-story', { kind: 'asset', target: { kind: 'story-blueprint' } }),
    toolCall('chapter-01-write-story', {
      kind: 'replace', target: { kind: 'story-blueprint' }, baseRevision: 'absent',
      replacement: story, summary: '建立故事蓝图',
    }),
    toolCall('chapter-01-read-blueprint', { kind: 'asset', target: { kind: 'chapter-blueprint', chapter: 1 } }),
    toolCall('chapter-01-write-blueprint', {
      kind: 'replace', target: { kind: 'chapter-blueprint', chapter: 1 }, baseRevision: 'absent',
      replacement: blueprint, summary: '建立第一章蓝图',
    }),
    toolCall('chapter-01-read-working-set', { kind: 'working-set', chapter: 1 }),
    toolCall('chapter-01-write-draft', {
      kind: 'replace', target: { kind: 'chapter-draft', chapter: 1 }, baseRevision: 'absent',
      replacement: draft, summary: '起草第一章',
    }),
    toolCall('chapter-01-readback', { kind: 'working-set', chapter: 1 }),
    textResponse('第一章已在收到 CommitReceipt 后保存，并已回读确认。'),
  ]
}

class KeylessNovelAdapter extends LlmAdapter {
  constructor(phase, script, authoringStage = undefined) {
    super()
    this.phase = phase
    this.script = [...script]
    this.authoringStage = authoringStage
    this.authoringProtocolAsserted = false
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    if (this.authoringStage !== undefined) {
      assertV2AuthoringChainPrompt(options, this.authoringStage)
      if (!this.authoringProtocolAsserted) {
        assertV2ProposalProtocol(options)
        this.authoringProtocolAsserted = true
        process.stdout.write(`${JSON.stringify({ type: 'v2_proposal_protocol_asserted', phase: this.phase })}\n`)
      }
    }
    process.stdout.write(`${JSON.stringify({
      type: 'model_request',
      phase: this.phase,
      request: {
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort ?? null,
        maxTokens: options.maxTokens ?? null,
        system: options.system ?? null,
        tools: options.tools ?? [],
        messages: options.messages,
      },
    })}\n`)
    const step = this.script.shift()
    if (step === undefined) throw new Error('Keyless novel script is exhausted')
    const chunks = typeof step === 'function' ? step(options) : step
    for (const chunk of chunks) yield chunk
  }
}

/** Cordis fixture identity. */
export const name = 'complete-chapter-snapshot-backend'
/** Services required before the fixture creates its one root agent. */
export const inject = ['llm', 'agents', 'agentLoop', 'agentPresets', 'approval']

/**
 * Register the scripted model, approval answerer, and one preset-composed agent.
 * @param {import('@deepseek-ai/cordis').Context} ctx - settled fixture composition.
 * @returns {Promise<void>} Completion after the root agent is published.
 */
export async function apply(ctx) {
  const manifest = join(process.cwd(), '.ai-novel', 'project.json')
  let initialized = true
  try {
    await access(manifest)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    initialized = false
  }
  const scenario = process.env.DSH_NOVEL_SCENARIO
  const authoringStage = scenario === 'v2-authoring-chain' ? process.env.DSH_NOVEL_AUTHORING_STAGE : undefined
  if (scenario === 'v2-authoring-chain' && (typeof authoringStage !== 'string' || authoringStage === '')) {
    throw new Error('V2 authoring chain backend requires DSH_NOVEL_AUTHORING_STAGE')
  }
  const phase = authoringStage ?? (scenario === 'approval-never'
    || scenario === 'invalid-args'
    || scenario === 'approval-rejected'
    || scenario === 'stale-revision'
    || scenario === 'v2-proposal'
    ? scenario
    : initialized ? 'restart' : 'first')
  const script = authoringStage !== undefined
    ? v2AuthoringChainScript(authoringStage)
    : phase === 'approval-never'
    ? [textResponse('当前会话已禁用原生审批，因此无法提交小说修改。请切换到允许审批的权限策略后再试。')]
    : phase === 'invalid-args'
      ? [
          rawToolCall('invalid-nested-request', 'novel_apply_change', {
            request: JSON.stringify({ kind: 'initialize', title: '错误嵌套' }),
          }),
          textResponse('novel_apply_change 需要直接传入 kind 等浅层字段，不能使用字符串化的 request；本次修改已停止，不会重试。'),
        ]
      : phase === 'approval-rejected'
        ? [initializationCall('rejected-init'), textResponse('用户拒绝了小说项目初始化，磁盘未发生变化。')]
        : phase === 'stale-revision'
          ? staleRevisionScript()
          : phase === 'v2-proposal'
            ? v2ProposalScript()
            : initialized
            ? [
                toolCall('chapter-01-restart-read', { kind: 'working-set', chapter: 1 }),
                textResponse('重启后已读取相同的创作策略与第一章正文。'),
              ]
            : firstRunScript()
  const adapter = new KeylessNovelAdapter(phase, script, authoringStage)
  ctx.effect(() => ctx.llm.registerAdapter(['novel-snapshot'], adapter))
  const presetId = phase === 'v2-proposal' || authoringStage !== undefined ? 'ai-novel-writer-v2' : 'ai-novel-writer'
  let approvalCount = 0
  ctx.on('approval/request', async () => {
    approvalCount += 1
    if (approvalCount === 1) {
      let state = 'present'
      try {
        await access(manifest)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        state = 'absent'
      }
      process.stdout.write(`${JSON.stringify({ type: 'preapproval', phase, manifest: state })}\n`)
      if (state !== 'absent') throw new Error('manifest changed before native approval')
    }
    if (phase === 'approval-rejected') return 'rejected'
    if (phase === 'stale-revision' && approvalCount === 2) {
      const external = `${JSON.stringify({
        ...JSON.parse(PROJECT_MANIFEST),
        title: '外部并发标题',
        updatedAt: '2026-08-16T00:30:00.000Z',
      }, null, 2)}\n`
      await writeFile(manifest, external, 'utf8')
    }
    return 'allowed-once'
  })
  await ctx.agents.create({
    sessionId: SessionId(`complete-chapter-${phase}`),
    meta: { cwd: process.cwd(), agentPreset: presetId },
    agentOptions: { provider: 'novel-snapshot', model: 'keyless' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
}
