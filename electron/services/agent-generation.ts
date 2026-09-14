import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import type { AgentGenerationContext, AgentGenerationInput, AgentGenerationRecovery, AgentGenerationRound, AgentToolAction, AgentToolActionRef, AgentWorkflowRegistration, AgentAuthorBlueprintProposal, AgentToolClaim, AgentDomainToolReceipt } from '../../src/shared/agent-generation'
import type { BeginGenerationRequest } from '../../src/shared/generation-owner-contract'
import type { MainGenerationExecuteReceipt, MainGenerationRunHandle, MainGenerationRunView } from '../../src/services/generation/generation-runtime'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { GenerationRunRepository, textHash, type DurableGenerationRun, type RunBinding } from '../repositories/generation-run-repository'
import { validateAgentGenerationInput } from './agent-generation-context'
import { commitAgentDomainTool, isAgentDomainToolCurrent } from './agent-domain-tool-effect'

export type AgentBeginSelection = BeginGenerationRequest & { agentInput: AgentGenerationInput; agentSession: { key: string; roundIndex: number } }
interface AgentHost {
  begin(selection: AgentBeginSelection): MainGenerationRunView
  read(handle: MainGenerationRunHandle): MainGenerationRunView
  resume(handle: MainGenerationRunHandle): Promise<MainGenerationRunView>
  execute(handle: MainGenerationRunHandle, nonce: string, task: GenerationTask): Promise<MainGenerationExecuteReceipt>
  current(run: DurableGenerationRun, expected?: RunBinding): boolean
  capture(run: DurableGenerationRun): RunBinding
}
type ActionState = Pick<AgentToolAction, 'status' | 'observation' | 'workflow'> & { domainEffect?: AgentDomainToolReceipt }
type StoredUsage = { agentActions?: Record<string, ActionState>; agentAuthorSelections?: Record<string, AgentAuthorBlueprintProposal[]>;
  agentSourceTransition?: { actionId: string; beforeHash: string; afterHash: string; binding: RunBinding }; agentControlEpoch?: string }

/** Agent navigation/control lives on existing runs and attempt receipts. No second budget or writer. */
export class AgentGeneration {
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository,
    private readonly scope: { projectId: string; epoch: string }, private readonly assertCurrent: () => void, private readonly host: AgentHost) {
    // A renderer-owned tool may have crossed its commit point before the old owner
    // closed. Its unfinished claim is an unknown result, never permission to rerun.
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT a.attempt_id,a.usage_receipt_json FROM generation_attempts a JOIN generation_runs r ON r.run_id=a.run_id WHERE json_extract(r.binding_json,'$.projectId')=? AND json_extract(r.binding_json,'$.sourceManifest.operation')='agent-round'").all(scope.projectId) as { attempt_id: string; usage_receipt_json: string | null }[]
      for (const row of rows) {
        const usage = JSON.parse(row.usage_receipt_json ?? '{}') as StoredUsage
        if (!usage.agentActions) continue
        let changed = false
        for (const state of Object.values(usage.agentActions)) if (state.status === 'running') {
          state.status = state.domainEffect ? 'completed' : 'unknown'
          if (state.domainEffect) state.observation = 'The confirmed application change was committed.'
          changed = true
        }
        if (changed) this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(usage), row.attempt_id)
      }
    }).immediate()
  }

  private handle(run: DurableGenerationRun): MainGenerationRunHandle {
    return { projectId: run.binding.projectId, epoch: run.binding.epoch, rootActionId: run.rootActionId, runId: run.runId }
  }
  private requireRun(handle: MainGenerationRunHandle): DurableGenerationRun {
    this.assertCurrent()
    const run = this.runs.get(handle.runId)
    if (!isDeepStrictEqual(this.handle(run), handle) || run.binding.projectId !== this.scope.projectId
      || run.binding.sourceManifest.operation !== 'agent-round') throw new Error('GENERATION_AGENT_IDENTITY_MISMATCH')
    this.context(run)
    return run
  }
  private context(run: DurableGenerationRun): AgentGenerationContext {
    const context = run.binding.sourceManifest.agentContext as AgentGenerationContext | undefined
    if (!context || context.version !== 1 || textHash(JSON.stringify(context)) !== run.binding.sourceManifest.agentContextHash)
      throw new Error('GENERATION_AGENT_CONTEXT_INVALID')
    return context
  }
  private navigation(run: DurableGenerationRun): { key: string; roundIndex: number } {
    const value = run.binding.sourceManifest.agentSession as { key: string; roundIndex: number } | undefined
    if (!value || !/^[a-f0-9]{64}$/u.test(value.key) || !Number.isSafeInteger(value.roundIndex) || value.roundIndex < 0 || value.roundIndex >= 8)
      throw new Error('GENERATION_AGENT_NAVIGATION_INVALID')
    return value
  }
  private sessionRuns(key: string): DurableGenerationRun[] {
    return (this.db.prepare("SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.agentSession.key')=? ORDER BY rowid").all(key) as { run_id: string }[])
      .map(row => this.runs.get(row.run_id)).filter(run => run.binding.projectId === this.scope.projectId)
      .sort((a, b) => this.navigation(a).roundIndex - this.navigation(b).roundIndex)
  }
  private modelId(run: DurableGenerationRun): string { return (run.binding.sourceManifest.modelReceipt as { modelId: string }).modelId }
  private actionId(attemptId: string, index: number): string { return `agent-tool:${attemptId}:${index}` }
  private sourcesCurrent(run: DurableGenerationRun): boolean {
    const rows = this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid DESC').all(run.runId) as { usage_receipt_json: string | null }[]
    const transition = rows.map(row => (JSON.parse(row.usage_receipt_json ?? '{}') as StoredUsage).agentSourceTransition).find(Boolean)
    if (transition && textHash(JSON.stringify(transition.binding)) !== transition.afterHash) throw new Error('GENERATION_AGENT_EFFECT_BINDING_INVALID')
    return this.host.current(run, transition?.binding)
  }
  private round(run: DurableGenerationRun): AgentGenerationRound {
    const index = this.navigation(run).roundIndex
    const rows = this.db.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(run.runId) as { attempt_id: string; usage_receipt_json: string | null }[]
    if (rows.length > 1) throw new Error('GENERATION_AGENT_ROUND_AMBIGUOUS')
    const row = rows[0]
    if (!row) return { index, handle: this.handle(run), status: 'not-started', visibleText: '', protocolText: '', actions: [] }
    const receipt = this.runs.receipt(row.attempt_id)
    const usage = JSON.parse(row.usage_receipt_json ?? '{}') as StoredUsage
    const response = receipt.result?.usage?.agentResponse
    const complete = !!response && response.version === 1 && receipt.result?.finishReason === 'stop'
      && ['settled', 'unknown'].includes(receipt.attempt.status) && receipt.artifact?.text === response.visibleText
    if (!complete) return { index, handle: this.handle(run), attemptId: row.attempt_id,
      status: receipt.attempt.status === 'unknown' || receipt.attempt.status === 'dispatch-marked' || receipt.attempt.status === 'reserved' ? 'unknown' : 'incomplete',
      visibleText: receipt.artifact?.text ?? '', protocolText: '', actions: [] }
    const actions = response.toolCalls.map((call, callIndex): AgentToolAction => {
      const toolCallId = this.actionId(row.attempt_id, callIndex)
      const state = usage.agentActions?.[toolCallId]
      return { ref: { handle: this.handle(run), attemptId: row.attempt_id, toolCallId }, name: call.name, arguments: structuredClone(call.arguments),
        status: state?.status ?? 'pending', ...(state?.observation !== undefined ? { observation: state.observation } : {}), ...(state?.workflow ? { workflow: state.workflow } : {}) }
    })
    for (let index = 0; index < actions.length; index++) {
      const parent = actions[index]!
      if (parent.name !== 'propose_novel_config' || parent.status !== 'completed' || usage.agentActions?.[parent.ref.toolCallId]?.domainEffect?.kind !== 'config') continue
      const selected = usage.agentAuthorSelections?.[parent.ref.toolCallId] ?? []
      const followups = selected.map((proposal, selectionIndex): AgentToolAction => {
        const toolCallId = `${parent.ref.toolCallId}:author:${selectionIndex}`, state = usage.agentActions?.[toolCallId]
        return { ref: { ...parent.ref, toolCallId }, name: proposal.name, arguments: structuredClone(proposal.arguments), status: state?.status ?? 'pending',
          ...(state?.observation !== undefined ? { observation: state.observation } : {}) }
      })
      actions.splice(index + 1, 0, ...followups)
      index += followups.length
    }
    return { index, handle: this.handle(run), attemptId: row.attempt_id, status: 'completed', visibleText: response.visibleText,
      protocolText: [response.visibleText, ...response.toolCalls.map(call => `<tool_call>${JSON.stringify(call)}</tool_call>`)].filter(Boolean).join('\n'), actions }
  }
  read(handle: MainGenerationRunHandle): AgentGenerationRecovery {
    const selected = this.requireRun(handle), key = this.navigation(selected).key, records = this.sessionRuns(key)
    if (!records.length || records[0]!.rootActionId !== selected.rootActionId || records.some(run => run.rootActionId !== selected.rootActionId)) throw new Error('GENERATION_AGENT_ROOT_MISMATCH')
    const rounds = records.map(run => this.round(run)), latest = records.at(-1)!, last = rounds.at(-1)!
    if (rounds.some((round, index) => round.index !== index)) throw new Error('GENERATION_AGENT_ROUND_GAP')
    const allDone = last.actions.length > 0 && last.actions.every(action => ['completed', 'failed', 'declined'].includes(action.status))
    const nextRound = last.status === 'not-started' ? last.index : last.status === 'completed' && allDone && last.index < 7 ? last.index + 1 : null
    return { handle: this.handle(latest), modelId: this.modelId(records[0]!), context: this.context(records[0]!), rounds,
      sourceStatus: this.sourcesCurrent(latest) ? 'current' : 'conflict', nextRound, run: this.host.read(this.handle(latest)) }
  }
  begin(request: { uiActionNonce: string; modelId: string; input: AgentGenerationInput }): AgentGenerationRecovery {
    this.assertCurrent()
    if (!request || Object.keys(request).some(key => !['uiActionNonce', 'modelId', 'input'].includes(key))
      || typeof request.uiActionNonce !== 'string' || !request.uiActionNonce.trim() || request.uiActionNonce.length > 256
      || typeof request.modelId !== 'string' || !request.modelId.trim()) throw new Error('GENERATION_AGENT_BEGIN_INVALID')
    const input = validateAgentGenerationInput(request.input)
    const key = textHash(JSON.stringify([this.scope.projectId, request.uiActionNonce]))
    const existing = this.sessionRuns(key)
    if (existing.length) {
      if (!isDeepStrictEqual(this.context(existing[0]!).input, input) || this.modelId(existing[0]!) !== request.modelId) throw new Error('GENERATION_AGENT_NONCE_CONFLICT')
      return this.read(this.handle(existing[0]!))
    }
    const view = this.host.begin(this.selection(input, key, 0, request.modelId))
    return this.read(view.handle)
  }
  async resume(handle: MainGenerationRunHandle): Promise<AgentGenerationRecovery> {
    const recovery = this.read(handle)
    if (recovery.sourceStatus !== 'current') throw new Error('GENERATION_SOURCE_CHANGED')
    const last = recovery.rounds.at(-1)!
    if (last.status === 'completed') {
      // Resume control of a finished response without rewriting that response's
      // historical input binding or dispatching a new model attempt.
      this.db.transaction(() => {
        this.runs.activateRootForCommittedStage(recovery.handle.rootActionId, this.scope)
        const raw = this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(last.attemptId) as string
        const usage = JSON.parse(raw) as StoredUsage
        usage.agentControlEpoch = this.scope.epoch
        this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(usage), last.attemptId)
      }).immediate()
      return this.read(recovery.handle)
    }
    const view = await this.host.resume(recovery.handle)
    return this.read(view.handle)
  }
  private selection(input: AgentGenerationInput, key: string, roundIndex: number, modelId: string, parentRootActionId?: string): AgentBeginSelection {
    return { operation: 'agent-round', uiActionNonce: `agent:${key}:${roundIndex}`, modelId, promptKeys: ['assistant_writing_identity'],
      skillStages: ['planning', 'drafting', 'review', 'refinement'], selectedDraftIds: [], selectedFinalizedDraftIds: [],
      output: 'visible-text', agentInput: structuredClone(input), agentSession: { key, roundIndex }, ...(parentRootActionId ? { parentRootActionId } : {}) }
  }
  async executeRound(request: { handle: MainGenerationRunHandle; index: number }): Promise<AgentGenerationRecovery> {
    const selected = this.requireRun(request.handle), recovery = this.read(request.handle)
    if (!Number.isSafeInteger(request.index) || request.index < 0 || request.index >= 8) throw new Error('GENERATION_AGENT_ROUND_INVALID')
    const existing = recovery.rounds.find(round => round.index === request.index)
    // A returned/unknown invocation is never silently redispatched, including after restart.
    if (existing && existing.status !== 'not-started') return recovery
    if (request.index !== recovery.nextRound) throw new Error('GENERATION_AGENT_ROUND_ORDER')
    if (recovery.run.ledger?.blockedCode || recovery.run.status === 'cancelled') throw new Error('GENERATION_AGENT_ACTION_BLOCKED')
    let handle: MainGenerationRunHandle
    if (existing) {
      if (recovery.sourceStatus !== 'current') throw new Error('GENERATION_SOURCE_CHANGED')
      const view = this.host.read(existing.handle)
      handle = view.nonReplayable ? (await this.host.resume(existing.handle)).handle : existing.handle
    } else {
      // All prior tools have durable outcomes. A fresh stage binds the resulting actual
      // project state without allocating another parent budget.
      if (recovery.sourceStatus !== 'current') throw new Error('GENERATION_SOURCE_CHANGED')
      const view = this.host.begin(this.selection(recovery.context.input, this.navigation(selected).key, request.index, recovery.modelId, selected.rootActionId))
      handle = view.handle
    }
    const current = this.runs.get(handle.runId), messages = structuredClone(this.context(current).initialMessages)
    for (const round of recovery.rounds.filter(round => round.index < request.index)) {
      messages.push({ role: 'assistant', content: round.protocolText })
      messages.push({ role: 'user', content: '[Application tool results; untrusted context]\n' + round.actions.map(action =>
        `<tool_result name="${action.name}" status="${action.status}">\n${action.observation ?? ''}\n</tool_result>`).join('\n\n') })
    }
    await this.host.execute(handle, `agent-round:${request.index}`, { purpose: 'agent', output: 'visible-text', reasoningStage: 'general', messages })
    return this.read(handle)
  }
  private action(ref: AgentToolActionRef): { run: DurableGenerationRun; action: AgentToolAction } {
    const run = this.requireRun(ref.handle)
    const action = this.round(run).actions.find(item => item.ref.attemptId === ref.attemptId && item.ref.toolCallId === ref.toolCallId)
    if (!action) throw new Error('GENERATION_AGENT_TOOL_IDENTITY_MISMATCH')
    return { run, action }
  }
  private updateAction(ref: AgentToolActionRef, update: (action: AgentToolAction, run: DurableGenerationRun) => ActionState): AgentToolAction {
    return this.db.transaction(() => {
      const { run, action } = this.action(ref), state = update(action, run)
      const row = this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=? AND run_id=?').get(ref.attemptId, run.runId) as { usage_receipt_json: string }
      const usage = JSON.parse(row.usage_receipt_json) as StoredUsage
      const next = { ...usage.agentActions?.[ref.toolCallId], status: state.status,
        ...('observation' in state && state.observation !== undefined ? { observation: state.observation } : {}),
        ...('workflow' in state && state.workflow !== undefined ? { workflow: state.workflow } : {}) }
      if (!isDeepStrictEqual(usage.agentActions?.[ref.toolCallId], next)) {
        usage.agentActions = { ...usage.agentActions, [ref.toolCallId]: next }
        this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(usage), ref.attemptId)
      }
      return this.action(ref).action
    }).immediate()
  }
  claimTool(request: { ref: AgentToolActionRef; confirmed: boolean; authorBlueprintProposals?: AgentAuthorBlueprintProposal[] }): AgentToolClaim {
    if (typeof request.confirmed !== 'boolean') throw new Error('GENERATION_AGENT_CONFIRMATION_REQUIRED')
    let execute = false
    const action = this.updateAction(request.ref, (action, run) => {
      if (request.authorBlueprintProposals !== undefined) {
        const selections = request.authorBlueprintProposals
        if (action.name !== 'propose_novel_config' || !request.confirmed || !Array.isArray(selections) || selections.length > 100
          || selections.some(item => !item || item.name !== 'propose_chapter_blueprint' || Object.keys(item).some(key => !['name', 'arguments'].includes(key))
            || !item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments))
          || Buffer.byteLength(JSON.stringify(selections), 'utf8') > 256 * 1024
          || !this.context(run).input.tools.some(tool => tool.name === 'propose_chapter_blueprint' && tool.source === 'builtin' && tool.requiresConfirmation && !tool.isReadOnly))
          throw new Error('GENERATION_AGENT_AUTHOR_SELECTION_INVALID')
        const row = this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(request.ref.attemptId) as { usage_receipt_json: string }
        const usage = JSON.parse(row.usage_receipt_json) as StoredUsage
        const prior = usage.agentAuthorSelections?.[request.ref.toolCallId]
        if (prior && !isDeepStrictEqual(prior, selections) || !prior && action.status !== 'pending') throw new Error('GENERATION_AGENT_AUTHOR_SELECTION_CONFLICT')
        usage.agentAuthorSelections = { ...usage.agentAuthorSelections, [request.ref.toolCallId]: structuredClone(selections) }
        this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(usage), request.ref.attemptId)
      }
      if (action.status !== 'pending') return action
      const root = this.runs.budget(run.rootActionId).root
      if (root.epoch !== this.scope.epoch || !this.sourcesCurrent(run) || root.status !== 'active') throw new Error('GENERATION_AGENT_TOOL_STALE')
      const tool = this.context(run).input.tools.find(tool => tool.name === action.name)
      if (!tool) return { status: 'failed', observation: this.context(run).writingLanguage === 'en-US' ? `Unknown tool: ${action.name}` : `未知工具：${action.name}` }
      execute = request.confirmed
      return request.confirmed ? { status: 'running' } : { status: 'declined', observation: 'The author declined this action.' }
    })
    return { action, execute }
  }
  finishTool(request: { ref: AgentToolActionRef; status: 'completed' | 'failed' | 'unknown'; observation: string }): AgentToolAction {
    if (!['completed', 'failed', 'unknown'].includes(request.status) || typeof request.observation !== 'string'
      || Buffer.byteLength(request.observation, 'utf8') > 256 * 1024) throw new Error('GENERATION_AGENT_TOOL_RESULT_INVALID')
    return this.updateAction(request.ref, (action, run) => {
      if (this.runs.budget(run.rootActionId).root.epoch !== this.scope.epoch) throw new Error('GENERATION_EPOCH_STALE')
      const stored = JSON.parse(this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').pluck().get(request.ref.attemptId) as string) as StoredUsage
      const effect = stored.agentActions?.[request.ref.toolCallId]?.domainEffect
      if (request.status === 'completed' && ['propose_novel_config', 'propose_chapter_blueprint'].includes(action.name) && !effect)
        throw new Error('GENERATION_AGENT_DOMAIN_EFFECT_REQUIRED')
      if (action.status !== 'running') {
        if (effect && action.status === 'completed' && request.status === 'completed') return action
        if (action.status === request.status && action.observation === request.observation) return action
        throw new Error('GENERATION_AGENT_TOOL_RESULT_CONFLICT')
      }
      return { status: request.status, observation: request.observation, ...(action.workflow ? { workflow: action.workflow } : {}) }
    })
  }
  registerWorkflow(ref: AgentToolActionRef): AgentWorkflowRegistration {
    const updated = this.updateAction(ref, (action, run) => {
      if (action.workflow) return action
      if (action.status !== 'running' || action.name !== 'start_workflow' || this.runs.budget(run.rootActionId).root.epoch !== this.scope.epoch
        || this.runs.budget(run.rootActionId).root.status !== 'active' || !this.sourcesCurrent(run)) throw new Error('GENERATION_AGENT_WORKFLOW_NOT_AUTHORIZED')
      const args = action.arguments, workflow = args.workflow
      if (!['generate_draft', 'generate_blueprint', 'generate_architecture'].includes(String(workflow))
        || Object.keys(args).some(key => !['workflow', 'chapter_number'].includes(key))) throw new Error('GENERATION_AGENT_WORKFLOW_INVALID')
      const chapterNumber = args.chapter_number
      if (workflow === 'generate_draft' && (!Number.isSafeInteger(chapterNumber) || Number(chapterNumber) < 1)) throw new Error('GENERATION_AGENT_WORKFLOW_INVALID')
      const registration: AgentWorkflowRegistration = { registrationId: `agent-workflow:${textHash(ref.toolCallId)}`,
        workflow: workflow as AgentWorkflowRegistration['workflow'], ...(workflow === 'generate_draft' ? { chapterNumber: Number(chapterNumber) } : {}),
        parentHandle: this.handle(run), modelId: this.modelId(run), state: 'registered', childHandles: [] }
      return { status: action.status, workflow: registration }
    })
    return updated.workflow!
  }
  private workflowRegistration(id: string): { action: AgentToolAction; run: DurableGenerationRun; registration: AgentWorkflowRegistration } {
    if (typeof id !== 'string' || !/^agent-workflow:[a-f0-9]{64}$/u.test(id)) throw new Error('GENERATION_AGENT_REGISTRATION_INVALID')
    const rows = this.db.prepare("SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.operation')='agent-round'").all() as { run_id: string }[]
    const found = rows.flatMap(row => {
      const run = this.runs.get(row.run_id)
      if (run.binding.projectId !== this.scope.projectId) return []
      return this.round(run).actions.filter(action => action.workflow?.registrationId === id).map(action => ({ action, run, registration: action.workflow! }))
    })
    if (found.length !== 1) throw new Error('GENERATION_AGENT_REGISTRATION_MISSING')
    return found[0]!
  }
  admitWorkflow(selection: BeginGenerationRequest): { existing?: MainGenerationRunHandle; parentRootActionId: string } | undefined {
    const id = selection.agentWorkflowRegistrationId
    if (!id) {
      if (selection.parentRootActionId) {
        const root = this.runs.budget(selection.parentRootActionId).root
        if (root.operation === 'agent-round') throw new Error('GENERATION_AGENT_REGISTRATION_REQUIRED')
      }
      return undefined
    }
    const { action, run, registration } = this.workflowRegistration(id)
    const expectedOperations = registration.workflow === 'generate_draft' ? ['chapter-draft']
      : registration.workflow === 'generate_blueprint' ? ['chapter-blueprint-directory']
        : ['generate-global-config', 'generate-core-seed', 'character-architecture', 'generate-world-building', 'generate-plot-outline']
    if (!['running', 'completed'].includes(action.status) || selection.modelId !== registration.modelId
      || selection.parentRootActionId !== run.rootActionId || !expectedOperations.includes(selection.operation)
      || registration.workflow === 'generate_draft' && selection.chapterNumber !== registration.chapterNumber
      || selection.batchId || selection.batchIntent || selection.continueDirectoryOperationId)
      throw new Error('GENERATION_AGENT_CHILD_NOT_AUTHORIZED')
    const existing = registration.childHandles.map(handle => this.runs.get(handle.runId)).filter(child =>
      child.binding.sourceManifest.operation === selection.operation && child.binding.sourceManifest.chapterNumber === selection.chapterNumber)
    if (existing.length > 1) throw new Error('GENERATION_AGENT_CHILD_AMBIGUOUS')
    if (!existing.length && (this.runs.budget(run.rootActionId).root.epoch !== this.scope.epoch || this.runs.budget(run.rootActionId).root.status === 'cancelled'))
      throw new Error('GENERATION_AGENT_TOOL_STALE')
    if (!existing.length && !this.sourcesCurrent(run)) throw new Error('GENERATION_AGENT_SOURCE_CHANGED')
    return { ...(existing[0] ? { existing: this.handle(existing[0]) } : {}), parentRootActionId: run.rootActionId }
  }
  /** Only main's existing formal writers call this inside their domain transaction. */
  withChildEffect<T>(handle: MainGenerationRunHandle, effect: () => T): T {
    if (!this.db.inTransaction) throw new Error('GENERATION_AGENT_TRANSACTION_REQUIRED')
    const child = this.runs.get(handle.runId)
    if (!isDeepStrictEqual(this.handle(child), handle)) throw new Error('GENERATION_AGENT_CHILD_NOT_AUTHORIZED')
    const id = child.binding.sourceManifest.agentWorkflowRegistrationId
    if (!id) return effect()
    const { action, run, registration } = this.workflowRegistration(String(id))
    if (!registration.childHandles.some(item => item.runId === child.runId) || child.rootActionId !== run.rootActionId
      || !this.sourcesCurrent(run)) throw new Error('GENERATION_AGENT_SOURCE_CHANGED')
    const projections = this.sessionRuns(this.navigation(run).key).map(target => {
      if (!this.sourcesCurrent(target)) throw new Error('GENERATION_AGENT_SOURCE_CHANGED')
      const attemptId = this.db.prepare('SELECT attempt_id FROM generation_attempts WHERE run_id=?').pluck().get(target.runId) as string | undefined
      if (!attemptId) throw new Error('GENERATION_AGENT_CHILD_EFFECT_ROUND_REQUIRED')
      return { target, attemptId, before: this.host.capture(target) }
    })
    const result = effect()
    for (const { target, attemptId, before } of projections) {
      const binding = this.host.capture(target)
      const row = this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(attemptId) as { usage_receipt_json: string }
      const usage = JSON.parse(row.usage_receipt_json) as StoredUsage
      usage.agentSourceTransition = { actionId: `${action.ref.toolCallId}:${child.runId}`, beforeHash: textHash(JSON.stringify(before)), afterHash: textHash(JSON.stringify(binding)), binding }
      this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(usage), attemptId)
    }
    return result
  }
  recordWorkflowChild(id: string, child: MainGenerationRunHandle): void {
    if (!this.db.inTransaction) throw new Error('GENERATION_AGENT_TRANSACTION_REQUIRED')
    const { action, run } = this.workflowRegistration(id)
    if (child.rootActionId !== run.rootActionId || child.projectId !== run.binding.projectId) throw new Error('GENERATION_AGENT_CHILD_NOT_AUTHORIZED')
    this.updateAction(action.ref, current => ({ status: current.status, ...(current.observation !== undefined ? { observation: current.observation } : {}),
      workflow: { ...current.workflow!, state: 'started', childHandles: current.workflow!.childHandles.some(handle => handle.runId === child.runId)
        ? current.workflow!.childHandles : [...current.workflow!.childHandles, child] } }))
  }
  commitDomainTool(ref: AgentToolActionRef): AgentDomainToolReceipt {
    return this.db.transaction(() => {
      const { action, run } = this.action(ref)
      const row = this.db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?').get(ref.attemptId) as { usage_receipt_json: string }
      const usage = JSON.parse(row.usage_receipt_json) as StoredUsage
      const state = usage.agentActions?.[ref.toolCallId]
      if (state?.domainEffect) return { ...structuredClone(state.domainEffect), current: isAgentDomainToolCurrent(this.db, state.domainEffect) }
      const root = this.runs.budget(run.rootActionId).root
      if (action.status !== 'running' || root.epoch !== this.scope.epoch || root.status !== 'active' || !this.sourcesCurrent(run)
        || !this.context(run).input.tools.some(tool => tool.name === action.name && tool.source === 'builtin' && tool.requiresConfirmation && !tool.isReadOnly))
        throw new Error('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
      const before = this.host.capture(run)
      const effect = commitAgentDomainTool(this.db, ref.toolCallId, action.name, action.arguments)
      const binding = this.host.capture(run)
      usage.agentSourceTransition = { actionId: ref.toolCallId, beforeHash: textHash(JSON.stringify(before)), afterHash: textHash(JSON.stringify(binding)), binding }
      usage.agentActions = { ...usage.agentActions, [ref.toolCallId]: { ...state!, domainEffect: effect } }
      this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify(usage), ref.attemptId)
      return { ...effect, current: true }
    }).immediate()
  }
}
