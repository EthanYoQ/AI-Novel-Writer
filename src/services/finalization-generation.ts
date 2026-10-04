import { ipc } from './ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { FinalizationGenerationSlot, FinalizationGenerationRecovery } from '../shared/finalization-generation'
import type { MainGenerationRunHandle } from './generation/generation-runtime'

/** Reuses one durable main slot. Saved effects never rebuild prompts or execute. */
export async function runFinalizationGeneration(options: {
  session: ProjectSessionContext
  slot: FinalizationGenerationSlot
  modelId: () => string
  parentRootActionId?: string
  cancelled: () => boolean
  onHandle?: (handle: MainGenerationRunHandle) => void
}) {
  const session = Object.freeze({ ...options.session })
  let recovery: FinalizationGenerationRecovery | null = null
  let cancelPromise: Promise<unknown> | undefined
  const cancel = () => {
    if (recovery && !cancelPromise) cancelPromise = ipc.invokeWithProjectSession(session, 'finalization-generation:cancel', { handle: recovery.view.handle })
    return cancelPromise
  }
  const validate = (value: FinalizationGenerationRecovery) => {
    const actual = value.context.slot
    if (value.view.handle.projectId !== session.projectId || actual.stepKey !== options.slot.stepKey
      || (['finalizationId', 'draftId', 'chapterNumber', 'contentHash'] as const).some(key => actual.source[key] !== options.slot.source[key])
      || value.effect && value.effect.stepKey !== options.slot.stepKey) throw new Error('FINALIZATION_GENERATION_IDENTITY_MISMATCH')
  }
  const timer = setInterval(() => { if (options.cancelled()) void cancel()?.catch(() => {}) }, 25)
  try {
    recovery = await ipc.invokeWithProjectSession(session, 'finalization-generation:read', { slot: options.slot })
    if (recovery) validate(recovery)
    if (recovery?.effect) return recovery.effect
    if (options.cancelled()) throw new Error('GENERATION_WORKFLOW_CANCELLED')
    if (!recovery) recovery = await ipc.invokeWithProjectSession(session, 'finalization-generation:begin', {
      slot: options.slot, modelId: options.modelId(), ...(options.parentRootActionId ? { parentRootActionId: options.parentRootActionId } : {}),
    })
    validate(recovery)
    options.onHandle?.(recovery.view.handle)
    if (options.cancelled()) { await cancel(); throw new Error('GENERATION_WORKFLOW_CANCELLED') }
    if (recovery.effect) return recovery.effect
    if (recovery.sourceStatus !== 'current' || recovery.view.status === 'cancelled') throw new Error('FINALIZATION_GENERATION_SOURCE_CHANGED')
    let candidates = recovery.view.candidates ?? recovery.view.artifacts
    let candidate = candidates.at(-1)
    if (!candidate || options.slot.stepKey === 'character_cards' && candidate.status === 'completed' && candidate.compositionEligible === true) {
      if (!candidate && recovery.attemptCount > 0) throw new Error('FINALIZATION_GENERATION_OUTCOME_UNKNOWN')
      const previous = recovery.view.handle
      const receipt = await ipc.invokeWithProjectSession(session, 'finalization-generation:execute', { handle: previous })
      if (receipt.run.handle.projectId !== previous.projectId || receipt.run.handle.rootActionId !== previous.rootActionId || receipt.run.handle.runId !== previous.runId) throw new Error('FINALIZATION_GENERATION_IDENTITY_MISMATCH')
      recovery.view = receipt.run
      if (options.cancelled()) { await cancel(); throw new Error('GENERATION_WORKFLOW_CANCELLED') }
      if (receipt.outcome.status !== 'completed' || receipt.outcome.finishReason !== 'stop') throw new Error('FINALIZATION_GENERATION_INCOMPLETE')
      candidates = receipt.run.candidates ?? receipt.run.artifacts
      candidate = candidates.at(-1)
    }
    if (!candidate || candidate.status !== 'completed' || candidate.compositionEligible !== true) throw new Error('FINALIZATION_GENERATION_ARTIFACT_REQUIRED')
    return await ipc.invokeWithProjectSession(session, 'finalization-generation:commit', { handle: recovery.view.handle,
      artifact: { artifactId: candidate.artifactId, revision: candidate.revision, textHash: candidate.textHash },
    })
  } finally { clearInterval(timer); await cancelPromise }
}
