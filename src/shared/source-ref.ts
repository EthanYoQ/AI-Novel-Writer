import type { FinalizedSourceIdentity } from './finalized-continuity'

/** S01 seam only: repositories remain the sole source of author data. */
export interface ProjectEpoch { projectId: string; epoch: string }
export interface SourceRef extends ProjectEpoch {
  sourceId: string
  revision: number
  /** SHA-256 of the unmodified UTF-8 bytes; never normalized author prose. */
  contentHash: string
  /** Editor offsets are UTF-16 code units, end exclusive. */
  span?: { start: number; end: number; unit: 'utf16-code-unit' }
}
export const isContentHash = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value)
export function isFinalizedSourceIdentity(source: FinalizedSourceIdentity): boolean {
  return Boolean(source.finalizationId.trim()) && Number.isSafeInteger(source.draftId) && source.draftId > 0
    && Number.isSafeInteger(source.chapterNumber) && source.chapterNumber > 0 && isContentHash(source.contentHash)
}
export const sameProjectEpoch = (a: ProjectEpoch, b: ProjectEpoch): boolean =>
  Boolean(a.projectId && a.epoch) && a.projectId === b.projectId && a.epoch === b.epoch

export async function hashAuthorText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function validateSourceRef(ref: SourceRef, current: ProjectEpoch, text: string): Promise<boolean> {
  const span = ref.span
  return sameProjectEpoch(ref, current) && Boolean(ref.sourceId)
    && Number.isSafeInteger(ref.revision) && ref.revision >= 0
    && isContentHash(ref.contentHash) && await hashAuthorText(text) === ref.contentHash
    && (!span || (span.unit === 'utf16-code-unit' && Number.isSafeInteger(span.start)
      && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= text.length))
}
export interface FrozenInputFingerprint {
  chapterBriefHash: string; authorGuidanceHash: string; dependencyHash: string
  contextSnapshotHash: string; templateHash: string; skillSnapshotHash: string
  modelLeaseRevision: string; policyHash: string; outputContractHash: string
}
export type CandidateState = 'draft' | 'partial' | 'recovery' | 'source-conflict' | 'discarded' | 'stale' | 'replaced'
export interface CandidateSource extends ProjectEpoch {
  artifactId: string; revision: number; state: CandidateState; saved: boolean
  batchLineage: string; fingerprint: FrozenInputFingerprint
}
export interface CandidateAdmission extends ProjectEpoch {
  batchLineage: string; selectedCurrentDraftId?: string; directPredecessorId?: string
}
/** Only author-selected current drafts or the saved direct predecessor may enter context. */
export function mayUseCandidate(candidate: CandidateSource, admission: CandidateAdmission): boolean {
  return sameProjectEpoch(candidate, admission) && candidate.state === 'draft' && candidate.saved
    && Boolean(candidate.artifactId) && Number.isSafeInteger(candidate.revision) && candidate.revision >= 0
    && (admission.selectedCurrentDraftId === candidate.artifactId
      || (Boolean(admission.batchLineage) && candidate.batchLineage === admission.batchLineage
        && admission.directPredecessorId === candidate.artifactId))
}
export interface ContextSnapshot extends ProjectEpoch {
  id: string; hash: string
  sources: readonly { ref: SourceRef; slot: 'finalized-fact' | 'unconfirmed-continuity' | 'author-constraint'; reason: string }[]
  omissions: readonly { sourceId: string; reason: string; required: boolean }[]
  estimate: { methodVersion: string; inputUnits: number }
}
