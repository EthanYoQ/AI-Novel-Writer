import { vi } from 'vitest'
import type { ModelProfile, ProjectData } from '../../../../shared/ipc-channels'
import type { ReviewCycleProjection, ReviewFindingStatus } from '../../../../shared/review-cycle'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'

export const PROJECT_PATH = 'C:\\novels\\chapter-view'
export const SESSION = Object.freeze({ projectId: 'chapter-view', leaseId: 'chapter-view-lease', projectPath: PROJECT_PATH })

export const BLUEPRINT: ChapterBlueprint = {
  chapterNumber: 3,
  title: '雨夜车站',
  role: '发展',
  purpose: '让林舟确认匿名信不是恶作剧。',
  keyEvents: '最后一班列车晚点；第三节车厢的门开了。',
  characters: ['林舟', '老周'],
  suspenseHook: '',
  userGuidance: '前半章只写声音。',
  notes: '',
  notesUpdatedAt: '',
}

export const ORIGINAL = [
  '雨从傍晚开始就没有停过。',
  '最后一班列车晚点了十七分钟。广播里的女声重复着同一句道歉。',
  '他第三次展开信纸。',
  '他想起母亲说过，这座车站在三十年前就该拆了。',
].join('\n\n')

export const REVISED = [
  '雨从傍晚开始就没有停过。',
  '最后一班列车晚点了十七分钟，广播里的道歉一遍遍落进空站台。',
  '他第三次展开信纸。',
  '他想起旧报纸上说过，这座车站在三十年前就该拆了。',
].join('\n\n')

export const AI_REVIEW = JSON.stringify({
  summary: '节奏偏慢，有一处前后矛盾。',
  items: [
    { category: '前后矛盾', severity: 'error', description: '第 2 章写明母亲在他出生前离开。', quote: '他想起母亲说过，这座车站在三十年前就该拆了。' },
    { category: '节奏', severity: 'warning', description: '晚点与道歉两句信息重叠。' },
    { category: '本章必现', severity: 'unknown', description: '「不要回头」的伏笔是否回收，由你决定。' },
    { category: '措辞', severity: 'pass', description: '语言自然。' },
  ],
})

type Status = 'draft' | 'revised' | 'finalized' | 'archived'

interface Draft { id: number; chapterNumber: number; version: number; status: Status; content: string; createdAt: string; updatedAt: string }
interface Review { id: number; baseDraftId: number; reviewIndex: number; content: string; source: Draft; createdAt: string }
interface Revision {
  id: number; baseDraftId: number; revisionIndex: number; revisionType: 'refine' | 'review-fix'; status: 'pending' | 'merged' | 'discarded'
  content: string; source: Draft | null; createdAt: string; updatedAt: string
}

/**
 * 一章的假数据库：草稿、审稿、修稿、复验周期与后处理，按主进程的通道语义回答。
 * 测试改它的状态来摆出各个阶段，再读 calls 里的写入断言界面交给了主进程什么。
 */
export function createChapterBackend() {
  const state = {
    drafts: [] as Draft[],
    reviews: [] as Review[],
    revisions: [] as Revision[],
    cycles: new Map<number, ReviewCycleProjection>(),
    postProcess: null as null | { steps: { stepKey: string; label: string; ok: boolean; errorMsg?: string; attemptCount?: number }[] },
    nextId: 100,
    mergeDisposition: 'required' as 'required' | 'not-required',
    incompleteDeletions: [] as unknown[],
    calls: [] as { channel: string; args: unknown[] }[],
    clock: 0,
  }
  /** 和主进程 datetime('now') 同样写法的时间，每次写入往后走一秒，先后可比。 */
  const now = () => {
    state.clock += 1
    return `2026-10-13 21:${String(Math.floor(state.clock / 60)).padStart(2, '0')}:${String(state.clock % 60).padStart(2, '0')}`
  }
  const meta = (draft: Draft) => ({
    id: draft.id, chapterNumber: draft.chapterNumber, version: draft.version, status: draft.status, source: 'write',
    wordCount: draft.content.length, createdAt: draft.createdAt, updatedAt: draft.updatedAt,
  })
  const source = (draft: Draft) => ({ id: draft.id, chapterNumber: draft.chapterNumber, version: draft.version, status: draft.status, content: draft.content })
  const revisionMeta = (revision: Revision) => ({ id: revision.id, baseDraftId: revision.baseDraftId, revisionIndex: revision.revisionIndex, revisionType: revision.revisionType,
    status: revision.status, mergedToDraftId: null, userPrompt: '', reviewSourceId: null, contentId: revision.id, wordCount: 0, createdAt: revision.createdAt, updatedAt: revision.updatedAt })
  const byId = (id: unknown) => state.drafts.find(draft => draft.id === Number(id))

  const invoke = vi.fn(async (channel: string, ...args: unknown[]): Promise<unknown> => {
    state.calls.push({ channel, args })
    switch (channel) {
      case 'db:blueprint-get-all': return [BLUEPRINT]
      case 'db:blueprint-get': return Number(args[0]) === BLUEPRINT.chapterNumber ? BLUEPRINT : null
      case 'db:draft-get-meta': { const draft = byId(args[0]); return draft ? meta(draft) : null }
      case 'db:draft-list': return state.drafts.filter(draft => draft.chapterNumber === Number(args[0])).map(meta)
      case 'db:draft-list-all': return state.drafts.map(meta)
      case 'db:draft-get-full': { const draft = byId(args[0]); return draft ? { ...meta(draft), content: draft.content } : null }
      case 'db:draft-update-content': {
        const draft = byId(args[0])
        if (draft) Object.assign(draft, { content: String(args[1]), updatedAt: now() })
        return { success: Boolean(draft) }
      }
      case 'db:draft-delete': {
        state.drafts = state.drafts.filter(draft => draft.id !== Number(args[0]))
        return { success: true }
      }
      case 'db:review-list': return state.reviews.filter(review => review.baseDraftId === Number(args[0])).map(review => ({ id: review.id, baseDraftId: review.baseDraftId, reviewIndex: review.reviewIndex, contentId: review.id, createdAt: review.createdAt }))
      case 'db:review-get-latest':
      case 'db:review-get-full': {
        const review = channel === 'db:review-get-full'
          ? state.reviews.find(candidate => candidate.id === Number(args[0]))
          : state.reviews.filter(candidate => candidate.baseDraftId === Number(args[0])).at(-1)
        return review ? { id: review.id, baseDraftId: review.baseDraftId, reviewIndex: review.reviewIndex, contentId: review.id, createdAt: review.createdAt, content: review.content, sourceDraft: source(review.source) } : null
      }
      case 'db:review-cycle-get': return state.cycles.get(Number(args[0])) ?? null
      case 'db:review-next-index': return state.reviews.filter(review => review.baseDraftId === Number(args[0])).length + 1
      case 'db:review-create': {
        const request = args[0] as { baseDraftId: number; reviewIndex: number; content: string }
        const draft = byId(request.baseDraftId)!
        const id = ++state.nextId
        state.reviews.push({ id, baseDraftId: request.baseDraftId, reviewIndex: request.reviewIndex, content: request.content, source: { ...draft }, createdAt: now() })
        return { success: true, id, reviewIndex: request.reviewIndex }
      }
      case 'db:revision-list':
      case 'db:revision-get-pending': return state.revisions.filter(revision => revision.baseDraftId === Number(args[0]) && (channel === 'db:revision-list' || revision.status === 'pending'))
        .map(revisionMeta)
      case 'db:revision-get-full': {
        const revision = state.revisions.find(candidate => candidate.id === Number(args[0]))
        return revision ? { ...revisionMeta(revision), content: revision.content, sourceDraft: revision.source && source(revision.source) } : null
      }
      case 'db:revision-mark-discarded': {
        const revision = state.revisions.find(candidate => candidate.id === Number(args[0]) && candidate.status === 'pending')
        if (revision) Object.assign(revision, { status: 'discarded', updatedAt: now() })
        return { success: Boolean(revision) }
      }
      case 'db:revision-merge': {
        const request = args[0] as { revisionId: number; targetDraftId: number; mergedContent: string }
        const draft = byId(request.targetDraftId)!
        const revision = state.revisions.find(candidate => candidate.id === request.revisionId)!
        const mergedAt = now()
        Object.assign(draft, { content: request.mergedContent, status: 'revised', updatedAt: mergedAt })
        Object.assign(revision, { status: 'merged', updatedAt: mergedAt })
        // 只有按审稿意见修出的稿属于复验周期；直接修稿合并不动周期，也不复验。
        const reviewFix = revision.revisionType === 'review-fix'
        if (reviewFix) setCycle(revision.baseDraftId, 'merge-committed')
        return { success: true, receipt: {
          revisionId: revision.id, targetDraftId: draft.id, status: 'revised', wordCount: request.mergedContent.length, idempotent: false,
          chapterNumber: draft.chapterNumber, version: draft.version,
          ...(reviewFix ? { reviewCycle: { cycleId: 'cycle-1', mergedHash: 'b'.repeat(64), disposition: state.mergeDisposition } } : {}),
        } }
      }
      case 'db:post-process-get-latest-run': return state.postProcess ? { id: 'run-1', sourceLabel: '第3章定稿', createdAt: '', updatedAt: '', allCriticalPassed: false } : null
      case 'db:post-process-get-steps': return state.postProcess?.steps.map(step => ({ critical: false, completedAt: step.ok ? '2026-10-13 22:00:00' : '', ...step })) ?? []
      case 'db:consistency-exemption-list': return []
      case 'chapter:list-incomplete-deletions': return { success: true, operations: state.incompleteDeletions }
      case 'chapter:retry-deletion': {
        state.incompleteDeletions = []
        return { success: true }
      }
      case 'db:character-get-all': return [{ id: 1 }]
      case 'db:draft-authority-sequence': return { status: 'continuous', lastChapterNumber: 2, nextChapterNumber: 3, duplicateChapterNumbers: [], authorityFingerprint: 'e'.repeat(64) }
      case 'db:draft-get-finalized': return { chapterNumber: Number(args[0]) }
      case 'db:draft-get-max-finalized-chapter': return Math.max(0, ...state.drafts.filter(draft => draft.status === 'finalized').map(draft => draft.chapterNumber))
      case 'db:continuity-list-before': return []
      case 'fs:read-json': return { success: false }
      case 'fs:write-json': return { success: true }
      default: throw new Error(`unexpected IPC ${channel}`)
    }
  })

  const install = () => Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
  })

  const addDraft = (fields: Partial<Draft> & Pick<Draft, 'status'>): Draft => {
    const draft: Draft = { id: ++state.nextId, chapterNumber: 3, version: 1, content: ORIGINAL, createdAt: '2026-10-13 20:00:00', updatedAt: '2026-10-13 20:00:00', ...fields }
    state.drafts.push(draft)
    return draft
  }
  /** 和主进程一样：AI 审稿开一个复验周期，修稿生成后为 generated，合并提交后为 merge-committed。 */
  function setCycle(draftId: number, revisionStatus: ReviewCycleProjection['revisionStatus']) {
    const review = state.reviews.find(candidate => candidate.baseDraftId === draftId && state.cycles.has(candidate.id))
    if (review) state.cycles.set(review.id, { ...state.cycles.get(review.id)!, revisionStatus })
  }
  const addReview = (draft: Draft, content = AI_REVIEW): Review => {
    const review: Review = { id: ++state.nextId, baseDraftId: draft.id, reviewIndex: state.reviews.filter(candidate => candidate.baseDraftId === draft.id).length + 1, content, source: { ...draft }, createdAt: now() }
    state.reviews.push(review)
    state.cycles.set(review.id, { cycleId: `cycle-${review.id}`, reviewId: review.id, revisionStatus: 'not-generated', recheckCount: 0, findings: [] })
    return review
  }
  /**
   * 和主进程一样：合并后的自动复验另存一份审稿（每项带 findingId，没有自己的复验周期），
   * 逐项结果写回原审稿的周期，周期记为已复验。
   */
  const addRecheck = (draft: Draft, review: Review, statuses: ReviewFindingStatus[]): Review => {
    state.cycles.set(review.id, { ...state.cycles.get(review.id)!, revisionStatus: 'merge-committed', recheckCount: 1, recheckDisposition: 'completed',
      findings: statuses.map((status, index) => ({ findingId: `finding-${index}`, reviewItemIndex: index, category: '', kind: 'literary' as const, status })) })
    const content = JSON.stringify({ summary: '', items: statuses.map((_, index) => ({ category: '', severity: 'unknown', findingId: `finding-${index}`,
      targetId: null, description: '复核未提供唯一且可验证的新证据。' })) })
    const recheck: Review = { id: ++state.nextId, baseDraftId: draft.id, reviewIndex: state.reviews.filter(candidate => candidate.baseDraftId === draft.id).length + 1,
      content, source: { ...draft }, createdAt: now() }
    state.reviews.push(recheck)
    return recheck
  }
  const addRevision = (draft: Draft, revisionType: Revision['revisionType'] = 'review-fix'): Revision => {
    const createdAt = now()
    const revision: Revision = { id: ++state.nextId, baseDraftId: draft.id, revisionIndex: state.revisions.filter(candidate => candidate.baseDraftId === draft.id).length + 1,
      revisionType, status: 'pending', content: REVISED, source: { ...draft }, createdAt, updatedAt: createdAt }
    state.revisions.push(revision)
    if (revisionType === 'review-fix') setCycle(draft.id, 'generated')
    return revision
  }
  const writes = (channel: string) => state.calls.filter(call => call.channel === channel).map(call => call.args)

  return { state, invoke, install, addDraft, addReview, addRecheck, addRevision, writes }
}

export function chapterProject(): ProjectData {
  return {
    id: SESSION.projectId,
    sessionLease: SESSION.leaseId,
    name: '雨夜列车',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑', subGenre: '', targetAudience: '成人', totalChapters: 24, wordsPerChapter: 3000,
      plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '雨夜列车', worldSetting: '',
      goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

export function generationModel(id: string): ModelProfile {
  return {
    id, name: id.toUpperCase(), provider: 'custom', protocol: 'openai', modelName: id, apiKey: 'test-only-key',
    baseUrl: 'https://models.example/v1', temperature: 0.7, maxTokens: 4096, purposes: ['generation'],
  }
}
