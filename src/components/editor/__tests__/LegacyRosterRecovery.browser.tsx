import type { LegacyRosterGenerationRecovery } from '../../../shared/legacy-roster-generation'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ArchFileViewer from '../ArchFileViewer'
import WorldBuildingEditor from '../WorldBuildingEditor'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session = { projectId: '旧角色项目', leaseId: '会话3', projectPath: 'C:/合成旧角色' }
const handle = { projectId: session.projectId, epoch: '会话1', rootActionId: '原根', runId: '原运行' }
const source = { snapshot: { revision: 1, migrationState: 'legacy_markdown_pending', status: 'legacy_repair_required', entries: [], legacyMarkdown: '旧原文', renderedMarkdown: '' }, rawLegacy: '旧原文' }
let stored: LegacyRosterGenerationRecovery
let root: Root, container: HTMLDivElement, invoke: ReturnType<typeof vi.fn>, copy: ReturnType<typeof vi.fn>
const originalModel = useLLMStore.getState().defaultModelId
beforeEach(() => {
 useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
 useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, novelConfig: { genre: '', targetAudience: '', coreOutline: '' } } as never, fileTree: [], loading: false })
 useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null })
 useLLMStore.setState({ defaultModelId: '' }); setActiveProjectSessionContext(session)
 stored = { view: { handle, status: 'completed', artifacts: [{ text: '沈砺候选原文' }] }, modelId: '已移除的原模型', context: { projectId: session.projectId, source }, attemptCount: 1, sourceStatus: 'conflict' } as unknown as LegacyRosterGenerationRecovery
 invoke = vi.fn(async (channel: string) => {
  if (channel === 'generation:list') return [{ ...stored.view, operation: 'legacy-character-roster-repair' }]
  if (channel === 'legacy-roster:read') return stored
  if (channel === 'legacy-roster:cancel') { stored = { ...stored, view: { ...stored.view, status: 'cancelled' } }; return stored.view }
  if (channel === 'db:character-roster-read') return source.snapshot
  if (channel === 'db:project-core-get') return { synopsis: '', worldbuilding: '', totalChapters: 2 }
  if (channel === 'fs:read-json') return { success: true, data: {} }
  if (channel === 'fs:check-exists') return false
  throw new Error(`Unexpected IPC ${channel}`)
 })
 Object.assign(window, { aiNovelAPI: { invoke, on: () => () => {}, once: vi.fn(), send: vi.fn() } })
 copy = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
 container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); setActiveProjectSessionContext(null); useProjectStore.setState({ currentProject: null }); useLLMStore.setState({ defaultModelId: originalModel }); vi.restoreAllMocks() })
function button(label: string) { const el = [...container.querySelectorAll('button')].find(node => node.textContent?.includes(label)); if (!el) throw new Error(label); return el }
it.each(['arch', 'world'])('%s真实入口恢复旧候选无需模型，冲突只读可复制，取消原run', async entry => {
 await act(async () => root.render(entry === 'arch' ? <ArchFileViewer tabId="角色" filePath="ai-novel://core/characters" projectKey={session.projectPath} content="" savedContent="" /> : <WorldBuildingEditor projectKey={session.projectPath} />))
 await vi.waitFor(() => expect(container.textContent).toContain('已移除的原模型'))
 expect(container.textContent).toContain('沈砺候选原文')
 expect(button('恢复原运行').disabled).toBe(true)
 await act(async () => button('复制原文与候选').click())
 expect(copy).toHaveBeenCalledWith('旧原文\n\n沈砺候选原文')
 await act(async () => button('取消原运行').click())
 expect(invoke.mock.calls.find(([channel]) => channel === 'legacy-roster:cancel')?.[1]).toEqual({ handle })
 expect(invoke.mock.calls.some(([channel]) => channel.startsWith('llm:') || channel === 'legacy-roster:begin')).toBe(false)
})

it.each(['arch', 'world'])('%s恢复原运行经过实际launcher确认门，批准前不写', async entry => {
 const artifact = { artifactId: '片', revision: 1, textHash: 'a'.repeat(64) }
 const batch = { proposalBatchId: '提议', revision: 1, status: 'pending-approval', source: { kind: 'legacy-roster-generation', handle, artifact }, items: [{ selectionKey: '1', sourceId: '1', fields: { name: '沈砺' }, rawValue: { currentState: { location: '矿场' } }, resolution: { status: 'unresolved', candidateIds: [] }, relationships: [] }] }
 stored = { ...stored, sourceStatus: 'current', artifact }
 const original = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
 invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
  if (channel === 'legacy-roster:read-source') return source
  if (channel === 'legacy-roster:stage') return batch
  if (channel === 'skills:list-user') return []
  if (channel === 'character-proposal:approve') return { batch: { ...batch, status: 'approved' } }
  return original(channel, ...args)
 })
 await act(async () => root.render(entry === 'arch' ? <ArchFileViewer tabId="角色" filePath="ai-novel://core/characters" projectKey={session.projectPath} content="" savedContent="" /> : <WorldBuildingEditor projectKey={session.projectPath} />))
 await vi.waitFor(() => expect(container.textContent).toContain('已移除的原模型'))
 await act(async () => button('恢复原运行').click())
 await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('waiting'))
 expect(invoke.mock.calls.some(([channel]) => channel === 'character-proposal:approve')).toBe(false)
 await act(async () => useWorkflowStore.getState().confirmContinue(useWorkflowStore.getState().activeRuns[0].id))
 await vi.waitFor(() => expect(useWorkflowStore.getState().history[0]?.status).toBe('completed'))
 expect(invoke.mock.calls.find(([channel]) => channel === 'character-proposal:approve')?.[1]).toMatchObject({ proposalBatchId: '提议', selections: [{ selectionKey: '1', action: 'create' }] })
 expect(invoke.mock.calls.some(([channel]) => channel === 'legacy-roster:begin' || channel.startsWith('llm:'))).toBe(false)
})
it.each(['arch', 'world'])('%s只有明确重新开始才新begin，原read无需defaultmodel', async entry => {
 const artifact = { artifactId: '新片', revision: 1, textHash: 'b'.repeat(64) }
 const batch = { proposalBatchId: '新提议', revision: 1, status: 'pending-approval', source: { kind: 'legacy-roster-generation', handle, artifact }, items: [] }
 const original = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
 invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
  if (channel === 'legacy-roster:read-source') return source
  if (channel === 'legacy-roster:begin') { stored = { ...stored, sourceStatus: 'current', artifact }; return stored }
  if (channel === 'legacy-roster:stage') return batch
  if (channel === 'skills:list-user') return []
  return original(channel, ...args)
 })
 await act(async () => root.render(entry === 'arch' ? <ArchFileViewer tabId="角色" filePath="ai-novel://core/characters" projectKey={session.projectPath} content="" savedContent="" /> : <WorldBuildingEditor projectKey={session.projectPath} />))
 await vi.waitFor(() => expect(container.textContent).toContain('已移除的原模型'))
 expect(invoke.mock.calls.some(([channel]) => channel === 'legacy-roster:begin')).toBe(false)
 useLLMStore.setState({ defaultModelId: '作者新选模型' })
 await act(async () => button('明确重新开始').click())
 await vi.waitFor(() => expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('waiting'))
 expect(invoke.mock.calls.find(([channel]) => channel === 'legacy-roster:begin')?.[1]).toMatchObject({ modelId: '作者新选模型' })
 await act(async () => useWorkflowStore.getState().cancelWorkflow(useWorkflowStore.getState().activeRuns[0].id))
})

it('已有历史但read失败仍显示错误和明确restart，不伪造可复制候选', async () => {
 const original = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
 invoke.mockImplementation(async (channel: string, ...args: unknown[]) => { if (channel === 'legacy-roster:read') throw new Error('合成读取失败'); return original(channel, ...args) })
 await act(async () => root.render(<WorldBuildingEditor projectKey={session.projectPath} />))
 await vi.waitFor(() => expect(container.textContent).toContain('原运行暂时无法读取'))
 expect(button('明确重新开始').disabled).toBe(false)
 expect(container.textContent).not.toContain('复制原文与候选')
 expect(invoke.mock.calls.some(([channel]) => channel === 'legacy-roster:begin')).toBe(false)
})
it('A项目旧页不得显示或取消当前B项目的恢复运行', async () => {
 await act(async () => root.render(<ArchFileViewer tabId="旧页" filePath="ai-novel://core/characters" projectKey="C:/另一项目A" content="" savedContent="" />))
 await act(async () => new Promise(resolve => setTimeout(resolve, 20)))
 expect(container.textContent).not.toContain('已移除的原模型')
 expect(container.textContent).not.toContain('沈砺候选原文')
 expect(container.textContent).not.toContain('取消原运行')
 expect(invoke.mock.calls.some(([channel]) => channel === 'generation:list' || channel.startsWith('legacy-roster:'))).toBe(false)
})
