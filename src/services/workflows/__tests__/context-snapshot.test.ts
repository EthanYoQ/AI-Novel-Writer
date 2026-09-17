import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildChapterContextSnapshot, CONTEXT_ESTIMATOR_VERSION } from '../context-snapshot'
import { selectChapterSources, type MaterialCandidate, type SourceOmission, type SourceSelection } from '../source-selection'
import type { SourceRef } from '../../../shared/source-ref'
import { s10aFixture } from './fixtures/s10a-chapter-sources.fixture'

afterEach(() => vi.unstubAllGlobals())

const ref = (sourceId: string, seed = sourceId): SourceRef => ({
  projectId: '项目', epoch: '会话', sourceId, revision: 1, contentHash: seed.repeat(64).slice(0, 64),
})
const candidate = (sourceId: string, text: string, seed?: string): MaterialCandidate =>
  ({ ref: ref(sourceId, seed), category: 'author', provenance: 'author', required: true, text })
const current = { projectId: '项目', epoch: '会话' }
const capacity = { maxInputUnits: 10_000, methodVersion: CONTEXT_ESTIMATOR_VERSION }

function readySelection(candidates: MaterialCandidate[]): Extract<SourceSelection, { decision: 'ready' }> {
  const selection = selectChapterSources({ current, candidates, capacity, relevanceTerms: [] })
  if (selection.decision !== 'ready') throw new Error('fixture must be ready')
  return selection
}
async function snapshotOf(candidates: MaterialCandidate[]) {
  return buildChapterContextSnapshot({ current, selection: readySelection(candidates) })
}

describe('S10A deterministic context snapshot', () => {
  it('is byte-identical for identical frozen input and skips the session epoch in the hash', async () => {
    const first = await snapshotOf([candidate('a:1', '甲'), candidate('b:2', '乙')])
    const second = await snapshotOf([candidate('b:2', '乙'), candidate('a:1', '甲')])
    expect(second.hash).toBe(first.hash)
    expect(second.id).toBe(first.id)
    expect(second.hash).toMatch(/^[a-f0-9]{64}$/u)
    expect(second.estimate.methodVersion).toBe(CONTEXT_ESTIMATOR_VERSION)
  })

  it('maps categories to the existing S01 slots without inventing new ones', async () => {
    const snapshot = await snapshotOf([candidate('a:1', '甲')])
    expect(snapshot.sources.map(source => source.slot)).toEqual(['author-constraint'])
    expect(snapshot.sources[0].ref.span).toBeUndefined()
  })

  it('carries omissions through with their required flag', async () => {
    const selection = readySelection([{ ref: ref('plot-tree:x'), category: 'reference', provenance: 'derived',
      required: false, text: '剧情树' }])
    const snapshot = await buildChapterContextSnapshot({ current, selection })
    expect(snapshot.omissions).toEqual([{ sourceId: 'plot-tree:x', reason: 'plot-tree-not-manuscript', required: false }])
  })

  it('counts estimate units as UTF-8 bytes of the included material', async () => {
    const snapshot = await snapshotOf([candidate('a:1', '甲')])
    expect(snapshot.estimate.inputUnits).toBe(3)
  })

  it('emits no model request and replays the frozen fixture identically', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const fixture = s10aFixture()
    const selection = selectChapterSources({ current: fixture.current, capacity: fixture.capacity,
      relevanceTerms: [], candidates: fixture.materials })
    if (selection.decision !== 'ready') throw new Error(`fixture must be ready, got ${selection.decision}`)
    const first = await buildChapterContextSnapshot({ current: fixture.current, selection })
    const second = await buildChapterContextSnapshot({ current: fixture.current, selection })

    expect(first).toEqual(second)
    // 纳入顺序必须稳定，否则重放会漂移；省略项也要随快照一起解释。
    expect(first.sources.map(source => source.ref.sourceId))
      .toEqual([...first.sources.map(source => source.ref.sourceId)].sort())
    expect(first.omissions.length).toBeGreaterThan(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('S10A snapshot fingerprint', () => {
  /** 手工构造一个 ready 选择，用来单独改变正文或省略清单。 */
  const readyWith = (text: string, omissions: SourceOmission[] = []) => ({
    decision: 'ready' as const,
    included: [{ ref: ref('a:1'), category: 'author' as const, text, required: true, reason: 'author material' }],
    omissions,
    coverage: { required: 1, included: 1, complete: true },
  })

  it('commits the fingerprint to the material text, not only to the refs', async () => {
    const first = await buildChapterContextSnapshot({ current, selection: readyWith('甲') })
    const second = await buildChapterContextSnapshot({ current, selection: readyWith('乙') })
    expect(second.hash).not.toBe(first.hash)
  })

  it('commits the fingerprint to the omission decision', async () => {
    const first = await buildChapterContextSnapshot({ current, selection: readyWith('甲') })
    const second = await buildChapterContextSnapshot({ current, selection: readyWith('甲', [
      { sourceId: 'plot-tree:x', reason: 'plot-tree-not-manuscript', category: 'reference', required: false },
    ]) })
    expect(second.hash).not.toBe(first.hash)
  })

  it('slots recovered finalized prose as a finalized fact, not unconfirmed continuity', async () => {
    const selection = selectChapterSources({ current, capacity,
      relevanceTerms: [], candidates: [{ ref: ref('summary:1'), category: 'derived-locator', provenance: 'derived',
        required: false, staleLocator: true, text: '旧摘要陈述', recoveredProse: ['定稿原文片段'] }] })
    if (selection.decision !== 'ready') throw new Error('fixture must be ready')
    const snapshot = await buildChapterContextSnapshot({ current, selection })
    expect(snapshot.sources).toEqual([{ ref: expect.objectContaining({ sourceId: 'summary:1' }),
      slot: 'finalized-fact', reason: expect.stringContaining('derived-locator:') }])
  })
})
