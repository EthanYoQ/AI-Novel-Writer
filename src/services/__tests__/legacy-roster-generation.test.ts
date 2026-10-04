import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLegacyRosterGeneration } from '../legacy-roster-generation'
import { RepairLegacyCharacterRosterCommand } from '../workflows/commands/legacy-character-roster-repair.command'
import type { CommandExecuteParams } from '../workflows/commands/base-command'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { migrateLegacyCharacterRoster } from '../workflows/architecture-workflow'
import { useWorkflowStore } from '../../stores/workflow-store'
const session = { projectId: '项目', leaseId: '会话3', projectPath: 'C:/合成旧角色' }
const handle = { projectId: session.projectId, epoch: '会话1', rootActionId: '根', runId: '运行' }
const artifact = { artifactId: '片', revision: 1, textHash: 'a'.repeat(64) }
const source = { snapshot: { migrationState: 'legacy_markdown_pending', revision: 7 }, rawLegacy: '旧原文\r\n完整保留', legacyHash: '旧hash', identityRevision: 3, factsHash: '事实hash' }
const batch = { proposalBatchId: '提议', revision: 1, source: { kind: 'legacy-roster-generation', handle, artifact }, status: 'pending-approval', items: [{ selectionKey: '角色1', sourceId: '来源1', fields: { name: '沈砺' }, rawValue: { currentState: { location: '矿场' } }, resolution: { status: 'unresolved', candidateIds: [] }, relationships: [] }] }
const stored = { view: { handle: { ...handle, epoch: '会话2' }, status: 'completed', artifacts: [] }, modelId: '已移除的原模型', context: { projectId: session.projectId, source }, attemptCount: 1, sourceStatus: 'current', artifact }
const originalModel = useLLMStore.getState().defaultModelId
function install(invoke: ReturnType<typeof vi.fn>) { vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } }); return createLegacyRosterGeneration(session) }
function params(): CommandExecuteParams { return { step: {}, context: { runId: '界面动作', projectPath: session.projectPath, projectSession: session, data: {}, cancelled: false }, callbacks: { log: vi.fn(), setProgress: vi.fn(), onChunk: vi.fn() } } as unknown as CommandExecuteParams }
beforeEach(() => { useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, novelConfig: {} } as never }); useLLMStore.setState({ defaultModelId: '' }); useWorkflowStore.setState({ activeRuns: [], history: [] }) })
afterEach(() => { vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: null }); useLLMStore.setState({ defaultModelId: originalModel }); vi.restoreAllMocks() })
it('第三会话恢复原model与artifact，仅stage不重新请求，不正式采用', async () => {
 const invoke = vi.fn(async (channel: string) => { if (channel === 'legacy-roster:read') return stored; if (channel === 'legacy-roster:stage') return batch; throw new Error(channel) })
 install(invoke); const args = params()
 const output = await new RepairLegacyCharacterRosterCommand({ expectedProjectPath: session.projectPath, genre: '', recoveryHandle: handle }).execute(args)
 expect(output).toContain('矿场'); expect(output).toContain('尚未写入正式角色'); expect(output).toContain('不将其写入定稿状态')
 expect(args.context.data.characterProposalBatch).toEqual(batch)
 expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('legacy-roster:begin')
 expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('legacy-roster:execute')
})
it.each(['projectId', 'rootActionId', 'runId'])('拒绝伪%s', async key => {
 const client = install(vi.fn(async () => ({ ...stored, view: { ...stored.view, handle: { ...handle, [key]: '伪' } } })))
 await expect(client.open({ handle })).rejects.toThrow('IDENTITY_MISMATCH')
})
it('unknown无候选原占用不可再execute', async () => {
 const invoke = vi.fn<(channel: string) => Promise<unknown>>(async () => ({ ...stored, artifact: undefined })); const client = install(invoke)
 await client.open({ handle }); await expect(client.execute()).rejects.toThrow('OUTCOME_UNKNOWN'); expect(invoke.mock.calls.every(([channel]) => channel === 'legacy-roster:read')).toBe(true); expect(invoke).toHaveBeenCalledTimes(2)
})
it('detach不取消，重复cancel只一次专属IPC', async () => {
 const invoke = vi.fn(async (channel: string) => channel === 'legacy-roster:cancel' ? stored.view : stored)
 const client = install(invoke); await client.open({ handle }); client.detach(); expect(invoke).toHaveBeenCalledTimes(1)
 await Promise.all([client.cancel(), client.cancel()]); expect(invoke.mock.calls.filter(([channel]) => channel === 'legacy-roster:cancel')).toHaveLength(1)
})
it('现有卡采用不读取任何模型并发送全部CAS凭证', async () => {
 const invoke = vi.fn(async (channel: string, request: unknown) => {
  if (channel === 'legacy-roster:read-source') return { ...source, snapshot: { ...source.snapshot, migrationState: 'legacy_cards_preserved' } }
  if (channel === 'legacy-roster:adopt-existing') { expect(request).toMatchObject({ expectedRevision: 7, expectedLegacyHash: '旧hash', expectedIdentityRevision: 3, expectedFactsHash: '事实hash' }); return { snapshot: { renderedMarkdown: '原卡保留' } } }
  throw new Error(channel)
 }); install(invoke)
 expect(await new RepairLegacyCharacterRosterCommand({ expectedProjectPath: session.projectPath, genre: '' }).execute(params())).toBe('原卡保留')
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['legacy-roster:read-source', 'legacy-roster:adopt-existing'])
})
it('source读取期间取消，不采用既有卡', async () => {
 const args = params(); const invoke = vi.fn(async () => { args.context.cancelled = true; return { ...source, snapshot: { ...source.snapshot, migrationState: 'legacy_cards_preserved' } } }); install(invoke)
 await expect(new RepairLegacyCharacterRosterCommand({ expectedProjectPath: session.projectPath, genre: '' }).execute(args)).rejects.toThrow()
 expect(invoke).toHaveBeenCalledTimes(1)
})
it('实际launcher暂停等待明确确认，stage不等于正式完成', async () => {
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'legacy-roster:read-source') return source
  if (channel === 'legacy-roster:read') return stored
  if (channel === 'legacy-roster:stage') return batch
  if (channel === 'skills:list-user') return []
  if (channel === 'fs:check-exists') return false
  throw new Error(channel)
 }); install(invoke)
 const pending = migrateLegacyCharacterRoster(session.projectPath, { recoveryHandle: handle })
 await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns.some(run => run.status === 'waiting')).toBe(true))
 expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('character-proposal:approve')
 useWorkflowStore.getState().cancelWorkflow(useWorkflowStore.getState().activeRuns[0].id)
 await expect(pending).rejects.toThrow()
})

it('launcher既有卡模式被改变时拒绝改为模型流程', async () => {
 let reads = 0
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'legacy-roster:read-source') return ++reads === 1 ? { ...source, snapshot: { ...source.snapshot, migrationState: 'legacy_cards_preserved' } } : source
  if (channel === 'skills:list-user') return []
  if (channel === 'fs:check-exists') return false
  throw new Error(channel)
 }); install(invoke)
 await expect(migrateLegacyCharacterRoster(session.projectPath)).rejects.toThrow('SOURCE_MODE_CHANGED')
 expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('legacy-roster:begin')
})

it('known length failed但主资格为true，可显式恢复同run固定下一ordinal', async () => {
 let finished = false
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'legacy-roster:execute') { finished = true; return { run: stored.view } }
  return finished ? stored : { ...stored, artifact: undefined, view: { ...stored.view, artifacts: [{ text: '半截JSON', status: 'failed', compositionEligible: true }] } }
 })
 const client = install(invoke); await client.open({ handle }); expect((await client.execute()).artifact).toEqual(artifact)
 expect(invoke.mock.calls.filter(([channel]) => channel === 'legacy-roster:execute')).toHaveLength(1)
})
it.each(['history', 'open', 'client-read'])('取消发生%s await返回时禁止dispatch，已知main handle必须取消', async point => {
 const args = params()
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'legacy-roster:read-source') return source
  if (channel === 'generation:list') { if (point === 'history') args.context.cancelled = true; return [] }
  if (channel === 'legacy-roster:begin') { if (point === 'open') args.context.cancelled = true; return { ...stored, artifact: undefined, attemptCount: 0 } }
  if (channel === 'legacy-roster:read') { if (point === 'client-read') args.context.cancelled = true; return { ...stored, artifact: undefined, attemptCount: 0 } }
  if (channel === 'legacy-roster:cancel') return stored.view
  throw new Error(`Unexpected ${channel}`)
 }); install(invoke)
 await expect(new RepairLegacyCharacterRosterCommand({ expectedProjectPath: session.projectPath, genre: '' }).execute(args)).rejects.toThrow()
 expect(invoke.mock.calls.filter(([channel]) => channel === 'legacy-roster:execute')).toHaveLength(0)
 expect(invoke.mock.calls.filter(([channel]) => channel === 'legacy-roster:cancel')).toHaveLength(point === 'history' ? 0 : 1)
 expect(invoke.mock.calls.filter(([channel]) => channel === 'legacy-roster:begin')).toHaveLength(point === 'history' ? 0 : 1)
})
it('stage前置read期间取消不提交提议', async () => {
 let active = true
 const invoke = vi.fn(async (channel: string) => { if (channel === 'legacy-roster:read') { active = false; return stored } throw new Error(channel) })
 install(invoke)
 const client = createLegacyRosterGeneration(session, () => { if (!active) throw new Error('已取消') })
 // Open a known handle before enabling the cancellation race on the next read.
 invoke.mockImplementationOnce(async () => stored)
 await client.open({ handle })
 await expect(client.stage()).rejects.toThrow('已取消')
 expect(invoke.mock.calls.filter(([channel]) => channel === 'legacy-roster:stage')).toHaveLength(0)
})
