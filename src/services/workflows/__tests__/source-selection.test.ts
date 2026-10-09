import { describe, expect, it } from 'vitest'

import { selectChapterSources, type MaterialCandidate, type SourceSelection } from '../source-selection'
import type { SourceRef } from '../../../shared/source-ref'
import { s10aFixture } from './fixtures/s10a-chapter-sources.fixture'

const hash = (seed: string) => seed.repeat(64).slice(0, 64)
function ref(sourceId: string, contentHash = hash('a')): SourceRef {
  return { projectId: '项目', epoch: '会话', sourceId, revision: 1, contentHash }
}
function material(over: Partial<MaterialCandidate> & { ref: SourceRef }): MaterialCandidate {
  return { category: 'author', provenance: 'author', required: false, text: '保留作者事实', ...over }
}
const capacity = { maxInputUnits: 1000, methodVersion: 'utf8-bytes-v1' }
const current = { projectId: '项目', epoch: '会话' }
/** Narrows the decision union after asserting it, so variant fields stay typed. */
function expectDecision<S extends SourceSelection['decision']>(
  result: SourceSelection, decision: S,
): Extract<SourceSelection, { decision: S }> {
  expect(result.decision).toBe(decision)
  return result as Extract<SourceSelection, { decision: S }>
}

describe('S10A source selection contract', () => {
  it('never launders an unknown-provenance source into author material', () => {
    const result = selectChapterSources({ current, capacity, relevanceTerms: [],
      candidates: [material({ ref: ref('characters:unknown'), provenance: 'unknown', required: true, text: '来路不明的角色卡' })] })
    const conflict = expectDecision(result, 'capacity-conflict')
    expect(conflict.blockingSourceId).toBe('characters:unknown')
    expect(conflict.blockingReason).toBe('unknown-provenance')
    expect(conflict.omissions).toContainEqual(expect.objectContaining({ sourceId: 'characters:unknown', reason: 'unknown-provenance',
      category: 'author', required: true }))
  })

  it('keeps a stale locator usable only to read back the immutable prose', () => {
    const result = selectChapterSources({ current, capacity, relevanceTerms: [],
      candidates: [material({ ref: ref('summary:1'), category: 'derived-locator', provenance: 'derived', required: false,
        staleLocator: true, text: '旧摘要陈述', recoveredProse: ['定稿原文片段'] })] })
    const ready = expectDecision(result, 'ready')
    expect(ready.included.map(item => item.text)).toEqual(['定稿原文片段'])
    expect(ready.omissions).toContainEqual(expect.objectContaining({ sourceId: 'summary:1', reason: 'locator-statement-not-evidence',
      category: 'derived-locator', required: false }))
  })

  it('never admits the plot tree as manuscript material', () => {
    const result = selectChapterSources({ current, capacity, relevanceTerms: [],
      candidates: [material({ ref: ref('plot-tree:snapshot'), category: 'reference', provenance: 'derived', text: '剧情树' })] })
    const ready = expectDecision(result, 'ready')
    expect(ready.included).toHaveLength(0)
    expect(ready.omissions[0]).toMatchObject({ reason: 'plot-tree-not-manuscript', required: false })
  })

  it('reports a split instead of dropping required material', () => {
    const result = selectChapterSources({ current, relevanceTerms: [],
      capacity: { maxInputUnits: 40, methodVersion: 'utf8-bytes-v1' },
      candidates: [
        material({ ref: ref('finalized:1', hash('b')), category: 'finalized-history', provenance: 'finalized', required: true, text: '甲'.repeat(10) }),
        material({ ref: ref('finalized:2', hash('c')), category: 'finalized-history', provenance: 'finalized', required: true, text: '乙'.repeat(10) })] })
    const split = expectDecision(result, 'split-required')
    expect(split.coverage).toEqual({ required: 2, included: 1, complete: false })
    expect(split.remainingRequired).toEqual(['finalized:2'])
  })

  it('reports a capacity conflict when a single required source cannot fit', () => {
    const result = selectChapterSources({ current, relevanceTerms: [],
      capacity: { maxInputUnits: 4, methodVersion: 'utf8-bytes-v1' },
      candidates: [material({ ref: ref('finalized:1'), category: 'finalized-history', provenance: 'finalized', required: true, text: '甲'.repeat(10) })] })
    const conflict = expectDecision(result, 'capacity-conflict')
    expect(conflict.blockingSourceId).toBe('finalized:1')
    expect(conflict.blockingReason).toBe('budget')
  })

  it('admits only author-selected drafts or the saved direct predecessor', () => {
    const candidate = {
      source: { projectId: '项目', epoch: '会话', artifactId: '草稿1', revision: 1, state: 'draft' as const,
        saved: true, batchLineage: '批次', fingerprint: {} as never },
      admission: { projectId: '项目', epoch: '会话', batchLineage: '批次' },
    }
    const result = selectChapterSources({ current, capacity, relevanceTerms: [],
      candidates: [material({ ref: ref('draft:1'), category: 'finalized-history', provenance: 'author', text: '未采纳草稿', candidate })] })
    const ready = expectDecision(result, 'ready')
    expect(ready.included).toHaveLength(0)
    expect(ready.omissions[0]).toMatchObject({ reason: 'candidate-not-admitted' })
  })

  it('orders optional material by chapter relevance before source id', () => {
    const result = selectChapterSources({ current, relevanceTerms: ['海港'],
      capacity: { maxInputUnits: 20, methodVersion: 'utf8-bytes-v1' },
      candidates: [
        material({ ref: ref('a:1', hash('b')), text: '无关材料' }),
        material({ ref: ref('z:1', hash('c')), text: '海港相关材料' })] })
    const ready = expectDecision(result, 'ready')
    expect(ready.included.map(item => item.ref.sourceId)).toEqual(['z:1'])
    expect(ready.omissions).toContainEqual(expect.objectContaining({ sourceId: 'a:1', reason: 'budget', category: 'author', required: false }))
  })

  it('produces the same selection for the same frozen input regardless of input order', () => {
    const materials = [material({ ref: ref('a:1', hash('b')), text: '甲' }),
      material({ ref: ref('a:2', hash('c')), text: '乙', required: true })]
    const first = selectChapterSources({ current, capacity, relevanceTerms: [], candidates: materials })
    const second = selectChapterSources({ current, capacity, relevanceTerms: [], candidates: [...materials].reverse() })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})

describe('S10A frozen fixture fault matrix', () => {
  const run = (capacityOverride?: { maxInputUnits: number; methodVersion: string }) => {
    const fixture = s10aFixture()
    return selectChapterSources({ current: fixture.current, capacity: capacityOverride ?? fixture.capacity,
      relevanceTerms: [], candidates: fixture.materials })
  }

  it('separates same-chapter drafts, replaced sources and future secrets', () => {
    const ready = expectDecision(run(), 'ready')
    const ids = ready.included.map(item => item.ref.sourceId)
    expect(ids).toContain('finalized:1')
    expect(ids).toContain('candidate:selected')
    expect(ids).not.toContain('candidate:unselected')
    expect(ids).not.toContain('candidate:replaced')
    expect(ids).not.toContain('future:secret-7')
    expect(ready.coverage).toEqual({ required: 2, included: 2, complete: true })
    expect(ready.omissions.filter(item => item.reason === 'candidate-not-admitted').map(item => item.sourceId))
      .toEqual(['candidate:replaced', 'candidate:unselected'])
  })

  it('admits a saved direct predecessor from the same frozen batch lineage', () => {
    const ready = expectDecision(run(), 'ready')
    const predecessor = ready.included.find(item => item.ref.sourceId === 'candidate:predecessor')
    expect(predecessor).toMatchObject({ category: 'finalized-history', required: false })
  })

  it('keeps one copy when two locators cite the same immutable content', () => {
    const ready = expectDecision(run(), 'ready')
    const ids = ready.included.map(item => item.ref.sourceId)
    expect(ids).toContain('finalized:1')
    expect(ids).not.toContain('finalized:1-mirror')
    expect(ready.omissions).toContainEqual(expect.objectContaining({ sourceId: 'finalized:1-mirror', reason: 'duplicate-content',
      category: 'finalized-history', required: false }))
  })

  it('replays identically for the same frozen input', () => {
    const fixture = s10aFixture()
    const first = selectChapterSources({ current: fixture.current, capacity: fixture.capacity,
      relevanceTerms: [], candidates: fixture.materials })
    const second = selectChapterSources({ current: fixture.current, capacity: fixture.capacity,
      relevanceTerms: [], candidates: [...fixture.materials].reverse() })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('reports a capacity conflict for an indispensable long setting that cannot fit', () => {
    const conflict = expectDecision(run({ maxInputUnits: 8, methodVersion: 'utf8-bytes-v1' }), 'capacity-conflict')
    expect(conflict.blockingSourceId).toBe('finalized:1')
    expect(conflict.blockingReason).toBe('budget')
    expect(conflict.coverage.complete).toBe(false)
  })
})

describe('S10A ordering does not depend on locale or input order', () => {
  const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const select = (candidates: MaterialCandidate[]) =>
    selectChapterSources({ current, capacity, relevanceTerms: [], candidates })

  it('orders non-ASCII identifiers by code unit, not by locale collation', () => {
    const ids = ['人物:阿', '人物:波', '人物:测']
    const byId = new Map(ids.map((id, index) => [id, index]))
    // 事实必须绑定到来源本身，不能绑定到数组下标，否则换序就等于换了材料。
    const candidatesOf = (order: readonly string[]) => order.map(id =>
      material({ ref: ref(id, hash(String(byId.get(id)))), text: `t${byId.get(id)}` }))
    const forward = select(candidatesOf(ids))
    const backward = select(candidatesOf([...ids].reverse()))
    // 同一组输入换序必须得到同一个结果，且顺序是码元升序。
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward))
    expect(expectDecision(forward, 'ready').included.map(item => item.ref.sourceId))
      .toEqual([...ids].sort(codeUnit))
  })

  it('stays deterministic when identifiers are collation-equivalent', () => {
    const composed = 'é'
    const decomposed = 'é'
    // 记录触发条件：localeCompare 会把这两个不同字符串判成相等，因而它不是全序。
    expect(composed.localeCompare(decomposed)).toBe(0)
    const a = material({ ref: ref(`x:${composed}`, hash('b')), text: '甲', required: true })
    const b = material({ ref: ref(`x:${decomposed}`, hash('c')), text: '乙' })
    expect(JSON.stringify(select([b, a]))).toBe(JSON.stringify(select([a, b])))
  })

  it('stays deterministic when two records differ only in fields the sort must still order', () => {
    // 同 ID、同内容哈希，只差 locatorOnly：比较器若只看前几个字段就会退回输入顺序，
    // 这条曾经能让决策在 ready 与 capacity-conflict 之间翻转。
    const a = material({ ref: ref('dup', hash('b')), text: '甲', required: true, locatorOnly: true })
    const b = material({ ref: ref('dup', hash('b')), text: '甲', required: true })
    expect(JSON.stringify(select([b, a]))).toBe(JSON.stringify(select([a, b])))

    // 同 ID、同内容，只差 revision：revision 参与快照哈希，因此也必须是排序键。
    const c = material({ ref: { ...ref('dup', hash('b')), revision: 1 }, text: '甲' })
    const d = material({ ref: { ...ref('dup', hash('b')), revision: 2 }, text: '甲' })
    expect(JSON.stringify(select([d, c]))).toBe(JSON.stringify(select([c, d])))
  })

  it('lets a required source with no material of its own be satisfied by a sibling of the same content', () => {
    // 需求顺序不应决定结果：必需来源自己产不出材料，但同内容的可选来源进得来。
    const coverer = material({ ref: ref('a:1', hash('b')), text: '定稿原文' })
    const requiredLocator = material({ ref: ref('a:2', hash('b')), category: 'derived-locator', provenance: 'derived',
      required: true, locatorOnly: true, text: '只可定位' })
    const ready = expectDecision(select([coverer, requiredLocator]), 'ready')
    expect(ready.coverage).toEqual({ required: 1, included: 1, complete: true })
    expect(ready.included.map(item => item.text)).toEqual(['定稿原文'])
  })

  it('attributes the blocking reason to the source that actually blocked when an id repeats', () => {
    const fits = material({ ref: ref('a:0', hash('9')), text: '甲', required: true })
    // 同一 sourceId 的另一个 revision：一个装不下，一个来源不可用。
    const budgetBlocked = material({ ref: { ...ref('s', hash('b')), revision: 1 }, text: '乙乙乙', required: true })
    const unusable = material({ ref: { ...ref('s', hash('c')), revision: 2 }, provenance: 'unknown',
      text: '来路不明', required: true })
    const result = selectChapterSources({ current, capacity: { maxInputUnits: 6, methodVersion: 'utf8-bytes-v1' },
      relevanceTerms: [], candidates: [fits, budgetBlocked, unusable] })

    // 真正阻断的是「装不下」那个候选，不是同 ID 的另一个 revision，所以应当可拆分。
    const split = expectDecision(result, 'split-required')
    expect(split.remainingRequired).toEqual(['s', 's'])
    expect(split.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 's', reason: 'budget', category: 'author', required: true }),
      expect.objectContaining({ sourceId: 's', reason: 'unknown-provenance', category: 'author', required: true }),
    ]))
  })

  it('keeps the blocker reason when a shared identity is rejected by an earlier rule', () => {
    const fits = material({ ref: ref('a:0', hash('9')), text: '甲', required: true })
    // 同一条源修订被引用了两次，一条来源未知、一条来源正常。前者先被前置规则拒绝，
    // 后者进入容量判定；阻断原因必须取自前者自己，而不是后者。
    const rejected = material({ ref: { ...ref('s', hash('b')), revision: 1 }, provenance: 'unknown',
      text: '甲甲甲', required: true })
    const admitted = material({ ref: { ...ref('s', hash('b')), revision: 1 }, category: 'derived-locator',
      text: '甲甲甲', required: true })
    const result = selectChapterSources({ current, capacity: { maxInputUnits: 6, methodVersion: 'utf8-bytes-v1' },
      relevanceTerms: [], candidates: [fits, rejected, admitted] })

    const conflict = expectDecision(result, 'capacity-conflict')
    expect(conflict.blockingSourceId).toBe('s')
    expect(conflict.blockingReason).toBe('unknown-provenance')
  })

  it('reports a split when the shared identity is only capacity-blocked', () => {
    const fits = material({ ref: ref('a:0', hash('9')), text: '甲', required: true })
    const first = material({ ref: { ...ref('s', hash('b')), revision: 1 }, text: '甲甲甲', required: true })
    const duplicate = material({ ref: { ...ref('s', hash('b')), revision: 1 }, category: 'derived-locator',
      text: '甲甲甲', required: true })
    const result = selectChapterSources({ current, capacity: { maxInputUnits: 6, methodVersion: 'utf8-bytes-v1' },
      relevanceTerms: [], candidates: [fits, first, duplicate] })

    const split = expectDecision(result, 'split-required')
    expect(split.remainingRequired).toEqual(['s', 's'])
    expect(split.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 's', reason: 'budget', category: 'author', required: true }),
      expect.objectContaining({ sourceId: 's', reason: 'duplicate-source-ref', category: 'derived-locator', required: true }),
    ]))
  })

  it('reports a split, not a hard conflict, when a stale locator only fails on capacity', () => {
    const fits = material({ ref: ref('a:0', hash('9')), text: '甲甲', required: true })
    const stale = material({ ref: ref('st', hash('b')), category: 'derived-locator', provenance: 'derived',
      required: true, staleLocator: true, text: '旧摘要陈述', recoveredProse: ['定稿原文'.repeat(20)] })
    const result = selectChapterSources({ current, capacity: { maxInputUnits: 9, methodVersion: 'utf8-bytes-v1' },
      relevanceTerms: [], candidates: [fits, stale] })

    // 该来源本身可用（能回读原文），只是装不下：应当可拆分，不是「来源不可用」的硬冲突。
    const split = expectDecision(result, 'split-required')
    expect(split.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'st', reason: 'locator-statement-not-evidence', category: 'derived-locator', required: true }),
      expect.objectContaining({ sourceId: 'st', reason: 'budget', category: 'derived-locator', required: true }),
    ]))
  })

  it('still blocks on a required source that is unusable and has no sibling', () => {
    const orphan = material({ ref: ref('a:9', hash('d')), category: 'derived-locator', provenance: 'derived',
      required: true, locatorOnly: true, text: '只可定位' })
    const conflict = expectDecision(select([orphan]), 'capacity-conflict')
    expect(conflict.blockingSourceId).toBe('a:9')
    expect(conflict.blockingReason).toBe('locator-statement-not-evidence')
  })

  it('records exactly one omission for a stale locator whose content is already covered', () => {
    const plain = material({ ref: ref('a:1', hash('b')), text: '定稿原文' })
    const stale = material({ ref: ref('a:2', hash('b')), category: 'derived-locator', provenance: 'derived',
      staleLocator: true, text: '旧摘要陈述' })
    const ready = expectDecision(select([plain, stale]), 'ready')
    expect(ready.omissions).toEqual([expect.objectContaining({ sourceId: 'a:2', reason: 'duplicate-content',
      category: 'derived-locator', required: false })])
  })
})
