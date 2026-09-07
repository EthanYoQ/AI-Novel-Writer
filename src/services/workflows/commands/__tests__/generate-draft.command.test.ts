import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

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
import { EN_US_BUILTIN_PROMPTS } from '../../../prompt-language'
import { BUILTIN_PROMPTS } from '../../../prompt-templates'
import {
  DRAFT_GENERATION_BUDGET,
  GenerateDraftCommand,
  countDraftUnits,
  previousChapterEnding,
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

  it('starts the previous-chapter window at a natural prose boundary', () => {
    const completeEnding = '完整事件已经结束。'.repeat(100)
    const content = `${'前'.repeat(1001)}被截断的半句。${completeEnding}`

    const ending = previousChapterEnding(content)

    expect(ending).toHaveLength(completeEnding.length)
    expect(ending).toBe(completeEnding)
  })
})

describe('built-in author-guidance prompt boundaries', () => {
  it('keeps global guidance compact and out of the chapter-outline role in both languages', () => {
    const zh = BUILTIN_PROMPTS.find(template => template.key === 'generate_global_config')
    const zhField = BUILTIN_PROMPTS.find(template => template.key === 'generate_novel_config_field')
    const en = EN_US_BUILTIN_PROMPTS.generate_global_config
    const enField = EN_US_BUILTIN_PROMPTS.generate_novel_config_field

    expect(`${zh?.content}\n${zh?.systemSuffix}`).toMatch(/globalGuidance[\s\S]*禁止逐章/u)
    expect(zhField?.systemSuffix).toMatch(/globalGuidance[\s\S]*禁止逐章/u)
    expect(`${en.content}\n${en.systemSuffix}`).toMatch(/globalGuidance[\s\S]*must not enumerate chapters/i)
    expect(en.content).toContain('no more than 600 characters')
    expect(enField.systemSuffix).toMatch(/globalGuidance[\s\S]*must not enumerate chapters/i)
  })

  it('keeps generic draft conventions subordinate to the current chapter brief', () => {
    const zhFirst = BUILTIN_PROMPTS.find(template => template.key === 'first_chapter_draft')
    const zhNext = BUILTIN_PROMPTS.find(template => template.key === 'next_chapter_draft')
    const enFirst = EN_US_BUILTIN_PROMPTS.first_chapter_draft
    const enNext = EN_US_BUILTIN_PROMPTS.next_chapter_draft

    expect(`${zhFirst?.content}\n${zhFirst?.systemSuffix}`).toContain('仅当【本章信息】明确要求时才展现主角的金手指')
    expect(`${zhFirst?.content}\n${zhFirst?.systemSuffix}`).not.toContain('留置一个强力钩子')
    expect(`${zhNext?.content}\n${zhNext?.systemSuffix}`).toContain('不因此成为已发生事件')
    expect(`${zhNext?.content}\n${zhNext?.systemSuffix}`).not.toContain('上述事件已经发生完毕')
    expect(`${zhNext?.content}\n${zhNext?.systemSuffix}`).not.toContain('必须卡在一个剧情的小高潮点或突发变故上')
    expect(`${enFirst.content}\n${enFirst.systemSuffix}`).toContain('only when the chapter brief explicitly requires it')
    expect(`${enNext.content}\n${enNext.systemSuffix}`).toContain('do not thereby become completed events')
    expect(`${enNext.content}\n${enNext.systemSuffix}`).not.toContain('Those events have already happened')
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
    options?: { signal?: AbortSignal; onChunk?: (chunk: string) => void },
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
    charactersArch?: string
    blueprints?: Array<{ chapterNumber: number; title: string; keyEvents: string }>
    userGuidance?: string
    globalGuidance?: string
    writingStyle?: string
    coreOutline?: string
    worldSetting?: string
    goldenFinger?: string
    protagonistProfile?: string
    writingLanguage?: 'zh-CN' | 'en-US'
    uiLocale?: 'zh-CN' | 'en-US'
    chapterNumber?: number
    characters?: string[]
    continuity?: Array<{
      draftId: number
      chapterNumber: number
      chapterTitle: string
      chapterNotes: string
      sourceStatus?: 'current' | 'stale' | 'legacy'
      facts?: Array<{
        category: 'character-state' | 'timeline' | 'open-thread' | 'plot'
        entities: string[]
        statement: string
        sourceChapter: number
        evidence: string
      }>
    }>
    continuitySourceContents?: Record<number, string>
    invalidContinuitySourceIds?: number[]
    narrativeThreads?: NarrativeThreadView[]
    previousFinalizedContent?: string
    selectedCandidateDrafts?: Array<{
      chapterNumber: number
      draftId: number
      version: number
      content: string
    }>
    knowledgeResults?: Array<{ text: string; score: number; fileName: string }>
    keyEvents?: string
    knowledgeQueryHint?: string
    characterCards?: Array<{
      name: string
      role: string
      currentState: Record<string, unknown>
      [key: string]: unknown
    }>
    sourceDraft?: { id: number; version: number }
  }) {
    let recoveryCandidateSequence = 0
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists' && String(args[0]).endsWith('/.vela/prompts')) return false
      if (channel === 'db:project-core-get') {
        return {
          premise: options.premise ?? '故事前提',
          charactersArch: options.charactersArch ?? '',
          worldbuilding: '',
          synopsis: '',
        }
      }
      if (channel === 'db:blueprint-get-all') return options.blueprints ?? []
      if (channel === 'db:blueprint-get') {
        return options.blueprints?.find(blueprint => blueprint.chapterNumber === args[0]) ?? null
      }
      if (channel === 'db:continuity-list-before') return options.continuity ?? []
      if (channel === 'db:continuity-read-source') {
        const draftId = Number(args[0])
        if (options.invalidContinuitySourceIds?.includes(draftId)) return { status: 'invalid' }
        const content = options.continuitySourceContents?.[draftId]
        if (content) {
          const projection = options.continuity?.find(item => item.draftId === draftId)
          return {
            status: 'valid',
            snapshot: {
              source: {
                draftId,
                finalizationId: `finalization-${draftId}`,
                chapterNumber: projection?.chapterNumber ?? 1,
                contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
              },
              chapterTitle: projection?.chapterTitle ?? '',
              content,
            },
          }
        }
        const projection = options.continuity?.find(item => item.draftId === draftId)
        if (!projection) return { status: 'invalid' }
        return {
          status: 'legacy',
          draftId,
          chapterNumber: projection.chapterNumber,
          chapterTitle: projection.chapterTitle,
          content: options.previousFinalizedContent
            && projection.chapterNumber === (options.chapterNumber ?? 1) - 1
            ? options.previousFinalizedContent
            : projection.facts?.map(fact => fact.evidence).join('\n\n') ?? '',
        }
      }
      if (channel === 'db:narrative-thread-list-relevant') return options.narrativeThreads ?? []
      if (channel === 'db:draft-get-finalized') {
        return options.previousFinalizedContent ? { id: 77 } : null
      }
      if (channel === 'db:draft-get-full') {
        const draftId = Number(args[0])
        const projection = options.continuity?.find(item => item.draftId === draftId)
        if (projection) {
          return {
            id: draftId,
            content: options.previousFinalizedContent && projection.chapterNumber === (options.chapterNumber ?? 1) - 1
              ? options.previousFinalizedContent
              : projection.facts?.map(fact => fact.evidence).join('\n\n') ?? '',
          }
        }
        return options.previousFinalizedContent && draftId === 77
          ? { id: 77, content: options.previousFinalizedContent }
          : null
      }
      if (channel === 'kb:search-writing-context') return options.knowledgeResults ?? []
      if (channel === 'db:character-get-all') return options.characterCards ?? []
      if (channel === 'db:character-roster-read') return {
        status: 'ready',
        entries: options.characterCards ?? [],
      }
      if (channel === 'db:draft-get-latest') return options.sourceDraft ?? null
      if (channel === 'fs:list-dir') return []
      if (channel === 'db:draft-next-version') return 1
      if (channel === 'db:draft-create') return { success: true, id: 'draft-1' }
      if (channel === 'db:recovery-candidate-record') {
        recoveryCandidateSequence += 1
        return {
          success: true,
          candidate: {
            ...(args[0] as Record<string, unknown>),
            candidateId: `candidate-${recoveryCandidateSequence}`,
          },
        } as { success: boolean; candidate?: { candidateId: string }; error?: string }
      }
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
          globalGuidance: options.globalGuidance,
          writingStyle: options.writingStyle,
          coreOutline: options.coreOutline,
          worldSetting: options.worldSetting,
          goldenFinger: options.goldenFinger,
          protagonistProfile: options.protagonistProfile,
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
      uiLocale: options.uiLocale ?? 'zh-CN',
    } as WorkflowContext
    const callbacks: StepCallbacks = {
      log: vi.fn(),
      setProgress: vi.fn(),
      appendText: vi.fn(),
      replaceText: vi.fn(),
    }
    const command = new GenerateDraftCommand({
      projectPath,
      chapterNumber: options.chapterNumber ?? 1,
      title: options.chapterNumber === 2 ? 'Chapter Two' : '第一章',
      role: '开端',
      purpose: '建立冲突',
      keyEvents: options.keyEvents ?? '开端',
      characters: options.characters ?? [],
      wordsTarget: options.wordsTarget,
      userGuidance: options.userGuidance,
      knowledgeQueryHint: options.knowledgeQueryHint,
    }, {
      dependencies: { createRuntime: options.runtime.createRuntime },
      selectedCandidateDrafts: options.selectedCandidateDrafts,
    })
    return { invoke, context, callbacks, command }
  }

  function expectNoDraftPersistence(invoke: ReturnType<typeof vi.fn>): void {
    expect(invoke).not.toHaveBeenCalledWith('db:draft-next-version', expect.anything(), expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  }

  it('persists visible prose from an interrupted stream before returning the error', async () => {
    const runtime = fakeRuntime((_attempt, _task, options) => {
      options?.onChunk?.('<think>private reasoning</think>林岚推开驾驶室的门。')
      throw Object.assign(new Error('connection reset'), { code: 'PROVIDER_REQUEST_FAILED' })
    })
    const { invoke, context, callbacks, command } = setup({ runtime, wordsTarget: 500 })

    await expect(command.execute({
      step: { id: 'draft-step' },
      context,
      callbacks,
    })).rejects.toThrow('connection reset')

    expect(invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-record',
      expect.objectContaining({
        runId: context.runId,
        stepId: 'draft-step',
        chapterNumber: 1,
        sourceDraft: null,
        visibleText: '林岚推开驾驶室的门。',
        failureCode: 'PROVIDER_REQUEST_FAILED',
      }),
      projectPath,
      context.projectSession,
    )
    expectNoDraftPersistence(invoke)
  })

  it('freezes the generation-start draft identity in a recovery candidate', async () => {
    const runtime = fakeRuntime((_attempt, _task, options) => {
      options?.onChunk?.('已有草稿之上的候选正文。')
      throw new Error('connection reset')
    })
    const { invoke, context, callbacks, command } = setup({
      runtime,
      sourceDraft: { id: 42, version: 3 },
    })

    await expect(command.execute({ step: { id: 'draft-step' }, context, callbacks }))
      .rejects.toThrow('connection reset')

    expect(invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-record',
      expect.objectContaining({ sourceDraft: { id: 42, version: 3 } }),
      projectPath,
      context.projectSession,
    )
  })

  it('persists received prose when cancellation wins the generation race', async () => {
    const activeContext: { value?: WorkflowContext } = {}
    const runtime = fakeRuntime((_attempt, _task, options) => {
      options?.onChunk?.('取消前已经收到的正文。')
      if (activeContext.value) activeContext.value.cancelled = true
      throw Object.assign(new Error('aborted'), { code: 'CANCELLED' })
    })
    const prepared = setup({ runtime, wordsTarget: 500 })
    activeContext.value = prepared.context

    await expect(prepared.command.execute({
      step: { id: 'draft-step' },
      context: prepared.context,
      callbacks: prepared.callbacks,
    })).rejects.toThrow('工作流已取消')

    expect(prepared.invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-record',
      expect.objectContaining({
        visibleText: '取消前已经收到的正文。',
        failureCode: 'CANCELLED',
      }),
      projectPath,
      prepared.context.projectSession,
    )
  })

  it('persists a quality-short candidate and never promotes it to drafts', async () => {
    const runtime = fakeRuntime(() => outcome('正文太短。', 'stop'))
    const { invoke, context, callbacks, command } = setup({ runtime, wordsTarget: 500 })

    await expect(command.execute({ step: { id: 'draft-step' }, context, callbacks }))
      .rejects.toThrow(/明显未达到章节目标/u)

    expect(invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-record',
      expect.objectContaining({ visibleText: expect.stringContaining('正文太短。') }),
      projectPath,
      context.projectSession,
    )
    expectNoDraftPersistence(invoke)
  })

  it('keeps the in-memory text and reports when candidate persistence fails', async () => {
    const runtime = fakeRuntime(() => outcome('正文太短。', 'stop'))
    const { invoke, context, callbacks, command } = setup({ runtime, wordsTarget: 500 })
    const baseInvoke = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:recovery-candidate-record') {
        return { success: false, error: 'disk full' }
      }
      return baseInvoke(channel, ...args)
    })

    await expect(command.execute({ step: { id: 'draft-step' }, context, callbacks }))
      .rejects.toThrow(/恢复候选保存失败.*disk full/u)
    expect(callbacks.replaceText).toHaveBeenLastCalledWith(expect.stringContaining('正文太短。'))
  })

  it('does not create a recovery candidate for a successful generation', async () => {
    const runtime = fakeOutcomes(outcome('正'.repeat(450), 'stop'))
    const { invoke, context, callbacks, command } = setup({ runtime, wordsTarget: 500 })

    await command.execute({ step: { id: 'draft-step' }, context, callbacks })

    expect(invoke.mock.calls.some(([channel]) => channel === 'db:recovery-candidate-record')).toBe(false)
  })

  it('uses the frozen English UI locale for draft start and save logs', async () => {
    const runtime = fakeRuntime(() => outcome('Draft prose. '.repeat(250), 'stop'))
    const { context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'zh-CN',
      uiLocale: 'en-US',
      wordsTarget: 500,
    })

    await command.execute({ step: {}, context, callbacks })

    const visibleLogs = vi.mocked(callbacks.log).mock.calls.flat().join('\n')
    expect(visibleLogs).toContain('Building chapter context')
    expect(visibleLogs).toContain('Calling AI to generate the chapter draft')
    expect(visibleLogs).toContain('Draft saved automatically as version v1')
    expect(visibleLogs).not.toMatch(/拼装章节上下文|调用 AI 生成章节草稿|草稿已自动入库/u)
  })

  it.each([
    { uiLocale: 'zh-CN', writingLanguage: 'zh-CN', expected: '你是一位经验丰富的小说作者', unexpected: 'You are an experienced fiction writer' },
    { uiLocale: 'en-US', writingLanguage: 'zh-CN', expected: '你是一位经验丰富的小说作者', unexpected: 'You are an experienced fiction writer' },
    { uiLocale: 'zh-CN', writingLanguage: 'en-US', expected: 'You are an experienced fiction writer', unexpected: '你是一位经验丰富的小说作者' },
    { uiLocale: 'en-US', writingLanguage: 'en-US', expected: 'You are an experienced fiction writer', unexpected: '你是一位经验丰富的小说作者' },
  ] as const)(
    'sends $writingLanguage built-in instructions through the provider request in a $uiLocale interface',
    async ({ uiLocale, writingLanguage, expected, unexpected }) => {
      useLocaleStore.setState({ locale: uiLocale })
      let observedTask: GenerationTask | undefined
      const runtime = fakeRuntime((_attempt, task) => {
        observedTask = task
        return outcome('English draft prose. '.repeat(166), 'stop')
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
      return outcome('Continuation prose. '.repeat(250), 'stop')
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
    const runtime = fakeOutcomes(outcome('正文。'.repeat(250), 'stop'))
    const { context, callbacks, command } = setup({ runtime, wordsTarget: 500 })
    ;(context as WorkflowContext & { generationModelId?: string }).generationModelId = 'grok-selected-model'

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('正文')

    expect(runtime.createRuntime).toHaveBeenCalledWith({
      budget: DRAFT_GENERATION_BUDGET,
      modelId: 'grok-selected-model',
    })
  })

  it('injects verbatim finalized excerpts without promoting mixed fact indexes to manuscript truth', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
    })
    const previousFinalizedContent = [
      '林岚拖着受伤的脚踝走进仓库。',
      '林岚把红色钥匙收进口袋。',
      '守门人要求她交出钥匙，她明确拒绝。',
      '上一章定稿结尾哨兵。',
    ].join('\n\n')
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      characters: ['林岚'],
      wordsTarget: 500,
      continuity: [{
        draftId: 41,
        chapterNumber: 1,
        chapterTitle: '作者第一章',
        chapterNotes: 'OLD_DERIVED_SUMMARY_MUST_NOT_REACH_PROVIDER',
        facts: [{
          category: 'character-state',
          entities: ['林岚'],
          statement: '林岚脚踝韧带受损，始终持有红色钥匙。',
          sourceChapter: 1,
          evidence: '林岚把红色钥匙收进口袋。',
        }],
      }],
      previousFinalizedContent,
      knowledgeResults: [{ text: '项目知识哨兵', score: 0.9, fileName: '世界观' }],
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).not.toContain('OLD_DERIVED_SUMMARY_MUST_NOT_REACH_PROVIDER')
    expect(prompt).not.toContain('林岚脚踝韧带受损，始终持有红色钥匙。')
    expect(prompt).not.toContain('[character-state]')
    expect(prompt).toContain('定稿原文 · 第1章 · draft 41 · 定位索引')
    expect(prompt).toContain('林岚把红色钥匙收进口袋。')
    expect(prompt).toContain('索引、摘要和 currentState 都不是作者事实')
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('定稿连续性原文（1 条候选）'))
    expect(prompt).toContain('上一章定稿结尾哨兵。')
    expect(prompt).not.toContain('批内候选稿结尾')
    expect(prompt).toContain('项目知识哨兵')
    expect(invoke).toHaveBeenCalledWith(
      'kb:search-writing-context',
      expect.any(String),
      5,
      projectPath,
      expect.anything(),
    )
  })

  it('captures final provider requests without legacy characters_arch, currentState, or chapter summaries', async () => {
    const runtime = fakeOutcomes(
      outcome('初'.repeat(100), 'length', 1),
      outcome(`${'续'.repeat(400)}。`, 'stop', 2),
    )
    const authorTask = '本章必须查明伤口原因，但不得交出钥匙。'
    const original = [
      '林岚扶住墙，左腿仍在发抖。',
      '她说伤口不是坠落造成的，而是昨夜被铁钩划开。',
      '周砚索要钥匙，她回答：“我不会交给你。”',
      '门外的脚步声突然停住。',
    ].join('\n\n')
    const { context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      characters: ['林岚'],
      keyEvents: authorTask,
      charactersArch: 'LEGACY_CHARACTERS_ARCH_SENTINEL',
      characterCards: [{
        name: '林岚',
        role: 'protagonist',
        personality: 'AUTHOR_PROFILE_SENTINEL',
        relationships: [{ target: '周砚', relation: '父子' }],
        legacyRelationshipNotes: '旧纸档记载两人曾是师徒',
        currentState: {
          location: '作者指定的码头',
          recentEvents: 'OLD_CURRENT_STATE_SENTINEL',
          provenance: {
            location: { kind: 'author', chapterNumber: 1 },
            recentEvents: { kind: 'legacy' },
          },
        },
      }],
      continuity: [{
        draftId: 41,
        chapterNumber: 1,
        chapterTitle: '伤口',
        chapterNotes: 'OLD_CHAPTER_SUMMARY_SENTINEL',
        facts: [{
          category: 'character-state',
          entities: ['林岚'],
          statement: 'DERIVED_STATEMENT_SENTINEL',
          sourceChapter: 1,
          evidence: '伤口不是坠落造成的',
        }],
      }],
      previousFinalizedContent: original,
    })

    await command.execute({ step: {}, context, callbacks })

    const providerPrompts = runtime.complete.mock.calls.map(([task]) => (
      task.messages.find(message => message.role === 'user')?.content ?? ''
    ))
    expect(providerPrompts).toHaveLength(2)
    for (const prompt of providerPrompts) {
      expect(prompt).toContain(authorTask)
      expect(prompt).toContain('AUTHOR_PROFILE_SENTINEL')
      expect(prompt).toContain('location@chapter1: 作者指定的码头')
      expect(prompt).toContain('relationship: 周砚 (父子)')
      expect(prompt).toContain('relationship（legacy 来源未知）: 旧纸档记载两人曾是师徒')
      expect(prompt).toContain('林岚扶住墙')
      expect(prompt).toContain('我不会交给你')
      expect(prompt).not.toContain('LEGACY_CHARACTERS_ARCH_SENTINEL')
      expect(prompt).not.toContain('OLD_CURRENT_STATE_SENTINEL')
      expect(prompt).not.toContain('OLD_CHAPTER_SUMMARY_SENTINEL')
      expect(prompt).not.toContain('DERIVED_STATEMENT_SENTINEL')
    }
  })

  it('rebuilds a stale locator from immutable finalized prose without injecting its statement', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
    })
    const { context, callbacks, command } = setup({
      runtime,
      chapterNumber: 3,
      characters: ['林岚'],
      wordsTarget: 500,
      continuity: [{
        draftId: 51,
        chapterNumber: 1,
        chapterTitle: '旧伤',
        chapterNotes: 'STALE_SUMMARY_SENTINEL',
        sourceStatus: 'stale',
        facts: [{
          category: 'character-state',
          entities: ['林岚'],
          statement: 'STALE_STATEMENT_SENTINEL',
          sourceChapter: 1,
          evidence: '铁钩划开了她的左腿',
        }],
      }],
      continuitySourceContents: {
        51: '林岚扶墙停下。\n\n铁钩划开了她的左腿。\n\n她拒绝把钥匙交给周砚。',
      },
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain('定位索引stale')
    expect(prompt).toContain('林岚扶墙停下')
    expect(prompt).toContain('她拒绝把钥匙交给周砚')
    expect(prompt).not.toContain('STALE_SUMMARY_SENTINEL')
    expect(prompt).not.toContain('STALE_STATEMENT_SENTINEL')
  })

  it('does not fall back to an ordinary draft body after finalized-source validation fails', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
    })
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 3,
      wordsTarget: 500,
      characters: ['林岚'],
      invalidContinuitySourceIds: [51],
      continuity: [{
        draftId: 51,
        chapterNumber: 1,
        chapterTitle: '损坏收据',
        chapterNotes: '',
        facts: [{
          category: 'character-state',
          entities: ['林岚'],
          statement: 'UNVERIFIED_STATEMENT_SENTINEL',
          sourceChapter: 1,
          evidence: 'UNVERIFIED_BODY_SENTINEL',
        }],
      }],
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).not.toContain('UNVERIFIED_BODY_SENTINEL')
    expect(prompt).not.toContain('UNVERIFIED_STATEMENT_SENTINEL')
    expect(prompt).toContain('finalized#1:source-invalid')
    expect(invoke).not.toHaveBeenCalledWith('db:draft-get-full', 51, projectPath, expect.anything())
  })

  it('marks an injected batch draft ending as unconfirmed continuity context', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
    })
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      selectedCandidateDrafts: [{
        chapterNumber: 1,
        draftId: 31,
        version: 3,
        content: '批内上一章候选稿结尾哨兵。',
      }],
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain('未定稿候选 · 第1章 · draft 31 · v3')
    expect(prompt).toContain('候选正文尚未确认，不得冒充定稿')
    expect(prompt).toContain('批内上一章候选稿结尾哨兵。')
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({
        sourceDependencies: [{
          draftId: 31,
          contentHash: createHash('sha256').update('批内上一章候选稿结尾哨兵。', 'utf8').digest('hex'),
        }],
      }),
      projectPath,
      expect.anything(),
    )
    expect(invoke).toHaveBeenCalledWith('db:draft-get-finalized', 1, projectPath, expect.anything())
  })

  it('persists the exact candidate dependency chain in chapter order', async () => {
    const runtime = fakeRuntime(() => outcome('新章正文。'.repeat(125), 'stop'))
    const chapterOne = '林岚把钥匙藏进钟楼。'
    const chapterTwo = '周砚抵达码头，林岚仍未交出钥匙。'
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 3,
      wordsTarget: 500,
      selectedCandidateDrafts: [
        { chapterNumber: 2, draftId: 32, version: 4, content: chapterTwo },
        { chapterNumber: 1, draftId: 31, version: 2, content: chapterOne },
      ],
    })

    await command.execute({ step: {}, context, callbacks })

    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({
        sourceDependencies: [
          {
            draftId: 31,
            contentHash: createHash('sha256').update(chapterOne, 'utf8').digest('hex'),
          },
          {
            draftId: 32,
            contentHash: createHash('sha256').update(chapterTwo, 'utf8').digest('hex'),
          },
        ],
      }),
      projectPath,
      expect.anything(),
    )
  })

  it('distinguishes author hard constraints from finalized state changes in English', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('New chapter prose. '.repeat(200), 'stop')
    })
    const { context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'en-US',
      chapterNumber: 2,
      wordsTarget: 500,
      continuity: [{
        draftId: 41,
        chapterNumber: 1,
        chapterTitle: 'Transfer',
        chapterNotes: '',
        facts: [{
          category: 'character-state',
          entities: ['Maya'],
          statement: 'Maya transferred the key.',
          sourceChapter: 1,
          evidence: 'Maya put the key in Eli’s hand.',
        }],
      }],
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain('Finalized excerpts establish only their exact text')
    expect(prompt).toContain('summaries, and currentState are not author facts')
  })

  it('puts an explicit knowledge hint before more than eight generated query terms', async () => {
    const runtime = fakeRuntime(() => outcome('新章正文。'.repeat(125), 'stop'))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      keyEvents: '数据 对峙 异常 标签 旧实验室 陆星辰 系统 警报 第七章',
      characters: ['林晓'],
      knowledgeQueryHint: '作者检索哨兵',
    })

    await command.execute({ step: {}, context, callbacks })

    const searchCall = invoke.mock.calls.find(([channel]) => channel === 'kb:search-writing-context')
    expect(searchCall?.[1]).toBe(
      '作者检索哨兵 Chapter Two 数据 对峙 异常 标签 旧实验室 陆星辰 系统 警报 第七章 林晓',
    )
  })

  it.each([1, 2])('sends retrieved planning material in the Chapter %s draft request', async (chapterNumber) => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('本章正文持续推进。'.repeat(60), 'stop')
    })
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber,
      wordsTarget: 500,
      knowledgeResults: [{
        text: '规划资料唯一事实：月桂港的潮汐钟每天倒走十三分钟。',
        score: 0.99,
        fileName: 'world-notes.md',
      }],
    })

    await command.execute({ step: {}, context, callbacks })

    expect(invoke.mock.calls.some(([channel]) => channel === 'kb:search-writing-context')).toBe(true)
    expect(observedTask?.messages.map(message => message.content).join('\n'))
      .toContain('规划资料唯一事实：月桂港的潮汐钟每天倒走十三分钟。')
  })

  it.each([
    { writingLanguage: 'zh-CN' as const, completedBoundary: '记录的是已发生历史', forbiddenReplay: '不得引用、摘要、回放或重演' },
    { writingLanguage: 'en-US' as const, completedBoundary: 'records completed history', forbiddenReplay: 'Do not quote, summarize, replay, or restage' },
  ])('marks previous prose as completed history in $writingLanguage', async ({
    writingLanguage,
    completedBoundary,
    forbiddenReplay,
  }) => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome(writingLanguage === 'zh-CN'
        ? '新事件继续发生。'.repeat(70)
        : 'A new event moves the story forward. '.repeat(70), 'stop')
    })
    const { context, callbacks, command } = setup({
      runtime,
      writingLanguage,
      chapterNumber: 2,
      wordsTarget: 500,
      previousFinalizedContent: writingLanguage === 'zh-CN'
        ? '上一章已经结束。'.repeat(100)
        : 'The previous chapter is complete. '.repeat(100),
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain(completedBoundary)
    expect(prompt).toContain(forbiddenReplay)
  })

  it('keeps workflow metadata out of both initial and continuation writer chapter briefs', async () => {
    const runtime = fakeOutcomes(
      outcome('初'.repeat(100), 'length', 1),
      outcome(`${'续'.repeat(400)}。`, 'stop', 2),
    )
    const keyEvents = '必须保留的创作事件'
    const userGuidance = '必须保留的作者指导'
    const knowledgeQueryHint = 'PRIVATE_QUERY_SENTINEL'
    const { context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      keyEvents,
      userGuidance,
      knowledgeQueryHint,
    })

    await command.execute({ step: {}, context, callbacks })

    const prompts = runtime.complete.mock.calls.map(([task]) => (
      task.messages.find(message => message.role === 'user')?.content ?? ''
    ))
    expect(prompts).toHaveLength(2)
    for (const prompt of prompts) {
      expect(prompt).toContain(keyEvents)
      expect(prompt).toContain(userGuidance)
      expect(prompt).not.toContain(projectPath)
      expect(prompt).not.toContain(knowledgeQueryHint)
      expect(prompt).not.toContain('"wordsTarget"')
    }
  })

  it('injects guidance and style once while retaining the remaining author configuration', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新事件继续发生。'.repeat(70), 'stop')
    })
    const globalGuidance = 'GLOBAL-GUIDANCE-ONCE'
    const writingStyle = 'WRITING-STYLE-ONCE'
    const coreOutline = 'AUTHOR-CORE-FACT'
    const { context, callbacks, command } = setup({
      runtime,
      wordsTarget: 500,
      globalGuidance,
      writingStyle,
      coreOutline,
    })

    await command.execute({ step: {}, context, callbacks })

    const completePrompt = observedTask?.messages.map(message => message.content).join('\n') ?? ''
    expect(completePrompt.match(new RegExp(globalGuidance, 'g'))).toHaveLength(1)
    expect(completePrompt.match(new RegExp(writingStyle, 'g'))).toHaveLength(1)
    expect(completePrompt).toContain(coreOutline)
  })

  it('keeps the head, middle, and tail of authored guidance in every draft request', async () => {
    const authorGuidance = [
      'AUTHOR_RULE_BEGIN。',
      '保持因果推进。'.repeat(80),
      `PARTIAL_RULE_SHOULD_NOT_APPEAR_${'x'.repeat(200)}。`,
      'AUTHOR_RULE_AFTER_LIMIT。',
    ].join('\n')
    const runtime = fakeOutcomes(
      outcome('初'.repeat(100), 'length', 1),
      outcome(`${'续'.repeat(320)}。`, 'length', 2),
      outcome(`${'后'.repeat(50)}。`, 'stop', 3),
    )
    const { context, callbacks, command } = setup({
      runtime,
      wordsTarget: 500,
      globalGuidance: authorGuidance,
    })

    await command.execute({ step: {}, context, callbacks })

    const requestPrompts = runtime.complete.mock.calls.map(([task]) => (
      task.messages.find(message => message.role === 'user')?.content ?? ''
    ))
    expect(requestPrompts).toHaveLength(3)
    for (const prompt of requestPrompts) {
      expect(prompt).toContain('AUTHOR_RULE_BEGIN')
      expect(prompt).toContain('PARTIAL_RULE_SHOULD_NOT_APPEAR')
      expect(prompt).toContain('AUTHOR_RULE_AFTER_LIMIT')
    }
    expect(useProjectStore.getState().currentProject?.novelConfig.globalGuidance)
      .toBe(authorGuidance)
  })

  it('keeps every authored configuration fact in initial drafting and every continuation', async () => {
    const longField = (name: string) => [
      `${name}_BEGIN。`,
      '保留稳定的作者事实。'.repeat(75),
      `${name}_PARTIAL_SHOULD_NOT_APPEAR_${'x'.repeat(400)}。`,
      `${name}_AFTER_LIMIT。`,
    ].join('\n')
    const authoredConfig = {
      globalGuidance: longField('GUIDANCE'),
      writingStyle: longField('STYLE'),
      coreOutline: longField('OUTLINE'),
      worldSetting: longField('WORLD'),
      goldenFinger: longField('ADVANTAGE'),
      protagonistProfile: longField('PROTAGONIST'),
    }
    const runtime = fakeOutcomes(
      outcome('初'.repeat(100), 'length', 1),
      outcome(`${'续'.repeat(320)}。`, 'length', 2),
      outcome(`${'后'.repeat(50)}。`, 'stop', 3),
    )
    const { context, callbacks, command } = setup({
      runtime,
      wordsTarget: 500,
      ...authoredConfig,
    })

    await command.execute({ step: {}, context, callbacks })

    const requestPrompts = runtime.complete.mock.calls.map(([task]) => (
      task.messages.find(message => message.role === 'user')?.content ?? ''
    ))
    expect(requestPrompts).toHaveLength(3)
    for (const prompt of requestPrompts) {
      for (const name of ['GUIDANCE', 'STYLE', 'OUTLINE', 'WORLD', 'ADVANTAGE', 'PROTAGONIST']) {
        expect(prompt).toContain(`${name}_BEGIN`)
        expect(prompt).toContain(`${name}_PARTIAL_SHOULD_NOT_APPEAR`)
        expect(prompt).toContain(`${name}_AFTER_LIMIT`)
      }
    }
    expect(useProjectStore.getState().currentProject?.novelConfig).toMatchObject(authoredConfig)
  })

  it('rejects a new chapter that substantially replays the previous ending before persistence', async () => {
    const replayedAction = [
      '他抠住残片边缘发力，一声脆响，残片离体，掌心纹路骤然炽亮。',
      '他跃入通风竖井，砸碎腕表，将灵核残片按进左臂，银灰纹路沿血管攀援。',
      '他割开掌心，残片浮出覆盖时间戳和签名密钥，校准员的脚步声抵达竖井口。',
    ].join('')
    const runtime = fakeRuntime(() => outcome(
      `${replayedAction}\n\n${'新的场景继续向前推进。'.repeat(35)}`,
      'stop',
    ))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      previousFinalizedContent: `${'此前事件。'.repeat(150)}${replayedAction}`,
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('大段重演')

    expectNoDraftPersistence(invoke)
  })

  it('does not hard-reject cumulative reuse spread across short fragments', async () => {
    const previousEnding = [
      '远处，走廊尽头传来急促的脚步声，皮靴踏在金属地面上，一声声，冷硬如铁砧。',
      '残片像一枚倒计时的活体引信，在皮肉下高频搏动。',
      '银灰纹路像一条刚刚苏醒的、暗红色的虫，沿着血管爬行。',
    ].join('\n\n')
    const replayedOpening = [
      '远处走廊尽头，皮靴踏在金属地面上，一声声，冷硬如铁砧。',
      '那枚残片像一枚倒计时的活体引信，在皮肉下高频搏动。',
      '纹路像一条刚苏醒的暗红色虫，重新钻向指尖。',
    ].join('\n\n')
    const runtime = fakeRuntime(() => outcome(
      `${replayedOpening}\n\n${'本章的新事件持续推进。'.repeat(40)}`,
      'stop',
    ))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      previousFinalizedContent: `${'此前事件。'.repeat(150)}${previousEnding}`,
    })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('本章的新事件')
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: expect.stringContaining('本章的新事件') }),
      expect.anything(),
      expect.anything(),
    )
  })

  it.each([
    {
      previous: '她把空账簿寄给联邦中央档案管理总局第七特别调查委员会，又通知北方边境异常能量联合观测实验研究中心，当夜离港。',
      next: '三日后，联邦中央档案管理总局第七特别调查委员会撤销通缉；北方边境异常能量联合观测实验研究中心则发现一颗新卫星。',
    },
    {
      previous: '顾舟向泛大陆古代文字数字化保护与联合研究理事会递交拓片，并请环赤道深海热泉生态长期监测联合实验室保管样本。',
      next: '半年后，泛大陆古代文字数字化保护与联合研究理事会公布了新译文；环赤道深海热泉生态长期监测联合实验室则报告了物种迁徙。',
    },
  ])('allows repeated long proper names when the surrounding events are different', async ({ previous, next }) => {
    const runtime = fakeRuntime(() => outcome(
      `${next}\n\n${'本章沿着全新的因果继续推进。'.repeat(32)}`,
      'stop',
    ))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      previousFinalizedContent: `${'此前事件。'.repeat(150)}${previous}`,
    })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain(next)
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: expect.stringContaining(next) }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('allows a short state echo before the new chapter advances', async () => {
    const sharedState = '远处传来脚步声，顾长庚握紧残片，却没有回头。'
    const runtime = fakeRuntime(() => outcome(
      `${sharedState}\n\n${'他进入新的区域并处理本章的新冲突。'.repeat(27)}`,
      'stop',
    ))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      previousFinalizedContent: `${'此前事件。'.repeat(150)}${sharedState}`,
    })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain(sharedState)

    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: expect.stringContaining('新的区域') }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('allows one short English carry-over sentence before new action', async () => {
    const sharedState = 'Boots rang on the steel floor while Gu held the shard and did not look back.'
    const runtime = fakeRuntime(() => outcome(
      `${sharedState}\n\n${'She crossed the next threshold and confronted a new conflict. '.repeat(45)}`,
      'stop',
    ))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'en-US',
      chapterNumber: 2,
      wordsTarget: 500,
      previousFinalizedContent: `${'Earlier events moved forward. '.repeat(100)}${sharedState}`,
    })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain(sharedState)

    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: expect.stringContaining('next threshold') }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('allows ordinary English phrases shared with the previous chapter', async () => {
    const previousEnding = [
      'No one believed the truce would last.',
      'He waited beneath the yellow canopy.',
      'They stopped counting bodies before dawn.',
      'Smoke circled the fluorescent light above the desk.',
    ].join(' ')
    const newOpening = [
      'The truce held for twenty-seven minutes.',
      'Maya pulled the yellow ribbon from her bag.',
      'She resumed counting floor tiles.',
      'Above her, the fluorescent light flickered once.',
    ].join(' ')
    const runtime = fakeRuntime(() => outcome(
      `${newOpening}\n\n${'Fresh action moved Maya deeper into the archive without revisiting any completed event. '.repeat(34)}`,
      'stop',
    ))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'en-US',
      chapterNumber: 2,
      wordsTarget: 500,
      previousFinalizedContent: previousEnding,
    })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain(newOpening)

    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: expect.stringContaining('The truce held') }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('still rejects an English chapter that copies a continuous passage', async () => {
    const copiedPassage = [
      'Maya measured every cracked tile while Eli copied the dimensions into his notebook,',
      'then they sealed the archive door and hid the only key beneath the broken recorder.',
    ].join(' ')
    const runtime = fakeRuntime(() => outcome(
      `${copiedPassage}\n\n${'New consequences forced them to abandon the room and confront the dean outside. '.repeat(36)}`,
      'stop',
    ))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'en-US',
      uiLocale: 'en-US',
      chapterNumber: 2,
      wordsTarget: 500,
      previousFinalizedContent: `Earlier events led here. ${copiedPassage}`,
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('substantially replays')

    expectNoDraftPersistence(invoke)
  })

  it('keeps older facts only when they are relevant to the current chapter entities', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
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
            entities: [],
            statement: '早期事实哨兵：林岚不会游泳。',
            sourceChapter: 1,
            evidence: '她在河边承认自己不会游泳。',
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
    expect(prompt).toContain('她在河边承认自己不会游泳。')
    expect(prompt).not.toContain('早期事实哨兵')
    // Complete adjacent paragraphs are preserved even when only the hit drove retrieval.
    expect(prompt).toContain('周远穿上新鞋。')
    expect(prompt).not.toContain('无关事实哨兵')
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('定稿连续性原文（1 条候选）'))
  })

  it('keeps an older relevant fact when newer chapter notes exhaust the context budget', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
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
    expect(prompt).toContain('林岚在旧码头拒绝登船。')
    expect(prompt).toContain('定稿原文 · 第1章 · draft 41 · 定位索引')
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('定稿连续性原文（1 条候选）'))
  })

  it('injects a bounded set of relevant active narrative threads into the next chapter prompt', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
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

  it('bounds provisional renders for a burst of small chunks and still reconciles the terminal draft', async () => {
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

    for (let index = 0; index < 12_000; index += 1) streamChunk!('文')

    expect(replaceText.mock.calls.length).toBeLessThanOrEqual(2)

    const terminalDraft = `${'终稿正文'.repeat(1250)}。`
    resolveAttempt!(outcome(terminalDraft, 'stop'))
    await execution

    const persisted = setupResult.invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    const persistedText = (persisted?.[1] as { content: string }).content
    expect(replaceText).toHaveBeenLastCalledWith(persistedText)
  })

  it('bounds continuation renders for a burst of small chunks and keeps the accepted continuation', async () => {
    let resolveContinuation: ((value: GenerationOutcome) => void) | undefined
    let streamContinuation: ((chunk: string) => void) | undefined
    const initialDraft = '初'.repeat(4000)
    const runtime = fakeRuntime((attempt, _task, options) => {
      if (attempt === 1) return outcome(initialDraft, 'length', 1)
      streamContinuation = (options as { onChunk?: (chunk: string) => void } | undefined)?.onChunk
      return new Promise<GenerationOutcome>(resolve => { resolveContinuation = resolve })
    })
    const setupResult = setup({ runtime })
    const replaceText = vi.fn()
    const callbacks = Object.assign(setupResult.callbacks, { replaceText })

    const execution = setupResult.command.execute({
      step: {},
      context: setupResult.context,
      callbacks,
    })
    await vi.waitFor(() => expect(streamContinuation).toBeTypeOf('function'))
    const callsBeforeContinuation = replaceText.mock.calls.length

    for (let index = 0; index < 12_000; index += 1) streamContinuation!('续')

    expect(replaceText.mock.calls.length - callsBeforeContinuation).toBeLessThanOrEqual(2)

    const terminalContinuation = `${'续'.repeat(1000)}。`
    resolveContinuation!(outcome(terminalContinuation, 'stop', 2))
    await execution

    const persisted = setupResult.invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    expect((persisted?.[1] as { content: string }).content).toBe(
      `${initialDraft}\n\n${terminalContinuation}`,
    )
  })

  it('keeps provisional text as a recovery candidate after a failed attempt and ignores late chunks', async () => {
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

    expect(replaceText).toHaveBeenLastCalledWith('不会落盘的正文')
    lateChunk?.('晚到的正文')
    expect(replaceText).toHaveBeenLastCalledWith('不会落盘的正文')
    expect(JSON.stringify(replaceText.mock.calls)).not.toContain('晚到的正文')
    expect(setupResult.invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-record',
      expect.objectContaining({ visibleText: '不会落盘的正文' }),
      expect.anything(),
      expect.anything(),
    )
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
    const runtime = fakeOutcomes(outcome(draft, 'stop'))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'en-US',
      wordsTarget: 900,
    })

    await command.execute({ step: {}, context, callbacks })

    const persisted = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    expect(persisted?.[1]).toMatchObject({
      wordCount: countDraftUnits((persisted?.[1] as { content: string }).content),
    })
    expect(runtime.complete).toHaveBeenCalledOnce()
  })

  it.each([1604, 2285])(
    'persists a complete %i-unit result above a 1000-unit target without length repair',
    async visibleUnits => {
      const draft = '正'.repeat(visibleUnits)
      const runtime = fakeOutcomes(outcome(draft, 'stop'))
      const { invoke, context, callbacks, command } = setup({
        runtime,
        wordsPerChapter: 1000,
        wordsTarget: 1000,
      })

      await expect(command.execute({ step: {}, context, callbacks })).resolves.toBe(draft)

      expect(runtime.complete).toHaveBeenCalledOnce()
      expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft'])
      expect(invoke).toHaveBeenCalledWith(
        'db:draft-create',
        expect.objectContaining({ content: draft, wordCount: visibleUnits }),
        expect.anything(),
        expect.anything(),
      )
    },
  )

  it('continues a length result even after it has crossed 82%', async () => {
    const runtime = fakeOutcomes(
      outcome('初'.repeat(5000), 'length', 1),
      outcome(`${'续'.repeat(800)}。`, 'stop', 2),
    )
    const { context, callbacks, command } = setup({ runtime, wordsPerChapter: 6000 })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')
    expect(runtime.complete).toHaveBeenCalledTimes(2)
  })

  it('continues an over-target length candidate and commits only after a stop result', async () => {
    const initialCandidate = `${'甲'.repeat(4000)}。`
    const continuation = `${'乙'.repeat(2800)}。`
    const runtime = fakeOutcomes(
      outcome(initialCandidate, 'length', 1),
      outcome(continuation, 'stop', 2),
    )
    const { invoke, context, callbacks, command } = setup({
      runtime,
      wordsPerChapter: 3000,
      wordsTarget: 3000,
    })

    const completedDraft = `${initialCandidate}\n\n${continuation}`
    await expect(command.execute({ step: {}, context, callbacks })).resolves.toBe(completedDraft)

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual([
      'chapter-draft',
      'chapter-draft-continuation',
    ])
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: completedDraft }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('keeps an over-target length candidate visible when the shared budget cannot continue it', async () => {
    const initialCandidate = `${'甲'.repeat(4000)}。`
    const runtime = fakeRuntime((attempt) => {
      if (attempt === 1) return outcome(initialCandidate, 'length', 1)
      throw new Error('生成会话已用尽请求次数。')
    })
    const setupResult = setup({ runtime, wordsPerChapter: 3000, wordsTarget: 3000 })
    const replaceText = vi.fn()
    const callbacks = Object.assign(setupResult.callbacks, { replaceText })

    await expect(setupResult.command.execute({
      step: {},
      context: setupResult.context,
      callbacks,
    })).rejects.toThrow('生成会话已用尽请求次数')

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual([
      'chapter-draft',
      'chapter-draft-continuation',
    ])
    expect(replaceText).toHaveBeenLastCalledWith(initialCandidate)
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('已保存为项目恢复候选'))
    expectNoDraftPersistence(setupResult.invoke)
  })

  it('keeps frozen relevant state, continuity, and selected references in continuations', async () => {
    const characterStateSentinel = 'UNIQUE_ROLE_STATE_MIDDLE_SENTINEL'
    const characterProfileSentinel = 'UNIQUE_AUTHOR_PROFILE_SENTINEL'
    const continuitySentinel = 'UNIQUE_DERIVED_SUMMARY_MUST_NOT_REACH_PROVIDER'
    const finalizedEvidenceSentinel = 'UNIQUE_FINALIZED_ORIGINAL_MIDDLE_SENTINEL'
    const referenceSentinel = 'UNIQUE_SELECTED_REFERENCE_MIDDLE_SENTINEL'
    const characterCards = [
      {
        name: '林岚',
        role: 'protagonist',
        personality: characterProfileSentinel,
        currentState: {
          powerLevel: '普通人',
          location: '旧档案馆',
          physicalState: '轻伤',
          mentalState: characterStateSentinel,
          keyItems: '蓝色钥匙',
          recentEvents: '接到交接任务',
          updatedAtChapter: 1,
        },
      },
      {
        name: '周岚',
        role: 'supporting',
        currentState: { mentalState: 'IRRELEVANT_ROLE_STATE_SENTINEL' },
      },
    ]
    const sharedSetup = {
      chapterNumber: 2,
      characters: ['林岚'],
      characterCards,
      continuity: [{
        draftId: 41,
        chapterNumber: 1,
        chapterTitle: '交接',
        chapterNotes: continuitySentinel,
        facts: [{
          category: 'character-state' as const,
          entities: ['林岚'],
          statement: continuitySentinel,
          sourceChapter: 1,
          evidence: finalizedEvidenceSentinel,
        }],
      }],
      knowledgeResults: [{ fileName: 'author-notes.md', score: 0.99, text: referenceSentinel }],
    }
    const initialRuntime = fakeOutcomes(outcome(`${'首'.repeat(500)}。`, 'stop', 1))
    const initial = setup({
      runtime: initialRuntime,
      chapterNumber: 1,
      wordsTarget: 500,
      characters: sharedSetup.characters,
      characterCards,
    })
    await initial.command.execute({ step: {}, context: initial.context, callbacks: initial.callbacks })
    const initialPrompt = initialRuntime.complete.mock.calls[0]?.[0].messages
      .find(message => message.role === 'user')?.content ?? ''
    const continuationRuntime = fakeOutcomes(
      outcome('初'.repeat(100), 'length', 1),
      outcome(`${'续'.repeat(400)}。`, 'stop', 2),
    )
    const continuation = setup({
      runtime: continuationRuntime,
      wordsTarget: 500,
      ...sharedSetup,
    })
    await continuation.command.execute({ step: {}, context: continuation.context, callbacks: continuation.callbacks })
    const continuationPrompt = continuationRuntime.complete.mock.calls[1]?.[0].messages
      .find(message => message.role === 'user')?.content ?? ''

    const overTargetContinuationRuntime = fakeOutcomes(
      outcome(`${'甲'.repeat(4000)}。`, 'length', 1),
      outcome(`${'乙'.repeat(2800)}。`, 'stop', 2),
    )
    const overTargetContinuation = setup({
      runtime: overTargetContinuationRuntime,
      wordsPerChapter: 3000,
      wordsTarget: 3000,
      ...sharedSetup,
    })
    await overTargetContinuation.command.execute({
      step: {},
      context: overTargetContinuation.context,
      callbacks: overTargetContinuation.callbacks,
    })
    const overTargetContinuationPrompt = overTargetContinuationRuntime.complete.mock.calls[1]?.[0].messages
      .find(message => message.role === 'user')?.content ?? ''

    for (const prompt of [initialPrompt, continuationPrompt, overTargetContinuationPrompt]) {
      expect(prompt).toContain(characterProfileSentinel)
      expect(prompt).not.toContain(characterStateSentinel)
      expect(prompt).not.toContain('IRRELEVANT_ROLE_STATE_SENTINEL')
      expect(prompt).not.toContain(continuitySentinel)
    }
    for (const prompt of [continuationPrompt, overTargetContinuationPrompt]) {
      expect(prompt).toContain(finalizedEvidenceSentinel)
      expect(prompt).toContain(referenceSentinel)
    }
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
    expect(prompts[0]).toContain('[Sourced history and candidates]')
    expect(prompts[0]).toContain('(no relevant knowledge-base context)')
    expect(prompts[0]).toContain('(no additional author material)')
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

    const contextWithSkill = {
      ...context,
      writingSkills: Object.freeze({
        drafting: Object.freeze({
          skillId: 'user:scene-craft', name: 'Scene craft', stage: 'drafting' as const,
          source: 'user' as const, writingLanguage: 'zh-CN' as const,
          content: '用具体动作推进因果变化。', utf8Bytes: 36,
        }),
      }),
    }
    await command.execute({ step: {}, context: contextWithSkill, callbacks })

    const task = runtime.complete.mock.calls[0]?.[0] as GenerationTask
    const prompt = task.messages.find(message => message.role === 'user')?.content ?? ''
    expect(task).toMatchObject({ purpose: 'chapter-draft', output: 'visible-text' })
    expect(prompt).toContain('【补充写作 Skill：Scene craft】')
    expect(prompt).toContain('用具体动作推进因果变化。')
    expect(prompt).not.toMatch(/\{\{(?:chapter_info|future_blueprints|user_guidance)\}\}/u)
    expect(prompt).toContain('第2章 蓝门回声：追查蓝色漆屑与撞击声')
    expect(prompt).toContain('第一章必须以潮湿灯塔开场')
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
