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
  DirectoryCharacterSyncPendingError,
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
  it('sends English blueprint instructions through the provider request for an English project', async () => {
    stubIpcInvoke(successfulCommitHandler())
    let observedTask: GenerationTask | undefined
    const session = generationSession(async task => {
      observedTask = task
      return {
        status: 'completed',
        content: blueprintJson([1]),
        finishReason: 'stop',
        receipt: generationReceipt(1, 'stop'),
      }
    })
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      {
        ...projectSnapshot,
        novelConfig: {
          ...projectSnapshot.novelConfig,
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

    const system = observedTask?.messages.find(message => message.role === 'system')?.content ?? ''
    const user = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(system).toContain('You are an experienced web-fiction architect')
    expect(user).toContain('Generate chapter blueprints from chapter 1 through chapter 1')
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
    const context = { ...workflowContext(), writingLanguage: 'en-US' as const }

    const result = await command.execute({ step: {}, context, callbacks: stepCallbacks() })

    expect(result[0]?.title).toBe('Café 夜航')
    expect(attempt).toBe(2)
  })

  it('blocks a new billable directory run while a durable character sync is pending', async () => {
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
    stubIpcInvoke(channel => (
      channel === 'db:blueprint-character-sync-list-pending' ? [operation] : { success: true }
    ))
    const createRuntime = vi.fn()
    const command = new GenerateDirectoryCommand(
      { mode: 'full', count: 1 },
      { ...projectSnapshot, novelConfig: { ...projectSnapshot.novelConfig, totalChapters: 1 } },
      { createRuntime: createRuntime as never },
    )

    const failure = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    }).catch(error => error as unknown)

    expect(failure).toBeInstanceOf(DirectoryCharacterSyncPendingError)
    expect(failure).toMatchObject({ operationIds: ['blueprint-sync-previous-run'] })
    expect(createRuntime).not.toHaveBeenCalled()
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
        maxAttempts: 15,
        maxRequestedOutputTokens: 61_440,
        maxRequestedOutputTokensPerAttempt: 4_096,
        deadlineMs: 600_000,
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
        maxAttempts: 23,
        maxRequestedOutputTokens: 94_208,
        maxRequestedOutputTokensPerAttempt: 4_096,
        deadlineMs: 600_000,
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
        maxAttempts: 11,
        maxRequestedOutputTokens: 45_056,
        maxRequestedOutputTokensPerAttempt: 4_096,
        deadlineMs: 600_000,
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

    await expect(command.execute({
      step: {},
      context: workflowContext(),
      callbacks,
    })).rejects.toThrow(
      /purpose=chapter-blueprint-directory:compact-single:chapter-1 finishReason=length requestedTokens=4096/u,
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
    })).rejects.toThrow(/code=missing_item path=blueprints/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
  })

  it('rejects an empty required purpose before any database write', async () => {
    const invoke = stubIpcInvoke(successfulCommitHandler())
    const session = generationSession(async () => ({
      status: 'completed',
      content: JSON.stringify({ blueprints: [modelBlueprint(1, { purpose: '' })] }),
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
    })).rejects.toThrow(/code=invalid_value path=blueprints\[0\]\.purpose/u)

    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('db:blueprint-commit-range')
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

    const failure = await command.execute({
      step: {},
      context: workflowContext(),
      callbacks: stepCallbacks(),
    }).then(() => null, error => error as Error & { diagnostic?: unknown })

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
    expect(context.data.blueprintCommitReceipt).toMatchObject({ chapterNumbers: [1] })
    expect(context.data.blueprintCharacterSyncReceipt).toMatchObject({
      blueprintCommitOperationId: 'directory-test-run-1-1',
      operationId: 'blueprint-sync-directory-test-run-1-1',
      status: 'already-satisfied',
    })
  })

  it('reports an explicit committed receipt when post-commit character synchronization fails', async () => {
    const committed = blueprint(1, { characters: ['林岚'] })
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
