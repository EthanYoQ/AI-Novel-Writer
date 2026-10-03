import { afterEach, expect, it, vi } from 'vitest'
import type { MainGenerationReasoningEvent, MainGenerationRunView, MainGenerationSnapshot } from '../../generation/generation-runtime'
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
  let emitSnapshot: (snapshot: MainGenerationSnapshot) => void = () => {}
  const unsubscribeReasoning = vi.fn()
  const transport = {
    begin: vi.fn(async () => view),
    read: vi.fn(async () => view),
    subscribe: vi.fn((_handle, listener) => { emitSnapshot = listener; return () => {} }),
    subscribeReasoning: vi.fn((_handle, listener) => { emitReasoning = listener; return unsubscribeReasoning }),
  } as unknown as ReturnType<typeof createMainGenerationTransport>
  const context = { runId: 'workflow', projectPath: session.projectPath, projectSession: session,
    generationModelId: 'model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false } as WorkflowContext
  const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn(), setGenerationActivity: vi.fn() } satisfies StepCallbacks
  const runtime = await createWorkflowMainGenerationRuntime({ context, callbacks,
    selection: { operation: 'review-chapter', chapterNumber: 1, promptKeys: [], skillStages: [], output: 'visible-text' } }, transport)
  emitReasoning({ ...handle, attemptId: 'attempt', text: '临时推理' })
  expect(useWorkflowReasoningStore.getState().entries.workflow?.text).toBe('临时推理')
  const diagnostics = { startedAt: 0, elapsedMs: 10000, firstResponseMs: 1000, lastResponseMs: 10000,
    lastOutputMs: 9000, phase: 'stream' as const, visibleEvents: 0, reasoningEvents: 5 }
  const snapshot: MainGenerationSnapshot = { ...handle, artifactId: 'artifact', attemptId: 'attempt',
    revision: 0, durableRevision: 0, text: '', textHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', status: 'running', diagnostics }
  emitSnapshot(snapshot)
  await vi.waitFor(() => expect(callbacks.setGenerationActivity).toHaveBeenLastCalledWith({ operation: 'review-chapter', diagnostics }))
  const heartbeat = { ...diagnostics, elapsedMs: 20000, lastResponseMs: 20000 }
  emitSnapshot({ ...snapshot, diagnostics: heartbeat })
  await vi.waitFor(() => expect(callbacks.setGenerationActivity).toHaveBeenLastCalledWith({ operation: 'review-chapter', diagnostics: heartbeat }))
  expect(callbacks.setGenerationActivity.mock.calls.at(-1)![0].diagnostics.lastOutputMs).toBe(9000)
  useProjectStore.setState({ currentProject: { id: 'other', path: 'C:/other', sessionLease: 'other' } as never })
  expect(useWorkflowReasoningStore.getState().entries.workflow).toBeUndefined()
  emitReasoning({ ...handle, attemptId: 'attempt', text: '迟到推理' })
  expect(useWorkflowReasoningStore.getState().entries.workflow).toBeUndefined()
  await runtime.close()
  expect(unsubscribeReasoning).toHaveBeenCalledOnce()
})
