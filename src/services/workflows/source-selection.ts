import type { CandidateAdmission, CandidateSource, ProjectEpoch, SourceRef } from '../../shared/source-ref'
import { mayUseCandidate, sameProjectEpoch } from '../../shared/source-ref'

/** 材料类别按来源性质区分，不建立第二份可写事实库。 */
export type MaterialCategory = 'author' | 'finalized-history' | 'future-plan' | 'derived-locator' | 'reference'
export type MaterialProvenance = 'author' | 'finalized' | 'generated' | 'derived' | 'legacy' | 'unknown'

export interface MaterialCandidate {
  ref: SourceRef
  category: MaterialCategory
  provenance: MaterialProvenance
  /** 必需材料装不下时返回容量冲突，绝不静默裁掉。 */
  required: boolean
  text: string
  /** 角色来源身份；未知来源不得被洗成 author。 */
  characterId?: string
  /** 只可用于定位并回读原文，其陈述本身不得进入正文材料。 */
  locatorOnly?: boolean
  /** 该来源的定位索引已过期（stale 摘要）。 */
  staleLocator?: boolean
  /** 从同一可读来源回读到的不可变原文；stale 定位的唯一合法替代。 */
  recoveredProse?: readonly string[]
  /** 未定稿候选材料；只有通过准入的白名单项才可能入选。 */
  candidate?: { source: CandidateSource; admission: CandidateAdmission }
}

export type SourceOmissionReason = 'unknown-provenance' | 'locator-statement-not-evidence' | 'candidate-not-admitted'
  | 'invalid-source-ref' | 'plot-tree-not-manuscript' | 'duplicate-content' | 'duplicate-source-ref' | 'budget'

/** 这些原因说明来源本身不可用，不是容量问题：再拆小范围也解决不了。 */
const UNUSABLE_SOURCE_REASONS: readonly SourceOmissionReason[] = [
  'unknown-provenance', 'locator-statement-not-evidence', 'candidate-not-admitted',
  'invalid-source-ref', 'plot-tree-not-manuscript', 'duplicate-source-ref',
]

export interface SourceOmission {
  sourceId: string
  reason: SourceOmissionReason
  category: MaterialCategory
  required: boolean
}

export interface SelectedMaterial {
  ref: SourceRef
  category: MaterialCategory
  text: string
  required: boolean
  reason: string
}

export interface RequiredCoverage {
  required: number
  included: number
  complete: boolean
}

/**
 * `remainingRequired` 与 `blockingSourceId` 都是 `sourceId`，同一条源修订被引用
 * 多次时并不唯一。需要精确定位到某一版时，必须与 `omissions`（带 reason /
 * category / required）配合读取；本契约不为此把 payload 换成不可读的身份串。
 */
export type SourceSelection =
  | { decision: 'ready'; included: readonly SelectedMaterial[]; omissions: readonly SourceOmission[]; coverage: RequiredCoverage }
  | { decision: 'split-required'; remainingRequired: readonly string[]; omissions: readonly SourceOmission[]; coverage: RequiredCoverage }
  | { decision: 'capacity-conflict'; blockingSourceId: string; blockingReason: SourceOmissionReason
      omissions: readonly SourceOmission[]; coverage: RequiredCoverage }

export interface SourceSelectionInput {
  current: ProjectEpoch
  candidates: readonly MaterialCandidate[]
  capacity: { maxInputUnits: number; methodVersion: string }
  relevanceTerms: readonly string[]
}

const PLOT_TREE_PREFIX = 'plot-tree:'
/** 估计单位固定为 UTF-8 字节；位置单位仍是编辑器的 UTF-16 code unit，本片不产生 span。 */
const unitOf = (text: string) => new TextEncoder().encode(text).length
/** 只用于给可选材料排序，不作为事实判定依据。 */
const relevanceOf = (text: string, terms: readonly string[]) => terms.filter(term => term && text.includes(term)).length

/**
 * 码元比较。不用 localeCompare：它依赖 ICU/locale（同一组中文 ID 在 zh-CN 与
 * en-US 下顺序不同），并且会把 collation 等价的字符串判成相等，因而不是全序，
 * 会让排序结果继承输入顺序。
 */
function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * 候选的规范序列化。比较器必须对**整条记录**构成全序，否则只在前几个字段上
 * 相等的两条记录会退回输入顺序，进而让选择结果甚至决策依赖调用方传参顺序。
 * 这里把每个决策相关字段都写进固定顺序的数组，比较这个字符串即可。
 */
function canonicalCandidate(candidate: MaterialCandidate): string {
  const { ref, candidate: draft } = candidate
  return JSON.stringify([
    ref.projectId, ref.epoch, ref.sourceId, ref.revision, ref.contentHash,
    ref.span ? [ref.span.start, ref.span.end, ref.span.unit] : null,
    candidate.category, candidate.provenance, candidate.required, candidate.text,
    candidate.characterId ?? null,
    candidate.locatorOnly ?? false,
    candidate.staleLocator ?? false,
    candidate.recoveredProse ? [...candidate.recoveredProse] : null,
    draft ? [draft.source.artifactId, draft.source.revision, draft.source.state, draft.source.saved,
      draft.source.batchLineage, draft.admission.selectedCurrentDraftId ?? null,
      draft.admission.directPredecessorId ?? null] : null,
  ])
}

const compareCandidate = (left: MaterialCandidate, right: MaterialCandidate): number =>
  compareCodeUnit(canonicalCandidate(left), canonicalCandidate(right))

/**
 * 不可变源身份。同一条源修订被引用两次属于矛盾输入（同一份内容不可能既是
 * author 又是 unknown，也不可能同时必需与可选），必须先拒绝，否则后续的
 * 覆盖与排序判断都得依赖「谁先被处理」。
 */
function sourceIdentity(candidate: MaterialCandidate): string {
  const { ref } = candidate
  return JSON.stringify([ref.projectId, ref.epoch, ref.sourceId, ref.revision, ref.contentHash,
    ref.span ? [ref.span.start, ref.span.end, ref.span.unit] : null])
}

function coverageOf(required: readonly string[], covered: ReadonlySet<string>): RequiredCoverage {
  const hit = required.filter(contentHash => covered.has(contentHash)).length
  return { required: required.length, included: hit, complete: hit === required.length }
}

/**
 * 纯选择接缝：先证明哪些资料可以进入本章，再由调用方接模型。
 * 它不读数据库、不写文件、不发请求；相同输入（含调用方传参顺序）产生相同选择。
 *
 * 必需覆盖按**内容**判定并在选择结束后统一结算，不在循环里提前失败：否则
 * 「必需但自身不产材料的来源」能否被同内容的兄弟来源满足，就取决于谁先被
 * 处理，而不是事实本身。
 */
export function selectChapterSources(input: SourceSelectionInput): SourceSelection {
  const omissions: SourceOmission[] = []
  const admissible: MaterialCandidate[] = []
  const ordered = [...input.candidates].sort(compareCandidate)
  // 必需覆盖按内容统计，重复来源既不会重复进入上下文，也不会让覆盖看起来缺失。
  const requiredContent = ordered.filter(item => item.required).map(item => item.ref.contentHash)
  const seenIdentity = new Set<string>()
  // 阻断原因按**候选对象**记录，而不是按 sourceId 或源身份：同一 sourceId 可以
  // 合法地出现在不同 revision 上，而同身份的两条候选也可能一条被接受、一条被
  // 前置规则拒绝，任何字符串键都会让后写覆盖先写、把原因归给另一个候选。
  const reasonByCandidate = new WeakMap<MaterialCandidate, SourceOmissionReason>()
  // 省略清单记录所有被排除的材料；阻断原因只记录阻止它进入的那一条。
  // stale 定位的陈述未被采用是信息性的，来源仍然可用，不能算阻断原因。
  const markBlock = (candidate: MaterialCandidate, reason: SourceOmissionReason) => {
    if (!reasonByCandidate.has(candidate)) reasonByCandidate.set(candidate, reason)
  }
  const record = (candidate: MaterialCandidate, reason: SourceOmissionReason) => {
    omissions.push({ sourceId: candidate.ref.sourceId, reason, category: candidate.category, required: candidate.required })
  }
  const block = (candidate: MaterialCandidate, reason: SourceOmissionReason) => {
    record(candidate, reason)
    markBlock(candidate, reason)
  }

  for (const candidate of ordered) {
    const omit = (reason: SourceOmissionReason) => block(candidate, reason)
    if (!sameProjectEpoch(candidate.ref, input.current) || !candidate.ref.sourceId.trim()
      || !Number.isSafeInteger(candidate.ref.revision) || candidate.ref.revision < 0) { omit('invalid-source-ref'); continue }
    if (candidate.ref.sourceId.startsWith(PLOT_TREE_PREFIX)) { omit('plot-tree-not-manuscript'); continue }
    if (candidate.provenance === 'unknown') { omit('unknown-provenance'); continue }
    if (candidate.candidate && !mayUseCandidate(candidate.candidate.source, candidate.candidate.admission)) {
      omit('candidate-not-admitted'); continue
    }
    const identity = sourceIdentity(candidate)
    if (seenIdentity.has(identity)) { omit('duplicate-source-ref'); continue }
    seenIdentity.add(identity)
    admissible.push(candidate)
  }

  const requiredFirst = [...admissible].sort((left, right) => {
    if (left.required !== right.required) return Number(right.required) - Number(left.required)
    // 先必需后可选；可选材料之间按本章相关词命中数排序，再按稳定全序收口。
    if (!left.required) {
      const delta = relevanceOf(right.text, input.relevanceTerms) - relevanceOf(left.text, input.relevanceTerms)
      if (delta !== 0) return delta
    }
    return compareCandidate(left, right)
  })
  const included: SelectedMaterial[] = []
  const coveredContent = new Set<string>()
  let remaining = input.capacity.maxInputUnits

  for (const candidate of requiredFirst) {
    // 同一份不可变内容已由别的来源贡献：只记一次重复省略就够，
    // 不再叠加第二条定位省略。
    if (coveredContent.has(candidate.ref.contentHash)) {
      block(candidate, 'duplicate-content')
      continue
    }
    const blocks = candidate.staleLocator
      ? (candidate.recoveredProse ?? []).map(text => ({ text, reason: 'recovered immutable prose for a stale locator' }))
      : candidate.locatorOnly ? [] : [{ text: candidate.text, reason: `${candidate.category} material` }]
    if (candidate.staleLocator) record(candidate, 'locator-statement-not-evidence')
    if (blocks.length === 0) {
      // 只可定位、且没有可回读原文的来源本身不产生材料。它能否被满足由结算阶段
      // 按最终内容判断：同内容的兄弟来源进得来就算满足，否则整体失败。
      // stale 定位已经记过同一条省略，这里不再重复。
      if (candidate.staleLocator) markBlock(candidate, 'locator-statement-not-evidence')
      else block(candidate, 'locator-statement-not-evidence')
      continue
    }
    const cost = blocks.reduce((sum, piece) => sum + unitOf(piece.text), 0)
    if (cost > remaining) {
      block(candidate, 'budget')
      continue
    }
    remaining -= cost
    for (const piece of blocks) {
      included.push({ ref: candidate.ref, category: candidate.category, text: piece.text,
        required: candidate.required, reason: piece.reason })
    }
    coveredContent.add(candidate.ref.contentHash)
  }

  const coverage = coverageOf(requiredContent, coveredContent)
  if (coverage.complete) return { decision: 'ready', included, omissions, coverage }

  // 结算：按稳定顺序挑出第一个未被覆盖的必需来源作为阻断点。
  const blocking = ordered.find(item => item.required && !coveredContent.has(item.ref.contentHash))!
  // blocking 取自 ordered，是同一个对象引用，因此这里取到的就是它自己的原因。
  const reason = reasonByCandidate.get(blocking) ?? 'budget'
  if (UNUSABLE_SOURCE_REASONS.includes(reason)) {
    // 来源本身不可用：拆小范围也解决不了。
    return { decision: 'capacity-conflict', blockingSourceId: blocking.ref.sourceId,
      blockingReason: reason, omissions, coverage }
  }
  return coverage.included === 0
    ? { decision: 'capacity-conflict', blockingSourceId: blocking.ref.sourceId,
        blockingReason: reason, omissions, coverage }
    : { decision: 'split-required', remainingRequired: ordered
        .filter(item => item.required && !coveredContent.has(item.ref.contentHash))
        .map(item => item.ref.sourceId), omissions, coverage }
}
