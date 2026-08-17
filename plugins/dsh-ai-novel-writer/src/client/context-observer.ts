/** Selection, Preset, approval, and completed-tool observation for the novel workbench. */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { Revision } from '../types.ts'
import type { NovelApplyOutcome, NovelApprovalAvailability, NovelWorkbenchController } from './workbench-store.ts'

interface Observable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface ConversationNodeView {
  readonly kind: string
  readonly seq: number
  readonly call?: { readonly name: string; readonly argsRaw?: string } | null
  readonly isError?: boolean
  readonly error?: { readonly code: string }
  readonly meta?: unknown
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
}

interface ConversationQueueMessageView {
  readonly text: string | null
  readonly content: readonly { readonly type: string; readonly text?: string }[]
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
    binding(sessionId: SessionId): { readonly session: Observable<{
      readonly nodes: readonly ConversationNodeView[]
      readonly turnEnds?: ReadonlyMap<number, number>
      readonly queue?: readonly ConversationQueueMessageView[]
      readonly running?: boolean
    }> } | undefined
  }
  readonly workspaces: {
    readonly list: Observable<{
      readonly items: ReadonlyArray<{ readonly workspaceId: WorkspaceId; readonly sessionIds: readonly SessionId[] }>
    }>
  }
}

function markerUserSeq(nodes: readonly ConversationNodeView[], marker: string): number | undefined {
  const line = `[AI_NOVEL_UI_CORRELATION:${marker}]`
  let seq: number | undefined
  for (const node of nodes) {
    if (node.kind !== 'user' || !node.content?.some(block => block.type === 'text' && block.text?.includes(line))) continue
    if (seq === undefined || node.seq > seq) seq = node.seq
  }
  return seq
}

function queueContainsMarker(
  queue: readonly ConversationQueueMessageView[],
  marker: string,
): boolean {
  const line = `[AI_NOVEL_UI_CORRELATION:${marker}]`
  return queue.some(item => item.text?.includes(line)
    || item.content.some(block => block.type === 'text' && block.text?.includes(line)))
}

function approvalAvailability(value: unknown): NovelApprovalAvailability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unknown'
  const currentValue = (value as { readonly currentValue?: unknown }).currentValue
  if (currentValue === 'danger-full-access') return 'never'
  if (typeof currentValue === 'string' && currentValue !== 'custom') return 'ask'
  return 'unknown'
}

function latestNovelApplyResult(nodes: readonly ConversationNodeView[]): ConversationNodeView | undefined {
  let latest: ConversationNodeView | undefined
  for (const node of nodes) {
    if (node.kind === 'tool-result' && node.call?.name === 'novel_apply_change') {
      if (latest === undefined || node.seq > latest.seq) latest = node
    }
  }
  return latest
}

function applyAttribution(node: ConversationNodeView): NovelApplyOutcome['attribution'] {
  const argsRaw = node.call?.argsRaw
  if (argsRaw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(argsRaw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'initialize') {
    const keys = Object.keys(record)
    if (keys.length !== 10
      || typeof record.projectId !== 'string'
      || typeof record.createdAt !== 'string'
      || typeof record.updatedAt !== 'string'
      || typeof record.title !== 'string'
      || typeof record.language !== 'string'
      || typeof record.genre !== 'string'
      || typeof record.plannedChapters !== 'number'
      || typeof record.targetWordsPerChapter !== 'number'
      || typeof record.creativeStrategy !== 'string') return undefined
    return {
      kind: 'initialize',
      requestJson: JSON.stringify({
        kind: 'initialize',
        projectId: record.projectId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        title: record.title,
        language: record.language,
        genre: record.genre,
        plannedChapters: record.plannedChapters,
        targetWordsPerChapter: record.targetWordsPerChapter,
        creativeStrategy: record.creativeStrategy,
      }, null, 2),
    }
  }
  if (record.kind !== 'replace'
    || typeof record.targetKind !== 'string'
    || typeof record.baseRevision !== 'string'
    || typeof record.replacement !== 'string') return undefined
  return {
    kind: 'replace',
    targetKind: record.targetKind,
    ...(typeof record.chapter === 'number' ? { chapter: record.chapter } : {}),
    baseRevision: record.baseRevision,
    replacement: record.replacement,
  }
}

/** Read the tool-owned replayable receipt metadata without interpreting model-facing result text. */
function commitRevision(node: ConversationNodeView): Revision | undefined {
  if (node.isError === true) return undefined
  if (typeof node.meta !== 'object' || node.meta === null || Array.isArray(node.meta)) return undefined
  const revision = (node.meta as { readonly newRevision?: unknown }).newRevision
  return typeof revision === 'string' && /^[0-9a-f]{64}$/.test(revision)
    ? revision as Revision
    : undefined
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
  let observedMarker: string | undefined
  let settledMarker: string | undefined
  let queuedMarkerSeen = false

  const bindConversation = (sessionId: SessionId | undefined): void => {
    if (sessionId === undefined && boundSessionId === undefined) return
    if (sessionId === boundSessionId && stopConversation !== undefined) return
    stopConversation?.()
    stopConversation = undefined
    boundSessionId = sessionId
    seenApplySeq = undefined
    observedMarker = undefined
    settledMarker = undefined
    queuedMarkerSeen = false
    if (sessionId === undefined) return
    const binding = sources.sessions.binding(sessionId)
    if (binding === undefined) return
    const inspect = (): void => {
      if (disposed) return
      const snapshot = binding.session.getSnapshot()
      const latest = latestNovelApplyResult(snapshot.nodes)
      let refresh = false
      if (latest !== undefined && latest.seq !== seenApplySeq) {
        const newRevision = commitRevision(latest)
        controller.novelApplySettled({
          isError: latest.isError === true,
          code: latest.error?.code,
          ...(newRevision === undefined ? {} : { newRevision }),
          attribution: applyAttribution(latest),
        })
        refresh = true
      }
      seenApplySeq = latest?.seq
      const marker = controller.currentGenerationCorrelationMarker()
      if (marker !== observedMarker) {
        observedMarker = marker
        settledMarker = undefined
        queuedMarkerSeen = false
      }
      const userSeq = marker === undefined ? undefined : markerUserSeq(snapshot.nodes, marker)
      const queued = marker !== undefined && snapshot.queue !== undefined
        ? queueContainsMarker(snapshot.queue, marker)
        : false
      if (queued) queuedMarkerSeen = true
      const matchingTurnEnd = userSeq === undefined || snapshot.turnEnds === undefined
        ? undefined
        : [...snapshot.turnEnds.values()].filter(seq => seq > userSeq).sort((left, right) => left - right)[0]
      if (marker !== undefined
        && queuedMarkerSeen
        && !queued
        && userSeq === undefined
        && snapshot.running === false) {
        controller.generationPromptLost()
        queuedMarkerSeen = false
      } else if (marker !== undefined && matchingTurnEnd !== undefined && settledMarker !== marker) {
        controller.generationTurnSettled()
        settledMarker = marker
        refresh = true
      }
      if (refresh) void controller.refresh()
    }
    const initial = binding.session.getSnapshot()
    seenApplySeq = latestNovelApplyResult(initial.nodes)?.seq
    observedMarker = controller.currentGenerationCorrelationMarker()
    queuedMarkerSeen = observedMarker !== undefined && initial.queue !== undefined
      ? queueContainsMarker(initial.queue, observedMarker)
      : false
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
