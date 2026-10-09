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
import { reviewRevisionAiBrief, reviewRevisionAuthorMaterial, type ReviewRevisionOperation } from '../../../../shared/review-revision-generation'
import { MATERIAL_DECISION_MAX_INPUT_UNITS } from '../../../../shared/generation-owner-contract'
import type { ReviewRevisionCommandSource } from '../review-revision-command'
import { createHumanConfirmedReviewSnapshot, serializeHumanConfirmedReviewSnapshot } from '../../../../shared/human-confirmed-review'
import { clearProjectCustomPrompts, getBuiltinPromptTemplate, getPromptSource } from '../../../prompt-templates'
import { ipcPromptPersistence } from '../../../prompt-catalog'
import type { FinalizedContinuityProjection } from '../../../../shared/finalized-continuity'

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

it('saves a unique complete report surrounded by prose after one model response', async () => {
  const wrapped = `检查结果如下：\n\`\`\`json\n${review}\n\`\`\`\n检查结束。`
  const f = setup([{ content: wrapped, finishReason: 'stop' }])
  await f.command('review-chapter').execute(f.args)
  expect(f.provider).toHaveBeenCalledTimes(1)
  expect(f.fixture.calls.filter(call => call.channel === 'review-revision:commit-review')).toHaveLength(1)
  expect(f.writes()).toBe(1)
  expect(f.fixture.recovery?.latestArtifact?.text).toBe(wrapped)
  expect(JSON.parse(f.fixture.recovery!.saved!.content).items[0]).toEqual(JSON.parse(review).items[0])
})

beforeEach(() => {
  useProjectStore.setState({ currentProject: { id: session.projectId, path: projectPath, name: 'Synthetic', sessionLease: session.leaseId,
    novelConfig: { wordsPerChapter: 300, globalGuidance: '冻结项目指导', writingLanguage: 'zh-CN' } } as never })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
})
afterEach(() => { clearProjectCustomPrompts(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: null }) })

describe('review/revision consumers using the main contract (synthetic transport)', () => {
  it.each(['refine-draft', 'refine-from-review'] as const)('saves and reopens complete overlength %s with one notice and no generation on replay', async operation => {
    for (const [sourceUnits, targetUnits] of [[1000, 2000], [1200, 1000], [1000, 1000]]) {
      const project = useProjectStore.getState().currentProject!
      useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, wordsPerChapter: targetUnits } } })
      const content = `${'修'.repeat(1400)}。`
      const f = setup([{ content, finishReason: 'stop' }], [], { ...source, content: `${'原'.repeat(sourceUnits)}。` })
      await expect(f.command(operation).execute(f.args)).resolves.toBe(content)
      expect(f.writes()).toBe(1)
      expect(f.fixture.recovery!.saved).toMatchObject({ content, contentHash: hash(content) })
      expect(f.args.callbacks.log.mock.calls.filter(([text]) => text.includes('字数超过约定'))).toEqual([['第1章字数超过约定']])
      expect(useEditorStore.getState().tabs.at(-1)).toMatchObject({ type: 'diff', content })
      f.provider.mockClear()
      f.args.callbacks.log.mockClear()
      await expect(f.command(operation, { recoveryHandle: f.fixture.recovery!.handle }).execute(f.args)).resolves.toBe(content)
      expect(f.provider).not.toHaveBeenCalled()
      expect(f.writes()).toBe(1)
      expect(f.args.callbacks.log.mock.calls).toContainEqual(['第1章字数超过约定'])
    }
  })

  it.each(['zh-CN', 'en-US'] as const)('limits ordinary time judgments to draft precision while preserving conflict checks in %s', async language => {
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, writingLanguage: language } } })
    const predecessor = language === 'zh-CN'
      ? '正午，信使抵达。入夜后，他封好了包裹。'
      : 'At noon, the courier arrived. After nightfall, he sealed the parcel.'
    const broadReference = language === 'zh-CN'
      ? '他收起之前封好的包裹。'
      : 'He picked up the parcel he had sealed earlier.'
    const specificConflict = language === 'zh-CN'
      ? '他收起昨天封好的包裹，又说那是今早封好的。'
      : 'He picked up the parcel sealed yesterday, then said he had sealed it this morning.'
    for (const version of [1, 2]) for (const content of [broadReference, specificConflict]) {
      const f = setup([{ content: review, finishReason: 'stop' }], [], { ...source, version, content })
      f.args.context.writingLanguage = language
      const invoke = f.fixture.invoke.bind(f.fixture)
      vi.spyOn(f.fixture, 'invoke').mockImplementation(async (channel, ...args) => {
        const result = await invoke(channel, ...args)
        if (channel === 'review-revision:prepare') {
          const prepared = result as NonNullable<typeof f.fixture.prepared>
          prepared.context.predecessor = { draftId: 8, chapterNumber: 0, chapterTitle: '', content: predecessor,
            identity: { projectId: session.projectId, sourceId: 'candidate:8', revision: 1,
              contentHash: hash(predecessor), provenance: 'generated' } }
          prepared.context.frozenGoals = { chapterNumber: 1, coverage: 'complete',
            items: [{ id: 'ch1:keyEvents:1', text: 'Carry the parcel' }] }
          f.fixture.prepared = structuredClone(prepared)
        }
        return result
      })
      await f.command('review-chapter', {
        sourceDraft: { id: 1, chapterNumber: 1, version, status: 'draft', contentRevision: version },
      }).execute(f.args)
      const prompt = f.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
      expect(f.provider).toHaveBeenCalledOnce()
      expect(f.fixture.prepared!.context.recheck).toBeUndefined()
      expect(prompt).toContain(content)
      expect(prompt).toContain(predecessor)
      expect(prompt).toContain('ch1:keyEvents:1')
      expect(prompt).toContain('Carry the parcel')
      expect(prompt).toContain('goalReviews')
      expect(prompt).toContain('"summary"')
      expect(prompt).toContain('"items"')
      expect(prompt).toContain(language === 'zh-CN'
        ? '只核对正文实际表达的时间精度'
        : 'Check only the time precision actually expressed in the draft')
      expect(prompt).toContain(language === 'zh-CN'
        ? '顺序一致则不补推更精确的历史日期或时段'
        : 'if consistent, do not infer a more precise historical date or time period')
      expect(prompt).toContain(language === 'zh-CN'
        ? '明确日期、时段和相对时间须对照作者时点与前驱同一事件'
        : 'Check explicit dates, time periods and relative times against author timing and the same predecessor event')
      expect(prompt).toContain(language === 'zh-CN'
        ? '真实冲突报 error 或 warning：quote 定位当前正文的冲突句'
        : 'Report genuine conflicts as error or warning: quote the conflicting current-draft sentence')
      expect(prompt).toContain(language === 'zh-CN'
        ? '无法确定时保留不确定性'
        : 'Preserve uncertainty when it cannot be determined')
      expect(prompt).toContain(language === 'zh-CN'
        ? '全文未发现具体问题时，保留一条 pass'
        : 'If the whole draft has no specific issue, keep one pass item')
      expect(prompt).toContain(language === 'zh-CN'
        ? '不必逐项展开无问题内容的历史时点'
        : 'do not expand the historical timing of each problem-free detail')
      expect(prompt).not.toContain(language === 'zh-CN' ? '每个时间判断（包括 pass）' : 'For every temporal judgment (including pass)')
      expect(prompt).not.toContain(language === 'zh-CN' ? '【时间承接】' : '[Time continuity]')
      expect(prompt).toContain(language === 'zh-CN'
        ? '逐字连续、且全文仅出现一次的单一摘录'
        : 'one verbatim, contiguous excerpt that occurs exactly once in the draft under review')
      expect(f.fixture.materialDecisions[0]?.promptHash).toBe(hash(prompt))
    }
  })

  it.each(['zh-CN', 'en-US'] as const)('sends temporal checks and separated author constraints through all review consumers in %s', async language => {
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, writingLanguage: language } } })
    for (const operation of ['review-chapter', 'refine-from-review', 'recheck'] as const) {
      clearProjectCustomPrompts()
      const f = setup([{ content: operation === 'refine-from-review' ? revised : review, finishReason: 'stop' }])
      f.args.context.writingLanguage = language
      const original = f.fixture.invoke.bind(f.fixture)
      vi.spyOn(f.fixture, 'invoke').mockImplementation(async (channel, ...args) => {
        const result = await original(channel, ...args)
        if (channel === 'review-revision:prepare') {
          const prepared = result as NonNullable<typeof f.fixture.prepared>
          prepared.context.blueprints = [{ chapterNumber: 1, title: 'Current', keyEvents: '', characters: [],
            role: '', purpose: '', suspenseHook: '', notes: '', userGuidance: 'CURRENT_AUTHOR_TIME' },
          { chapterNumber: 2, title: 'Future', keyEvents: 'FUTURE_PLAN', characters: [],
            role: '', purpose: '', suspenseHook: '', notes: '', userGuidance: '' }]
          f.fixture.prepared = structuredClone(prepared)
        }
        return result
      })
      if (operation === 'review-chapter') {
        const builtin = getBuiltinPromptTemplate('consistency_check', language)!
        expect(builtin.systemSuffix).not.toContain(language === 'zh-CN' ? '未发现与前文矛盾' : 'No contradiction found')
        vi.spyOn(ipcPromptPersistence, 'loadProject').mockResolvedValue({ templates: [{ ...builtin, writingLanguage: language,
          content: 'PERSISTED_TEMPLATE\n{{chapter_content}}', systemSuffix: 'OLD_PASS_EXAMPLE' }], diagnostics: [] })
      }
      if (operation === 'recheck') {
        const selected = { draftPath: 'ai-novel://draft/1', draftContent: source.content, chapterNumber: 1,
          sourceDraft: { id: 1, chapterNumber: 1, version: 1, status: 'draft' as const, contentRevision: 1 } }
        f.fixture.selected = selected
        await new ReviewChapterCommand({ ...selected, reviewCycleId: 'cycle-1', expectedMergedHash: hash(source.content) }, f.dependencies).execute(f.args)
      } else await f.command(operation).execute(f.args)
      const prompt = f.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
      expect(prompt).toContain(operation === 'review-chapter'
        ? language === 'zh-CN' ? '按前章结尾同日紧接核对' : 'check a same-day continuation from the previous ending'
        : language === 'zh-CN' ? '【时间承接】' : '[Time continuity]')
      expect(prompt).toContain(language === 'zh-CN' ? '正文自身明确写出的跨日或时间间隔优先于同日默认' : 'An explicit day change or time gap in the manuscript takes priority over the same-day default')
      expect(prompt).toContain(language === 'zh-CN' ? '前面最近的明确时点' : 'nearest preceding explicit time')
      expect(prompt).toContain(language === 'zh-CN' ? 'AI 建议中的具体时点不构成来源依据' : 'A specific time proposed by AI is not source evidence')
      const author = reviewRevisionAuthorMaterial(f.fixture.prepared!.context)
      const boundary = language === 'zh-CN' ? '【后续蓝图/计划｜非既定历史】' : '[Future blueprints/plans | not established history]'
      expect(author.split(boundary)[0]).toContain('CURRENT_AUTHOR_TIME')
      expect(author.split(boundary)[0]).not.toContain('FUTURE_PLAN')
      expect(author.split(boundary)[1]).toContain('FUTURE_PLAN')
      expect(prompt).toContain(author)
      expect(f.fixture.materialDecisions[0]?.included.find(item => item.sourceId === 'author:required')?.contentHash).toBe(hash(author))
      if (operation === 'review-chapter') {
        expect(prompt).toContain('PERSISTED_TEMPLATE')
        expect(prompt).toContain(language === 'zh-CN' ? '【时间一致性检查】' : '[Temporal consistency checks]')
        expect(prompt).toContain(language === 'zh-CN' ? 'pass 简述实际核对的对象、来源与对照结果即可' : 'Briefly state the actual subject, source checked and comparison result for a pass')
      }
      if (operation === 'refine-from-review') expect(prompt).toContain(reviewRevisionAiBrief(f.fixture.prepared!.context))
      if (operation === 'recheck') expect(prompt).toContain(language === 'zh-CN' ? '不能判为 resolved' : 'must not be marked resolved')
      if (operation !== 'refine-from-review') expect(prompt).toContain(language === 'zh-CN' ? '单纯超出约定字数只作非阻断提示' : 'Exceeding the agreed length alone is a nonblocking notice')
      vi.restoreAllMocks()
    }
  })
  it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)('passes the complete required set beyond 24k to the actual %s request', async operation => {
    const f = setup([{ content: operation === 'review-chapter' ? review : revised, finishReason: 'stop' }])
    const setting = '独有作者事实。'.repeat(900)
    const predecessor = '前驱独有原文。'.repeat(320)
    let frozenBytes = ''
    const invoke = f.fixture.invoke.bind(f.fixture)
    vi.spyOn(f.fixture, 'invoke').mockImplementation(async (channel, ...args) => {
      const result = await invoke(channel, ...args)
      if (channel === 'review-revision:prepare') {
        const prepared = result as NonNullable<typeof f.fixture.prepared>
        prepared.context.config.worldSetting = setting
        prepared.context.predecessor = { draftId: 8, chapterNumber: 0, chapterTitle: '', content: predecessor,
          identity: { projectId: session.projectId, sourceId: 'candidate:8', revision: 1,
            contentHash: hash(predecessor), provenance: 'generated' } }
        frozenBytes = JSON.stringify(prepared.context)
        f.fixture.prepared = structuredClone(prepared)
      }
      return result
    })
    await f.command(operation).execute(f.args)
    expect(JSON.stringify(f.fixture.prepared!.context)).toBe(frozenBytes)
    const prompt = f.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
    const author = reviewRevisionAuthorMaterial(f.fixture.prepared!.context)
    expect(prompt).toContain(author)
    expect(prompt).toContain(predecessor)
    if (operation === 'refine-from-review') expect(prompt).toContain(reviewRevisionAiBrief(f.fixture.prepared!.context))
    expect(f.fixture.materialDecisions[0]?.capacity.admittedUnits).toBeGreaterThan(24_000)
    expect(f.fixture.materialDecisions[0]?.capacity.maxInputUnits).toBe(MATERIAL_DECISION_MAX_INPUT_UNITS)
    expect(f.fixture.materialDecisions[0]?.coverage.complete).toBe(true)
    expect(f.fixture.materialDecisions[0]?.promptHash).toBe(hash(prompt))
    expect(f.fixture.materialDecisions[0]?.included.find(item => item.sourceId === 'author:required')?.contentHash).toBe(hash(author))
    expect(f.fixture.materialDecisions[0]?.included.find(item => item.sourceId === 'candidate:8')?.contentHash).toBe(hash(predecessor))
  })

  it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)(
    'admits long author text once without changing the frozen %s sources', async operation => {
      const f = setup([{ content: operation === 'review-chapter' ? review : revised, finishReason: 'stop' }])
      const prefix = '登记日期仅为核查线索。'.repeat(100)
      const setting = prefix + '仓库独有作者规定。'.repeat(400)
      const invoke = f.fixture.invoke.bind(f.fixture)
      vi.spyOn(f.fixture, 'invoke').mockImplementation(async (channel, ...args) => {
        const result = await invoke(channel, ...args)
        if (channel === 'review-revision:prepare') {
          const prepared = result as NonNullable<typeof f.fixture.prepared>
          prepared.context.config.coreOutline = prefix
          prepared.context.config.worldSetting = setting
          prepared.context.worldbuilding = prefix
          f.fixture.prepared = structuredClone(prepared)
        }
        return result
      })
      await f.command(operation).execute(f.args)
      const frozen = f.fixture.prepared!.context
      expect(frozen.config.coreOutline).toBe(prefix)
      expect(frozen.config.worldSetting).toBe(setting)
      expect(frozen.worldbuilding).toBe(prefix)
      const author = reviewRevisionAuthorMaterial(frozen)
      expect(author.split(prefix)).toHaveLength(2)
      expect(author).toContain(setting)
      expect(author).toContain('"coreOutline"')
      expect(author).toContain('【世界观设定】')
      expect(f.provider).toHaveBeenCalledOnce()
      expect(f.fixture.materialDecisions[0]?.capacity.maxInputUnits).toBe(MATERIAL_DECISION_MAX_INPUT_UNITS)
      expect(f.fixture.materialDecisions[0]?.coverage.complete).toBe(true)
    },
  )

  it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)(
    'sends frozen author facts, goals and predecessor in the actual %s request', async operation => {
      const f = setup([{ content: operation === 'review-chapter' ? review : revised, finishReason: 'stop' }], [{
        draftId: 7, chapterNumber: 0, chapterTitle: '历史章', chapterNotes: '前驱已交出钥匙。', sourceStatus: 'current', facts: [],
      }])
      const invoke = f.fixture.invoke.bind(f.fixture)
      vi.spyOn(f.fixture, 'invoke').mockImplementation(async (channel, ...args) => {
        const result = await invoke(channel, ...args)
        if (channel === 'review-revision:prepare') {
          const prepared = result as NonNullable<typeof f.fixture.prepared>
          prepared.context.worldbuilding = '作者硬事实：钟楼没有地下室。'
          prepared.context.predecessor = { draftId: 8, chapterNumber: 0, chapterTitle: '', content: '已选保存前驱：角色仍未定稿。',
            identity: { projectId: session.projectId, sourceId: 'candidate:8', revision: 1,
              contentHash: hash('已选保存前驱：角色仍未定稿。'), provenance: 'generated' } }
          prepared.context.blueprints = [{ chapterNumber: 1, title: '开门', keyEvents: '本章必须交出印章', characters: [], role: '', purpose: '', suspenseHook: '', userGuidance: '', notes: '' }]
          if (prepared.context.confirmation) prepared.context.confirmation.snapshot = {
            ...prepared.context.confirmation.snapshot, items: [
              { category: '地点', severity: 'warning', description: '把钟楼改成地下室。', decision: 'apply', origin: 'ai' },
              { category: '作者要求', severity: 'warning', description: '保留钟楼场景。', decision: 'apply', origin: 'author' },
            ],
          }
          f.fixture.prepared = structuredClone(prepared)
        }
        return result
      })
      await f.command(operation).execute(f.args)
      const prompt = f.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
      expect(prompt).toContain('前驱已交出钥匙。')
      expect(prompt).toContain('已选保存前驱：角色仍未定稿。')
      expect(prompt).toContain('不覆盖作者设定')
      expect(prompt).toContain('作者硬事实：钟楼没有地下室。')
      expect(prompt).toContain('本章必须交出印章')
      expect(f.fixture.materialDecisions[0]?.included.map(item => item.sourceId)).toContain('author:required')
      if (operation === 'refine-from-review') {
        expect(prompt).toContain('选择 AI 意见只授权处理问题')
        expect(prompt).toContain('作者确认的额外指导')
        expect(prompt).toContain('[AI 意见] 把钟楼改成地下室。')
        expect(prompt).toContain('[作者亲写] 保留钟楼场景。')
        expect(f.fixture.materialDecisions[0]?.included.find(item => item.sourceId === 'review:confirmed:10')?.category).toBe('future-plan')
      }
    },
  )

  it.each(['zh-CN', 'en-US'] as const)('uses one default revision task contract with intact source partitions in %s', async writingLanguage => {
    const predecessor = '前驱原文：双方已交还印章。'
    const authorRequest = '作者明确要求：保留城门场景。'
    const f = setup([{ content: revised, finishReason: 'stop' }], [{
      draftId: 7, chapterNumber: 0, chapterTitle: '前章', chapterNotes: predecessor, sourceStatus: 'current', facts: [],
    }])
    useProjectStore.setState(state => ({ currentProject: { ...state.currentProject!,
      novelConfig: { ...state.currentProject!.novelConfig, writingLanguage } } }))
    f.args.context.writingLanguage = writingLanguage
    let frozenBytes = ''
    const invoke = f.fixture.invoke.bind(f.fixture)
    vi.spyOn(f.fixture, 'invoke').mockImplementation(async (channel, ...args) => {
      const result = await invoke(channel, ...args)
      if (channel === 'review-revision:prepare') {
        const prepared = result as NonNullable<typeof f.fixture.prepared>
        const snapshot = prepared.context.confirmation!.snapshot
        prepared.context.confirmation!.snapshot = { ...snapshot, items: [...snapshot.items,
          { category: '作者要求', severity: 'warning', description: authorRequest, decision: 'apply', origin: 'author' }] }
        frozenBytes = JSON.stringify(prepared.context)
        f.fixture.prepared = structuredClone(prepared)
      }
      return result
    })
    await f.command('refine-from-review').execute(f.args)
    const frozen = f.fixture.prepared!.context
    expect(JSON.stringify(frozen)).toBe(frozenBytes)
    const prompt = f.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
    const reportStart = writingLanguage === 'zh-CN' ? '\n【审稿报告】\n' : '\n[Confirmed review checklist]\n'
    const reportEnd = writingLanguage === 'zh-CN' ? '\n【待修稿内容】\n' : '\n[Source manuscript]\n'
    const [basis, rest] = prompt.split(reportStart)
    const report = rest!.split(reportEnd)[0]!
    const author = reviewRevisionAuthorMaterial(frozen)
    const ai = reviewRevisionAiBrief(frozen)
    expect(basis).toContain(author)
    expect(basis).toContain(predecessor)
    expect(basis).toContain(authorRequest)
    expect(report.trim()).toBe(ai)
    const messages = f.provider.mock.calls[0]![0].map(message => message.content).join('\n')
    expect(messages).not.toMatch(/精准修复|一条一条逐项解决|改得越少越好|Revise the chapter using only the confirmed|Resolve every confirmed item one by one|Prefer the smallest complete change/)
    const contractHeading = writingLanguage === 'zh-CN' ? '【完整修稿任务合同】' : '[Complete revision task contract]'
    expect(prompt.split(contractHeading)).toHaveLength(2)
    const contract = prompt.split(contractHeading)[1]!
    expect(contract).toContain(writingLanguage === 'zh-CN' ? '解决经来源核实后成立的问题' : 'Resolve the selected issues established by the sources')
    expect(contract).toContain('70%-130%')
    expect(contract).toContain(writingLanguage === 'zh-CN' ? '纯文本' : 'plain prose')
    expect(contract).toContain(writingLanguage === 'zh-CN' ? '段落之间保留一个空行' : 'one blank line between paragraphs')
    expect(prompt).toContain(writingLanguage === 'zh-CN'
      ? '确认 AI 意见只确定处理范围，不确认其事实判断或替换方案'
      : 'Confirming an AI finding selects the scope, not its factual claims or proposed replacement')
    expect(prompt).toContain(writingLanguage === 'zh-CN'
      ? '作者亲写的明确要求仍按作者指导执行'
      : 'Explicit author-written requests remain author guidance')
    expect(f.fixture.materialDecisions[0]).toMatchObject({ promptHash: hash(prompt), coverage: { complete: true },
      included: [expect.objectContaining({ sourceId: 'author:required', contentHash: hash(author) }),
        expect.objectContaining({ sourceId: 'finalized:7', contentHash: hash(predecessor) }),
        expect.objectContaining({ sourceId: 'review:confirmed:10', contentHash: hash(ai) })] })
    expect(f.provider).toHaveBeenCalledOnce()
  })

  it('resolves and consumes the project custom review-revision template and guidance', async () => {
    const f = setup([{ content: revised, finishReason: 'stop' }])
    const template = { ...getBuiltinPromptTemplate('refine_from_review', 'zh-CN')!,
      systemRole: 'CUSTOM_REVIEW_ROLE', taskGuidance: 'CUSTOM_AUTHOR_GUIDANCE',
      content: 'CUSTOM_REVIEW_TASK\n{{review_report}}\n{{draft_content}}\n{{global_guidance}}' }
    const load = vi.spyOn(ipcPromptPersistence, 'loadProject').mockResolvedValue({ templates: [template], diagnostics: [] })
    await f.command('refine-from-review').execute(f.args)
    expect(load).toHaveBeenCalledWith(session)
    expect(getPromptSource('refine_from_review', session)).toBe('project')
    const messages = f.provider.mock.calls[0]![0]
    expect(messages.find(message => message.role === 'system')!.content).toContain('CUSTOM_REVIEW_ROLE')
    const prompt = messages.find(message => message.role === 'user')!.content
    expect(prompt).toContain('CUSTOM_REVIEW_TASK')
    expect(prompt).toContain('CUSTOM_AUTHOR_GUIDANCE')
    expect(prompt).toContain(source.content)
    expect(prompt).toContain(reviewRevisionAiBrief(f.fixture.prepared!.context))
    expect(prompt).toContain(reviewRevisionAuthorMaterial(f.fixture.prepared!.context))
    expect(prompt).toContain('【完整修稿任务合同】')
    expect(f.fixture.materialDecisions[0]?.promptHash).toBe(hash(prompt))
    expect(f.fixture.selections[0]).toMatchObject({ parentRootActionId: 'fixture-review-root' })
    expect(f.provider).toHaveBeenCalledOnce()
  })

  it('stops before requesting a model when frozen author facts exceed the 8MiB material safety bound', async () => {
    const f = setup([])
    const invoke = f.fixture.invoke.bind(f.fixture)
    vi.spyOn(f.fixture, 'invoke').mockImplementation(async (channel, ...args) => {
      const result = await invoke(channel, ...args)
      if (channel === 'review-revision:prepare') {
        const prepared = result as NonNullable<typeof f.fixture.prepared>
        prepared.context.worldbuilding = 'A'.repeat(MATERIAL_DECISION_MAX_INPUT_UNITS + 1)
        f.fixture.prepared = structuredClone(prepared)
      }
      return result
    })
    await expect(f.command('refine-from-review').execute(f.args)).rejects.toThrow('必需材料超出上下文容量')
    expect(f.provider).not.toHaveBeenCalled()
  })
  it.each(['review-chapter', 'refine-draft', 'refine-from-review'] as const)(
    'binds %s admission to the exact initial user message before the first provider request',
    async operation => {
      const f = setup([{ content: operation === 'review-chapter' ? review : revised, finishReason: 'stop' }])
      const stage = operation === 'review-chapter' ? 'review' : 'refinement'
      f.args.context.writingSkills = { [stage]: { stage, skillId: 'user:causality', source: 'user',
        name: 'Causality', content: 'FROZEN_SKILL_SENTINEL', writingLanguage: 'zh-CN', utf8Bytes: 21 } }
      await f.command(operation).execute(f.args)

      const userPrompt = f.provider.mock.calls[0]?.[0].find(message => message.role === 'user')?.content ?? ''
      expect(userPrompt).not.toBe('')
      expect(userPrompt.match(/FROZEN_SKILL_SENTINEL/g)).toHaveLength(1)
      expect(f.providerBindCounts[0]).toBe(1)
      expect(f.fixture.materialDecisions).toHaveLength(1)
      expect(f.fixture.materialDecisions[0]?.promptHash).toBe(hash(userPrompt))
      expect(f.fixture.materialDecisions[0]?.coverage.complete).toBe(true)
      if (operation === 'refine-from-review') {
        // The material authority is the persisted human-confirmation row (10), not its original AI review (9).
        expect(f.fixture.materialDecisions[0]?.included.map(item => item.sourceId)).toEqual(['author:required', 'review:confirmed:10'])
        expect(f.fixture.materialDecisions[0]?.included.map(item => item.revision)).toEqual([1, 10])
      } else {
        expect(f.fixture.materialDecisions[0]?.included.map(item => item.sourceId)).toEqual(['author:required'])
        expect(f.fixture.materialDecisions[0]?.capacity.admittedUnits).toBeGreaterThan(0)
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
    expect(prompt).toContain('【作者设定优先】【作者确认项目配置】与【世界观设定】是权威事实；作者角色状态按标注时点理解；历史派生摘要不能覆盖作者事实。')
    expect(prompt).toContain('即使蓝图、章节计划或冻结目标写法相反，也不得因此放过。')
    expect(prompt).toContain('在 description 中逐个简述子动作要求、前章同一事件的终态、本章动作与实际后果')
    expect(prompt).toContain('明确要求回顾或维持状态时，不另造动作或代价')
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
    expect(prompt).toContain('[Author settings take priority] The author-confirmed project configuration and the worldbuilding settings are authoritative facts; author character states apply at their annotated time; historical derived summaries cannot override author facts.')
    expect(prompt).toContain('even when a blueprint, chapter plan or frozen goal says otherwise.')
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

  it('defaults to the main-proved review model and forwards its root and only confirmed decisions', async () => {
    const f = setup([{ content: revised, finishReason: 'stop' }])
    await f.command('refine-from-review').execute(f.args)
    expect(f.fixture.selections[0]).toMatchObject({ parentRootActionId: 'fixture-review-root' })
    expect(f.dependencies.createRuntime.mock.calls[0]![0]).toMatchObject({ modelId: 'model-a' })
    const prompt = f.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
    expect(prompt).toContain('已选择的意见')
    expect(prompt).toContain('作者确认的额外指导')
    expect(prompt).not.toContain('已忽略的意见')
    expect(prompt).not.toContain('未确认的临时指导')
    expect(prompt).toContain('冻结源稿共 240 个正文单位')
    expect(prompt).toContain('168-312 个正文单位（源稿的 70%-130%），其中上限仅作指导')
    expect(prompt).toContain('所有未受影响的段落或行必须完整保留')
    expect(prompt).toContain('不得摘要、节选、合并重复段落或使用占位符')
    expect(f.fixture.materialDecisions[0]?.promptHash).toBe(hash(prompt))
  })

  it('renders the complete-revision contract in English and rejects a zero-unit source before dispatch', async () => {
    useProjectStore.setState({ currentProject: { id: session.projectId, path: projectPath, name: 'Synthetic', sessionLease: session.leaseId,
      novelConfig: { wordsPerChapter: 300, globalGuidance: 'frozen guidance', writingLanguage: 'en-US' } } as never })
    const english = setup([{ content: revised, finishReason: 'stop' }], [], {
      ...source, content: 'The courier crossed the bridge. '.repeat(183) + 'He delivered the parcel.',
    })
    english.args.context.writingLanguage = 'en-US'
    english.args.context.uiLocale = 'en-US'
    await english.command('refine-from-review').execute(english.args)
    const prompt = english.provider.mock.calls[0]![0].find(message => message.role === 'user')!.content
    expect(prompt).toContain('[Complete revision task contract]')
    expect(prompt).toContain('The frozen source contains 919 prose units')
    expect(prompt).toContain('Aim for 643-1195 prose units (70%-130% of the source)')
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

  it('keeps an unknown review unsaved, then uses one explicit request to review again and zero requests to reopen', async () => {
    const f = setup([{ content: '', finishReason: 'unknown' }, { content: review, finishReason: 'stop' }])
    const command = f.command('review-chapter')
    await expect(command.execute(f.args)).rejects.toThrow()
    expect(f.provider).toHaveBeenCalledOnce()
    expect(f.writes()).toBe(0)
    expect(f.fixture.recovery?.saved).toBeUndefined()
    await expect(f.backend('db:draft-get-full')).resolves.toEqual(source)
    await command.execute(f.args)
    expect(f.provider).toHaveBeenCalledTimes(2)
    expect(f.writes()).toBe(1)
    await command.execute(f.args)
    expect(f.provider).toHaveBeenCalledTimes(2)
    expect(f.writes()).toBe(1)
    expect(f.args.callbacks.setProgress.mock.calls.flat()).not.toContain(10)
    expect(f.args.callbacks.setProgress.mock.calls.flat()).not.toContain(90)
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
    for (const [messages] of f.provider.mock.calls) expect(messages.find(message => message.role === 'user')!.content).toContain('单纯超出约定字数只作非阻断提示')
    expect(f.fixture.materialDecisions).toHaveLength(2)
    expect(f.fixture.materialDecisions[1]).toEqual(f.fixture.materialDecisions[0])
    expect(f.fixture.calls.some(c => c.channel === 'generation:compose-visible')).toBe(false)
    expect(f.writes()).toBe(1)
  })

  it('persists malformed one-time recheck output as unknown without a replacement model call', async () => {
    const historySentinel = 'RECHECK_FROZEN_PREDECESSOR_EVIDENCE'
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
    expect(prompt).toContain(historySentinel)
    expect(prompt).not.toContain('证据锚点硬约束')
    expect(prompt).not.toContain('[Strict evidence-anchor constraint]')
    expect(f.fixture.materialDecisions[0]?.included.map(item => item.sourceId)).toEqual(['author:required', 'finalized:7'])
    expect(f.fixture.materialDecisions[0]?.capacity.admittedUnits).toBeGreaterThan(0)
    expect(prompt).toContain('核对改法是否与上述作者事实、前驱及本章目标冲突')
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

  it.each(['refine-draft', 'refine-from-review'] as const)(
    'does not turn the first-run integrity rejection of a stop revision into a saved revision when %s resumes', async operation => {
      // Long enough and different from the source, but the same long paragraph appears twice.
      const paragraph = '修订后的长段落逐字重复。'.repeat(12)
      const duplicated = `${paragraph}\n\n${paragraph}`
      const f = setup([{ content: duplicated, finishReason: 'stop' }])
      await expect(f.command(operation).execute(f.args)).rejects.toThrow('明显重复段落')
      expect(f.fixture.recovery!.composition!.text).toBe(duplicated)
      expect(f.fixture.recovery!.lastCompositionFinishReason).toBe('stop')
      const handle = f.fixture.recovery!.handle
      f.provider.mockClear()

      await expect(f.command(operation, { recoveryHandle: handle }).execute(f.args)).rejects.toThrow('明显重复段落')

      expect(f.provider).not.toHaveBeenCalled()
      expect(f.fixture.calls.filter(call => call.channel === 'review-revision:commit-revision')).toHaveLength(0)
      expect(f.fixture.recovery!.saved).toBeUndefined()
      expect(f.writes()).toBe(0)
    },
  )

  it('still saves a resumed stop composition that passes the same integrity check', async () => {
    const f = setup([{ content: revised, finishReason: 'stop' }])
    f.failSaves(1)
    await expect(f.command('refine-draft').execute(f.args)).rejects.toThrow('synthetic storage failed')
    const handle = f.fixture.recovery!.handle
    f.provider.mockClear()

    await f.command('refine-draft', { recoveryHandle: handle }).execute(f.args)

    expect(f.provider).not.toHaveBeenCalled()
    expect(f.writes()).toBe(1)
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
