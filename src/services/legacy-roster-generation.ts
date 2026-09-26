import { ipc } from './ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { LegacyRosterGenerationRecovery } from '../shared/legacy-roster-generation'
import type { MainGenerationRunHandle } from './generation/generation-runtime'

const sameRun = (a: MainGenerationRunHandle, b: MainGenerationRunHandle) => a.projectId === b.projectId && a.rootActionId === b.rootActionId && a.runId === b.runId
export function canContinueLegacyRoster(current: LegacyRosterGenerationRecovery) {
  const latest = (current.view.candidates ?? current.view.artifacts).at(-1)
  return current.sourceStatus === 'current' && current.view.status !== 'cancelled'
    && (!!current.proposal || !!current.artifact || current.attemptCount === 0
      || !!latest && (latest.status === 'completed' || latest.status === 'failed') && latest.compositionEligible === true)
}
/** Main alone owns the fixed task, bounded repairs, source proof and proposal. */
export function createLegacyRosterGeneration(sessionInput: ProjectSessionContext, assertActive: () => void = () => {}) {
  const session = Object.freeze({ ...sessionInput })
  let recovery: LegacyRosterGenerationRecovery | undefined
  let detached = false
  let cancelled = false
  let cancelPromise: Promise<void> | undefined
  let opening: Promise<LegacyRosterGenerationRecovery> | undefined
  const validate = (value: LegacyRosterGenerationRecovery, expected?: MainGenerationRunHandle) => {
    if (value.view.handle.projectId !== session.projectId || value.context.projectId !== session.projectId
      || typeof value.view.handle.epoch !== 'string' || !value.view.handle.epoch
      || expected && !sameRun(expected, value.view.handle)) throw new Error('LEGACY_ROSTER_GENERATION_IDENTITY_MISMATCH')
    return value
  }
  const read = async () => {
    if (!recovery) throw new Error('LEGACY_ROSTER_GENERATION_NOT_OPEN')
    recovery = validate(await ipc.invokeWithProjectSession(session, 'legacy-roster:read', { handle: recovery.view.handle }), recovery.view.handle)
    return recovery
  }
  const cancelKnown = async () => {
    if (!recovery) return
    const view = await ipc.invokeWithProjectSession(session, 'legacy-roster:cancel', { handle: recovery.view.handle })
    if (!sameRun(view.handle, recovery.view.handle)) throw new Error('LEGACY_ROSTER_GENERATION_IDENTITY_MISMATCH')
    recovery.view = view
  }
  return {
    read,
    open(request: { handle: MainGenerationRunHandle } | { modelId: string; uiActionNonce: string }) {
      if (opening) throw new Error('LEGACY_ROSTER_GENERATION_ALREADY_OPEN')
      opening = (async () => {
        assertActive()
        recovery = validate('handle' in request
          ? await ipc.invokeWithProjectSession(session, 'legacy-roster:read', request)
          : await ipc.invokeWithProjectSession(session, 'legacy-roster:begin', request), 'handle' in request ? request.handle : undefined)
        assertActive()
        if (cancelled) { throw new Error('LEGACY_ROSTER_GENERATION_CANCELLED') }
        if (detached) throw new Error('LEGACY_ROSTER_GENERATION_DETACHED')
        return recovery
      })()
      return opening
    },
    async execute() {
      const current = await read()
      assertActive()
      if (detached || cancelled) throw new Error('LEGACY_ROSTER_GENERATION_DETACHED')
      if (current.proposal || current.artifact) return current
      if (!canContinueLegacyRoster(current)) throw new Error('LEGACY_ROSTER_GENERATION_OUTCOME_UNKNOWN')
      if (current.sourceStatus !== 'current' || current.view.status === 'cancelled') throw new Error('LEGACY_ROSTER_GENERATION_SOURCE_CONFLICT')
      // Main replays cached ordinals and alone decides whether a known malformed
      // stop can use one of the original finite repair attempts.
      const receipt = await ipc.invokeWithProjectSession(session, 'legacy-roster:execute', { handle: current.view.handle })
      if (!sameRun(receipt.run.handle, current.view.handle)) throw new Error('LEGACY_ROSTER_GENERATION_IDENTITY_MISMATCH')
      assertActive()
      if (detached || cancelled) throw new Error('LEGACY_ROSTER_GENERATION_CANCELLED')
      return read()
    },
    async stage() {
      const current = await read()
      assertActive()
      if (current.proposal) return current.proposal
      if (detached || cancelled || current.sourceStatus !== 'current' || current.view.status === 'cancelled' || !current.artifact) throw new Error('LEGACY_ROSTER_GENERATION_NOT_STAGEABLE')
      return ipc.invokeWithProjectSession(session, 'legacy-roster:stage', { handle: current.view.handle, artifact: current.artifact })
    },
    async cancel() { cancelled = true; cancelPromise ??= (async () => { if (opening) await opening.catch(() => {}); await cancelKnown() })(); await cancelPromise },
    detach() { detached = true },
  }
}
