/** Deterministic model and approval boundary for the complete-chapter composition. */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000'
const PROJECT_TIME = '2026-08-16T00:00:00.000Z'

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
    toolCall('chapter-01-init', {
      kind: 'initialize', projectId: PROJECT_ID, createdAt: PROJECT_TIME, updatedAt: PROJECT_TIME,
      title: '潮汐来信', language: 'zh-CN', genre: '奇幻悬疑', plannedChapters: 6,
      targetWordsPerChapter: 2_000, creativeStrategy: 'consistency-first',
    }),
    toolCall('chapter-01-read-characters', { kind: 'asset', target: { kind: 'characters' } }),
    toolCall('chapter-01-write-characters', {
      kind: 'replace', target: { kind: 'characters' }, baseRevision: 'absent', baseText: '',
      replacement: characters, summary: '建立主要人物',
    }),
    toolCall('chapter-01-read-story', { kind: 'asset', target: { kind: 'story-blueprint' } }),
    toolCall('chapter-01-write-story', {
      kind: 'replace', target: { kind: 'story-blueprint' }, baseRevision: 'absent', baseText: '',
      replacement: story, summary: '建立故事蓝图',
    }),
    toolCall('chapter-01-read-blueprint', { kind: 'asset', target: { kind: 'chapter-blueprint', chapter: 1 } }),
    toolCall('chapter-01-write-blueprint', {
      kind: 'replace', target: { kind: 'chapter-blueprint', chapter: 1 }, baseRevision: 'absent', baseText: '',
      replacement: blueprint, summary: '建立第一章蓝图',
    }),
    toolCall('chapter-01-read-working-set', { kind: 'working-set', chapter: 1 }),
    toolCall('chapter-01-write-draft', {
      kind: 'replace', target: { kind: 'chapter-draft', chapter: 1 }, baseRevision: 'absent', baseText: '',
      replacement: draft, summary: '起草第一章',
    }),
    toolCall('chapter-01-readback', { kind: 'working-set', chapter: 1 }),
    textResponse('第一章已在收到 CommitReceipt 后保存，并已回读确认。'),
  ]
}

class KeylessNovelAdapter extends LlmAdapter {
  constructor(phase, script) {
    super()
    this.phase = phase
    this.script = [...script]
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
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
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('Keyless novel script is exhausted')
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
  const phase = scenario === 'approval-never' || scenario === 'invalid-args'
    ? scenario
    : initialized ? 'restart' : 'first'
  const script = phase === 'approval-never'
    ? [textResponse('当前会话已禁用原生审批，因此无法提交小说修改。请切换到允许审批的权限策略后再试。')]
    : phase === 'invalid-args'
      ? [
          rawToolCall('invalid-nested-request', 'novel_apply_change', {
            request: JSON.stringify({ kind: 'initialize', title: '错误嵌套' }),
          }),
          textResponse('novel_apply_change 需要直接传入 kind 等浅层字段，不能使用字符串化的 request；本次修改已停止，不会重试。'),
        ]
      : initialized
        ? [
        toolCall('chapter-01-restart-read', { kind: 'working-set', chapter: 1 }),
        textResponse('重启后已读取相同的创作策略与第一章正文。'),
      ]
        : firstRunScript()
  const adapter = new KeylessNovelAdapter(phase, script)
  ctx.effect(() => ctx.llm.registerAdapter(['novel-snapshot'], adapter))
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
    return 'allowed-once'
  })
  await ctx.agents.create({
    sessionId: SessionId(`complete-chapter-${phase}`),
    meta: { cwd: process.cwd(), agentPreset: 'ai-novel-writer' },
    agentOptions: { provider: 'novel-snapshot', model: 'keyless' },
    setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'ai-novel-writer'),
  })
}
