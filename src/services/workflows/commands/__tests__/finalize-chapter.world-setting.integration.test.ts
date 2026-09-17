import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import { FinalizeChapterCommand } from '../finalize-chapter.command'

const finalizationClient = vi.hoisted(() => ({
  commitFinalizationSnapshot: vi.fn(),
}))

vi.mock('../../../finalization-client', () => finalizationClient)

const PROJECT_PATH = 'C:\\novels\\world-settings'
const PROJECT_SESSION = Object.freeze({
  projectId: 'world-settings',
  leaseId: 'lease-world-settings',
  projectPath: PROJECT_PATH,
})

function workflowContext(): WorkflowContext {
  return {
    runId: 'finalize-world-settings',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
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
    leaseId: 'model-lease-world-settings',
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

/** 世界观设定库里的既有条目（world-setting:list 的返回）。 */
function worldSettingEntry(id: number, name: string, content = '', aliases: string[] = []): Record<string, unknown> {
  return {
    id,
    name,
    aliases,
    summary: '',
    content,
    tags: [],
    importance: 'side',
    related: [],
    source: 'manual',
    status: 'confirmed',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
  }
}

function snapshot(content: string) {
  return Object.freeze({
    tabId: 'draft-33',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    draftId: 33,
    chapterNumber: 3,
    chapterTitle: '山行',
    content,
    contentRevision: 5,
  })
}

function chapterInfo() {
  return {
    projectPath: PROJECT_PATH,
    chapterNumber: 3,
    title: '山行',
    role: '发展',
    purpose: '推进剧情',
    keyEvents: '旅人离开客栈',
    characters: [],
  }
}

/**
 * 跑完整定稿流程，返回 invoke mock（用于断言 world-setting 通道的调用）。
 * `worldResponse` 是 world_settings 步骤（第 3 次 LLM 调用）返回的 JSON。
 */
async function runFinalize(
  content: string,
  worldEntries: Record<string, unknown>[],
  worldResponse: string,
) {
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
        return { chapterNumber: 3, title: '山行', characters: [] }
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
          critical: stepKey !== 'character_cards' && stepKey !== 'world_settings',
          ok: true,
          attemptCount: 1,
          completedAt: '2026-09-18T00:00:00.000Z',
          lastAttemptAt: '2026-09-18T00:00:00.000Z',
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
              contentHash: 'content-hash-3',
            },
            chapterTitle: '山行',
            content,
            projectionGeneration: 0,
          },
        }
      case 'db:blueprint-update-notes':
        return { success: true, updated: true }
      case 'db:character-roster-read':
        return { status: 'empty', revision: 0, entries: [] }
      case 'world-setting:list-chapter-refs':
        return []
      case 'world-setting:list':
        return worldEntries
      case 'world-setting:append-derived':
        return { entry: { id: args[0] }, appended: true }
      case 'world-setting:record-conflict':
        return { id: 1 }
      case 'world-setting:save':
        return { id: 999, name: args[0] }
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
      if (completionIndex === 1) {
        streamCallbacks.onDone?.(content, undefined, 'stop')
      } else if (completionIndex === 2) {
        streamCallbacks.onDone?.('{"updates":[]}', undefined, 'stop')
      } else {
        streamCallbacks.onDone?.(worldResponse, undefined, 'stop')
      }
      return `request-${completionIndex}`
    }),
  })

  const command = new FinalizeChapterCommand({
    draftPath: 'vela://draft/33',
    draftContent: '旧参数正文不得被读取',
    chapterNumber: 3,
    chapterInfo: chapterInfo(),
    snapshot: snapshot(content),
  })

  await command.execute({
    step: {},
    context: workflowContext(),
    callbacks: callbacks(),
  })

  return invoke
}

describe('FinalizeChapterCommand world-setting evidence guard', () => {
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
        id: 'world-settings',
        name: 'World settings',
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

  it('never auto-appends when the model evidence is not in the frozen manuscript', async () => {
    const content = '旅人独自离开了客栈，走向山路。'
    const invoke = await runFinalize(
      content,
      [worldSettingEntry(1, '青云宗', '青云宗已覆灭。')],
      JSON.stringify({
        updates: [{
          entryName: '青云宗',
          evidence: '青云宗已经彻底覆灭。',
          statement: '青云宗已覆灭。',
        }],
        conflicts: [],
        newEntities: [],
      }),
    )

    const appendCalls = invoke.mock.calls.filter(([channel]) => channel === 'world-setting:append-derived')
    expect(appendCalls).toHaveLength(0)
  })

  it('auto-appends once when the evidence does appear in the frozen manuscript', async () => {
    const content = '旅人独自离开了客栈，走向山路。青云宗已经彻底覆灭。'
    const invoke = await runFinalize(
      content,
      [worldSettingEntry(1, '青云宗', '青云宗已覆灭。')],
      JSON.stringify({
        updates: [{
          entryName: '青云宗',
          evidence: '青云宗已经彻底覆灭。',
          statement: '青云宗已覆灭。',
        }],
        conflicts: [],
        newEntities: [],
      }),
    )

    const appendCalls = invoke.mock.calls.filter(([channel]) => channel === 'world-setting:append-derived')
    expect(appendCalls).toHaveLength(1)
    expect(appendCalls[0]).toEqual([
      'world-setting:append-derived',
      1,
      { content: '青云宗已覆灭。' },
      3,
      PROJECT_PATH,
    ])
  })

  it('does not auto-append when a name matches two entries ambiguously', async () => {
    const content = '旅人走进了东城商会。'
    const invoke = await runFinalize(
      content,
      [
        worldSettingEntry(1, '东城商会'),
        worldSettingEntry(2, '西城商会'),
      ],
      JSON.stringify({
        updates: [{
          entryName: '商会',
          evidence: '旅人走进了东城商会。',
          statement: '旅人去了商会。',
        }],
        conflicts: [],
        newEntities: [],
      }),
    )

    const appendCalls = invoke.mock.calls.filter(([channel]) => channel === 'world-setting:append-derived')
    expect(appendCalls).toHaveLength(0)
    // 歧义名字转入待确认候选（走 world-setting:save），而不是自动追加。
    const saveCalls = invoke.mock.calls.filter(([channel]) => channel === 'world-setting:save')
    expect(saveCalls.length).toBeGreaterThan(0)
  })

  it('does not auto-append a duplicate alias reported as a new entity', async () => {
    const content = '旅人路过北境仙门。'
    const invoke = await runFinalize(
      content,
      [
        worldSettingEntry(1, '青云宗', '', ['北境仙门']),
        worldSettingEntry(2, '太玄宗', '', ['北境仙门']),
      ],
      JSON.stringify({
        updates: [],
        conflicts: [],
        // 模型把「北境仙门」报成新实体，但它其实是两个条目的重复别名，
        // 同名转追加分支必须与 updates 一样拒绝歧义归属。
        newEntities: [{
          name: '北境仙门',
          evidence: '旅人路过北境仙门。',
          statement: '北境仙门出现了。',
        }],
      }),
    )

    const appendCalls = invoke.mock.calls.filter(([channel]) => channel === 'world-setting:append-derived')
    expect(appendCalls).toHaveLength(0)
    // 重复别名不自动归属，转成待确认候选让作者裁决。
    const saveCalls = invoke.mock.calls.filter(([channel]) => channel === 'world-setting:save')
    expect(saveCalls.length).toBeGreaterThan(0)
  })
})
