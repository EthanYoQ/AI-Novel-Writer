import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AIOutputPanel from '../AIOutputPanel'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'
import type { MainGenerationRunHandle, MainGenerationRunView } from '../../../services/generation/generation-runtime'
import { createDraftRecoveryWorkflow } from '../../../services/workflows/draft-recovery-workflow'

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
