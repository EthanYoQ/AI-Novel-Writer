import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import { FinalizeChapterCommand } from '../finalize-chapter.command'
import type { FinalizedCharacterContext } from '../../../../shared/finalized-continuity'

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
const CONTENT = '韩峥被洪水卷入排水井，当场死亡。'
const CONTENT_HASH = createHash('sha256').update(CONTENT).digest('hex')
const finalizedContext = (): FinalizedCharacterContext => ({ projectId: PROJECT_SESSION.projectId, epoch: PROJECT_SESSION.leaseId,
  source: { draftId: 33, finalizationId: 'finalization-3', chapterNumber: 3, contentHash: CONTENT_HASH }, content: CONTENT,
  identityRevision: 0, identityStatus: 'bound', projectionGeneration: 0, characters: [],
  sourceOrder: { continuityEpoch: `${PROJECT_SESSION.projectId}:0`, chapterNumber: 3, authoritativeFinalizationRevision: 1 },
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

describe('FinalizeChapterCommand blueprint character fallback', () => {
  beforeEach(() => {
    finalizationClient.commitFinalizationSnapshot.mockResolvedValue({
      success: true,
      committed: true,
      finalizationId: 'finalization-3',
      contentHash: CONTENT_HASH,
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

  it('uses a positive source revision when a batch draft has no editor tab', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:draft-get-meta') return { id: 33, version: 1, status: 'draft', source: 'write' }
      throw new Error(`unexpected IPC: ${channel}`)
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke } })
    const command = new FinalizeChapterCommand({
      draftPath: 'ai-novel://draft/33',
      draftContent: CONTENT,
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
    })
    const snapshot = await command['createBatchSnapshot'](workflowContext(), PROJECT_PATH)
    expect(snapshot).toMatchObject({ contentRevision: 1, content: CONTENT, draftId: 33 })
    expect(invoke).toHaveBeenCalledWith('db:draft-get-meta', 33, PROJECT_PATH, PROJECT_SESSION)
  })

  it('uses this chapter blueprint characters when direct finalization omits them', async () => {
    const completedSteps = new Set<string>()
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      switch (channel) {
        case 'finalization-generation:read': {
          const slot = (args[0] as { slot: { source: unknown; stepKey: string } }).slot
          return { view: { handle: { projectId: PROJECT_SESSION.projectId, epoch: PROJECT_SESSION.leaseId, rootActionId: 'main-root', runId: slot.stepKey }, artifacts: [], status: 'completed' },
            modelId: 'original-main-model', context: { slot }, sourceStatus: 'current',
            effect: slot.stepKey === 'chapter_notes' ? { success: true, stepKey: slot.stepKey, chapterNotes: '韩峥被洪水卷入排水井，当场死亡。', factCount: 1, blueprintUpdated: true }
              : { success: true, stepKey: slot.stepKey, applied: 0, unchanged: 0, candidates: [], unresolved: [] } }
        }

        case 'prompt:load-global':
          return { templates: [], diagnostics: [] }
        case 'fs:check-exists':
          return false
        case 'finalized-character:read-context':
          return { contextId: 'synthetic-context-33', context: finalizedContext() }
        case 'finalized-character:commit':
          return { applied: 0, unchanged: 0, candidates: [], unresolved: [] }
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
        case 'db:continuity-read-source':
          return {
            status: 'valid',
            snapshot: {
              source: {
                draftId: 33,
                finalizationId: 'finalization-3',
                chapterNumber: 3,
                contentHash: CONTENT_HASH,
              },
              chapterTitle: '钟楼真相',
              content: '韩峥被洪水卷入排水井，当场死亡。',
              projectionGeneration: 0,
            },
          }
        case 'db:blueprint-update-notes':
          return { success: true, updated: true }
        case 'db:character-roster-read':
          return { status: 'empty', revision: 0, entries: [] }
        default:
          throw new Error(`unexpected IPC: ${channel}`)
      }
    })
    vi.stubGlobal('window', { aiNovelAPI: { invoke } })

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
      draftPath: 'ai-novel://draft/33',
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
    expect(invoke.mock.calls.filter(([channel]) => channel === 'finalization-generation:read').map(([, request]) => request)).toEqual([
      { slot: { source: { draftId: 33, finalizationId: 'finalization-3', chapterNumber: 3, contentHash: CONTENT_HASH }, stepKey: 'chapter_notes' } },
      { slot: { source: { draftId: 33, finalizationId: 'finalization-3', chapterNumber: 3, contentHash: CONTENT_HASH }, stepKey: 'character_cards' } },
    ])
    expect(invoke.mock.calls.some(([channel]) => ['db:continuity-save-finalized', 'db:blueprint-update-notes', 'finalization-generation:begin', 'finalization-generation:execute', 'finalization-generation:commit'].includes(channel))).toBe(false)
    expect(completedSteps).toEqual(new Set(['kb_import', 'chapter_notes', 'character_cards']))
    const visibleLogs = vi.mocked(stepCallbacks.log).mock.calls.flat().join('\n')
    expect(visibleLogs).toContain('Starting finalization and post-processing analysis')
    expect(visibleLogs).toContain('Finalized content committed to SQLite and published as a manuscript')
    expect(visibleLogs).toContain('Chapter 3 creation workflow fully completed')
    expect(visibleLogs).not.toMatch(/开始定稿与后处理分析|定稿内容已提交到|创作全流程彻底完成/u)
  })
})
