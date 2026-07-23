import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkflowStore, type WorkflowDefinition } from '../workflow-store'

beforeEach(() => {
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
})

describe('workflow pause at a safe step boundary', () => {
  it('finishes the current step, pauses before the next one, and resumes without starting it early', async () => {
    let finishFirstStep: (() => void) | undefined
    const secondStep = vi.fn(async () => undefined)
    const workflow: WorkflowDefinition = {
      type: 'batch_generate',
      title: '批量创作测试',
      steps: [
        {
          name: '第1章',
          description: '当前章节',
          executor: async () => new Promise<void>((resolve) => { finishFirstStep = resolve }),
        },
        {
          name: '第2章',
          description: '下一章节',
          executor: secondStep,
        },
      ],
    }

    const completion = useWorkflowStore.getState().startWorkflow(workflow)
    const runId = useWorkflowStore.getState().activeRuns[0].id
    await vi.waitFor(() => {
      expect(finishFirstStep).toBeTypeOf('function')
    })
    useWorkflowStore.getState().pauseWorkflow(runId)

    finishFirstStep!()
    await vi.waitFor(() => {
      expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('paused')
    })
    expect(secondStep).not.toHaveBeenCalled()

    useWorkflowStore.getState().resumeWorkflow(runId)
    await completion

    expect(secondStep).toHaveBeenCalledTimes(1)
    expect(useWorkflowStore.getState().history[0]).toMatchObject({ status: 'completed', title: '批量创作测试' })
  })
})
