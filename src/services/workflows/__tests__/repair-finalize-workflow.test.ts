import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

import { useWorkflowStore, type StepCallbacks, type WorkflowContext } from '../../../stores/workflow-store'
import { globalEventBus } from '../../../shared/event-bus'
import type { PostProcessStatus } from '../workflow-utils'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { createChapterWorkflow, createRepairFinalizeWorkflow } from '../chapter-workflow'

const postProcess = vi.hoisted(() => ({
  params: [] as Array<Record<string, unknown>>,
  execute: vi.fn<(params: unknown) => Promise<PostProcessStatus>>(),
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

function finalizedSource(content: string) {
  return {
    status: 'valid' as const,
    snapshot: {
      source: {
        draftId: 17,
        finalizationId: 'finalization-17',
        chapterNumber: 3,
        contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
      },
      chapterTitle: '定稿标题',
      content,
      projectionGeneration: 0,
    },
  }
}

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

function postProcessStatus(characterOk = true, notesOk = true): PostProcessStatus {
  return {
    scope: 'chapter_3_finalize',
    sourceLabel: '第3章定稿',
    createdAt: '',
    updatedAt: '',
    allCriticalPassed: notesOk,
    steps: {
      chapter_notes: {
        label: '章节要点', critical: true, ok: notesOk, lastAttemptAt: '', attemptCount: 1,
      },
      character_cards: {
        label: '角色状态', critical: false, ok: characterOk, lastAttemptAt: '', attemptCount: 1,
        ...(!characterOk ? { error: '角色状态提取失败' } : {}),
      },
    },
  }
}

beforeEach(() => {
  postProcess.execute.mockResolvedValue(postProcessStatus())
})

afterEach(() => {
  postProcess.params.length = 0
  postProcess.execute.mockReset()
  useWorkflowStore.setState({
    activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, currentRun: null,
    waitingForConfirm: false, waitingAfterStepIndex: -1,
  })
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

  it.each([
    ['all failed steps', undefined],
    ['one failed step', 'character_cards'],
  ] as const)('retries %s without rerunning successful steps', async (_label, stepKey) => {
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
        case 'db:continuity-read-source':
          return finalizedSource('已定稿正文')
        case 'db:blueprint-get':
          return { title: '定稿标题', characters: ['林舟'] }
        default:
          throw new Error(`unexpected IPC: ${channel}`)
      }
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke } })

    const workflow = createRepairFinalizeWorkflow(3, PROJECT_PATH, PROJECT_SESSION, stepKey)
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
      onlyFailed: true,
      retryInvalidResult: true,
      stepKey,
    })])
    expect(postProcess.execute).toHaveBeenCalledOnce()
  })

  it.each([
    ['all failed-step repair still has a character failure', undefined, false, true, 'failed'],
    ['selected character repair still fails', 'character_cards', false, true, 'failed'],
    ['all failed-step repair succeeds', undefined, true, true, 'completed'],
    ['selected character repair succeeds while notes still fail', 'character_cards', true, false, 'completed'],
  ] as const)('%s reports the requested repair outcome', async (_label, stepKey, characterOk, notesOk, expectedStatus) => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({
      currentProject: {
        id: PROJECT_SESSION.projectId,
        name: 'Repair finalize',
        path: PROJECT_PATH,
        sessionLease: PROJECT_SESSION.leaseId,
        characterStates: '', createdAt: '', updatedAt: '',
        novelConfig: {
          genre: '', subGenre: '', targetAudience: '', totalChapters: 3, wordsPerChapter: 2000,
          plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '',
          worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
        },
      },
    })
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'skills:list-user': return []
        case 'fs:check-exists': return false
        case 'db:draft-get-finalized': return { id: 17 }
        case 'db:draft-get-full': return { content: '已定稿正文' }
        case 'db:continuity-read-source': return finalizedSource('已定稿正文')
        case 'db:blueprint-get': return { title: '定稿标题', characters: ['林舟'] }
        default: throw new Error(`unexpected IPC: ${channel}`)
      }
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke } })
    postProcess.execute.mockResolvedValue(postProcessStatus(characterOk, notesOk))
    const workflow = createRepairFinalizeWorkflow(3, PROJECT_PATH, PROJECT_SESSION, stepKey)
    const completed = vi.fn()
    const openResult = vi.fn()
    const unsubscribe = globalEventBus.on('WORKFLOW_COMPLETE', completed)
    try {
      const runId = await useWorkflowStore.getState().startWorkflow({
        ...workflow,
        onComplete: { ...workflow.onComplete, mode: 'open', openResult },
      })
      expect(postProcess.execute).toHaveBeenCalledOnce()
      const run = useWorkflowStore.getState().history.find(entry => entry.id === runId)
      expect(run).toMatchObject({ status: expectedStatus, steps: [{ status: expectedStatus }] })
      if (expectedStatus === 'failed') {
        expect(run?.error).toContain('角色状态')
        expect(completed).not.toHaveBeenCalled()
        expect(openResult).not.toHaveBeenCalled()
      } else {
        expect(completed).toHaveBeenCalledOnce()
        expect(openResult).toHaveBeenCalledOnce()
      }
    } finally {
      unsubscribe()
    }
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
        case 'db:continuity-read-source':
          return finalizedSource('Finalized manuscript')
        case 'db:blueprint-get':
          return null
        default:
          throw new Error(`unexpected IPC: ${channel}`)
      }
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke } })

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
    vi.stubGlobal('window', { aiNovelAPI: { invoke } })
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
