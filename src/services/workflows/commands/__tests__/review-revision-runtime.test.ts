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

const projectPath = 'C:\\synthetic\\review-runtime'
const session = { projectId: 'review-runtime', projectPath, leaseId: 'review-epoch' }
const source = { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, content: '原稿正文。'.repeat(60) }
const revised = '修订正文。'.repeat(60)
const review = JSON.stringify({ summary: '模型总结', items: [{ category: '连续性', severity: 'pass', description: '逐项核对完成。' }] })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
type Response = { content: string; finishReason: LLMFinishReason } | Error

function setup(responses: Response[]) {
  let saveFailures = 0
  let writes = 0
  let current = { ...source }
  const confirmation = serializeHumanConfirmedReviewSnapshot(createHumanConfirmedReviewSnapshot({
    sourceReviewId: 9, sourceDraft: source, summary: '模型总结不应注入', authorGuidance: '作者确认的额外指导',
    items: [{ category: '连续性', severity: 'warning', description: '已选择的意见', decision: 'apply', origin: 'ai' },
      { category: '连续性', severity: 'warning', description: '已忽略的意见', decision: 'ignore', origin: 'ai' }],
  })!)
  const backend = vi.fn(async (channel: string) => {
    if (channel === 'db:draft-get-full') return current
    if (channel === 'db:draft-get-meta') return { ...current, source: 'write' }
    if (channel === 'db:review-get-full') return { id: 10, baseDraftId: 1, content: confirmation, sourceDraft: source }
    if (channel === 'db:revision-replace-pending' || channel === 'db:review-create') {
      if (saveFailures-- > 0) return { success: false, error: 'synthetic storage failed' }
      writes += 1
      return { success: true, id: 9, revisionIndex: 2, reviewIndex: 2 }
    }
    throw new Error(`unexpected IPC: ${channel}`)
  })
  const fixture = new ReviewRevisionRuntimeFixture(backend)
  const provider = vi.fn<ReturnType<typeof useLLMStore.getState>['generateStream']>(async (_messages, callbacks) => {
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
    const selected = { draftPath: 'ai-novel://draft/1', draftContent: source.content, chapterNumber: 1,
      sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, contentRevision: 1 }, ...overrides }
    fixture.selected = selected
    if (operation === 'review-chapter') return new ReviewChapterCommand({ ...selected, reviewFocus: '作者指定的审稿重点' }, dependencies)
    if (operation === 'refine-from-review') return new RefineFromReviewCommand({ ...selected, reviewSourceId: 10,
      confirmedReviewContent: confirmation, userRefinePrompt: '未确认的临时指导' }, dependencies)
    return new RefineDraftCommand({ ...selected, userRefinePrompt: '作者选定的修稿指导', mergedGuidance: '明确合并指导', shortSummary: '未绑定摘要',
      chapterInfo: { projectPath, chapterNumber: 1, title: '未绑定标题', role: '', purpose: '', keyEvents: '', characters: [] } }, dependencies)
  }
  return { fixture, provider, dependencies, backend, invoke, args, command,
    failSaves: (count: number) => { saveFailures = count }, writes: () => writes,
    changeSource: () => { current = { ...source, content: source.content + '作者已保存修改' } } }
}

beforeEach(() => {
  useProjectStore.setState({ currentProject: { id: session.projectId, path: projectPath, name: 'Synthetic', sessionLease: session.leaseId,
    novelConfig: { wordsPerChapter: 300, globalGuidance: '冻结项目指导', writingLanguage: 'zh-CN' } } as never })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})
afterEach(() => { clearProjectCustomPrompts(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: null }) })

describe('review/revision consumers using the main contract (synthetic transport)', () => {
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
    const prompt = f.provider.mock.calls[0]![0].map(m => m.content).join('\n')
    expect(prompt).toContain('已选择的意见')
    expect(prompt).toContain('作者确认的额外指导')
    expect(prompt).not.toContain('已忽略的意见')
    expect(prompt).not.toContain('未确认的临时指导')
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
    await command.execute(f.args)
    expect(f.dependencies.createRuntime).toHaveBeenCalledTimes(opened)
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
    expect(f.fixture.calls.some(c => c.channel === 'generation:compose-visible')).toBe(false)
    expect(f.writes()).toBe(1)
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
