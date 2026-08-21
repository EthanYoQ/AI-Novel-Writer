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

/** Narrow selection surface required by the V2 sidebar shell. */
export interface NovelV2WorkspaceSelectionSources {
  readonly sessions: {
    readonly list: Observable<{
      readonly current: SessionId | undefined
      readonly byId?: Readonly<Record<SessionId, { readonly agentPreset?: string }>>
    }>
  }
  readonly workspaces: {
    readonly list: Observable<{
      readonly items: ReadonlyArray<{ readonly workspaceId: WorkspaceId; readonly sessionIds: readonly SessionId[] }>
    }>
  }
}

/**
 * Follow the Workspace attached to the active Harness Session.
 * The browser only forwards an opaque Workspace identity to the V2 controller.
 */
export function observeNovelV2Workspace(
  sources: NovelV2WorkspaceSelectionSources,
  controller: NovelV2WorkbenchController,
  route: NovelWorkbenchRouteController,
): () => void {
  const reconcile = (): void => {
    const sessions = sources.sessions.list.getSnapshot()
    const sessionId = sessions.current
    const agentPreset = sessionId === undefined ? undefined : sessions.byId?.[sessionId]?.agentPreset
    route.setPreset(agentPreset)
    if (agentPreset !== AI_NOVEL_V2_PRESET_ID) {
      controller.setWorkspace(undefined)
      return
    }
    const workspaceId = sessionId === undefined
      ? undefined
      : sources.workspaces.list.getSnapshot().items
        .find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId
    controller.setWorkspace(workspaceId)
  }
  const stopSessions = sources.sessions.list.subscribe(reconcile)
  const stopWorkspaces = sources.workspaces.list.subscribe(reconcile)
  reconcile()
  return () => {
    stopSessions()
    stopWorkspaces()
  }
}
