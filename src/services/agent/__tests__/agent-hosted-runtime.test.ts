import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentGenerationClient } from '../agent-generation-client'
import { runAgentLoop, type AgentEngineCallbacks, type ToolConfirmationDecision } from '../agent-engine'
import { toolRegistry, type AgentTool, type ToolResult } from '../tool-registry'
import { AgentHostFixture } from './agent-generation.fixture'
import { proposeNovelConfigTool } from '../tools/propose-novel-config.tool'
import { proposeChapterBlueprintTool } from '../tools/propose-chapter-blueprint.tool'
import { startWorkflowTool } from '../tools/start-workflow.tool'
import { useProjectStore } from '../../../stores/project-store'

const session = { projectId: 'hosted-project', leaseId: 'hosted-lease', projectPath: 'C:/synthetic/hosted-agent' }
const project = { id: session.projectId, sessionLease: session.leaseId, path: session.projectPath, name: 'Synthetic',
  characterStates: '', createdAt: '', updatedAt: '', novelConfig: { writingLanguage: 'en-US' as const, genre: '', subGenre: '',
    targetAudience: '', totalChapters: 10, wordsPerChapter: 3000, plotStructure: 'three_act' as const, narrativePOV: 'third_limited' as const,
    coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '' } }
const toolText = (name = 'hosted_probe', args: Record<string, unknown> = {}) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`
let fixture: AgentHostFixture
let registered: AgentTool[]
const ipcCalls = (channel: string) => fixture.invoke.mock.calls.filter(call => call[0] === channel)
function register(tool: AgentTool) { toolRegistry.register(tool); registered.push(tool); return tool }
function probe(options: Partial<AgentTool> = {}) {
  return register({ name: 'hosted_probe', description: 'Synthetic probe', source: 'builtin', inputSchema: { type: 'object', properties: {} },
    requiresConfirmation: true, isReadOnly: false, execute: vi.fn(async () => ({ success: true, content: 'result' })), ...options })
}
function callbacks() {
  return { onTextChunk: vi.fn(), onToolCallStart: vi.fn(), onToolCallComplete: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
    onToolCallConfirmRequired: vi.fn<AgentEngineCallbacks['onToolCallConfirmRequired']>(async () => true) }
}
async function client() {
  const host = new AgentGenerationClient(session)
  await host.begin({ uiActionNonce: 'synthetic-user-action', modelId: 'frozen-model', input: { mode: 'planning', uiLocale: 'en-US',
    historyMessages: [], userMessage: 'Synthetic request', tools: registered.map(tool => ({ name: tool.name, description: tool.description,
      inputSchema: { ...structuredClone(tool.inputSchema) }, source: tool.source, requiresConfirmation: tool.requiresConfirmation, isReadOnly: tool.isReadOnly })) } })
  return host
}
function run(host: AgentGenerationClient, ui = callbacks(), signal?: AbortSignal) {
  let index = 0
  const generated = vi.fn(async () => host.round(index++))
  const promise = runAgentLoop('renderer instructions are ignored', [], 'renderer history is ignored', 'renderer-model', generated, ui, signal,
    { projectSession: session, selectedModelId: 'frozen-model', writingLanguage: 'en-US', uiLocale: 'en-US', agentGeneration: host })
  return { promise, ui, generated }
}

describe('Agent hosted consumer control boundary (synthetic transport)', () => {
  beforeEach(() => {
    registered = []
    useProjectStore.setState({ currentProject: structuredClone(project) })
    fixture = new AgentHostFixture(session).install()
    fixture.writingLanguage = 'en-US'
    fixture.response = async index => index === 0 ? toolText() : 'Done.'
  })
  afterEach(() => {
    for (const tool of registered) toolRegistry.unregister(tool.name)
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
    useProjectStore.setState({ currentProject: null })
  })

  it('uses only main action identity, frozen model, and handle/index round requests', async () => {
    const tool = probe()
    fixture.response = async index => index === 0 ? 'Visible.' + toolText('hosted_probe', { rootActionId: 'forged-root' }) : 'Done.'
    const host = await client(), result = run(host)
    await result.promise
    const action = fixture.recovery.rounds[0].actions[0]
    expect(tool.execute).toHaveBeenCalledWith({ rootActionId: 'forged-root' }, expect.objectContaining({ agentToolAction: action.ref, selectedModelId: 'frozen-model' }))
    expect(result.ui.onToolCallStart).toHaveBeenCalledWith(expect.objectContaining({ id: action.ref.toolCallId }))
    expect(ipcCalls('agent-generation:claim-tool')[0][1]).toEqual({ ref: action.ref, confirmed: true })
    expect(ipcCalls('agent-generation:round').map(call => Object.keys(call[1] as object).sort())).toEqual([['handle', 'index'], ['handle', 'index']])
    expect(result.ui.onDone).toHaveBeenCalledWith('Visible.Done.', expect.any(Array), [])
  })

  it.each(['completed', 'running', 'unknown'] as const)('never executes a claim replay returned as %s', async status => {
    const tool = probe()
    fixture.claimOverride = action => ({ action: { ...action, status, observation: 'prior receipt' }, execute: false })
    const result = run(await client()); await result.promise
    expect(tool.execute).not.toHaveBeenCalled()
    expect(ipcCalls('agent-generation:finish-tool')).toHaveLength(0)
    expect(result.ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: status === 'completed' ? 'completed' : 'result_unknown' }))
    expect(ipcCalls('agent-generation:round')).toHaveLength(status === 'completed' ? 2 : 1)
  })

  it('persists a declined action without crossing the tool boundary', async () => {
    const tool = probe(), ui = callbacks()
    ui.onToolCallConfirmRequired.mockResolvedValue(false)
    await run(await client(), ui).promise
    expect(tool.execute).not.toHaveBeenCalled()
    expect(fixture.recovery.rounds[0].actions[0].status).toBe('declined')
    expect(ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ error: 'The user declined this action', commitState: 'not_committed' }))
  })

  it('replays a lost finish ACK without executing the write or requesting its model round again', async () => {
    const tool = probe({ execute: vi.fn(async (_args, context) => { context?.markSideEffectStarted?.(); return { success: true, content: 'stored' } }) })
    fixture.loseFinishAck = true
    const host = await client(), first = run(host); await first.promise
    expect(first.ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'result_unknown' }))
    expect(tool.execute).toHaveBeenCalledOnce()
    host.close()
    const reopened = new AgentGenerationClient(session)
    await reopened.read(fixture.recovery.handle)
    const replay = run(reopened); await replay.promise
    expect(tool.execute).toHaveBeenCalledOnce()
    expect(ipcCalls('agent-generation:finish-tool')).toHaveLength(1)
    expect(ipcCalls('agent-generation:round').map(call => (call[1] as { index: number }).index)).toEqual([0, 1])
    expect(replay.ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', result: 'stored' }))
  })

  it('stops on an unsaved finish receipt and leaves the running action non-replayable', async () => {
    const tool = probe(); fixture.finishFailures = 1
    const host = await client(); await run(host).promise
    expect(fixture.recovery.rounds[0].actions[0].status).toBe('running')
    await host.read()
    await run(host).promise
    expect(tool.execute).toHaveBeenCalledOnce()
    expect(ipcCalls('agent-generation:finish-tool')).toHaveLength(1)
    expect(ipcCalls('agent-generation:round')).toHaveLength(1)
  })

  it('does not retry the finish receipt for an unknown tool', async () => {
    fixture.response = async () => toolText('not_registered')
    fixture.finishFailures = 1
    const result = run(await client()); await result.promise
    expect(ipcCalls('agent-generation:finish-tool')).toHaveLength(1)
    expect(result.ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'result_unknown' }))
  })

  it.each(['incomplete', 'unknown'] as const)('does not execute control metadata from a %s generation', async status => {
    const tool = probe(); fixture.response = async () => ({ status, text: '' })
    const result = run(await client()); await result.promise
    expect(tool.execute).not.toHaveBeenCalled()
    expect(ipcCalls('agent-generation:claim-tool')).toHaveLength(0)
    expect(result.ui.onError).toHaveBeenCalledOnce()
  })

  it('retains visible output and navigation after a later source conflict', async () => {
    probe()
    fixture.response = async index => { if (index) throw new Error('GENERATION_SOURCE_CHANGED'); return 'Keep this candidate.' + toolText() }
    const host = await client(), result = run(host); await result.promise
    expect(result.ui.onDone).toHaveBeenCalledWith(expect.stringContaining('Keep this candidate.'), expect.any(Array), [])
    expect(result.ui.onDone.mock.calls[0][0]).toContain('original candidate was retained')
    expect(host.recovery.handle.rootActionId).toBe('agent-root')
    expect(result.ui.onError).not.toHaveBeenCalled()
    expect(ipcCalls('generation:cancel')).toHaveLength(0)
  })

  it.each(['incomplete', 'unknown'] as const)('retains only main-projected visible text from a %s round without executing its controls', async status => {
    const tool = probe(); fixture.response = async () => ({ status, text: 'Main-projected candidate.' })
    const result = run(await client()); await result.promise
    expect(result.ui.onDone).toHaveBeenCalledWith(expect.stringContaining('Main-projected candidate.'), [], [])
    expect(tool.execute).not.toHaveBeenCalled()
    expect(ipcCalls('agent-generation:claim-tool')).toHaveLength(0)
    expect(result.ui.onError).not.toHaveBeenCalled()
  })

  it('rejects a changed live tool registry before confirmation or execution', async () => {
    const tool = probe(), host = await client()
    tool.isReadOnly = true
    const result = run(host); await result.promise
    expect(tool.execute).not.toHaveBeenCalled()
    expect(result.ui.onToolCallConfirmRequired).not.toHaveBeenCalled()
    expect(ipcCalls('agent-generation:claim-tool')).toHaveLength(0)
  })

  it.each([false, true])('distinguishes a write timeout with sideEffectStarted=%s', async committed => {
    vi.useFakeTimers()
    const tool = probe({ execute: vi.fn(async (_args, context) => {
      if (committed) context?.markSideEffectStarted?.()
      return new Promise<ToolResult>(() => {})
    }) })
    const host = await client(), result = run(host)
    await vi.advanceTimersByTimeAsync(30_000); await result.promise
    expect(tool.execute).toHaveBeenCalledOnce()
    expect(result.ui.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({ status: committed ? 'result_unknown' : 'failed', commitState: committed ? 'unknown' : 'not_committed' }))
    expect(ipcCalls('agent-generation:finish-tool')[0][1]).toMatchObject({ status: committed ? 'unknown' : 'failed' })
    expect(ipcCalls('agent-generation:round')).toHaveLength(committed ? 1 : 2)
  })

  it('reuses original round indices and stops at the eighth round across recovery', async () => {
    const tool = probe({ requiresConfirmation: false, isReadOnly: true })
    fixture.response = async () => toolText()
    const host = await client(); await run(host).promise
    expect(tool.execute).toHaveBeenCalledTimes(8)
    await host.read(); const replay = run(host); await replay.promise
    expect(tool.execute).toHaveBeenCalledTimes(8)
    expect(ipcCalls('agent-generation:round').map(call => (call[1] as { index: number }).index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(replay.ui.onDone.mock.calls[0][0]).toContain('maximum number')
  })

  it('detaches without cancelling the shared root and rejects additional execution', async () => {
    probe(); const host = await client(); host.close()
    await expect(host.round(0)).rejects.toThrow('DETACHED')
    expect(ipcCalls('generation:cancel')).toHaveLength(0)
  })

  it('cancels the original root and never claims an action after author confirmation resolves late', async () => {
    const tool = probe(), controller = new AbortController(), ui = callbacks()
    let resolve!: (decision: boolean) => void
    ui.onToolCallConfirmRequired.mockImplementation(() => new Promise(done => { resolve = done }))
    const host = await client(), result = run(host, ui, controller.signal)
    await vi.waitFor(() => expect(ui.onToolCallConfirmRequired).toHaveBeenCalledOnce())
    controller.abort(); await host.cancel(); resolve(true); await result.promise
    expect(tool.execute).not.toHaveBeenCalled()
    expect(ipcCalls('agent-generation:claim-tool')).toHaveLength(0)
    expect(ipcCalls('generation:cancel')[0][1]).toEqual(host.recovery.handle)
  })

  it('restores only proved workflow navigation and does not label the child as currently running', async () => {
    probe(); const host = await client(); await host.round(0)
    const action = fixture.recovery.rounds[0].actions[0]
    action.status = 'completed'
    action.workflow = { registrationId: 'original-registration', workflow: 'generate_draft', chapterNumber: 1,
      parentHandle: action.ref.handle, modelId: 'frozen-model', state: 'started', childHandles: [{ ...action.ref.handle, runId: 'child-run' }] }
    await host.read(); const result = run(host); await result.promise
    expect(result.ui.onDone.mock.calls[0][2]).toEqual([expect.objectContaining({ type: 'workflow_started', runId: 'original-registration', status: 'waiting', projectSession: session })])
    expect(ipcCalls('agent-generation:claim-tool')).toHaveLength(0)
  })

  it('requires a host-issued workflow action even when model arguments contain a forged ref', async () => {
    const result = await startWorkflowTool.execute({ workflow: 'generate_draft', chapter_number: 1, agentToolAction: { toolCallId: 'forged' } },
      { projectSession: session, writingLanguage: 'en-US', uiLocale: 'en-US', selectedModelId: 'model' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('main-issued tool action is missing')
    expect(fixture.invoke).not.toHaveBeenCalled()
  })

  it('executes author-selected blueprint changes only after the main domain commit and separate confirmation', async () => {
    register(proposeNovelConfigTool); register(proposeChapterBlueprintTool)
    const originalInvoke = fixture.invoke.getMockImplementation()!
    fixture.invoke.mockImplementation(async (channel, ...args) => channel === 'db:blueprint-get'
      ? { chapterNumber: 2, title: 'Old', characters: [], role: '', purpose: '', keyEvents: '', suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '' }
      : originalInvoke(channel, ...args))
    fixture.response = async index => index === 0 ? toolText('propose_novel_config', { changes: { genre: 'Fantasy' } }) : 'Done.'
    const ui = callbacks()
    const decision: ToolConfirmationDecision = { confirmed: true, blueprintProposals: [{ name: 'propose_chapter_blueprint', arguments: { chapter_number: 2, changes: { title: 'Author choice' } } }] }
    ui.onToolCallConfirmRequired.mockResolvedValueOnce(decision).mockResolvedValueOnce(true)
    await run(await client(), ui).promise
    expect(ui.onToolCallConfirmRequired).toHaveBeenCalledTimes(2)
    expect(ipcCalls('agent-generation:commit-domain-tool')).toHaveLength(2)
    expect(fixture.domainEffects.size).toBe(2)
    expect(ipcCalls('project:update-config')).toHaveLength(0)
    expect(ipcCalls('db:blueprint-upsert')).toHaveLength(0)
    const [config, blueprint] = fixture.recovery.rounds[0].actions
    expect(blueprint.ref).toMatchObject({ handle: config.ref.handle, attemptId: config.ref.attemptId, toolCallId: `${config.ref.toolCallId}-author-0` })
    expect(blueprint.status).toBe('completed')
    expect(useProjectStore.getState().currentProject?.novelConfig.genre).toBe('Fantasy')
  })

  it.each([true, false])('never fabricates author actions from finish success=%s without a domain effect', async success => {
    probe({ name: 'propose_novel_config', execute: vi.fn(async () => ({ success, content: 'transport only' })) })
    fixture.response = async index => index === 0 ? toolText('propose_novel_config') : 'Done.'
    const ui = callbacks()
    ui.onToolCallConfirmRequired.mockResolvedValue({ confirmed: true, blueprintProposals: [{ name: 'propose_chapter_blueprint', arguments: { chapter_number: 2 } }] })
    await run(await client(), ui).promise
    expect(ui.onToolCallConfirmRequired).toHaveBeenCalledOnce()
    expect(fixture.recovery.rounds[0].actions).toHaveLength(1)
    expect(fixture.domainEffects.size).toBe(0)
  })
})
