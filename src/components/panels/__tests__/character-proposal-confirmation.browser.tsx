import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import BottomPanel from '../BottomPanel'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { AdoptGeneratedCharactersCommand } from '../../../services/workflows/commands/architecture.command'
import type { CharacterProposalBatch } from '../../../shared/character-proposal'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session = { projectId: '项目', projectPath: 'C:/批量确认', leaseId: '会话' }
const batch: CharacterProposalBatch = { proposalBatchId: '批次', revision: 1, status: 'pending-approval', source: { kind: 'directory', operationId: '已签来源' }, items: [
 { selectionKey: 'a', sourceId: '来源甲', fields: { name: '同名', background: '旧王朝来客' }, rawValue: {}, relationships: [{ targetSelectionKey: 'b', relation: '盟友' }], resolution: { status: 'ambiguous', candidateIds: ['甲', '乙'] } },
 { selectionKey: 'b', sourceId: '来源乙', fields: { name: '同名', background: '新港口居民' }, rawValue: {}, relationships: [], resolution: { status: 'unresolved', candidateIds: [] } },
] }
let root: Root, container: HTMLDivElement, invoke: ReturnType<typeof vi.fn>
beforeEach(() => {
 useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, novelConfig: {} } as never }); setActiveProjectSessionContext(session)
 useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {} }); useLayoutStore.setState({ bottomPanelOpen: true, bottomTab: 'tasks' }); useLocaleStore.setState({ locale: 'zh-CN' })
 invoke = vi.fn(async (channel: string) => {
  if (channel === 'skills:list-user') return []
  if (channel === 'fs:check-exists') return false
  if (channel === 'character-identity:read') return { characters: [{ characterId: '甲', fields: { name: '同名', role: 'protagonist' }, retired: false }, { characterId: '乙', fields: { name: '同名', role: 'supporting' }, retired: false }] }
  if (channel === 'character-proposal:approve') return { batch: { ...batch, status: 'approved' } }
  throw new Error(channel)
 }); Object.assign(window, { aiNovelAPI: { invoke, on: () => () => {} } })
 container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); setActiveProjectSessionContext(null); useProjectStore.setState({ currentProject: null }); vi.restoreAllMocks() })
async function start() {
 const pending = useWorkflowStore.getState().startWorkflow({ type: 'post_process', title: '中文角色批量采用', projectPath: session.projectPath, projectSession: session, steps: [
  { name: '预览', description: '候选', executor: async (_step, context) => { context.data.characterProposalBatch = batch; return '候选尚未正式写入' } },
  { name: '统一确认采用', description: '作者明确选择', requiresConfirmation: true, executor: (step, context, callbacks) => new AdoptGeneratedCharactersCommand().execute({ step, context, callbacks }) },
 ] })
 await act(async () => root.render(<BottomPanel />))
 await vi.waitFor(() => expect(container.querySelectorAll('select')).toHaveLength(2))
 await vi.waitFor(() => expect((container.querySelector('[data-testid="workflow-confirmation-confirm"]') as HTMLButtonElement).disabled).toBe(false))
 return { pending, runId: useWorkflowStore.getState().activeRuns[0].id }
}
it('actual等待host一次选择同名乙+新建，显式关系经原批准command传送', async () => {
 const { pending } = await start(); const selects = container.querySelectorAll('select')
 expect(selects[0].value).toBe('keep-unresolved'); expect(selects[1].value).toBe('create')
 await act(async () => { selects[0].value = 'map:乙'; selects[0].dispatchEvent(new Event('change', { bubbles: true })) })
 await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
 expect(invoke.mock.calls.some(([channel]) => channel === 'character-proposal:approve')).toBe(false)
 await act(async () => (container.querySelector('[data-testid="workflow-confirmation-confirm"]') as HTMLButtonElement).click())
 await pending
 expect(invoke.mock.calls.find(([channel]) => channel === 'character-proposal:approve')?.[1]).toMatchObject({ proposalBatchId: '批次', selections: expect.arrayContaining([{ selectionKey: 'a', action: 'map', characterId: '乙' }, { selectionKey: 'b', action: 'create' }]), relationships: [{ sourceSelectionKey: 'a', targetSelectionKey: 'b', relation: '盟友' }] })
})
it('换项目与错误批次选择不能写live context；取消无批准', async () => {
 const { pending, runId } = await start(); const choices = useWorkflowStore.getState().activeRuns[0].characterProposalChoices!
 expect(useWorkflowStore.getState().setCharacterProposalChoices(runId, { ...choices, revision: 2 })).toBe(false)
 await act(async () => useProjectStore.setState({ currentProject: { id: 'B', path: 'C:/B', sessionLease: 'B', novelConfig: {} } as never }))
 expect(useWorkflowStore.getState().setCharacterProposalChoices(runId, choices)).toBe(false)
 expect(container.querySelectorAll('select')).toHaveLength(0)
 await act(async () => useWorkflowStore.getState().cancelWorkflow(runId)); await pending
 expect(invoke.mock.calls.some(([channel]) => channel === 'character-proposal:approve')).toBe(false)
})
