import { useWorkflowStore, type StepCallbacks, type WorkflowContext } from '../../stores/workflow-store'
import { routeModelId } from '../model-routing'
import type { BeginGenerationRequest } from '../../shared/generation-owner-contract'
import type { GenerationOperation } from '../../shared/model-stage-routing'
import { createMainGenerationTransport } from '../generation/main-generation-transport'
import { createMainOwnedGenerationRuntime, type GenerationRuntime, type MainGenerationRunHandle, type MainGenerationRunView, type MainGenerationSnapshot } from '../generation/generation-runtime'
import { GenerationAttemptError, TerminalProviderFailureError, throwIfTerminalProviderFailure, type GenerationSession } from '../generation/generation-harness'
import { requireWorkflowProjectSession, workflowUiLocale } from './workflow-project-session'
import { ipc } from '../ipc-client'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowReasoningStore } from '../../stores/workflow-reasoning-store'
import { PLOT_OUTLINE_PROTOCOL, plotOutlineSourceInvalidText } from '../../shared/plot-outline-contract'

export interface WorkflowMainGenerationSelection extends Omit<BeginGenerationRequest, 'operation' | 'uiActionNonce' | 'modelId' | 'parentRootActionId' | 'selectedDraftIds' | 'selectedFinalizedDraftIds'> {
  operation: GenerationOperation
  selectedDraftIds?: number[]
  selectedFinalizedDraftIds?: number[]
  /** Exact persisted navigation identity. Never infer a recovery run from recency. */
  resumeHandle?: MainGenerationRunHandle
  /** Explicit author continuation; main closes the original and admits only its missing range. */
  restartHandle?: MainGenerationRunHandle
  /** Main-issued lineage of the original review; admission verifies its durable effect. */
  parentRootActionId?: string
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

export function pinWorkflowModel(context: WorkflowContext, modelId: string): void {
  context.generationModelId ||= modelId
  useWorkflowStore.getState().recordRunGenerationModel(context.runId, context.generationModelId)
}

/** Each stage freezes its sources; all stages of the author action share main's root. */
export async function createWorkflowMainGenerationRuntime(request: WorkflowMainGenerationRequest,
  transport = createMainGenerationTransport(() => request.context.projectSession)): Promise<WorkflowMainGenerationRuntime> {
  const { context, callbacks } = request
  const projectSession = requireWorkflowProjectSession(context)
  let modelId = context.generationModelId?.trim() || routeModelId(request.selection.operation)
  if (!modelId && !request.selection.importSlot && !request.selection.resumeHandle) throw new Error('GENERATION_MODEL_REQUIRED')
  let closed = false, busy = false, readOnlyOutline = false
  let inner: Awaited<ReturnType<typeof createMainOwnedGenerationRuntime>> | undefined
  let view: MainGenerationRunView
  let cancelPromise: Promise<unknown> | undefined
  let cancelFailure: unknown
  let importOrdinal = 0
  let operation = request.selection.operation
  let importStage = false
  let unsubscribeReasoning: (() => void) | undefined
  const clearReasoning = () => useWorkflowReasoningStore.getState().clear(context.runId)
  const displayed = new Map<string, string>()
  const onSnapshot = (snapshot: MainGenerationSnapshot) => {
    if (closed) return
    if (snapshot.diagnostics) callbacks.setGenerationActivity?.({ operation, diagnostics: snapshot.diagnostics })
    if (callbacks.replaceText) callbacks.replaceText(snapshot.text)
    else {
      const previous = displayed.get(snapshot.artifactId) ?? ''
      // These are verified durable full snapshots; this difference is display-only.
      if (snapshot.text.startsWith(previous)) callbacks.appendText(snapshot.text.slice(previous.length))
    }
    displayed.set(snapshot.artifactId, snapshot.text)
  }
  const cancel = () => {
    clearReasoning()
    if (readOnlyOutline) return Promise.resolve()
    if (!cancelPromise && view) cancelPromise = transport.cancel(view.handle).catch(error => { cancelFailure = error })
    return cancelPromise
  }
  const previousCancellation = context.requestMainGenerationCancellation
  context.requestMainGenerationCancellation = async () => { await cancel(); if (cancelFailure) throw cancelFailure }
  const open = async (selection: WorkflowMainGenerationSelection) => {
    if (closed || context.cancelled) throw new Error('GENERATION_WORKFLOW_CANCELLED')
    const { resumeHandle, restartHandle, onRunOpened, ...intent } = selection
    if (resumeHandle && restartHandle) throw new Error('GENERATION_RECOVERY_SELECTION_INVALID')
    operation = selection.operation
    importOrdinal = 0
    importStage = !!intent.importSlot
    const previousRoot = context.mainGenerationRootHandle, previousRun = context.mainGenerationRunHandle
    const previousModelId = context.generationModelId, previousImportContext = context.data.importGenerationContext
    let openedView: MainGenerationRunView | undefined
    let begunModelId: string | null = null
    try {
      const importRecovery = intent.importSlot ? await ipc.invokeWithProjectSession(projectSession, 'import-generation:read', { slot: intent.importSlot }) : null
      if (importRecovery) {
        if (resumeHandle && resumeHandle.runId !== importRecovery.view.handle.runId) throw new Error('GENERATION_IMPORT_SLOT_CHANGED')
        view = importRecovery.view
        modelId = importRecovery.modelId
        context.generationModelId = importRecovery.modelId
        context.data.importGenerationContext = importRecovery.frozenContext
      } else if (resumeHandle) {
        const stored = await transport.read(resumeHandle)
        if (context.mainGenerationRootHandle && context.mainGenerationRootHandle.rootActionId !== resumeHandle.rootActionId)
          throw new Error('GENERATION_WORKFLOW_ROOT_CHANGED')
        if (!importStage) begunModelId = modelId = context.generationModelId?.trim()
          || (await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle: resumeHandle })).modelId
        view = stored.nonReplayable && !importStage ? await transport.resume(projectSession, resumeHandle).catch((error: unknown) => {
          // 主进程按设计拒绝续写来源无效的大纲任务，只给错误码；换成与恢复稿入口相同的说明。
          if (stored.plotOutline?.protocol === PLOT_OUTLINE_PROTOCOL && String((error as Error)?.message ?? error).includes('GENERATION_PLOT_OUTLINE_PREFIX_INVALID'))
            throw new Error(plotOutlineSourceInvalidText(stored.plotOutline.sourceExpected.synopsis, workflowUiLocale(context)))
          throw error
        }) : stored
      } else {
        if (!modelId) throw new Error('GENERATION_MODEL_REQUIRED')
        begunModelId = modelId
        const parent = intent.continueDirectoryOperationId || restartHandle ? undefined : context.mainGenerationRootHandle
        if (intent.parentRootActionId && parent && intent.parentRootActionId !== parent.rootActionId)
          throw new Error('GENERATION_WORKFLOW_ROOT_CHANGED')
        if (parent && (parent.projectId !== projectSession.projectId || !intent.batchId && !intent.importSlot && !context.agentWorkflowRegistrationId && parent.epoch !== projectSession.leaseId))
          throw new Error('GENERATION_WORKFLOW_RESUME_REQUIRED')
        const beginRequest = { ...intent, selectedDraftIds: intent.selectedDraftIds ?? [],
          selectedFinalizedDraftIds: intent.selectedFinalizedDraftIds ?? [], modelId,
          uiActionNonce: `${context.runId}:${intent.operation}${intent.operation === 'chapter-draft' ? `:${intent.chapterNumber}` : ''}`,
          ...(context.agentWorkflowRegistrationId ? { agentWorkflowRegistrationId: context.agentWorkflowRegistrationId } : {}),
          ...(parent ? { parentRootActionId: parent.rootActionId } : {}) }
        view = restartHandle ? await transport.restart(projectSession, restartHandle, beginRequest) : await transport.begin(projectSession, beginRequest)
        openedView = view
        if (restartHandle && view.nonReplayable) view = await transport.resume(projectSession, view.handle)
      }
      openedView = view
      readOnlyOutline = view.nonReplayable && view.plotOutline?.protocol === PLOT_OUTLINE_PROTOCOL && view.plotOutline.cursor.kind === 'complete'
      context.mainGenerationRootHandle = Object.freeze({ ...view.handle })
      context.mainGenerationRunHandle = Object.freeze({ ...view.handle })
      if (intent.importSlot && !importRecovery) {
        const stored = await ipc.invokeWithProjectSession(projectSession, 'import-generation:read', { slot: intent.importSlot })
        if (!stored || stored.view.handle.runId !== view.handle.runId) throw new Error('GENERATION_IMPORT_CONTEXT_REQUIRED')
        context.data.importGenerationContext = stored.frozenContext
        context.generationModelId = stored.modelId
      }
      await onRunOpened?.(context.mainGenerationRunHandle)
      if (context.cancelled) { await cancel(); throw new Error('GENERATION_WORKFLOW_CANCELLED') }
      unsubscribeReasoning = readOnlyOutline ? undefined : transport.subscribeReasoning?.(view.handle, event => {
        if (closed || context.cancelled || !event.attemptId || !event.text
          || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(useProjectStore.getState().currentProject))) return
        useWorkflowReasoningStore.getState().append(context.runId, event.attemptId, event.text)
      })
      inner = await createMainOwnedGenerationRuntime({ runHandle: view.handle, onSnapshot }, transport)
      if (begunModelId) pinWorkflowModel(context, begunModelId)
    } catch (error) {
      unsubscribeReasoning?.(); unsubscribeReasoning = undefined; clearReasoning()
      if (openedView?.handle.epoch === projectSession.leaseId && openedView.status === 'running') {
        await (context.cancelled ? transport.cancel(openedView.handle) : transport.pause(openedView.handle)).catch(() => undefined)
      }
      context.mainGenerationRootHandle = previousRoot
      context.mainGenerationRunHandle = previousRun
      context.generationModelId = previousModelId
      context.data.importGenerationContext = previousImportContext
      throw error
    }
  }
  try { await open(request.selection) }
  catch (error) { context.requestMainGenerationCancellation = previousCancellation; throw error }
  const unsubscribeProject = useProjectStore.subscribe(state => {
    if (!sameProjectSessionContext(projectSession, projectSessionContextFromProject(state.currentProject))) clearReasoning()
  })
  const cancellationTimer = setInterval(() => { if (context.cancelled) void cancel() }, 25)
  const close = async () => {
    if (closed) return
    closed = true; clearInterval(cancellationTimer)
    unsubscribeReasoning?.(); unsubscribeProject(); clearReasoning()
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
      callbacks.setGenerationActivity?.({ operation })
      try {
        if (importStage) {
          const receipt = await ipc.invokeWithProjectSession(projectSession, 'import-generation:execute', { handle: view.handle, ordinal: importOrdinal, task,
            execution: context.data.importRunExecution as import('../../shared/import-run').ImportRunExecutionAuthority | undefined })
          importOrdinal += 1
          view = receipt.run
          context.mainGenerationRunHandle = Object.freeze({ ...view.handle })
          context.mainGenerationRootHandle = Object.freeze({ ...view.handle })
          const artifactId = receipt.outcome.receipt.visibleArtifact?.artifactId
          for (const snapshot of (view.candidates ?? view.artifacts).filter(snapshot => snapshot.artifactId === artifactId)) onSnapshot(snapshot)
          throwIfTerminalProviderFailure(receipt.outcome.receipt)
          return receipt.outcome
        }
        // Keep this nonce for the entire request; transport failures never mint a retry.
        const outcome = await inner!.execute(({ session: owned }) => owned.complete(task, { invocationNonce }))
        if (outcome.receipt.diagnostics) callbacks.setGenerationActivity?.({ operation, diagnostics: outcome.receipt.diagnostics })
        return outcome
      } catch (error) {
        if ((error instanceof GenerationAttemptError || error instanceof TerminalProviderFailureError) && error.receipt.diagnostics) {
          callbacks.setGenerationActivity?.({ operation, diagnostics: error.receipt.diagnostics })
        }
        throw error
      } finally { busy = false; options?.signal?.removeEventListener('abort', abort) }
    },
  }
  return {
    mainOwned: true,
    async execute(operation) { try { return await operation({ session }) } finally { await close() } },
    close,
    async advance(selection) {
      if (closed || busy || cancelPromise || readOnlyOutline) throw new Error('GENERATION_WORKFLOW_ADVANCE_REFUSED')
      unsubscribeReasoning?.(); unsubscribeReasoning = undefined; clearReasoning()
      await inner?.close(); inner = undefined
      await open(selection)
    },
  }
}
