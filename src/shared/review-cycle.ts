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
export function isNoopRevision(before: string, after: string): boolean {
  const visible = (value: string): string => value.replace(/[\p{White_Space}\p{Cf}]/gu, '')
  return visible(before) === visible(after)
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
