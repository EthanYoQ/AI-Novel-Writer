/** Selection, Preset, approval, and completed-tool observation for the novel workbench. */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { NovelApprovalAvailability, NovelWorkbenchController } from './workbench-store.ts'

interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface ConversationNodeView {
  readonly kind: string
  readonly seq: number
  readonly call?: { readonly name: string } | null
}

/** Minimal browser-runtime sources needed without exposing Workspace paths to the RPC caller. */
export interface NovelContextSelectionSources {
  readonly sessions: {
    readonly list: Observable<{
      readonly current: SessionId | undefined
      readonly byId?: Readonly<Record<SessionId, {
        readonly agentPreset?: string
        readonly projectionValues?: Readonly<Record<string, unknown>>
      }>>
    }>
    binding(sessionId: SessionId): { readonly session: Observable<{ readonly nodes: readonly ConversationNodeView[] }> } | undefined
  }
  readonly workspaces: {
    readonly list: Observable<{
      readonly items: ReadonlyArray<{ readonly workspaceId: WorkspaceId; readonly sessionIds: readonly SessionId[] }>
    }>
  }
}

function approvalAvailability(value: unknown): NovelApprovalAvailability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unknown'
  const currentValue = (value as { readonly currentValue?: unknown }).currentValue
  if (currentValue === 'danger-full-access') return 'never'
  if (typeof currentValue === 'string' && currentValue !== 'custom') return 'ask'
  return 'unknown'
}

function latestNovelApplySeq(nodes: readonly ConversationNodeView[]): number | undefined {
  let latest: number | undefined
  for (const node of nodes) {
    if (node.kind === 'tool-result' && node.call?.name === 'novel_apply_change') {
      latest = latest === undefined ? node.seq : Math.max(latest, node.seq)
    }
  }
  return latest
}

/**
 * Follow the current registered Workspace and refresh after new completed novel mutations.
 *
 * @param sources Browser runtime selection and conversation observables.
 * @param controller Context controller receiving opaque ids and refresh signals.
 * @returns A disposer that removes every root and per-session subscription.
 */
export function observeNovelContextSources(
  sources: NovelContextSelectionSources,
  controller: NovelWorkbenchController,
): () => void {
  let disposed = false
  let boundSessionId: SessionId | undefined
  let stopConversation: (() => void) | undefined
  let seenApplySeq: number | undefined

  const bindConversation = (sessionId: SessionId | undefined): void => {
    if (sessionId === undefined && boundSessionId === undefined) return
    if (sessionId === boundSessionId && stopConversation !== undefined) return
    stopConversation?.()
    stopConversation = undefined
    boundSessionId = sessionId
    seenApplySeq = undefined
    if (sessionId === undefined) return
    const binding = sources.sessions.binding(sessionId)
    if (binding === undefined) return
    const inspect = (): void => {
      if (disposed) return
      const latest = latestNovelApplySeq(binding.session.getSnapshot().nodes)
      if (latest === undefined) return
      if (latest !== seenApplySeq) void controller.refresh()
      seenApplySeq = latest
    }
    seenApplySeq = latestNovelApplySeq(binding.session.getSnapshot().nodes)
    stopConversation = binding.session.subscribe(inspect)
  }

  const reconcile = (): void => {
    if (disposed) return
    const sessionList = sources.sessions.list.getSnapshot()
    const sessionId = sessionList.current
    const workspaceId = sessionId === undefined
      ? undefined
      : sources.workspaces.list.getSnapshot().items
        .find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
    controller.setTarget(sessionId === undefined || workspaceId === undefined
      ? undefined
      : {
          sessionId,
          workspaceId,
          agentPreset: sessionList.byId?.[sessionId]?.agentPreset,
          approval: approvalAvailability(sessionList.byId?.[sessionId]?.projectionValues?.['permissions']),
        })
    bindConversation(sessionId)
  }
  const stopSessions = sources.sessions.list.subscribe(reconcile)
  const stopWorkspaces = sources.workspaces.list.subscribe(reconcile)
  reconcile()
  return () => {
    if (disposed) return
    disposed = true
    stopConversation?.()
    stopSessions()
    stopWorkspaces()
  }
}
