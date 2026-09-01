import { beforeEach, describe, expect, it, vi } from 'vitest'

const { freezeWritingSkillsSnapshot } = vi.hoisted(() => ({ freezeWritingSkillsSnapshot: vi.fn() }))
vi.mock('../../services/agent/writing-skill-bindings', () => ({ freezeWritingSkillsSnapshot }))

import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { useWorkflowStore, type WorkflowContext } from '../workflow-store'

const projectPath = 'C:\\novels\\skill-snapshot'
const projectSession = {
  projectId: 'skill-snapshot',
  projectPath,
  leaseId: 'skill-snapshot-lease',
}

beforeEach(() => {
  freezeWritingSkillsSnapshot.mockReset()
  useWorkflowStore.setState({
    activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null,
    waitingForConfirm: false, waitingAfterStepIndex: -1,
  })
  useProjectStore.setState({
    currentProject: {
      id: projectSession.projectId,
      name: 'Skill snapshot',
      path: projectPath,
      sessionLease: projectSession.leaseId,
      novelConfig: { writingLanguage: 'en-US' },
    } as never,
  })
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
})

describe('workflow writing skill snapshot', () => {
  it('fails before step execution when configured writing skills cannot be frozen', async () => {
    freezeWritingSkillsSnapshot.mockRejectedValue(new Error('Writing skill binding target is missing: user:gone'))
    const executor = vi.fn().mockResolvedValue(undefined)

    await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'Fail closed skill workflow',
      projectPath,
      projectSession,
      steps: [{ name: 'write', description: 'write', executor }],
    })

    expect(executor).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(0)
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('user:gone'),
    })
  })

  it('reserves resource claims before the asynchronous snapshot load', async () => {
    let resolveSnapshot!: (snapshot: Readonly<Record<string, never>>) => void
    freezeWritingSkillsSnapshot.mockImplementation(() => new Promise((resolve) => {
      resolveSnapshot = resolve
    }))
    const firstExecutor = vi.fn().mockResolvedValue(undefined)
    const duplicateExecutor = vi.fn().mockResolvedValue(undefined)

    const firstCompletion = useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'First chapter writer',
      projectPath,
      projectSession,
      resourceKeys: ['chapter:1'],
      steps: [{ name: 'write', description: 'write', executor: firstExecutor }],
    })
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(1)

    await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'Duplicate chapter writer',
      projectPath,
      projectSession,
      resourceKeys: ['chapter:1'],
      steps: [{ name: 'write', description: 'write', executor: duplicateExecutor }],
    })

    expect(duplicateExecutor).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().history[0]).toMatchObject({
      title: 'Duplicate chapter writer',
      status: 'failed',
    })

    resolveSnapshot(Object.freeze({}))
    await firstCompletion
    expect(firstExecutor).toHaveBeenCalledOnce()
  })

  it('freezes bindings once before step one and reuses the same immutable snapshot across steps', async () => {
    const snapshot = Object.freeze({
      drafting: Object.freeze({
        skillId: 'user:scene-craft', name: 'Scene craft', stage: 'drafting' as const,
        source: 'user' as const, writingLanguage: 'en-US' as const,
        content: 'Frozen scene guidance', utf8Bytes: 21,
      }),
    })
    freezeWritingSkillsSnapshot.mockResolvedValue(snapshot)
    const contexts: WorkflowContext[] = []

    await useWorkflowStore.getState().startWorkflow({
      type: 'chapter_creation',
      title: 'Frozen writing skill workflow',
      projectPath,
      projectSession,
      steps: [
        { name: 'one', description: 'one', executor: async (_step, context) => { contexts.push(context) } },
        { name: 'two', description: 'two', executor: async (_step, context) => { contexts.push(context) } },
      ],
    })

    expect(freezeWritingSkillsSnapshot).toHaveBeenCalledOnce()
    expect(contexts).toHaveLength(2)
    expect(contexts[0].writingSkills).toBe(snapshot)
    expect(contexts[1].writingSkills).toBe(snapshot)
    expect(Object.isFrozen(contexts[0].writingSkills)).toBe(true)
    expect(useWorkflowStore.getState().history[0].writingSkills).toEqual([{
      stage: 'drafting', skillId: 'user:scene-craft', name: 'Scene craft', source: 'user', utf8Bytes: 21,
    }])
  })
})
