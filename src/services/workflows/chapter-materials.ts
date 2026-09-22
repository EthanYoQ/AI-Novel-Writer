import type { WritingLanguage } from '../../shared/writing-language'
import { hashAuthorText } from '../../shared/source-ref'
import {
  MATERIAL_DECISION_MAX_INPUT_UNITS,
  MATERIAL_DECISION_RECEIPT_VERSION,
  MATERIAL_DECISION_UNIT_METHOD_VERSION,
  type MaterialDecisionIncludedSource,
  type MaterialDecisionOmittedSource,
  type MaterialDecisionDraft,
} from '../../shared/generation-owner-contract'
import type { ReviewMaterialIdentity } from '../../shared/review-revision-generation'
import { promptLanguageText } from '../prompt-language'
import {
  selectChapterSources,
  type MaterialCandidate,
  type MaterialCategory,
  type SourceOmission,
  type SourceOmissionReason,
  type SourceSelection,
} from './source-selection'

export interface SelectedCandidateDraft {
  chapterNumber: number
  draftId: number
  version: number
  content: string
  /** Required predecessor for this run. Omitted on the legacy single-candidate path. */
  required?: boolean
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
  selection: Extract<SourceSelection, { decision: 'ready' }>
  /** 脱敏准入收据：随主进程冻结上下文一起持久化，并被恢复指纹绑定。 */
  decision: MaterialDecisionDraft
}

/**
 * 材料准入裁决 -> 脱敏收据（S10B 步骤 3）。
 *
 * 收据只承载**可核对的编号**：来源 id、修订、已渲染材料的内容哈希、类别、是否必需、
 * UTF-8 字节数、省略原因码、必需覆盖计数与容量裁决。正文、作者文字、路径与凭据一律
 * 不进收据——「收据记明确认了什么」与「公开日志不放正文」是同一件事的两面。
 *
 * 只有 `ready` 裁决才配得上收据：容量冲突与拆分在调用方就已显式失败，根本不会开出
 * 运行，也就不存在可绑定的指纹。这里因此对非 `ready` 输入直接抛错，绝不用半份裁决
 * 冒充收据。
 *
 * 同一来源可能拆成多个片段进入材料（stale 定位回读、多段证据窗口），这里按
 * `(sourceId, revision, contentHash)` 合并为一个来源条目并累加字节数，使收据记录的是
 * **来源级**准入，而不是渲染分块。排序用码元比较的稳定全序，不依赖 locale。
 */
export function buildMaterialDecisionReceipt(
  selection: SourceSelection,
  capacity: { maxInputUnits: number; methodVersion: typeof MATERIAL_DECISION_UNIT_METHOD_VERSION },
  additionalOmissions: readonly MaterialDecisionOmittedSource[] = [],
): MaterialDecisionDraft {
  if (selection.decision !== 'ready') throw new Error('MATERIAL_DECISION_NOT_READY')
  if (!Number.isSafeInteger(capacity.maxInputUnits) || capacity.maxInputUnits < 1
    || capacity.maxInputUnits > MATERIAL_DECISION_MAX_INPUT_UNITS)
    throw new Error('MATERIAL_DECISION_CAPACITY_INVALID')
  const included = new Map<string, MaterialDecisionIncludedSource>()
  for (const material of selection.included) {
    const key = materialIdentityKey(material.ref)
    const units = new TextEncoder().encode(material.text).length
    if (units < 1) throw new Error('MATERIAL_DECISION_INCLUDED_EMPTY')
    const existing = included.get(key)
    if (existing) {
      if (existing.category !== material.category || existing.required !== material.required)
        throw new Error('MATERIAL_DECISION_INCLUDED_IDENTITY_CONFLICT')
      existing.units += units
      continue
    }
    included.set(key, {
      sourceId: material.ref.sourceId,
      revision: material.ref.revision,
      contentHash: material.ref.contentHash,
      category: material.category,
      required: material.required,
      units,
    })
  }
  const ordered = [...included.values()].sort((left, right) =>
    compareCodeUnit(left.sourceId, right.sourceId)
    || left.revision - right.revision
    || compareCodeUnit(left.contentHash, right.contentHash))
  const omitted: MaterialDecisionOmittedSource[] = [
    ...selection.omissions.map(omission => ({
      sourceId: omission.sourceId,
      revision: omission.revision,
      contentHash: omission.contentHash,
      reason: omission.reason,
      category: omission.category,
      required: omission.required,
    })),
    ...additionalOmissions,
  ]
    .sort((left, right) =>
      compareCodeUnit(left.sourceId, right.sourceId)
      || left.revision - right.revision
      || compareCodeUnit(left.contentHash, right.contentHash)
      || compareCodeUnit(left.reason, right.reason)
      || compareCodeUnit(left.category, right.category)
      || Number(left.required) - Number(right.required))
  const omittedEvents = omitted.map(item => `${materialIdentityKey(item)}\u0000${item.reason}`)
  if (new Set(omittedEvents).size !== omittedEvents.length)
    throw new Error('MATERIAL_DECISION_DUPLICATE_OMISSION')
  const includedIdentities = new Set(ordered.map(materialIdentityKey))
  if (omitted.some(item => includedIdentities.has(materialIdentityKey(item))
    && item.reason !== 'locator-statement-not-evidence' && item.reason !== 'evidence-not-locatable'))
    throw new Error('MATERIAL_DECISION_IDENTITY_CONFLICT')
  const admittedUnits = ordered.reduce((sum, item) => sum + item.units, 0)
  if (admittedUnits > capacity.maxInputUnits)
    throw new Error('MATERIAL_DECISION_CAPACITY_INVALID')
  return {
    version: MATERIAL_DECISION_RECEIPT_VERSION,
    verdict: 'admitted',
    capacity: {
      maxInputUnits: capacity.maxInputUnits,
      methodVersion: capacity.methodVersion,
      admittedUnits,
    },
    coverage: { required: selection.coverage.required, included: selection.coverage.included, complete: selection.coverage.complete },
    included: ordered,
    omitted,
  }
}

/** 码元比较：与选择契约同一套全序，避免排序依赖 ICU/locale。 */
function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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

// ---- 审稿/修稿入口的准入层（S10B-2）----
// 写稿路径在 `assembleChapterMaterials` 里把「渲染」和「准入」合在一个函数里，因为材料文本
// 本身由它生成。审/修入口的材料文本由各自命令按**原有措辞**渲染好后传入，所以这里只做准入。
// 成员判定的语义与写稿路径完全一致：同一份不可变内容只进一次、未知来源不得进入、
// 必需材料装不下时显式失败——因为两条路径最终都调用同一个 `selectChapterSources`。

/** 审稿/修稿入口的一条材料：主进程捕获的身份 + 该入口自己的渲染文本。 */
export interface ReviewRevisionMaterial {
  /** 主进程捕获的不可变来源身份；渲染层不得自行编造来源。 */
  identity: ReviewMaterialIdentity
  category: MaterialCategory
  /** 必需材料装不下时整轮显式失败，绝不静默丢弃。 */
  required: boolean
  /** 该材料在本入口提示词里的文本（块头按各入口原有措辞由调用方给出）。 */
  text: string
}

export interface ReviewRevisionMaterialAdmission {
  selection: Extract<SourceSelection, { decision: 'ready' }>
  decision: MaterialDecisionDraft
  /**
   * 准入的材料，**保持调用方传入顺序**。
   *
   * 顺序是刻意的：合同的 `included` 按「必需优先 + 相关度 + 规范全序」排列，那是写稿路径
   * 的渲染顺序。审/修入口不得因此重排历史（重排会改提示词），所以这里只按身份判定成员，
   * 再由调用方按原有顺序渲染——准入没有真正改变集合时，提示词逐字节与接入前相同。
   */
  admitted: readonly ReviewRevisionMaterial[]
}

/** 材料身份键：只取合同判定「同一份不可变内容」的字段，不含渲染文本。 */
function materialIdentityKey(identity: { sourceId: string; revision: number; contentHash: string }): string {
  return JSON.stringify([identity.sourceId, identity.revision, identity.contentHash])
}

/**
 * 审稿/修稿入口与写稿路径共享的准入权威。必需材料装不下时抛与写稿路径同一个
 * `ChapterMaterialCapacityError`（稳定错误码 `CHAPTER_MATERIAL_CAPACITY_CONFLICT`），
 * 绝不静默截断或丢掉必需材料。
 *
 * 会话租约在这里按**当前会话**补上：冻结材料身份是会话无关的（不含 `epoch`），而
 * `SourceRef` 必须带上活跃租约才能通过 `sameProjectEpoch`。重开同一项目后租约变化，
 * 冻结材料仍然合法——这正是把租约放在使用点、而不是冻进来源清单的原因。
 *
 * 本函数不读数据库、不写文件、不发请求。
 */
export function selectReviewRevisionMaterials(input: {
  current: ChapterMaterialIdentity
  writingLanguage: WritingLanguage
  materials: readonly ReviewRevisionMaterial[]
  relevanceTerms: readonly string[]
  budgetChars?: number
}): ReviewRevisionMaterialAdmission {
  const candidates: MaterialCandidate[] = input.materials.map(material => ({
    ref: {
      projectId: material.identity.projectId, epoch: input.current.epoch,
      sourceId: material.identity.sourceId, revision: material.identity.revision,
      contentHash: material.identity.contentHash,
    },
    category: material.category,
    provenance: material.identity.provenance,
    required: material.required,
    text: material.text,
  }))
  // 容量与写稿路径同源：同一份码元预算、同一个估算器版本。
  const capacity = {
    maxInputUnits: (input.budgetChars ?? MATERIAL_BUDGET_CHARS) * BYTES_PER_BUDGET_CHAR[input.writingLanguage],
    methodVersion: MATERIAL_DECISION_UNIT_METHOD_VERSION,
  }
  const selection = selectChapterSources({
    current: input.current,
    capacity,
    relevanceTerms: input.relevanceTerms,
    candidates,
  })
  if (selection.decision !== 'ready') throw new ChapterMaterialCapacityError(selection, input.writingLanguage)
  const admittedKeys = new Set(selection.included.map(item => materialIdentityKey(item.ref)))
  return {
    selection,
    decision: buildMaterialDecisionReceipt(selection, capacity),
    admitted: input.materials.filter(material => admittedKeys.has(materialIdentityKey(material.identity))),
  }
}

/**
 * 没有主进程身份的历史材料一律按 `unknown` 来源对待：合同会以 `invalid-source-ref` /
 * `unknown-provenance` 排除它，必需项因此显式失败。绝不用渲染层自己编的来源顶替。
 * 这里只给出会话无关的最小身份；活跃租约由 `selectReviewRevisionMaterials` 按当前会话补上。
 */
export function unknownReviewMaterialIdentity(current: ChapterMaterialIdentity): ReviewMaterialIdentity {
  return { projectId: current.projectId, sourceId: '', revision: 0, contentHash: '', provenance: 'unknown' }
}

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
  const decisionOmissions: MaterialDecisionOmittedSource[] = []
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
  const recordDecisionOmission = async (input: {
    sourceId: string
    revision: number
    contentHash?: string
    text?: string
    reason: MaterialDecisionOmittedSource['reason']
    category: MaterialDecisionOmittedSource['category']
    required?: boolean
  }): Promise<void> => {
    decisionOmissions.push({
      sourceId: input.sourceId,
      revision: input.revision,
      contentHash: input.contentHash ?? await hashAuthorText(input.text ?? ''),
      reason: input.reason,
      category: input.category,
      required: input.required ?? false,
    })
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
      await recordDecisionOmission({
        sourceId: `finalized:${source.draftId}`,
        revision: source.draftId,
        text: source.content,
        reason: 'source-invalid',
        category: 'finalized-history',
      })
      continue
    }
    const extracted = finalizedPassages(source, input.relevanceTerms)
    const expectedEvidence = source.evidence.filter(value => value.trim()).length
    const hasUnlocatedEvidence = extracted.locatedEvidence < expectedEvidence
    if (hasUnlocatedEvidence) {
      omissions.push({
        source: 'finalized',
        chapterNumber: source.chapterNumber,
        reason: 'evidence-not-locatable',
      })
    }
    if (extracted.passages.length === 0) {
      await recordDecisionOmission({
        sourceId: `finalized:${source.draftId}`,
        revision: source.draftId,
        text: source.content,
        reason: hasUnlocatedEvidence ? 'evidence-not-locatable' : 'no-relevant-passage',
        category: 'finalized-history',
      })
      continue
    }
    const selected = await push({
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
    if (hasUnlocatedEvidence && selected) {
      await recordDecisionOmission({
        sourceId: selected.ref.sourceId,
        revision: selected.ref.revision,
        contentHash: selected.ref.contentHash,
        reason: 'evidence-not-locatable',
        category: selected.category,
      })
    }
  }

  // ---- 未定稿候选 ----
  const orderedCandidates = [...input.candidates].sort((left, right) => left.chapterNumber - right.chapterNumber)
  const explicitRequiredCandidates = orderedCandidates.filter(candidate => candidate.required === true)
  if (orderedCandidates.length > 1 && explicitRequiredCandidates.length !== 1) {
    throw new Error('CHAPTER_MATERIAL_REQUIRED_PREDECESSOR_AMBIGUOUS')
  }
  // Legacy callers supplied only the direct predecessor and had no marker. Keep
  // that case required; larger sets must identify the one authoritative predecessor.
  const requiredPredecessor = orderedCandidates.length === 1
    ? orderedCandidates[0]
    : explicitRequiredCandidates[0]
  let requiredPredecessorMaterial: MaterialCandidate | undefined
  for (const candidate of orderedCandidates) {
    const isRequired = candidate === requiredPredecessor
    const passages = candidatePassages(candidate, isRequired, input.relevanceTerms)
    if (passages.length === 0) {
      omissions.push({ source: 'candidate', chapterNumber: candidate.chapterNumber, reason: 'no-relevant-passage' })
      await recordDecisionOmission({
        sourceId: `candidate:${candidate.draftId}`,
        revision: candidate.version,
        text: candidate.content,
        reason: 'no-relevant-passage',
        category: 'finalized-history',
        required: isRequired,
      })
      continue
    }
    const material = await push({ family: 'candidate', chapterNumber: candidate.chapterNumber, locatedEvidence: 0, passages: [] }, {
      sourceId: `candidate:${candidate.draftId}`,
      revision: candidate.version,
      text: promptLanguageText(
        writingLanguage,
        `【未定稿候选 · 第${candidate.chapterNumber}章 · draft ${candidate.draftId} · v${candidate.version}】\n${passages.join('\n\n')}`,
        `[Unfinalized candidate · Chapter ${candidate.chapterNumber} · draft ${candidate.draftId} · v${candidate.version}]\n${passages.join('\n\n')}`,
      ),
      category: 'finalized-history',
      provenance: 'author',
      required: isRequired,
    })
    if (isRequired) requiredPredecessorMaterial = material
  }
  if (requiredPredecessor && !requiredPredecessorMaterial) {
    throw new ChapterMaterialCapacityError({
      decision: 'capacity-conflict',
      blockingSourceId: `candidate:${requiredPredecessor.draftId}`,
      blockingReason: 'invalid-source-ref',
      omissions: [],
      coverage: { required: 2, included: 0, complete: false },
    }, writingLanguage)
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
    else {
      await recordDecisionOmission({
        sourceId: `reference:${referenceIndex}`,
        revision: 1,
        text: reference.rendered,
        reason: 'no-relevant-passage',
        category: 'reference',
      })
    }
  }

  // 单位在这里统一：旧遍历按 UTF-16 码元、合同按 UTF-8 字节，容量用码元预算按写作语言
  // 主要字符集换算出的字节数表示，估算器版本与 context-snapshot 冻结的 utf8-bytes-v1 一致。
  const capacity = {
    maxInputUnits: (input.budgetChars ?? MATERIAL_BUDGET_CHARS) * BYTES_PER_BUDGET_CHAR[writingLanguage],
    methodVersion: MATERIAL_DECISION_UNIT_METHOD_VERSION,
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
      await recordDecisionOmission({
        sourceId: candidate.ref.sourceId,
        revision: candidate.ref.revision,
        contentHash: candidate.ref.contentHash,
        reason: 'deduplicated-against-finalized',
        category: candidate.category,
      })
    }
  }

  // ---- 权威裁决：这一步的结果就是提示词，别处不再有第二条准入路径 ----
  const selection = selectChapterSources({
    current: input.identity,
    capacity,
    relevanceTerms: input.relevanceTerms,
    candidates: candidates.filter(item => !droppedReferences.has(item)),
  })
  if (selection.decision !== 'ready') {
    const omission = selection.omissions.find(item => (
      [requiredCandidate, requiredPredecessorMaterial].some(material => material
        && item.sourceId === material.ref.sourceId
        && item.revision === material.ref.revision
        && item.contentHash === material.ref.contentHash)
    ))
    if (omission) {
      throw new ChapterMaterialCapacityError({
        decision: 'capacity-conflict',
        blockingSourceId: omission.sourceId,
        blockingReason: omission.reason,
        omissions: selection.omissions,
        coverage: selection.coverage,
      }, writingLanguage)
    }
  }
  if (selection.decision !== 'ready') throw new ChapterMaterialCapacityError(selection, writingLanguage)

  // 渲染：块头沿用各族原有的模板（在构造候选时就已经套好，这里不做二次改写），
  // 顺序就是合同的顺序——必需材料在前，其后按相关度与规范全序。
  // 必需材料按**内容哈希**结算覆盖，`ready` 意味着该哈希已被某条 included 材料覆盖，
  // 所以这里按哈希取回的就是实际进入提示词的那一份（同内容被兄弟来源满足时也一样）。
  const requiredBlock = requiredCandidate
    ? selection.included.find(item => item.ref.contentHash === requiredCandidate.ref.contentHash)?.text ?? ''
    : ''
  const sourcedBlocks = selection.included
    .filter(item => item.ref.sourceId !== REQUIRED_SOURCE_ID)
    .map(item => item.text)

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

  const endingSource = requiredPredecessor
    ? undefined
    : input.finalized.find(source => source.includeEnding && source.content.trim())
  if (endingSource && !consumedFinalizedSources.some(source => source.draftId === endingSource.draftId)) {
    // The ending also affects replay rejection even when its prompt block exceeded the budget.
    consumedFinalizedSources.push(endingSource)
  }

  return {
    selection,
    decision: buildMaterialDecisionReceipt(selection, capacity, decisionOmissions),
    text: [requiredBlock, sourced, ...sourcedBlocks, gap].filter(Boolean).join('\n\n'),
    previousEnding: requiredPredecessor
      ? previousChapterEnding(requiredPredecessor.content)
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
