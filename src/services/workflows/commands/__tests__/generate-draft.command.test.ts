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
  type MainGenerationRunHandle,
  type MainGenerationRunView,
} from '../../../generation/generation-runtime'
import type {
  GenerationAttemptReceipt,
  GenerationOutcome,
  GenerationTask,
} from '../../../generation/generation-harness'
import { EN_US_BUILTIN_PROMPTS } from '../../../prompt-language'
import { BUILTIN_PROMPTS, clearProjectCustomPrompts } from '../../../prompt-templates'
import { composeDraftVisibleContinuation, DRAFT_VISIBLE_TEXT_VERSION } from '../../../../shared/draft-visible-text'
import { parseDraftReconciliation, renderDraftReconciliationBlock, stripDraftReconciliationBlock } from '../../../../shared/draft-reconciliation'
import { appendVisibleTextContinuation } from '../../bounded-completion'
import {
  DRAFT_GENERATION_BUDGET,
  GenerateDraftCommand,
  countDraftUnits,
  previousChapterEnding,
  sanitizeDraftText,
  synopsisForDraftChapter,
  type GenerateDraftCommandDependencies,
} from '../generate-draft.command'

describe('generate draft command text cleanup', () => {
  it('主进程正文投影保持旧续接规则且不改原始片段', () => {
    const first = `<think>内部推理</think>\n${'林舟守在海港等待潮汐。'.repeat(12)}\n\n未完待续`
    const second = `${'林舟守在海港等待潮汐。'.repeat(8)}\n\n钟楼终于亮起灯。`
    const original = [first, second]
    const oldProjection = sanitizeDraftText(appendVisibleTextContinuation(sanitizeDraftText(first), sanitizeDraftText(second)))
    expect(DRAFT_VISIBLE_TEXT_VERSION).toBe('draft-visible-v1')
    expect(composeDraftVisibleContinuation(first, second)).toBe(oldProjection)
    expect([first, second]).toEqual(original)
    expect(composeDraftVisibleContinuation(first, second)).not.toContain('内部推理')
    expect(composeDraftVisibleContinuation(first, second)).toContain('钟楼终于亮起灯。')
  })
  it.each(['```', '~~~'])('keeps quoted chapter examples inside %s fences verbatim', (fence) => {
    const synopsis = `全局说明\n${fence}text\n## 第1章：示例\n作者不可丢事实甲\n## 第2章：示例\n作者不可丢事实乙\n${fence}\n全局尾部`
    expect(synopsisForDraftChapter(synopsis, 2)).toBe(synopsis)
  })

  it('keeps global sections and the exact current chapter from an explicit Chinese chapter outline', () => {
    const synopsis = `# 全书总纲
潮门只能由守钟人开启。

## 第1章：失钟
顾舟遗失潮汐钟。

## 第2章：回港
顾舟在退潮前回到月桂港。

## 第3章：潮门
顾舟找到潮门。

## 全局禁则
潮门真相只能在终章揭晓。`

    const projected = synopsisForDraftChapter(synopsis, 2)

    expect(projected).toContain('潮门只能由守钟人开启')
    expect(projected).toContain('## 第2章：回港')
    expect(projected).toContain('潮门真相只能在终章揭晓')
    expect(projected).not.toContain('顾舟遗失潮汐钟')
    expect(projected).not.toContain('顾舟找到潮门')
  })

  it('keeps an ambiguous chapter outline verbatim instead of guessing which facts to drop', () => {
    const synopsis = `## 第1章：甲
事实甲。

### 第2章：乙
事实乙。`

    expect(synopsisForDraftChapter(synopsis, 2)).toBe(synopsis)
  })

  it('does not treat ordinary prose mentioning a later chapter as a chapter heading', () => {
    const synopsis = `全局说明：第2章发生的事将在未来改变潮门归属。

普通正文仍属于全局大纲，不含 Markdown 章节标题。`

    expect(synopsisForDraftChapter(synopsis, 2)).toBe(synopsis)
  })

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
    expect(zhFirst?.content).toContain('不得仅为展示信息而让角色公开说出只由其私下感知、尚未转述的内容')
    expect(zhFirst?.content).not.toContain('全部改成"角色对话 + 神态描写 + 动作互动"')
    expect(zhFirst?.content).toContain('{{chapter_info}}')
    expect(zhFirst?.content).toContain('{{global_guidance}}')
    expect(zhFirst?.systemSuffix).toContain('{{user_guidance}}')
    expect(`${zhFirst?.content}\n${zhFirst?.systemSuffix}`).not.toContain('留置一个强力钩子')
    expect(`${zhNext?.content}\n${zhNext?.systemSuffix}`).toContain('不因此成为已发生事件')
    expect(`${zhNext?.content}\n${zhNext?.systemSuffix}`).not.toContain('上述事件已经发生完毕')
    expect(`${zhNext?.content}\n${zhNext?.systemSuffix}`).not.toContain('必须卡在一个剧情的小高潮点或突发变故上')
    expect(`${enFirst.content}\n${enFirst.systemSuffix}`).toContain('only when the chapter brief explicitly requires it')
    expect(enFirst.content).toContain('Do not turn private perception into public dialogue merely to expose information')
    expect(enFirst.content).toContain('{{chapter_info}}')
    expect(enFirst.content).toContain('{{global_guidance}}')
    expect(enFirst.systemSuffix).toContain('{{user_guidance}}')
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
  // 生成前定稿对账单独记录，默认返回不可解析的输出（按无对账继续），不计入正文尝试。
  reconcileAttempt: (task: GenerationTask) => GenerationOutcome | Promise<GenerationOutcome> = () => outcome('{}', 'stop'),
) {
  let attempt = 0
  const reconcile = vi.fn(async (task: GenerationTask) => reconcileAttempt(task))
  const complete = vi.fn(async (task: GenerationTask, options?: { signal?: AbortSignal }) => {
    attempt += 1
    return completeAttempt(attempt, task, options)
  })
  const routed = async (task: GenerationTask, options?: { signal?: AbortSignal }) => task.purpose === 'chapter-draft-reconcile'
    ? reconcile(task) : complete(task, options)
  const execute = vi.fn(async (operation: (scope: GenerationRuntimeScope) => Promise<unknown>) => operation({
    session: {
      budget: {
        maxAttempts: DRAFT_GENERATION_BUDGET.maxAttempts,
        maxRequestedOutputTokens: DRAFT_GENERATION_BUDGET.maxRequestedOutputTokens,
        maxRequestedOutputTokensPerAttempt: DRAFT_GENERATION_BUDGET.maxRequestedOutputTokensPerAttempt,
        deadlineAt: Date.now() + DRAFT_GENERATION_BUDGET.deadlineMs,
      },
      complete: routed,
    },
  }))
  const close = vi.fn().mockResolvedValue(undefined)
  const runtime = { execute, close } as unknown as GenerationRuntime
  const createRuntime = vi.fn<GenerateDraftCommandDependencies['createRuntime']>()
    .mockResolvedValue(runtime)
  return { complete, reconcile, execute, close, createRuntime }
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
    clearProjectCustomPrompts()
    useProjectStore.setState({ currentProject: null })
  })

  function setup(options: {
    runtime: Pick<ReturnType<typeof fakeRuntime>, 'createRuntime' | 'complete' | 'execute' | 'close'>
    mainDefault?: boolean
    resumeHandle?: MainGenerationRunHandle
    batchId?: string
    wordsPerChapter?: number
    wordsTarget?: number
    premise?: string
    charactersArch?: string
    worldbuilding?: string
    synopsis?: string
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
      currentFinalizedDraftId?: number
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
      required?: boolean
    }>
    knowledgeResults?: Array<{ text: string; score: number; fileName: string }>
    keyEvents?: string
    suspenseHook?: string
    knowledgeQueryHint?: string
    characterCards?: Array<{
      name: string
      role: string
      currentState: Record<string, unknown>
      [key: string]: unknown
    }>
    sourceDraft?: { id: number; version: number }
    customDraftTemplate?: typeof BUILTIN_PROMPTS[number]
  }) {
    let recoveryCandidateSequence = 0
    const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      if (channel === 'fs:check-exists' && String(args[0]).endsWith('/.ai-novel/prompts')) return Boolean(options.customDraftTemplate)
      if (channel === 'fs:list-dir' && options.customDraftTemplate) return [{
        isDir: false,
        name: `${options.customDraftTemplate.key}.${options.customDraftTemplate.writingLanguage}.json`,
        path: `${projectPath}/.ai-novel/prompts/${options.customDraftTemplate.key}.${options.customDraftTemplate.writingLanguage}.json`,
      }]
      if (channel === 'fs:read-file' && options.customDraftTemplate) return {
        success: true, content: JSON.stringify(options.customDraftTemplate),
      }
      if (channel === 'db:project-core-get') {
        return {
          premise: options.premise ?? '故事前提',
          charactersArch: options.charactersArch ?? '',
          worldbuilding: options.worldbuilding ?? '',
          synopsis: options.synopsis ?? '',
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
              projectionGeneration: 0,
              chapterTitle: projection?.chapterTitle ?? '',
              content,
            },
          }
        }
        const projection = options.continuity?.find(item => item.draftId === draftId)
        if (!projection) {
          return options.previousFinalizedContent && draftId === 77
            ? {
                status: 'legacy',
                draftId,
                chapterNumber: (options.chapterNumber ?? 1) - 1,
                chapterTitle: '',
                content: options.previousFinalizedContent,
              }
            : { status: 'invalid' }
        }
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
      if (channel === 'generation:prepare-draft-context') return {
        preparationId: '合成准备', selectedDrafts: (options.selectedCandidateDrafts ?? []).map(candidate => ({
          chapterNumber: candidate.chapterNumber, draftId: candidate.draftId,
          version: candidate.version, content: candidate.content,
        })),
        knowledgeSnapshot: { version: 1, state: 'empty', storageState: 'absent',
          query: (args[0] as { query: string }).query, topK: 5, canonicalRevision: null, documentsRevision: null,
          items: options.knowledgeResults ?? [] },
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
      if (channel === 'db:draft-create') return { success: true, id: 1 }
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
      aiNovelAPI: {
        invoke,
        on: vi.fn(() => () => {}),
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
      suspenseHook: options.suspenseHook,
      characters: options.characters ?? [],
      wordsTarget: options.wordsTarget,
      userGuidance: options.userGuidance,
      knowledgeQueryHint: options.knowledgeQueryHint,
    }, {
      ...(options.mainDefault ? {} : { dependencies: { createRuntime: options.runtime.createRuntime } }),
      resumeHandle: options.resumeHandle,
      batchId: options.batchId,
      selectedCandidateDrafts: options.selectedCandidateDrafts,
    })
    return { invoke, context, callbacks, command }
  }

  function expectNoDraftPersistence(invoke: ReturnType<typeof vi.fn>): void {
    expect(invoke).not.toHaveBeenCalledWith('db:draft-next-version', expect.anything(), expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything())
  }

  it.each([{ target: 900, edit: false }, { target: 2000, edit: false }, { target: 3000, edit: false }, { target: 900, edit: true }])('真实默认 facade 字数 $target，作者改稿 $edit，仅main组合与原子保存', async ({ target, edit }) => {
    const legacy = fakeOutcomes()
    const f = setup({ runtime: legacy, wordsTarget: target, mainDefault: true })
    f.context.generationModelId = '合成模型'
    const handle: MainGenerationRunHandle = { projectId: f.context.projectSession.projectId,
      epoch: f.context.projectSession.leaseId, rootActionId: '合成根', runId: '合成正文' }
    const raw = `<think>推理不可成为正文</think>${'潮'.repeat(target)}。`
    const text = sanitizeDraftText(raw)
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const view: MainGenerationRunView = { handle, status: 'running', nonReplayable: false, artifacts: [],
      budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: Date.now() + 3600000 } }
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'generation:begin' || channel === 'generation:read') return view
      if (channel === 'generation:execute') {
        if (edit) useProjectStore.setState(state => ({ currentProject: { ...state.currentProject!,
          novelConfig: { ...state.currentProject!.novelConfig, worldSetting: '作者刚补写的世界设定' } } }))
        const result = outcome(raw, 'stop')
        result.receipt.visibleArtifact = { artifactId: '正文片', attemptId: '物理请求', revision: 1, textHash: hash(raw) }
        return { outcome: result, run: view }
      }
      if (channel === 'generation:compose-visible') {
        expect(args.slice(0, 4)).toEqual([handle, ['正文片'], hash(text), 'draft-visible-v1'])
        return { algorithm: 'draft-visible-v1', artifactIds: ['正文片'], text, textHash: hash(text), sources: [] }
      }
      if (channel === 'generation:commit-draft') return { success: true, id: 17, version: 2, content: text, contentHash: hash(text) }
      return original(channel, ...args)
    })
    if (edit) {
      await expect(f.command.execute({ step: {}, context: f.context, callbacks: f.callbacks })).rejects.toThrow('GENERATION_DRAFT_AUTHOR_CONFIG_CHANGED')
      expect(f.invoke.mock.calls.some(([channel]) => channel === 'generation:commit-draft')).toBe(false)
      expect(f.callbacks.replaceText).toHaveBeenLastCalledWith(text)
    } else await expect(f.command.execute({ step: {}, context: f.context, callbacks: f.callbacks })).resolves.toBe(text)
    expect(legacy.createRuntime).not.toHaveBeenCalled()
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')).toHaveLength(1)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'db:draft-create' || channel === 'db:draft-next-version' || channel === 'db:recovery-candidate-record')).toBe(false)
  })

  it('composes and commits the single in-range condense revision through the main-owned run', async () => {
    const legacy = fakeOutcomes()
    const f = setup({ runtime: legacy, wordsTarget: 2000, wordsPerChapter: 2000, mainDefault: true })
    f.context.generationModelId = '合成模型'
    const handle: MainGenerationRunHandle = { projectId: f.context.projectSession.projectId,
      epoch: f.context.projectSession.leaseId, rootActionId: '压缩根', runId: '压缩正文' }
    const draft = `${'长'.repeat(2700)}。`
    const condensed = `${'缩'.repeat(2000)}。`
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const view: MainGenerationRunView = { handle, status: 'running', nonReplayable: false, artifacts: [],
      budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: Date.now() + 3600000 } }
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'generation:begin' || channel === 'generation:read') return view
      if (channel === 'generation:execute') {
        const condense = (args[0] as { task: GenerationTask }).task.purpose === 'chapter-draft-condense'
        const text = condense ? condensed : draft
        const result = outcome(text, 'stop')
        result.receipt.visibleArtifact = { artifactId: condense ? '压缩片' : '原片', attemptId: condense ? '压缩请求' : '原请求', revision: 1, textHash: hash(text) }
        return { outcome: result, run: view }
      }
      if (channel === 'generation:compose-visible') {
        const ids = args[1] as string[]
        const text = ids.length === 1 ? draft : condensed
        expect(args[2]).toBe(hash(text))
        return { algorithm: 'draft-visible-v1', artifactIds: ids, text, textHash: hash(text), sources: [] }
      }
      if (channel === 'generation:commit-draft') {
        expect((args[0] as { expectedCompositionHash: string }).expectedCompositionHash).toBe(hash(condensed))
        return { success: true, id: 21, version: 1, content: condensed, contentHash: hash(condensed) }
      }
      if (channel === 'generation:pause') throw new Error('unexpected pause')
      return original(channel, ...args)
    })

    await expect(f.command.execute({ step: {}, context: f.context, callbacks: f.callbacks })).resolves.toBe(condensed)

    expect(legacy.createRuntime).not.toHaveBeenCalled()
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:compose-visible').map(([, , ids]) => ids))
      .toEqual([['原片'], ['原片', '压缩片']])
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')).toHaveLength(2)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'db:draft-create' || channel === 'db:recovery-candidate-record')).toBe(false)
  })

  it('pauses an over-limit main-owned replay and reports the length code first', async () => {
    const legacy = fakeOutcomes()
    const replayedEnding = '潮'.repeat(500)
    const f = setup({
      runtime: legacy,
      chapterNumber: 2,
      previousFinalizedContent: replayedEnding,
      wordsTarget: 2000,
      wordsPerChapter: 2000,
      mainDefault: true,
    })
    f.context.generationModelId = '合成模型'
    const handle: MainGenerationRunHandle = {
      projectId: f.context.projectSession.projectId,
      epoch: f.context.projectSession.leaseId,
      rootActionId: '超长根',
      runId: '超长正文',
    }
    const text = `${replayedEnding}${'灯'.repeat(2101)}`
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const view: MainGenerationRunView = {
      handle,
      status: 'running',
      nonReplayable: false,
      artifacts: [],
      budget: {
        maxAttempts: 32,
        maxRequestedOutputTokens: 2000000,
        maxRequestedOutputTokensPerAttempt: 32768,
        deadlineAt: Date.now() + 3600000,
      },
    }
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'generation:begin' || channel === 'generation:read') return view
      if (channel === 'generation:execute') {
        const result = outcome(text, 'stop')
        result.receipt.visibleArtifact = {
          artifactId: '超长正文片',
          attemptId: '超长物理请求',
          revision: 1,
          textHash: hash(text),
        }
        return { outcome: result, run: view }
      }
      if (channel === 'generation:compose-visible') {
        return {
          algorithm: 'draft-visible-v1',
          artifactIds: ['超长正文片'],
          text,
          textHash: hash(text),
          sources: [],
        }
      }
      if (channel === 'generation:pause') return { ...view, status: 'paused' }
      if (channel === 'generation:commit-draft') throw new Error('unexpected commit')
      return original(channel, ...args)
    })

    await expect(f.command.execute({ step: {}, context: f.context, callbacks: f.callbacks }))
      .rejects.toThrow('GENERATION_DRAFT_LENGTH_OUT_OF_RANGE')

    expect(legacy.createRuntime).not.toHaveBeenCalled()
    const executed = f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')
    // 已定稿前驱 + 本章蓝图：首稿之前先有一次生成前定稿对账（此处输出不可解析，按无对账继续）。
    expect(executed.map(([, request]) => (request as { task: GenerationTask }).task.purpose))
      .toEqual(['chapter-draft-reconcile', 'chapter-draft', 'chapter-draft-condense'])
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:compose-visible')).toHaveLength(1)
    expect(f.invoke).toHaveBeenCalledWith('generation:pause', handle, f.context.projectSession)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'generation:commit-draft')).toBe(false)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'db:recovery-candidate-record')).toBe(false)
    expect(f.callbacks.replaceText).toHaveBeenLastCalledWith(text)
  })

  it.each(['stop', 'length', 'saved-ack-lost'] as const)('默认恢复沿精确组合与 %s 终态，不重发初始正文', async (state) => {
    const finishReason = state === 'saved-ack-lost' ? 'stop' : state
    const handle: MainGenerationRunHandle = { projectId: 'generation-runtime', epoch: state === 'saved-ack-lost' ? '已关闭旧会话' : 'lease-generation-runtime', rootActionId: '原根', runId: '原正文' }
    const f = setup({ runtime: fakeOutcomes(), mainDefault: true, resumeHandle: handle, wordsTarget: 900 })
    f.context.generationModelId = '合成模型'
    const seed = '潮'.repeat(finishReason === 'stop' ? 900 : 500)
    const addition = '灯'.repeat(500) + '。'
    const expected = finishReason === 'stop' ? seed : composeDraftVisibleContinuation(seed, addition)
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const view: MainGenerationRunView = { handle, status: 'running', nonReplayable: false, artifacts: [],
      budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: Date.now() + 3600000 } }
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'generation:read') return view
      if (channel === 'generation:read-context') return { handle, operation: 'chapter-draft', chapterNumber: 1,
        authorInputs: [
          { id: 'draft:chapter-info', text: JSON.stringify({ chapterNumber: 1, title: '第一章', role: '开端', purpose: '建立冲突', characters: [], keyEvents: '开端' }) },
          { id: 'draft:author-config', text: JSON.stringify(useProjectStore.getState().currentProject!.novelConfig) },
          { id: 'draft:target-units', text: '900' },
        ], selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6],
        knowledgeSnapshot: { version: 1, state: 'empty', storageState: 'absent', query: '第一章 开端', topK: 5, canonicalRevision: null, documentsRevision: null, items: [] },
        composition: { algorithm: 'draft-visible-v1', text: seed, textHash: hash(seed), artifactIds: ['原片'], sources: [] },
        lastCompositionFinishReason: finishReason, attemptedPurposes: ['chapter-draft'],
        ...(state === 'saved-ack-lost' ? { savedDraft: { success: true, id: 18, version: 1, content: expected, contentHash: hash(expected) } } : {}) }
      if (channel === 'generation:execute') {
        expect((args[0] as { task: GenerationTask }).task.purpose).toBe('chapter-draft-continuation')
        const result = outcome(addition, 'stop')
        result.receipt.visibleArtifact = { artifactId: '续片', attemptId: '续请求', revision: 1, textHash: hash(addition) }
        return { outcome: result, run: view }
      }
      if (channel === 'generation:compose-visible') {
        expect(args[1]).toEqual(['原片', '续片'])
        return { algorithm: 'draft-visible-v1', artifactIds: ['原片', '续片'], text: expected, textHash: hash(expected), sources: [] }
      }
      if (channel === 'generation:commit-draft') return { success: true, id: 18, version: 1, content: expected, contentHash: hash(expected) }
      return original(channel, ...args)
    })
    await expect(f.command.execute({ step: {}, context: f.context, callbacks: f.callbacks })).resolves.toBe(expected)
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')).toHaveLength(finishReason === 'stop' ? 0 : 1)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'generation:begin' || channel === 'db:draft-create')).toBe(false)
    if (state === 'saved-ack-lost') {
      expect(f.invoke.mock.calls.some(([channel]) => channel === 'generation:read' || channel === 'generation:resume')).toBe(false)
      expect(f.invoke.mock.calls.some(([channel]) => ['generation:commit-draft', 'generation:prepare-draft-context', 'kb:search-writing-context', 'db:draft-get-latest'].includes(channel))).toBe(false)
    }
  })

  it.each(['after-draft', 'reconciled-only', 'after-unreconciled-draft', 'reconcile-failed-or-unknown'] as const)('恢复时沿用记录的定稿对账结果而不重发对账：%s', async (state) => {
    const draftPending = state === 'reconciled-only' || state === 'reconcile-failed-or-unknown'
    const withoutBlock = state === 'after-unreconciled-draft' || state === 'reconcile-failed-or-unknown'
    const handle: MainGenerationRunHandle = { projectId: 'generation-runtime', epoch: 'lease-generation-runtime', rootActionId: '对账根', runId: '对账正文' }
    const f = setup({ runtime: fakeOutcomes(), mainDefault: true, resumeHandle: handle, wordsTarget: 900 })
    f.context.generationModelId = '合成模型'
    const recorded = JSON.stringify({ finalState: ['林澄已撤回核查安排。'], events: [{ event: '核查遇阻', conflict: true, realization: '许可被驳回。' }] })
    const block = renderDraftReconciliationBlock('zh-CN', parseDraftReconciliation(recorded)!)
    const seed = '潮'.repeat(500)
    const addition = '灯'.repeat(500) + '。'
    const initial = `${'潮'.repeat(900)}。`
    const expected = draftPending ? initial : composeDraftVisibleContinuation(seed, addition)
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const view: MainGenerationRunView = { handle, status: 'running', nonReplayable: false, artifacts: [],
      budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: Date.now() + 3600000 } }
    const original = f.invoke.getMockImplementation()!
    const executed: GenerationTask[] = []
    f.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'generation:read') return view
      if (channel === 'generation:read-context') return { handle, operation: 'chapter-draft', chapterNumber: 1,
        authorInputs: [
          { id: 'draft:chapter-info', text: JSON.stringify({ chapterNumber: 1, title: '第一章', role: '开端', purpose: '建立冲突', characters: [], keyEvents: '开端' }) },
          { id: 'draft:author-config', text: JSON.stringify(useProjectStore.getState().currentProject!.novelConfig) },
          { id: 'draft:target-units', text: '900' },
        ], selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6],
        knowledgeSnapshot: { version: 1, state: 'empty', storageState: 'absent', query: '第一章 开端', topK: 5, canonicalRevision: null, documentsRevision: null, items: [] },
        composition: !draftPending ? { algorithm: 'draft-visible-v1', text: seed, textHash: hash(seed), artifactIds: ['原片'], sources: [] } : null,
        lastCompositionFinishReason: !draftPending ? 'length' : null,
        attemptedPurposes: !draftPending ? ['chapter-draft-reconcile', 'chapter-draft'] : ['chapter-draft-reconcile'],
        // 首稿发出时未带注入块：主进程不再提供对账结果，续写与首稿保持一致。
        draftReconciliation: { artifactIds: ['对账片'], completedOutput: withoutBlock ? null : recorded } }
      if (channel === 'generation:execute') {
        const task = (args[0] as { task: GenerationTask }).task
        executed.push(task)
        const text = task.purpose === 'chapter-draft' ? initial : addition
        const result = outcome(text, 'stop')
        result.receipt.visibleArtifact = { artifactId: `${task.purpose}片`, attemptId: `${task.purpose}请求`, revision: 1, textHash: hash(text) }
        return { outcome: result, run: view }
      }
      if (channel === 'generation:compose-visible') {
        return { algorithm: 'draft-visible-v1', artifactIds: args[1], text: expected, textHash: hash(expected), sources: [] }
      }
      if (channel === 'generation:commit-draft') return { success: true, id: 18, version: 1, content: expected, contentHash: hash(expected) }
      return original(channel, ...args)
    })
    await expect(f.command.execute({ step: {}, context: f.context, callbacks: f.callbacks })).resolves.toBe(expected)
    expect(executed.map(task => task.purpose)).toEqual([draftPending ? 'chapter-draft' : 'chapter-draft-continuation'])
    if (withoutBlock) expect(executed[0]!.messages.at(-1)!.content).not.toContain('【本章与定稿对账')
    else expect(executed[0]!.messages.at(-1)!.content).toContain(`${block}\n\n【定稿事实优先】`)
  })

  it.each([
    { attempted: ['chapter-draft'], condenses: true },
    { attempted: ['chapter-draft', 'chapter-draft-condense'], condenses: false },
  ])('resumes a paused over-range composition through the single condense revision: $condenses', async ({ attempted, condenses }) => {
    const handle: MainGenerationRunHandle = { projectId: 'generation-runtime', epoch: 'lease-generation-runtime', rootActionId: '超长根', runId: '超长暂停' }
    const f = setup({ runtime: fakeOutcomes(), mainDefault: true, resumeHandle: handle, wordsTarget: 900 })
    f.context.generationModelId = '合成模型'
    const seed = `${'潮'.repeat(1300)}。`
    const condensed = `${'缩'.repeat(880)}。`
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const view: MainGenerationRunView = { handle, status: 'running', nonReplayable: false, artifacts: [],
      budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: Date.now() + 3600000 } }
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'generation:read') return view
      if (channel === 'generation:read-context') return { handle, operation: 'chapter-draft', chapterNumber: 1,
        authorInputs: [
          { id: 'draft:chapter-info', text: JSON.stringify({ chapterNumber: 1, title: '第一章', role: '开端', purpose: '建立冲突', characters: [], keyEvents: '开端' }) },
          { id: 'draft:author-config', text: JSON.stringify(useProjectStore.getState().currentProject!.novelConfig) },
          { id: 'draft:target-units', text: '900' },
        ], selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6],
        knowledgeSnapshot: { version: 1, state: 'empty', storageState: 'absent', query: '第一章 开端', topK: 5, canonicalRevision: null, documentsRevision: null, items: [] },
        composition: { algorithm: 'draft-visible-v1', text: seed, textHash: hash(seed), artifactIds: ['原片'], sources: [] },
        lastCompositionFinishReason: 'stop', attemptedPurposes: attempted }
      if (channel === 'generation:execute') {
        expect((args[0] as { task: GenerationTask }).task.purpose).toBe('chapter-draft-condense')
        expect((args[0] as { task: GenerationTask }).task.messages.at(-1)!.content).toContain(`【待压缩正文】\n${seed}`)
        const result = outcome(condensed, 'stop')
        result.receipt.visibleArtifact = { artifactId: '压缩片', attemptId: '压缩请求', revision: 1, textHash: hash(condensed) }
        return { outcome: result, run: view }
      }
      if (channel === 'generation:compose-visible') {
        expect(args[1]).toEqual(['原片', '压缩片'])
        return { algorithm: 'draft-visible-v1', artifactIds: ['原片', '压缩片'], text: condensed, textHash: hash(condensed), sources: [] }
      }
      if (channel === 'generation:commit-draft') return { success: true, id: 19, version: 1, content: condensed, contentHash: hash(condensed) }
      if (channel === 'generation:pause') return { ...view, status: 'paused' }
      return original(channel, ...args)
    })
    const result = f.command.execute({ step: {}, context: f.context, callbacks: f.callbacks })
    if (condenses) await expect(result).resolves.toBe(condensed)
    else await expect(result).rejects.toThrow('GENERATION_DRAFT_LENGTH_OUT_OF_RANGE')
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute')).toHaveLength(condenses ? 1 : 0)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'generation:pause')).toBe(!condenses)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'generation:commit-draft')).toBe(condenses)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'generation:begin' || channel === 'db:draft-create')).toBe(false)
  })

  it.each([
    { state: 'failed empty batch', selectedBatch: 'batch-1', recoveryBatch: 'batch-1',
      finishReason: null, failureCode: 'GENERATION_PROVIDER_FAILED', visibleArtifact: false, allowed: true },
    { state: 'successful but uncomposed', selectedBatch: 'batch-1', recoveryBatch: 'batch-1',
      finishReason: 'stop', failureCode: null, visibleArtifact: false, allowed: false },
    { state: 'non-batch', selectedBatch: undefined, recoveryBatch: undefined,
      finishReason: null, failureCode: 'GENERATION_PROVIDER_FAILED', visibleArtifact: false, allowed: false },
    { state: 'wrong batch', selectedBatch: 'batch-2', recoveryBatch: 'batch-1',
      finishReason: null, failureCode: 'GENERATION_PROVIDER_FAILED', visibleArtifact: false, allowed: false },
    { state: 'unknown termination', selectedBatch: 'batch-1', recoveryBatch: 'batch-1',
      finishReason: null, failureCode: null, visibleArtifact: false, allowed: false },
    { state: 'visible failed candidate', selectedBatch: 'batch-1', recoveryBatch: 'batch-1',
      finishReason: null, failureCode: 'GENERATION_PROVIDER_FAILED', visibleArtifact: true, allowed: false },
  ])('retries only a failed empty batch chapter on its durable handle: $state', async scenario => {
    const handle: MainGenerationRunHandle = { projectId: 'generation-runtime', epoch: 'lease-generation-runtime',
      rootActionId: '批次根', runId: '失败的第1章' }
    const f = setup({ runtime: fakeOutcomes(), mainDefault: true, resumeHandle: handle,
      batchId: scenario.selectedBatch, wordsTarget: 100 })
    f.context.generationModelId = '合成模型'
    const text = '潮'.repeat(100)
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const view: MainGenerationRunView = { handle, status: 'running', nonReplayable: false,
      artifacts: scenario.visibleArtifact ? [{ ...handle, artifactId: '失败片', attemptId: '失败尝试', revision: 1,
        durableRevision: 1, text: '保留候选', textHash: hash('保留候选'), status: 'failed', compositionEligible: false }] : [],
      budgetDiagnostics: [{ attemptId: '失败尝试', requestedOutputTokens: 2048, reservedTokens: 2048,
        actualState: 'unknown', actual: null, finishReason: scenario.finishReason,
        failureCode: scenario.failureCode, reasons: [] }],
      ledger: { policy: DRAFT_GENERATION_BUDGET as never, tokenLiability: 2048, physicalRequests: 1,
        activeElapsedMs: 100, blockedCode: null },
      budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768,
        deadlineAt: Date.now() + 3600000 } }
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'generation:read-context') return { handle, modelId: '合成模型', operation: 'chapter-draft', chapterNumber: 1,
        batchId: scenario.recoveryBatch, authorInputs: [
          { id: 'draft:chapter-info', text: JSON.stringify({ chapterNumber: 1, title: '第一章', role: '开端', purpose: '建立冲突', characters: [], keyEvents: '开端' }) },
          { id: 'draft:author-config', text: JSON.stringify(useProjectStore.getState().currentProject!.novelConfig) },
          { id: 'draft:target-units', text: '100' },
        ], selectedDraftIds: [], selectedFinalizedDraftIds: [], selectedBlueprintChapterNumbers: [1, 2, 3, 4, 5, 6],
        knowledgeSnapshot: { version: 1, state: 'empty', storageState: 'absent', query: '第一章 开端', topK: 5,
          canonicalRevision: null, documentsRevision: null, items: [] },
        composition: null, lastCompositionFinishReason: scenario.finishReason, attemptedPurposes: ['chapter-draft'] }
      if (channel === 'generation:read') return view
      if (channel === 'generation:execute') {
        expect((args[0] as { handle: MainGenerationRunHandle }).handle).toEqual(handle)
        const result = outcome(text, 'stop')
        result.receipt.visibleArtifact = { artifactId: '重试正文片', attemptId: '重试物理请求', revision: 1, textHash: hash(text) }
        return { outcome: result, run: view }
      }
      if (channel === 'generation:compose-visible') return { algorithm: 'draft-visible-v1',
        artifactIds: ['重试正文片'], text, textHash: hash(text), sources: [] }
      if (channel === 'generation:commit-draft') return { success: true, id: 23, version: 1,
        content: text, contentHash: hash(text) }
      return original(channel, ...args)
    })

    const execution = f.command.execute({ step: {}, context: f.context, callbacks: f.callbacks })
    if (scenario.allowed) await expect(execution).resolves.toBe(text)
    else await expect(execution).rejects.toThrow('GENERATION_DRAFT_RECOVERY_EVIDENCE_REQUIRED')
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:execute'))
      .toHaveLength(scenario.allowed ? 1 : 0)
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'generation:begin')).toBe(false)
  })

  it('main续写低增量片段保持独立，不进入确认组合或正式草稿', async () => {
    const f = setup({ runtime: fakeOutcomes(), mainDefault: true, wordsTarget: 3000 })
    f.context.generationModelId = '合成模型'
    const handle: MainGenerationRunHandle = { projectId: f.context.projectSession.projectId, epoch: f.context.projectSession.leaseId,
      rootActionId: '唯一根', runId: '正文运行' }
    const view: MainGenerationRunView = { handle, status: 'running', nonReplayable: false, artifacts: [],
      budget: { maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: Date.now() + 3600000 } }
    const fragments = ['潮'.repeat(1500), '灯'.repeat(100), '钟'.repeat(2000) + '。']
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    let attempt = 0, composed = ''
    const purposes: string[] = []
    const original = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'generation:begin' || channel === 'generation:read') return view
      if (channel === 'generation:execute') {
        purposes.push((args[0] as { task: GenerationTask }).task.purpose)
        const raw = fragments[attempt]
        const result = outcome(raw, attempt === 2 ? 'stop' : 'length')
        result.receipt.visibleArtifact = { artifactId: `片${attempt}`, attemptId: `请求${attempt}`, revision: 1, textHash: hash(raw) }
        attempt += 1
        return { outcome: result, run: view }
      }
      if (channel === 'generation:compose-visible') {
        const ids = args[1] as string[]
        expect(ids).not.toContain('片1')
        composed = ids.reduce((text, id) => composeDraftVisibleContinuation(text, fragments[Number(id.slice(1))]), '')
        return { algorithm: 'draft-visible-v1', text: composed, textHash: hash(composed), artifactIds: ids, sources: [] }
      }
      if (channel === 'generation:commit-draft') return { success: true, id: 21, version: 1, content: composed, contentHash: hash(composed) }
      return original(channel, ...args)
    })
    const result = await f.command.execute({ step: {}, context: f.context, callbacks: f.callbacks })
    expect(result).not.toContain('灯')
    expect(purposes).toEqual(['chapter-draft', 'chapter-draft-continuation', 'chapter-draft-no-progress-recovery'])
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:compose-visible')).toHaveLength(2)
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'generation:begin')).toHaveLength(1)
  })

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

  it.each([
    { target: 900, aimLow: 765, lowerBound: 630, upperBound: 1170 },
    { target: 1400, aimLow: 1190, lowerBound: 979, upperBound: 1820 },
  ])('sends the dynamic $target-unit length contract with a tighter aim and a hard ceiling in the final provider request', async ({
    target,
    aimLow,
    lowerBound,
    upperBound,
  }) => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('正'.repeat(target), 'stop')
    })
    const requiredEvent = '作者指定的必需事件必须完整发生'
    const { context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'zh-CN',
      wordsTarget: target,
      keyEvents: requiredEvent,
    })

    await command.execute({ step: {}, context, callbacks })

    const user = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(user).toContain('【本章篇幅合同】')
    expect(user).toContain(`【本章篇幅合同】\n目标 ${target} 字（按汉字计，不含标点）；请写到约 ${aimLow}–${target} 字。${upperBound} 字是硬上限，超过即被退回；少于 ${lowerBound} 字同样会被退回。`)
    expect(user).toContain('篇幅紧张时，压缩描写与过渡、减少场景数量，而不是删掉必需事件')
    expect(user).not.toContain('可接受范围')
    expect(user).toContain(requiredEvent)
    expect(runtime.complete).toHaveBeenCalledOnce()
  })

  it('orders sourced history before the current author task and length contract in the final provider request', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('正'.repeat(900), 'stop')
    })
    const historyMarker = '上一章唯一历史哨兵'
    const authorTask = '当前章唯一作者任务哨兵'
    const futurePlan = '后续章唯一作者计划哨兵'
    const { context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 900,
      keyEvents: authorTask,
      blueprints: [{ chapterNumber: 3, title: '第三章', keyEvents: futurePlan }],
      previousFinalizedContent: `${historyMarker}。`.repeat(100),
    })

    await command.execute({ step: {}, context, callbacks })

    const user = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    const historyIndex = user.indexOf(historyMarker)
    const authorTaskIndex = user.indexOf(authorTask)
    const lengthContractIndex = user.indexOf('【本章篇幅合同】')
    expect(historyIndex).toBeGreaterThanOrEqual(0)
    expect(authorTaskIndex).toBeGreaterThan(historyIndex)
    expect(lengthContractIndex).toBeGreaterThan(authorTaskIndex)
    expect(user).toContain('【后续计划边界（只约束当前章，不是当前章任务）】')
    expect(user).toContain(futurePlan)
    expect(user).toContain('目标 900 字（按汉字计，不含标点）；请写到约 765–900 字。1170 字是硬上限')
    expect(runtime.complete).toHaveBeenCalledOnce()
  })

  it('sends the English length contract with word counting, a tighter aim, and a hard ceiling', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('word '.repeat(900), 'stop')
    })
    const { context, callbacks, command } = setup({ runtime, writingLanguage: 'en-US', wordsTarget: 900 })

    await command.execute({ step: {}, context, callbacks })

    const user = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(user).toContain('[Chapter length contract]\nTarget: 900 words (counted as words, excluding punctuation); aim for about 765-900 words. 1170 words is a hard ceiling: drafts beyond it are rejected, and drafts under 630 words are rejected too.')
    expect(user).toContain('compress description and transitions and use fewer scenes rather than dropping required events')
    expect(user).not.toContain('acceptable range')
  })

  it.each([
    {
      writingLanguage: 'zh-CN' as const,
      heading: '【本章执行卡（作者原文重列）】',
      labels: ['必需事件', '章节钩子', '作者本章指导'],
      semanticChecks: ['按作者原文含义遵循', '正文动作或结果落实', '叙述约束', '不要仅为证明遵守而新增或反复确认', '按原文揭示时点', '作者明确要求的动作、揭示或反复仍按原文执行'],
    },
    {
      writingLanguage: 'en-US' as const,
      heading: '[Current-chapter execution card (author text repeated verbatim)]',
      labels: ['Required events', 'Chapter hook', 'Author guidance for this chapter'],
      semanticChecks: ['Follow the author text according to its meaning', 'manuscript action or outcome', 'narrative constraints', 'do not add or repeatedly confirm', 'reveal timing specified by the author', 'explicitly requested actions, reveals, or repetition'],
    },
  ].flatMap(language => [1, 2].map(chapterNumber => ({ ...language, chapterNumber }))))('places a $writingLanguage chapter $chapterNumber semantic execution card immediately before the length contract', async ({
    writingLanguage,
    heading,
    labels,
    semanticChecks,
    chapterNumber,
  }) => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('正'.repeat(900), 'stop')
    })
    const keyEvents = '顾弦把潮印实际交给陆霁。潮印此后由陆霁保管。'
    const suspenseHook = '本章只听到记录机倒带声；第二章才揭示来源。'
    const userGuidance = '四拍灯码暂时只有陆霁知道；不要让她重复解释；用克制语气叙述。'
    const { context, callbacks, command } = setup({
      runtime,
      writingLanguage,
      chapterNumber,
      wordsTarget: 900,
      keyEvents,
      suspenseHook,
      userGuidance,
      previousFinalizedContent: chapterNumber === 2 ? '上一章正文已完成。'.repeat(100) : undefined,
    })

    await command.execute({ step: {}, context, callbacks })

    const user = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    const executionCardIndex = user.lastIndexOf(heading)
    const lengthContractIndex = user.indexOf(
      writingLanguage === 'en-US' ? '[Chapter length contract]' : '【本章篇幅合同】',
    )
    expect(executionCardIndex).toBeGreaterThanOrEqual(0)
    expect(lengthContractIndex).toBeGreaterThan(executionCardIndex)
    expect(user.slice(executionCardIndex, lengthContractIndex)).toContain(`- ${labels[0]}: ${keyEvents}`)
    expect(user.slice(executionCardIndex, lengthContractIndex)).toContain(`- ${labels[1]}: ${suspenseHook}`)
    expect(user.slice(executionCardIndex, lengthContractIndex)).toContain(`- ${labels[2]}: ${userGuidance}`)
    for (const instruction of semanticChecks) {
      expect(user.slice(executionCardIndex, lengthContractIndex)).toContain(instruction)
    }
    expect(user.slice(executionCardIndex, lengthContractIndex)).toContain(
      writingLanguage === 'en-US'
        ? 'Each later action must continue from the item ownership, character knowledge, and plan-completion state actually established in the prose.'
        : '后一项动作必须承接正文实际形成的物品持有、人物知情和计划完成状态。',
    )
    expect(runtime.complete).toHaveBeenCalledOnce()
  })

  it('retains all three author fields in the final task when a custom draft template omits chapter_info', async () => {
    clearProjectCustomPrompts()
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('正'.repeat(900), 'stop')
    })
    const builtin = BUILTIN_PROMPTS.find(template => template.key === 'first_chapter_draft')!
    const keyEvents = '顾弦把潮印交给陆霁。'
    const suspenseHook = '来源留待下一章揭示。'
    const userGuidance = '保持克制，潮印由陆霁保管。'
    const { context, callbacks, command } = setup({
      runtime,
      wordsTarget: 900,
      keyEvents,
      suspenseHook,
      userGuidance,
      customDraftTemplate: {
        ...builtin,
        writingLanguage: 'zh-CN',
        content: '自定义正文任务。',
        systemSuffix: '',
        requiredContextVariables: [],
      },
    })

    await command.execute({ step: {}, context, callbacks })

    const user = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(user).toContain('自定义正文任务。')
    expect(user).toContain(`- 必需事件: ${keyEvents}`)
    expect(user).toContain(`- 章节钩子: ${suspenseHook}`)
    expect(user).toContain(`- 作者本章指导: ${userGuidance}`)
  })

  it('omits the execution card when all three author fields are empty', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('正'.repeat(900), 'stop')
    })
    const { context, callbacks, command } = setup({
      runtime,
      writingLanguage: 'zh-CN',
      wordsTarget: 900,
      keyEvents: '',
      suspenseHook: '  ',
      userGuidance: '',
    })

    await command.execute({ step: {}, context, callbacks })

    const user = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(user).not.toContain('【本章执行卡（作者原文重列）】')
    expect(user).toContain('【本章篇幅合同】')
    expect(runtime.complete).toHaveBeenCalledOnce()
  })

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
      previousFinalizedContent: 'The previous chapter is finalized.',
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
    expect(createRuntime).toHaveBeenCalledWith({ budget: DRAFT_GENERATION_BUDGET }, expect.objectContaining({
      context, callbacks: expect.objectContaining({ replaceText: expect.any(Function) }), selection: expect.objectContaining({ operation: 'chapter-draft', output: 'visible-text' }),
    }))
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
    }, expect.objectContaining({
      context, callbacks: expect.objectContaining({ replaceText: expect.any(Function) }), selection: expect.objectContaining({ operation: 'chapter-draft', output: 'visible-text' }),
    }))
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
      knowledgeResults: [
        { text: '林岚把红色钥匙收进口袋。', score: 0.95, fileName: '重复定稿块' },
        { text: '项目知识哨兵', score: 0.9, fileName: '世界观' },
      ],
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).not.toContain('OLD_DERIVED_SUMMARY_MUST_NOT_REACH_PROVIDER')
    expect(prompt).not.toContain('林岚脚踝韧带受损，始终持有红色钥匙。')
    expect(prompt).not.toContain('[character-state]')
    expect(prompt).toContain('【定稿原文 · 第1章 · draft 41】')
    expect(prompt).toContain('林岚把红色钥匙收进口袋。')
    expect(prompt).toContain('索引、摘要和 currentState 都不是作者事实')
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining('定稿连续性原文（1 条候选）'))
    expect(prompt).toContain('上一章定稿结尾哨兵。')
    expect(prompt).not.toContain('批内候选稿结尾')
    expect(prompt).not.toContain('重复定稿块')
    expect(prompt.split('林岚把红色钥匙收进口袋。')).toHaveLength(2)
    expect(prompt).toContain('项目知识哨兵')
    expect(invoke).toHaveBeenCalledWith(
      'kb:search-writing-context',
      expect.any(String),
      5,
      projectPath,
      expect.anything(),
    )
  })

  it('sends the sanitized material decision of this exact admission into the frozen run', async () => {
    // S10B 步骤 3：写稿路径的材料准入先于运行开启，所以本次准入的脱敏收据随 selection
    // 一起交给主进程去冻进 sourceManifest 并被恢复指纹绑定。
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
    })
    const previousFinalizedContent = ['作者第一章正文。', '林岚把红色钥匙收进口袋。', '上一章定稿结尾哨兵。'].join('\n\n')
    const { context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      characters: ['林岚'],
      wordsTarget: 500,
      continuity: [{
        draftId: 41,
        chapterNumber: 1,
        chapterTitle: '作者第一章',
        chapterNotes: '',
        facts: [{
          category: 'character-state',
          entities: ['林岚'],
          statement: '林岚持有红色钥匙。',
          sourceChapter: 1,
          evidence: '林岚把红色钥匙收进口袋。',
        }],
      }],
      previousFinalizedContent,
    })

    await command.execute({ step: {}, context, callbacks })

    const decision = runtime.createRuntime.mock.calls[0]?.[1]?.selection.materialDecision
    expect(decision).toMatchObject({ version: 1, verdict: 'admitted', coverage: { required: 1, included: 1, complete: true } })
    // 收据记的来源就是提示词里真正出现的那几份材料。
    expect(decision?.included.map(item => item.sourceId)).toContain('author:required')
    expect(decision?.included.map(item => item.sourceId)).toContain('finalized:41')
    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(decision?.promptHash).toBe(createHash('sha256').update(prompt).digest('hex'))
    expect(prompt).toContain('【定稿原文 · 第1章 · draft 41】')
    expect(prompt).toContain('上一章定稿结尾哨兵。')
    // 脱敏：收据只是编号、原因码与数字，没有任何材料正文。
    const serialized = JSON.stringify(decision)
    expect(serialized).not.toContain('上一章定稿结尾哨兵。')
    expect(serialized).not.toContain('作者第一章正文。')
    expect(serialized).toMatch(/^[\x20-\x7e]+$/)
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
      previousFinalizedContent: '第二章定稿原文。',
      continuity: [{
        draftId: 51,
        currentFinalizedDraftId: 52,
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
        51: '旧摘要绑定正文，不应读取。',
        52: '新权威正文：林岚扶墙停下。\n\n铁钩划开了她的左腿。\n\n她拒绝把钥匙交给周砚。',
      },
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain('【定稿原文 · 第1章 · draft 52】')
    expect(prompt).not.toContain('定位索引')
    expect(prompt).not.toMatch(/draft 52[^\n]*stale/)
    expect(prompt).toContain('新权威正文：林岚扶墙停下')
    expect(prompt).toContain('林岚扶墙停下')
    expect(prompt).toContain('她拒绝把钥匙交给周砚')
    expect(prompt).not.toContain('STALE_SUMMARY_SENTINEL')
    expect(prompt).not.toContain('STALE_STATEMENT_SENTINEL')
    expect(prompt).not.toContain('旧摘要绑定正文，不应读取')
  })

  it('keeps a distant invalid source optional when the previous legacy source is readable', async () => {
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
      previousFinalizedContent: '第二章可读的 legacy 定稿原文。',
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
    expect(prompt).toContain('第二章可读的 legacy 定稿原文。')
    expect(prompt).toContain('finalized#1:source-invalid')
    expect(invoke).not.toHaveBeenCalledWith('db:draft-get-full', 51, projectPath, expect.anything())
  })

  it.each([
    ['without a continuity projection', false],
    ['with an empty continuity fact index', true],
  ])('stops before the provider when the previous finalized source is invalid %s', async (_label, withProjection) => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
    })
    const unverifiedBody = 'UNVERIFIED_PREVIOUS_FINALIZED_BODY_SENTINEL'
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      invalidContinuitySourceIds: [77],
      previousFinalizedContent: unverifiedBody,
      continuity: withProjection
        ? [{
            draftId: 77,
            chapterNumber: 1,
            chapterTitle: '损坏收据',
            chapterNotes: '',
            facts: [],
          }]
        : [],
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow(/无法固定第 1 章的必需定稿来源/u)

    expect(observedTask).toBeUndefined()
    expect(runtime.complete).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything(), expect.anything())
    expect(invoke).toHaveBeenCalledWith('db:continuity-read-source', 77, projectPath, expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('db:draft-get-full', 77, projectPath, expect.anything())
  })

  it('stops before the provider when the required previous finalized source is missing', async () => {
    const runtime = fakeOutcomes(outcome('不应生成。'.repeat(125), 'stop'))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow(/无法固定第 1 章的必需定稿来源/u)

    expect(runtime.complete).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('db:draft-create', expect.anything(), expect.anything(), expect.anything())
  })

  it('recovers the previous canonical source when a derived projection points at an invalid receipt', async () => {
    let observedTask: GenerationTask | undefined
    const runtime = fakeRuntime((_attempt, task) => {
      observedTask = task
      return outcome('新章正文。'.repeat(125), 'stop')
    })
    const canonicalBody = '当前第 1 章定稿原文哨兵。'
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      invalidContinuitySourceIds: [51],
      previousFinalizedContent: canonicalBody,
      continuitySourceContents: { 77: canonicalBody },
      continuity: [{
        draftId: 51,
        chapterNumber: 1,
        chapterTitle: '损坏派生定位',
        chapterNotes: '',
        facts: [{
          category: 'plot',
          entities: [],
          statement: '损坏派生事实',
          sourceChapter: 1,
          evidence: '损坏派生引文',
        }],
      }],
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain(canonicalBody)
    expect(prompt).not.toContain('损坏派生引文')
    expect(invoke).toHaveBeenCalledWith('db:continuity-read-source', 51, projectPath, expect.anything())
    expect(invoke).toHaveBeenCalledWith('db:continuity-read-source', 77, projectPath, expect.anything())
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

  it('persists only the admitted candidate dependency chain', async () => {
    const runtime = fakeRuntime(() => outcome('新章正文。'.repeat(125), 'stop'))
    const chapterOne = '林岚把钥匙藏进钟楼。'
    const chapterTwo = '周砚抵达码头，林岚仍未交出钥匙。'
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 3,
      wordsTarget: 500,
      selectedCandidateDrafts: [
        { chapterNumber: 2, draftId: 32, version: 4, content: chapterTwo, required: true },
        { chapterNumber: 1, draftId: 31, version: 2, content: chapterOne },
      ],
    })

    await command.execute({ step: {}, context, callbacks })

    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({
        sourceDependencies: [
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

  it('binds the final provider request to only the finalized prose that reached that request', async () => {
    const runtime = fakeRuntime(() => outcome('新章正文。'.repeat(125), 'stop'))
    const overBudget = `林岚把钥匙藏进钟楼。${'过长段落'.repeat(2_000)}`
    const included = '周砚守住码头，林岚折返仓库。'
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 3,
      wordsTarget: 500,
      characters: ['林岚'],
      continuity: [
        {
          draftId: 41,
          chapterNumber: 1,
          chapterTitle: '钟楼',
          chapterNotes: '',
          facts: [{
            category: 'plot',
            entities: ['林岚'],
            statement: '钥匙在钟楼。',
            sourceChapter: 1,
            evidence: '林岚把钥匙藏进钟楼。',
          }],
        },
        {
          draftId: 42,
          chapterNumber: 2,
          chapterTitle: '码头',
          chapterNotes: '',
          facts: [{
            category: 'plot',
            entities: ['林岚'],
            statement: '码头被守住。',
            sourceChapter: 2,
            evidence: included,
          }],
        },
      ],
      continuitySourceContents: { 41: overBudget, 42: included },
      selectedCandidateDrafts: [{
        chapterNumber: 2,
        draftId: 42,
        version: 1,
        content: included,
      }],
    })

    await command.execute({ step: {}, context, callbacks })

    const request = runtime.complete.mock.calls[0]?.[0]
    const prompt = request?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain(included)
    expect(prompt).not.toContain(overBudget)
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({
        sourceDependencies: [{
          kind: 'finalized',
          draftId: 42,
          chapterNumber: 2,
          finalizationId: 'finalization-42',
          contentHash: createHash('sha256').update(included, 'utf8').digest('hex'),
        }],
      }),
      projectPath,
      expect.anything(),
    )
  })

  it('stops before the provider with a clear message when required material exceeds the context capacity', async () => {
    // 决定 1B：必需材料也受预算。装不下时命令层给出可执行提示，并把合同的裁决写进日志，
    // 绝不静默裁掉作者资料后继续生成。
    const runtime = fakeRuntime(() => outcome('不应到达的正文。'.repeat(200), 'stop'))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      wordsTarget: 500,
      coreOutline: '作者核心资料。'.repeat(3_000),
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('必需材料（作者资料、角色档案、后续计划）超出上下文容量')
    expect(runtime.complete).not.toHaveBeenCalled()
    expect(callbacks.log).toHaveBeenCalledWith(expect.stringContaining(
      '必需材料超出上下文容量（capacity-conflict）：author:required:budget',
    ))
    expectNoDraftPersistence(invoke)
  })

  it('admits a normal predecessor after long author facts fill more than the former draft capacity', async () => {
    const runtime = fakeRuntime(() => outcome('新章正文。'.repeat(125), 'stop'))
    const authorFact = '设'.repeat(5_400)
    const predecessor = '前章正文。'.repeat(230)
    const { invoke, context, callbacks, command } = setup({
      runtime,
      chapterNumber: 2,
      wordsTarget: 500,
      coreOutline: authorFact,
      selectedCandidateDrafts: [{ chapterNumber: 1, draftId: 31, version: 3, content: predecessor, required: true }],
    })

    await command.execute({ step: {}, context, callbacks })

    const decision = runtime.createRuntime.mock.calls[0]?.[1]?.selection.materialDecision
    expect(decision?.capacity.maxInputUnits).toBe(24_000)
    expect(decision?.capacity.admittedUnits).toBeGreaterThan(18_000)
    expect(decision?.capacity.admittedUnits).toBeLessThan(24_000)
    expect(decision?.coverage).toEqual({ required: 2, included: 2, complete: true })
    expect(decision?.included.map(item => item.sourceId)).toEqual(expect.arrayContaining(['author:required', 'candidate:31']))
    expect(decision?.included.find(item => item.sourceId === 'candidate:31')?.revision).toBe(3)
    expect(runtime.complete).toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('db:draft-create', expect.objectContaining({
      sourceDependencies: [{ draftId: 31, contentHash: createHash('sha256').update(predecessor, 'utf8').digest('hex') }],
    }), projectPath, expect.anything())
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
      previousFinalizedContent: '第一章定稿原文。',
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
      previousFinalizedContent: chapterNumber === 1 ? undefined : '第一章定稿原文。',
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
    { writingLanguage: 'zh-CN' as const,
      completedBoundary: '1. 向前推进：【有来源的历史与候选】中的【定稿原文 · 第N章】（以及作者选入的【未定稿候选 · 第N章】）记录的是本章之前已写成的正文，其中最近一章的结尾就是上一章已完成的最终状态；【本章写作方向与核心任务】和【后续计划边界】不因此成为已发生事件。',
      forbiddenReplay: '不得引用、摘要、回放或重演',
      presentHeadings: ['【有来源的历史与候选】', '【定稿原文 · 第1章', '【本章写作方向与核心任务】', '【后续计划边界'],
      prunedSections: ['【剧情记忆库与前置断点上下文】', '[全局剧情进展]', '[角色状态监控]', '[近期三章简要]', '上一章已完成的结尾状态', '【后续章节大纲预告】', '【知识库资料'] },
    { writingLanguage: 'en-US' as const,
      completedBoundary: '1. The [Finalized manuscript · Chapter N] passages (and any author-selected [Unfinalized candidate · Chapter N] passages) under [Sourced history and candidates] are prose written before this chapter; the end of the latest one is the previous chapter\'s completed state. [Chapter brief] and [Future-plan boundary] do not thereby become completed events.',
      forbiddenReplay: 'Do not quote, summarize, replay, or restage',
      presentHeadings: ['[Sourced history and candidates]', '[Finalized manuscript · Chapter 1', '[Chapter brief]', '[Future-plan boundary'],
      prunedSections: ['[Story memory and previous stopping point]', 'Overall progress:', 'Character states:', 'Recent chapters:', 'Completed ending state of the previous chapter', '[Upcoming chapter blueprints', '[Knowledge-base context]'] },
  ])('marks previous prose as completed history and prunes empty context sections in $writingLanguage', async ({
    writingLanguage,
    completedBoundary,
    forbiddenReplay,
    presentHeadings,
    prunedSections,
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
    // 第 1 条法则引用的标题必须真实存在；运行时留空的上下文段连同标题一起裁掉。
    for (const heading of presentHeadings) expect(prompt).toContain(heading)
    for (const section of prunedSections) expect(prompt).not.toContain(section)
    expect(prompt).not.toMatch(/\n{3,}/u)
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
      previousFinalizedContent: '第一章定稿原文。',
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

  it.each(['## ', ''])('bounds an explicit long chapter outline with heading prefix %j while retaining author facts', async (headingPrefix) => {
    const worldbuilding = [
      '世界规则开始：月桂港每天只有一次退潮。',
      // 必需材料现在也受预算（决定 1B），这份世界设定会同时进入架构与作者资料，
      // 所以长度要留在材料容量之内，同时仍然长到足以验证架构侧的精确去重。
      '港务规则必须服从潮汐钟。'.repeat(300),
      '世界观尾部关键事实：顾舟不会游泳。',
    ].join('\n')
    const synopsis = (outsideChapterSize: number) => `# 全书总纲
全局关键事实：潮门真相只能在终章揭晓。

${headingPrefix}第1章：失钟
第一章非当前内容开始。${'旧案延展。'.repeat(outsideChapterSize)}第一章非当前内容结束。

${headingPrefix}第2章：回港
当前章关键事实：顾舟必须在退潮前拿回潮汐钟。

${headingPrefix}第3章：潮门
第三章非当前内容开始。${'后续延展。'.repeat(outsideChapterSize)}第三章非当前内容结束。

## 全局禁则
全局尾部关键事实：任何人不得提前知道潮门来源。`
    const run = async (outline: string) => {
      const runtime = fakeOutcomes(outcome(`${'正文'.repeat(250)}。`, 'stop'))
      const { context, callbacks, command } = setup({
        runtime,
        chapterNumber: 2,
        wordsTarget: 500,
        previousFinalizedContent: '第一章定稿原文。',
        worldbuilding,
        worldSetting: worldbuilding,
        coreOutline: '作者核心事实：顾舟必须查清潮门来源。',
        synopsis: outline,
      })

      await command.execute({ step: {}, context, callbacks })
      return runtime.complete.mock.calls[0]?.[0].messages
        .find(message => message.role === 'user')?.content ?? ''
    }

    const shortPrompt = await run(synopsis(2))
    const longPrompt = await run(synopsis(4_000))

    expect(longPrompt).toContain('全局关键事实：潮门真相只能在终章揭晓')
    expect(longPrompt).toContain('当前章关键事实：顾舟必须在退潮前拿回潮汐钟')
    expect(longPrompt).toContain('全局尾部关键事实：任何人不得提前知道潮门来源')
    expect(longPrompt).toContain('世界观尾部关键事实：顾舟不会游泳')
    expect(longPrompt).toContain('作者核心事实：顾舟必须查清潮门来源')
    expect(longPrompt).not.toContain('第一章非当前内容开始')
    expect(longPrompt).not.toContain('第三章非当前内容开始')
    expect(longPrompt.length).toBe(shortPrompt.length)
    expect(longPrompt.match(/世界观尾部关键事实：顾舟不会游泳/gu)).toHaveLength(1)
  })

  it.each([
    {
      writingLanguage: 'zh-CN' as const,
      heading: '【定稿事实优先】',
      rule: '本章蓝图、章节计划或必需事件的措辞与已定稿章节中确立的事实（包括作者在定稿中的最新更正）冲突时，以定稿事实为准：按与定稿事实一致的方式落实该条目（例如改变阻碍发生的方式或原因），不得把已撤回、取消或被取代的计划写成已执行；蓝图明确写成本章新决定的（如重新启用某计划），按新决定写。',
      executionCard: '【本章执行卡（作者原文重列）】',
      lengthContract: '【本章篇幅合同】',
    },
    {
      writingLanguage: 'en-US' as const,
      heading: '[Finalized facts take precedence]',
      rule: "When the chapter blueprint, chapter plans, or the wording of required events conflict with facts established in finalized chapters (including the author's latest corrections in them), the finalized facts prevail: realize the item in a way consistent with them (for example, change how or why an obstacle happens) and never write a withdrawn, cancelled, or superseded plan as executed. If the blueprint explicitly states a new decision in this chapter (such as reviving a plan), write that new decision.",
      executionCard: '[Current-chapter execution card (author text repeated verbatim)]',
      lengthContract: '[Chapter length contract]',
    },
  ])('puts the $writingLanguage finalized-fact precedence rule in initial and continuation requests', async ({
    writingLanguage, heading, rule, executionCard, lengthContract,
  }) => {
    const runtime = fakeOutcomes(
      outcome('初'.repeat(100), 'length', 1),
      outcome(`${'续'.repeat(400)}。`, 'stop', 2),
    )
    const { context, callbacks, command } = setup({
      runtime, wordsTarget: 500, writingLanguage, chapterNumber: 2, keyEvents: '核查遇阻；承担代价',
      previousFinalizedContent: '作者更正：林澄撤回先前核查安排。',
    })

    await command.execute({ step: {}, context, callbacks })

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft', 'chapter-draft-continuation'])
    const [initial, continuation] = runtime.complete.mock.calls.map(([task]) => task.messages.at(-1)!.content)
    expect(initial).toContain(`${heading}\n${rule}`)
    expect(initial.split(rule)).toHaveLength(2)
    // 初始请求：执行卡之后、篇幅合同之前。
    const ruleIndex = initial.indexOf(heading)
    expect(ruleIndex).toBeGreaterThan(initial.lastIndexOf(executionCard))
    expect(initial.indexOf(lengthContract)).toBeGreaterThan(ruleIndex)
    // 续写复用作者资料块，同一措辞只出现一次。
    expect(continuation).toContain(`${heading}\n${rule}`)
    expect(continuation.split(heading)).toHaveLength(2)
  })

  describe('pre-draft finalized reconciliation', () => {
    const reconciliationOutput = (writingLanguage: 'zh-CN' | 'en-US') => JSON.stringify(writingLanguage === 'en-US'
      ? { finalState: ['Lin withdrew the inspection plan and waits for a new pass.'],
        events: [{ event: 'Inspection is blocked', conflict: true, realization: 'The pass request is refused; Lin does not set out.' },
          { event: 'Pay a price', conflict: false, realization: 'as written' }] }
      : { finalState: ['林澄已撤回核查安排，等待新的通行许可。'],
        events: [{ event: '核查遇阻', conflict: true, realization: '通行许可申请被驳回，林澄不出发核查。' },
          { event: '承担代价', conflict: false, realization: '按原文' }] })
    const expectedBlock = {
      'zh-CN': '【本章与定稿对账（生成前自动对账，须遵守）】\n上一章定稿结束时的状态（本章正文写出条件满足或人物作出新决定之前保持不变）：\n- 林澄已撤回核查安排，等待新的通行许可。\n本章必需事件的落实方式：\n'
        + '- 核查遇阻（按字面会与定稿冲突）：通行许可申请被驳回，林澄不出发核查。\n- 承担代价：按原文落实，不得与上述状态矛盾。\n'
        + '对账结论：以上冲突按给出的落实方式处理；不得把已撤回、取消或被取代的计划写成已执行。',
      'en-US': '[Reconciliation with finalized chapters (automatic pre-draft check; binding)]\nState at the end of the finalized previous chapter (it holds until this chapter\'s prose shows a condition being met or a character making a new decision):\n'
        + '- Lin withdrew the inspection plan and waits for a new pass.\nHow to realize this chapter\'s required events:\n'
        + '- Inspection is blocked (conflicts with the finalized facts if taken literally): The pass request is refused; Lin does not set out.\n'
        + '- Pay a price: as written, without contradicting the state above.\n'
        + 'Conclusion: resolve the conflicts above exactly as stated; never write a withdrawn, cancelled, or superseded plan as executed.',
    } as const
    const markers = {
      'zh-CN': { card: '【本章执行卡（作者原文重列）】', precedence: '【定稿事实优先】', heading: '【已定稿章节原文】', blueprint: '【本章蓝图】' },
      'en-US': { card: '[Current-chapter execution card (author text repeated verbatim)]', precedence: '[Finalized facts take precedence]',
        heading: '[Finalized chapter text]', blueprint: '[Current chapter blueprint]' },
    } as const

    it.each(['zh-CN', 'en-US'] as const)('reconciles once before the %s first draft and carries the result into continuation', async writingLanguage => {
      const runtime = fakeRuntime((attempt) => attempt === 1 ? outcome('初'.repeat(100), 'length', 1) : outcome(`${'续'.repeat(400)}。`, 'stop', 2),
        () => outcome(`<think>先想一想</think>\`\`\`json\n${reconciliationOutput(writingLanguage)}\n\`\`\``, 'stop'))
      const { context, callbacks, command } = setup({
        runtime, wordsTarget: 500, writingLanguage, chapterNumber: 2, keyEvents: '核查遇阻；承担代价',
        worldSetting: '铜钥匙始终由林澄保管。',
        previousFinalizedContent: '林澄写下核查安排。\n\n作者更正：林澄撤回先前核查安排，等待新的通行许可。',
      })

      await command.execute({ step: {}, context, callbacks })

      expect(runtime.reconcile).toHaveBeenCalledTimes(1)
      const reconcileTask = runtime.reconcile.mock.calls[0]![0]
      expect(reconcileTask).toMatchObject({ purpose: 'chapter-draft-reconcile', output: 'visible-text', reasoningStage: 'review',
        budgetDemand: { kind: 'structured-items', writingLanguage, requestedItems: 1 } })
      expect(reconcileTask.messages).toHaveLength(1)
      const reconcilePrompt = reconcileTask.messages[0]!.content
      for (const text of [markers[writingLanguage].heading, '作者更正：林澄撤回先前核查安排，等待新的通行许可。', '铜钥匙始终由林澄保管。',
        markers[writingLanguage].blueprint, '"keyEvents": "核查遇阻；承担代价"']) expect(reconcilePrompt).toContain(text)
      expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft', 'chapter-draft-continuation'])
      const [initial, continuation] = runtime.complete.mock.calls.map(([task]) => task.messages.at(-1)!.content)
      const block = expectedBlock[writingLanguage]
      // 首稿：紧跟执行卡（必需事件）之后、定稿事实优先规则之前，只出现一次。
      expect(initial.split(block)).toHaveLength(2)
      expect(initial.indexOf(block)).toBeGreaterThan(initial.indexOf(markers[writingLanguage].card))
      expect(initial).toContain(`${block}\n\n${markers[writingLanguage].precedence}`)
      // 续写复用作者资料块，携带同一对账结果。
      expect(continuation.split(block)).toHaveLength(2)
      expect(continuation).toContain(`${block}\n\n${markers[writingLanguage].precedence}`)
    })

    it('carries the reconciliation into the single condense revision', async () => {
      const draft = `${'长'.repeat(2700)}。`
      const condensed = `${'缩'.repeat(2000)}。`
      const runtime = fakeRuntime(attempt => attempt === 1 ? outcome(draft, 'stop', 1) : outcome(condensed, 'stop', 2),
        () => outcome(reconciliationOutput('zh-CN'), 'stop'))
      const { context, callbacks, command } = setup({ runtime, wordsPerChapter: 2000, wordsTarget: 2000, chapterNumber: 2,
        keyEvents: '核查遇阻；承担代价', previousFinalizedContent: '作者更正：林澄撤回先前核查安排，等待新的通行许可。' })

      await expect(command.execute({ step: {}, context, callbacks })).resolves.toBe(condensed)

      expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft', 'chapter-draft-condense'])
      const condensePrompt = runtime.complete.mock.calls[1]![0].messages.at(-1)!.content
      expect(condensePrompt).toContain(`${expectedBlock['zh-CN']}\n\n【定稿事实优先】`)
      expect(condensePrompt.indexOf(expectedBlock['zh-CN'])).toBeLessThan(condensePrompt.indexOf('【待压缩正文】'))
    })

    it('binds the reconciliation prompt and the unreconciled draft prompt into the material decision', async () => {
      const runtime = fakeRuntime(() => outcome('新章正文。'.repeat(125), 'stop'), () => outcome(reconciliationOutput('zh-CN'), 'stop'))
      const { context, callbacks, command } = setup({ runtime, wordsTarget: 500, chapterNumber: 2, keyEvents: '核查遇阻',
        previousFinalizedContent: '作者更正：林澄撤回先前核查安排。' })

      await command.execute({ step: {}, context, callbacks })

      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      const decision = runtime.createRuntime.mock.calls[0]?.[1]?.selection.materialDecision
      const reconcilePrompt = runtime.reconcile.mock.calls[0]![0].messages[0]!.content
      const initial = runtime.complete.mock.calls[0]![0].messages.at(-1)!.content
      expect(decision?.reconciliationPromptHash).toBe(hash(reconcilePrompt))
      expect(decision?.promptHash).toBe(hash(stripDraftReconciliationBlock(initial, reconciliationOutput('zh-CN'))!))
      expect(decision?.promptHash).not.toBe(hash(initial))
    })

    it('stops without drafting when the workflow is cancelled during reconciliation', async () => {
      let cancel = () => {}
      const runtime = fakeRuntime(() => outcome('新章正文。'.repeat(125), 'stop'), () => {
        cancel()
        throw new Error('GENERATION_WORKFLOW_CANCELLED')
      })
      const { context, callbacks, command } = setup({ runtime, wordsTarget: 500, chapterNumber: 2, keyEvents: '核查遇阻',
        previousFinalizedContent: '作者更正：林澄撤回先前核查安排。' })
      cancel = () => { context.cancelled = true }

      await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow()

      expect(runtime.reconcile).toHaveBeenCalledTimes(1)
      expect(runtime.complete).not.toHaveBeenCalled()
      expect(vi.mocked(callbacks.log).mock.calls.map(([line]) => String(line)).some(line => line.includes('按无对账继续生成'))).toBe(false)
    })

    it('does not reconcile without a finalized predecessor', async () => {
      const runtime = fakeOutcomes(outcome('新章正文。'.repeat(125), 'stop'))
      const { context, callbacks, command } = setup({ runtime, wordsTarget: 500, chapterNumber: 1, keyEvents: '核查遇阻' })

      await command.execute({ step: {}, context, callbacks })

      expect(runtime.reconcile).not.toHaveBeenCalled()
      expect(runtime.createRuntime.mock.calls[0]?.[1]?.selection.materialDecision?.reconciliationPromptHash).toBeUndefined()
    })

    it.each([
      ['a failed request', () => { throw new Error('GENERATION_PROVIDER_FAILED') }],
      ['an incomplete response', () => outcome(reconciliationOutput('zh-CN').slice(0, 20), 'length')],
      ['unparseable output', () => outcome('这里没有冲突。', 'stop')],
    ] as const)('continues with the unreconciled prompt after %s', async (_label, reconcile) => {
      const runtime = fakeRuntime(() => outcome('新章正文。'.repeat(125), 'stop'), reconcile)
      const { context, callbacks, command } = setup({ runtime, wordsTarget: 500, chapterNumber: 2, keyEvents: '核查遇阻',
        previousFinalizedContent: '作者更正：林澄撤回先前核查安排。' })

      await command.execute({ step: {}, context, callbacks })

      expect(runtime.reconcile).toHaveBeenCalledTimes(1)
      const decision = runtime.createRuntime.mock.calls[0]?.[1]?.selection.materialDecision
      const initial = runtime.complete.mock.calls[0]![0].messages.at(-1)!.content
      expect(initial).not.toContain('【本章与定稿对账')
      expect(decision?.promptHash).toBe(createHash('sha256').update(initial).digest('hex'))
      expect(vi.mocked(callbacks.log).mock.calls.map(([line]) => String(line)).some(line => line.includes('按无对账继续生成'))).toBe(true)
    })
  })

  it.each([
    ['zh-CN', '文风仅用于选择表达方式', '作者明确事实与指导、实际前文、本章关键因果和本章篇幅优先'],
    ['en-US', 'Writing style selects expression only', 'actual prior prose'],
  ] as const)('keeps the complete style profile optional in %s draft and continuation requests', async (
    writingLanguage,
    applicabilityBoundary,
    priorityBoundary,
  ) => {
    const writingStyle = 'STYLE_PROFILE_SENTINEL: sample flaw; two actions per scene; sample length 900.'
    const runtime = fakeOutcomes(
      outcome('初'.repeat(100), 'length', 1),
      outcome(`${'续'.repeat(400)}。`, 'stop', 2),
    )
    const { context, callbacks, command } = setup({
      runtime,
      wordsTarget: 500,
      writingLanguage,
      writingStyle,
    })

    await command.execute({ step: {}, context, callbacks })

    expect(runtime.complete).toHaveBeenCalledTimes(2)
    const prompts = runtime.complete.mock.calls.map(([task]) => (
      task.messages.map(message => message.content).join('\n')
    ))
    for (const prompt of prompts) {
      expect(prompt).toContain(writingStyle)
      expect(prompt.match(/STYLE_PROFILE_SENTINEL/gu)).toHaveLength(1)
      expect(prompt).toContain(applicabilityBoundary)
      expect(prompt).toContain(priorityBoundary)
    }
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
      previousFinalizedContent: '第七章定稿原文。',
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
      previousFinalizedContent: '第七章定稿原文。',
      continuity,
    })

    await command.execute({ step: {}, context, callbacks })

    const prompt = observedTask?.messages.find(message => message.role === 'user')?.content ?? ''
    expect(prompt).toContain('林岚在旧码头拒绝登船。')
    expect(prompt).toContain('【定稿原文 · 第1章 · draft 41】')
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
      previousFinalizedContent: '第四章定稿原文。',
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

  it('accepts exactly 70% of the target without requesting a continuation', async () => {
    const runtime = fakeOutcomes(outcome('正'.repeat(1400), 'stop', 1))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      wordsPerChapter: 2000,
      wordsTarget: 2000,
    })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toHaveLength(1400)

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft'])
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: '正'.repeat(1400), wordCount: 1400 }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('continues a 1399-unit result before persisting the completed draft', async () => {
    const runtime = fakeOutcomes(
      outcome('初'.repeat(1399), 'stop', 1),
      outcome('续', 'stop', 2),
    )
    const { invoke, context, callbacks, command } = setup({
      runtime,
      wordsPerChapter: 2000,
      wordsTarget: 2000,
    })

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

  it('persists exactly the 2600-unit upper bound without length repair', async () => {
    const draft = '正'.repeat(2600)
    const runtime = fakeOutcomes(outcome(draft, 'stop'))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      wordsPerChapter: 2000,
      wordsTarget: 2000,
    })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toBe(draft)

    expect(runtime.complete).toHaveBeenCalledOnce()
    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft'])
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: draft, wordCount: 2600 }),
      expect.anything(),
      expect.anything(),
    )
  })

  it('stores a 2601-unit length result as a recovery candidate after one failed condense request', async () => {
    const draft = '正'.repeat(2601)
    const runtime = fakeOutcomes(outcome(draft, 'length'))
    const { invoke, context, callbacks, command } = setup({
      runtime,
      wordsPerChapter: 2000,
      wordsTarget: 2000,
    })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('GENERATION_DRAFT_LENGTH_OUT_OF_RANGE')

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft', 'chapter-draft-condense'])
    expect(invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-record',
      expect.objectContaining({
        visibleText: draft,
        failureCode: 'GENERATION_DRAFT_LENGTH_OUT_OF_RANGE',
      }),
      expect.anything(),
      expect.anything(),
    )
    expect(callbacks.replaceText).toHaveBeenLastCalledWith(draft)
    expectNoDraftPersistence(invoke)
  })

  it('condenses an over-limit draft once and persists the in-range revision', async () => {
    const draft = `${'长'.repeat(2700)}。`
    const condensed = `${'缩'.repeat(2000)}。`
    const runtime = fakeOutcomes(outcome(draft, 'stop', 1), outcome(`<think>压缩</think>${condensed}`, 'stop', 2))
    const { invoke, context, callbacks, command } = setup({ runtime, wordsPerChapter: 2000, wordsTarget: 2000,
      globalGuidance: '压缩全局要求哨兵', writingStyle: '压缩文风哨兵', keyEvents: '压缩必需事件哨兵' })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toBe(condensed)

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft', 'chapter-draft-condense'])
    const condenseTask = runtime.complete.mock.calls[1]![0]
    expect(condenseTask).toMatchObject({ output: 'visible-text', reasoningStage: 'drafting',
      budgetDemand: { kind: 'draft-units', requestedUnits: 2000, segmentable: false } })
    const condensePrompt = condenseTask.messages.at(-1)!.content
    expect(condensePrompt).toContain('1400–2600')
    expect(condensePrompt).toContain('目标 2000 字（按汉字计，不含标点）；请写到约 1700–2000 字。2600 字是硬上限')
    // 与自动续写相同的作者资料块，随后才是篇幅合同、执行卡与待压缩正文。
    const order = ['【硬性要求】', '【本章蓝图】', '【全局写作要求】\n压缩全局要求哨兵', '【文风要求】\n压缩文风哨兵', '【文风适用边界】',
      '【小说配置事实】', '【作者资料（保留原文', '【定稿事实优先】', '【本章篇幅合同】', '【本章执行卡（作者原文重列）】', '- 必需事件: 压缩必需事件哨兵', '【待压缩正文】']
      .map(marker => condensePrompt.indexOf(marker))
    expect(order.every(index => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(condensePrompt.endsWith(`【待压缩正文】\n${draft}`)).toBe(true)
    expect(invoke).toHaveBeenCalledWith(
      'db:draft-create',
      expect.objectContaining({ content: condensed, wordCount: 2000 }),
      expect.anything(),
      expect.anything(),
    )
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:recovery-candidate-record')).toBe(false)
    expect(callbacks.replaceText).toHaveBeenLastCalledWith(condensed)
  })

  it('localizes the condense revision prompt for English manuscripts', async () => {
    const draft = `${'word '.repeat(1200).trim()}.`
    const condensed = `${'short '.repeat(900).trim()}.`
    const runtime = fakeOutcomes(outcome(draft, 'stop', 1), outcome(condensed, 'stop', 2))
    const { context, callbacks, command } = setup({ runtime, writingLanguage: 'en-US', wordsTarget: 900 })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toBe(condensed)

    const condensePrompt = runtime.complete.mock.calls[1]![0].messages.at(-1)!.content
    expect(condensePrompt).toContain('between 630 and 1170 words')
    expect(condensePrompt).toContain('[Chapter length contract]')
    const order = ['[Requirements]', '[Current chapter blueprint]', '[Project-wide writing guidance]', '[Writing style]', '[Novel configuration facts]',
      '[Author material (verbatim', '[Finalized facts take precedence]', '[Chapter length contract]', '[Manuscript to condense]'].map(marker => condensePrompt.indexOf(marker))
    expect(order.every(index => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(condensePrompt).not.toContain('【')
  })

  it.each([
    { label: 'still over the maximum', text: `${'缩'.repeat(2700)}。`, finishReason: 'stop' as const },
    { label: 'below the minimum', text: `${'缩'.repeat(1300)}。`, finishReason: 'stop' as const },
    { label: 'truncated by length', text: `${'缩'.repeat(2000)}`, finishReason: 'length' as const },
  ])('keeps the original length failure when the single condense revision is $label', async ({ text, finishReason }) => {
    const draft = `${'长'.repeat(2700)}。`
    const runtime = fakeOutcomes(outcome(draft, 'stop', 1), outcome(text, finishReason, 2))
    const { invoke, context, callbacks, command } = setup({ runtime, wordsPerChapter: 2000, wordsTarget: 2000 })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('GENERATION_DRAFT_LENGTH_OUT_OF_RANGE')

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft', 'chapter-draft-condense'])
    expect(invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-record',
      expect.objectContaining({ visibleText: draft, failureCode: 'GENERATION_DRAFT_LENGTH_OUT_OF_RANGE' }),
      expect.anything(),
      expect.anything(),
    )
    expect(callbacks.replaceText).toHaveBeenLastCalledWith(draft)
    expectNoDraftPersistence(invoke)
  })

  it('does not request a condense revision for a short draft that is continued into range', async () => {
    const runtime = fakeOutcomes(outcome('初'.repeat(1000), 'stop', 1), outcome(`${'续'.repeat(900)}。`, 'stop', 2))
    const { context, callbacks, command } = setup({ runtime, wordsPerChapter: 2000, wordsTarget: 2000 })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft', 'chapter-draft-continuation'])
  })

  it('continues a length result even after it has crossed 80%', async () => {
    const runtime = fakeOutcomes(
      outcome('初'.repeat(5000), 'length', 1),
      outcome(`${'续'.repeat(800)}。`, 'stop', 2),
    )
    const { context, callbacks, command } = setup({ runtime, wordsPerChapter: 6000 })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')
    expect(runtime.complete).toHaveBeenCalledTimes(2)
  })

  it('asks a below-target continuation for the remaining units under the hard ceiling and repeats the length contract', async () => {
    const runtime = fakeOutcomes(outcome(`${'初'.repeat(1000)}。`, 'stop', 1), outcome(`${'续'.repeat(900)}。`, 'stop', 2))
    const { context, callbacks, command } = setup({ runtime, wordsPerChapter: 2000, wordsTarget: 2000 })

    await expect(command.execute({ step: {}, context, callbacks })).resolves.toContain('续')

    const continuation = runtime.complete.mock.calls[1]![0]
    expect(continuation).toMatchObject({ purpose: 'chapter-draft-continuation', budgetDemand: { requestedUnits: 1000 } })
    const prompt = continuation.messages.at(-1)!.content
    expect(prompt).toContain('- 本次续写补足约 1000 字即可，新增部分绝不超过 1600 字；接近时按本章结束状态收束，停在完整句子和自然段落末尾。')
    expect(prompt).toContain('【本章篇幅合同】\n目标 2000 字（按汉字计，不含标点）；请写到约 1700–2000 字。2600 字是硬上限')
    expect(prompt.indexOf('【本章篇幅合同】')).toBeLessThan(prompt.indexOf('【本章蓝图】'))
    expect(prompt).not.toContain('剩余约')
  })

  it.each([
    { writingLanguage: 'zh-CN' as const, initial: `${'初'.repeat(2100)}`, addition: '收束。', target: 2000,
      instruction: '- 本章已达到目标篇幅：只补完被截断的句子并收束当前场景，新增部分约 150 字以内、绝不超过 500 字，不要展开新事件。',
      contract: '【本章篇幅合同】' },
    { writingLanguage: 'en-US' as const, initial: 'word '.repeat(1000).trim(), addition: 'and the door closed.', target: 900,
      instruction: '- The chapter has reached its target length: only finish the truncated sentence and close the current scene in about 150 words or fewer, never more than 170; do not start new events.',
      contract: '[Chapter length contract]' },
  ])('limits a $writingLanguage length-truncated continuation at the target to closing the truncated sentence', async ({ writingLanguage, initial, addition, target, instruction, contract }) => {
    const runtime = fakeOutcomes(outcome(initial, 'length', 1), outcome(addition, 'stop', 2))
    const { context, callbacks, command } = setup({ runtime, writingLanguage, wordsPerChapter: target, wordsTarget: target })

    await command.execute({ step: {}, context, callbacks })

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual(['chapter-draft', 'chapter-draft-continuation'])
    const continuation = runtime.complete.mock.calls[1]![0]
    expect(continuation.budgetDemand).toMatchObject({ requestedUnits: 150 })
    const prompt = continuation.messages.at(-1)!.content
    expect(prompt).toContain(instruction)
    expect(prompt).toContain(contract)
    expect(prompt).not.toMatch(/剩余约 0|approximately 0 words/u)
  })

  it('keeps a completed over-limit continuation as a recovery candidate instead of committing it', async () => {
    const initialCandidate = `${'甲'.repeat(3200)}。`
    const continuation = `${'乙'.repeat(701)}。`
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
    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toThrow('GENERATION_DRAFT_LENGTH_OUT_OF_RANGE')

    expect(runtime.complete.mock.calls.map(([task]) => task.purpose)).toEqual([
      'chapter-draft',
      'chapter-draft-continuation',
      'chapter-draft-condense',
    ])
    expect(invoke).toHaveBeenCalledWith(
      'db:recovery-candidate-record',
      expect.objectContaining({
        visibleText: completedDraft,
        failureCode: 'GENERATION_DRAFT_LENGTH_OUT_OF_RANGE',
      }),
      expect.anything(),
      expect.anything(),
    )
    expectNoDraftPersistence(invoke)
  })

  it('keeps an over-target length candidate visible when the shared budget cannot continue it', async () => {
    const initialCandidate = `${'甲'.repeat(3500)}。`
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
      outcome(`${'甲'.repeat(3100)}。`, 'length', 1),
      outcome(`${'乙'.repeat(400)}。`, 'stop', 2),
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
      previousFinalizedContent: 'The previous chapter is finalized.',
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

  it('surfaces a main-owned safe provider failure code without saving a draft', async () => {
    const failed = outcome('', 'error')
    Object.assign(failed.receipt, { failureCode: 'GENERATION_PROVIDER_FAILED' })
    const runtime = fakeOutcomes(failed)
    const { invoke, context, callbacks, command } = setup({ runtime })

    await expect(command.execute({ step: {}, context, callbacks }))
      .rejects.toMatchObject({ code: 'GENERATION_PROVIDER_FAILED' })
    expect(runtime.complete).toHaveBeenCalledOnce()
    expectNoDraftPersistence(invoke)
  })

  it('does not turn untrusted failure text into a displayed code', async () => {
    const failed = outcome('', 'error')
    Object.assign(failed.receipt, { failureCode: 'provider body: synthetic-private-key' })
    const runtime = fakeOutcomes(failed)
    const { context, callbacks, command } = setup({ runtime })

    const error = await command.execute({ step: {}, context, callbacks }).catch(value => value)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toHaveProperty('code')
    expect(error.message).not.toContain('synthetic-private-key')
  })

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
      .rejects.toThrow('AI 输出达到本次请求长度限制，尚未完整生成')
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
