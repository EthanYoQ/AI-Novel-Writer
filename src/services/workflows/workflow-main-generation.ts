import type { StepCallbacks, WorkflowContext } from '../../stores/workflow-store'
import { useLLMStore } from '../../stores/llm-store'
import type { BeginGenerationRequest } from '../../shared/generation-owner-contract'
import { createMainGenerationTransport } from '../generation/main-generation-transport'
import { createMainOwnedGenerationRuntime, type GenerationRuntime, type MainGenerationRunHandle, type MainGenerationRunView, type MainGenerationSnapshot } from '../generation/generation-runtime'
import type { GenerationSession } from '../generation/generation-harness'
import { requireWorkflowProjectSession } from './workflow-project-session'

export interface WorkflowMainGenerationSelection extends Omit<BeginGenerationRequest, 'uiActionNonce' | 'modelId' | 'parentRootActionId' | 'selectedDraftIds' | 'selectedFinalizedDraftIds'> {
  selectedDraftIds?: number[]
  selectedFinalizedDraftIds?: number[]
  /** Exact persisted navigation identity. Never infer a recovery run from recency. */
  resumeHandle?: MainGenerationRunHandle
  /** Persist navigation metadata before the first physical request. */
  onRunOpened?: (handle: MainGenerationRunHandle) => Promise<void>
}
export interface WorkflowMainGenerationRequest {
  context: WorkflowContext
  callbacks: StepCallbacks
  selection: WorkflowMainGenerationSelection
}
export interface WorkflowMainGenerationRuntime extends GenerationRuntime {
  readonly mainOwned: true
  advance(selection: WorkflowMainGenerationSelection): Promise<void>
}

/** Each stage freezes its sources; all stages of the author action share main's root. */
export async function createWorkflowMainGenerationRuntime(request: WorkflowMainGenerationRequest,
  transport = createMainGenerationTransport(() => request.context.projectSession)): Promise<WorkflowMainGenerationRuntime> {
  const { context, callbacks } = request
  const projectSession = requireWorkflowProjectSession(context)
  const modelId = context.generationModelId?.trim() || useLLMStore.getState().defaultModelId
  if (!modelId) throw new Error('GENERATION_MODEL_REQUIRED')
  let closed = false, busy = false
  let inner: Awaited<ReturnType<typeof createMainOwnedGenerationRuntime>> | undefined
  let view: MainGenerationRunView
  let cancelPromise: Promise<unknown> | undefined
  let cancelFailure: unknown
  const displayed = new Map<string, string>()
  const onSnapshot = (snapshot: MainGenerationSnapshot) => {
    if (closed) return
    if (callbacks.replaceText) callbacks.replaceText(snapshot.text)
    else {
      const previous = displayed.get(snapshot.artifactId) ?? ''
      // These are verified durable full snapshots; this difference is display-only.
      if (snapshot.text.startsWith(previous)) callbacks.appendText(snapshot.text.slice(previous.length))
    }
    displayed.set(snapshot.artifactId, snapshot.text)
  }
  const cancel = () => {
    if (!cancelPromise && view) cancelPromise = transport.cancel(view.handle).catch(error => { cancelFailure = error })
    return cancelPromise
  }
  context.requestMainGenerationCancellation = async () => { await cancel(); if (cancelFailure) throw cancelFailure }
  const open = async (selection: WorkflowMainGenerationSelection) => {
    if (closed || context.cancelled) throw new Error('GENERATION_WORKFLOW_CANCELLED')
    const { resumeHandle, onRunOpened, ...intent } = selection
    if (resumeHandle) {
      const stored = await transport.read(resumeHandle)
      if (context.mainGenerationRootHandle && context.mainGenerationRootHandle.rootActionId !== resumeHandle.rootActionId)
        throw new Error('GENERATION_WORKFLOW_ROOT_CHANGED')
      view = stored.nonReplayable ? await transport.resume(projectSession, resumeHandle) : stored
    } else {
      const parent = intent.continueDirectoryOperationId ? undefined : context.mainGenerationRootHandle
      if (parent && (parent.projectId !== projectSession.projectId || !intent.batchId && parent.epoch !== projectSession.leaseId))
        throw new Error('GENERATION_WORKFLOW_RESUME_REQUIRED')
      view = await transport.begin(projectSession, { ...intent, selectedDraftIds: intent.selectedDraftIds ?? [],
        selectedFinalizedDraftIds: intent.selectedFinalizedDraftIds ?? [], modelId,
        uiActionNonce: `${context.runId}:${intent.operation}${intent.operation === 'chapter-draft' ? `:${intent.chapterNumber}` : ''}`,
        ...(parent ? { parentRootActionId: parent.rootActionId } : {}) })
    }
    context.mainGenerationRootHandle = Object.freeze({ ...view.handle })
    context.mainGenerationRunHandle = Object.freeze({ ...view.handle })
    await onRunOpened?.(context.mainGenerationRunHandle)
    if (context.cancelled) { await transport.cancel(view.handle); throw new Error('GENERATION_WORKFLOW_CANCELLED') }
    inner = await createMainOwnedGenerationRuntime({ runHandle: view.handle, onSnapshot }, transport)
  }
  await open(request.selection)
  const cancellationTimer = setInterval(() => { if (context.cancelled) void cancel() }, 25)
  const close = async () => {
    if (closed) return
    closed = true; clearInterval(cancellationTimer)
    await cancelPromise
    await inner?.close()
  }
  const session: GenerationSession = {
    get budget() { return view.budget },
    async complete(task, options) {
      if (closed || busy) throw new Error('GENERATION_WORKFLOW_SESSION_BUSY')
      if (context.cancelled || options?.signal?.aborted) { await cancel(); throw new Error('GENERATION_WORKFLOW_CANCELLED') }
      if (cancelFailure) throw cancelFailure
      if (options?.onChunk) throw new Error('MAIN_SNAPSHOT_CALLBACK_REQUIRED')
      const invocationNonce = options?.invocationNonce ?? crypto.randomUUID()
      const abort = () => { void cancel() }
      options?.signal?.addEventListener('abort', abort, { once: true })
      busy = true
      try {
        // Keep this nonce for the entire request; transport failures never mint a retry.
        return await inner!.execute(({ session: owned }) => owned.complete(task, { invocationNonce }))
      } finally { busy = false; options?.signal?.removeEventListener('abort', abort) }
    },
  }
  return {
    mainOwned: true,
    async execute(operation) { try { return await operation({ session }) } finally { await close() } },
    close,
    async advance(selection) {
      if (closed || busy || cancelPromise) throw new Error('GENERATION_WORKFLOW_ADVANCE_REFUSED')
      await inner?.close(); inner = undefined
      await open(selection)
    },
  }
}
