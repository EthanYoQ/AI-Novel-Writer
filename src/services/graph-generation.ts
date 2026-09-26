import { ipc } from './ipc-client'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { GraphGenerationInput, GraphGenerationRecovery } from '../shared/graph-generation'
import type { MainGenerationRunHandle } from './generation/generation-runtime'

const sameRun = (a: MainGenerationRunHandle, b: MainGenerationRunHandle) => a.projectId === b.projectId && a.rootActionId === b.rootActionId && a.runId === b.runId
export function canExecuteGraph(recovery: GraphGenerationRecovery) {
  return recovery.sourceStatus === 'current' && recovery.view.status !== 'cancelled' && recovery.attemptCount === 0 && !recovery.result
    && !recovery.artifact && (recovery.view.candidates ?? recovery.view.artifacts).length === 0
}
/** Navigation only: main owns sources, tasks, candidate identity and durable effects. */
export function createGraphGeneration(sessionInput: ProjectSessionContext) {
  const session = Object.freeze({ ...sessionInput })
  let recovery: GraphGenerationRecovery | undefined
  let detached = false
  let cancelled = false
  let opening: Promise<GraphGenerationRecovery> | undefined
  let cancelPromise: Promise<void> | undefined
  const validate = (value: GraphGenerationRecovery, handle?: MainGenerationRunHandle) => {
    if (value.view.handle.projectId !== session.projectId || value.context.projectId !== session.projectId
      || !value.view.handle.epoch || handle && !sameRun(handle, value.view.handle)
      || value.context.kind !== value.context.input.kind || value.result && value.result.kind !== value.context.kind) throw new Error('GRAPH_GENERATION_IDENTITY_MISMATCH')
    return value
  }
  const read = async () => {
    if (!recovery) throw new Error('GRAPH_GENERATION_NOT_OPEN')
    recovery = validate(await ipc.invokeWithProjectSession(session, 'graph-generation:read', { handle: recovery.view.handle }), recovery.view.handle)
    return recovery
  }
  const cancelKnown = async () => {
    if (!recovery) return
    if (!cancelPromise) cancelPromise = (async () => {
      const view = await ipc.invokeWithProjectSession(session, 'graph-generation:cancel', { handle: recovery!.view.handle })
      if (!sameRun(view.handle, recovery!.view.handle)) throw new Error('GRAPH_GENERATION_IDENTITY_MISMATCH')
      recovery!.view = view
    })()
    await cancelPromise
  }
  return {
    read,
    open(request: { input: GraphGenerationInput; modelId: string; uiActionNonce: string } | { handle: MainGenerationRunHandle }) {
      if (opening) throw new Error('GRAPH_GENERATION_ALREADY_OPEN')
      opening = (async () => {
        recovery = validate('handle' in request
          ? await ipc.invokeWithProjectSession(session, 'graph-generation:read', request)
          : await ipc.invokeWithProjectSession(session, 'graph-generation:begin', request), 'handle' in request ? request.handle : undefined)
        if ('input' in request && JSON.stringify(recovery.context.input) !== JSON.stringify(request.input)) throw new Error('GRAPH_GENERATION_CONTEXT_MISMATCH')
        if (cancelled) { await cancelKnown(); throw new Error('GRAPH_GENERATION_CANCELLED') }
        if (detached) throw new Error('GRAPH_GENERATION_DETACHED')
        return recovery
      })()
      return opening
    },
    async execute() {
      if (!opening) throw new Error('GRAPH_GENERATION_NOT_OPEN')
      await opening
      if (!recovery || cancelled || detached) throw new Error('GRAPH_GENERATION_NOT_EXECUTABLE')
      if (recovery.result) return read()
      if (!canExecuteGraph(recovery)) throw new Error('GRAPH_GENERATION_OUTCOME_UNKNOWN')
      const handle = recovery.view.handle
      const receipt = await ipc.invokeWithProjectSession(session, 'graph-generation:execute', { handle })
      if (!sameRun(handle, receipt.run.handle)) throw new Error('GRAPH_GENERATION_IDENTITY_MISMATCH')
      recovery.view = receipt.run
      if (cancelled || detached) throw new Error('GRAPH_GENERATION_CANCELLED')
      return read()
    },
    async confirm(index: number, expectedHandle?: MainGenerationRunHandle) {
      const current = await read()
      if (expectedHandle && !sameRun(current.view.handle, expectedHandle)) throw new Error('GRAPH_GENERATION_IDENTITY_MISMATCH')
      const existing = current.effects.find(effect => effect.index === index)
      if (existing) return existing
      if (cancelled || detached || current.sourceStatus !== 'current' || current.view.status === 'cancelled' || !current.artifact || !current.result) throw new Error('GRAPH_GENERATION_NOT_CONFIRMABLE')
      const length = current.result.kind === 'plot' ? 1 : current.result.candidates.length
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new Error('GRAPH_GENERATION_SELECTION_INVALID')
      return ipc.invokeWithProjectSession(session, 'graph-generation:confirm', { handle: current.view.handle, artifact: current.artifact, index })
    },
    async cancel() { cancelled = true; if (opening) await opening.catch(() => {}); await cancelKnown() },
    detach() { detached = true },
  }
}

export async function generateGraphResult(session: ProjectSessionContext, input: GraphGenerationInput, modelId: string, signal: AbortSignal) {
  const client = createGraphGeneration(session)
  const cancel = () => { void client.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) throw new Error('GRAPH_GENERATION_CANCELLED')
    await client.open({ input, modelId, uiActionNonce: crypto.randomUUID() })
    const recovery = await client.execute()
    if (!recovery.result) throw new Error('GRAPH_GENERATION_INCOMPLETE')
    if (input.kind === 'plot') await client.confirm(0)
    return recovery.result
  } finally { signal.removeEventListener('abort', cancel); client.detach() }
}
