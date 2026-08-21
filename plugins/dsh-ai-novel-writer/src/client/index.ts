/** Browser entry for the bundle. */

import type { ClientConnectionRpc, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext, ISessions, IWorkspaces } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { parseNovelAssetReadResult, parseNovelContextReadResult } from '../context-types.ts'
import {
  PresetSetupController,
  PresetSetupDisconnectedError,
  type PresetSetupPort,
} from './setup-store.ts'
import {
  NovelPluginStatusCard,
  NovelWorkbenchOverlay,
  NovelWorkbenchTrigger,
  type NovelWorkbenchInjected,
} from './context-view.tsx'
import { observeNovelContextSources, type NovelContextSelectionSources } from './context-observer.ts'
import { NovelWorkbenchRouteController, observeNovelV2Workspace } from './workbench-v2-observer.ts'
import { installNovelContextStyle } from './setup-style.ts'
import {
  NovelWorkbenchController,
  NovelWorkbenchDisconnectedError,
  NovelV2WorkbenchController,
  type NovelWorkbenchPort,
  type NovelV2WorkbenchPort,
} from './workbench-store.ts'
import type { NovelStateReadResult } from '../command-rpc.ts'
import type { NovelAggregateRef, NovelProposalSummary, NovelTaskAggregate } from '../novel-store.ts'

export { PresetSetupBody } from './setup-view.tsx'
export type { PresetSetupBodyProps } from './setup-view.tsx'
export {
  installDrawerKeyboardScope,
  installWorkbenchLayoutReservation,
  NovelPluginCardBody,
  NovelPluginStatusCard,
  NovelWorkbenchBody,
  NovelWorkbenchOverlay,
  NovelWorkbenchTrigger,
} from './context-view.tsx'
export type {
  NovelPluginCardBodyProps,
  NovelWorkbenchBodyProps,
  NovelWorkbenchInjected,
} from './context-view.tsx'
export { observeNovelContextSources } from './context-observer.ts'
export type { NovelContextSelectionSources } from './context-observer.ts'
export { observeNovelV2Workspace } from './workbench-v2-observer.ts'
export type { NovelV2WorkspaceSelectionSources } from './workbench-v2-observer.ts'
export {
  PresetSetupController,
  PresetSetupDisconnectedError,
} from './setup-store.ts'
export type { PresetSetupPort, PresetSetupState } from './setup-store.ts'
export {
  AI_NOVEL_PRESET_ID,
  initializationProposalPrompt,
  NovelWorkbenchController,
  NovelWorkbenchDisconnectedError,
  NovelV2WorkbenchController,
} from './workbench-store.ts'
export type {
  NovelApprovalAvailability,
  NovelInitializationDraft,
  NovelInitializationIdentity,
  NovelInitializationPhase,
  NovelInitializationPreview,
  NovelInitializationState,
  NovelPromptResult,
  NovelReadFeedback,
  NovelWorkbenchPort,
  NovelWorkbenchState,
  NovelWorkbenchTarget,
  NovelV2WorkbenchPort,
  NovelV2WorkbenchState,
} from './workbench-store.ts'
export { installNovelContextStyle, novelContextCss } from './setup-style.ts'

/** Required browser services. */
export const inject = ['slots', 'connection', 'sessions', 'workspaces']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStatus(value: unknown): { readonly status: 'not-installed' | 'installed' | 'conflict' } {
  if (!isRecord(value)
    || (value.status !== 'not-installed' && value.status !== 'installed' && value.status !== 'conflict')) {
    throw new Error('AI novel preset status response is invalid')
  }
  return { status: value.status }
}

function readInstall(value: unknown): { readonly status: 'installed' | 'conflict'; readonly changed: boolean } {
  if (!isRecord(value)
    || (value.status !== 'installed' && value.status !== 'conflict')
    || typeof value.changed !== 'boolean') {
    throw new Error('AI novel preset install response is invalid')
  }
  return { status: value.status, changed: value.changed }
}

async function callSetup(
  rpc: Pick<ClientConnectionRpc, 'call'>,
  endpoint: string,
  signal: AbortSignal,
): Promise<unknown> {
  let result
  try {
    result = await rpc.call('/ai-novel', endpoint, {}, signal)
  } catch (error) {
    throw new PresetSetupDisconnectedError(error)
  }
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/**
 * Adapt the generic Connection RPC caller to the closed preset setup interface.
 *
 * @param rpc Browser connection RPC caller.
 * @returns A validated setup port with no path-bearing operations.
 */
export function createPresetSetupPort(rpc: Pick<ClientConnectionRpc, 'call'>): PresetSetupPort {
  return {
    status: async signal => readStatus(await callSetup(rpc, 'preset/status', signal)),
    install: async signal => readInstall(await callSetup(rpc, 'preset/install', signal)),
  }
}

/**
 * Adapt the generic Connection RPC caller to the path-free context read interface.
 *
 * @param rpc Browser connection RPC caller.
 * @returns A validated context port accepting only opaque Workspace identity and chapter number.
 */
export function createNovelContextPort(
  rpc: Pick<ClientConnectionRpc, 'call'>,
): Pick<NovelWorkbenchPort, 'read' | 'readAsset'> {
  return {
    read: async (workspaceId, chapter, signal) => {
      let result
      try {
        result = await rpc.call('/ai-novel', 'context/read', { workspaceId, chapter }, signal)
      } catch (error) {
        throw new NovelWorkbenchDisconnectedError(error)
      }
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return parseNovelContextReadResult(result.value)
    },
    readAsset: async (workspaceId, target, signal) => {
      let result
      try {
        result = await rpc.call('/ai-novel', 'asset/read', { workspaceId, target }, signal)
      } catch (error) {
        throw new NovelWorkbenchDisconnectedError(error)
      }
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return parseNovelAssetReadResult(result.value)
    },
  }
}

/**
 * Adapt Host reads and the current Session face to the workbench's closed port.
 *
 * @param rpc Browser connection RPC caller.
 * @param sessions Browser Session registry used only for ordinary prompt submission.
 * @returns A path-free port with no mutation RPC.
 */
export function createNovelWorkbenchPort(
  rpc: Pick<ClientConnectionRpc, 'call'>,
  sessions: Pick<ISessions, 'binding'>,
): NovelWorkbenchPort {
  const context = createNovelContextPort(rpc)
  return {
    read: context.read,
    readAsset: context.readAsset,
    prompt: async (sessionId, text) => {
      const session = sessions.binding(sessionId)?.session
      if (session === undefined) {
        return { ok: false, error: { code: 'session-unavailable', message: '当前会话尚未就绪' } }
      }
      return session.prompt([{ type: 'text', text }], 'queue')
    },
  }
}

function rejectPathBearingValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectPathBearingValue(item)
    return
  }
  if (!isRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'path' || key === 'workspacePath' || key === 'archivePath') {
      throw new Error('AI novel V2 response must not contain a local path')
    }
    rejectPathBearingValue(nested)
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value))
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isV2AggregateRef(value: unknown): value is NovelAggregateRef {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'chapter') return isNonNegativeInteger(value.chapter) && value.chapter > 0
  if (value.kind === 'task') return isNonEmptyString(value.taskId)
  return value.kind === 'project' || value.kind === 'architecture' || value.kind === 'characters'
}

function isV2Project(value: unknown, revision: boolean): boolean {
  return isRecord(value)
    && (!revision || isNonNegativeInteger(value.revision))
    && typeof value.title === 'string' && typeof value.language === 'string' && typeof value.genre === 'string'
    && isNonNegativeInteger(value.plannedChapters) && value.plannedChapters > 0
    && isNonNegativeInteger(value.targetWordsPerChapter) && value.targetWordsPerChapter > 0
    && (value.creativeStrategy === 'auto' || value.creativeStrategy === 'fluent-drafting'
      || value.creativeStrategy === 'consistency-first' || value.creativeStrategy === 'deep-planning')
    && (value.structureMode === 'episodic' || value.structureMode === 'three-act' || value.structureMode === 'multi-thread')
    && (value.narrativePov === 'first' || value.narrativePov === 'third-limited'
      || value.narrativePov === 'third-omniscient' || value.narrativePov === 'multi-pov')
    && typeof value.globalGuidance === 'string' && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt)
}

function isV2Architecture(value: unknown, revision: boolean): boolean {
  return isRecord(value)
    && (!revision || isNonNegativeInteger(value.revision))
    && typeof value.premise === 'string' && typeof value.characterGraph === 'string'
    && typeof value.world === 'string' && typeof value.plotOutline === 'string'
    && typeof value.styleConstraints === 'string' && isStringArray(value.referenceWorks)
}

function isV2Characters(value: unknown, revision: boolean): boolean {
  return isRecord(value)
    && (!revision || isNonNegativeInteger(value.revision))
    && Array.isArray(value.items) && value.items.every(item => isRecord(item)
      && isNonEmptyString(item.characterId) && typeof item.name === 'string' && typeof item.role === 'string'
      && typeof item.summary === 'string' && typeof item.goal === 'string'
      && typeof item.currentState === 'string' && typeof item.notes === 'string')
    && Array.isArray(value.relationships) && value.relationships.every(relationship => isRecord(relationship)
      && isNonEmptyString(relationship.fromCharacterId) && isNonEmptyString(relationship.toCharacterId)
      && typeof relationship.relation === 'string' && typeof relationship.notes === 'string')
}

function isV2Chapter(value: unknown, revision: boolean): boolean {
  return isRecord(value)
    && (!revision || isNonNegativeInteger(value.revision))
    && isNonNegativeInteger(value.chapter) && value.chapter > 0 && typeof value.title === 'string'
    && typeof value.purpose === 'string' && isStringArray(value.plotBeats) && isStringArray(value.characters)
    && isStringArray(value.keyEvents) && typeof value.suspense === 'string'
    && (value.status === 'planned' || value.status === 'drafting' || value.status === 'reviewing'
      || value.status === 'revising' || value.status === 'finalized')
}

function isV2Task(value: unknown): value is NovelTaskAggregate {
  return isRecord(value)
    && isNonNegativeInteger(value.revision)
    && isNonEmptyString(value.taskId)
    && (value.kind === 'architecture' || value.kind === 'chapter' || value.kind === 'review'
      || value.kind === 'revision' || value.kind === 'finalization')
    && typeof value.stage === 'string'
    && (value.status === 'pending' || value.status === 'running' || value.status === 'blocked'
      || value.status === 'succeeded' || value.status === 'failed' || value.status === 'cancelled')
    && typeof value.failure === 'string' && typeof value.resumeCursor === 'string'
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt)
}

function isV2Provenance(value: unknown): boolean {
  return isRecord(value) && (value.origin === 'manual'
    || (value.origin === 'model' && isNonEmptyString(value.sessionId) && isNonEmptyString(value.callId)
      && isNonEmptyString(value.argsHash)))
}

function isV2ChangeSet(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.changeSetId) || value.operation !== 'replace'
    || !isV2AggregateRef(value.aggregate) || !isNonNegativeInteger(value.baseAggregateRevision)
    || !isNonNegativeInteger(value.baseGlobalRevision) || !isV2Provenance(value.provenance) || !isRecord(value.nextValue)) return false
  if (value.aggregate.kind === 'project') return isV2Project(value.nextValue, false)
  if (value.aggregate.kind === 'architecture') return isV2Architecture(value.nextValue, false)
  if (value.aggregate.kind === 'characters') return isV2Characters(value.nextValue, false)
  if (value.aggregate.kind === 'chapter') {
    return isV2Chapter(value.nextValue, false) && value.nextValue.chapter === value.aggregate.chapter
  }
  return isV2Task({ ...value.nextValue, revision: 0 }) && value.nextValue.taskId === value.aggregate.taskId
}

function isV2ChangeAuditRecord(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.changeSetId) && value.operation === 'replace'
    && isV2AggregateRef(value.aggregate) && isNonNegativeInteger(value.baseAggregateRevision)
    && isNonNegativeInteger(value.baseGlobalRevision) && isNonNegativeInteger(value.aggregateRevision)
    && isNonNegativeInteger(value.globalRevision) && isV2Provenance(value.provenance) && value.status === 'committed'
}

function isV2Proposal(value: unknown): value is NovelProposalSummary {
  return isRecord(value) && isNonEmptyString(value.proposalId) && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.callId) && isNonEmptyString(value.argsHash)
    && (value.status === 'pending' || value.status === 'stale' || value.status === 'applied'
      || value.status === 'discarded' || value.status === 'superseded' || value.status === 'failed')
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt)
    && Array.isArray(value.changes) && value.changes.every(isV2ChangeSet)
}

function isV2MigrationReceipt(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.projectId) && isNonEmptyString(value.fingerprint)
    && isNonNegativeInteger(value.sourceCount) && isNonNegativeInteger(value.chapterCount)
    && isNonNegativeInteger(value.draftCount) && isTimestamp(value.migratedAt)
}

function isV2StateReadResult(value: unknown): value is NovelStateReadResult {
  if (!isRecord(value)
    || typeof value.projectId !== 'string' || value.projectId === ''
    || typeof value.workspaceId !== 'string' || value.workspaceId === ''
    || !isNonNegativeInteger(value.globalRevision) || typeof value.readOnly !== 'boolean'
    || !isRecord(value.storage) || !isRecord(value.project) || !isRecord(value.architecture) || !isRecord(value.characters)
    || !Array.isArray(value.chapters) || !Array.isArray(value.tasks) || !Array.isArray(value.changes)
    || !Array.isArray(value.proposals) || !(value.migration === undefined || isV2MigrationReceipt(value.migration))) return false
  return isNonNegativeInteger(value.storage.applicationId) && isNonNegativeInteger(value.storage.userVersion)
    && typeof value.storage.foreignKeys === 'boolean' && typeof value.storage.journalMode === 'string'
    && typeof value.storage.synchronous === 'string' && typeof value.storage.lockingMode === 'string'
    && isV2Project(value.project, true) && isV2Architecture(value.architecture, true)
    && isV2Characters(value.characters, true) && value.chapters.every(chapter => isV2Chapter(chapter, true))
    && value.tasks.every(isV2Task) && value.changes.every(isV2ChangeAuditRecord) && value.proposals.every(isV2Proposal)
}

function isV2ProposalList(value: unknown): value is { readonly proposals: readonly NovelProposalSummary[] } {
  return isRecord(value) && Array.isArray(value.proposals) && value.proposals.every(isV2Proposal)
}

async function callV2Workbench(
  rpc: Pick<ClientConnectionRpc, 'call'>,
  endpoint: 'state/read' | 'proposal/list' | 'task/read',
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  let result
  try {
    result = await rpc.call('/ai-novel', endpoint, payload, signal)
  } catch (error) {
    throw new NovelWorkbenchDisconnectedError(error)
  }
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  rejectPathBearingValue(result.value)
  return result.value
}

/**
 * Adapt only the already-published V2 loopback read contracts to the sidebar shell.
 * It deliberately exposes neither command preview/commit nor task execution.
 */
export function createNovelV2WorkbenchPort(
  rpc: Pick<ClientConnectionRpc, 'call'>,
): NovelV2WorkbenchPort {
  return {
    readState: async (workspaceId, signal) => {
      const value = await callV2Workbench(rpc, 'state/read', { workspaceId }, signal)
      if (!isV2StateReadResult(value) || value.workspaceId !== workspaceId) {
        throw new Error('AI novel V2 state response is invalid')
      }
      return value
    },
    listProposals: async (workspaceId, signal) => {
      const value = await callV2Workbench(rpc, 'proposal/list', { workspaceId }, signal)
      if (!isV2ProposalList(value)) throw new Error('AI novel V2 proposal response is invalid')
      return value.proposals
    },
    readTask: async (workspaceId, taskId, signal) => {
      const value = await callV2Workbench(rpc, 'task/read', { workspaceId, taskId }, signal)
      if (!isV2Task(value) || value.taskId !== taskId) throw new Error('AI novel V2 task response is invalid')
      return value
    },
  }
}

/**
 * Register the sidebar setup trigger and shell overlay over one shared controller.
 *
 * @param ctx Browser Cordis context.
 * @returns Nothing.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const controller = new PresetSetupController(
    createPresetSetupPort(connection.rpc),
    error => { ctx.logger.warn(error) },
  )
  const sessions = ctx.get('sessions' as never) as ISessions | undefined
  const workspaces = ctx.get('workspaces' as never) as IWorkspaces | undefined
  if (sessions === undefined || workspaces === undefined) {
    throw new Error('AI novel context requires the browser Session and Workspace services')
  }
  const workbenchController = new NovelWorkbenchController(
    createNovelWorkbenchPort(connection.rpc, sessions),
    error => { ctx.logger.warn(error) },
  )
  const v2WorkbenchController = new NovelV2WorkbenchController(
    createNovelV2WorkbenchPort(connection.rpc),
  )
  const workbenchRoute = new NovelWorkbenchRouteController()
  ctx.effect(() => {
    const stopObserving = observeNovelContextSources({
      sessions,
      workspaces,
    } satisfies NovelContextSelectionSources, workbenchController)
    const stopV2Workspace = observeNovelV2Workspace({ sessions, workspaces }, v2WorkbenchController, workbenchRoute)
    return async () => {
      stopObserving()
      stopV2Workspace()
      workbenchRoute.dispose()
      await Promise.all([controller.dispose(), workbenchController.dispose(), v2WorkbenchController.dispose()])
    }
  }, 'ai-novel-writer: setup and context lifecycle')
  if (typeof document !== 'undefined') {
    ctx.effect(() => installNovelContextStyle(document), 'ai-novel-writer: context-window styles')
  }

  ctx.effect(() => {
    let stopped = false
    let refreshScheduled = false
    const refreshConnectedState = (): void => {
      if (stopped || refreshScheduled) return
      refreshScheduled = true
      queueMicrotask(() => {
        refreshScheduled = false
        if (stopped || connection.hostDescription.getSnapshot() === undefined) return
        if (controller.getSnapshot().status !== 'idle') void controller.load()
        if (workbenchController.getSnapshot().open) void workbenchController.refresh()
        else void workbenchController.inspect()
        if (v2WorkbenchController.getSnapshot().open) void v2WorkbenchController.refresh()
      })
    }
    const stopDescription = connection.hostDescription.subscribe(() => {
      if (connection.hostDescription.getSnapshot() === undefined) {
        controller.disconnected()
        workbenchController.disconnected()
        v2WorkbenchController.disconnected()
        return
      }
      refreshConnectedState()
    })
    const stopReset = ctx.on('connection/reset', refreshConnectedState)
    return () => {
      stopped = true
      stopReset()
      stopDescription()
    }
  }, 'ai-novel-writer: observe and refresh Host connection')

  const workbenchInjected = (): NovelWorkbenchInjected => ({
    workbenchController,
    v2WorkbenchController,
    workbenchRoute,
    setupController: controller,
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'ai-novel-workbench',
    order: 90,
    label: '小说工作台',
    inject: workbenchInjected,
  }, NovelWorkbenchTrigger))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'ai-novel-workbench',
    order: 90,
    inject: workbenchInjected,
  }, NovelWorkbenchOverlay))
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'ai-novel-writer',
    order: 90,
    inject: workbenchInjected,
  }, NovelPluginStatusCard))
}
