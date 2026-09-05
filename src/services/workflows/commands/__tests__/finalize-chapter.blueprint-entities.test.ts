import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import { FinalizeChapterCommand } from '../finalize-chapter.command'

const finalizationClient = vi.hoisted(() => ({
  commitFinalizationSnapshot: vi.fn(),
}))

vi.mock('../../../finalization-client', () => finalizationClient)

const PROJECT_PATH = 'C:\\novels\\blueprint-entities'
const PROJECT_SESSION = Object.freeze({
  projectId: 'blueprint-entities',
  leaseId: 'lease-blueprint-entities',
  projectPath: PROJECT_PATH,
})

function workflowContext(uiLocale: 'zh-CN' | 'en-US' = 'zh-CN'): WorkflowContext {
  return {
    runId: 'finalize-blueprint-entities',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    writingLanguage: 'zh-CN',
    uiLocale,
    data: {},
    cancelled: false,
  }
}

function callbacks(): StepCallbacks {
  return {
    log: vi.fn(),
    setProgress: vi.fn(),
    appendText: vi.fn(),
  }
}

function modelLease() {
  return {
    leaseId: 'model-lease-blueprint-entities',
    modelId: 'test-model',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'test-model',
    modelRevision: 'a'.repeat(64),
    endpointFingerprint: 'b'.repeat(64),
    capabilityEvidence: {
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown',
      },
      subjectFingerprint: 'c'.repeat(64),
      contextWindowTokens: null,
      maxOutputTokens: 8192,
      reasoning: null,
      structuredOutput: true,
      usage: null,
    },
    createdAt: 1_000,
    expiresAt: 61_000,
  }
}

describe('FinalizeChapterCommand blueprint character fallback', () => {
  beforeEach(() => {
    finalizationClient.commitFinalizationSnapshot.mockResolvedValue({
      success: true,
      committed: true,
      finalizationId: 'finalization-3',
      contentHash: 'content-hash-3',
      contentRevision: 5,
      draftId: 33,
      publicationStatus: 'published',
    })
    useProjectStore.setState({
      currentProject: {
        id: 'blueprint-entities',
        name: 'Blueprint entities',
        path: PROJECT_PATH,
        sessionLease: PROJECT_SESSION.leaseId,
        novelConfig: {
          globalGuidance: '',
          wordsPerChapter: 1200,
          creativeStrategy: 'auto',
        },
      } as never,
      refreshFileTree: vi.fn().mockResolvedValue(undefined),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useProjectStore.setState({ currentProject: null })
    useLLMStore.setState({ defaultModelId: null })
  })

  it('uses this chapter blueprint characters when direct finalization omits them', async () => {
    const completedSteps = new Set<string>()
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'prompt:load-global':
          return { templates: [], diagnostics: [] }
        case 'fs:check-exists':
          return false
        case 'llm:begin-execution-lease':
          return { success: true, lease: modelLease() }
        case 'llm:close-execution-lease':
          return { success: true }
        case 'db:blueprint-get':
          return { chapterNumber: 3, title: '钟楼真相', characters: ['韩峥'] }
        case 'db:post-process-get-latest-run':
          return null
        case 'db:post-process-create-run':
          return { success: true, id: 'post-process-3' }
        case 'db:post-process-get-steps':
          return [...completedSteps].map((stepKey, index) => ({
            id: index + 1,
            runId: 'post-process-3',
            stepKey,
            label: stepKey,
            critical: stepKey !== 'character_cards',
            ok: true,
            attemptCount: 1,
            completedAt: '2026-08-29T00:00:00.000Z',
            lastAttemptAt: '2026-08-29T00:00:00.000Z',
          }))
        case 'db:post-process-mark-step-ok':
          completedSteps.add(String(args[1]))
          return { success: true }
        case 'kb:import-text':
          return { success: true, docId: 'knowledge-3', chunkCount: 1 }
        case 'db:finalization-link-knowledge-document':
          return { success: true }
        case 'db:continuity-save-finalized':
          return { success: true }
        case 'db:blueprint-update-notes':
          return { success: true, updated: true }
        case 'db:character-roster-read':
          return { status: 'empty', revision: 0, entries: [] }
        default:
          throw new Error(`unexpected IPC: ${channel}`)
      }
    })
    vi.stubGlobal('window', { velaAPI: { invoke } })

    let completionIndex = 0
    useLLMStore.setState({
      defaultModelId: 'test-model',
      generateStream: vi.fn(async (_messages, streamCallbacks) => {
        completionIndex += 1
        streamCallbacks.onDone?.(
          completionIndex === 1
            ? '韩峥被洪水卷入排水井，当场死亡。'
            : '{"updates":[],"newCharacters":[]}',
          undefined,
          'stop',
        )
        return `request-${completionIndex}`
      }),
    })

    const command = new FinalizeChapterCommand({
      draftPath: 'vela://draft/33',
      draftContent: '旧参数正文不得被读取',
      chapterNumber: 3,
      chapterInfo: {
        projectPath: PROJECT_PATH,
        chapterNumber: 3,
        title: '钟楼真相',
        role: '高潮',
        purpose: '揭露真相',
        keyEvents: '韩峥死亡',
        characters: [],
      },
      snapshot: Object.freeze({
        tabId: 'draft-33',
        projectPath: PROJECT_PATH,
        projectSession: PROJECT_SESSION,
        draftId: 33,
        chapterNumber: 3,
        chapterTitle: '钟楼真相',
        content: '韩峥被洪水卷入排水井，当场死亡。',
        contentRevision: 5,
      }),
    })

    const stepCallbacks = callbacks()
    await command.execute({
      step: {},
      context: workflowContext('en-US'),
      callbacks: stepCallbacks,
    })

    expect(invoke).toHaveBeenCalledWith(
      'db:blueprint-get',
      3,
      PROJECT_PATH,
      PROJECT_SESSION,
    )
    const continuityCall = invoke.mock.calls.find(([channel]) => channel === 'db:continuity-save-finalized')
    expect(continuityCall?.[1]).toEqual(expect.objectContaining({
      facts: [expect.objectContaining({
        category: 'character-state',
        entities: ['韩峥'],
        statement: '韩峥被洪水卷入排水井，当场死亡。',
      })],
    }))
    const visibleLogs = vi.mocked(stepCallbacks.log).mock.calls.flat().join('\n')
    expect(visibleLogs).toContain('Starting finalization and post-processing analysis')
    expect(visibleLogs).toContain('Finalized content committed to SQLite and published as a manuscript')
    expect(visibleLogs).toContain('Chapter 3 creation workflow fully completed')
    expect(visibleLogs).not.toMatch(/开始定稿与后处理分析|定稿内容已提交到|创作全流程彻底完成/u)
  })
})
