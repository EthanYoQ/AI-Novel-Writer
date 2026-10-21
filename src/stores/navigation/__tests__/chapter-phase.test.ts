import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { refreshChapterFacts } from '../chapter-facts'
import type { DraftMeta } from '../../../services/draft-index'
import { chapterPhase, deriveChapters, deriveStages, focusChapter, landingStage, type ChapterFacts, type WorkFacts } from '../stage-progress'
import { useStageStore } from '../stage-store'

interface FakeRevision { id: number; status: 'pending' | 'merged' | 'discarded'; updatedAt: string; sourceContent: string | null }
interface FakeReview { id: number; reviewIndex: number; createdAt: string; cycle: string | null }

const db = vi.hoisted(() => ({
  draft: { id: 7, chapterNumber: 3, version: 1, status: 'draft', content: '雨从傍晚开始就没有停过。' },
  revisions: [] as FakeRevision[],
  reviews: [] as FakeReview[],
  /** 下一次读修稿列表先按当时的记录取好，等它放行才返回。 */
  hold: null as Promise<void> | null,
}))

vi.mock('../../../services/ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: async (_session: unknown, channel: string, id: number) => {
      switch (channel) {
        case 'db:revision-list': {
          const listed = db.revisions.map(({ id, status, updatedAt }) => ({ id, status, updatedAt }))
          const hold = db.hold
          db.hold = null
          await hold
          return listed
        }
        case 'db:review-list': return db.reviews.map(({ id, reviewIndex, createdAt }) => ({ id, reviewIndex, createdAt }))
        case 'db:review-get-full': return { id, content: '{"summary":"","items":[]}' }
        case 'db:review-cycle-get': {
          const cycle = db.reviews.find(review => review.id === id)?.cycle
          return cycle ? { revisionStatus: cycle } : null
        }
        case 'db:draft-get-full': return db.draft
        case 'db:revision-get-full': {
          const revision = db.revisions.find(candidate => candidate.id === id)!
          return { id, sourceDraft: revision.sourceContent === null ? null : { ...db.draft, content: revision.sourceContent } }
        }
        default: throw new Error(`unexpected IPC ${channel}`)
      }
    },
  },
}))

const SESSION = { projectId: 'p', leaseId: 'lease', projectPath: 'C:\\novels\\p' }

/** 按数据库里的记录读出这一稿的 facts，再按稿状态判断它走到哪一步，与流程脊、单章视图同一条路径。 */
async function phaseOf(status: 'draft' | 'reviewed' | 'revised') {
  db.draft.status = status
  await refreshChapterFacts([{ id: db.draft.id }], SESSION)
  const facts = useStageStore.getState().chapterFacts?.byDraft[db.draft.id]
  return { phase: chapterPhase(status, facts), facts }
}

beforeEach(() => {
  setActiveProjectSessionContext(SESSION)
  db.draft.content = '雨从傍晚开始就没有停过。'
  db.revisions = []
  db.reviews = []
  db.hold = null
})

afterEach(() => {
  setActiveProjectSessionContext(null)
  useStageStore.setState({ chapterFacts: null })
})

describe('一稿走到哪一步（chapter-facts 读记录，chapterPhase 判断）', () => {
  it('记录还没读完：草稿与库里的 reviewed 都按草稿，已修稿按已修稿，定稿按定稿', () => {
    expect((['draft', 'reviewed', 'revised', 'finalized'] as const).map(status => chapterPhase(status, undefined)))
      .toEqual(['draft', 'draft', 'revised', 'final'])
  })

  it('只有审稿记录：已审稿；库里的 reviewed 状态没有审稿记录时仍是草稿', async () => {
    expect((await phaseOf('reviewed')).phase).toBe('draft')
    db.reviews = [{ id: 1, reviewIndex: 1, createdAt: '2026-10-13 20:00:01', cycle: 'not-generated' }]
    expect((await phaseOf('draft')).phase).toBe('reviewed')
  })

  it('修稿生成后正文又改过：修稿过期，不占主流程，停在已审稿；源稿没变时停在合并', async () => {
    db.reviews = [{ id: 1, reviewIndex: 1, createdAt: '2026-10-13 20:00:01', cycle: 'generated' }]
    db.revisions = [{ id: 9, status: 'pending', updatedAt: '2026-10-13 20:00:02', sourceContent: db.draft.content }]
    expect(await phaseOf('draft')).toMatchObject({ phase: 'merge', facts: { mergeable: [9], stale: [] } })

    db.draft.content = '雨从傍晚开始就没有停过。作者后来补的一句。'
    expect(await phaseOf('draft')).toMatchObject({ phase: 'reviewed', facts: { mergeable: [], stale: [{ id: 9, reason: 'edited' }] } })
  })

  it('旧修稿没有记下生成时的源稿：同样过期，原因是 unsourced', async () => {
    db.revisions = [{ id: 9, status: 'pending', updatedAt: '2026-10-13 20:00:02', sourceContent: null }]
    expect(await phaseOf('draft')).toMatchObject({ phase: 'draft', facts: { mergeable: [], stale: [{ id: 9, reason: 'unsourced' }] } })
  })

  it('审稿后直接修稿并合并：合并前的审稿不算，已修稿', async () => {
    db.reviews = [{ id: 1, reviewIndex: 1, createdAt: '2026-10-13 20:00:01', cycle: 'not-generated' }]
    db.revisions = [{ id: 9, status: 'merged', updatedAt: '2026-10-13 20:00:05', sourceContent: db.draft.content }]
    expect(await phaseOf('revised')).toMatchObject({ phase: 'revised', facts: { lastMergedAt: '2026-10-13 20:00:05' } })
  })

  it('合并后再审稿：回到已审稿（待修稿）；这次的修稿也合并后再回到已修稿', async () => {
    db.reviews = [
      { id: 1, reviewIndex: 1, createdAt: '2026-10-13 20:00:01', cycle: 'merge-committed' },
      { id: 2, reviewIndex: 2, createdAt: '2026-10-13 20:00:09', cycle: 'not-generated' },
    ]
    db.revisions = [{ id: 9, status: 'merged', updatedAt: '2026-10-13 20:00:05', sourceContent: db.draft.content }]
    expect((await phaseOf('revised')).phase).toBe('reviewed')

    db.reviews[1].cycle = 'merge-committed'
    db.revisions.push({ id: 10, status: 'merged', updatedAt: '2026-10-13 20:00:12', sourceContent: db.draft.content })
    expect((await phaseOf('revised')).phase).toBe('revised')
  })

  it('合并与审稿落在同一秒：按合并在后，已修稿', async () => {
    db.reviews = [{ id: 1, reviewIndex: 1, createdAt: '2026-10-13 20:00:05', cycle: 'not-generated' }]
    db.revisions = [{ id: 9, status: 'merged', updatedAt: '2026-10-13 20:00:05', sourceContent: db.draft.content }]
    expect((await phaseOf('revised')).phase).toBe('revised')
  })

  it('同一稿先发的读取晚回来：不盖掉后发读取的结果', async () => {
    db.revisions = [{ id: 9, status: 'pending', updatedAt: '2026-10-13 20:00:02', sourceContent: db.draft.content }]
    let release = () => {}
    db.hold = new Promise<void>(resolve => { release = resolve })
    const older = refreshChapterFacts([{ id: db.draft.id }], SESSION)

    db.revisions[0].status = 'merged'
    await refreshChapterFacts([{ id: db.draft.id }], SESSION)
    release()
    await older
    expect(useStageStore.getState().chapterFacts?.byDraft[db.draft.id]).toMatchObject({ mergeable: [], lastMergedAt: '2026-10-13 20:00:02' })
  })

  it('合并后的自动复验没有复验周期：不算重新审稿', async () => {
    db.reviews = [{ id: 1, reviewIndex: 1, createdAt: '2026-10-13 20:00:09', cycle: null }]
    db.revisions = [{ id: 9, status: 'merged', updatedAt: '2026-10-13 20:00:05', sourceContent: db.draft.content }]
    const facts: ChapterFacts | undefined = (await phaseOf('revised')).facts
    expect([chapterPhase('revised', facts), facts?.latestReview]).toEqual(['revised', { createdAt: '2026-10-13 20:00:09', cycleStatus: null }])
  })
})

describe('打开作品的落点不等审稿与修稿记录：落到哪个阶段、哪一章、正文进度只看章是否待写或定稿', () => {
  const draft = (id: number, chapterNumber: number, status: DraftMeta['status']): DraftMeta => ({ id, chapterNumber, version: 1, status,
    createdAt: '2026-10-13 20:00:00', updatedAt: '2026-10-13 20:00:00', source: 'write', filePath: `ai-novel://draft/${id}`, fileName: 'draft_v1.md' })
  const reviewed: ChapterFacts = { mergeable: [], stale: [], latestReview: { createdAt: '2026-10-13 20:00:01', cycleStatus: 'not-generated' }, lastMergedAt: null }
  const merge: ChapterFacts = { ...reviewed, mergeable: [21] }
  const work = {
    config: { coreOutline: '旧港', genre: '悬疑', targetAudience: '成年读者', totalChapters: 6, wordsPerChapter: 3000 },
    architecture: { premise: true, characters: true, worldbuilding: true, synopsis: true },
    blueprints: [1, 2, 3, 4, 5, 6].map(chapterNumber => ({ chapterNumber, title: `第${chapterNumber}章` })),
    drafts: { 1: [draft(11, 1, 'finalized')], 2: [draft(12, 2, 'reviewed')], 3: [draft(13, 3, 'revised')], 4: [draft(14, 4, 'draft')] },
    runningChapters: new Set<number>(),
  }

  it('有无记录，都落在最后一章在写的第 4 章，正文进度都是 1/6', () => {
    const open = (chapterFacts?: Record<number, ChapterFacts>) => {
      const chapters = deriveChapters({ ...work, chapterFacts })
      const stages = deriveStages({ ...work, chapterFacts }, chapters)
      return { landing: landingStage(stages), manuscript: stages.at(-1), focus: focusChapter(chapters)?.number }
    }
    const landed = { landing: 'manuscript', focus: 4, manuscript: { stage: 'manuscript', finalized: 1, total: 6, progress: { state: 'active', ratio: 1 / 6 } } }
    expect(open()).toEqual(landed)
    expect(open({ 12: reviewed, 13: reviewed, 14: merge })).toEqual(landed)
  })

  it('一章有定稿、之后又新建了一份空草稿：仍算写过；没有蓝图、大纲没写完也落在这一章的正文', () => {
    const emptyAfterFinal = [draft(11, 1, 'finalized'), { ...draft(12, 1, 'draft'), version: 2, wordCount: 0 }]
    const open = (drafts: WorkFacts['drafts']) => {
      const facts = { ...work, architecture: { ...work.architecture, synopsis: false }, blueprints: [], drafts }
      const chapters = deriveChapters(facts)
      const stages = deriveStages(facts, chapters)
      return { landing: landingStage(stages), focus: focusChapter(chapters)?.number, manuscript: stages.at(-1)?.progress }
    }
    expect(open({ 1: emptyAfterFinal })).toEqual({ landing: 'manuscript', focus: 1, manuscript: { state: 'active', ratio: 0 } })
    // 几章都在写时落在最后一章在写的：定稿后新建空草稿的章也算在写。
    expect(open({ 1: [draft(15, 1, 'draft')], 2: emptyAfterFinal.map(meta => ({ ...meta, chapterNumber: 2 })) }).focus).toBe(2)
  })
})
