import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ui/Toast', () => ({ toast: { info: vi.fn(), warning: vi.fn() } }))

import { startConfigGeneration } from '../config-generation'
import { useLLMStore } from '../../../stores/llm-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'

const session = { projectId: 'novel', leaseId: 'lease', projectPath: 'C:/novel' }
const originalLLM = useLLMStore.getState()
const originalWorkflow = useWorkflowStore.getState()
const originalProject = useProjectStore.getState()
const startWorkflow = vi.fn(async () => 'run')
const addLog = vi.fn()

beforeEach(() => {
  useWorkflowStore.setState({ startWorkflow, addLog, activeRuns: [] })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: 'Novel', novelConfig: {} } as never })
})

afterEach(() => {
  vi.clearAllMocks()
  useLLMStore.setState(originalLLM, true)
  useWorkflowStore.setState(originalWorkflow, true)
  useProjectStore.setState(originalProject, true)
})

describe('config generation model gate', () => {
  it('starts when the planning stage has a usable model even though the default is unusable', () => {
    useLLMStore.setState({ models: [{ id: 'planner', purposes: ['generation'] }, { id: 'embedder', purposes: ['embedding'] }] as never,
      defaultModelId: 'embedder', stageModelIds: { planning: 'planner' } })
    expect(startConfigGeneration({ idea: '海港', projectSession: session, onGenerated: () => {} })).toBe(true)
    expect(startWorkflow).toHaveBeenCalledOnce()
  })

  it('refuses to start when neither the planning model nor the default can generate text', () => {
    useLLMStore.setState({ models: [{ id: 'embedder', purposes: ['embedding'] }] as never, defaultModelId: 'embedder', stageModelIds: { planning: 'gone' } })
    expect(startConfigGeneration({ idea: '海港', projectSession: session, onGenerated: () => {} })).toBe(false)
    expect(startWorkflow).not.toHaveBeenCalled()
    expect(addLog).toHaveBeenCalledWith('error', expect.any(String))
  })
})
