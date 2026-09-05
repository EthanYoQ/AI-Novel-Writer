import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { useProjectStore } from '../../../../stores/project-store'
import {
  GenerationAttemptError,
  type GenerationAttemptReceipt,
  type GenerationSession,
  type GenerationTask,
} from '../../../generation/generation-harness'
import type { GenerationRuntime } from '../../../generation/generation-runtime'
import {
  DirectoryPostCommitCancellationError,
  DirectoryPostCommitSyncError,
  DirectoryCostLimitError,
  GenerateDirectoryCommand,
  retryDirectoryCharacterSync,
} from '../directory.command'
import { listPendingDirectoryCharacterSyncs } from '../../directory-character-sync-recovery'

type Blueprint = {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  newCharacterCandidates?: Array<{ name: string; role: 'protagonist' | 'antagonist' | 'supporting' | 'minor' }>
  suspenseHook: string
  userGuidance: string
  notes: string
  notesUpdatedAt: string
  relationshipHints: unknown
}

const projectSnapshot = {
  expectedProjectPath: 'C:\\tmp\\vela-test',
  novelConfig: {
    totalChapters: 5,
    globalGuidance: '',
    genre: '玄幻',
  },
}

let authoritySequenceResult: Record<string, unknown>

function workflowContext(): WorkflowContext {
  return {
    runId: 'test-run',
    projectPath: projectSnapshot.expectedProjectPath,
    projectSession: {
      projectId: 'project-1',
      leaseId: 'lease-project-1',
      projectPath: projectSnapshot.expectedProjectPath,
    },
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    data: { architecture: '故事前提'.repeat(30) },
    cancelled: false,
  }
}

function stepCallbacks(): StepCallbacks {
  return {
    log: vi.fn(),
    setProgress: vi.fn(),
    appendText: vi.fn(),
  }
}

function blueprint(chapterNumber: number, overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    chapterNumber,
    title: `第${chapterNumber}章`,
    role: '发展',
    purpose: `推进第${chapterNumber}章`,
    keyEvents: `第${chapterNumber}章发生关键事件`,
    characters: [],
    relationshipHints: [],
    suspenseHook: `第${chapterNumber}章留下新的悬念`,
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
    ...overrides,
  }
}

function modelBlueprint(chapterNumber: number, overrides: Partial<Blueprint> = {}): Record<string, unknown> {
  const candidate = blueprint(
    chapterNumber,
    { characters: ['主角'], ...overrides },
  )
  return {
    chapterNumber: candidate.chapterNumber,
    title: candidate.title,
    role: candidate.role,
    purpose: candidate.purpose,
    keyEvents: candidate.keyEvents,
    characters: candidate.characters,
    newCharacterCandidates: candidate.newCharacterCandidates,
    relationships: candidate.relationshipHints,
    suspenseHook: candidate.suspenseHook,
  }
}

function blueprintJson(chapterNumbers: readonly number[]): string {
  return JSON.stringify({ blueprints: chapterNumbers.map(chapterNumber => modelBlueprint(chapterNumber)) })
}

function generationReceipt(
  attempt: number,
  finishReason: GenerationAttemptReceipt['finishReason'],
  purpose?: string,
): GenerationAttemptReceipt {
  return {
    ...(purpose ? { purpose } : {}),
    model: {
      id: 'model-1',
      configurationRevision: 'revision-1',
      endpointFingerprint: 'endpoint-1',
    },
    capabilities: {
      contextWindowTokens: null,
      maxOutputTokens: 4096,
      reasoning: null,
      structuredOutput: true,
      usage: true,
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'legacy-profile',
        featureFlags: 'unknown',
      },
    },
    budget: Object.freeze({
      attempt,
      maxAttempts: 20,
      requestedOutputTokens: 4096,
      cumulativeRequestedOutputTokens: attempt * 4096,
      maxRequestedOutputTokens: 100_000,
      maxRequestedOutputTokensPerAttempt: 4096,
      deadlineAt: Number.MAX_SAFE_INTEGER,
    }),
    finishReason,
  }
}

function generationSession(
  complete: GenerationSession['complete'],
): GenerationSession {
  return {
    budget: Object.freeze({
      maxAttempts: 20,
      maxRequestedOutputTokens: 100_000,
      maxRequestedOutputTokensPerAttempt: 4096,
      deadlineAt: Number.MAX_SAFE_INTEGER,
    }),
    complete,
  }
}

function testRuntime(session: GenerationSession): GenerationRuntime & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {})
  return {
    execute: operation => operation({
      session,
    }),
    close,
  }
}

function taskRange(task: GenerationTask): [number, number] {
  const prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
  const match = /第(\d+)章到第(\d+)章/u.exec(prompt)
  const compactMatch = /targetChapterNumber"?\s*:\s*(\d+)/u.exec(prompt)
  if (!match && compactMatch) return [Number(compactMatch[1]), Number(compactMatch[1])]
  if (!match) throw new Error(`missing directory range in prompt: ${prompt}`)
  return [Number(match[1]), Number(match[2])]
}

function stubIpcInvoke(handler: (channel: string, ...args: unknown[]) => unknown) {
  const invoke = vi.fn((channel: string, ...args: unknown[]) => Promise.resolve(
    channel === 'prompt:load-global' ? { templates: [], diagnostics: [] }
      : channel === 'fs:check-exists' && String(args[0]).endsWith('/.vela/prompts') ? false
        : channel === 'db:draft-authority-sequence' ? authoritySequenceResult
        : handler(channel, ...args),
  ))
  vi.stubGlobal('window', {
    velaAPI: {
      invoke,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  return invoke
}

function successfulCommitHandler(overrides: {
  snapshot?: readonly Blueprint[]
  other?: (channel: string, ...args: unknown[]) => unknown
} = {}) {
  const syncOperations = new Map<string, Record<string, unknown>>()
  return (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-commit-range') {
      const request = args[0] as {
        mode: 'full' | 'replace-range'
        operationId: string
        startChapter: number
        endChapter: number
        blueprints: Blueprint[]
      }
      const snapshot = overrides.snapshot ?? request.blueprints
      const characterSyncInput = snapshot.map(item => (
        item.characters.length === 1
          && item.characters[0] === '主角'
          && Array.isArray(item.relationshipHints)
          && item.relationshipHints.length === 0
          ? { ...item, characters: [] }
          : item
      ))
      const syncOperation = {
        operationId: `blueprint-sync-${request.operationId}`,
        blueprintCommitOperationId: request.operationId,
        blueprintCommitPayloadHash: 'a'.repeat(64),
        status: 'pending',
        startChapter: request.startChapter,
        endChapter: request.endChapter,
        characterSyncInput,
        createdAt: '2026-01-01 00:00:00',
        updatedAt: '2026-01-01 00:00:00',
      }
      syncOperations.set(syncOperation.operationId, syncOperation)
      return {
        success: true,
        receipt: {
          mode: request.mode,
          operationId: request.operationId,
          payloadHash: 'a'.repeat(64),
          idempotent: false,
          startChapter: request.startChapter,
          endChapter: request.endChapter,
          chapterNumbers: snapshot.map(item => item.chapterNumber),
          snapshot,
          characterSyncInput,
          characterSyncOperation: syncOperation,
        },
      }
    }
    if (channel === 'db:blueprint-character-sync-list-pending') {
      return [...syncOperations.values()].filter(operation => operation.status === 'pending')
    }
    if (channel === 'db:blueprint-character-sync-get') {
      return syncOperations.get(String(args[0])) ?? null
    }
    if (channel === 'db:blueprint-character-sync-complete') {
      const operationId = String(args[0])
      const operation = syncOperations.get(operationId)
      if (!operation) return { success: false, error: 'operation missing' }
      const completionReceipt = {
        blueprintCommitOperationId: operation.blueprintCommitOperationId,
        operationId,
        status: 'already-satisfied',
      }
      const completed = {
        ...operation,
        status: 'completed',
        completionReceipt,
        completedAt: '2026-01-01 00:01:00',
        updatedAt: '2026-01-01 00:01:00',
      }
      syncOperations.set(operationId, completed)
      return { success: true, operation: completed }
    }
    return overrides.other?.(channel, ...args) ?? { success: true }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  authoritySequenceResult = {
    status: 'empty',
    lastChapterNumber: 0,
    nextChapterNumber: 1,
    duplicateChapterNumbers: [],
    authorityFingerprint: 'f'.repeat(64),
  }
  useProjectStore.setState({
    currentProject: {
      id: 'project-1',
      name: '测试项目',
      path: projectSnapshot.expectedProjectPath,
      sessionLease: 'lease-project-1',
      novelConfig: {
        genre: '玄幻',
        subGenre: '',
        targetAudience: '男频',
        totalChapters: 5,
        wordsPerChapter: 3000,
        plotStructure: 'three_act',
        narrativePOV: 'third_limited',
        coreOutline: '',
        worldSetting: '',
        goldenFinger: '',
        protagonistProfile: '',
        globalGuidance: '',
      },
      characterStates: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useProjectStore.setState({ currentProject: null })
})

describe('GenerateDirectoryCommand', () => {
  it('uses finalized authority as the default append start when no explicit range is supplied', async () => {
    authoritySequenceResult = {
      status: 'continuous',
      lastChapterNumber: 9,
      nextChapterNumber: 10,
      duplicateChapterNumbers: [],
      authorityFingerprint: 'a'.repeat(64),
    }
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([10]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'append', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 10 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await command.execute({ step: {}, context: workflowContext(), callbacks: stepCallbacks() })

    expect(invoke.mock.calls.find(([channel]) => channel === 'db:blueprint-commit-range')?.[1])
      .toMatchObject({ startChapter: 10, endChapter: 10 })
  })

  it('fails before opening a runtime when finalized authority is discontinuous', async () => {
    authoritySequenceResult = {
      status: 'invalid',
      lastChapterNumber: 9,
      firstGapChapterNumber: 4,
      duplicateChapterNumbers: [],
      authorityFingerprint: 'b'.repeat(64),
    }
    stubIpcInvoke(successfulCommitHandler())
    const createRuntime = vi.fn()
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      projectSnapshot,
      { createRuntime: createRuntime as never },
    )

    await expect(command.execute({ step: {}, context: workflowContext(), callbacks: stepCallbacks() }))
      .rejects.toThrow(/权威定稿缺少第 4 章/u)
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it('sends English blueprint instructions through the provider request for an English project', async () => {
    stubIpcInvoke(successfulCommitHandler())
    const observedTasks: GenerationTask[] = []
    const session = generationSession(async task => {
      observedTasks.push(task)
      const prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
      const diagnosticRebuild = prompt.includes('[Previous contract violation]')
      return {
        status: 'completed',
        content: JSON.stringify({
          blueprints: [modelBlueprint(1, {
            role: 'inciting incident',
            relationshipHints: diagnosticRebuild
              ? []
              : [{ from: '主角', to: 'Unknown character', relation: 'rival' }],
            suspenseHook: 'A sealed letter names the next suspect.',
          })],
        }),
        finishReason: 'stop',
        receipt: generationReceipt(observedTasks.length, 'stop', task.purpose),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      {
        ...projectSnapshot,
        novelConfig: {
          ...projectSnapshot.novelConfig,
          genre: '科幻',
          totalChapters: 1,
        },
      },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )
    const context = {
      ...workflowContext(),
      writingLanguage: 'en-US' as const,
      data: { architecture: 'The sign “夜航 Café” must remain byte-for-byte unchanged.' },
    }

    await command.execute({ step: {}, context, callbacks: stepCallbacks() })

    const observedTask = observedTasks.at(-1)
    const system = observedTask?.messages.find(message => message.role === 'system')?.content ?? ''
    const user = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(observedTasks).toHaveLength(2)
    expect(observedTasks.map(task => task.purpose)).toEqual([
      'chapter-blueprint-directory',
      'chapter-blueprint-directory:compact-single:chapter-1',
    ])
    expect(observedTask?.purpose).toBe('chapter-blueprint-directory:compact-single:chapter-1')
    expect(system).toContain('You are an experienced chapter architect')
    expect(system).toContain('[Immutable system contract]')
    expect(user).toContain('Build the complete chapter blueprint from only the bounded facts below.')
    expect(user).toContain('"suspenseHookCharacters":160')
    expect(user).toContain('"role":"short structural label"')
    expect(user).toContain('code=relationship_endpoint_not_in_characters path=blueprints[0].relationships[0]')
    expect(user).not.toContain('actualCharacters')
    expect(user).toContain('Science fiction')
    expect(user).not.toContain('科幻')
    expect(user).toContain('The sign “夜航 Café” must remain byte-for-byte unchanged.')
    expect(user).not.toContain('【不可变蓝图 JSON 合同】')
  })

  it('keeps an English project in English when the actual blueprint request enters syntax repair', async () => {
    stubIpcInvoke(successfulCommitHandler())
    const completeBlueprint = JSON.stringify({
      blueprints: [modelBlueprint(1, { title: 'Café 夜航' })],
    })
    const malformedBlueprint = completeBlueprint.slice(0, -2)
    let attempt = 0
    const session = generationSession(async task => {
      attempt += 1
      if (attempt === 1) {
        return {
          status: 'completed',
          content: malformedBlueprint,
          finishReason: 'stop',
          receipt: generationReceipt(attempt, 'stop', task.purpose),
        }
      }

      const system = task.messages.find(message => message.role === 'system')?.content ?? ''
      const user = task.messages.find(message => message.role === 'user')?.content ?? ''
      expect(user).toContain('[Supplemental writing skill: Blueprint craft]')
      expect(user).toContain('Preserve causal structure across chapters.')
      expect(task.purpose).toBe('chapter-blueprint-directory:structured-syntax-repair')
      expect(system).toContain('You repair JSON syntax')
      expect(system).not.toContain('你是结构化 JSON 语法修复器')
      expect(user).toContain(malformedBlueprint)
      expect(user).toContain('Café 夜航')
      return {
        status: 'completed',
        content: completeBlueprint,
        finishReason: 'stop',
        receipt: generationReceipt(attempt, 'stop', task.purpose),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )
    const context = {
      ...workflowContext(),
      writingLanguage: 'en-US' as const,
      writingSkills: Object.freeze({
        planning: Object.freeze({
          skillId: 'user:blueprint-craft', name: 'Blueprint craft', stage: 'planning' as const,
          source: 'user' as const, writingLanguage: 'en-US' as const,
          content: 'Preserve causal structure across chapters.', utf8Bytes: 42,
        }),
      }),
    }

    const result = await command.execute({ step: {}, context, callbacks: stepCallbacks() })

    expect(result[0]?.title).toBe('Café 夜航')
    expect(attempt).toBe(2)
  })

  it('allows a new directory run while an older character sync remains independently retryable', async () => {
    const operation = {
      operationId: 'blueprint-sync-previous-run',
      blueprintCommitOperationId: 'previous-run',
      blueprintCommitPayloadHash: 'a'.repeat(64),
      status: 'pending',
      startChapter: 1,
      endChapter: 2,
      characterSyncInput: [blueprint(1, { characters: ['林岚'] })],
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    }
    const commitHandler = successfulCommitHandler()
    stubIpcInvoke((channel, ...args) => (
      channel === 'db:blueprint-character-sync-list-pending'
        ? [operation]
        : commitHandler(channel, ...args)
    ))
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([1]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const createRuntime = vi.fn(async () => testRuntime(session))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result).toHaveLength(1)
    expect(createRuntime).toHaveBeenCalledOnce()
  })

  it('keeps a larger logical range in one transaction while the executor makes ordered five-item batches', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observedRanges: Array<[number, number]> = []
    let firstPrompt = ''
    const session = generationSession(async task => {
      if (!firstPrompt) firstPrompt = task.messages.find(message => message.role === 'user')?.content ?? ''
      const range = taskRange(task)
      observedRanges.push(range)
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(observedRanges.length, 'stop'),
      }
    })
    const createRuntime = vi.fn(async () => testRuntime(session))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 7 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 7 } },
      { createRuntime },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result.map(item => item.chapterNumber)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(observedRanges).toEqual([[1, 5], [6, 7]])
    expect(firstPrompt).toContain('【不可变蓝图 JSON 合同】')
    for (const field of ['chapterNumber', 'title', 'role', 'purpose', 'keyEvents', 'characters', 'relationships', 'suspenseHook']) {
      expect(firstPrompt).toContain(field)
    }
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
    expect(createRuntime).toHaveBeenCalledWith({
      budget: {
        maxAttempts: 20,
        maxRequestedOutputTokens: 81_920,
        maxRequestedOutputTokensPerAttempt: 4_096,
        deadlineMs: 1_800_000,
      },
    })
  })

  it('opens one runtime for an eleven-chapter append with the authoritative bounded cost plan', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observedRanges: Array<[number, number]> = []
    const session = generationSession(async task => {
      const range = taskRange(task)
      observedRanges.push(range)
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(observedRanges.length, 'stop'),
      }
    })
    const createRuntime = vi.fn(async () => testRuntime(session))
    const command = new GenerateDirectoryCommand(
      { mode: 'append', startChapter: 10, count: 11 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 20 } },
      { createRuntime },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result.map(item => item.chapterNumber))
      .toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    expect(observedRanges).toEqual([[10, 14], [15, 19], [20, 20]])
    expect(createRuntime).toHaveBeenCalledWith({
      budget: {
        maxAttempts: 31,
        maxRequestedOutputTokens: 126_976,
        maxRequestedOutputTokensPerAttempt: 4_096,
        deadlineMs: 1_800_000,
      },
    })
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
  })

  it('commits append generation as an exact replace-range operation', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const session = generationSession(async task => {
      const range = taskRange(task)
      return {
        status: 'completed',
        content: blueprintJson([range[0], range[1]]),
        finishReason: 'stop',
        receipt: generationReceipt(1, 'stop'),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'append', startChapter: 2, count: 2 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(invoke.mock.calls.find(([channel]) => channel === 'db:blueprint-commit-range')?.[1])
      .toMatchObject({
        mode: 'replace-range',
        startChapter: 2,
        endChapter: 3,
        blueprints: [{ chapterNumber: 2 }, { chapterNumber: 3 }],
      })
  })

  it('writes nothing when a later five-item semantic batch fails', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    let attempt = 0
    const session = generationSession(async () => {
      attempt += 1
      if (attempt === 1) {
        return {
          status: 'completed',
          content: blueprintJson([1, 2, 3, 4, 5]),
          finishReason: 'stop',
          receipt: generationReceipt(attempt, 'stop'),
        }
      }
      throw new GenerationAttemptError(
        'PROVIDER_REQUEST_FAILED',
        '模型请求失败。',
        generationReceipt(attempt, 'error'),
      )
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 7 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 7 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/模型请求失败/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-upsert-many')
  })

  it('rejects a scope beyond the absolute task-cost cap before opening a runtime', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const createRuntime = vi.fn(async () => testRuntime(generationSession(async () => {
      throw new Error('must not generate')
    })))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 51 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 51 } },
      { createRuntime },
    )

    const failure = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    }).then(() => null, error => error as unknown)

    expect(failure).toBeInstanceOf(DirectoryCostLimitError)
    expect(failure).toMatchObject({ code: 'DIRECTORY_TASK_COST_LIMIT', chapterCount: 51 })
    expect((failure as Error).message).toMatch(/每段不超过 50 章/u)
    expect(createRuntime).not.toHaveBeenCalled()
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })

  it('rejects an append range beyond the project boundary instead of reporting an empty success', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const createRuntime = vi.fn(async () => testRuntime(generationSession(async () => {
      throw new Error('must not generate')
    })))
    const command = new GenerateDirectoryCommand(
      { mode: 'append', startChapter: 6, count: 1 },
      projectSnapshot,
      { createRuntime },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/章节范围无效/u)

    expect(createRuntime).not.toHaveBeenCalled()
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })

  it('splits a five-chapter length outcome into ordered 2+3 batches and commits once', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observedRanges: Array<[number, number]> = []
    const createRuntime = vi.fn(async () => testRuntime(session))
    let attempt = 0
    const session = generationSession(async (task) => {
      attempt += 1
      const range = taskRange(task)
      observedRanges.push(range)
      if (attempt === 1) {
        return {
          status: 'incomplete',
          content: '{"blueprints":[',
          finishReason: 'length',
          receipt: generationReceipt(attempt, 'length'),
        }
      }
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(attempt, 'stop'),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 5 },
      projectSnapshot,
      { createRuntime },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result.map(item => item.chapterNumber)).toEqual([1, 2, 3, 4, 5])
    expect(observedRanges).toEqual([[1, 5], [1, 2], [3, 5]])
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
    expect(createRuntime).toHaveBeenCalledWith({
      budget: {
        maxAttempts: 15,
        maxRequestedOutputTokens: 61_440,
        maxRequestedOutputTokensPerAttempt: 4_096,
        deadlineMs: 1_800_000,
      },
    })
  })

  it('replaces one length-truncated single blueprint in full on the same runtime and commits once', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observed: Array<{ range: [number, number]; purpose: string }> = []
    const authorGuidance = `KEEP-FULL-${'g'.repeat(1_300)}-END`
    let attempt = 0
    const session = generationSession(async (task) => {
      attempt += 1
      const range = taskRange(task)
      observed.push({ range, purpose: task.purpose })
      if (task.purpose.includes(':compact-single:')) {
        const prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
        expect(prompt).toContain(authorGuidance)
        expect(task.promptBudget).toMatchObject({
          limitUtf8Bytes: 16_384,
          sections: expect.arrayContaining([
            expect.objectContaining({ sectionName: 'global-guidance', messageIndex: 1 }),
          ]),
        })
      }
      if (attempt <= 2) {
        return {
          status: 'incomplete',
          content: '{"blueprints":[',
          finishReason: 'length',
          receipt: generationReceipt(attempt, 'length'),
        }
      }
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(attempt, 'stop'),
      }
    })
    const createRuntime = vi.fn(async () => testRuntime(session))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 2 },
      {
        ...projectSnapshot,
        novelConfig: { ...projectSnapshot.novelConfig, globalGuidance: authorGuidance },
      },
      { createRuntime },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result.map(item => item.chapterNumber)).toEqual([1, 2])
    expect(observed).toEqual([
      { range: [1, 2], purpose: 'chapter-blueprint-directory' },
      { range: [1, 1], purpose: 'chapter-blueprint-directory' },
      { range: [1, 1], purpose: 'chapter-blueprint-directory:compact-single:chapter-1' },
      { range: [2, 2], purpose: 'chapter-blueprint-directory' },
    ])
    expect(createRuntime).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
  })

  it('commits no directory facts when the single-item replacement is also length-truncated', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const callbacks = stepCallbacks()
    let attempt = 0
    const session = generationSession(async (task) => {
      attempt += 1
      return {
        status: 'incomplete',
        content: '{"blueprints":[',
        finishReason: 'length',
        receipt: generationReceipt(attempt, 'length', task.purpose),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const failure = await command.execute({
      step: {},
      context: { ...workflowContext(), uiLocale: 'en-US' },
      callbacks,
    }).then(() => null, error => error as Error)

    expect(failure?.message).not.toMatch(/[\u3400-\u9fff]/u)
    expect(failure?.message).toContain('code=limit_exceeded reason=output_limit')
    expect(failure?.message).toContain(
      'purpose=chapter-blueprint-directory:compact-single:chapter-1 finishReason=length requestedTokens=4096',
    )
    expect(attempt).toBe(2)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining(
      'purpose=chapter-blueprint-directory:compact-single:chapter-1 finishReason=length requestedTokens=4096',
    ))
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-upsert-many')
  })

  it('replays the observed split sequence and recovers chapter 18 with one bounded compact task', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const observed: Array<{ range: [number, number]; purpose: string }> = []
    const lengthAttempts = new Set([1, 3, 6, 8, 10, 11])
    const session = generationSession(async task => {
      const attempt = observed.length + 1
      const range = taskRange(task)
      observed.push({ range, purpose: task.purpose })
      if (lengthAttempts.has(attempt)) {
        return {
          status: 'incomplete',
          content: '{"blueprints":[{"chapterNumber":18,"keyEvents":"不可信截断片段',
          finishReason: 'length',
          receipt: generationReceipt(attempt, 'length', task.purpose),
        }
      }
      if (task.purpose.includes(':compact-single:')) {
        const prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
        const taskBytes = task.messages.reduce(
          (total, message) => total + new TextEncoder().encode(message.content).byteLength,
          0,
        )
        expect(taskBytes).toBeLessThanOrEqual(16_384)
        expect(prompt).not.toContain('不可信截断片段')
      }
      const chapters = Array.from(
        { length: range[1] - range[0] + 1 },
        (_, index) => range[0] + index,
      )
      return {
        status: 'completed',
        content: blueprintJson(chapters),
        finishReason: 'stop',
        receipt: generationReceipt(attempt, 'stop', task.purpose),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'append', startChapter: 10, count: 11 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 20 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )
    const context = workflowContext()
    context.data.architecture = '极长架构事实。'.repeat(20_000)

    const result = await command.execute({ step: {}, context, callbacks: stepCallbacks() })

    expect(result.map(item => item.chapterNumber)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    expect(observed).toEqual([
      { range: [10, 14], purpose: 'chapter-blueprint-directory' },
      { range: [10, 11], purpose: 'chapter-blueprint-directory' },
      { range: [12, 14], purpose: 'chapter-blueprint-directory' },
      { range: [12, 12], purpose: 'chapter-blueprint-directory' },
      { range: [13, 14], purpose: 'chapter-blueprint-directory' },
      { range: [15, 19], purpose: 'chapter-blueprint-directory' },
      { range: [15, 16], purpose: 'chapter-blueprint-directory' },
      { range: [17, 19], purpose: 'chapter-blueprint-directory' },
      { range: [17, 17], purpose: 'chapter-blueprint-directory' },
      { range: [18, 19], purpose: 'chapter-blueprint-directory' },
      { range: [18, 18], purpose: 'chapter-blueprint-directory' },
      { range: [18, 18], purpose: 'chapter-blueprint-directory:compact-single:chapter-18' },
      { range: [19, 19], purpose: 'chapter-blueprint-directory' },
      { range: [20, 20], purpose: 'chapter-blueprint-directory' },
    ])
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
  })

  it('writes nothing when the later split fails after the earlier split validated', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    let attempt = 0
    const session = generationSession(async () => {
      attempt += 1
      if (attempt === 1) {
        return {
          status: 'incomplete',
          content: '{"blueprints":[',
          finishReason: 'length',
          receipt: generationReceipt(attempt, 'length'),
        }
      }
      if (attempt === 2) {
        return {
          status: 'completed',
          content: blueprintJson([1, 2]),
          finishReason: 'stop',
          receipt: generationReceipt(attempt, 'stop'),
        }
      }
      throw new GenerationAttemptError(
        'PROVIDER_REQUEST_FAILED',
        '模型请求失败。',
        generationReceipt(attempt, 'error'),
      )
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 5 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/模型请求失败/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-upsert-many')
  })

  it('requires exact chapter coverage before any database write', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([1, 3]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 3 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/code=unexpected_item path=blueprints/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })

  it('bounds an overlong generated suspense hook and commits without another model call', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const overlongHook = 'h'.repeat(180)
    const complete = vi.fn(async () => ({
      status: 'completed',
      content: JSON.stringify({ blueprints: [modelBlueprint(1, { suspenseHook: overlongHook })] }),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    } as const))
    const session = generationSession(complete)
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(complete).toHaveBeenCalledOnce()
    expect(result[0]?.suspenseHook).toBe('h'.repeat(160))
    expect(invoke.mock.calls.find(([channel]) => channel === 'db:blueprint-commit-range')?.[1])
      .toMatchObject({ blueprints: [expect.objectContaining({ suspenseHook: 'h'.repeat(160) })] })
  })

  it('bounds an overlong generated relationship description and commits without another model call', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler({
      other: channel => channel === 'db:character-roster-read'
        ? { status: 'empty', revision: 0, entries: [] }
        : { success: true },
    }))
    const overlongRelation = 'r'.repeat(105)
    const complete = vi.fn(async () => ({
      status: 'completed',
      content: JSON.stringify({
        blueprints: [modelBlueprint(1, {
          characters: ['主角', '盟友'],
          relationshipHints: [{ from: '主角', to: '盟友', relation: overlongRelation }],
        })],
      }),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    } as const))
    const session = generationSession(complete)
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    const boundedRelation = 'r'.repeat(80)
    expect(complete).toHaveBeenCalledOnce()
    expect(result[0]?.relationshipHints).toEqual([
      { from: '主角', to: '盟友', relation: boundedRelation },
    ])
    expect(invoke.mock.calls.find(([channel]) => channel === 'db:blueprint-commit-range')?.[1])
      .toMatchObject({
        blueprints: [expect.objectContaining({
          relationshipHints: [{ from: '主角', to: '盟友', relation: boundedRelation }],
        })],
      })
  })

  it('normalizes all safe overlong text when a supported relationship alias triggers recovery', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler({
      other: channel => channel === 'db:character-roster-read'
        ? { status: 'empty', revision: 0, entries: [] }
        : { success: true },
    }))
    const candidate = modelBlueprint(1, {
      characters: ['主角', '盟友'],
      purpose: 'p'.repeat(260),
    })
    delete candidate.relationships
    candidate.relationshipHints = [
      { from: '主角', to: '盟友', relation: 'r'.repeat(105) },
    ]
    const complete = vi.fn(async () => ({
      status: 'completed',
      content: JSON.stringify({ blueprints: [candidate] }),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    } as const))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(generationSession(complete))) },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(complete).toHaveBeenCalledOnce()
    expect(result[0]).toMatchObject({
      purpose: 'p'.repeat(240),
      relationshipHints: [{ from: '主角', to: '盟友', relation: 'r'.repeat(80) }],
    })
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range'))
      .toHaveLength(1)
  })

  it('does not synthesize a missing required title in strict generation output', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const missingTitle: Record<string, unknown> = modelBlueprint(1)
    delete missingTitle.title
    const session = generationSession(async () => ({
      status: 'completed',
      content: JSON.stringify({ blueprints: [missingTitle] }),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })).rejects.toThrow(/code=missing_field path=blueprints\[0\]\.title/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })

  it('does not commit when generated blueprint relationship facts are omitted', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const incomplete = modelBlueprint(1)
    delete incomplete.relationships
    const session = generationSession(async () => ({
      status: 'completed',
      content: JSON.stringify({ blueprints: [incomplete] }),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const context = { ...workflowContext(), uiLocale: 'en-US' as const }
    const failure = await command.execute({
      step: {},
      context,
      callbacks: stepCallbacks(),
    }).then(() => null, error => error as Error & { diagnostic?: unknown })

    expect(failure?.message).not.toMatch(/[\u3400-\u9fff]/u)
    expect(failure?.message).toContain('Structured contract diagnostic')
    expect(failure?.message).toContain('code=missing_field')
    expect(failure?.message).toContain('path=blueprints[0].relationships')
    expect(failure?.diagnostic).toMatchObject({ code: 'missing_field', path: 'blueprints[0].relationships' })

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })

  it('returns the single transaction readback snapshot instead of generated pre-commit objects', async () => {
    const readback = [1, 2, 3].map(chapterNumber => blueprint(chapterNumber, {
      title: `第${chapterNumber}章（事务回读）`,
    }))
    const invoke = stubIpcInvoke(successfulCommitHandler({ snapshot: readback }))
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([1, 2, 3]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 3 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const result = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    })

    expect(result).toEqual(readback)
    const commitCalls = invoke.mock.calls.filter(([channel]) => channel === 'db:blueprint-commit-range')
    expect(commitCalls).toHaveLength(1)
    expect(commitCalls[0]?.[1]).toMatchObject({
      mode: 'full',
      operationId: 'directory-test-run-1-3',
      startChapter: 1,
      endChapter: 3,
      blueprints: [{ chapterNumber: 1 }, { chapterNumber: 2 }, { chapterNumber: 3 }],
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-get')
  })

  it('cancels before commit and writes nothing', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const context = workflowContext()
    const session = generationSession(async () => {
      context.cancelled = true
      return {
        status: 'completed',
        content: blueprintJson([1, 2, 3]),
        finishReason: 'stop',
        receipt: generationReceipt(1, 'stop'),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 3 },
      projectSnapshot,
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await expect(command.execute({ step: {}, context, callbacks: stepCallbacks() }))
      .rejects.toThrow(/取消/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })

  it('synchronizes character candidates only after the committed blueprint receipt exists', async () => {
    const committed = blueprint(1, {
      characters: ['林岚', '周砚'],
      newCharacterCandidates: [{ name: '周砚', role: 'supporting' }],
      relationshipHints: [{ from: '林岚', to: '周砚', relation: '共同追查真相' }],
    })
    const invoke = stubIpcInvoke(successfulCommitHandler({
      snapshot: [committed],
      other: (channel, ...args) => {
        if (channel === 'db:character-roster-read') {
          return { status: 'empty', revision: 0, entries: [] }
        }
        if (channel === 'db:character-roster-commit') {
          const request = args[0] as { entries: unknown[] }
          return {
            success: true,
            receipt: {
              revision: 1,
              snapshot: { status: 'ready', entries: request.entries },
            },
          }
        }
        return { success: true }
      },
    }))
    const session = generationSession(async () => ({
      status: 'completed',
      content: JSON.stringify({ blueprints: [modelBlueprint(1, committed)] }),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const context = workflowContext()
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    await command.execute({ step: {}, context, callbacks: stepCallbacks() })

    const committedAt = invoke.mock.calls.findIndex(([channel]) => channel === 'db:blueprint-commit-range')
    const syncAt = invoke.mock.calls.findIndex(([channel]) => channel === 'db:character-roster-read')
    expect(committedAt).toBeGreaterThanOrEqual(0)
    expect(syncAt).toBeGreaterThan(committedAt)
    expect(invoke).toHaveBeenCalledWith(
      'db:character-roster-commit',
      expect.objectContaining({
        intent: 'blueprint_sync',
        entries: [expect.objectContaining({
          name: '周砚',
        })],
      }),
      projectSnapshot.expectedProjectPath,
      context.projectSession,
    )
    expect(context.data.blueprintCommitReceipt).toMatchObject({ chapterNumbers: [1] })
    expect(context.data.blueprintCharacterSyncReceipt).toMatchObject({
      blueprintCommitOperationId: 'directory-test-run-1-1',
      operationId: 'blueprint-sync-directory-test-run-1-1',
      status: 'already-satisfied',
    })
  })

  it('reports an explicit committed receipt when post-commit character synchronization fails', async () => {
    const committed = blueprint(1, {
      characters: ['林岚', '周砚'],
      relationshipHints: [{ from: '林岚', to: '周砚', relation: '追查' }],
    })
    stubIpcInvoke(successfulCommitHandler({
      snapshot: [committed],
      other: channel => {
        if (channel === 'db:character-roster-read') throw new Error('同步故障')
        return { success: true }
      },
    }))
    const session = generationSession(async () => ({
      status: 'completed',
      content: JSON.stringify({ blueprints: [modelBlueprint(1, committed)] }),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const failure = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    }).catch(error => error as unknown)

    expect(failure).toBeInstanceOf(DirectoryPostCommitSyncError)
    expect(failure).toMatchObject({
      retryOperationId: 'blueprint-sync-directory-test-run-1-1',
      commitReceipt: {
        operationId: 'directory-test-run-1-1',
        chapterNumbers: [1],
      },
    })
    expect((failure as Error).message).toContain('蓝图已提交')
  })

  it('retries character synchronization from the committed receipt without regenerating blueprints', async () => {
    const committed = blueprint(1, {
      characters: ['林岚', '周砚'],
      relationshipHints: [{ from: '林岚', to: '周砚', relation: '追查' }],
    })
    let rosterReads = 0
    stubIpcInvoke(successfulCommitHandler({
      snapshot: [committed],
      other: (channel, ...args) => {
        if (channel === 'db:character-roster-read') {
          rosterReads += 1
          if (rosterReads === 1) throw new Error('首次同步故障')
          return { status: 'empty', revision: 0, entries: [] }
        }
        if (channel === 'db:character-roster-commit') {
          const request = args[0] as { operationId: string; entries: unknown[] }
          return {
            success: true,
            receipt: {
              operationId: request.operationId,
              payloadHash: 'b'.repeat(64),
              revision: 1,
              idempotent: false,
              snapshot: { revision: 1, entries: request.entries },
            },
          }
        }
        return { success: true }
      },
    }))
    const complete = vi.fn<GenerationSession['complete']>(async () => ({
      status: 'completed',
      content: JSON.stringify({ blueprints: [modelBlueprint(1, committed)] }),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const context = workflowContext()
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(generationSession(complete))) },
    )

    const failure = await command.execute({ step: {}, context, callbacks: stepCallbacks() })
      .then(() => null, error => error as unknown)
    expect(failure).toBeInstanceOf(DirectoryPostCommitSyncError)
    const committedFailure = failure as DirectoryPostCommitSyncError
    const pendingAfterRestart = await listPendingDirectoryCharacterSyncs(
      projectSnapshot.expectedProjectPath,
      context.projectSession!,
    )
    expect(pendingAfterRestart).toEqual([
      expect.objectContaining({ operationId: committedFailure.retryOperationId, status: 'pending' }),
    ])
    const retryReceipt = await retryDirectoryCharacterSync(
      committedFailure.retryOperationId,
      projectSnapshot.expectedProjectPath,
      context.projectSession!,
    )

    expect(retryReceipt).toMatchObject({
      blueprintCommitOperationId: 'directory-test-run-1-1',
      operationId: 'blueprint-sync-directory-test-run-1-1',
      status: 'already-satisfied',
    })
    expect(committedFailure.commitReceipt.characterSyncInput[0]).toMatchObject({
      chapterNumber: 1,
      relationshipHints: committed.relationshipHints,
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('does not report zero-write cancellation when cancellation arrives after the atomic commit', async () => {
    const context = workflowContext()
    const committed = blueprint(1)
    const commitHandler = successfulCommitHandler({ snapshot: [committed] })
    stubIpcInvoke((channel, ...args) => {
      const result = commitHandler(channel, ...args)
      if (channel === 'db:blueprint-commit-range') context.cancelled = true
      return result
    })
    const session = generationSession(async () => ({
      status: 'completed',
      content: blueprintJson([1]),
      finishReason: 'stop',
      receipt: generationReceipt(1, 'stop'),
    }))
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: vi.fn(async () => testRuntime(session)) },
    )

    const failure = await command.execute({ step: {}, context, callbacks: stepCallbacks() })
      .catch(error => error as unknown)

    expect(failure).toBeInstanceOf(DirectoryPostCommitCancellationError)
    expect(failure).toMatchObject({ commitReceipt: { chapterNumbers: [1] } })
    expect((failure as Error).message).toContain('蓝图已提交')
  })
})
