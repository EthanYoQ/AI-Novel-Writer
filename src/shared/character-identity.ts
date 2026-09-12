import type { CharacterStateFieldProvenance, CharacterStateTextField } from './character-roster'
import type { FinalizedSourceIdentity } from './finalized-continuity'
import { isContentHash, isFinalizedSourceIdentity, sameProjectEpoch, type ProjectEpoch } from './source-ref'

export type CharacterResolution =
  | { status: 'resolved'; characterId: string }
  | { status: 'ambiguous'; candidateIds: readonly string[]; originalText: string }
  | { status: 'unresolved'; originalText: string }
export interface CharacterAlias extends ProjectEpoch {
  characterId: string; displayText: string; sourceId: string; fromRevision: number; toRevision?: number
}
/** Input candidates come from a project/source-scoped exact alias lookup; never similarity. */
export function resolveCharacterIdentity(originalText: string, candidateIds: readonly string[]): CharacterResolution {
  if (!originalText || candidateIds.some(id => !id)) throw new Error('INVALID_CHARACTER_LOOKUP')
  const unique = [...new Set(candidateIds)]
  return unique.length === 1 ? { status: 'resolved', characterId: unique[0]! }
    : unique.length > 1 ? { status: 'ambiguous', candidateIds: unique, originalText }
      : { status: 'unresolved', originalText }
}
export function assertCharacterResolution(resolution: CharacterResolution, exactCandidateIds: readonly string[]): void {
  const ids = [...new Set(exactCandidateIds)]
  if (ids.some(id => !id) || !(resolution.status === 'resolved' && ids.length === 1 && resolution.characterId === ids[0]
    || resolution.status === 'unresolved' && ids.length === 0 && Boolean(resolution.originalText)
    || resolution.status === 'ambiguous' && ids.length > 1 && Boolean(resolution.originalText)
      && resolution.candidateIds.length === ids.length && new Set(resolution.candidateIds).size === ids.length
      && resolution.candidateIds.every(id => ids.includes(id)))) throw new Error('INVALID_CHARACTER_RESOLUTION')
}
export interface CharacterProposal extends ProjectEpoch {
  proposalId: string; resolution: CharacterResolution
  origin: 'generated' | 'derived' | 'legacy'; status: 'pending' | 'accepted' | 'rejected'
  sourceHash: string
}
export interface DerivedSourceOrder {
  continuityEpoch: string; chapterNumber: number; authoritativeFinalizationRevision: number
}
export interface CharacterFieldSnapshot extends ProjectEpoch {
  characterId: string; field: CharacterStateTextField; revision: number; value: string; valueHash: string
  provenance: CharacterStateFieldProvenance; sourceOrder?: DerivedSourceOrder
}
export interface DerivedCharacterPatch extends ProjectEpoch {
  characterId: string; field: CharacterStateTextField; value: string; valueHash: string
  baseFieldRevision: number; baseValueHash: string; baseProvenance: CharacterStateFieldProvenance
  source: FinalizedSourceIdentity; sourceOrder: DerivedSourceOrder
}
const sameSource = (a: FinalizedSourceIdentity, b: FinalizedSourceIdentity): boolean =>
  a.draftId === b.draftId && a.finalizationId === b.finalizationId && a.chapterNumber === b.chapterNumber && a.contentHash === b.contentHash
const sameProvenance = (a: CharacterStateFieldProvenance, b: CharacterStateFieldProvenance): boolean =>
  a.kind === 'legacy' && b.kind === 'legacy'
  || a.kind === 'author' && b.kind === 'author' && a.chapterNumber === b.chapterNumber
  || a.kind === 'derived' && b.kind === 'derived' && sameSource(a.source, b.source)
export type DerivedPatchDecision = 'apply-derived' | 'already-applied' | 'proposal-required' | 'source-conflict' | 'field-conflict'
/** Caller recomputes hashes and reads field/authority in the same synchronous commit transaction. */
export function decideDerivedPatch(current: CharacterFieldSnapshot, patch: DerivedCharacterPatch,
  authority: { source: FinalizedSourceIdentity; order: DerivedSourceOrder }): DerivedPatchDecision {
  const order = patch.sourceOrder
  if (!sameProjectEpoch(current, patch) || !isFinalizedSourceIdentity(patch.source) || !isFinalizedSourceIdentity(authority.source) || !sameSource(patch.source, authority.source)
    || !isContentHash(patch.source.contentHash) || !order.continuityEpoch
    || order.continuityEpoch !== authority.order.continuityEpoch || order.chapterNumber !== authority.order.chapterNumber
    || order.chapterNumber !== patch.source.chapterNumber || order.authoritativeFinalizationRevision !== authority.order.authoritativeFinalizationRevision
    || !Number.isSafeInteger(order.chapterNumber) || order.chapterNumber < 1
    || !Number.isSafeInteger(order.authoritativeFinalizationRevision) || order.authoritativeFinalizationRevision < 1) return 'source-conflict'
  if (current.characterId !== patch.characterId || current.field !== patch.field || !patch.characterId
    || !isContentHash(patch.valueHash) || !isContentHash(patch.baseValueHash)
    || !Number.isSafeInteger(current.revision) || current.revision < 0) return 'field-conflict'
  const previous = current.sourceOrder
  if (current.provenance.kind === 'derived' && (!previous
    || previous.chapterNumber !== current.provenance.source.chapterNumber)) return 'source-conflict'
  if (previous && (!previous.continuityEpoch || !Number.isSafeInteger(previous.chapterNumber) || previous.chapterNumber < 1
    || !Number.isSafeInteger(previous.authoritativeFinalizationRevision) || previous.authoritativeFinalizationRevision < 1)) return 'source-conflict'
  if (previous && (previous.continuityEpoch !== order.continuityEpoch || previous.chapterNumber > order.chapterNumber
    || previous.chapterNumber === order.chapterNumber && previous.authoritativeFinalizationRevision > order.authoritativeFinalizationRevision)) return 'source-conflict'
  if (current.provenance.kind === 'derived' && sameSource(current.provenance.source, patch.source)
    && current.valueHash === patch.valueHash) return 'already-applied'
  if (current.revision !== patch.baseFieldRevision || current.valueHash !== patch.baseValueHash
    || !sameProvenance(current.provenance, patch.baseProvenance)) return 'field-conflict'
  if (current.provenance.kind !== 'derived' && !(current.provenance.kind === 'legacy' && current.value === '')) return 'proposal-required'
  return 'apply-derived'
}
/** Exact source/value-scoped dedupe; a new finalization source may propose again. */
export function rejectedCharacterProposalKey(patch: DerivedCharacterPatch): string {
  return JSON.stringify([patch.projectId, patch.characterId, patch.field, patch.source.contentHash, patch.valueHash])
}
