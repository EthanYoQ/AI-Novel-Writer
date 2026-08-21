/** Loopback command face for the authoritative V2 NovelStore. */

import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import {
  NovelStoreError,
  openNovelStore,
  recoverNovelStoreBinding,
  validateNovelChangeSet,
  type NovelAggregateRef,
  type NovelChangeSet,
  type NovelChapterNextValue,
  type NovelCharactersNextValue,
  type NovelStore,
  type NovelStoreSnapshot,
  type NovelTaskAggregate,
  type NovelProposalSummary,
  type NovelProposalItem,
  type NovelProposalStatus,
  type NovelProposalItemStatus,
  type NovelProposalItemFailure,
  type NovelProposalItemReceipt,
  type NovelProposalApplyResult,
  type NovelProposalItemMutationResult,
  type NovelProposalRegenerationResult,
  type NovelStoreRecoveryMode,
  type NovelStoreRecoveryReceipt,
} from './novel-store.ts'

/** Migration evidence that is safe to expose outside the Host filesystem boundary. */
export interface NovelMigrationStateReadReceipt {
  readonly projectId: NovelStoreSnapshot['projectId']
  readonly fingerprint: string
  readonly sourceCount: number
  readonly chapterCount: number
  readonly draftCount: number
  readonly migratedAt: string
}

/** Authoritative state projection with all Host-local paths removed. */
export type NovelStateReadResult = Omit<NovelStoreSnapshot, 'workspacePath' | 'migration'> & {
  readonly migration: NovelMigrationStateReadReceipt | undefined
}

/** Remove Host-local migration archive paths before a `state/read` result crosses the RPC boundary. */
export function projectNovelStateRead(snapshot: NovelStoreSnapshot): NovelStateReadResult {
  const { workspacePath: _workspacePath, migration, ...state } = snapshot
  return {
    ...state,
    migration: migration === undefined ? undefined : {
      projectId: migration.projectId,
      fingerprint: migration.fingerprint,
      sourceCount: migration.sourceCount,
      chapterCount: migration.chapterCount,
      draftCount: migration.draftCount,
      migratedAt: migration.migratedAt,
    },
  }
}

/** Summary of one persisted, non-authoritative model proposal. */
export type {
  NovelProposalSummary,
  NovelProposalItem,
  NovelProposalStatus,
  NovelProposalItemStatus,
  NovelProposalItemFailure,
  NovelProposalItemReceipt,
  NovelProposalApplyResult,
  NovelProposalItemMutationResult,
  NovelProposalRegenerationResult,
}

/** Proposal inbox projection returned to the sidebar. */
export interface NovelProposalListResult {
  readonly proposals: readonly NovelProposalSummary[]
}

/** Path-free result of one explicit Host-authorized workspace recovery. */
export type NovelWorkspaceRecoveryResult = NovelStoreRecoveryReceipt

/** Closed command shared by preview and commit: one aggregate replacement with its complete next value. */
export type NovelLoopbackCommand = Omit<NovelChangeSet, 'changeSetId' | 'operation' | 'provenance'>

/** One entity-level field change inside a preview diff. */
export interface NovelCommandDiffChange {
  readonly path: string
  readonly before: unknown
  readonly after: unknown
}

/** Preview projection derived from the authoritative store without writing to it. */
export interface NovelCommandPreviewResult {
  readonly aggregate: NovelAggregateRef
  readonly baseAggregateRevision: number
  readonly baseGlobalRevision: number
  readonly nextValue: unknown
  readonly changes: readonly NovelCommandDiffChange[]
}

/** Minimal read face consumed from the Host Workspace registry. */
export interface NovelWorkspaceRegistry {
  /**
   * Resolve an opaque Workspace identity without accepting a browser path.
   *
   * @param workspaceId Opaque Workspace identity received from the browser.
   * @returns The registered canonical directory, or undefined for an unknown id.
   */
  get(workspaceId: WorkspaceId): Pick<Workspace, 'path'> | undefined
}

type CommandRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** Human-readable request labels shared by stable failure messages. */
const ENDPOINT_LABEL: Record<string, string> = {
  'state/read': 'Novel state',
  'proposal/list': 'Novel proposal list',
  'proposal/apply': 'Novel proposal apply',
  'proposal/retry': 'Novel proposal retry',
  'proposal/discard': 'Novel proposal discard',
  'proposal/regenerate': 'Novel proposal regenerate',
  'task/read': 'Novel task',
  'command/preview': 'command/preview',
  'command/commit': 'command/commit',
  'workspace/reattach': 'Novel workspace re-attach',
  'workspace/clone': 'Novel workspace clone',
}

function badRequest(message: string): CommandRpcResult {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function internalFailure(message: string): CommandRpcResult {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function reportFailure(report: (error: unknown) => void, error: unknown): void {
  try {
    report(error)
  } catch (reportingError) {
    void reportingError
  }
}

function workspaceOnlyRequest(value: unknown): WorkspaceId | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== ['workspaceId'].join('\0')) return undefined
  if (typeof record.workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(record.workspaceId)) return undefined
  return WorkspaceId(record.workspaceId)
}

/** Non-empty, trim-stable string; empty strings are only allowed where the field name opts in. */
function requireNonEmptyWireString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function requirePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function requireNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).sort().join('\0') === [...keys].sort().join('\0')
}

/**
 * Parse the closed command selector shared by preview and commit. This layer only checks the
 * wire envelope (exact keys, aggregate selector shape, revision and changeSetId presence); the
 * complete nextValue semantics stay with the shared store validator so preview and commit can
 * never drift apart.
 *
 * @param value Wire command candidate from the browser payload.
 * @param requireChangeSetId Whether a non-empty changeSetId is required (commit only).
 * @returns A wire-shaped command, or undefined for any unknown key, path, patch, or malformed
 *   envelope field.
 */
function parseCommand(value: unknown, requireChangeSetId: boolean): (NovelLoopbackCommand & { readonly changeSetId?: string }) | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = ['aggregate', 'baseAggregateRevision', 'baseGlobalRevision', 'nextValue', ...(requireChangeSetId ? ['changeSetId'] : [])]
  if (!exactKeys(record, keys)) return undefined
  const baseAggregateRevision = requireNonNegativeInteger(record.baseAggregateRevision)
  const baseGlobalRevision = requireNonNegativeInteger(record.baseGlobalRevision)
  if (baseAggregateRevision === undefined || baseGlobalRevision === undefined) return undefined
  let changeSetId: string | undefined
  if (requireChangeSetId) {
    changeSetId = requireNonEmptyWireString(record.changeSetId)
    if (changeSetId === undefined) return undefined
  }
  if (typeof record.aggregate !== 'object' || record.aggregate === null || Array.isArray(record.aggregate)) return undefined
  const aggregate = record.aggregate as Record<string, unknown>
  let selector: NovelAggregateRef
  if (aggregate.kind === 'project' || aggregate.kind === 'architecture' || aggregate.kind === 'characters') {
    if (!exactKeys(aggregate, ['kind'])) return undefined
    selector = { kind: aggregate.kind }
  } else if (aggregate.kind === 'chapter') {
    if (!exactKeys(aggregate, ['kind', 'chapter'])) return undefined
    const chapter = requirePositiveInteger(aggregate.chapter)
    if (chapter === undefined) return undefined
    selector = { kind: 'chapter', chapter }
  } else if (aggregate.kind === 'task') {
    if (!exactKeys(aggregate, ['kind', 'taskId'])) return undefined
    const taskId = requireNonEmptyWireString(aggregate.taskId)
    if (taskId === undefined) return undefined
    selector = { kind: 'task', taskId }
  } else {
    return undefined
  }
  return {
    aggregate: selector,
    baseAggregateRevision,
    baseGlobalRevision,
    nextValue: record.nextValue as NovelLoopbackCommand['nextValue'],
    ...(changeSetId === undefined ? {} : { changeSetId }),
  } as NovelLoopbackCommand & { readonly changeSetId?: string }
}

/**
 * Build the validated single-aggregate ChangeSet for one parsed wire command.
 *
 * @param command Wire-shaped command from {@link parseCommand}.
 * @param commit Whether the real changeSetId is required (commit) or a preview placeholder is used.
 * @returns The ChangeSet validated by the shared store contract.
 * @throws {@link NovelStoreError} for any semantic violation the store would reject.
 */
function validateCommand(
  command: NovelLoopbackCommand & { readonly changeSetId?: string },
  commit: boolean,
): NovelChangeSet {
  return validateNovelChangeSet({
    ...command,
    changeSetId: commit ? command.changeSetId ?? '' : 'loopback-preview',
    operation: 'replace',
    provenance: { origin: 'manual' },
  } as NovelChangeSet)
}

/**
 * Parse the closed preview/commit payload: a branded Workspace id plus its wire command.
 *
 * @param value Wire payload candidate from the browser.
 * @param requireChangeSetId Whether the command must carry a changeSetId (commit only).
 * @returns The Workspace identity and wire-shaped command, or undefined for any path, patch,
 *   unknown key, or malformed envelope.
 */
function parseCommandPayload(value: unknown, requireChangeSetId: boolean): { readonly workspaceId: WorkspaceId; readonly command: NovelLoopbackCommand & { readonly changeSetId?: string } } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!exactKeys(record, ['workspaceId', 'command'])) return undefined
  if (typeof record.workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(record.workspaceId)) return undefined
  const command = parseCommand(record.command, requireChangeSetId)
  if (command === undefined) return undefined
  return { workspaceId: WorkspaceId(record.workspaceId), command }
}

function taskPayload(value: unknown): { readonly workspaceId: WorkspaceId; readonly taskId: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!exactKeys(record, ['workspaceId', 'taskId'])) return undefined
  if (typeof record.workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(record.workspaceId)) return undefined
  const taskId = requireNonEmptyWireString(record.taskId)
  if (taskId === undefined || !TASK_ID_PATTERN.test(taskId)) return undefined
  return { workspaceId: WorkspaceId(record.workspaceId), taskId }
}

/** Parse path-free proposal lifecycle requests; proposal and item ids are opaque UUIDs only. */
function proposalPayload(
  value: unknown,
  withItem: boolean,
): { readonly workspaceId: WorkspaceId; readonly proposalId: string; readonly itemId?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!exactKeys(record, withItem ? ['workspaceId', 'proposalId', 'itemId'] : ['workspaceId', 'proposalId'])) return undefined
  if (typeof record.workspaceId !== 'string' || !WORKSPACE_ID_PATTERN.test(record.workspaceId)) return undefined
  if (typeof record.proposalId !== 'string' || !WORKSPACE_ID_PATTERN.test(record.proposalId)) return undefined
  if (!withItem) return { workspaceId: WorkspaceId(record.workspaceId), proposalId: record.proposalId }
  if (typeof record.itemId !== 'string' || !WORKSPACE_ID_PATTERN.test(record.itemId)) return undefined
  return { workspaceId: WorkspaceId(record.workspaceId), proposalId: record.proposalId, itemId: record.itemId }
}

function entityDiff(before: unknown, after: unknown, path: string, out: NovelCommandDiffChange[]): void {
  if (Array.isArray(before) || Array.isArray(after)
    || typeof before !== 'object' || before === null
    || typeof after !== 'object' || after === null) {
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, before, after })
    return
  }
  const beforeRecord = before as Record<string, unknown>
  const afterRecord = after as Record<string, unknown>
  for (const key of Object.keys(afterRecord)) {
    entityDiff(beforeRecord[key], afterRecord[key], path === '' ? key : `${path}.${key}`, out)
  }
}

function currentAggregateValue(store: NovelStoreSnapshot, aggregate: NovelAggregateRef): unknown {
  switch (aggregate.kind) {
    case 'project': return store.project
    case 'architecture': return store.architecture
    case 'characters': return store.characters
    case 'chapter': return store.chapters.find(chapter => chapter.chapter === aggregate.chapter)
    case 'task': return store.tasks.find(task => task.taskId === aggregate.taskId)
  }
}

function currentAggregateRevision(store: NovelStoreSnapshot, aggregate: NovelAggregateRef): number {
  const current = currentAggregateValue(store, aggregate)
  if (typeof current !== 'object' || current === null || !('revision' in current)) return 0
  return (current as { readonly revision: number }).revision
}

/**
 * Relationship integrity the store enforces inside its commit transaction, checked for a
 * preview against the authoritative snapshot so the browser never sees a diff the store
 * would refuse: chapter casts must exist, and a characters replacement must retain every
 * character still referenced by a chapter.
 *
 * @param snapshot Authoritative projection the preview is based on.
 * @param command Validated ChangeSet under preview.
 * @returns The integrity failure to report, or undefined when the command would commit.
 */
function previewIntegrityError(
  snapshot: NovelStoreSnapshot,
  command: NovelChangeSet,
): NovelStoreError | undefined {
  if (command.aggregate.kind === 'chapter') {
    const nextValue = command.nextValue as NovelChapterNextValue
    const known = new Set(snapshot.characters.items.map(item => item.characterId))
    if (nextValue.characters.some(characterId => !known.has(characterId))) {
      return new NovelStoreError('INVALID_CONTENT', 'chapter characters must already exist')
    }
    return undefined
  }
  if (command.aggregate.kind === 'characters') {
    const nextValue = command.nextValue as NovelCharactersNextValue
    const retained = new Set(nextValue.items.map(item => item.characterId))
    const referenced = new Set(snapshot.chapters.flatMap(chapter => chapter.characters))
    if ([...referenced].some(characterId => !retained.has(characterId))) {
      return new NovelStoreError('INVALID_CONTENT', 'characters collection still has chapter references')
    }
  }
  return undefined
}

/**
 * Map one underlying failure to the stable loopback failure projection.
 *
 * NovelStore failures keep their machine-readable code but never their message, which may
 * contain a local path; unexpected failures collapse to `internal`. Cancellation is reported
 * without involving the diagnostic sink.
 *
 * @param endpoint Closed endpoint label used in the stable message.
 * @param error Underlying failure, potentially carrying Host-only detail.
 * @param signal Cancellation signal for the in-flight request.
 * @param report Host-only diagnostic sink for the underlying failure.
 * @returns The stable RPC failure without local paths.
 */
function stableStoreFailure(endpoint: string, error: unknown, signal: AbortSignal, report: (error: unknown) => void): CommandRpcResult {
  const label = ENDPOINT_LABEL[endpoint] ?? endpoint
  if (signal.aborted || (error instanceof NovelStoreError && error.code === 'CANCELLED')) {
    return { ok: false, error: { code: 'cancelled', message: `${label} request was cancelled`, details: {} } }
  }
  reportFailure(report, error)
  if (error instanceof NovelStoreError) return badRequest(`${label} request failed: ${error.code}`)
  return internalFailure(`${label} request failed`)
}

/**
 * Close the store without letting a disposal failure replace an already settled result.
 *
 * @param store Opened store instance to dispose.
 * @param report Host-only diagnostic sink for a disposal failure.
 * @returns Nothing; a disposal failure is only reported.
 */
async function disposeQuietly(store: NovelStore, report: (error: unknown) => void): Promise<void> {
  try {
    await store.dispose()
  } catch (error) {
    reportFailure(report, error)
  }
}

/**
 * Create the closed V2 state and command loopback RPC face.
 *
 * @param workspaces Authoritative Workspace registry read face.
 * @param reportFailure Host-only diagnostic sink for underlying errors.
 * @returns A handler for the V2 state, proposal, task, command, and explicit recovery endpoints.
 */
export function createAiNovelCommandRpcHandler(
  workspaces: NovelWorkspaceRegistry,
  reportFailure: (error: unknown) => void = () => {},
): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    if (endpoint !== 'state/read' && endpoint !== 'proposal/list' && endpoint !== 'task/read'
      && endpoint !== 'command/preview' && endpoint !== 'command/commit'
      && endpoint !== 'proposal/apply' && endpoint !== 'proposal/retry'
      && endpoint !== 'proposal/discard' && endpoint !== 'proposal/regenerate'
      && endpoint !== 'workspace/reattach' && endpoint !== 'workspace/clone') {
      return badRequest(`Unknown AI novel endpoint: ${endpoint}`)
    }
    let workspaceId: WorkspaceId
    let taskId: string | undefined
    let changeSet: NovelChangeSet | undefined
    let recovery: NovelStoreRecoveryMode | undefined
    let proposalId: string | undefined
    let itemId: string | undefined
    if (endpoint === 'state/read' || endpoint === 'proposal/list'
      || endpoint === 'workspace/reattach' || endpoint === 'workspace/clone') {
      const resolved = workspaceOnlyRequest(payload)
      if (resolved === undefined) {
        return badRequest('Novel command payload must contain only a Workspace UUID')
      }
      workspaceId = resolved
      if (endpoint === 'workspace/reattach') recovery = 'reattach'
      if (endpoint === 'workspace/clone') recovery = 'clone'
    } else if (endpoint === 'task/read') {
      const resolved = taskPayload(payload)
      if (resolved === undefined) {
        return badRequest('Novel task payload must contain only a Workspace UUID and a task id')
      }
      workspaceId = resolved.workspaceId
      taskId = resolved.taskId
    } else if (endpoint === 'proposal/apply' || endpoint === 'proposal/retry'
      || endpoint === 'proposal/discard' || endpoint === 'proposal/regenerate') {
      const resolved = proposalPayload(
        payload,
        endpoint === 'proposal/retry' || endpoint === 'proposal/discard' || endpoint === 'proposal/regenerate',
      )
      if (resolved === undefined) {
        return badRequest(`Novel ${endpoint} payload must contain only opaque Workspace, proposal, and required item UUIDs`)
      }
      workspaceId = resolved.workspaceId
      proposalId = resolved.proposalId
      itemId = resolved.itemId
    } else {
      const resolved = parseCommandPayload(payload, endpoint === 'command/commit')
      if (resolved === undefined) {
        return badRequest(`Novel ${endpoint === 'command/commit' ? 'commit' : 'preview'} payload must contain only a Workspace UUID and a typed command`)
      }
      workspaceId = resolved.workspaceId
      try {
        changeSet = validateCommand(resolved.command, endpoint === 'command/commit')
      } catch (error) {
        return stableStoreFailure(endpoint, error, signal, reportFailure)
      }
    }
    const workspace = workspaces.get(workspaceId)
    if (workspace === undefined) return badRequest(`Unknown Workspace: ${workspaceId}`)
    if (recovery !== undefined) {
      try {
        const value: NovelWorkspaceRecoveryResult = await recoverNovelStoreBinding(
          workspace.path,
          workspaceId,
          recovery,
          signal,
        )
        return { ok: true, value }
      } catch (error) {
        return stableStoreFailure(endpoint, error, signal, reportFailure)
      }
    }
    let store: NovelStore
    try {
      // The loopback read/command face never initializes a project; opening must not create
      // `.ai-novel` or an empty novel.db for an uninitialized workspace.
      store = await openNovelStore(workspace.path, workspaceId, { create: false })
    } catch (error) {
      return stableStoreFailure(endpoint, error, signal, reportFailure)
    }
    try {
      if (endpoint === 'proposal/list') {
        const proposals = await store.listProposals(signal)
        const value: NovelProposalListResult = { proposals }
        return { ok: true, value }
      }
      if (endpoint === 'proposal/apply') {
        return { ok: true, value: await store.applyProposal(proposalId!, signal) }
      }
      if (endpoint === 'proposal/retry') {
        return { ok: true, value: await store.retryProposalItem(proposalId!, itemId!, signal) }
      }
      if (endpoint === 'proposal/discard') {
        return { ok: true, value: await store.discardProposalItem(proposalId!, itemId!, signal) }
      }
      if (endpoint === 'proposal/regenerate') {
        return { ok: true, value: await store.requestProposalRegeneration(proposalId!, itemId!, signal) }
      }
      if (endpoint === 'task/read') {
        const snapshot = await store.read(signal)
        const task: NovelTaskAggregate | undefined = snapshot.tasks.find(candidate => candidate.taskId === taskId)
        if (task === undefined) return badRequest(`Novel task request failed: unknown task ${taskId}`)
        return { ok: true, value: task }
      }
      if (endpoint === 'command/preview' || endpoint === 'command/commit') {
        const commit = endpoint === 'command/commit'
        const validated = changeSet as NovelChangeSet
        try {
          if (commit) {
            return { ok: true, value: await store.applyChange(validated, signal) }
          }
          const snapshot = await store.read(signal)
          if (validated.baseAggregateRevision !== currentAggregateRevision(snapshot, validated.aggregate)
            || validated.baseGlobalRevision !== snapshot.globalRevision) {
            return stableStoreFailure(endpoint, new NovelStoreError('STALE_REVISION', 'novel aggregate changed since it was read'), signal, reportFailure)
          }
          const integrityError = previewIntegrityError(snapshot, validated)
          if (integrityError !== undefined) {
            return stableStoreFailure(endpoint, integrityError, signal, reportFailure)
          }
          const changes: NovelCommandDiffChange[] = []
          entityDiff(currentAggregateValue(snapshot, validated.aggregate), validated.nextValue, '', changes)
          const value: NovelCommandPreviewResult = {
            aggregate: validated.aggregate,
            baseAggregateRevision: validated.baseAggregateRevision,
            baseGlobalRevision: validated.baseGlobalRevision,
            nextValue: validated.nextValue,
            changes,
          }
          return { ok: true, value }
        } catch (error) {
          return stableStoreFailure(endpoint, error, signal, reportFailure)
        }
      }
      return { ok: true, value: projectNovelStateRead(await store.read(signal)) }
    } catch (error) {
      return stableStoreFailure(endpoint, error, signal, reportFailure)
    } finally {
      await disposeQuietly(store, reportFailure)
    }
  }
}
