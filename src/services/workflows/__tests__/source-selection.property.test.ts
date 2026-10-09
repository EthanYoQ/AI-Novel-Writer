import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { selectChapterSources, type MaterialCandidate } from '../source-selection'
import type { SourceRef } from '../../../shared/source-ref'

/**
 * 属性测试：手工 fixture 只能覆盖想到的组合，这里让 fast-check 在
 * 类别 / 来源真实性 / 必需性 / 容量 / 重复内容的组合空间里找反例。
 */
const CATEGORIES = ['author', 'finalized-history', 'future-plan', 'derived-locator', 'reference'] as const
const PROVENANCES = ['author', 'finalized', 'generated', 'derived', 'legacy', 'unknown'] as const
const current = { projectId: '项目', epoch: '会话' }

/** 非空且无空白的文本，让字节长度等于可预测的 UTF-8 宽度。 */
const text = fc.string({ minLength: 1, maxLength: 8 }).map(value => value.replace(/\s/gu, '')).filter(value => value.length > 0)
const spec = fc.record({
  category: fc.constantFrom(...CATEGORIES),
  provenance: fc.constantFrom(...PROVENANCES),
  required: fc.boolean(),
  text,
  hashSeed: fc.integer({ min: 0, max: 3 }),
  locatorOnly: fc.boolean(),
  staleLocator: fc.boolean(),
  plotTree: fc.boolean(),
  // 受限的 ID 池与版本池：故意制造重复来源、同内容不同版本这些并列情形，
  // 否则比较器是否全序根本测不到。
  idSeed: fc.integer({ min: 0, max: 2 }),
  revision: fc.integer({ min: 0, max: 2 }),
  recovered: fc.array(text, { maxLength: 2 }),
})
const environment = fc.record({
  specs: fc.array(spec, { maxLength: 6 }),
  maxInputUnits: fc.integer({ min: 0, max: 40 }),
})

const unitOf = (text: string) => new TextEncoder().encode(text).length

function build(specs: readonly (typeof spec extends fc.Arbitrary<infer T> ? T : never)[], prefix: string) {
  const candidates: MaterialCandidate[] = specs.map((entry, index) => {
    const ref: SourceRef = { ...current, sourceId: `${entry.plotTree ? 'plot-tree:' : ''}${prefix}:${entry.idSeed}`,
      revision: entry.revision, contentHash: String(entry.hashSeed).repeat(64).slice(0, 64) }
    // 文本带下标，让「某条材料有没有被用上」可以按文本精确断言；
    // 内容哈希仍由 hashSeed 决定，重复内容的路径照样会被走到。
    return { ref, category: entry.category, provenance: entry.provenance, required: entry.required,
      text: `${entry.text}@${index}`, locatorOnly: entry.locatorOnly, staleLocator: entry.staleLocator,
      ...(entry.recovered.length ? { recoveredProse: entry.recovered.map((item, at) => `${item}@${index}:${at}`) } : {}) }
  })
  return candidates
}

describe('S10A selection properties', () => {
  it('keeps decision and required coverage consistent in both directions', () => {
    fc.assert(fc.property(environment, ({ specs, maxInputUnits }) => {
      const candidates = build(specs, 's')
      const required = candidates.filter(item => item.required)
      const requiredIds = new Set(required.map(item => item.ref.sourceId))
      const result = selectChapterSources({ current, capacity: { maxInputUnits, methodVersion: 'utf8-bytes-v1' },
        relevanceTerms: [], candidates })

      // 失败决策绝不能自称覆盖完整，反之亦然。这条在两边都会真正触发。
      expect(result.coverage.complete).toBe(result.decision === 'ready')
      expect(result.coverage.included).toBeLessThanOrEqual(result.coverage.required)

      if (result.decision === 'ready') {
        // ready 意味着每个必需来源的内容都真的进了上下文。
        for (const candidate of required) {
          expect(result.included.some(item => item.ref.contentHash === candidate.ref.contentHash)).toBe(true)
        }
      } else {
        // 失败时必须说清缺口：要么给出无法继续的来源，要么列出未覆盖的必需范围。
        if (result.decision === 'split-required') {
          expect(result.remainingRequired.length).toBeGreaterThan(0)
          for (const id of result.remainingRequired) expect(requiredIds.has(id)).toBe(true)
        } else {
          expect(result.blockingSourceId.length).toBeGreaterThan(0)
        }
      }
    }), { numRuns: 400 })
  })

  it('never turns an unusable source into material', () => {
    fc.assert(fc.property(environment, ({ specs, maxInputUnits }) => {
      const candidates = build(specs, 's')
      const result = selectChapterSources({ current, capacity: { maxInputUnits, methodVersion: 'utf8-bytes-v1' },
        relevanceTerms: [], candidates })
      const omitted = new Map<string, Set<string>>()
      for (const omission of result.omissions) {
        const reasons = omitted.get(omission.sourceId) ?? new Set<string>()
        reasons.add(omission.reason)
        omitted.set(omission.sourceId, reasons)
      }
      const includedTexts = new Set(result.decision === 'ready' ? result.included.map(item => item.text) : [])

      for (const candidate of candidates) {
        const reasons = omitted.get(candidate.ref.sourceId)
        // 来源本身不可用的候选必须留下可解释的拒绝记录；前缀规则先于来源真实性判定，
        // 所以剧情树按剧情树记录，其余未知来源按 unknown 记录。
        if (candidate.ref.sourceId.includes('plot-tree:')) {
          expect(reasons?.has('plot-tree-not-manuscript')).toBe(true)
        } else if (candidate.provenance === 'unknown') {
          expect(reasons?.has('unknown-provenance')).toBe(true)
        }
        // 只可定位的来源不能把自己的陈述送进正文；stale 定位同理，只能回读原文。
        if (candidate.locatorOnly && !candidate.staleLocator) expect(includedTexts.has(candidate.text)).toBe(false)
        if (candidate.staleLocator) expect(includedTexts.has(candidate.text)).toBe(false)
      }
    }), { numRuns: 400 })
  })

  it('never exceeds the declared capacity', () => {
    fc.assert(fc.property(environment, ({ specs, maxInputUnits }) => {
      const result = selectChapterSources({ current, capacity: { maxInputUnits, methodVersion: 'utf8-bytes-v1' },
        relevanceTerms: [], candidates: build(specs, 's') })
      if (result.decision !== 'ready') return
      const total = result.included.reduce((sum, item) => sum + unitOf(item.text), 0)
      expect(total).toBeLessThanOrEqual(maxInputUnits)
    }), { numRuns: 400 })
  })

  it('is deterministic under input permutation', () => {
    fc.assert(fc.property(environment, ({ specs, maxInputUnits }) => {
      const candidates = build(specs, 's')
      const input = { current, capacity: { maxInputUnits, methodVersion: 'utf8-bytes-v1' }, relevanceTerms: [] as string[] }
      const forward = selectChapterSources({ ...input, candidates })
      const backward = selectChapterSources({ ...input, candidates: [...candidates].reverse() })
      expect(JSON.stringify(backward)).toBe(JSON.stringify(forward))
    }), { numRuns: 400 })
  })

  it('never lets two different sources with the same content both contribute', () => {
    fc.assert(fc.property(environment, ({ specs, maxInputUnits }) => {
      const result = selectChapterSources({ current, capacity: { maxInputUnits, methodVersion: 'utf8-bytes-v1' },
        relevanceTerms: [], candidates: build(specs, 's') })
      if (result.decision !== 'ready') return
      const owners = new Map<string, Set<string>>()
      for (const item of result.included) {
        const ids = owners.get(item.ref.contentHash) ?? new Set<string>()
        ids.add(item.ref.sourceId)
        owners.set(item.ref.contentHash, ids)
      }
      // 同一份不可变内容只能有一个来源贡献材料；同一个来源拆成多段是允许的。
      for (const ids of owners.values()) expect(ids.size).toBe(1)
    }), { numRuns: 400 })
  })

  it('reports the decisions in a closed set and keeps coverage consistent', () => {
    fc.assert(fc.property(environment, ({ specs, maxInputUnits }) => {
      const result = selectChapterSources({ current, capacity: { maxInputUnits, methodVersion: 'utf8-bytes-v1' },
        relevanceTerms: [], candidates: build(specs, 's') })
      expect(['ready', 'split-required', 'capacity-conflict']).toContain(result.decision)
      expect(result.coverage.included).toBeLessThanOrEqual(result.coverage.required)
      expect(result.coverage.complete).toBe(result.coverage.included === result.coverage.required)
    }), { numRuns: 400 })
  })
})

/**
 * 只守一条不变量：阻断原因必须来自候选真正受阻的那条记录，而不是信息性省略。
 * record/block 一旦被后来的改动用错，单元与其余属性测试都抓不到，只有这条能。
 */
describe('S10A obstruction labelling', () => {
  const candidate = (sourceId: string, seed: string, value: Partial<MaterialCandidate> & { text: string }): MaterialCandidate => ({
    ref: { ...current, sourceId, revision: 1, contentHash: seed.repeat(64).slice(0, 64) },
    category: 'author', provenance: 'author', required: true, ...value,
  })

  it('never labels a stale locator that has recovered prose as an unusable source', () => {
    fc.assert(fc.property(fc.record({
      proseUnits: fc.integer({ min: 1, max: 6 }),
      plainUnits: fc.integer({ min: 1, max: 6 }),
      maxInputUnits: fc.integer({ min: 0, max: 24 }),
    }), ({ proseUnits, plainUnits, maxInputUnits }) => {
      const stale = candidate('stale', 's', { category: 'derived-locator', provenance: 'derived',
        staleLocator: true, text: '旧摘要陈述', recoveredProse: ['回读原文'.repeat(proseUnits)] })
      const plain = candidate('plain', 'p', { text: '丙'.repeat(plainUnits) })
      const result = selectChapterSources({ current, capacity: { maxInputUnits, methodVersion: 'utf8-bytes-v1' },
        relevanceTerms: [], candidates: [stale, plain] })

      if (result.decision !== 'capacity-conflict') return
      // 这条 stale 定位始终带可回读原文，因此它永远是可用的：只可能是装不下。
      if (result.blockingSourceId === 'stale') expect(result.blockingReason).toBe('budget')
    }), { numRuns: 300 })
  })
})
