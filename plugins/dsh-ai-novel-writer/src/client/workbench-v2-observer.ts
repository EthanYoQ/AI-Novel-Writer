/** Bind the V2 workbench to the Harness selection without exposing Workspace paths. */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { NovelV2WorkbenchController } from './workbench-v2.ts'
import { AI_NOVEL_PRESET_ID } from './workbench-store.ts'

/** The V2 sidebar is opt-in: existing sessions stay on the V1 workbench. */
export const AI_NOVEL_V2_PRESET_ID = 'ai-novel-writer-v2'

export type NovelWorkbenchMode = 'none' | 'v1' | 'v2'

/** A small public selection controller shared by the trigger and overlay. */
export class NovelWorkbenchRouteController {
  readonly #listeners = new Set<() => void>()
  #mode: NovelWorkbenchMode = 'none'

  public getSnapshot(): NovelWorkbenchMode { return this.#mode }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Route only the two exact novel Presets; every other session stays unbound. */
  public setPreset(agentPreset: string | undefined): void {
    const mode: NovelWorkbenchMode = agentPreset === AI_NOVEL_PRESET_ID
      ? 'v1'
      : agentPreset === AI_NOVEL_V2_PRESET_ID ? 'v2' : 'none'
    if (mode === this.#mode) return
    this.#mode = mode
    for (const listener of this.#listeners) listener()
  }

  public dispose(): void { this.#listeners.clear() }
}

interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface ConversationNodeView {
  readonly kind: string
  readonly seq: number
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
}

interface ConversationSessionView {
  readonly nodes: readonly ConversationNodeView[]
  readonly turnEnds?: ReadonlyMap<number, number>
  readonly queue?: readonly ConversationQueueMessageView[]
  readonly running?: boolean
}

interface ConversationQueueMessageView {
  readonly text: string | null
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/** Narrow selection surface required by the V2 sidebar shell. */
export interface NovelV2WorkspaceSelectionSources {
  readonly sessions: {
    readonly list: Observable<{
      readonly current: SessionId | undefined
      readonly byId?: Readonly<Record<SessionId, { readonly agentPreset?: string }>>
    }>
    binding(sessionId: SessionId): { readonly session: Observable<ConversationSessionView> } | undefined
  }
  readonly workspaces: {
    readonly list: Observable<{
      readonly items: ReadonlyArray<{ readonly workspaceId: WorkspaceId; readonly sessionIds: readonly SessionId[] }>
    }>
  }
}

function highestUserSeq(nodes: readonly ConversationNodeView[]): number {
  let highest = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    if (node.kind === 'user' && node.seq > highest) highest = node.seq
  }
  return highest
}

function requestUserSeqAfter(
  nodes: readonly ConversationNodeView[],
  requestText: string,
  baselineUserSeq: number,
): number | undefined {
  let seq: number | undefined
  for (const node of nodes) {
    if (node.kind !== 'user' || node.seq <= baselineUserSeq
      || !node.content?.some(block => block.type === 'text' && block.text === requestText)) continue
    if (seq === undefined || node.seq > seq) seq = node.seq
  }
  return seq
}

function queueContainsRequest(queue: readonly ConversationQueueMessageView[], requestText: string): boolean {
  return queue.some(item => item.text === requestText
    || item.content.some(block => block.type === 'text' && block.text === requestText))
}

/**
 * Follow the Workspace attached to the active Harness Session.
 * The browser forwards only opaque Workspace/Session identities and refreshes only the exact readable
 * workbench-submitted authoring request after its durable turn end.
 */
export function observeNovelV2Workspace(
  sources: NovelV2WorkspaceSelectionSources,
  controller: NovelV2WorkbenchController,
  route: NovelWorkbenchRouteController,
): () => void {
  let disposed = false
  let boundSessionId: SessionId | undefined
  let stopConversation: (() => void) | undefined
  let observedRequestText: string | undefined
  let settledRequestText: string | undefined
  let queuedRequestSeen = false
  let requestBaselineUserSeq: number | undefined
  let conversation: Observable<ConversationSessionView> | undefined

  const clearRequestObservation = (): void => {
    observedRequestText = undefined
    settledRequestText = undefined
    queuedRequestSeen = false
    requestBaselineUserSeq = undefined
  }

  /** Capture the highest pre-action user node while the controller synchronously enters submitting. */
  const beginRequestObservation = (requestText: string): void => {
    observedRequestText = requestText
    settledRequestText = undefined
    queuedRequestSeen = false
    requestBaselineUserSeq = conversation === undefined
      ? undefined
      : highestUserSeq(conversation.getSnapshot().nodes)
  }

  const observeControllerAction = (): void => {
    if (disposed) return
    const state = controller.getSnapshot()
    const requestText = controller.currentAuthoringRequestText()
    if (state.status === 'ready' && state.authoring.phase === 'submitting' && requestText !== undefined) {
      if (requestText !== observedRequestText || requestBaselineUserSeq === undefined) beginRequestObservation(requestText)
      return
    }
    if (requestText === undefined) clearRequestObservation()
  }

  const bindConversation = (sessionId: SessionId | undefined): void => {
    if (sessionId === boundSessionId && stopConversation !== undefined) return
    stopConversation?.()
    stopConversation = undefined
    boundSessionId = sessionId
    conversation = undefined
    clearRequestObservation()
    if (sessionId === undefined) return
    const binding = sources.sessions.binding(sessionId)
    if (binding === undefined) return
    conversation = binding.session
    stopConversation = conversation.subscribe(() => {
      if (disposed) return
      const sessions = sources.sessions.list.getSnapshot()
      if (sessions.current !== sessionId || sessions.byId?.[sessionId]?.agentPreset !== AI_NOVEL_V2_PRESET_ID) return
      const snapshot = conversation?.getSnapshot()
      if (snapshot === undefined) return
      const requestText = controller.currentAuthoringRequestText()
      if (requestText !== observedRequestText) {
        if (requestText === undefined) clearRequestObservation()
        else beginRequestObservation(requestText)
      }
      const userSeq = requestText === undefined || requestBaselineUserSeq === undefined
        ? undefined
        : requestUserSeqAfter(snapshot.nodes, requestText, requestBaselineUserSeq)
      const queued = requestText !== undefined && snapshot.queue !== undefined
        ? queueContainsRequest(snapshot.queue, requestText)
        : false
      if (queued) queuedRequestSeen = true
      const matchingTurnEnd = userSeq === undefined || snapshot.turnEnds === undefined
        ? undefined
        : [...snapshot.turnEnds.values()].filter(seq => seq > userSeq).sort((left, right) => left - right)[0]
      if (requestText !== undefined
        && queuedRequestSeen
        && !queued
        && userSeq === undefined
        && snapshot.running === false) {
        controller.authoringPromptLost()
        queuedRequestSeen = false
      } else if (requestText !== undefined && matchingTurnEnd !== undefined && settledRequestText !== requestText) {
        controller.authoringTurnSettled()
        settledRequestText = requestText
        void controller.refreshAfterSessionActivity()
      }
    })
    const requestText = controller.currentAuthoringRequestText()
    if (requestText !== undefined) beginRequestObservation(requestText)
  }

  const reconcile = (): void => {
    if (disposed) return
    const sessions = sources.sessions.list.getSnapshot()
    const sessionId = sessions.current
    const agentPreset = sessionId === undefined ? undefined : sessions.byId?.[sessionId]?.agentPreset
    route.setPreset(agentPreset)
    if (agentPreset !== AI_NOVEL_V2_PRESET_ID) {
      controller.setSession(undefined)
      controller.setWorkspace(undefined)
      bindConversation(undefined)
      return
    }
    const workspaceId = sessionId === undefined
      ? undefined
      : sources.workspaces.list.getSnapshot().items
        .find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
    if (sessionId === undefined || workspaceId === undefined) {
      controller.setSession(undefined)
      controller.setWorkspace(undefined)
      bindConversation(undefined)
      return
    }
    controller.setWorkspace(workspaceId)
    controller.setSession(sessionId)
    bindConversation(sessionId)
  }
  const stopController = controller.subscribe(observeControllerAction)
  const stopSessions = sources.sessions.list.subscribe(reconcile)
  const stopWorkspaces = sources.workspaces.list.subscribe(reconcile)
  reconcile()
  return () => {
    if (disposed) return
    disposed = true
    stopConversation?.()
    stopController()
    stopSessions()
    stopWorkspaces()
  }
}
