import type { WritingLanguage } from '../../shared/writing-language'
import { hashAuthorText } from '../../shared/source-ref'
import { promptLanguageText } from '../prompt-language'
import {
  selectChapterSources,
  type MaterialCandidate,
  type SourceOmission,
  type SourceOmissionReason,
  type SourceSelection,
} from './source-selection'

export interface SelectedCandidateDraft {
  chapterNumber: number
  draftId: number
  version: number
  content: string
}

export interface FinalizedMaterialSource {
  chapterNumber: number
  draftId: number
  title: string
  content: string
  evidence: readonly string[]
  includeEnding?: boolean
  sourceStatus?: 'current' | 'stale' | 'legacy' | 'invalid'
  sourceIdentity?:
    | { kind: 'finalized'; finalizationId: string; contentHash: string }
    | { kind: 'legacy-finalized' }
}

export interface ChapterMaterialOmission {
  source: 'finalized' | 'candidate' | 'reference'
  chapterNumber?: number
  /**
   * `evidence-not-locatable` / `source-invalid` / `no-relevant-passage` 由材料摘取给出，
   * `budget` / `duplicate-content` 由选择契约的容量与内容唯一性结算给出。
   */
  reason: 'evidence-not-locatable' | 'source-invalid' | 'no-relevant-passage' | 'budget' | 'duplicate-content'
}

export interface ChapterMaterialReference {
  readonly text: string
  readonly rendered: string
  readonly deduplicateAgainstFinalized?: boolean
}

export interface ChapterMaterialBundle {
  text: string
  previousEnding: string
  includedFinalizedFacts: number
  consumedFinalizedSources: FinalizedMaterialSource[]
  omissions: ChapterMaterialOmission[]
}

/** 稳定准入需要的项目身份。epoch 与主进程 generation binding 一致，取会话 lease。 */
export interface ChapterMaterialIdentity {
  projectId: string
  epoch: string
}

/**
 * 合同省略原因 -> 装配层省略原因。
 *
 * 装配层的联合体比合同窄，这里做一次有损投影：写稿路径上可达的只有 `budget` 与
 * `duplicate-content`（其余原因需要 provenance=unknown、`plot-tree:` 前缀、locatorOnly
 * 或候选准入字段，而本函数从不构造这类候选），它们一律归为 `source-invalid`——都表示
 * 「这条来源不可用」。
 */
const SELECTION_OMISSION_REASON: Record<SourceOmissionReason, ChapterMaterialOmission['reason']> = {
  budget: 'budget',
  'duplicate-content': 'duplicate-content',
  'duplicate-source-ref': 'duplicate-content',
  'invalid-source-ref': 'source-invalid',
  'unknown-provenance': 'source-invalid',
  'plot-tree-not-manuscript': 'source-invalid',
  'candidate-not-admitted': 'source-invalid',
  'locator-statement-not-evidence': 'source-invalid',
}

/**
 * 必需材料（作者资料 + 角色档案 + 后续计划）装不下容量时的唯一结果。
 *
 * 它携带合同的原始裁决（谁被阻断、原因、覆盖缺口），调用方据此给出可执行提示；
 * 绝不静默截断、也不静默丢掉必需材料。
 */
export class ChapterMaterialCapacityError extends Error {
  readonly code = 'CHAPTER_MATERIAL_CAPACITY_CONFLICT' as const

  constructor(
    readonly decision: Extract<SourceSelection, { decision: 'split-required' | 'capacity-conflict' }>,
    locale: WritingLanguage,
  ) {
    const blocked = decision.decision === 'capacity-conflict'
      ? `${decision.blockingSourceId} (${decision.blockingReason})`
      : decision.remainingRequired.join(', ')
    super(locale === 'en-US'
      ? `Required chapter material does not fit the context capacity (${decision.decision}): ${blocked}. Trim the author material or future plans and try again.`
      : `本章必需材料装不下上下文容量（${decision.decision}）：${blocked}。请精简作者资料、角色档案或后续计划后重试。`)
    this.name = 'ChapterMaterialCapacityError'
  }
}

/**
 * S10B-1b：选择契约是提示词材料的唯一权威。渲染、省略清单与依赖清单全部由
 * `selectChapterSources` 的一次裁决推出；传统遍历已经删除，不再存在第二条准入路径。
 */
export interface ChapterMaterialAssembly extends ChapterMaterialBundle {
  selection: SourceSelection
}

const MATERIAL_BUDGET_CHARS = 6_000
const PREVIOUS_ENDING_MAX_CHARS = 1_000
/**
 * 单位统一（S10B-1b）：旧遍历按 UTF-16 码元计量，选择契约按 UTF-8 字节计量
 * （估算器版本冻结为 `utf8-bytes-v1`）。这里按**写作语言的主要字符集**把码元预算换算成
 * 字节，使切换前后同一条路径的有效材料上限保持同一量级：CJK 一个码元约 3 字节，
 * 拉丁字母一个码元 1 字节。用固定倍数会把另一条路径的上限放大或缩小到 3 倍。
 */
const BYTES_PER_BUDGET_CHAR: Readonly<Record<WritingLanguage, number>> = { 'zh-CN': 3, 'en-US': 1 }
/** `SourceRef.sourceId` 里的家族前缀；渲染与省略清单都按它归类。 */
const REQUIRED_SOURCE_ID = 'author:required'

function paragraphs(content: string): string[] {
  return content.split(/\r?\n\s*\r?\n/u).map(part => part.trim()).filter(Boolean)
}

function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = []
  for (const window of windows.sort((left, right) => left[0] - right[0])) {
    const previous = merged.at(-1)
    if (!previous || window[0] > previous[1] + 1) {
      merged.push([...window])
    } else {
      previous[1] = Math.max(previous[1], window[1])
    }
  }
  return merged
}

/** Keep the hit paragraph plus one complete neighbour on each side. */
export function adjacentEvidencePassages(
  content: string,
  evidence: readonly string[],
  includeEnding = false,
): { passages: string[]; locatedEvidence: number } {
  const sourceParagraphs = paragraphs(content)
  const windows: Array<[number, number]> = []
  let locatedEvidence = 0
  for (const quote of evidence.map(value => value.trim()).filter(Boolean)) {
    const index = sourceParagraphs.findIndex(paragraph => paragraph.includes(quote))
    if (index < 0) continue
    locatedEvidence += 1
    windows.push([Math.max(0, index - 1), Math.min(sourceParagraphs.length - 1, index + 1)])
  }
  if (includeEnding && sourceParagraphs.length > 0) {
    windows.push([Math.max(0, sourceParagraphs.length - 2), sourceParagraphs.length - 1])
  }
  return {
    passages: mergeWindows(windows).map(([start, end]) => sourceParagraphs.slice(start, end + 1).join('\n\n')),
    locatedEvidence,
  }
}

export function previousChapterEnding(content: string): string {
  const trimmed = content.trim()
  if (trimmed.length <= PREVIOUS_ENDING_MAX_CHARS) return trimmed

  const tail = trimmed.slice(-PREVIOUS_ENDING_MAX_CHARS)
  const firstBoundary = /(?:\r?\n\s*\r?\n|[。！？!?][”’"'）)\]】」』]*|\.[”’"')\]]*(?=\s|$))/u.exec(tail)
  return firstBoundary
    ? tail.slice(firstBoundary.index + firstBoundary[0].length).trim() || tail.trim()
    : tail.trim()
}

function relevantPassages(content: string, terms: readonly string[]): string[] {
  const sourceParagraphs = paragraphs(content)
  const normalizedTerms = terms.map(term => term.trim().toLocaleLowerCase()).filter(term => term.length >= 2)
  const windows: Array<[number, number]> = []
  for (let index = 0; index < sourceParagraphs.length; index += 1) {
    const value = sourceParagraphs[index].toLocaleLowerCase()
    if (normalizedTerms.some(term => value.includes(term))) {
      windows.push([Math.max(0, index - 1), Math.min(sourceParagraphs.length - 1, index + 1)])
    }
  }
  return mergeWindows(windows).slice(-2).map(([start, end]) => sourceParagraphs.slice(start, end + 1).join('\n\n'))
}

function removeContainedPassages(passages: readonly string[]): string[] {
  return passages.filter((passage, index) => !passages.some((other, otherIndex) => (
    otherIndex !== index
    && other.includes(passage)
    && (other.length > passage.length || otherIndex < index)
  )))
}

/**
 * 定稿来源在本章的材料文本。摘取逻辑只有这一处：两套各自实现一份就会变成两个事实来源。
 */
function finalizedPassages(source: FinalizedMaterialSource, relevanceTerms: readonly string[]): {
  passages: string[]
  locatedEvidence: number
} {
  const located = adjacentEvidencePassages(source.content, source.evidence, source.includeEnding)
  const expectedEvidence = source.evidence.filter(value => value.trim()).length
  // A stale locator is only an index failure. Recover nearby immutable prose from
  // the same readable source with the existing deterministic term matcher, while
  // never injecting the old statement itself.
  const recovered = located.locatedEvidence < expectedEvidence
    ? relevantPassages(source.content, relevanceTerms) : []
  return { passages: removeContainedPassages([...located.passages, ...recovered]), locatedEvidence: located.locatedEvidence }
}

/** 未定稿候选在本章的材料文本；同上，只有一处计算。 */
function candidatePassages(candidate: SelectedCandidateDraft, isLatest: boolean,
  relevanceTerms: readonly string[]): string[] {
  return isLatest ? [previousChapterEnding(candidate.content)] : relevantPassages(candidate.content, relevanceTerms)
}

/** 每条候选在渲染与账目上额外需要的信息，只能由本函数的构造过程给出。 */
interface MaterialFamily {
  family: ChapterMaterialOmission['source'] | 'required'
  chapterNumber?: number
  locatedEvidence: number
  passages: readonly string[]
  source?: FinalizedMaterialSource
}

export async function assembleChapterMaterials(input: {
  identity: ChapterMaterialIdentity
  writingLanguage: WritingLanguage
  authorProjectFacts: readonly string[]
  characterProfiles: string
  futurePlans: string
  references: readonly ChapterMaterialReference[]
  finalized: readonly FinalizedMaterialSource[]
  candidates: readonly SelectedCandidateDraft[]
  relevanceTerms: readonly string[]
  budgetChars?: number
}): Promise<ChapterMaterialAssembly> {
  const writingLanguage = input.writingLanguage
  const omissions: ChapterMaterialOmission[] = []
  const candidates: MaterialCandidate[] = []
  const familyBySourceId = new Map<string, MaterialFamily>()
  const referenceCandidates: Array<{ candidate: MaterialCandidate; reference: ChapterMaterialReference }> = []

  const push = async (family: MaterialFamily, material: {
    sourceId: string
    revision: number
    text: string
    category: MaterialCandidate['category']
    provenance: MaterialCandidate['provenance']
    required: boolean
    staleLocator?: false
  }): Promise<MaterialCandidate | undefined> => {
    // 没有材料文本的来源贡献不了任何东西；如果给它建候选，只会在省略清单里
    // 冒出一个成本为 0 的假纳入。
    if (!material.text.trim()) return undefined
    const candidate: MaterialCandidate = {
      ref: {
        projectId: input.identity.projectId, epoch: input.identity.epoch,
        sourceId: material.sourceId, revision: material.revision,
        contentHash: await hashAuthorText(material.text),
      },
      category: material.category, provenance: material.provenance, required: material.required,
      text: material.text,
      ...(material.staleLocator === undefined ? {} : { staleLocator: material.staleLocator }),
    }
    candidates.push(candidate)
    familyBySourceId.set(material.sourceId, family)
    return candidate
  }

  // ---- 必需材料（决定 1B）：作者资料 + 角色档案 + 后续计划是单一候选，----
  // ---- 装不下就整轮失败，绝不静默截断，也绝不让它挤掉别的块。            ----
  const authorFacts = [...new Set(input.authorProjectFacts.map(value => value.trim()).filter(Boolean))]
  const required = promptLanguageText(
    writingLanguage,
    `【作者资料（保留原文；人物状态具有时点，不是永久约束）】\n${[...authorFacts, input.characterProfiles].filter(Boolean).join('\n\n') || '（无补充作者资料）'}\n\n【后续计划边界（只约束当前章，不是当前章任务）】\n以下保留作者后续计划原文，只用于防止本章提前执行。明确安排在后续章节的知情变化、物品转交、行动和完成状态不得前移；允许不改变这些时点的铺垫。\n${input.futurePlans}`,
    `[Author material (verbatim; character state is time-bound, not permanent)]\n${[...authorFacts, input.characterProfiles].filter(Boolean).join('\n\n') || '(no additional author material)'}\n\n[Future-plan boundary (constrains the current chapter; not a current-chapter task)]\nThe author's future plans are preserved verbatim below and only prevent premature execution in this chapter. Knowledge changes, item transfers, actions, and completed states explicitly assigned to later chapters must not be moved earlier; foreshadowing that does not change those timings is allowed.\n${input.futurePlans}`,
  )
  const sourced = promptLanguageText(
    writingLanguage,
    '【有来源的历史与候选】\n以下定稿原文只证明原文直接写明的内容；索引、摘要和 currentState 都不是作者事实。候选正文尚未确认，不得冒充定稿。',
    '[Sourced history and candidates]\nFinalized excerpts establish only their exact text; indexes, summaries, and currentState are not author facts. Candidate prose is unconfirmed and is not finalized history.',
  )
  const requiredCandidate = await push({ family: 'required', locatedEvidence: 0, passages: [] }, {
    sourceId: REQUIRED_SOURCE_ID, revision: 1, text: required,
    category: 'author', provenance: 'author', required: true,
  })

  // ---- 定稿来源 ----
  // 摘取顺序仍是新章在前，这样摘取层的省略清单保持稳定；**渲染顺序由合同决定**。
  for (const source of [...input.finalized].sort((left, right) => right.chapterNumber - left.chapterNumber)) {
    if (source.sourceStatus === 'invalid') {
      omissions.push({
        source: 'finalized',
        chapterNumber: source.chapterNumber,
        reason: 'source-invalid',
      })
      continue
    }
    const extracted = finalizedPassages(source, input.relevanceTerms)
    const expectedEvidence = source.evidence.filter(value => value.trim()).length
    if (extracted.locatedEvidence < expectedEvidence) {
      omissions.push({
        source: 'finalized',
        chapterNumber: source.chapterNumber,
        reason: 'evidence-not-locatable',
      })
    }
    if (extracted.passages.length === 0) continue
    await push({
      family: 'finalized',
      chapterNumber: source.chapterNumber,
      locatedEvidence: extracted.locatedEvidence,
      passages: extracted.passages,
      source,
    }, {
      sourceId: `finalized:${source.draftId}`,
      revision: source.draftId,
      text: promptLanguageText(
        writingLanguage,
        `【定稿原文 · 第${source.chapterNumber}章 · draft ${source.draftId} · 定位索引${source.sourceStatus ?? 'legacy'}】\n${extracted.passages.join('\n\n')}`,
        `[Finalized manuscript · Chapter ${source.chapterNumber} · draft ${source.draftId} · locator ${source.sourceStatus ?? 'legacy'}]\n${extracted.passages.join('\n\n')}`,
      ),
      category: 'finalized-history',
      provenance: source.sourceStatus === 'legacy' ? 'legacy' : 'finalized',
      required: false,
      // stale 定位只说明索引失效：回读到的原文照常计入材料，过时陈述本身从不进入提示词。
      ...(source.sourceStatus === 'stale' ? { staleLocator: false as const } : {}),
    })
  }

  // ---- 未定稿候选 ----
  const orderedCandidates = [...input.candidates].sort((left, right) => left.chapterNumber - right.chapterNumber)
  const latestCandidate = orderedCandidates.at(-1)
  for (const candidate of orderedCandidates) {
    const passages = candidatePassages(candidate, candidate === latestCandidate, input.relevanceTerms)
    if (passages.length === 0) {
      omissions.push({ source: 'candidate', chapterNumber: candidate.chapterNumber, reason: 'no-relevant-passage' })
      continue
    }
    await push({ family: 'candidate', chapterNumber: candidate.chapterNumber, locatedEvidence: 0, passages: [] }, {
      sourceId: `candidate:${candidate.draftId}`,
      revision: candidate.version,
      text: promptLanguageText(
        writingLanguage,
        `【未定稿候选 · 第${candidate.chapterNumber}章 · draft ${candidate.draftId} · v${candidate.version}】\n${passages.join('\n\n')}`,
        `[Unfinalized candidate · Chapter ${candidate.chapterNumber} · draft ${candidate.draftId} · v${candidate.version}]\n${passages.join('\n\n')}`,
      ),
      category: 'finalized-history',
      provenance: 'author',
      required: false,
    })
  }

  // ---- 参考材料 ----
  for (const [referenceIndex, reference] of input.references.entries()) {
    const candidate = await push({ family: 'reference', locatedEvidence: 0, passages: [] }, {
      sourceId: `reference:${referenceIndex}`,
      revision: 1,
      text: reference.rendered,
      category: 'reference',
      provenance: 'author',
      required: false,
    })
    if (candidate) referenceCandidates.push({ candidate, reference })
  }

  // 单位在这里统一：旧遍历按 UTF-16 码元、合同按 UTF-8 字节，容量用码元预算按写作语言
  // 主要字符集换算出的字节数表示，估算器版本与 context-snapshot 冻结的 utf8-bytes-v1 一致。
  const capacity = {
    maxInputUnits: (input.budgetChars ?? MATERIAL_BUDGET_CHARS) * BYTES_PER_BUDGET_CHAR[writingLanguage],
    methodVersion: 'utf8-bytes-v1',
  }

  // ---- 参考材料族的局部子串去重（决定 2C）----
  // 它是「参考材料」这一族的补充过滤器，**不是**第二套事实来源：它不判定来源是否可用、
  // 不参与覆盖结算，只是不重复发送已经发过的字节。它需要知道定稿最终纳入了哪些段落，
  // 而合同只在跑完一次选择之后才结算这一点，所以先用全部候选跑一次探针选择，据此过滤
  // 参考候选，再用过滤后的候选跑权威选择。
  //
  // 探针只可能**多**纳入定稿块（参考候选被删掉只会让出预算，不会夺走预算），所以探针算出的
  // 「已纳入定稿段落」在权威选择里仍然成立，被删掉的参考不会因此漏网。
  const probe = selectChapterSources({
    current: input.identity,
    capacity,
    relevanceTerms: input.relevanceTerms,
    candidates,
  })
  const includedFinalizedPassages: string[] = []
  if (probe.decision === 'ready') {
    for (const material of probe.included) {
      const family = familyBySourceId.get(material.ref.sourceId)
      if (family?.family === 'finalized') includedFinalizedPassages.push(...family.passages)
    }
  }
  const droppedReferences = new Set<MaterialCandidate>()
  for (const { candidate, reference } of referenceCandidates) {
    if (reference.deduplicateAgainstFinalized && reference.text.length > 0
      && includedFinalizedPassages.some(passage => passage.includes(reference.text))) {
      droppedReferences.add(candidate)
    }
  }

  // ---- 权威裁决：这一步的结果就是提示词，别处不再有第二条准入路径 ----
  const selection = selectChapterSources({
    current: input.identity,
    capacity,
    relevanceTerms: input.relevanceTerms,
    candidates: candidates.filter(item => !droppedReferences.has(item)),
  })
  if (selection.decision !== 'ready') throw new ChapterMaterialCapacityError(selection, writingLanguage)

  // 渲染：块头沿用各族原有的模板（在构造候选时就已经套好，这里不做二次改写），
  // 顺序就是合同的顺序——必需材料在前，其后按相关度与规范全序。
  // 必需材料按**内容哈希**结算覆盖，`ready` 意味着该哈希已被某条 included 材料覆盖，
  // 所以这里按哈希取回的就是实际进入提示词的那一份（同内容被兄弟来源满足时也一样）。
  const requiredBlock = requiredCandidate
    ? selection.included.find(item => item.ref.contentHash === requiredCandidate.ref.contentHash)?.text ?? ''
    : ''
  const optionalBlocks = selection.included.filter(item => !item.required).map(item => item.text)

  const selectedOmissions = selection.omissions
    .map(omission => describeSelectionOmission(omission, familyBySourceId))
    .filter((omission): omission is ChapterMaterialOmission => omission !== null)
  const allOmissions = [...omissions, ...selectedOmissions]
  const gap = allOmissions.length > 0
    ? promptLanguageText(
        writingLanguage,
        `【可选材料覆盖缺口】${allOmissions.map(item => `${item.source}${item.chapterNumber ? `#${item.chapterNumber}` : ''}:${item.reason}`).join('；')}`,
        `[Optional material coverage gaps] ${allOmissions.map(item => `${item.source}${item.chapterNumber ? `#${item.chapterNumber}` : ''}:${item.reason}`).join('; ')}`,
      )
    : ''

  const consumedFinalizedSources: FinalizedMaterialSource[] = []
  let includedFinalizedFacts = 0
  for (const material of selection.included) {
    const family = familyBySourceId.get(material.ref.sourceId)
    if (family?.family !== 'finalized' || !family.source) continue
    consumedFinalizedSources.push(family.source)
    includedFinalizedFacts += family.locatedEvidence
  }

  const endingSource = latestCandidate
    ? undefined
    : input.finalized.find(source => source.includeEnding && source.content.trim())
  if (endingSource && !consumedFinalizedSources.some(source => source.draftId === endingSource.draftId)) {
    // The ending also affects replay rejection even when its prompt block exceeded the budget.
    consumedFinalizedSources.push(endingSource)
  }

  return {
    selection,
    text: [requiredBlock, sourced, ...optionalBlocks, gap].filter(Boolean).join('\n\n'),
    previousEnding: latestCandidate
      ? previousChapterEnding(latestCandidate.content)
      : previousChapterEnding(input.finalized.find(source => source.includeEnding)?.content ?? ''),
    includedFinalizedFacts,
    consumedFinalizedSources,
    omissions: allOmissions,
  }
}

/**
 * 合同的省略是全域的，这里只投影回装配层的族（并在必要时带上章号）。
 * `author:required` 的省略只出现在容量/拆分决策里，那时调用方已经抛错，不会走到这里。
 */
function describeSelectionOmission(
  omission: SourceOmission,
  familyBySourceId: ReadonlyMap<string, MaterialFamily>,
): ChapterMaterialOmission | null {
  const family = familyBySourceId.get(omission.sourceId)
  if (!family || family.family === 'required') return null
  return {
    source: family.family,
    ...(family.chapterNumber === undefined ? {} : { chapterNumber: family.chapterNumber }),
    reason: SELECTION_OMISSION_REASON[omission.reason],
  }
}
