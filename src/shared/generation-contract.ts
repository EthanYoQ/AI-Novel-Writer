import { hashAuthorText, isContentHash, sameProjectEpoch, type FrozenInputFingerprint, type ProjectEpoch } from './source-ref'

export interface RootAction extends ProjectEpoch {
  rootActionId: string; operation: string; uiActionNonce: string; frozenInputHash: string
  status: 'active' | 'paused' | 'cancelled' | 'sealed'
}
export interface GenerationRun extends ProjectEpoch {
  runId: string; rootActionId: string; fingerprint: FrozenInputFingerprint
  activeElapsedMs: number; status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
}
export interface PhysicalAttempt {
  attemptId: string; reservationId: string; rootActionId: string
  status: 'reserved' | 'dispatch-marked' | 'settled' | 'unknown' | 'cancelled-before-dispatch'
  reservedTokens: number
  requestedOutputTokens: number
  /** Actual usage is never clipped to the estimate. */
  actualTokens?: number
}
export interface RootBudget {
  maxPhysicalRequests: number; maxTokenLiability: number; maxOutputPerRequest: number
  maxActiveElapsedMs: number
}
export interface ProviderUsagePolicy {
  estimatorVersion: string; safetyMarginTokens: number
  reasoning: 'included-in-completion' | 'separately-billed' | 'unknown'
  canBoundTotalLiability: boolean
}
export interface VisibleArtifact extends ProjectEpoch {
  artifactId: string; attemptId: string; rootActionId: string
  revision: number; text: string; textHash: string; fingerprint: FrozenInputFingerprint
}
export function rootActionIdempotencyKey(action: RootAction): string {
  if (![action.projectId, action.epoch, action.operation, action.uiActionNonce, action.rootActionId].every(value => Boolean(value.trim()))
    || !isContentHash(action.frozenInputHash)) throw new Error('INVALID_ROOT_ACTION')
  // Reopening a renderer/session cannot turn the same author nonce into a new budget root.
  return JSON.stringify([action.projectId, action.operation, action.uiActionNonce, action.frozenInputHash])
}
export function tokenLiability(attempt: PhysicalAttempt): number {
  return attempt.status === 'cancelled-before-dispatch' ? 0
    : attempt.status === 'settled' && attempt.actualTokens !== undefined ? attempt.actualTokens : attempt.reservedTokens
}
/** Must run in the root ledger transaction before inserting a unique reservation. */
export function assertReservation(root: RootAction, policy: RootBudget, attempts: readonly PhysicalAttempt[], next: PhysicalAttempt, elapsedMs: number): void {
  rootActionIdempotencyKey(root)
  const integers = [policy.maxPhysicalRequests, policy.maxTokenLiability, policy.maxOutputPerRequest, policy.maxActiveElapsedMs, next.reservedTokens, next.requestedOutputTokens]
  if (integers.some(value => !Number.isSafeInteger(value) || value <= 0) || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error('INVALID_BUDGET')
  if (root.status !== 'active' || next.rootActionId !== root.rootActionId || !next.attemptId || !next.reservationId || next.status !== 'reserved') throw new Error('INVALID_RESERVATION')
  if (next.requestedOutputTokens > policy.maxOutputPerRequest || next.reservedTokens < next.requestedOutputTokens) throw new Error('INVALID_OUTPUT_RESERVATION')
  if (attempts.some(item => item.rootActionId !== root.rootActionId || item.attemptId === next.attemptId || item.reservationId === next.reservationId)) throw new Error('RESERVATION_CONFLICT')
  if (attempts.some(item => !Number.isSafeInteger(item.reservedTokens) || item.reservedTokens <= 0
    || item.actualTokens !== undefined && (!Number.isSafeInteger(item.actualTokens) || item.actualTokens < 0))) throw new Error('INVALID_LEDGER')
  if (new Set(attempts.map(item => item.attemptId)).size !== attempts.length
    || new Set(attempts.map(item => item.reservationId)).size !== attempts.length
    || attempts.some(item => !['reserved', 'dispatch-marked', 'settled', 'unknown', 'cancelled-before-dispatch'].includes(item.status))) throw new Error('INVALID_LEDGER')
  if (attempts.some(item => item.actualTokens !== undefined && item.actualTokens > item.reservedTokens)) throw new Error('USAGE_EXCEEDED_RESERVATION')
  if (attempts.filter(item => item.status !== 'cancelled-before-dispatch').length >= policy.maxPhysicalRequests
    || attempts.reduce((sum, item) => sum + tokenLiability(item), 0) + next.reservedTokens > policy.maxTokenLiability
    || elapsedMs >= policy.maxActiveElapsedMs) throw new Error('ROOT_BUDGET_EXHAUSTED')
}
export function assertAttemptTransition(before: PhysicalAttempt['status'], after: PhysicalAttempt['status']): void {
  if (!(before === 'reserved' && ['dispatch-marked', 'cancelled-before-dispatch'].includes(after)
    || before === 'dispatch-marked' && ['settled', 'unknown'].includes(after))) throw new Error('INVALID_ATTEMPT_TRANSITION')
}
/** CAS/prefix check only; durable acknowledgement belongs to the repository. */
export async function assertVisibleSnapshot(previous: VisibleArtifact, next: VisibleArtifact, expectedRevision: number): Promise<void> {
  if (![previous.artifactId, previous.attemptId, previous.rootActionId].every(id => Boolean(id.trim()))
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || !Number.isSafeInteger(next.revision) || !Number.isSafeInteger(previous.revision)
    || !sameProjectEpoch(previous, next) || previous.artifactId !== next.artifactId || previous.attemptId !== next.attemptId
    || previous.rootActionId !== next.rootActionId || previous.revision !== expectedRevision || next.revision !== expectedRevision + 1
    || !next.text.startsWith(previous.text) || !isContentHash(next.textHash)
    || await hashAuthorText(previous.text) !== previous.textHash || await hashAuthorText(next.text) !== next.textHash
    || JSON.stringify(previous.fingerprint) !== JSON.stringify(next.fingerprint)) throw new Error('ARTIFACT_SNAPSHOT_CONFLICT')
}
