import { ipc } from './ipc-client'
import type { MainGenerationRunHandle } from './generation/generation-runtime'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { EditorInlineInput, EditorInlineRecovery } from '../shared/editor-inline-generation'

const hasEpoch = (handle: MainGenerationRunHandle) => typeof handle.epoch === 'string' && handle.epoch.trim().length > 0
const identity = (handle: MainGenerationRunHandle) => JSON.stringify([handle.projectId, handle.rootActionId, handle.runId])

/** Main owns the task, model, nonce and budget. This adapter only holds navigation. */
export function createEditorInlineGeneration(sessionInput: ProjectSessionContext) {
  const session = Object.freeze({ ...sessionInput })
  let recovery: EditorInlineRecovery | undefined
  let opening: Promise<EditorInlineRecovery> | undefined
  let cancelled = false
  let detached = false
  let cancelPromise: Promise<unknown> | undefined
  async function validate(value: EditorInlineRecovery, expected?: MainGenerationRunHandle) {
    if (value.view.handle.projectId !== session.projectId || !hasEpoch(value.view.handle) || expected && identity(expected) !== identity(value.view.handle)) throw new Error('EDITOR_INLINE_IDENTITY_MISMATCH')
    const input = value.context
    if (!['refine', 'expand', 'continue', 'dialogue'].includes(input.action) || input.kind !== 'author-draft' || !Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to)
      || input.from < 0 || input.to <= input.from || input.to > input.documentText.length
      || input.documentText.slice(input.from, input.to) !== input.selectedText) throw new Error('EDITOR_INLINE_CONTEXT_INVALID')
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.documentText))
    const hash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== input.documentHash) throw new Error('EDITOR_INLINE_CONTEXT_INVALID')
    return value
  }
  async function cancelKnown() {
    if (recovery && !cancelPromise) cancelPromise = (async () => {
      const original = recovery!.view.handle
      const view = await ipc.invokeWithProjectSession(session, 'editor-inline:cancel', { handle: original })
      if (identity(view.handle) !== identity(original) || !hasEpoch(view.handle)) throw new Error('EDITOR_INLINE_IDENTITY_MISMATCH')
      recovery!.view = view
    })()
    await cancelPromise
  }
  async function read() {
    if (!recovery) throw new Error('EDITOR_INLINE_NOT_OPEN')
    recovery = await validate(await ipc.invokeWithProjectSession(session, 'editor-inline:read-recovery', { handle: recovery.view.handle }), recovery.view.handle)
    return recovery
  }
  return {
    read,
    open(request: { input: EditorInlineInput; modelId: string; uiActionNonce: string } | { handle: MainGenerationRunHandle }) {
      if (opening) throw new Error('EDITOR_INLINE_ALREADY_OPEN')
      opening = (async () => {
        const value = 'handle' in request
          ? await ipc.invokeWithProjectSession(session, 'editor-inline:read-recovery', request)
          : await ipc.invokeWithProjectSession(session, 'editor-inline:begin', request)
        recovery = await validate(value, 'handle' in request ? request.handle : undefined)
        if ('input' in request && (['action', 'documentText', 'from', 'to', 'selectedText'] as const).some(key => request.input[key] !== recovery!.context[key])) throw new Error('EDITOR_INLINE_CONTEXT_MISMATCH')
        if (cancelled) { await cancelKnown(); throw new Error('EDITOR_INLINE_CANCELLED') }
        if (detached) throw new Error('EDITOR_INLINE_DETACHED')
        return recovery
      })()
      return opening
    },
    async execute() {
      if (!opening) throw new Error('EDITOR_INLINE_NOT_OPEN')
      await opening
      if (cancelled || detached || !recovery || recovery.sourceStatus !== 'current') throw new Error('EDITOR_INLINE_NOT_EXECUTABLE')
      const handle = recovery.view.handle
      const receipt = await ipc.invokeWithProjectSession(session, 'editor-inline:execute', { handle })
      const next = receipt.run.handle
      if (next.projectId !== handle.projectId || next.runId !== handle.runId || next.rootActionId !== handle.rootActionId
        || !hasEpoch(next)) throw new Error('EDITOR_INLINE_IDENTITY_MISMATCH')
      recovery.view = receipt.run
      if (cancelled || detached || receipt.run.status === 'cancelled') throw new Error('EDITOR_INLINE_CANCELLED')
      const current = await read()
      if (cancelled || detached) throw new Error('EDITOR_INLINE_CANCELLED')
      return { ...receipt, sourceStatus: current.sourceStatus }
    },
    async cancel() { cancelled = true; if (opening) await opening.catch(() => {}); await cancelKnown() },
    detach() { detached = true },
  }
}
