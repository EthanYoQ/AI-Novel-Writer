import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AIOutputPanel from '../AIOutputPanel'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'
import type { MainGenerationRunHandle, MainGenerationRunView } from '../../../services/generation/generation-runtime'
import type { GenerationBatchHistory } from '../../../shared/generation-owner-contract'
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

it.each(['zh-CN', 'en-US'] as const)('合法改稿后的生成记录与审稿同时可读，旧正文只可复制：%s', async locale => {
  const session = { projectId: '历史海港', leaseId: '新会话', projectPath: 'C:/合成历史海港' }
  const handle: MainGenerationRunHandle = { projectId: session.projectId, epoch: '旧会话', rootActionId: '原预算', runId: '原正文' }
  const reviewHandle = { ...handle, rootActionId: '审稿预算', runId: '合法审稿' }
  const content = '原生成正文：林岚走向城门。'
  const view = { handle, status: 'running', nonReplayable: false,
    artifacts: [{ ...handle, artifactId: '原片段', attemptId: '原请求', text: content, textHash: 'a'.repeat(64),
      revision: 1, durableRevision: 1, status: 'completed', compositionEligible: true }], ledger: { physicalRequests: 1 } }
  const invoke = vi.fn(async (channel: string, request?: { handle: MainGenerationRunHandle }) => {
    if (channel === 'generation:list') return [view, { ...view, handle: reviewHandle, artifacts: [] }]
    if (channel === 'generation:list-batches' || channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:read-context') return request?.handle.runId === handle.runId
      ? { handle, operation: 'chapter-draft', chapterNumber: 1, draftSave: { kind: 'changed' },
          composition: null, attemptedPurposes: ['chapter-draft'] }
      : { handle: reviewHandle, operation: 'review-chapter', draftSave: { kind: 'absent' } }
    if (channel === 'review-revision:read-recovery') return { handle: reviewHandle, modelId: '原模型', sourceStatus: 'current', canResume: true,
      context: { operation: 'review-chapter', source: { id: 1, chapterNumber: 1, version: 1, status: 'revised', content: '作者当前正文。' } },
      attemptedPurposes: ['review-chapter'] }
    throw new Error(`Unexpected action: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  const startWorkflow = vi.fn(), copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, name: '海港', sessionLease: session.leaseId, novelConfig: {} } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null, startWorkflow })
  useLocaleStore.setState({ locale })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<AIOutputPanel />))
  await vi.waitFor(() => expect(container!.textContent).toContain(locale === 'zh-CN' ? '第1章生成记录' : 'Chapter 1 generation history'))
  expect(container.querySelector('[role=alert]')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(true)
  const buttons = [...container.querySelectorAll('button')]
  const saved = buttons.find(button => button.textContent === (locale === 'zh-CN' ? '已保存，正文已修改' : 'Saved, then edited'))!
  expect(saved.disabled).toBe(true)
  expect(buttons.find(button => button.textContent === (locale === 'zh-CN' ? '重新审稿' : 'Review again'))?.disabled).toBe(false)
  await act(async () => { saved.click(); buttons.find(button => button.textContent === (locale === 'zh-CN' ? '复制' : 'Copy'))!.click() })
  expect(copy).toHaveBeenCalledWith(content)
  expect(startWorkflow).not.toHaveBeenCalled()
  expect(invoke.mock.calls.some(([channel]) => ['generation:resume', 'generation:execute', 'generation:compose-visible', 'generation:commit-draft'].includes(channel))).toBe(false)
})

it.each(['zh-CN', 'en-US'] as const)('来源变化的未完成批次不能继续，独立候选仍可查看：%s', async locale => {
  const session = { projectId: '批次海港', leaseId: '新会话', projectPath: 'C:/合成批次海港' }
  const handle: MainGenerationRunHandle = { projectId: session.projectId, epoch: '旧会话', rootActionId: '批次预算', runId: '原批次' }
  const independent = { ...handle, rootActionId: '独立预算', runId: '独立候选' }, content = '独立候选中的海港正文。'
  const batch: GenerationBatchHistory = { batchId: handle.runId, rootHandle: handle, sourceCurrent: false,
    mode: 'draft_review', range: { startChapter: 1, endChapter: 2 }, targetUnits: 900, modelId: '原模型', authorInputs: [],
    nextChapterNumber: 2, completedChapters: [{ chapterNumber: 1, draftId: 1, version: 1, contentHash: 'a'.repeat(64), sourceRunHandle: handle }] }
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'generation:list') return [{ handle: independent, status: 'failed', artifacts: [{ ...independent,
      artifactId: '独立片段', attemptId: '独立请求', text: content, textHash: 'b'.repeat(64), revision: 1, durableRevision: 1,
      status: 'completed', compositionEligible: true }] }]
    if (channel === 'generation:list-batches') return [batch, { ...batch, batchId: '已完成批次', nextChapterNumber: null }]
    if (channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:read-context') return { handle: independent, operation: 'chapter-draft', chapterNumber: 3,
      draftSave: { kind: 'absent' }, composition: null, attemptedPurposes: ['chapter-draft'] }
    throw new Error(`Unexpected action: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  const startWorkflow = vi.fn(), copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, name: '批次海港', sessionLease: session.leaseId, novelConfig: {} } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null, startWorkflow })
  useLocaleStore.setState({ locale })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<AIOutputPanel />))
  const message = locale === 'zh-CN' ? '批次来源已变化，不能继续此批次。请从当前正文发起新任务。'
    : 'The batch source changed. This batch cannot continue. Start a new task from the current text.'
  await vi.waitFor(() => expect(container!.textContent).toContain(message))
  expect(container.querySelector('[role=alert]')).toBeNull()
  expect(container.textContent).toContain(locale === 'zh-CN' ? '已保存 1 章，下一章 2' : '1 saved; next chapter 2')
  expect(container.textContent).toContain(content)
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(false)
  const batchButtons = () => [...container!.querySelectorAll('button')].filter(button => button.textContent === (locale === 'zh-CN' ? '继续此批次' : 'Continue this batch'))
  expect(batchButtons()).toHaveLength(1)
  expect(batchButtons()[0].disabled).toBe(true)
  await act(async () => {
    batchButtons()[0].click()
    ;[...container!.querySelectorAll('button')].find(button => button.textContent === (locale === 'zh-CN' ? '复制' : 'Copy'))!.click()
  })
  expect(copy).toHaveBeenCalledWith(content)
  expect(startWorkflow).not.toHaveBeenCalled()
  expect(invoke.mock.calls.some(([channel]) => channel === 'generation:read-batch')).toBe(false)
  batch.sourceCurrent = true
  await act(async () => root!.render(<AIOutputPanel key="当前来源" />))
  await vi.waitFor(() => expect(batchButtons()[0]?.disabled).toBe(false))
  expect(container.textContent).not.toContain(message)
})

it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)('中文面板沿明确的 %s 原任务恢复，源冲突只可复制，已保存结果可直接打开', async operation => {
  const session = { projectId: '审修海港', leaseId: '新会话', projectPath: 'C:/合成审修海港' }
  const handle: MainGenerationRunHandle = { projectId: session.projectId, epoch: '旧会话', rootActionId: '原审稿预算', runId: operation }
  const content = '林岚到达海港，发现了留下的信。'
  const source = { id: 3, chapterNumber: 2, version: 1, status: 'draft', content }
  let sourceStatus = 'conflict', saved = false, canResume = false
  const view = { handle, status: 'failed', nonReplayable: true,
    budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 },
    artifacts: [{ ...handle, artifactId: '已保存片段', attemptId: '原请求', text: content, textHash: 'a'.repeat(64), revision: 1, durableRevision: 1, status: 'completed' }],
    ledger: { physicalRequests: 3 } }
  const recovery = () => ({ handle, modelId: '原模型', contextId: '主进程上下文', sourceStatus, canResume,
    context: { version: 1, operation, source, sourceHash: 'a'.repeat(64), config: { wordsPerChapter: 900 }, writingLanguage: 'zh-CN', uiLocale: 'zh-CN',
      authorInputs: [], blueprints: [], history: [], frozenGoals: { chapterNumber: 2, coverage: 'unknown', items: [] }, preflightFindings: [], characterStates: '', worldbuilding: '' },
    attemptedPurposes: [operation], ...(saved ? { saved: { success: true, kind: operation === 'review-chapter' ? 'review' : 'revision', id: 9, index: 1,
      content, contentHash: 'a'.repeat(64), source, revisionStatus: 'merged' } } : {}) })
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'generation:list') return [view]
    if (channel === 'generation:list-batches' || channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:read-context') return { draftSave: { kind: 'absent' }, handle, operation }
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
  const recoverButton = () => [...container!.querySelectorAll('button')].find(item => item.textContent === (operation === 'review-chapter' ? '重新审稿' : '恢复此审修任务'))!
  expect(recoverButton().disabled).toBe(true)
  if (operation === 'review-chapter') {
    expect(container.textContent).not.toContain('重新审稿会重新调用模型')
    expect(container.textContent).not.toContain('次数已用尽')
  }
  expect(container.textContent).toContain(content)
  expect(container.textContent).toContain('已用 3 次请求')
  await expect(createReviewRevisionRecoveryWorkflow(session, handle)).rejects.toThrow('GENERATION_REVIEW_SOURCE_CHANGED')
  sourceStatus = 'current'; canResume = true
  await act(async () => root!.render(<AIOutputPanel key="刷新当前源" />))
  await vi.waitFor(() => expect(recoverButton().disabled).toBe(false))
  if (operation === 'review-chapter') expect(container!.textContent).toContain('重新审稿会重新调用模型；原稿保留。')
  await act(async () => recoverButton().click())
  await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
  expect(startWorkflow.mock.calls[0][0]).toMatchObject({ generationModelId: '原模型', projectSession: session, resourceKeys: ['chapter:2'] })
  expect(invoke.mock.calls.some(([channel]) => ['generation:begin', 'generation:resume', 'generation:execute', 'db:revision-replace-pending'].includes(channel))).toBe(false)
  canResume = false
  await act(async () => root!.render(<AIOutputPanel key="仅可复制" />))
  await vi.waitFor(() => expect(container!.textContent).toContain(operation === 'review-chapter'
    ? '当前任务的审稿请求次数已用尽。原稿保留，可从原稿发起新的审稿任务。'
    : '候选未通过保存校验；可复制保留，请从原稿重新发起任务。'))
  expect(recoverButton().disabled).toBe(true)
  await expect(createReviewRevisionRecoveryWorkflow(session, handle)).rejects.toThrow('GENERATION_REVIEW_RECOVERY_COPY_ONLY')
  saved = true; sourceStatus = 'conflict'
  await act(async () => root!.render(<AIOutputPanel key="保存回执" />))
  await vi.waitFor(() => expect(container!.textContent).toContain('打开已保存结果'))
  const open = [...container.querySelectorAll('button')].find(item => item.textContent === '打开已保存结果')!
  expect(open.disabled).toBe(false)
  await act(async () => open.click())
  await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledTimes(2))
})

it.each(['zh-CN', 'en-US'] as const)('耗尽或取消的审稿保留复制且不承诺新请求（%s）', async locale => {
  const session = { projectId: '耗尽审稿', leaseId: '当前会话', projectPath: 'C:/合成耗尽审稿' }
  const handle: MainGenerationRunHandle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: '原预算', runId: '原审稿' }
  const content = '林岚到达海港，未完整的审稿候选仍应保留。'
  const view = { handle, status: 'failed', artifacts: [{ ...handle, artifactId: '候选', attemptId: '第二次审稿',
    text: content, textHash: 'a'.repeat(64), revision: 1, durableRevision: 1, status: 'completed' }], ledger: { physicalRequests: 2 } }
  const recovery = { handle, modelId: '原模型', sourceStatus: 'current', canResume: false,
    context: { operation: 'review-chapter', source: { id: 3, chapterNumber: 2, version: 1, status: 'draft', content }, uiLocale: locale },
    latestArtifact: view.artifacts[0], latestArtifactFinishReason: 'length', attemptedPurposes: ['review-chapter', 'review-chapter'] }
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'generation:list') return [view]
    if (channel === 'generation:list-batches' || channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:read-context') return { draftSave: { kind: 'absent' }, handle, operation: 'review-chapter' }
    if (channel === 'review-revision:read-recovery') return recovery
    throw new Error(`Unexpected action: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  const startWorkflow = vi.fn(), writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, name: '耗尽审稿', sessionLease: session.leaseId, novelConfig: {} } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null, startWorkflow })
  useLocaleStore.setState({ locale })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<AIOutputPanel />))
  await vi.waitFor(() => expect(container!.textContent).toContain(content))
  const recoverButton = () => [...container!.querySelectorAll('button')].find(item => item.textContent === (locale === 'zh-CN' ? '重新审稿' : 'Review again'))!
  const promise = locale === 'zh-CN' ? '重新审稿会重新调用模型' : 'Reviewing again sends a new model request'
  const exhausted = locale === 'zh-CN'
    ? '当前任务的审稿请求次数已用尽。原稿保留，可从原稿发起新的审稿任务。'
    : 'This task has used all review attempts. The source draft is preserved. Start a new review task from the source draft.'
  expect(recoverButton().disabled).toBe(true)
  await act(async () => recoverButton().click())
  expect(startWorkflow).not.toHaveBeenCalled()
  const copy = [...container.querySelectorAll('button')].find(item => item.textContent === (locale === 'zh-CN' ? '复制' : 'Copy'))!
  expect(copy.disabled).toBe(false)
  await act(async () => copy.click())
  expect(writeText).toHaveBeenCalledWith(content)
  expect.soft(container.textContent).not.toContain(promise)
  expect.soft(container.textContent).toContain(exhausted)
  view.status = 'cancelled'; recovery.canResume = true
  await act(async () => root!.render(<AIOutputPanel key="已取消" />))
  await vi.waitFor(() => expect(container!.textContent).toContain(content))
  expect(recoverButton().disabled).toBe(true)
  expect.soft(container.textContent).not.toContain(promise)
  expect(container.textContent).not.toContain(exhausted)
  expect(invoke.mock.calls.some(([channel]) => ['generation:begin', 'generation:resume', 'generation:execute'].includes(channel))).toBe(false)
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
    if (channel === 'generation:read-context') return { draftSave: { kind: 'absent' }, handle, operation: 'chapter-draft', chapterNumber: 1, modelId: '原模型',
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

it.each([true, false])('写稿恢复面板不把生成前定稿对账产物列为正文候选（另有正文片段=%s）', async (withDraft) => {
  const session = { projectId: '对账海港', leaseId: '当前会话', projectPath: 'C:/合成对账海港' }
  const handle: MainGenerationRunHandle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: '对账根', runId: '对账正文' }
  const reconciliationText = '{"finalState":["对账依据哨兵"],"events":[]}'
  const view: MainGenerationRunView = { handle, status: 'failed', nonReplayable: false,
    budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9999999999999 },
    artifacts: [reconciliationText, ...(withDraft ? ['海潮拍岸。'] : [])].map((text, index) => ({ ...handle, text, textHash: 'a'.repeat(64), artifactId: `片段${index}`,
      attemptId: `请求${index}`, revision: 1, durableRevision: 1, status: 'completed' as const, compositionEligible: index !== 0 })) }
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'generation:list') return [view]
    if (channel === 'generation:list-batches' || channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:read-context') return { draftSave: { kind: 'absent' }, handle, operation: 'chapter-draft', chapterNumber: 2, modelId: '原模型',
      authorInputs: [], selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [2], composition: null,
      lastCompositionFinishReason: null, attemptedPurposes: withDraft ? ['chapter-draft-reconcile', 'chapter-draft'] : ['chapter-draft-reconcile'],
      draftReconciliation: { artifactIds: ['片段0'], completedOutput: reconciliationText } }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, name: '对账海港', sessionLease: session.leaseId, novelConfig: {} } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null })
  useLocaleStore.setState({ locale: 'zh-CN' })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<AIOutputPanel />))
  await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'generation:read-context')).toBe(true))
  if (withDraft) await vi.waitFor(() => expect(container!.textContent).toContain('海潮拍岸。'))
  else await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(container.textContent).not.toContain('对账依据哨兵')
  expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(withDraft ? 1 : 0)
})

it.each(['failed', 'completed'] as const)('无正文时从原恢复列表进入 %s 细纲任务', async state => {
  const session = { projectId: '细纲海港', leaseId: '新会话', projectPath: 'C:/合成细纲海港' }
  const handle: MainGenerationRunHandle = { projectId: session.projectId, epoch: '旧会话', rootActionId: '原预算', runId: '原细纲任务' }
  const view = { handle, status: 'paused', nonReplayable: true, artifacts: [], ledger: { physicalRequests: 1 } }
  const info = { chapterNumber: 1, title: '海港', characters: [] }
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'generation:list') return [view]
    if (channel === 'generation:list-batches' || channel === 'db:recovery-candidate-list') return []
    if (channel === 'generation:read-context') return { draftSave: { kind: 'absent' }, handle, operation: 'chapter-draft', chapterNumber: 1, modelId: '原模型',
      authorInputs: [{ id: 'draft:chapter-info', text: JSON.stringify(info) }, { id: 'draft:target-units', text: '1000' }],
      selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1], composition: null,
      lastCompositionFinishReason: null, attemptedPurposes: ['chapter-draft-short-outline'],
      draftShortOutline: { artifactIds: ['原细纲'], completedOutput: state === 'completed' ? '完整细纲，不能作为正文显示' : null,
        promptHash: 'a'.repeat(64), retry: state === 'failed' ? { kind: 'available', failedAttemptId: '原失败' } : { kind: 'unavailable' } } }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  const startWorkflow = vi.fn().mockResolvedValue('恢复工作流')
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, name: '细纲海港', sessionLease: session.leaseId, novelConfig: {} } as never })
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null, startWorkflow })
  useLocaleStore.setState({ locale: 'zh-CN' })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<AIOutputPanel />))
  const text = state === 'failed' ? '重做一次细纲并继续写稿' : '沿原细纲继续写稿'
  await vi.waitFor(() => expect(container!.textContent).toContain(text))
  expect(container.textContent).not.toContain('完整细纲，不能作为正文显示')
  expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(0)
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text)!
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
  expect(startWorkflow.mock.calls[0][0]).toMatchObject({ generationModelId: '原模型', projectSession: session, resourceKeys: ['chapter:1'] })
  expect(invoke.mock.calls.every(([channel]) => !['generation:begin', 'generation:execute', 'generation:retry-draft-short-outline'].includes(channel))).toBe(true)
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
    if (channel === 'generation:read-context') return { draftSave: { kind: 'absent' }, handle, operation: 'agent-round' }
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
