import { vi } from 'vitest'
import type { AgentAuthorBlueprintProposal, AgentGenerationInput, AgentGenerationRecovery, AgentToolAction, AgentToolActionRef, AgentToolClaim } from '../../../shared/agent-generation'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { parseAgentResponseProtocol } from '../../../shared/agent-response-protocol'

/** Synthetic main transport for consumer tests. It does not prove SQLite
 * admission, main source validation, durable accounting, or real providers. */
export class AgentHostFixture {
  recovery!: AgentGenerationRecovery
  beginError?: Error
  finishFailures = 0
  loseFinishAck = false
  readonly domainEffects = new Set<string>()
  readonly authorProposals = new Map<string, AgentAuthorBlueprintProposal[]>()
  writingLanguage: 'zh-CN' | 'en-US' = 'zh-CN'
  claimOverride?: (action: AgentToolAction) => AgentToolClaim
  response: (index: number) => Promise<string | { status: 'unknown' | 'incomplete'; text?: string }> = async () => '完成。'
  readonly invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const request = args[0] as Record<string, unknown>
    if (channel === 'skills:list-user') return []
    if (channel === 'fs:check-exists') return false
    if (channel === 'agent-generation:begin') {
      if (this.beginError) throw this.beginError
      this.initialize(request.input as AgentGenerationInput, request.modelId as string)
      return structuredClone(this.recovery)
    }
    if (channel === 'agent-generation:read' || channel === 'agent-generation:resume') return structuredClone(this.recovery)
    if (channel === 'generation:cancel') { this.recovery.run.status = 'cancelled'; return this.recovery.run }
    if (channel === 'agent-generation:round') {
      const index = request.index as number
      let round = this.recovery.rounds.find(entry => entry.index === index)
      if (round && round.status !== 'not-started') return structuredClone(this.recovery)
      const content = await this.response(index)
      const handle = { ...this.recovery.handle, runId: `agent-run-${index}` }
      const protocol = typeof content === 'string' ? parseAgentResponseProtocol(content, this.recovery.context.input.tools.map(tool => tool.name)) : undefined
      round = { index, handle, attemptId: `agent-attempt-${index}`, status: typeof content === 'string' ? 'completed' : content.status,
        visibleText: protocol?.visibleText ?? (typeof content === 'string' ? '' : content.text ?? ''), protocolText: typeof content === 'string' ? content : '',
        actions: protocol?.toolCalls.map((call, toolIndex) => ({ ref: { handle, attemptId: `agent-attempt-${index}`, toolCallId: `agent-tool-${index}-${toolIndex}` },
          name: call.name, arguments: call.arguments, status: 'pending' })) ?? [] }
      this.recovery.rounds = [...this.recovery.rounds.filter(entry => entry.index !== index), round].sort((a, b) => a.index - b.index)
      this.recovery.handle = handle
      this.recovery.run.handle = handle
      this.recovery.nextRound = null
      return structuredClone(this.recovery)
    }
    if (channel === 'agent-generation:claim-tool') {
      const action = this.action(request.ref as AgentToolActionRef)
      if (this.claimOverride) return structuredClone(this.claimOverride(action))
      if (action.status !== 'pending') return { action: structuredClone(action), execute: false }
      action.status = request.confirmed ? 'running' : 'declined'
      if (request.confirmed && action.name === 'propose_novel_config' && request.authorBlueprintProposals) {
        this.authorProposals.set(action.ref.toolCallId, structuredClone(request.authorBlueprintProposals as AgentAuthorBlueprintProposal[]))
      }
      return { action: structuredClone(action), execute: request.confirmed === true }
    }
    if (channel === 'agent-generation:commit-domain-tool') {
      const action = this.action(request.ref as AgentToolActionRef)
      if (action.status !== 'running' || !['propose_novel_config', 'propose_chapter_blueprint'].includes(action.name)) throw new Error('Synthetic domain action not claimed')
      this.domainEffects.add(action.ref.toolCallId)
      return { kind: action.name === 'propose_novel_config' ? 'config' : 'blueprint', toolCallId: action.ref.toolCallId,
        changes: structuredClone(action.arguments.changes), chapterNumber: action.arguments.chapter_number,
        beforeHash: 'synthetic-before', afterHash: 'synthetic-after', current: true }
    }
    if (channel === 'agent-generation:finish-tool') {
      if (this.finishFailures-- > 0) throw new Error('synthetic storage failure')
      const action = this.action(request.ref as AgentToolActionRef)
      action.status = request.status as AgentToolAction['status']
      action.observation = request.observation as string
      if (action.status === 'completed' && this.domainEffects.has(action.ref.toolCallId)) {
        const round = this.recovery.rounds.find(entry => entry.actions.includes(action))!
        for (const [index, proposal] of (this.authorProposals.get(action.ref.toolCallId) ?? []).entries()) {
          const toolCallId = `${action.ref.toolCallId}-author-${index}`
          if (!round.actions.some(entry => entry.ref.toolCallId === toolCallId)) round.actions.push({ ref: { ...action.ref, toolCallId },
            name: proposal.name, arguments: structuredClone(proposal.arguments), status: 'pending' })
        }
      }
      const last = this.recovery.rounds.at(-1)!
      if (last.actions.length && last.actions.every(entry => ['completed', 'failed', 'declined'].includes(entry.status))) this.recovery.nextRound = last.index + 1
      if (this.loseFinishAck) { this.loseFinishAck = false; throw new Error('synthetic lost finish ACK') }
      return structuredClone(action)
    }
    throw new Error(`Unexpected synthetic Agent IPC: ${channel}`)
  })

  constructor(readonly session: ProjectSessionContext) {}

  initialize(input: AgentGenerationInput, modelId = 'model-a') {
    const handle = { projectId: this.session.projectId, epoch: this.session.leaseId, rootActionId: 'agent-root', runId: 'agent-run-0' }
    this.recovery = { handle, modelId, context: { version: 1, input: structuredClone(input), writingLanguage: this.writingLanguage,
      initialMessages: [{ role: 'system', content: this.writingLanguage === 'zh-CN' ? '主进程冻结的系统指令' : 'Main-frozen system instructions' }, ...input.historyMessages, { role: 'user', content: input.userMessage }] },
      rounds: [{ index: 0, handle, status: 'not-started', visibleText: '', protocolText: '', actions: [] }], sourceStatus: 'current', nextRound: 0,
      run: { handle, status: 'running', nonReplayable: false, artifacts: [], budget: { maxAttempts: 8, maxRequestedOutputTokens: 65_536,
        maxRequestedOutputTokensPerAttempt: 8192, deadlineAt: Date.now() + 60_000 } } }
  }

  action(ref: AgentToolActionRef): AgentToolAction {
    const action = this.recovery.rounds.flatMap(round => round.actions).find(entry => entry.ref.toolCallId === ref.toolCallId)
    if (!action) throw new Error('Synthetic action missing')
    return action
  }

  install() {
    vi.stubGlobal('window', { aiNovelAPI: { invoke: this.invoke, on: vi.fn(), once: vi.fn(), send: vi.fn() } })
    return this
  }
}
