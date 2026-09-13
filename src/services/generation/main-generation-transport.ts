import { ipc } from '../ipc-client'
import { getActiveProjectSessionContext } from '../../shared/project-session-context'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { BeginGenerationRequest } from '../../shared/generation-owner-contract'
import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationTransport } from './generation-runtime'

const handleKey = (handle: MainGenerationRunHandle) => JSON.stringify([handle.projectId, handle.epoch, handle.rootActionId, handle.runId])
function freezeSession(session: ProjectSessionContext | null): ProjectSessionContext {
  if (!session || ![session.projectId, session.leaseId, session.projectPath].every(value => typeof value === 'string' && Boolean(value.trim()))) throw new Error('GENERATION_PROJECT_SESSION_REQUIRED')
  return Object.freeze({ ...session })
}
function assertHandle(session: ProjectSessionContext, handle: MainGenerationRunHandle, historical = false): void {
  if (![handle.projectId, handle.epoch, handle.rootActionId, handle.runId].every(value => typeof value === 'string' && Boolean(value.trim()))
    || handle.projectId !== session.projectId || !historical && handle.epoch !== session.leaseId) throw new Error('GENERATION_PROJECT_SESSION_MISMATCH')
}
/** Construction is inert: neither current session nor IPC is read until a call. */
export function createMainGenerationTransport(captureSession = getActiveProjectSessionContext) {
  const sessions = new Map<string, ProjectSessionContext>()
  function sessionFor(handle: MainGenerationRunHandle, historical = false) {
    const key = handleKey(handle)
    const session = sessions.get(key) ?? freezeSession(captureSession())
    assertHandle(session, handle, historical)
    sessions.set(key, session)
    return session
  }
  function bindView(view: MainGenerationRunView, session: ProjectSessionContext, historical = false): MainGenerationRunView {
    assertHandle(session, view.handle, historical)
    sessions.set(handleKey(view.handle), session)
    return view
  }
  const transport: MainGenerationTransport = {
    async execute(request) {
      const frozen = structuredClone(request)
      const session = sessionFor(frozen.handle)
      const receipt = await ipc.invokeWithProjectSession(session, 'generation:execute', frozen)
      if (handleKey(receipt.run.handle) !== handleKey(frozen.handle)) throw new Error('GENERATION_RESPONSE_IDENTITY_MISMATCH')
      bindView(receipt.run, session)
      return receipt
    },
    async read(handle) {
      const frozen = Object.freeze({ ...handle }), session = sessionFor(frozen, true)
      const view = await ipc.invokeWithProjectSession(session, 'generation:read', frozen)
      if (handleKey(view.handle) !== handleKey(frozen)) throw new Error('GENERATION_RESPONSE_IDENTITY_MISMATCH')
      return bindView(view, session, true)
    },
    async list(projectSession) {
      const session = freezeSession(projectSession)
      const views = await ipc.invokeWithProjectSession(session, 'generation:list')
      return views.map(view => bindView(view, session, true))
    },
    async cancel(handle) {
      const frozen = Object.freeze({ ...handle }), session = sessionFor(frozen)
      const view = await ipc.invokeWithProjectSession(session, 'generation:cancel', frozen)
      if (handleKey(view.handle) !== handleKey(frozen)) throw new Error('GENERATION_RESPONSE_IDENTITY_MISMATCH')
      return bindView(view, session)
    },
    subscribe(handle, listener) {
      const frozen = Object.freeze({ ...handle }); sessionFor(frozen, true)
      let closed = false
      const unsubscribe = ipc.on('generation:snapshot', snapshot => {
        if (!closed && handleKey(snapshot) === handleKey(frozen)) listener(snapshot)
      })
      return () => { if (!closed) { closed = true; unsubscribe() } }
    },
  }
  return Object.assign(transport, {
    async begin(sessionInput: ProjectSessionContext, request: BeginGenerationRequest) {
      const session = freezeSession(sessionInput), frozen = structuredClone(request)
      return bindView(await ipc.invokeWithProjectSession(session, 'generation:begin', frozen), session)
    },
    async pause(handle: MainGenerationRunHandle) {
      const frozen = { ...handle }, session = sessionFor(frozen)
      const view = await ipc.invokeWithProjectSession(session, 'generation:pause', frozen)
      if (handleKey(view.handle) !== handleKey(frozen)) throw new Error('GENERATION_RESPONSE_IDENTITY_MISMATCH')
      return bindView(view, session)
    },
    async resume(sessionInput: ProjectSessionContext, handle: MainGenerationRunHandle) {
      const session = freezeSession(sessionInput), frozen = { ...handle }
      assertHandle(session, frozen, true)
      const view = await ipc.invokeWithProjectSession(session, 'generation:resume', frozen)
      if (view.handle.runId !== frozen.runId || view.handle.rootActionId !== frozen.rootActionId) throw new Error('GENERATION_RESPONSE_IDENTITY_MISMATCH')
      return bindView(view, session)
    },
    async restart(sessionInput: ProjectSessionContext, handle: MainGenerationRunHandle, request: BeginGenerationRequest) {
      const session = freezeSession(sessionInput), frozen = { ...handle }, intent = structuredClone(request)
      assertHandle(session, frozen, true)
      return bindView(await ipc.invokeWithProjectSession(session, 'generation:restart', frozen, intent), session)
    },
    async discard(sessionInput: ProjectSessionContext, handle: MainGenerationRunHandle, artifactId: string) {
      const session = freezeSession(sessionInput), frozen = { ...handle }
      assertHandle(session, frozen, true)
      const view = await ipc.invokeWithProjectSession(session, 'generation:discard-candidate', frozen, artifactId)
      if (handleKey(view.handle) !== handleKey(frozen)) throw new Error('GENERATION_RESPONSE_IDENTITY_MISMATCH')
      return bindView(view, session, true)
    },
  })
}
export const mainGenerationTransport = createMainGenerationTransport()
export const beginMainGeneration = mainGenerationTransport.begin
export const pauseMainGeneration = mainGenerationTransport.pause
export const resumeMainGeneration = mainGenerationTransport.resume
export const restartMainGeneration = mainGenerationTransport.restart
export const discardMainGenerationCandidate = mainGenerationTransport.discard
