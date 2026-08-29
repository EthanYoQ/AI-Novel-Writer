import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import type {
  LLMFinishReason,
  ModelExecutionLeaseReceipt,
} from '../../../../shared/ipc-channels'
import type { NarrativeThreadView } from '../../../../shared/narrative-thread'
import {
  createGenerationRuntime,
  type GenerationRuntime,
  type GenerationRuntimeEnvironment,
  type GenerationRuntimeScope,
} from '../../../generation/generation-runtime'
import type {
  GenerationAttemptReceipt,
  GenerationOutcome,
  GenerationTask,
} from '../../../generation/generation-harness'
import {
  DRAFT_GENERATION_BUDGET,
  GenerateDraftCommand,
  countDraftUnits,
  sanitizeDraftText,
  type GenerateDraftCommandDependencies,
} from '../generate-draft.command'

describe('generate draft command text cleanup', () => {
  it('removes thinking residue and continue UI prompts from draft text', () => {
    const text = sanitizeDraftText(`<think>分析过程</think>

点我继续生成后续内容

林岚推开办公室的门，屏幕上的航班编号仍在闪烁。`)

    expect(text).not.toContain('<think>')
    expect(text).not.toContain('点我继续')
    expect(text).toContain('林岚推开办公室的门')
  })

  it('removes a long malformed thinking prefix before visible draft prose', () => {
    const text = sanitizeDraftText(`推理过程：${'隐藏步骤。'.repeat(61)}</think>

林岚推开办公室的门。`)

    expect(text).toBe('林岚推开办公室的门。')
  })

  it('deduplicates repeated long paragraphs while keeping distinct paragraphs', () => {
    const repeated = '林岚握紧手中的U盘，屏幕蓝光映在她的指节上，走廊尽头传来压低的脚步声，她没有回头，只把那串航班编号重新敲进检索框。'
    const unique = '周砚没有立刻回答，只把监控画面停在三点十七分。'
    const text = sanitizeDraftText(`${repeated}

${unique}

${repeated}`)

    expect(text.match(/林岚握紧手中的U盘/g)).toHaveLength(1)
    expect(text).toContain(unique)
  })

  it('counts Chinese characters and English words for auto-continue thresholds', () => {
    expect(countDraftUnits('林岚\n\n 推门')).toBe(4)
    expect(countDraftUnits('林岚 walked into the room.')).toBe(6)
  })

  it('does not delete previous manuscript when a later continuation contains dangling think residue', () => {
    const previous = '林岚已经写下第一段正文。'.repeat(80)
    const text = sanitizeDraftText(`${previous}

碎片
</think>

周砚推门走进监控室。`)

    expect(text).toContain('林岚已经写下第一段正文')
    expect(text).toContain('周砚推门走进监控室')
    expect(text).not.toContain('</think>')
  })
})

function attemptReceipt(
  finishReason: LLMFinishReason,
  attempt = 1,
  reasoning = false,
): GenerationAttemptReceipt {
  const requestedOutputTokens = 4096
  return {
    model: {
      id: 'frozen-model',
      configurationRevision: 'a'.repeat(64),
      endpointFingerprint: 'b'.repeat(64),
    },
    capabilities: {
      contextWindowTokens: null,
      maxOutputTokens: 384_000,
      reasoning,
      structuredOutput: false,
      usage: false,
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown',
      },
    },
    budget: {
      attempt,
      maxAttempts: DRAFT_GENERATION_BUDGET.maxAttempts,
      requestedOutputTokens,
      cumulativeRequestedOutputTokens: attempt * requestedOutputTokens,
      maxRequestedOutputTokens: DRAFT_GENERATION_BUDGET.maxRequestedOutputTokens,
      maxRequestedOutputTokensPerAttempt: DRAFT_GENERATION_BUDGET.maxRequestedOutputTokensPerAttempt,
      deadlineAt: Date.now() + DRAFT_GENERATION_BUDGET.deadlineMs,
    },
    finishReason,
  }
}

function outcome(
  content: string,
  finishReason: LLMFinishReason,
  attempt = 1,
  reasoning = false,
): GenerationOutcome {
  const receipt = attemptReceipt(finishReason, attempt, reasoning)
  return finishReason === 'stop'
    ? { status: 'completed', content, finishReason, receipt }
    : { status: 'incomplete', content, finishReason, receipt }
}

function fakeRuntime(
  completeAttempt: (
    attempt: number,
    task: GenerationTask,
    options?: { signal?: AbortSignal },
  ) => GenerationOutcome | Promise<GenerationOutcome>,
) {
  let attempt = 0
  const complete = vi.fn(async (task: GenerationTask, options?: { signal?: AbortSignal }) => {
    attempt += 1
    return completeAttempt(attempt, task, options)
  })
  const execute = vi.fn(async (operation: (scope: GenerationRuntimeScope) => Promise<unknown>) => operation({
    session: {
      budget: {
        maxAttempts: DRAFT_GENERATION_BUDGET.maxAttempts,
        maxRequestedOutputTokens: DRAFT_GENERATION_BUDGET.maxRequestedOutputTokens,
        maxRequestedOutputTokensPerAttempt: DRAFT_GENERATION_BUDGET.maxRequestedOutputTokensPerAttempt,
        deadlineAt: Date.now() + DRAFT_GENERATION_BUDGET.deadlineMs,
      },
      complete,
    },
  }))
  const close = vi.fn().mockResolvedValue(undefined)
  const runtime = { execute, close } as unknown as GenerationRuntime
  const createRuntime = vi.fn<GenerateDraftCommandDependencies['createRuntime']>()
    .mockResolvedValue(runtime)
  return { complete, execute, close, createRuntime }
}

function fakeOutcomes(...outcomes: GenerationOutcome[]) {
  return fakeRuntime((attempt) => {
    const result = outcomes[attempt - 1]
    if (!result) throw new Error(`unexpected draft attempt ${attempt}`)
    return result
  })
}

function leaseReceipt(overrides: Partial<ModelExecutionLeaseReceipt> = {}): ModelExecutionLeaseReceipt {
  return {
    leaseId: 'draft-lease-a',
    modelId: 'model-a',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'model-a-v1',
    modelRevision: 'a'.repeat(64),
    endpointFingerprint: 'b'.repeat(64),
    capabilityEvidence: {
      source: {
        contextWindowTokens: 'verified-provider-preset',
        maxOutputTokens: 'verified-provider-preset',
        featureFlags: 'verified-provider-preset',
      },
      subjectFingerprint: 'c'.repeat(64),
      contextWindowTokens: 384_000,
      maxOutputTokens: 384_000,
      reasoning: false,
      structuredOutput: false,
      usage: true,
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 60_000,
    ...overrides,
  }
}

describe('GenerateDraftCommand generation runtime boundary', () => {
  const projectPath = 'C:\\novels\\generation-runtime'

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useProjectStore.setState({ currentProject: null })
  })

  function setup(options: {
    runtime: Pick<ReturnType<typeof fakeRuntime>, 'createRuntime' | 'complete' | 'execute' | 'close'>
    wordsPerChapter?: number
    wordsTarget?: number
    premise?: string
    blueprints?: Array<{ chapterNumber: number; title: string; keyEvents: string }>
    userGuidance?: string
    writingLanguage?: 'zh-CN' | 'en-US'
    chapterNumber?: number
    characters?: string[]
    continuity?: Array<{
      draftId: number
      chapterNumber: number
      chapterTitle: string
      chapterNotes: string
      facts?: Array<{
        category: 'character-state' | 'timeline' | 'open-thread' | 'plot'
        entities: string[]
        statement: string
        sourceChapter: number
        evidence: string
      }>
    }>
    narrativeThreads?: NarrativeThreadView[]
    previousFinalizedContent?: string
    knowledgeResults?: Array<{ text: string; score: number; fileName: string }>
  }) {
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists' && String(args[0]).endsWith('/.vela/prompts')) return false
      if (channel === 'db:project-core-get') {
        return {
          premise: options.premise ?? '故事前提',
          charactersArch: '',
          worldbuilding: '',
          synopsis: '',
        }
      }
      if (channel === 'db:blueprint-get-all') return options.blueprints ?? []
      if (channel === 'db:blueprint-get') {
        return options.blueprints?.find(blueprint => blueprint.chapterNumber === args[0]) ?? null
      }
      if (channel === 'db:continuity-list-before') return options.continuity ?? []
      if (channel === 'db:narrative-thread-list-relevant') return options.narrativeThreads ?? []
      if (channel === 'db:draft-get-finalized') {
        return options.previousFinalizedContent ? { id: 77 } : null
      }
      if (channel === 'db:draft-get-full') {
        return options.previousFinalizedContent
          ? { id: 77, content: options.previousFinalizedContent }
          : null
      }
      if (channel === 'kb:search-writing-context') return options.knowledgeResults ?? []
      if (channel === 'fs:list-dir' || channel === 'db:character-get-all') return []
      if (channel === 'db:draft-next-version') return 1
      if (channel === 'db:draft-create') return { success: true, id: 'draft-1' }
      throw new Error(`unexpected IPC: ${channel}`)
    })
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
    useProjectStore.setState({
      currentProject: {
        id: 'generation-runtime',
        name: 'generation-runtime',
        path: projectPath,
        sessionLease: 'lease-generation-runtime',
        novelConfig: {
          writingLanguage: options.writingLanguage ?? 'zh-CN',
          totalChapters: 10,
          wordsPerChapter: options.wordsPerChapter ?? 5000,
        },
      } as never,
      refreshFileTree: vi.fn().mockResolvedValue(undefined),
    })
    const context: WorkflowContext = {
      runId: 'draft-generation-runtime',
      projectPath,
      projectSession: {
        projectId: 'generation-runtime',
        leaseId: 'lease-generation-runtime',
        projectPath,
      },
      data: {},
      cancelled: false,
      writingLanguage: options.writingLanguage ?? 'zh-CN',
    } as WorkflowContext
    const callbacks: StepCallbacks = {
      log: vi.fn(),
      setProgress: vi.fn(),
      appendText: vi.fn(),
    }
    const command = new GenerateDraftCommand({
      projectPath,
      chapterNumber: options.chapterNumber ?? 1,
      title: options.chapterNumber === 2 ? 'Chapter Two' : '第一章',
      role: '开端',
      purpose: '建立冲突',
      keyEvents: '开端',
      characters: options.characters ?? [],
      wordsTarget: options.wordsTarget,
      userGuidance: options.userGuidance,
    }, { dependencies: { createRuntime: options.runtime.createRuntime } })
    return { invoke, context, callbacks, command }
  }

  function expectNoDraftPersistence(invoke: ReturnType<typeof vi.fn>): void {
    expect(invoke).not.toHaveBeenCalledWith('db:draft-next-version', expect.anything(), expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  }

  it.each([
    { uiLocale: 'zh-CN', writingLanguage: 'zh-CN', expected: '你是一位笔力精湛的网络小说家', unexpected: 'You are an accomplished web-fiction novelist' },
    { uiLocale: 'en-US', writingLanguage: 'zh-CN', expected: '你是一位笔力精湛的网络小说家', unexpected: 'You are an accomplished web-fiction novelist' },
    { uiLocale: 'zh-CN', writingLanguage: 'en-US', expected: 'You are an accomplished web-fiction novelist', unexpected: '你是一位笔力精湛的网络小说家' },
    { uiLocale: 'en-US', writingLanguage: 'en-US', expected: 'You are an accomplished web-fiction novelist', unexpected: '你是一位笔力精湛的网络小说家' },
  ] as const)(
    'sends $writingLanguage built-in instructions through the provider request in a $uiLocale interface',
    async ({ uiLocale, writingLanguage, expected, unexpected }) => {
      useLocaleStore.setState({ locale: uiLocale })
      let observedTask: GenerationTask | undefined
      const runtime = fakeRuntime((_attempt, task) => {
        observedTask = task
        return outcome('English draft prose. '.repeat(500), 'stop')
      })
      const authorGuidance = 'Keep the author\'s café sign “夜航 Café” exactly as written.'
      const { context, callbacks, command } = setup({
        runtime,
        writingLanguage,
        wordsTarget: 500,
        userGuidance: authorGuidance,
      })

      await command.execute({ step: {}, context, callbacks })

      const messages = observedTask?.messages ?? []
      const system = messages.find(message => message.role === 'system')?.content ?? ''
      const user = messages.find(message => message.role === 'user')?.content ?? ''
      expect(system).toContain(expected)
      expect(system).not.toContain(unexpected)
      expect(user).toContain(authorGuidance)
    },
  )

  it('sends English continuation-stage instructions for an English project', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('Continuation prose. '.repeat(500), 'stop')
    })
    const { context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'en-US',
      chapterNumber: 2,
      wordsTarget: 500,
    })

    await command.execute({ step: {}, context, callbacks })

    const requestText = observedTask?.messages.map(message => message.content).join('\n') ?? ''
    expect(requestText).toContain('You are serializing the latest chapter.')
    expect(requestText).not.toContain('你正在连载写作最新章节')
  })

  it('freezes one lease and one budget across initial and continuation attempts after model/config changes', async () => {
    let selectedModelId: string | null = 'model-a'
    let call = 0
    const receipt = leaseReceipt()
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>(async () => {
      call += 1
      if (call === 1) {
        selectedModelId = 'model-b'
        receipt.capabilityEvidence.maxOutputTokens = 1
        return { content: '初'.repeat(3500), finishReason: 'length' }
      }
      return { content: `${'续'.repeat(700)}。`, finishReason: 'stop' }
    })
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: vi.fn(() => selectedModelId),
      beginModelExecution: vi.fn(async () => receipt),
      completeWithLease,
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }
    const createRuntime = vi.fn<GenerateDraftCommandDependencies['createRuntime']>(
      options => createGenerationRuntime(options, environment),
    )
    const runtime = { createRuntime, complete: vi.fn(), execute: vi.fn(), close: vi.fn() }
    const { invoke, context, callbacks, command } = setup({ runtime })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')

    expect(environment.snapshotDefaultModelId).toHaveBeenCalledOnce()
    expect(environment.beginModelExecution).toHaveBeenCalledOnce()
    expect(environment.beginModelExecution).toHaveBeenCalledWith('model-a')
    expect(completeWithLease).toHaveBeenCalledTimes(2)
    expect(completeWithLease.mock.calls.map(([request]) => request.leaseId)).toEqual([
      'draft-lease-a',
      'draft-lease-a',
    ])
    expect(completeWithLease.mock.calls.map(([request]) => request.plan.maxOutputTokens)).toEqual([
      8192,
      8192,
    ])
    expect(createRuntime).toHaveBeenCalledWith({ budget: DRAFT_GENERATION_BUDGET })
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: expect.stringContaining('续') }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('uses the model frozen by the workflow context instead of reselecting the default model', async () => {
    const runtime = fakeOutcomes(outcome('正文。'.repeat(500), 'stop'))
    const { context, callbacks, command } = setup({ runtime, wordsTarget: 500 })
    ;(context as WorkflowContext & { generationModelId?: string }).generationModelId = 'grok-selected-model'

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('正文')

    expect(runtime.createRuntime).toHaveBeenCalledWith({
      budget: DRAFT_GENERATION_BUDGET,
      modelId: 'grok-selected-model',
    })
  })

  it('injects finalized author continuity and the previous finalized ending without a blueprint', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(500), 'stop')
    })
    const previousFinalizedContent = `${'旧章正文。'.repeat(300)}上一章定稿结尾哨兵。`
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      characters: ['林岚'],
      wordsTarget: 500,
      continuity: [{
        draftId: 41,
        chapterNumber: 1,
        chapterTitle: '作者第一章',
        chapterNotes: '作者事实哨兵：林岚已经拿到红色钥匙。',
        facts: [{
          category: 'character-state',
          entities: ['林岚'],
          statement: '林岚持有红色钥匙。',
          sourceChapter: 1,
          evidence: '林岚把红色钥匙收进口袋。',
        }],
      }],
      previousFinalizedContent,
      knowledgeResults: [{ text: '项目知识哨兵', score: 0.9, fileName: '世界观' }],
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain('作者事实哨兵：林岚已经拿到红色钥匙。')
    expect(prompt).toContain('林岚持有红色钥匙。')
    expect(prompt).toContain('来源第1章')
    expect(prompt).toContain('林岚把红色钥匙收进口袋。')
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('连续性事实（1 条）'))
    expect(prompt).toContain('上一章定稿结尾哨兵。')
    expect(prompt).toContain('项目知识哨兵')
    expect(invoke).toHaveBeenCalledWith(
      'kb:search-writing-context',
      expect.any(String),
      5,
      projectPath,
      expect.anything(),
    )
  })

  it('keeps older facts only when they are relevant to the current chapter entities', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(500), 'stop')
    })
    const { context, callbacks, command } = setup({
      runtime,
      chapterNumber: 8,
      characters: ['林岚'],
      wordsTarget: 500,
      continuity: [{
        draftId: 41,
        chapterNumber: 1,
        chapterTitle: '第一章',
        chapterNotes: '第一章摘要',
        facts: [
          {
            category: 'character-state',
            entities: ['林岚'],
            statement: '早期事实哨兵：林岚不会游泳。',
            sourceChapter: 1,
            evidence: '林岚在河边承认自己不会游泳。',
          },
          {
            category: 'plot',
            entities: ['周远'],
            statement: '无关事实哨兵：周远换了一双鞋。',
            sourceChapter: 1,
            evidence: '周远穿上新鞋。',
          },
        ],
      }],
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain('早期事实哨兵')
    expect(prompt).not.toContain('无关事实哨兵')
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('连续性事实（1 条）'))
  })

  it('keeps an older relevant fact when newer chapter notes exhaust the context budget', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(500), 'stop')
    })
    const continuity = Array.from({ length: 7 }, (_, index) => ({
      draftId: 41 + index,
      chapterNumber: index + 1,
      chapterTitle: `第${index + 1}章`,
      chapterNotes: index === 0 ? '第一章摘要' : `较新的长摘要${index + 1}：${'占用上下文。'.repeat(120)}`,
      facts: index === 0 ? [{
        category: 'character-state' as const,
        entities: ['林岚'],
        statement: '预算事实哨兵：林岚惧怕深水。',
        sourceChapter: 1,
        evidence: '林岚在旧码头拒绝登船。',
      }] : [],
    }))
    const { context, callbacks, command } = setup({
      runtime,
      chapterNumber: 8,
      characters: ['林岚'],
      wordsTarget: 500,
      continuity,
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain('预算事实哨兵')
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('连续性事实（1 条）'))
  })

  it('injects a bounded set of relevant active narrative threads into the next chapter prompt', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(500), 'stop')
    })
    const narrativeThreads: NarrativeThreadView[] = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      title: `活跃线索-${index + 1}`,
      type: '伏笔',
      targetStartChapter: 2,
      targetEndChapter: 8,
      authorIntent: `在第八章前兑现线索 ${index + 1}。`,
      status: index === 0 ? 'progressing' : 'planned',
      dormantChapters: index,
      overdue: false,
      events: index === 0 ? [{
        id: 11, planId: 1, draftId: 41, type: 'progressing', evidence: '门框上有三道刻痕',
        reason: '线索得到推进。', chapterNumber: 4, chapterTitle: '旧仓库', createdAt: '',
      }] : [],
      createdAt: '', updatedAt: '',
    }))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 5,
      characters: ['林岚'],
      wordsTarget: 500,
      narrativeThreads,
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain('【当前相关活跃叙事线索】')
    expect(prompt).toContain('活跃线索-1')
    expect(prompt).toContain('目标第2–8章')
    expect(prompt).toContain('来源第4章：门框上有三道刻痕')
    expect(prompt).toContain('活跃线索-6')
    expect(prompt).not.toContain('活跃线索-7')
    expect(prompt).not.toContain('活跃线索-8')
    const threadContextStart = prompt.indexOf('【当前相关活跃叙事线索】')
    const threadContextEnd = prompt.indexOf('\n\n', threadContextStart)
    expect(threadContextEnd).toBeGreaterThan(threadContextStart)
    expect(threadContextEnd - threadContextStart).toBeLessThanOrEqual(1200)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('活跃叙事线索（6 条）'))
    expect(invoke).toHaveBeenCalledWith(
      'db:narrative-thread-list-relevant',
      expect.objectContaining({ chapterNumber: 5, characters: ['林岚'] }),
      projectPath,
      expect.anything(),
    )
  })

  it('previews only authored text before completion and reconciles to the persisted terminal draft', async () => {
    let resolveAttempt: ((value: GenerationOutcome) => void) | undefined
    let streamChunk: ((chunk: string) => void) | undefined
    const runtime = fakeRuntime((_attempt, _task, options) => {
      streamChunk = (options as { onChunk?: (chunk: string) => void } | undefined)?.onChunk
      return new Promise<GenerationOutcome>(resolve => { resolveAttempt = resolve })
    })
    const setupResult = setup({ runtime })
    const replaceText = vi.fn()
    const callbacks = Object.assign(setupResult.callbacks, { replaceText })

    const execution = setupResult.command.execute({
      step: {},
      context: setupResult.context,
      callbacks,
    })
    await vi.waitFor(() => expect(streamChunk).toBeTypeOf('function'))

    streamChunk!('<thi')
    streamChunk!('nk>不得展示的推理')
    streamChunk!('</thi')
    streamChunk!('nk>\n林岚推开门。')

    expect(replaceText).toHaveBeenLastCalledWith('林岚推开门。')
    expect(JSON.stringify(replaceText.mock.calls)).not.toContain('不得展示的推理')

    resolveAttempt!(outcome(`${'终稿正文'.repeat(1250)}。`, 'stop'))
    await execution

    const persisted = setupResult.invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    const persistedText = (persisted?.[1] as { content: string }).content
    expect(replaceText).toHaveBeenLastCalledWith(persistedText)
  })

  it('clears provisional text after a failed attempt and ignores its late chunks', async () => {
    let lateChunk: ((chunk: string) => void) | undefined
    const runtime = fakeRuntime((_attempt, _task, options) => {
      lateChunk = (options as { onChunk?: (chunk: string) => void } | undefined)?.onChunk
      lateChunk?.('不会落盘的正文')
      throw new Error('provider disconnected')
    })
    const setupResult = setup({ runtime })
    const replaceText = vi.fn()
    const callbacks = Object.assign(setupResult.callbacks, { replaceText })

    await expect(setupResult.command.execute({
      step: {},
      context: setupResult.context,
      callbacks,
    })).rejects.toThrow('provider disconnected')

    expect(replaceText).toHaveBeenLastCalledWith('')
    lateChunk?.('晚到的正文')
    expect(replaceText).toHaveBeenLastCalledWith('')
    expect(JSON.stringify(replaceText.mock.calls)).not.toContain('晚到的正文')
    expectNoDraftPersistence(setupResult.invoke)
  })

  it('preserves the accepted preview after persistence even if a later refresh fails', async () => {
    const terminalDraft = `${'已持久化正文'.repeat(800)}。`
    const runtime = fakeOutcomes(outcome(terminalDraft, 'stop'))
    const setupResult = setup({ runtime })
    const replaceText = vi.fn()
    const callbacks = Object.assign(setupResult.callbacks, { replaceText })
    useProjectStore.setState({ refreshFileTree: vi.fn().mockRejectedValue(new Error('refresh failed')) })

    await expect(setupResult.command.execute({
      step: {},
      context: setupResult.context,
      callbacks,
    })).rejects.toThrow('refresh failed')

    const persisted = setupResult.invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    const persistedText = (persisted?.[1] as { content: string }).content
    expect(replaceText).toHaveBeenLastCalledWith(persistedText)
    expect(replaceText).not.toHaveBeenLastCalledWith('')
  })

  it('does not locally reject a 30K prompt when lease context evidence is unknown', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>(async request => {
      void request
      return { content: `${'正文'.repeat(2500)}。`, finishReason: 'stop' }
    })
    const environment: GenerationRuntimeEnvironment = {
      snapshotDefaultModelId: () => 'model-a',
      beginModelExecution: async () => leaseReceipt({
        capabilityEvidence: {
          ...leaseReceipt().capabilityEvidence,
          source: {
            contextWindowTokens: 'unknown',
            maxOutputTokens: 'user-operational-cap',
            featureFlags: 'unknown',
          },
          contextWindowTokens: null,
          maxOutputTokens: 8192,
        },
      }),
      completeWithLease,
      closeModelExecution: vi.fn().mockResolvedValue(undefined),
    }
    const createRuntime = vi.fn<GenerateDraftCommandDependencies['createRuntime']>(
      options => createGenerationRuntime(options, environment),
    )
    const runtime = { createRuntime, complete: vi.fn(), execute: vi.fn(), close: vi.fn() }
    const { context, callbacks, command } = setup({
      runtime,
      premise: '设定'.repeat(15_000),
    })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('正文')

    expect(completeWithLease).toHaveBeenCalledOnce()
    const physicalRequest = completeWithLease.mock.calls[0]![0]
    const promptChars = physicalRequest.messages.reduce((sum, message) => sum + message.content.length, 0)
    expect(promptChars).toBeGreaterThan(30_000)
    expect(completeWithLease.mock.calls[0]?.[0].plan.maxOutputTokens).toBe(8192)
  })

  it('continues an explicit stop result below 82% and commits only after the same session reaches the target', async () => {
    const runtime = fakeOutcomes(
      outcome(`${'初'.repeat(3968)}。`, 'stop', 1),
      outcome(`${'续'.repeat(300)}。`, 'stop', 2),
    )
    const { invoke, context, callbacks, command } = setup({ runtime })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')

    expect(runtime.execute).toHaveBeenCalledOnce()
    expect(runtime.complete).toHaveBeenCalledTimes(2)
    expect(runtime.complete.mock.calls[1]?.[0]).toMatchObject({
      purpose: 'chapter-draft-continuation',
      output: 'visible-text',
    })
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: expect.stringContaining('续') }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('persists the same draft-unit count used by generation thresholds', async () => {
    const draft = `${'chapter prose '.repeat(450).trim()}.`
    const { invoke, context, callbacks, command } = setup({
      runtime: fakeOutcomes(outcome(draft, 'stop')),
      writingLanguage: 'en-US',
      wordsTarget: 900,
    })

    await command.execute({ step: {}, context, callbacks })

    const persisted = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    expect(persisted?.[1]).toMatchObject({
      wordCount: countDraftUnits((persisted?.[1] as { content: string }).content),
    })
  })

  it('continues a length result even after it has crossed 82%', async () => {
    const runtime = fakeOutcomes(
      outcome('初'.repeat(5000), 'length', 1),
      outcome(`${'续'.repeat(800)}。`, 'stop', 2),
    )
    const { context, callbacks, command } = setup({ runtime, wordsPerChapter: 6000 })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')
    expect(runtime.complete).toHaveBeenCalledTimes(2)
  })

  it('recovers once from an output-limited continuation with no visible progress and commits only the recovered draft', async () => {
    const initial = '初'.repeat(4000)
    const discarded = '初'.repeat(200)
    const recovered = `${'续'.repeat(1000)}。`
    const runtime = fakeOutcomes(
      outcome(initial, 'length', 1),
      outcome(discarded, 'length', 2),
      outcome(recovered, 'stop', 3),
    )
    const { invoke, context, callbacks, command } = setup({ runtime })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual([
      'chapter-draft',
      'chapter-draft-continuation',
      'chapter-draft-no-progress-recovery',
    ])
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringMatching(
      /visibleUnitsBefore=4000 candidateVisibleUnits=200 mergedDelta=0 accepted=false/u,
    ))
    const persisted = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    expect((persisted?.[1] as { content: string }).content).toBe(`${initial}\n\n${recovered}`)
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:draft-create')).toHaveLength(1)
    expect(JSON.stringify(vi.mocked(callbacks.log).mock.calls)).not.toContain(discarded)
  })

  it('keeps empty context wrappers and private no-progress recovery instructions in English', async () => {
    const initial = 'opening '.repeat(4000)
    const discarded = 'opening '.repeat(200)
    const recovered = `${'advance '.repeat(1000)}.`
    const runtime = fakeOutcomes(
      outcome(initial, 'length', 1),
      outcome(discarded, 'length', 2),
      outcome(recovered, 'stop', 3),
    )
    const authorGuidance = 'Keep “夜航 Café” exactly; do not translate café.'
    const { context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'en-US',
      chapterNumber: 2,
      userGuidance: authorGuidance,
    })

    await command.execute({ step: {}, context, callbacks })

    const prompts = runtime.complete.mock.calls.map(([task]) => (
      task.messages.find(message => message.role === 'user')?.content ?? ''
    ))
    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toContain(authorGuidance)
    expect(prompts[0]).toContain('(no future chapter blueprints)')
    expect(prompts[0]).toContain('(no chapter notes)')
    expect(prompts[0]).toContain('(no previous manuscript)')
    expect(prompts[0]).toContain('(no relevant knowledge-base context)')
    expect(prompts[0]).toContain('(no character state records)')
    expect(prompts[1]).toContain('Continue the current chapter seamlessly')
    expect(prompts[2]).toContain('This is the only no-progress recovery attempt')
    expect(prompts.join('\n')).not.toMatch(/【(?:硬性要求|本章蓝图|后续章节大纲预告|角色状态档案|第\d+章)/u)
  })

  it('fails closed after the only no-progress recovery also makes no visible progress', async () => {
    const initial = '初'.repeat(4000)
    const runtime = fakeOutcomes(
      outcome(initial, 'length', 1),
      outcome('初'.repeat(200), 'length', 2),
      outcome('初'.repeat(300), 'length', 3),
    )
    const { invoke, context, callbacks, command } = setup({ runtime })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow(/恢复请求仍未增加足够的新正文/u)

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual([
      'chapter-draft',
      'chapter-draft-continuation',
      'chapter-draft-no-progress-recovery',
    ])
    expectNoDraftPersistence(invoke)
  })

  it('injects chapter, future blueprint, and user guidance into the semantic initial task', async () => {
    const runtime = fakeOutcomes(outcome(`${'正文'.repeat(2500)}。`, 'stop'))
    const { context, callbacks, command } = setup({
      runtime,
      blueprints: [{ chapterNumber: 2, title: '蓝门回声', keyEvents: '追查蓝色漆屑与撞击声' }],
      userGuidance: '第一章必须以潮湿灯塔开场',
    })

    await command.execute({ step: {}, context, callbacks })

    const task = runtime.complete.mock.calls[0]?.[0] as GenerationTask
    const prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
    expect(task).toMatchObject({ purpose: 'chapter-draft', output: 'visible-text' })
    expect(prompt).not.toMatch(/\{\{(?:chapter_info|future_blueprints|user_guidance)\}\}/u)
    expect(prompt).toContain('第2章 蓝门回声：追查蓝色漆屑与撞击声')
    expect(prompt).toContain('第一章必须以潮湿灯塔开场')
  })

  it('caps an overlong result at a natural boundary before persistence', async () => {
    const overlongDraft = Array.from(
      { length: 20 },
      (_, index) => `第${index + 1}段${'甲'.repeat(195)}。`,
    ).join('\n\n')
    const runtime = fakeOutcomes(outcome(overlongDraft, 'stop'))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      wordsPerChapter: 6000,
      wordsTarget: 3000,
    })

    await command.execute({ step: {}, context, callbacks })

    const persisted = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    const content = (persisted?.[1] as { content: string }).content
    expect(countDraftUnits(content)).toBeLessThanOrEqual(3360)
    expect(content).toMatch(/[。！？]$/u)
  })

  it.each(['content_filter', 'error', 'unknown', 'cancelled'] as const)(
    'rejects finishReason=%s and leaves no draft residue',
    async finishReason => {
      const runtime = fakeOutcomes(outcome(`${'正文'.repeat(2500)}。`, finishReason))
      const { invoke, context, callbacks, command } = setup({ runtime })

      await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow()
      expectNoDraftPersistence(invoke)
    },
  )

  it('rejects a no-progress continuation and leaves no draft residue', async () => {
    const runtime = fakeOutcomes(
      outcome('初'.repeat(200), 'stop', 1),
      outcome('无有效增量。', 'stop', 2),
    )
    const { invoke, context, callbacks, command } = setup({ runtime })

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('明显未达到章节目标')
    expectNoDraftPersistence(invoke)
  })

  it('uses at most seven continuations and leaves a still-truncated chapter uncommitted', async () => {
    const results = [outcome('初'.repeat(1000), 'length', 1)]
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      results.push(outcome(`第${attempt}段${'续'.repeat(1000)}。`, 'length', attempt))
    }
    const runtime = fakeOutcomes(...results)
    const { invoke, context, callbacks, command } = setup({
      runtime,
      wordsPerChapter: 20_000,
      wordsTarget: 20_000,
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('AI 输出达到模型最大长度，结果不完整')
    expect(runtime.complete).toHaveBeenCalledTimes(8)
    expectNoDraftPersistence(invoke)
  })

  it('uses lease reasoning evidence and refuses to continue hidden reasoning residue', async () => {
    const runtime = fakeOutcomes(outcome('<think>推理耗尽</think>', 'length', 1, true))
    const { invoke, context, callbacks, command } = setup({ runtime })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('无法安全续接隐藏推理过程')
    expect(runtime.complete).toHaveBeenCalledOnce()
    expectNoDraftPersistence(invoke)
  })

  it('aborts a cancelled run before any database version query or commit', async () => {
    let resolveAttempt: ((value: GenerationOutcome) => void) | undefined
    const runtime = fakeRuntime(() => new Promise<GenerationOutcome>(resolve => {
      resolveAttempt = resolve
    }))
    const { invoke, context, callbacks, command } = setup({ runtime })

    const execution = command.execute({ step: {}, context, callbacks })
    await vi.waitFor(() => expect(resolveAttempt).toBeTypeOf('function'))
    context.cancelled = true
    resolveAttempt!(outcome(`${'正文'.repeat(2500)}。`, 'stop'))

    await expect(execution).rejects.toThrow('工作流已取消')
    expectNoDraftPersistence(invoke)
  })

  it('leaves no draft residue when opening the generation runtime fails', async () => {
    const createRuntime = vi.fn<GenerateDraftCommandDependencies['createRuntime']>()
      .mockRejectedValue(new Error('lease unavailable'))
    const runtime = { createRuntime, complete: vi.fn(), execute: vi.fn(), close: vi.fn() }
    const { invoke, context, callbacks, command } = setup({ runtime })

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('lease unavailable')
    expectNoDraftPersistence(invoke)
  })
})
