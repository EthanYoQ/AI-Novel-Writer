import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AIOutputPanel from '../AIOutputPanel'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'
import type { MainGenerationRunHandle, MainGenerationRunView } from '../../../services/generation/generation-runtime'
import { createDraftRecoveryWorkflow } from '../../../services/workflows/draft-recovery-workflow'
import { createReviewRevisionRecoveryWorkflow } from '../../../services/workflows/review-revision-recovery-workflow'

const projectState = useProjectStore.getState(), workflowState = useWorkflowStore.getState(), localeState = useLocaleStore.getState()
const oldBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  useProjectStore.setState(projectState, true); useWorkflowStore.setState(workflowState, true); useLocaleStore.setState(localeState, true)
  if (oldBridge) Object.defineProperty(window, 'aiNovelAPI', oldBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
  vi.restoreAllMocks()
})

it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)('中文面板沿明确的 %s 原任务恢复，源冲突只可复制，已保存结果可直接打开', async operation => {
  const session = { projectId: '审修海港', leaseId: '新会话', projectPath: 'C:/合成审修海港' }
  const handle: MainGenerationRunHandle = { projectId: session.projectId, epoch: '旧会话', rootActionId: '原审稿预算', runId: operation }
  const content = '林岚到达海港，发现了留下的信。'
  const source = { id: 3, chapterNumber: 2, version: 1, status: 'draft', content }
  let sourceStatus = 'conflict', saved = false
  const view = { handle, status: 'failed', nonReplayable: true,
    budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 },
    artifacts: [{ ...handle, artifactId: '已保存片段', attemptId: '原请求', text: content, textHash: 'a'.repeat(64), revision: 1, durableRevision: 1, status: 'completed' }],
    ledger: { physicalRequests: 3 } }
  const recovery = () => ({ handle, modelId: '原模型', contextId: '主进程上下文', sourceStatus,
    context: { version: 1, operation, source, sourceHash: 'a'.repeat(64), config: { wordsPerChapter: 900 }, writingLanguage: 'zh-CN', uiLocale: 'zh-CN',
      authorInputs: [], blueprints: [], history: [], frozenGoals: { chapterNumber: 2, coverage: 'unknown', items: [] }, preflightFindings: [], characterStates: '', worldbuilding: '' },
    attemptedPurposes: [operation], ...(saved ? { saved: { success: true, kind: operation === 'review-chapter' ? 'review' : 'revision', id: 9, index: 1,
      content, contentHash: 'a'.repeat(64), source, revisionStatus: 'merged' } } : {}) })
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'generation:list') return [view]
    if (channel === 'generation:list-batches' || channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:read-context') return { handle, operation }
    if (channel === 'review-revision:read-recovery') return recovery()
    throw new Error(`Unexpected action: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  const startWorkflow = vi.fn().mockResolvedValue('审修恢复工作流')
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, name: '审修海港', sessionLease: session.leaseId, novelConfig: {} } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null, startWorkflow })
  useLocaleStore.setState({ locale: 'zh-CN' })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<AIOutputPanel />))
  await vi.waitFor(() => expect(container!.textContent).toContain('来源已变化；候选仍可复制'))
  const recoverButton = () => [...container!.querySelectorAll('button')].find(item => item.textContent === '恢复此审修任务')!
  expect(recoverButton().disabled).toBe(true)
  expect(container.textContent).toContain(content)
  expect(container.textContent).toContain('已用 3 次请求')
  await expect(createReviewRevisionRecoveryWorkflow(session, handle)).rejects.toThrow('GENERATION_REVIEW_SOURCE_CHANGED')
  sourceStatus = 'current'
  await act(async () => root!.render(<AIOutputPanel key="刷新当前源" />))
  await vi.waitFor(() => expect(recoverButton().disabled).toBe(false))
  await act(async () => recoverButton().click())
  await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
  expect(startWorkflow.mock.calls[0][0]).toMatchObject({ generationModelId: '原模型', projectSession: session, resourceKeys: ['chapter:2'] })
  expect(invoke.mock.calls.some(([channel]) => ['generation:begin', 'generation:resume', 'generation:execute', 'db:revision-replace-pending'].includes(channel))).toBe(false)
  saved = true; sourceStatus = 'conflict'
  await act(async () => root!.render(<AIOutputPanel key="保存回执" />))
  await vi.waitFor(() => expect(container!.textContent).toContain('打开已保存结果'))
  const open = [...container.querySelectorAll('button')].find(item => item.textContent === '打开已保存结果')!
  expect(open.disabled).toBe(false)
  await act(async () => open.click())
  await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledTimes(2))
})

it.each(['completed', 'failed'] as const)('中文恢复面板按明确组合资格恢复 %s 片段，不猜最新候选', async (status) => {
  const session = { projectId: '海港', leaseId: '当前会话', projectPath: 'C:/合成海港' }
  const handle: MainGenerationRunHandle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: '原根', runId: '原正文' }
  const view: MainGenerationRunView = { handle, status: 'failed', nonReplayable: false,
    budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 },
    artifacts: ['海潮拍岸。', '钟楼亮灯。', '连接丢失留下的文字。', '旧版本没有资格证据的文字。'].map((text, index) => ({ ...handle, text, textHash: 'a'.repeat(64), artifactId: `片段${index}`, attemptId: `请求${index}`, revision: 1, durableRevision: 1,
      status: index === 2 ? 'failed' : index === 3 ? 'completed' : status,
      ...(index === 3 ? {} : { compositionEligible: index !== 2 }) })),
    unsavedTails: [{ attemptId: '尾请求', artifactId: '尾片', durableRevision: 0, text: '尚未保存的潮声', failureCode: 'STORAGE_FAILED' }] }
  let composition: unknown = null
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'generation:list') return [view]
    if (channel === 'generation:list-batches' || channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:resume') return view
    if (channel === 'generation:compose-visible') {
      composition = { algorithm: 'draft-visible-v1', artifactIds: args[1], text: '海潮拍岸。', textHash: args[2], sources: [] }
      return composition
    }
    if (channel === 'generation:read-context') return { handle, operation: 'chapter-draft', chapterNumber: 1, modelId: '原模型',
      authorInputs: [{ id: 'draft:chapter-info', text: JSON.stringify({ chapterNumber: 1, title: '潮声', role: '开端', purpose: '寻找钟楼', characters: [], keyEvents: '亮灯' }) },
        { id: 'draft:target-units', text: '900' }], selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1],
      composition, lastCompositionFinishReason: status === 'failed' ? 'length' : 'stop', attemptedPurposes: ['chapter-draft'] }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  const startWorkflow = vi.fn().mockResolvedValue('恢复工作流')
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, name: '海港', sessionLease: session.leaseId, novelConfig: {} } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null, startWorkflow })
  useLocaleStore.setState({ locale: 'zh-CN' })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<AIOutputPanel />))
  await vi.waitFor(() => expect(container!.textContent).toContain('尚未保存的潮声'))
  const boxes = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
  expect(boxes).toHaveLength(4)
  expect(boxes[0].disabled).toBe(false)
  expect(boxes[2].disabled).toBe(true)
  expect(boxes[3].disabled).toBe(true)
  await expect(createDraftRecoveryWorkflow(session, handle, ['片段2'])).rejects.toThrow('GENERATION_COMPOSITION_SELECTION_INVALID')
  await expect(createDraftRecoveryWorkflow(session, handle, ['片段3'])).rejects.toThrow('GENERATION_COMPOSITION_SELECTION_INVALID')
  expect(invoke.mock.calls.some(([channel]) => channel === 'generation:compose-visible')).toBe(false)
  await act(async () => boxes[0].click())
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === '确认继续已选正文')!
  await act(async () => button.click())
  await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
  expect(invoke.mock.calls.find(([channel]) => channel === 'generation:compose-visible')?.[2]).toEqual(['片段0'])
  expect(startWorkflow.mock.calls[0][0]).toMatchObject({ generationModelId: '原模型', projectSession: session })
  expect(invoke.mock.calls.some(([channel]) => channel === 'generation:execute' || channel === 'generation:begin')).toBe(false)
})

it.each(['unknown', 'conflict', 'cancelled'] as const)('助手恢复卡只显示可见回复并保留 %s 边界', async state => {
  const { useAgentStore } = await import('../../../stores/agent-store')
  const { useLayoutStore } = await import('../../../stores/layout-store')
  const agentState = useAgentStore.getState(), layoutState = useLayoutStore.getState()
  const session = { projectId: '助手海港', leaseId: '当前会话', projectPath: 'C:/合成助手海港' }
  const handle: MainGenerationRunHandle = { projectId: session.projectId, epoch: '原会话', rootActionId: '原助手预算', runId: '原助手轮次' }
  const visibleText = '林岚在海港找到了信。'
  const view = { handle, status: state === 'cancelled' ? 'cancelled' : 'failed', artifacts: [], ledger: { physicalRequests: 2 } }
  const recovery = { handle, modelId: '冻结原模型', context: { input: { userMessage: '检查海港设定' } },
    sourceStatus: state === 'conflict' ? 'conflict' : 'current', run: view, nextRound: null,
    rounds: [{ index: 0, handle, status: 'unknown', visibleText,
      protocolText: '<tool_call>{"name":"秘密协议标记"}</tool_call>', actions: [] }] }
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'generation:list') return [view]
    if (channel === 'generation:list-batches' || channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:read-context') return { handle, operation: 'agent-round' }
    if (channel === 'agent-generation:read') return recovery
    throw new Error(`未配置调用：${channel}`)
  })
  const resumeGeneration = vi.fn().mockResolvedValue(undefined)
  try {
    Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
    useAgentStore.setState({ resumeGeneration })
    useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, name: '助手海港', sessionLease: session.leaseId, novelConfig: {} } as never })
    useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null })
    useLocaleStore.setState({ locale: 'zh-CN' })
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    await act(async () => root!.render(<AIOutputPanel />))
    await vi.waitFor(() => expect(container!.textContent).toContain(visibleText))
    expect(container.textContent).not.toContain('秘密协议标记')
    expect(container.textContent).not.toContain('<tool_call>')
    expect(container.textContent).toContain('部分操作结果待确认，恢复时不会自动重做。')
    expect(container.textContent).toContain('已用 2 次请求')
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === '恢复此助手任务')!
    expect(button.disabled).toBe(state !== 'unknown')
    if (state === 'conflict') expect(container.textContent).toContain('来源已变化；保留的回复仍可复制。')
    if (state === 'cancelled') expect(container.textContent).toContain('已取消')
    await act(async () => button.click())
    if (state === 'unknown') {
      await vi.waitFor(() => expect(resumeGeneration).toHaveBeenCalledExactlyOnceWith(handle))
      expect(useLayoutStore.getState().rightView).toBe('agent')
    } else expect(resumeGeneration).not.toHaveBeenCalled()
    expect(invoke.mock.calls.some(([channel]) => ['agent-generation:begin', 'agent-generation:round', 'generation:execute'].includes(channel))).toBe(false)
  } finally {
    useAgentStore.setState(agentState, true); useLayoutStore.setState(layoutState, true)
  }
})
