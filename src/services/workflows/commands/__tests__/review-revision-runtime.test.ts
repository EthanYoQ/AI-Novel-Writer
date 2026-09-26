import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { RefineDraftCommand } from '../refine-draft.command'
import { RefineFromReviewCommand } from '../refine-from-review.command'
import { ReviewChapterCommand } from '../review-chapter.command'
import { ReviewRevisionRuntimeFixture } from './review-revision-runtime.fixture'
import { workflowRuntimeDependencies } from './workflow-generation-runtime.fixture'
import { useProjectStore } from '../../../../stores/project-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import type { WorkflowContext } from '../../../../stores/workflow-store'
import type { LLMFinishReason } from '../../../../shared/ipc-channels'
import type { ReviewRevisionOperation } from '../../../../shared/review-revision-generation'
import type { ReviewRevisionCommandSource } from '../review-revision-command'
import { createHumanConfirmedReviewSnapshot, serializeHumanConfirmedReviewSnapshot } from '../../../../shared/human-confirmed-review'
import { clearProjectCustomPrompts } from '../../../prompt-templates'
import type { FinalizedContinuityProjection } from '../../../../shared/finalized-continuity'
import { countDraftUnits } from '../../../../shared/draft-units'

const projectPath = 'C:\\synthetic\\review-runtime'
const session = { projectId: 'review-runtime', projectPath, leaseId: 'review-epoch' }
const source = { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, content: '原稿正文。'.repeat(60) }
const revised = '修订正文。'.repeat(60)
const review = JSON.stringify({ summary: '模型总结', items: [{ category: '连续性', severity: 'pass', description: '逐项核对完成。' }] })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
type Response = { content: string; finishReason: LLMFinishReason } | Error

function setup(responses: Response[], projections: FinalizedContinuityProjection[] = [], activeSource = source) {
  let saveFailures = 0
  let writes = 0
  let current = { ...activeSource }
  const confirmation = serializeHumanConfirmedReviewSnapshot(createHumanConfirmedReviewSnapshot({
    sourceReviewId: 9, sourceDraft: activeSource, summary: '模型总结不应注入', authorGuidance: '作者确认的额外指导',
    items: [{ category: '连续性', severity: 'warning', description: '已选择的意见', decision: 'apply', origin: 'ai' },
      { category: '连续性', severity: 'warning', description: '已忽略的意见', decision: 'ignore', origin: 'ai' }],
  })!)
  const backend = vi.fn(async (channel: string) => {
    if (channel === 'db:draft-get-full') return current
    if (channel === 'db:draft-get-meta') return { ...current, source: 'write' }
    if (channel === 'db:continuity-list-before') return projections
    if (channel === 'db:review-get-full') return { id: 10, baseDraftId: 1, content: confirmation, sourceDraft: activeSource }
    if (channel === 'db:revision-replace-pending' || channel === 'db:review-create') {
      if (saveFailures-- > 0) return { success: false, error: 'synthetic storage failed' }
      writes += 1
      return { success: true, id: 9, revisionIndex: 2, reviewIndex: 2 }
    }
    throw new Error(`unexpected IPC: ${channel}`)
  })
  const fixture = new ReviewRevisionRuntimeFixture(backend)
  const providerBindCounts: number[] = []
  const provider = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(async (_messages, callbacks) => {
    providerBindCounts.push(fixture.materialDecisions.length)
    const response = responses.shift()
    if (!response) throw new Error('unexpected synthetic provider request')
    if (response instanceof Error) callbacks.onError?.(response.message)
    else callbacks.onDone?.(response.content, undefined, response.finishReason)
    return 'synthetic-request'
  })
  useLLMStore.setState({ defaultModelId: 'model-a', generateStream: provider })
  const dependencies = { createRuntime: vi.fn(fixture.wrap(workflowRuntimeDependencies).createRuntime) }
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
    if (channel === 'fs:check-exists') return false
    return fixture.invoke(channel, ...args)
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke } })
  const context: WorkflowContext = { runId: 'consumer-action', projectPath, projectSession: session,
    writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false }
  const callbacks = { log: vi.fn(), appendText: vi.fn(), replaceText: vi.fn(), setProgress: vi.fn() }
  const args = { step: {}, context, callbacks }
  const command = (operation: ReviewRevisionOperation, overrides: Partial<ReviewRevisionCommandSource> = {}) => {
    const selected = { draftPath: 'ai-novel://draft/1', draftContent: activeSource.content, chapterNumber: 1,
      sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, contentRevision: 1 }, ...overrides }
    fixture.selected = selected
    if (operation === 'review-chapter') return new ReviewChapterCommand({ ...selected, reviewFocus: '作者指定的审稿重点' }, dependencies)
    if (operation === 'refine-from-review') return new RefineFromReviewCommand({ ...selected, reviewSourceId: 10,
      confirmedReviewContent: confirmation, userRefinePrompt: '未确认的临时指导' }, dependencies)
    return new RefineDraftCommand({ ...selected, userRefinePrompt: '作者选定的修稿指导', mergedGuidance: '明确合并指导', shortSummary: '未绑定摘要',
      chapterInfo: { projectPath, chapterNumber: 1, title: '未绑定标题', role: '', purpose: '', keyEvents: '', characters: [] } }, dependencies)
  }
  return { fixture, provider, providerBindCounts, dependencies, backend, invoke, args, command,
    failSaves: (count: number) => { saveFailures = count }, writes: () => writes,
    changeSource: () => { current = { ...activeSource, content: activeSource.content + '作者已保存修改' } } }
}

beforeEach(() => {
  useProjectStore.setState({ currentProject: { id: session.projectId, path: projectPath, name: 'Synthetic', sessionLease: session.leaseId,
    novelConfig: { wordsPerChapter: 300, globalGuidance: '冻结项目指导', writingLanguage: 'zh-CN' } } as never })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})
afterEach(() => { clearProjectCustomPrompts(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: null }) })

describe('review/revision consumers using the main contract (synthetic transport)', () => {
  it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)(
    'binds %s admission to the exact initial user message before the first provider request',
    async operation => {
      const f = setup([{ content: operation === 'review-chapter' ? review : revised, finishReason: 'stop' }])

      await f.command(operation).execute(f.args)

      const userPrompt = f.provider.mock.calls[0]?.[0].find(message => message.role === 'user')?.content ?? ''
      expect(userPrompt).not.toBe('')
      expect(f.providerBindCounts[0]).toBe(1)
      expect(f.fixture.materialDecisions).toHaveLength(1)
      expect(f.fixture.materialDecisions[0]?.promptHash).toBe(hash(userPrompt))
      expect(f.fixture.materialDecisions[0]?.coverage.complete).toBe(true)
      if (operation === 'refine-from-review') {
        // The material authority is the persisted human-confirmation row (10), not its original AI review (9).
        expect(f.fixture.materialDecisions[0]?.included.map(item => item.sourceId)).toEqual(['review:confirmed:10'])
        expect(f.fixture.materialDecisions[0]?.included.map(item => item.revision)).toEqual([10])
      } else {
        expect(f.fixture.materialDecisions[0]?.included).toEqual([])
        expect(f.fixture.materialDecisions[0]?.capacity.admittedUnits).toBe(0)
      }
    },
  )

  it('requires each ordinary-review quote to be one unique contiguous draft excerpt', async () => {
    const f = setup([{ content: review, finishReason: 'stop' }])

    await f.command('review-chapter').execute(f.args)

    const prompt = f.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
    expect(prompt).toContain('逐字连续、且全文仅出现一次的单一摘录')
    expect(prompt).toContain('不得拼接多个位置、改写原文或包含省略号')
    expect(prompt).toContain('优先选择足以证明问题的最短完整句')
    expect(prompt).toContain('需要多处证据时拆成多个 evidence 项')
  })

  it('renders the unique contiguous evidence-anchor constraint for an English ordinary review', async () => {
    useProjectStore.setState({ currentProject: { id: session.projectId, path: projectPath, name: 'Synthetic', sessionLease: session.leaseId,
      novelConfig: { wordsPerChapter: 300, globalGuidance: 'frozen guidance', writingLanguage: 'en-US' } } as never })
    const f = setup([{ content: review, finishReason: 'stop' }])

    await f.command('review-chapter').execute(f.args)

    const prompt = f.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
    expect(prompt).toContain('[Strict evidence-anchor constraint]')
    expect(prompt).toContain('one verbatim, contiguous excerpt that occurs exactly once')
    expect(prompt).toContain('Do not combine multiple locations')
    expect(prompt).toContain('use separate evidence entries')
  })

  it('prepares source hashes, binds only the main context and commits the verified composition reference', async () => {
    const f = setup([{ content: revised, finishReason: 'stop' }])
    const result = await f.command('refine-draft').execute(f.args)
    const request = f.fixture.calls.find(c => c.channel === 'review-revision:prepare')!.args[0]
    expect(request).toMatchObject({ draftId: 1, expectedDraft: { contentHash: hash(source.content) },
      authorInputs: [{ id: 'user-prompt', text: '作者选定的修稿指导' }, { id: 'merged-guidance', text: '明确合并指导' }] })
    expect(request).not.toHaveProperty('content')
    expect(f.fixture.selections[0]).toMatchObject({ operation: 'refine-draft', reviewRevisionContextId: 'fixture-context',
      selectedDraftIds: [1], selectedFinalizedDraftIds: [], authorInputs: [{ id: 'review-revision-context', text: JSON.stringify(f.fixture.prepared!.context) }] })
    const prompt = f.provider.mock.calls[0]![0].map(m => m.content).join('\n')
    expect(prompt).toContain('作者选定的修稿指导')
    expect(prompt).not.toContain('未绑定摘要')
    expect(prompt).not.toContain('未绑定标题')
    expect(f.fixture.calls.find(c => c.channel === 'review-revision:commit-revision')!.args[0]).toEqual({
      contextId: 'fixture-context', handle: f.args.context.mainGenerationRunHandle, expectedCompositionHash: hash(revised),
    })
    expect(f.fixture.calls.some(c => c.channel === 'db:revision-replace-pending')).toBe(false)
    expect(result).toBe(f.fixture.recovery!.saved!.content)
    expect(f.writes()).toBe(1)
  })

  it('rejects a missing UI snapshot whose actual source body changed before preparing or requesting', async () => {
    const f = setup([])
    f.changeSource()
    await expect(f.command('refine-draft', { sourceDraft: undefined }).execute(f.args)).rejects.toMatchObject({ code: 'SOURCE_DRAFT_CHANGED' })
    expect(f.dependencies.createRuntime).not.toHaveBeenCalled()
    expect(f.provider).not.toHaveBeenCalled()
    expect(f.writes()).toBe(0)
  })

  it('forwards the main-proved review root/model and only confirmed decisions to review refinement', async () => {
    const f = setup([{ content: revised, finishReason: 'stop' }])
    f.args.context.generationModelId = 'renderer-selected-other-model'
    await f.command('refine-from-review').execute(f.args)
    expect(f.fixture.selections[0]).toMatchObject({ parentRootActionId: 'fixture-review-root' })
    expect(f.dependencies.createRuntime.mock.calls[0]![0]).toMatchObject({ modelId: 'model-a' })
    const prompt = f.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
    expect(prompt).toContain('已选择的意见')
    expect(prompt).toContain('作者确认的额外指导')
    expect(prompt).not.toContain('已忽略的意见')
    expect(prompt).not.toContain('未确认的临时指导')
    const sourceUnits = countDraftUnits(source.content)
    const range = { minimum: Math.floor(sourceUnits * 0.8), maximum: Math.ceil(sourceUnits * 1.2) }
    expect(prompt).toContain(`冻结源稿共 ${sourceUnits} 个正文单位`)
    expect(prompt).toContain(`${range.minimum}-${range.maximum} 个正文单位之间`)
    expect(prompt).toContain('所有未受影响的段落或行必须完整保留')
    expect(prompt).toContain('不得摘要、节选、合并重复段落或使用占位符')
    expect(f.fixture.materialDecisions[0]?.promptHash).toBe(hash(prompt))
  })

  it('renders the complete-revision contract in English and rejects a zero-unit source before dispatch', async () => {
    useProjectStore.setState({ currentProject: { id: session.projectId, path: projectPath, name: 'Synthetic', sessionLease: session.leaseId,
      novelConfig: { wordsPerChapter: 300, globalGuidance: 'frozen guidance', writingLanguage: 'en-US' } } as never })
    const english = setup([{ content: revised, finishReason: 'stop' }])
    english.args.context.writingLanguage = 'en-US'
    english.args.context.uiLocale = 'en-US'
    await english.command('refine-from-review').execute(english.args)
    const prompt = english.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
    expect(prompt).toContain('[Complete-revision hard constraint]')
    expect(prompt).toContain('Preserve every unaffected paragraph or line in full')
    expect(prompt).toContain('Do not summarize, excerpt, collapse repeated passages, or use placeholders')
    expect(english.fixture.materialDecisions[0]?.promptHash).toBe(hash(prompt))

    useProjectStore.setState({ currentProject: { id: session.projectId, path: projectPath, name: 'Synthetic', sessionLease: session.leaseId,
      novelConfig: { wordsPerChapter: 300, globalGuidance: '冻结项目指导', writingLanguage: 'zh-CN' } } as never })
    const punctuationOnly = { ...source, content: '！……🚀' }
    const empty = setup([], [], punctuationOnly)
    await expect(empty.command('refine-from-review').execute(empty.args)).rejects.toThrow(/有效的人工确认快照|valid human-confirmed review snapshot/)
    expect(empty.provider).not.toHaveBeenCalled()
    expect(empty.fixture.materialDecisions).toHaveLength(0)
  })

  it('treats a terminal invalid stop candidate as copy-only without reopening the runtime', async () => {
    const f = setup([{ content: '太短', finishReason: 'stop' }])
    await expect(f.command('refine-from-review').execute(f.args)).rejects.toThrow('修稿结果明显短于原稿')
    const handle = f.fixture.recovery!.handle
    f.fixture.recovery!.canResume = false
    delete f.fixture.recovery!.contextId
    f.provider.mockClear()
    f.dependencies.createRuntime.mockClear()

    await expect(f.command('refine-from-review', { recoveryHandle: handle }).execute(f.args))
      .rejects.toThrow('GENERATION_REVIEW_RECOVERY_COPY_ONLY')
    expect(f.dependencies.createRuntime).not.toHaveBeenCalled()
    expect(f.provider).not.toHaveBeenCalled()
  })

  it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)('retries %s storage using the original artifact without loading a new template or requesting again', async operation => {
    const f = setup([{ content: operation === 'review-chapter' ? review : revised, finishReason: 'stop' }])
    const command = f.command(operation)
    f.failSaves(1)
    await expect(command.execute(f.args)).rejects.toThrow('synthetic storage failed')
    const firstRequest = structuredClone(f.fixture.calls.find(c => c.channel.startsWith('review-revision:commit-'))!.args[0])
    const artifact = f.fixture.recovery!.latestArtifact
    clearProjectCustomPrompts()
    f.invoke.mockImplementation(async (channel, ...args) => {
      if (channel.startsWith('prompt:') || channel.startsWith('fs:')) throw new Error('template unavailable after generation')
      return f.fixture.invoke(channel, ...args)
    })
    const saved = await command.execute(f.args)
    expect(f.provider).toHaveBeenCalledTimes(1)
    expect(f.fixture.calls.filter(c => c.channel === 'review-revision:prepare')).toHaveLength(1)
    expect(f.fixture.calls.filter(c => c.channel.startsWith('review-revision:commit-')).at(-1)!.args[0]).toEqual(firstRequest)
    expect(f.fixture.recovery!.latestArtifact).toEqual(artifact)
    expect(saved).toBe(f.fixture.recovery!.saved!.content)
    const opened = f.dependencies.createRuntime.mock.calls.length
    const callsBeforeSavedAck = f.invoke.mock.calls.length
    const decisionsBeforeSavedAck = structuredClone(f.fixture.materialDecisions)
    await command.execute(f.args)
    expect(f.dependencies.createRuntime).toHaveBeenCalledTimes(opened)
    expect(f.invoke.mock.calls.slice(callsBeforeSavedAck).map(([channel]) => channel)).toEqual(['review-revision:read-recovery'])
    expect(f.fixture.materialDecisions).toEqual(decisionsBeforeSavedAck)
    expect(f.writes()).toBe(1)
  })

  it.each(['merged', 'discarded'] as const)('opens a saved %s revision read-only without a runtime or another replacement', async revisionStatus => {
    const f = setup([{ content: revised, finishReason: 'stop' }])
    await f.command('refine-draft').execute(f.args)
    f.fixture.recovery!.saved!.revisionStatus = revisionStatus
    f.fixture.recovery!.sourceStatus = 'conflict'
    useEditorStore.setState({ tabs: [], activeTabId: null })
    f.dependencies.createRuntime.mockClear()
    await f.command('refine-draft', { recoveryHandle: f.fixture.recovery!.handle, draftContent: '过期UI正文' }).execute(f.args)
    expect(f.dependencies.createRuntime).not.toHaveBeenCalled()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ type: 'chapter', draftStatus: 'archived', content: revised })
    expect(f.writes()).toBe(1)
  })

  it('keeps a conflicted candidate and refuses recovery writes or generation', async () => {
    const f = setup([{ content: revised, finishReason: 'stop' }])
    const command = f.command('refine-draft')
    f.failSaves(1)
    await expect(command.execute(f.args)).rejects.toThrow('storage failed')
    const artifact = structuredClone(f.fixture.recovery!.latestArtifact)
    f.fixture.recovery!.sourceStatus = 'conflict'
    await expect(command.execute(f.args)).rejects.toMatchObject({ code: 'SOURCE_DRAFT_CHANGED' })
    expect(f.fixture.recovery!.latestArtifact).toEqual(artifact)
    expect(f.provider).toHaveBeenCalledTimes(1)
    expect(f.writes()).toBe(0)
  })

  it('recovers broken stop JSON with a separate replacement attempt, retaining the original artifact', async () => {
    const f = setup([{ content: '{"summary":', finishReason: 'stop' }, new Error('synthetic network failure'), { content: review, finishReason: 'stop' }])
    const command = f.command('review-chapter')
    await expect(command.execute(f.args)).rejects.toThrow()
    const broken = f.fixture.recovery!.latestArtifact!
    await command.execute(f.args)
    expect(f.fixture.artifacts.get(broken.artifactId)?.text).toBe('{"summary":')
    expect(f.fixture.recovery!.latestArtifact!.artifactId).not.toBe(broken.artifactId)
    expect(f.fixture.recovery!.attemptedPurposes).toEqual(['review-chapter', 'review-chapter-rebuild', 'review-chapter-rebuild'])
    expect(f.fixture.materialDecisions).toHaveLength(2)
    expect(f.fixture.materialDecisions[1]).toEqual(f.fixture.materialDecisions[0])
    expect(f.fixture.calls.some(c => c.channel === 'generation:compose-visible')).toBe(false)
    expect(f.writes()).toBe(1)
  })

  it('persists malformed one-time recheck output as unknown without a replacement model call', async () => {
    const historySentinel = 'RECHECK_MUST_NOT_CLAIM_OR_RENDER_FINALIZED_HISTORY'
    const f = setup([{ content: 'not-json', finishReason: 'stop' }], [{
      draftId: 7, chapterNumber: 0, chapterTitle: '历史章', chapterNotes: historySentinel,
      sourceStatus: 'current', facts: [],
    }])
    const selected = { draftPath: 'ai-novel://draft/1', draftContent: source.content, chapterNumber: 1,
      sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, contentRevision: 1 } }
    f.fixture.selected = selected
    const command = new ReviewChapterCommand({ ...selected, reviewCycleId: 'cycle-1',
      expectedMergedHash: hash(source.content) }, f.dependencies)
    const result = await command.execute(f.args)
    const prepare = f.fixture.calls.find(call => call.channel === 'review-revision:prepare')!.args[0]
    expect(prepare).toMatchObject({ reviewCycleId: 'cycle-1', expectedMergedHash: hash(source.content) })
    expect(f.fixture.selections[0]).toMatchObject({ parentRootActionId: 'fixture-review-root' })
    expect(f.provider).toHaveBeenCalledTimes(1)
    const prompt = JSON.stringify(f.provider.mock.calls[0]?.[0])
    expect(prompt).toContain('门闩仍然敞开')
    expect(prompt).toContain('门闩必须保持关闭')
    expect(prompt).toContain('换一种错误说法，不代表问题已解决')
    expect(prompt).toContain('新增动作或结果本身必须满足目标语义')
    expect(prompt).toContain('签字认责或简单否定翻转都不能证明结果已经实现')
    expect(prompt).toContain('已经失去、消耗或承受的具体后果')
    expect(prompt).toContain('后文不得保留相反状态')
    expect(prompt).not.toContain(historySentinel)
    expect(prompt).not.toContain('证据锚点硬约束')
    expect(prompt).not.toContain('[Strict evidence-anchor constraint]')
    expect(f.fixture.materialDecisions[0]?.included).toEqual([])
    expect(f.fixture.materialDecisions[0]?.capacity.admittedUnits).toBe(0)
    expect(f.fixture.recovery!.attemptedPurposes).toEqual(['review-chapter'])
    expect(result).toContain('复核输出无效')
    expect(result).toContain('"severity": "unknown"')
  })

  it('continues the persisted revision composition after a network failure without regenerating its prefix', async () => {
    const prefix = '前半段修订正文。'.repeat(30)
    const f = setup([{ content: prefix, finishReason: 'length' }, new Error('synthetic network failure'), { content: '新增结尾。'.repeat(30), finishReason: 'stop' }])
    const command = f.command('refine-draft')
    await expect(command.execute(f.args)).rejects.toThrow()
    const priorId = f.fixture.recovery!.composition!.artifactIds[0]
    const result = await command.execute(f.args)
    expect(result.startsWith(prefix)).toBe(true)
    expect(f.fixture.recovery!.composition!.artifactIds[0]).toBe(priorId)
    expect(f.fixture.recovery!.attemptedPurposes).toHaveLength(3)
    expect(f.fixture.materialDecisions).toHaveLength(2)
    expect(f.fixture.materialDecisions[1]).toEqual(f.fixture.materialDecisions[0])
    expect(f.provider).toHaveBeenCalledTimes(3)
    expect(f.writes()).toBe(1)
  })

  it('does not reset the four-request revision limit on a recovery retry', async () => {
    const f = setup(Array.from({ length: 4 }, (_, i) => ({ content: `${i}独立片段。`.repeat(40), finishReason: 'length' as const })))
    const command = f.command('refine-draft')
    await expect(command.execute(f.args)).rejects.toThrow()
    await expect(command.execute(f.args)).rejects.toThrow()
    expect(f.provider).toHaveBeenCalledTimes(4)
    expect(f.fixture.recovery!.attemptedPurposes).toHaveLength(4)
    expect(f.fixture.recovery!.composition!.artifactIds).toHaveLength(4)
    expect(f.writes()).toBe(0)
  })

  it('rejects a receipt whose persisted content hash was altered instead of opening renderer prose', async () => {
    const f = setup([{ content: revised, finishReason: 'stop' }])
    await f.command('refine-draft').execute(f.args)
    f.fixture.recovery!.saved!.contentHash = '0'.repeat(64)
    useEditorStore.setState({ tabs: [], activeTabId: null })
    await expect(f.command('refine-draft', { recoveryHandle: f.fixture.recovery!.handle }).execute(f.args)).rejects.toThrow('RECEIPT_MISMATCH')
    expect(useEditorStore.getState().tabs).toEqual([])
    expect(f.provider).toHaveBeenCalledTimes(1)
  })
})
