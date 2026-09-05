import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { createChapterWorkflow, createRepairFinalizeWorkflow } from '../chapter-workflow'

const postProcess = vi.hoisted(() => ({
  params: [] as Array<Record<string, unknown>>,
  execute: vi.fn(async (params: unknown) => { void params }),
}))

vi.mock('../commands/finalize-chapter.command', () => ({
  RunFinalizePostProcessCommand: class {
    constructor(params: Record<string, unknown>) {
      postProcess.params.push(params)
    }

    execute(params: unknown) {
      return postProcess.execute(params)
    }
  },
}))

const PROJECT_PATH = 'C:\\novels\\repair-finalize'
const PROJECT_SESSION = Object.freeze({
  projectId: 'repair-finalize',
  leaseId: 'lease-repair-finalize',
  projectPath: PROJECT_PATH,
})
const originalLocale = useLocaleStore.getState().locale

function context(): WorkflowContext {
  return {
    runId: 'repair-finalize-run',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    data: {},
    cancelled: false,
  }
}

function callbacks(): StepCallbacks {
  return { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
}

afterEach(() => {
  postProcess.params.length = 0
  postProcess.execute.mockClear()
  vi.unstubAllGlobals()
  useLocaleStore.setState({ locale: originalLocale })
  useProjectStore.setState({ currentProject: null })
})

describe('createRepairFinalizeWorkflow', () => {
  it('scopes direct writing and repair to the target chapter', () => {
    const writing = createChapterWorkflow({
      projectPath: PROJECT_PATH,
      chapterNumber: 3,
      title: '第三章',
      role: '发展',
      purpose: '推进冲突',
      characters: [],
      keyEvents: '冲突升级',
      wordsTarget: 4200,
    }, PROJECT_SESSION)
    const repair = createRepairFinalizeWorkflow(3, PROJECT_PATH, PROJECT_SESSION)

    expect(writing).toMatchObject({
      chapterWordsTarget: 4200,
      resourceKeys: ['chapter:3'],
      readResourceKeys: ['novel-config', 'architecture', 'blueprints'],
    })
    expect(repair).toMatchObject({
      resourceKeys: [
        'chapter:3',
        'character-roster',
        'continuity',
        'chapter-summary',
      ],
      readResourceKeys: ['novel-config', 'architecture', 'blueprints'],
    })
  })

  it('rebuilds every derived result instead of skipping previously successful steps', async () => {
    useProjectStore.setState({
      currentProject: {
        id: PROJECT_SESSION.projectId,
        name: 'Repair finalize',
        path: PROJECT_PATH,
        sessionLease: PROJECT_SESSION.leaseId,
      } as never,
    })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'db:draft-get-finalized':
          return { id: 17 }
        case 'db:draft-get-full':
          return { content: '已定稿正文' }
        case 'db:blueprint-get':
          return { title: '定稿标题', characters: ['林舟'] }
        default:
          throw new Error(`unexpected IPC: ${channel}`)
      }
    })
    vi.stubGlobal('window', { velaAPI: { invoke } })

    const workflow = createRepairFinalizeWorkflow(3, PROJECT_PATH, PROJECT_SESSION)
    const step = workflow.steps[0]!
    await step.executor({
      ...step,
      id: 'repair-finalize-step',
      status: 'running',
      logs: [],
    }, context(), callbacks())

    expect(postProcess.params).toEqual([expect.objectContaining({
      chapterNumber: 3,
      draftId: 17,
      onlyFailed: false,
    })])
    expect(postProcess.execute).toHaveBeenCalledOnce()
  })

  it('freezes English repair copy, fallback metadata, and completion text at creation', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    useProjectStore.setState({
      currentProject: {
        id: PROJECT_SESSION.projectId,
        name: 'Repair finalize',
        path: PROJECT_PATH,
        sessionLease: PROJECT_SESSION.leaseId,
      } as never,
    })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'db:draft-get-finalized':
          return { id: 17 }
        case 'db:draft-get-full':
          return { content: 'Finalized manuscript' }
        case 'db:blueprint-get':
          return null
        default:
          throw new Error(`unexpected IPC: ${channel}`)
      }
    })
    vi.stubGlobal('window', { velaAPI: { invoke } })

    const workflow = createRepairFinalizeWorkflow(3, PROJECT_PATH, PROJECT_SESSION)
    expect(() => createRepairFinalizeWorkflow(3, PROJECT_PATH, {
      ...PROJECT_SESSION,
      projectPath: 'C:\\novels\\another-project',
    })).toThrow('Workflow project session does not match the target path')
    useLocaleStore.setState({ locale: 'zh-CN' })

    expect(workflow).toMatchObject({
      uiLocale: 'en-US',
      title: 'Repair post-processing — Chapter 3',
      steps: [{
        name: 'Rebuild post-processing',
        description: 'Regenerate chapter notes, continuity facts, and character state from the finalized manuscript',
      }],
      onComplete: { mode: 'open', message: 'Chapter 3 post-processing repair completed' },
    })
    const step = workflow.steps[0]!
    await step.executor({
      ...step,
      id: 'repair-finalize-step-en',
      status: 'running',
      logs: [],
    }, { ...context(), uiLocale: workflow.uiLocale! }, callbacks())

    expect(postProcess.params).toEqual([expect.objectContaining({
      chapterTitle: 'Chapter 3',
      sourceLabel: 'Chapter 3 finalized manuscript',
    })])
  })

  it.each([
    ['project switch', 'project', 'The project changed, so repair was stopped.'],
    ['missing finalized record', 'draft', 'The finalized record for Chapter 3 could not be found.'],
    ['missing finalized content', 'content', 'Could not read finalized manuscript content: ID=17'],
  ] as const)('uses frozen English for the %s error', async (_label, failure, expected) => {
    useLocaleStore.setState({ locale: 'en-US' })
    if (failure !== 'project') {
      useProjectStore.setState({
        currentProject: {
          id: PROJECT_SESSION.projectId,
          name: 'Repair finalize',
          path: PROJECT_PATH,
          sessionLease: PROJECT_SESSION.leaseId,
        } as never,
      })
    }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:draft-get-finalized') return failure === 'draft' ? null : { id: 17 }
      if (channel === 'db:draft-get-full') return null
      throw new Error(`unexpected IPC: ${channel}`)
    })
    vi.stubGlobal('window', { velaAPI: { invoke } })
    const workflow = createRepairFinalizeWorkflow(3, PROJECT_PATH, PROJECT_SESSION)
    useLocaleStore.setState({ locale: 'zh-CN' })
    const step = workflow.steps[0]!

    await expect(step.executor({
      ...step,
      id: 'repair-finalize-error-step',
      status: 'running',
      logs: [],
    }, { ...context(), uiLocale: workflow.uiLocale! }, callbacks())).rejects.toThrow(expected)
  })
})
