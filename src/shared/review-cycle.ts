import { isContentHash, type SourceRef } from './source-ref'

export type ReviewFindingStatus = 'unverified' | 'unresolved' | 'unknown' | 'resolved' | 'author-waived'
export interface ReviewFinding {
  findingId: string; source: SourceRef; excerptHash: string; occurrence: number
  category: string; targetId: string; kind: 'objective' | 'literary'; status: ReviewFindingStatus
}
export interface ReviewCycle {
  cycleId: string; rootActionId: string; sourceHash: string; findingSetHash: string
  revisionStatus: 'not-generated' | 'generated' | 'merge-committed'
  mergedHash?: string; recheckCount: 0 | 1
}
export interface ReviewCycleFindingProjection {
  findingId: string
  reviewItemIndex: number | null
  category: string
  kind: 'objective' | 'literary'
  status: ReviewFindingStatus
  targetId?: string
}
export interface ReviewCycleProjection {
  cycleId: string
  reviewId: number
  revisionStatus: 'not-generated' | 'generated' | 'merge-committed'
  mergedHash?: string
  recheckCount: 0 | 1
  recheckDisposition?: 'required' | 'not-required' | 'completed'
  findings: ReviewCycleFindingProjection[]
}

export interface ReviewCycleRecheckFinding {
  findingId: string
  targetId: string
  category: string
  kind: 'objective' | 'literary'
  /** Immutable human-readable problem statement from the original saved review. */
  problem: string
  /** Optional original goal semantics that the merged draft must actually satisfy. */
  expected?: string
  sourceSpan: { start: number; end: number; unit: 'utf16-code-unit' }
  occurrence: number
  sourceExcerpt: string
}

export interface ReviewCycleRecheckContext {
  /** v1 trusted a model's positive semantic judgment after quote anchoring; v2 keeps it pending author verification. */
  version: 1 | 2
  cycleId: string
  comparisonVersion: number
  mergedHash: string
  findingSetHash: string
  findings: readonly ReviewCycleRecheckFinding[]
}

export interface ReviewCycleRecheckModelItem {
  findingId: string
  targetId: string
  resolved: boolean
  evidenceQuote: string
  reason: string
}

export interface ReviewCycleRecheckDecision {
  findingId: string
  targetId: string
  status: 'resolved' | 'unresolved' | 'unknown'
  reviewItemIndex: number
  resolved?: boolean
}

export interface ReviewCycleRecheckReport {
  summary: string
  items: Array<Record<string, unknown>>
  decisions: ReviewCycleRecheckDecision[]
  validModelOutput: boolean
}
export function isNoopRevision(before: string, after: string): boolean {
  const visible = (value: string): string => value.replace(/[\p{White_Space}\p{Cf}]/gu, '')
  return visible(before) === visible(after)
}

function countOccurrences(text: string, excerpt: string): number {
  if (!excerpt) return 0
  let count = 0
  for (let offset = 0; offset <= text.length;) {
    const found = text.indexOf(excerpt, offset)
    if (found < 0) break
    count += 1
    offset = found + Math.max(1, excerpt.length)
  }
  return count
}

const objectiveText = (value: string): string => value.replace(/[^\p{L}\p{N}]/gu, '')

/** Deterministic admission only: unchanged or ambiguous evidence never spends a model request. */
export function classifyFindingEvidenceChange(source: string, merged: string,
  finding: ReviewCycleRecheckFinding): 'changed' | 'unchanged' | 'ambiguous' {
  const span = finding.sourceSpan
  if (span.unit !== 'utf16-code-unit' || !Number.isSafeInteger(span.start) || span.start < 0
    || !Number.isSafeInteger(span.end) || span.end <= span.start || span.end > source.length
    || !Number.isSafeInteger(finding.occurrence) || finding.occurrence < 1) return 'ambiguous'
  const excerpt = source.slice(span.start, span.end)
  if (!excerpt || countOccurrences(source, excerpt) < finding.occurrence) return 'ambiguous'
  if (isNoopRevision(source, merged)) return 'unchanged'
  if (finding.kind === 'objective') {
    const objectiveExcerpt = objectiveText(excerpt)
    return objectiveExcerpt && objectiveText(merged).includes(objectiveExcerpt) ? 'unchanged' : 'changed'
  }
  return merged.includes(excerpt) ? 'unchanged' : 'changed'
}

function parseRecheckItems(content: string): { summary: string; items: ReviewCycleRecheckModelItem[] } | null {
  try {
    const trimmed = content.trim()
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
    const parsed = JSON.parse(fenced?.[1]?.trim() ?? trimmed) as Record<string, unknown>
    if (!parsed || Array.isArray(parsed) || Object.keys(parsed).some(key => !['summary', 'items'].includes(key))
      || typeof parsed.summary !== 'string' || !parsed.summary.trim() || !Array.isArray(parsed.items)) return null
    const items: ReviewCycleRecheckModelItem[] = []
    for (const item of parsed.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const row = item as Record<string, unknown>
      if (Object.keys(row).some(key => !['findingId', 'targetId', 'resolved', 'evidenceQuote', 'reason'].includes(key))
        || typeof row.findingId !== 'string' || !row.findingId.trim()
        || typeof row.targetId !== 'string' || !row.targetId.trim()
        || typeof row.resolved !== 'boolean' || typeof row.evidenceQuote !== 'string' || !row.evidenceQuote.trim()
        || typeof row.reason !== 'string' || !row.reason.trim()) return null
      items.push({ findingId: row.findingId, targetId: row.targetId, resolved: row.resolved,
        evidenceQuote: row.evidenceQuote, reason: row.reason })
    }
    return { summary: parsed.summary.trim(), items }
  } catch { return null }
}

/** Canonicalizes valid, missing, duplicate, or malformed model output without ever inventing a green result. */
export function buildReviewCycleRecheckReport(content: string, merged: string,
  context: ReviewCycleRecheckContext, uiLocale: 'zh-CN' | 'en-US'): ReviewCycleRecheckReport {
  const parsed = parseRecheckItems(content)
  const counts = new Map<string, number>()
  for (const item of parsed?.items ?? []) counts.set(item.findingId, (counts.get(item.findingId) ?? 0) + 1)
  const items: Array<Record<string, unknown>> = []
  const decisions: ReviewCycleRecheckDecision[] = []
  for (const finding of context.findings) {
    const candidate = counts.get(finding.findingId) === 1
      ? parsed?.items.find(item => item.findingId === finding.findingId) : undefined
    const evidenceCount = candidate ? countOccurrences(merged, candidate.evidenceQuote) : 0
    const valid = candidate?.targetId === finding.targetId && evidenceCount === 1
    const reviewItemIndex = items.length
    if (!valid || !candidate) {
      items.push({ category: finding.category, severity: 'unknown', findingId: finding.findingId,
        targetId: finding.targetId, description: uiLocale === 'en-US'
          ? 'The recheck did not provide unique, verifiable evidence.' : '复核未提供唯一且可验证的新证据。' })
      decisions.push({ findingId: finding.findingId, targetId: finding.targetId, status: 'unknown', reviewItemIndex })
      continue
    }
    if (context.version === 2 && candidate.resolved) {
      items.push({ category: finding.category, severity: 'unknown', findingId: finding.findingId,
        targetId: finding.targetId, description: uiLocale === 'en-US'
          ? `The model supplied anchored evidence, but semantic resolution still requires author verification. ${candidate.reason}`
          : `模型提供了可定位的新证据，但是否实质解决仍需作者核实。${candidate.reason}`,
        quote: candidate.evidenceQuote, resolved: false })
      decisions.push({ findingId: finding.findingId, targetId: finding.targetId, status: 'unknown', reviewItemIndex })
      continue
    }
    items.push({ category: finding.category, severity: candidate.resolved ? 'pass' : 'warning',
      findingId: finding.findingId, targetId: finding.targetId, description: candidate.reason,
      quote: candidate.evidenceQuote, resolved: candidate.resolved })
    decisions.push({ findingId: finding.findingId, targetId: finding.targetId,
      status: candidate.resolved ? 'resolved' : 'unresolved', reviewItemIndex, resolved: candidate.resolved })
  }
  return { summary: parsed?.summary.trim() || (uiLocale === 'en-US'
    ? 'The recheck output was invalid; affected findings remain unknown.' : '复核输出无效；受影响项目保持待核实。'),
    items, decisions, validModelOutput: Boolean(parsed) }
}
export function findingAnchorKey(finding: ReviewFinding): string {
  const span = finding.source.span
  if (!isContentHash(finding.source.contentHash) || !isContentHash(finding.excerptHash) || !finding.source.span
    || !span || span.unit !== 'utf16-code-unit' || !Number.isSafeInteger(span.start) || span.start < 0
    || !Number.isSafeInteger(span.end) || span.end <= span.start
    || !finding.source.projectId || !finding.source.epoch || !finding.source.sourceId
    || !Number.isSafeInteger(finding.source.revision) || finding.source.revision < 0
    || !Number.isSafeInteger(finding.occurrence) || finding.occurrence < 1 || !finding.category || !finding.targetId) throw new Error('UNVERIFIED_FINDING')
  return JSON.stringify([finding.source.contentHash, finding.source.span, finding.occurrence, finding.excerptHash, finding.category, finding.targetId])
}
export function decideFindingStatus(input: {
  uniqueAnchor: boolean; relevantHunkChanged: boolean; noop: boolean
  authorWaived: boolean; mergedHash: string; findingSetHash: string
  recheck?: { mergedHash: string; findingSetHash: string; newEvidenceHash: string; targetId: string; resolved: boolean }
  targetId: string
}): ReviewFindingStatus {
  if (!isContentHash(input.mergedHash) || !isContentHash(input.findingSetHash) || !input.targetId.trim()) return 'unknown'
  if (input.authorWaived) return 'author-waived'
  if (!input.uniqueAnchor) return 'unverified'
  if (input.noop || !input.relevantHunkChanged) return 'unresolved'
  const check = input.recheck
  if (!check || !isContentHash(check.newEvidenceHash) || check.mergedHash !== input.mergedHash
    || check.findingSetHash !== input.findingSetHash || check.targetId !== input.targetId) return 'unknown'
  return check.resolved ? 'resolved' : 'unresolved'
}
export function assertSingleRecheck(cycle: ReviewCycle): void {
  if (cycle.recheckCount !== 0 || cycle.revisionStatus !== 'merge-committed' || !cycle.mergedHash || !isContentHash(cycle.mergedHash)) throw new Error('RECHECK_NOT_ALLOWED')
}
