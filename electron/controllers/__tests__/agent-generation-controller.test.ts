import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentGenerationChannels, AgentGenerationInput, AgentToolActionRef } from '../../../src/shared/agent-generation'
import type { CharacterProposalChannels } from '../../../src/shared/character-proposal'
import type { GenerationOwnerChannels, BeginGenerationRequest } from '../../../src/shared/generation-owner-contract'
import type { ModelProfile, ProjectSessionContext } from '../../../src/shared/ipc-channels'
import { ipc } from '../../../src/services/ipc-client'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), globalRoot: '' }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }))
vi.mock('../../services/app-data-locator', () => ({ getGlobalDataRoot: () => mocks.globalRoot }))
vi.mock('../kb-controller', () => ({ getEmbeddingConfig: () => null }))
import { registerGenerationController } from '../generation-controller'
import { registerDatabaseController } from '../db-controller'
import { ModelExecutionLeaseRegistry } from '../../services/model-execution-lease'
import { projectAccess } from '../../services/project-access'
import { createProjectDatabase, initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../database'

const base = path.join(os.tmpdir(), 'an-agent-ipc-')
const model: ModelProfile = { id: 'synthetic-ipc', name: 'Synthetic IPC', provider: 'openai', protocol: 'openai', modelName: 'gpt-4.1',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-only', maxTokens: 2048, temperature: 0.7, purposes: ['generation'] }
const sender = { isDestroyed: () => false, send: vi.fn() }
let root: string, session: ProjectSessionContext
const input: AgentGenerationInput = { mode: 'planning', uiLocale: 'en-US', historyMessages: [], userMessage: 'Synthetic Agent task',
  tools: ['read_project_state', 'start_workflow', 'propose_novel_config', 'propose_chapter_blueprint'].map(name => ({ name,
    description: 'Synthetic frozen tool', inputSchema: { type: 'object' }, requiresConfirmation: true, isReadOnly: false, source: 'builtin' })) }
type Channels = AgentGenerationChannels & GenerationOwnerChannels & CharacterProposalChannels
function invoke<C extends keyof Channels>(channel: C, ...args: Channels[C]['args']) {
  return mocks.handlers.get(channel)!({ sender }, ...args, { ...session }) as Promise<Channels[C]['return']>
}
function begin(nonce = 'explicit-author-action') {
  return ipc.invokeWithProjectSession(session, 'agent-generation:begin', { uiActionNonce: nonce, modelId: model.id, input })
}
const toolText = (name: string, args: Record<string, unknown> = {}) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`
function stream(...responses: string[]) {
  const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
    const content = responses.shift() ?? 'Synthetic final reply.'
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
    controller.close()
  } }) }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
async function action(name: string, args: Record<string, unknown>) {
  const fetch = stream('Visible candidate.' + toolText(name, args)), started = await begin()
  const recovery = await invoke('agent-generation:round', { handle: started.handle, index: 0 })
  return { fetch, started, recovery, ref: recovery.rounds[0].actions[0].ref }
}
async function workflow() {
  const f = await action('start_workflow', { workflow: 'generate_architecture' })
  await invoke('agent-generation:claim-tool', { ref: f.ref, confirmed: true })
  const registration = await invoke('agent-generation:register-workflow', { ref: f.ref })
  const selection: BeginGenerationRequest = { operation: 'generate-core-seed', uiActionNonce: 'child-stage', modelId: model.id,
    promptKeys: ['premise'], skillStages: ['planning'], selectedDraftIds: [], selectedFinalizedDraftIds: [], output: 'visible-text',
    parentRootActionId: f.recovery.handle.rootActionId, agentWorkflowRegistrationId: registration.registrationId }
  return { ...f, registration, selection }
}

beforeAll(() => {
  registerGenerationController({ modelExecutionLeases: new ModelExecutionLeaseRegistry({ loadModel: () => model }), loadModel: () => model, applyProxyConfig: () => {} })
  registerDatabaseController()
})
beforeEach(() => {
  root = fs.mkdtempSync(base)
  mocks.globalRoot = path.join(root, 'global'); fs.mkdirSync(mocks.globalRoot)
  const project = projectAccess.createProject(root, '合成')
  createProjectDatabase(project.rootPath); initProjectDatabase(project.rootPath)
  getProjectDb()!.exec("INSERT INTO project_core(id,project_name,genre,global_guidance) VALUES('main','Synthetic Agent IPC','Original genre','Author guidance'); INSERT INTO blueprints(chapter_number,title) VALUES(1,'Original plan')")
  const lease = projectAccess.beginSession(project)
  session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
  vi.stubGlobal('window', { aiNovelAPI: { invoke: (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender }, ...args) } })
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No unstubbed network access is permitted') }))
  sender.send.mockClear()
})
afterEach(() => {
  closeProjectDatabase(); projectAccess.invalidateCurrentSession(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  if (!path.resolve(root).startsWith(path.resolve(base))) throw new Error('Synthetic cleanup outside owned temp root')
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Agent registered IPC, actual SQLite and intercepted provider boundary', () => {
  it('commits only claimed actual domain arguments and separately confirmed author actions through registered IPC', async () => {
    const f = await action('propose_novel_config', { changes: { genre: 'Confirmed genre' } })
    expect(f.recovery.rounds[0].visibleText).toBe('Visible candidate.')
    expect(f.recovery.run.artifacts[0].text).toBe('Visible candidate.')
    await expect(invoke('agent-generation:commit-domain-tool', { ref: f.ref })).rejects.toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
    const proposals = [{ name: 'propose_chapter_blueprint' as const, arguments: { chapter_number: 1, changes: { title: 'Author plan' } } }]
    const claims = await Promise.all([invoke('agent-generation:claim-tool', { ref: f.ref, confirmed: true, authorBlueprintProposals: proposals }),
      invoke('agent-generation:claim-tool', { ref: f.ref, confirmed: true, authorBlueprintProposals: proposals })])
    expect(claims.map(claim => claim.execute).sort()).toEqual([false, true])
    await expect(invoke('agent-generation:finish-tool', { ref: f.ref, status: 'completed', observation: 'Forged completion' })).rejects.toThrow('GENERATION_AGENT_DOMAIN_EFFECT_REQUIRED')
    const receipt = await invoke('agent-generation:commit-domain-tool', { ref: f.ref })
    expect(receipt.changes).toEqual({ genre: 'Confirmed genre' })
    expect(getProjectDb()!.prepare('SELECT genre FROM project_core').pluck().get()).toBe('Confirmed genre')
    await invoke('agent-generation:finish-tool', { ref: f.ref, status: 'completed', observation: 'Actual domain receipt' })
    const child = (await invoke('agent-generation:read', { handle: f.recovery.handle })).rounds[0].actions[1]
    await expect(invoke('agent-generation:commit-domain-tool', { ref: child.ref })).rejects.toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
    await invoke('agent-generation:claim-tool', { ref: child.ref, confirmed: true })
    await invoke('agent-generation:commit-domain-tool', { ref: child.ref })
    await invoke('agent-generation:finish-tool', { ref: child.ref, status: 'completed', observation: 'Actual blueprint receipt' })
    const final = await invoke('agent-generation:round', { handle: f.recovery.handle, index: 1 })
    expect(final.handle.rootActionId).toBe(f.recovery.handle.rootActionId)
    expect(final.run.ledger?.physicalRequests).toBe(2)
    expect(final.sourceStatus).toBe('current')
    expect(getProjectDb()!.prepare('SELECT title FROM blueprints').pluck().get()).toBe('Author plan')
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps domain data and transition atomic when storing the action effect fails', async () => {
    const f = await action('propose_novel_config', { changes: { genre: 'Candidate' } })
    await invoke('agent-generation:claim-tool', { ref: f.ref, confirmed: true })
    const db = getProjectDb()!, before = db.prepare('SELECT * FROM project_core').all(), usage = db.prepare('SELECT usage_receipt_json FROM generation_attempts').all()
    db.exec("CREATE TRIGGER synthetic_ipc_effect_failure BEFORE UPDATE OF usage_receipt_json ON generation_attempts BEGIN SELECT RAISE(ABORT,'Synthetic effect storage failure'); END")
    await expect(invoke('agent-generation:commit-domain-tool', { ref: f.ref })).rejects.toThrow('GENERATION_REQUEST_FAILED')
    expect(db.prepare('SELECT * FROM project_core').all()).toEqual(before)
    expect(db.prepare('SELECT usage_receipt_json FROM generation_attempts').all()).toEqual(usage)
    db.exec('DROP TRIGGER synthetic_ipc_effect_failure')
    const receipt = await invoke('agent-generation:commit-domain-tool', { ref: f.ref })
    db.exec("CREATE TRIGGER reject_replayed_ipc_write BEFORE UPDATE ON project_core BEGIN SELECT RAISE(ABORT,'Repeated write'); END")
    await expect(invoke('agent-generation:commit-domain-tool', { ref: f.ref })).resolves.toEqual(receipt)
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects source changes between the actual claim and formal commit and preserves the candidate', async () => {
    const f = await action('propose_novel_config', { changes: { genre: 'Candidate' } })
    await invoke('agent-generation:claim-tool', { ref: f.ref, confirmed: true })
    getProjectDb()!.exec("UPDATE project_core SET genre='External author edit'")
    await expect(invoke('agent-generation:commit-domain-tool', { ref: f.ref })).rejects.toThrow('GENERATION_AGENT_DOMAIN_TOOL_NOT_AUTHORIZED')
    const read = await invoke('agent-generation:read', { handle: f.recovery.handle })
    expect(read.sourceStatus).toBe('conflict')
    expect(read.rounds[0].visibleText).toBe('Visible candidate.')
    expect(getProjectDb()!.prepare('SELECT genre FROM project_core').pluck().get()).toBe('External author edit')
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it.each(['rootActionId', 'epoch', 'projectId', 'toolCallId', 'attemptId'] as const)('rejects a forged %s through the actual registered handler', async field => {
    const f = await action('propose_novel_config', { changes: { genre: 'Candidate' } })
    const ref: AgentToolActionRef = structuredClone(f.ref)
    if (field === 'toolCallId' || field === 'attemptId') ref[field] = 'forged'
    else ref.handle[field] = 'forged'
    await expect(invoke('agent-generation:claim-tool', { ref, confirmed: true })).rejects.toThrow(/GENERATION_AGENT_(IDENTITY|TOOL_IDENTITY)_MISMATCH/)
    expect(getProjectDb()!.prepare('SELECT genre FROM project_core').pluck().get()).toBe('Original genre')
  })

  it('rejects a stale outer session while allowing explicit main-controlled recovery of the original pending action', async () => {
    const f = await action('propose_novel_config', { changes: { genre: 'Candidate' } }), old = { ...session }
    closeProjectDatabase(); projectAccess.invalidateCurrentSession(); initProjectDatabase(old.projectPath)
    const project = projectAccess.probeExistingProject(old.projectPath)
    if (project.kind !== 'manifest') throw new Error('Synthetic manifest missing')
    const lease = projectAccess.beginSession(project)
    session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
    await expect(mocks.handlers.get('agent-generation:read')!({ sender }, { handle: f.recovery.handle }, old)).rejects.toThrow()
    await expect(invoke('agent-generation:claim-tool', { ref: f.ref, confirmed: true })).rejects.toThrow('GENERATION_AGENT_TOOL_STALE')
    await invoke('agent-generation:resume', { handle: f.recovery.handle })
    await expect(invoke('agent-generation:claim-tool', { ref: f.ref, confirmed: true })).resolves.toMatchObject({ execute: true })
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('registers one child under concurrent replay and charges its dispatch to the original root', async () => {
    const f = await workflow()
    const registrations = await Promise.all([invoke('agent-generation:register-workflow', { ref: f.ref }), invoke('agent-generation:register-workflow', { ref: f.ref })])
    expect(registrations).toEqual([f.registration, f.registration])
    await expect(invoke('generation:begin', { ...f.selection, parentRootActionId: 'forged' })).rejects.toThrow('GENERATION_AGENT_CHILD_NOT_AUTHORIZED')
    const [left, right] = await Promise.all([invoke('generation:begin', f.selection), invoke('generation:begin', { ...f.selection, uiActionNonce: 'second-launch' })])
    expect(left.handle).toEqual(right.handle)
    const result = await invoke('generation:execute', { handle: left.handle, invocationNonce: 'child-request', task: { purpose: 'generate-core-seed', output: 'visible-text', messages: [{ role: 'user', content: 'Synthetic child' }] } })
    expect(result.run.ledger?.physicalRequests).toBe(2)
    expect(result.run.handle.rootActionId).toBe(f.recovery.handle.rootActionId)
    const read = await invoke('agent-generation:read', { handle: f.recovery.handle })
    expect(read.rounds[0].actions[0].workflow?.childHandles).toEqual([left.handle])
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps an admitted child source change fail-closed before its dispatch', async () => {
    const f = await workflow(), child = await invoke('generation:begin', f.selection)
    getProjectDb()!.exec("UPDATE project_core SET global_guidance='Author changed guidance'")
    await expect(invoke('generation:execute', { handle: child.handle, invocationNonce: 'child-request', task: { purpose: 'generate-core-seed', output: 'visible-text', messages: [{ role: 'user', content: 'Synthetic child' }] } })).rejects.toThrow('GENERATION_SOURCE_CHANGED')
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('keeps a proved child write current after the Agent has already returned its next round', async () => {
    const f = await workflow(), child = await invoke('generation:begin', f.selection)
    await invoke('generation:execute', { handle: child.handle, invocationNonce: 'child-request', task: { purpose: 'generate-core-seed', output: 'visible-text', messages: [{ role: 'user', content: 'Synthetic child' }] } })
    await invoke('agent-generation:finish-tool', { ref: f.ref, status: 'completed', observation: 'Child launched' })
    const next = await invoke('agent-generation:round', { handle: f.recovery.handle, index: 1 })
    expect(next.sourceStatus).toBe('current')
    const saved = await mocks.handlers.get('db:project-core-commit-generated')!({ sender }, { generationRunHandle: child.handle, data: { premise: 'Proved child premise' } }, session.projectPath, session)
    expect(saved).toEqual({ success: true })
    const read = await invoke('agent-generation:read', { handle: next.handle })
    expect(read.sourceStatus).toBe('current')
    expect(read.rounds.at(-1)?.visibleText).toBe('Synthetic final reply.')
    expect(f.fetch).toHaveBeenCalledTimes(3)
    getProjectDb()!.exec("UPDATE project_core SET premise='Unrelated external edit after the child commit'")
    expect((await invoke('agent-generation:read', { handle: next.handle })).sourceStatus).toBe('conflict')
  })

  it('does not duplicate a dispatch when the same round is concurrently requested', async () => {
    let release!: () => void, entered!: () => void
    const dispatched = new Promise<void>(resolve => { entered = resolve })
    const fetch = vi.fn(async () => ({ ok: true, body: new ReadableStream({ start(controller) {
      release = () => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'One reply.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
        controller.close()
      }
      entered()
    } }) }))
    vi.stubGlobal('fetch', fetch)
    const started = await begin(), first = invoke('agent-generation:round', { handle: started.handle, index: 0 })
    await dispatched
    const replay = await invoke('agent-generation:round', { handle: started.handle, index: 0 })
    expect(replay.rounds[0].actions).toEqual([])
    release(); const completed = await first
    expect(completed.rounds[0].visibleText).toBe('One reply.')
    expect(fetch).toHaveBeenCalledOnce()
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM generation_attempts').pluck().get()).toBe(1)
  })

  it('does not reauthorize a cancelled root or allow its child to commit', async () => {
    const f = await workflow(), child = await invoke('generation:begin', f.selection)
    await invoke('generation:execute', { handle: child.handle, invocationNonce: 'child-request', task: { purpose: 'generate-core-seed', output: 'visible-text', messages: [{ role: 'user', content: 'Synthetic child' }] } })
    await invoke('generation:cancel', f.recovery.handle)
    await expect(invoke('agent-generation:resume', { handle: f.recovery.handle })).rejects.toThrow()
    const before = getProjectDb()!.prepare('SELECT premise FROM project_core').pluck().get()
    const saved = await mocks.handlers.get('db:project-core-commit-generated')!({ sender }, { generationRunHandle: child.handle, data: { premise: 'Cancelled child write' } }, session.projectPath, session)
    expect(saved).toMatchObject({ success: false })
    expect(getProjectDb()!.prepare('SELECT premise FROM project_core').pluck().get()).toBe(before)
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })

  it('retains the safe visible prefix when the provider puts a hidden think block in the same event', async () => {
    const fetch = stream('Safe visible prefix.<think>Hidden model reasoning')
    const started = await begin(), result = await invoke('agent-generation:round', { handle: started.handle, index: 0 })
    expect(result.rounds[0].visibleText).toBe('Safe visible prefix.')
    expect(result.rounds[0].actions).toEqual([])
    expect(result.run.artifacts.map(artifact => artifact.text).join('')).not.toContain('Hidden model reasoning')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(['later-binding-corrupt', 'second-proof-update-fails'] as const)('rejects the whole child effect when %s', async fault => {
    const f = await workflow(), child = await invoke('generation:begin', f.selection)
    await invoke('generation:execute', { handle: child.handle, invocationNonce: 'child-request', task: { purpose: 'generate-core-seed', output: 'visible-text', messages: [{ role: 'user', content: 'Synthetic child' }] } })
    await invoke('agent-generation:finish-tool', { ref: f.ref, status: 'completed', observation: 'Child launched' })
    const next = await invoke('agent-generation:round', { handle: f.recovery.handle, index: 1 }), db = getProjectDb()!
    // A corruption probe targets only the later persisted binding. It does not
    // claim this is a normal author edit or change the earlier child source.
    if (fault === 'later-binding-corrupt') db.prepare("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.fingerprint.contextSnapshotHash','corrupt-later-source') WHERE run_id=?").run(next.handle.runId)
    else db.exec("CREATE TRIGGER second_agent_proof_failure BEFORE UPDATE OF usage_receipt_json ON generation_attempts WHEN NEW.run_id IN (SELECT run_id FROM generation_runs WHERE json_extract(binding_json,'$.sourceManifest.agentSession.roundIndex')=1) BEGIN SELECT RAISE(ABORT,'Synthetic second proof update failure'); END")
    const dataBefore = db.prepare('SELECT * FROM project_core').all(), usageBefore = db.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()
    const bindingsBefore = db.prepare('SELECT run_id,binding_json FROM generation_runs ORDER BY rowid').all()
    const saved = await mocks.handlers.get('db:project-core-commit-generated')!({ sender }, { generationRunHandle: child.handle, data: { premise: 'Must be atomic with both forward proofs' } }, session.projectPath, session)
    expect(saved).toMatchObject({ success: false })
    expect(db.prepare('SELECT * FROM project_core').all()).toEqual(dataBefore)
    expect(db.prepare('SELECT attempt_id,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()).toEqual(usageBefore)
    expect(db.prepare('SELECT run_id,binding_json FROM generation_runs ORDER BY rowid').all()).toEqual(bindingsBefore)
    expect(f.fetch).toHaveBeenCalledTimes(3)
  })

  it('continues an Agent architecture workflow after explicit adoption of its proved generated characters', async () => {
    const f = await workflow()
    const child = await invoke('generation:begin', { ...f.selection, operation: 'character-architecture', promptKeys: ['character_dynamics'], output: 'structured-data' })
    const slots = ['Mara', 'Ivo', 'Sena'].map((name, index) => ({ slotId: `slot-${index}`, name,
      role: index === 0 ? 'protagonist' : 'supporting', narrativeDuty: 'Advance the conflict', relations: [] }))
    const entries = slots.map(slot => ({ slotId: slot.slotId, name: slot.name, role: slot.role, gender: 'Unknown', age: '25',
      appearance: 'Cloak', personality: 'Careful', background: 'Harbor', abilities: 'Navigation', motivation: 'Return', arc: 'Trust', notes: 'Synthetic',
      currentState: { location: 'Harbor', powerLevel: 'Ordinary', physicalState: 'Healthy', mentalState: 'Alert', keyItems: 'Map', recentEvents: 'Arrival', updatedAtChapter: 0 } }))
    const fetch = stream(JSON.stringify({ slots }), JSON.stringify({ entries }))
    const artifacts = []
    for (const purpose of ['manifest', 'details']) {
      const result = await invoke('generation:execute', { handle: child.handle, invocationNonce: purpose, task: {
        purpose: `character-architecture-${purpose}`, output: 'structured-data', messages: [{ role: 'user', content: 'Synthetic character proposal' }] } })
      artifacts.push(result.run.artifacts.at(-1)!)
    }
    const batch = await invoke('character-proposal:stage', { source: { kind: 'generation', inputKind: 'architecture', handle: child.handle,
      manifestArtifactId: artifacts[0].artifactId, artifacts: artifacts.map(item => ({ artifactId: item.artifactId, revision: item.revision, textHash: item.textHash })) } })
    const approveRequest: CharacterProposalChannels['character-proposal:approve']['args'][0] = { proposalBatchId: batch.proposalBatchId, expectedRevision: batch.revision,
      operationId: 'explicit-author-adoption', selections: batch.items.map(item => ({ selectionKey: item.selectionKey, action: 'create' })) }
    const adoption = await invoke('character-proposal:approve', approveRequest)
    expect(adoption.created).toHaveLength(3)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(3)
    await expect(invoke('generation:begin', { ...f.selection, operation: 'generate-world-building', uiActionNonce: 'next-world-stage', promptKeys: ['world_building'] }))
      .resolves.toMatchObject({ handle: { rootActionId: f.recovery.handle.rootActionId } })
    expect(fetch).toHaveBeenCalledTimes(2)
    getProjectDb()!.exec("UPDATE project_core SET global_guidance='Later external author guidance'")
    const beforeReplay = getProjectDb()!.prepare('SELECT total_changes()').pluck().get()
    await expect(invoke('character-proposal:approve', approveRequest)).resolves.toEqual(adoption)
    expect(getProjectDb()!.prepare('SELECT total_changes()').pluck().get()).toBe(beforeReplay)
    await expect(invoke('character-proposal:approve', { ...approveRequest, selections: approveRequest.selections.map(item => ({ ...item, action: 'keep-unresolved' })) }))
      .rejects.toThrow('CHARACTER_APPROVAL_NONCE_CONFLICT')
    await expect(mocks.handlers.get('character-proposal:approve')!({ sender }, { ...approveRequest, handle: { ...child.handle, rootActionId: 'forged-root' } }, session))
      .rejects.toThrow('CHARACTER_APPROVAL_INVALID')
    expect(getProjectDb()!.prepare('SELECT total_changes()').pluck().get()).toBe(beforeReplay)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(3)
  })
})
