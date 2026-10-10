import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../../index.css'
import BottomPanel from '../BottomPanel'
import AIOutputPanel from '../AIOutputPanel'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { AdoptGeneratedCharactersCommand } from '../../../services/workflows/commands/architecture.command'
import { CommitPlanningMaterialCharactersCommand } from '../../../services/workflows/commands/planning-material.command'
import type { CharacterProposalBatch } from '../../../shared/character-proposal'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const session = { projectId: '项目', projectPath: 'C:/批量确认', leaseId: '会话' }
const batch: CharacterProposalBatch = { proposalBatchId: '批次', revision: 1, status: 'pending-approval', source: { kind: 'directory', operationId: '已签来源' }, items: [
 { selectionKey: 'a', sourceId: '来源甲', fields: { name: '同名', background: '旧王朝来客' }, rawValue: {}, relationships: [{ targetSelectionKey: 'b', relation: '盟友' }], resolution: { status: 'ambiguous', candidateIds: ['甲', '乙'] } },
 { selectionKey: 'b', sourceId: '来源乙', fields: { name: '同名', background: '新港口居民' }, rawValue: {}, relationships: [], resolution: { status: 'unresolved', candidateIds: [] } },
] }
let root: Root, container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
beforeEach(() => {
 useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, novelConfig: {} } as never }); setActiveProjectSessionContext(session)
 useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {} }); useLayoutStore.setState({ bottomPanelOpen: false, bottomTab: 'tasks', aiPanelOpen: true, rightView: 'ai-output', rightPanelRunId: null }); useLocaleStore.setState({ locale: 'zh-CN' })
 invoke = vi.fn(async (channel: string) => {
  if (['skills:list-user', 'db:recovery-candidate-list', 'generation:list', 'generation:list-batches'].includes(channel)) return []
  if (channel === 'fs:check-exists') return false
  if (channel === 'character-identity:read') return { characters: [{ characterId: '甲', fields: { name: '同名', role: 'protagonist' }, retired: false }, { characterId: '乙', fields: { name: '同名', role: 'supporting' }, retired: false }] }
  if (channel === 'character-proposal:approve') return { batch: { ...batch, status: 'approved' } }
  throw new Error(channel)
 }); Object.assign(window, { aiNovelAPI: { invoke, on: () => () => {} } })
 container = document.createElement('div'); container.style.cssText = 'width: 320px; height: 600px'; document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); setActiveProjectSessionContext(null); useProjectStore.setState({ currentProject: null }); vi.restoreAllMocks() })
async function start(proposal = batch, planning = false, waitForIdentity = true) {
 const pending = useWorkflowStore.getState().startWorkflow({ type: 'post_process', title: '中文角色批量采用', projectPath: session.projectPath, projectSession: session, steps: [
  { name: '预览', description: '候选', executor: async (_step, context) => { context.data.characterProposalBatch = proposal; context.data.planningMaterialCharacterCandidates = proposal.items; return '候选尚未正式写入' } },
  { name: '统一确认采用', description: '作者明确选择', requiresConfirmation: true, executor: (step, context, callbacks) => planning
    ? new CommitPlanningMaterialCharactersCommand().execute({ step, context, callbacks })
    : new AdoptGeneratedCharactersCommand().execute({ step, context, callbacks }) },
 ] })
 await act(async () => root.render(<><BottomPanel /><AIOutputPanel /></>))
 await vi.waitFor(() => expect(container.querySelectorAll('select[aria-label^="采用方式："]')).toHaveLength(proposal.items.length))
 if (waitForIdentity) await vi.waitFor(() => expect((container.querySelector('[data-testid="workflow-confirmation-confirm"]') as HTMLButtonElement).disabled).toBe(false))
 await act(async () => container.querySelector<HTMLElement>('[data-testid="workflow-confirmation-panel"] > details > summary')?.click())
 return { pending, runId: useWorkflowStore.getState().activeRuns[0].id }
}
it('V3 规划资料候选先编辑字段再确认，采用请求带作者修改', async () => {
 const planningBatch: CharacterProposalBatch = { ...batch, source: { kind: 'generation', inputKind: 'planning-material',
   handle: { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'run' }, artifacts: [] } }
 const { pending } = await start(planningBatch, true)
 await act(async () => {
   const adoption = container.querySelector<HTMLSelectElement>('select[aria-label="采用方式：同名 · a"]')!
   adoption.value = 'create'; adoption.dispatchEvent(new Event('change', { bubbles: true }))
   container.querySelector('[aria-label="批量选择角色采用方式"] details summary')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
 })
 const name = container.querySelector<HTMLInputElement>('input[aria-label="编辑候选姓名：a"]')
 expect(name).not.toBeNull()
 await act(async () => {
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '作者改名')
   name!.dispatchEvent(new Event('input', { bubbles: true }))
 })
 await act(async () => (container.querySelector('[data-testid="workflow-confirmation-confirm"]') as HTMLButtonElement).click())
 await pending
 expect(invoke.mock.calls.find(([channel]) => channel === 'character-proposal:approve')?.[1]).toMatchObject({
   edits: [{ selectionKey: 'a', fields: { name: '作者改名' } }],
 })
})
it('底部关闭时右侧按当前选择确认，同名乙+新建与显式关系经原批准command传送', async () => {
 const { pending } = await start(); expect(container.querySelector('.writer-task-table')).toBeNull(); const selects = container.querySelectorAll('select')
 expect(selects[0].value).toBe('keep-unresolved'); expect(selects[1].value).toBe('create')
 await act(async () => { selects[0].value = 'map:乙'; selects[0].dispatchEvent(new Event('change', { bubbles: true })) })
 await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
 expect(invoke.mock.calls.some(([channel]) => channel === 'character-proposal:approve')).toBe(false)
 await act(async () => (container.querySelector('[data-testid="workflow-confirmation-confirm"]') as HTMLButtonElement).click())
 await pending
 expect(invoke.mock.calls.find(([channel]) => channel === 'character-proposal:approve')?.[1]).toMatchObject({ proposalBatchId: '批次', selections: expect.arrayContaining([{ selectionKey: 'a', action: 'map', characterId: '乙' }, { selectionKey: 'b', action: 'create' }]), relationships: [{ sourceSelectionKey: 'a', targetSelectionKey: 'b', relation: '盟友' }] })
})
it('规划资料按唯一候选姓名显示关系，角色定位不提供无法提交的清空选项', async () => {
 const planning: CharacterProposalBatch = { ...batch, source: { kind: 'generation', inputKind: 'planning-material',
   handle: { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'run' }, artifacts: [] },
   items: batch.items.map((item, index) => ({ ...item, fields: { ...item.fields, name: index ? '乙' : '甲', role: 'supporting' },
     resolution: { status: 'unresolved', candidateIds: [] }, relationships: index ? [] : [{ targetName: '乙', relation: '同伴' }] })) }
 const { pending } = await start(planning, true)
 const relation = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
 expect(relation.disabled).toBe(false)
 expect(container.querySelector('select[aria-label="编辑候选角色定位：a"] option[value=""]')).toBeNull()
 await act(async () => relation.click())
 await act(async () => (container.querySelector('[data-testid="workflow-confirmation-confirm"]') as HTMLButtonElement).click())
 await pending
 expect(invoke.mock.calls.find(([channel]) => channel === 'character-proposal:approve')?.[1]).toMatchObject({
   relationships: [{ sourceSelectionKey: 'a', targetSelectionKey: 'b', relation: '同伴' }],
 })
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

it('身份读取失败时保留候选且禁用确认', async () => {
 const implementation = invoke.getMockImplementation()!
 invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === 'character-identity:read'
   ? Promise.reject(new Error('read failed')) : implementation(channel, ...args))
 const { pending, runId } = await start(batch, false, false)
 await vi.waitFor(() => expect(container.textContent).toContain('角色信息读取失败'))
 const confirm = container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')!
 expect(confirm.disabled).toBe(true)
 expect(container.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true)
 await act(async () => confirm.click())
 expect(invoke.mock.calls.some(([channel]) => channel === 'character-proposal:approve')).toBe(false)
 await act(async () => useWorkflowStore.getState().cancelWorkflow(runId)); await pending
})

it.each([false, true])('同路径新会话不复用旧身份，延迟返回=%s', async delayed => {
 let resolveIdentity!: (snapshot: { characters: [] }) => void
 const identityRead = new Promise<{ characters: [] }>(resolve => { resolveIdentity = resolve })
 if (delayed) {
   const implementation = invoke.getMockImplementation()!
   invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === 'character-identity:read'
     ? identityRead : implementation(channel, ...args))
 }
 const { pending, runId } = await start(batch, false, !delayed)
 await act(async () => {
   const nextSession = { ...session, leaseId: '重新打开的会话' }
   setActiveProjectSessionContext(nextSession)
   useProjectStore.setState({ currentProject: { ...useProjectStore.getState().currentProject!, sessionLease: nextSession.leaseId } })
   if (delayed) resolveIdentity({ characters: [] })
 })
 const confirm = container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')!
 expect(confirm.disabled).toBe(true)
 expect(container.textContent).toContain('项目会话已变更')
 await act(async () => confirm.click())
 expect(invoke.mock.calls.some(([channel]) => channel === 'character-proposal:approve')).toBe(false)
 await act(async () => useWorkflowStore.getState().cancelWorkflow(runId)); await pending
})

it('底部入口定位指定等待任务，消费后保留选择并允许切换其他任务', async () => {
 const { pending, runId } = await start()
 const adoption = container.querySelector<HTMLSelectElement>('select')!
 await act(async () => { adoption.value = 'map:乙'; adoption.dispatchEvent(new Event('change', { bubbles: true })) })
 const waitingRun = useWorkflowStore.getState().activeRuns[0]
 await act(async () => {
   useWorkflowStore.setState({ activeRuns: [{ ...waitingRun, id: '另一个任务', title: '另一个任务', status: 'running', characterProposalBatch: undefined, characterProposalChoices: undefined }, waitingRun] })
   useLayoutStore.setState({ bottomPanelOpen: true, aiPanelOpen: false, rightView: 'agent' })
   root.render(<BottomPanel />)
 })
 const openConfirmation = () => container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-open"]')!
 await act(async () => openConfirmation().click())
 expect(useLayoutStore.getState()).toMatchObject({ rightPanelRunId: runId, aiPanelOpen: true, rightView: 'ai-output' })
 await act(async () => root.render(<><BottomPanel /><AIOutputPanel /></>))
 await vi.waitFor(() => expect(useLayoutStore.getState().rightPanelRunId).toBeNull())
 await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')?.disabled).toBe(false))
 expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe('map:乙')
 expect(container.querySelectorAll('[data-testid="workflow-confirmation-panel"]')).toHaveLength(1)
 await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.writer-ai-panel button')].find(button => button.textContent === '另一个任务')!.click())
 expect(container.querySelector('[data-testid="workflow-confirmation-confirm"]')).toBeNull()
 await act(async () => openConfirmation().click())
 await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')?.disabled).toBe(false))
 const details = container.querySelector<HTMLDetailsElement>('[data-testid="workflow-confirmation-panel"] > details')!
 await act(async () => details.querySelector('summary')!.click())
 await act(async () => details.querySelector('summary')!.click())
 expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe('map:乙')
 await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')!.click())
 await pending
 expect(invoke.mock.calls.filter(([channel]) => channel === 'character-proposal:approve')).toHaveLength(1)
 expect(invoke.mock.calls.find(([channel]) => channel === 'character-proposal:approve')?.[1]).toMatchObject({ selections: expect.arrayContaining([{ selectionKey: 'a', action: 'map', characterId: '乙' }]) })
})

it.each([
 { theme: 'light', historyCount: 0 }, { theme: 'dark', historyCount: 0 },
 { theme: 'light', historyCount: 10 }, { theme: 'dark', historyCount: 10 },
])('260px 窄面板和短窗口长候选仍可确认与中止：$theme，历史 $historyCount 条', async ({ theme, historyCount }) => {
 await page.viewport(360, 340)
 container.style.cssText = 'width: 260px; height: 300px'
 container.className = `app-skin-root ${theme}`
 container.dataset.skin = 'classic'; container.dataset.theme = theme
 const longBatch: CharacterProposalBatch = { ...batch, items: Array.from({ length: 16 }, (_, index) => ({
   ...batch.items[1], selectionKey: `candidate-${index}`, fields: { name: '很长的候选角色名'.repeat(5), background: '角色背景与经历。'.repeat(40) }, relationships: [],
 })) }
 const { pending, runId } = await start(longBatch)
 await act(async () => {
   const run = useWorkflowStore.getState().activeRuns[0]
   useWorkflowStore.setState({ history: Array.from({ length: historyCount }, (_, index) => ({ ...run,
     id: `history-${index}`, title: `已完成 历史任务 ${index}`, status: 'completed' as const,
   })) })
 })
 await act(async () => useWorkflowStore.setState(state => ({ activeRuns: state.activeRuns.map(run => ({ ...run,
   steps: run.steps.map((step, index) => index ? { ...step, name: '下一步骤有很长的说明'.repeat(8) } : { ...step, result: '长篇候选输出。\n'.repeat(120) }),
 })) })))
 const panel = container.querySelector<HTMLElement>('.writer-ai-panel')!
 const confirmation = panel.querySelector<HTMLElement>('[data-testid="workflow-confirmation-panel"]')!
 const details = confirmation.querySelector<HTMLDetailsElement>('details')!
 const confirm = confirmation.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')!
 const stop = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('中止生成'))!
 const output = confirmation.parentElement!.previousElementSibling as HTMLElement
 expect(details.scrollHeight).toBeGreaterThan(details.clientHeight)
 expect(details.clientHeight).toBeGreaterThan(0)
 expect(output.clientHeight).toBeGreaterThan(0)
 expect(output.scrollHeight).toBeGreaterThan(output.clientHeight)
 const assertReachable = (button: HTMLButtonElement) => {
   const rect = button.getBoundingClientRect(), bounds = panel.getBoundingClientRect()
   expect(rect.height).toBeGreaterThan(20)
   expect(rect.left).toBeGreaterThanOrEqual(bounds.left)
   expect(rect.right).toBeLessThanOrEqual(bounds.right)
   expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom)
   expect(button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))).toBe(true)
 }
 assertReachable(confirm); assertReachable(stop)
 expect(confirm.getBoundingClientRect().bottom).toBeLessThan(stop.getBoundingClientRect().top)
 expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth)
 await page.screenshot({ path: `../../../../.runtime/.cache/manual-round2-20261010/confirmation-260x300-${theme}-history${historyCount}.png` })
 details.scrollTop = details.scrollHeight; output.scrollTop = output.scrollHeight
 assertReachable(confirm); assertReachable(stop)
 await page.screenshot({ path: `../../../../.runtime/.cache/manual-round2-20261010/confirmation-260x300-${theme}-history${historyCount}-scrolled.png` })
 const color = getComputedStyle(confirm)
 expect(color.color).not.toBe(color.backgroundColor)
 if (historyCount) {
   await act(async () => page.getByRole('button', { name: /历史任务 0/ }).click())
   expect(panel.querySelector('[data-testid="workflow-confirmation-confirm"]')).toBeNull()
   await act(async () => page.getByRole('button', { name: '当前生成', exact: true }).click())
   await vi.waitFor(() => expect(panel.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')?.disabled).toBe(false))
   assertReachable(panel.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')!)
   await act(async () => page.getByRole('button', { name: '中止生成', exact: true }).click())
 } else {
   await act(async () => stop.click())
 }
 await pending
 expect(useWorkflowStore.getState().waitingRuns[runId]).toBeUndefined()
 expect(invoke.mock.calls.some(([channel]) => channel === 'character-proposal:approve')).toBe(false)
})

it('普通逐步工作流在右侧阅读输出后只确认一次，不读取角色身份', async () => {
 const execute = vi.fn(async () => '已继续')
 const pending = useWorkflowStore.getState().startWorkflow({ type: 'post_process', title: '普通工作流', projectPath: session.projectPath, projectSession: session, steps: [
   { name: '预览', description: '步骤输出', executor: async () => '普通步骤的完整输出' },
   { name: '继续工作流', description: '人工确认', requiresConfirmation: true, executor: execute },
 ] })
 await act(async () => root.render(<><BottomPanel /><AIOutputPanel /></>))
 await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')?.disabled).toBe(false))
 expect(container.textContent).toContain('普通步骤的完整输出')
 const confirm = container.querySelector<HTMLButtonElement>('[data-testid="workflow-confirmation-confirm"]')!
 expect(confirm.textContent).toContain('确认继续')
 await act(async () => { confirm.click(); confirm.click() }); await pending
 expect(execute).toHaveBeenCalledTimes(1)
 expect(container.querySelector('[data-testid="workflow-confirmation-confirm"]')).toBeNull()
 expect(invoke.mock.calls.some(([channel]) => channel === 'character-identity:read')).toBe(false)
})
