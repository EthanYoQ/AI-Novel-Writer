import { afterEach, expect, it, vi } from 'vitest'
import type { MainGenerationReasoningEvent, MainGenerationRunView } from '../../generation/generation-runtime'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowReasoningStore } from '../../../stores/workflow-reasoning-store'
import { createWorkflowMainGenerationRuntime } from '../workflow-main-generation'
import type { createMainGenerationTransport } from '../../generation/main-generation-transport'

const session: ProjectSessionContext = { projectId: 'novel', leaseId: 'lease', projectPath: 'C:/novel' }
const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
const view: MainGenerationRunView = { handle, budget: { maxAttempts: 1, maxRequestedOutputTokens: 100, maxRequestedOutputTokensPerAttempt: 100, deadlineAt: 1000 }, status: 'running', nonReplayable: false, artifacts: [] }
const originalProject = useProjectStore.getState()
const originalReasoning = useWorkflowReasoningStore.getState()

afterEach(() => {
  useProjectStore.setState(originalProject, true)
  useWorkflowReasoningStore.setState(originalReasoning, true)
})

it('shows only current run reasoning in volatile memory and clears it on project switch', async () => {
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: 'Novel', novelConfig: {} } as never })
  let emitReasoning: (event: MainGenerationReasoningEvent) => void = () => {}
  const unsubscribeReasoning = vi.fn()
  const transport = {
    begin: vi.fn(async () => view),
    read: vi.fn(async () => view),
    subscribe: vi.fn(() => () => {}),
    subscribeReasoning: vi.fn((_handle, listener) => { emitReasoning = listener; return unsubscribeReasoning }),
  } as unknown as ReturnType<typeof createMainGenerationTransport>
  const context = { runId: 'workflow', projectPath: session.projectPath, projectSession: session,
    generationModelId: 'model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false } as WorkflowContext
  const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() } satisfies StepCallbacks
  const runtime = await createWorkflowMainGenerationRuntime({ context, callbacks,
    selection: { operation: 'chapter-draft', chapterNumber: 1, promptKeys: [], skillStages: [], output: 'visible-text' } }, transport)
  emitReasoning({ ...handle, attemptId: 'attempt', text: '临时推理' })
  expect(useWorkflowReasoningStore.getState().entries.workflow?.text).toBe('临时推理')
  useProjectStore.setState({ currentProject: { id: 'other', path: 'C:/other', sessionLease: 'other' } as never })
  expect(useWorkflowReasoningStore.getState().entries.workflow).toBeUndefined()
  emitReasoning({ ...handle, attemptId: 'attempt', text: '迟到推理' })
  expect(useWorkflowReasoningStore.getState().entries.workflow).toBeUndefined()
  await runtime.close()
  expect(unsubscribeReasoning).toHaveBeenCalledOnce()
})
