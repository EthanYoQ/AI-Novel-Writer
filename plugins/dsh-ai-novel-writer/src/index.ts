/** Host entry and public domain exports for the AI novel bundle. */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { createAiNovelCommandRpcHandler, type NovelWorkspaceRegistry } from './command-rpc.ts'
import { parseNovelAssetRef } from './context-types.ts'
import { readNovelAsset, readNovelContext } from './context-window.ts'
import { createPresetInstaller } from './preset-installer.ts'
import type { AssetRef } from './types.ts'

export { openNovelProject } from './novel-project.ts'
export type { NovelProjectOptions } from './novel-project.ts'
export { NovelStoreError, openNovelStore, validateNovelChangeSet } from './novel-store.ts'
export type {
  NovelAggregateRef,
  NovelArchitectureAggregate,
  NovelArchitectureNextValue,
  NovelChangeAuditRecord,
  NovelChangeReceipt,
  NovelChangeSet,
  NovelChangeProvenance,
  NovelChapterAggregate,
  NovelChapterNextValue,
  NovelCharactersAggregate,
  NovelCharactersNextValue,
  NovelProjectAggregate,
  NovelProjectNextValue,
  NovelStore,
  NovelStoreErrorCode,
  NovelStoreInitializeRequest,
  NovelStoreOpenOptions,
  NovelStoreSnapshot,
  NovelStorageDiagnostics,
  NovelTaskAggregate,
  NovelTaskKind,
  NovelTaskNextValue,
  NovelTaskStatus,
} from './novel-store.ts'
export { migrateV1NovelProject, previewV1NovelMigration } from './novel-migration.ts'
export type {
  NovelMigrationReceipt,
  NovelV1MigrationPreview,
  NovelV1SourcePreview,
} from './novel-migration.ts'
export { NovelProjectError } from './types.ts'
export type {
  AssetRef,
  CommitReceipt,
  CreativeStrategy,
  NovelApplyRequest,
  NovelAssetReadResult,
  NovelInitializeRequest,
  NovelProject,
  NovelProjectErrorCode,
  NovelProjectId,
  NovelQueryMatch,
  NovelQueryResult,
  NovelReadRequest,
  NovelReadResult,
  NovelReplaceRequest,
  NovelWorkingSetResult,
  Revision,
} from './types.ts'
export { createPresetInstaller } from './preset-installer.ts'
export type { PresetInstaller, PresetInstallResult, PresetInstallStatus } from './preset-installer.ts'
export { createAiNovelCommandRpcHandler } from './command-rpc.ts'
export type {
  NovelCommandDiffChange,
  NovelCommandPreviewResult,
  NovelLoopbackCommand,
  NovelProposalListResult,
  NovelProposalStatus,
  NovelProposalSummary,
  NovelStateReadResult,
  NovelWorkspaceRegistry,
} from './command-rpc.ts'

/** Stable Host plugin name used by Cordis diagnostics. */
export const name = 'dsh-ai-novel-writer'

/** Required Host services. */
export const inject = ['connection', 'workspaceRegistry']

/** Host configuration for the explicit preset setup surface. */
export interface Config {
  /** Absolute user preset root receiving the package's immutable preset directory. */
  readonly presetRoot?: string
}

/** Host configuration schema. */
export const Config: z<Config> = z.object({
  presetRoot: z.string().default(dshHomePath('.agent-presets')),
})

function templateRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'ai-novel-writer')
}

function badRequest(message: string): Awaited<ReturnType<ConnectionRpcHandler>> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function internalFailure(message: string): Awaited<ReturnType<ConnectionRpcHandler>> {
  return {
    ok: false,
    error: { code: 'internal', message, details: {} },
  }
}

function reportInternalFailure(report: (error: unknown) => void, error: unknown): void {
  try {
    report(error)
  } catch (reportingError) {
    // Diagnostic reporting is best-effort and must not replace the stable RPC failure.
    void reportingError
  }
}

function isEmptyObject(value: unknown): value is Record<PropertyKey, never> {
  return typeof value === 'object'
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 0
}

function contextRequest(value: unknown): { readonly workspaceId: WorkspaceId; readonly chapter: number } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== ['chapter', 'workspaceId'].join('\0')) return undefined
  if (typeof record.workspaceId !== 'string' || record.workspaceId.trim() === '') return undefined
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.workspaceId)) return undefined
  if (!Number.isSafeInteger(record.chapter) || Number(record.chapter) <= 0) return undefined
  return { workspaceId: WorkspaceId(record.workspaceId), chapter: record.chapter as number }
}

function assetRequest(value: unknown): { readonly workspaceId: WorkspaceId; readonly target: AssetRef } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('\0') !== ['target', 'workspaceId'].join('\0')) return undefined
  if (typeof record.workspaceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.workspaceId)) return undefined
  try {
    return { workspaceId: WorkspaceId(record.workspaceId), target: parseNovelAssetRef(record.target) }
  } catch {
    return undefined
  }
}

/**
 * Create the loopback preset setup RPC handler.
 *
 * @param installer Preset installer owned by the Host plugin instance.
 * @param reportFailure Host-only diagnostic sink for underlying errors.
 * @returns A handler for the two closed setup endpoints.
 */
export function createPresetSetupRpcHandler(
  installer: ReturnType<typeof createPresetInstaller>,
  reportFailure: (error: unknown) => void = () => {},
): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    if (!isEmptyObject(payload)) return badRequest('Preset setup payload must be an empty object')
    try {
      switch (endpoint) {
        case 'preset/status': return { ok: true, value: await installer.status(signal) }
        case 'preset/install': return { ok: true, value: await installer.install(signal) }
        default: return badRequest(`Unknown AI novel endpoint: ${endpoint}`)
      }
    } catch (error) {
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'Preset setup request was cancelled', details: {} } }
      }
      reportInternalFailure(reportFailure, error)
      return internalFailure('Preset setup request failed')
    }
  }
}

/**
 * Create the complete loopback RPC handler for setup and read-only project context.
 *
 * @param installer Preset installer owned by the Host plugin instance.
 * @param workspaces Authoritative Workspace registry read face.
 * @param reportFailure Host-only diagnostic sink for underlying errors.
 * @returns A handler whose read endpoints accept only opaque Workspace identity and recognized selectors.
 */
export function createAiNovelRpcHandler(
  installer: ReturnType<typeof createPresetInstaller>,
  workspaces: NovelWorkspaceRegistry,
  reportFailure: (error: unknown) => void = () => {},
): ConnectionRpcHandler {
  const setup = createPresetSetupRpcHandler(installer, reportFailure)
  const command = createAiNovelCommandRpcHandler(workspaces, reportFailure)
  return async (endpoint, payload, signal) => {
    if (endpoint === 'preset/status' || endpoint === 'preset/install') {
      return setup(endpoint, payload, signal)
    }
    if (endpoint === 'state/read' || endpoint === 'proposal/list' || endpoint === 'command/preview'
      || endpoint === 'command/commit' || endpoint === 'task/read') {
      return command(endpoint, payload, signal)
    }
    if (endpoint !== 'context/read' && endpoint !== 'asset/read') {
      return badRequest(`Unknown AI novel endpoint: ${endpoint}`)
    }
    let workspaceId: WorkspaceId
    let read: (root: string) => Promise<unknown>
    if (endpoint === 'context/read') {
      const request = contextRequest(payload)
      if (request === undefined) {
        return badRequest('Novel context payload must contain only a Workspace UUID and a positive chapter')
      }
      workspaceId = request.workspaceId
      read = root => readNovelContext(root, request.chapter, signal)
    } else {
      const request = assetRequest(payload)
      if (request === undefined) {
        return badRequest('Novel asset payload must contain only a Workspace UUID and a recognized target')
      }
      workspaceId = request.workspaceId
      read = root => readNovelAsset(root, request.target, signal)
    }
    const workspace = workspaces.get(workspaceId)
    if (workspace === undefined) return badRequest(`Unknown Workspace: ${workspaceId}`)
    try {
      return { ok: true, value: await read(workspace.path) }
    } catch (error) {
      if (signal.aborted) {
        return { ok: false, error: {
          code: 'cancelled',
          message: endpoint === 'context/read' ? 'Novel context request was cancelled' : 'Novel asset request was cancelled',
          details: {},
        } }
      }
      reportInternalFailure(reportFailure, error)
      return internalFailure(endpoint === 'context/read' ? 'Novel context request failed' : 'Novel asset request failed')
    }
  }
}

/**
 * Register the loopback-only preset setup channel.
 *
 * @param ctx Host Cordis context with Connection available.
 * @param config Resolved user preset root.
 * @returns Nothing.
 */
export function apply(ctx: Context, config: Config): void {
  const presetRoot = config.presetRoot ?? dshHomePath('.agent-presets')
  const installer = createPresetInstaller(templateRoot(), presetRoot)
  const connection = ctx.get('connection') as HostConnectionHandle
  const workspaces = ctx.get('workspaceRegistry') as NovelWorkspaceRegistry
  ctx.effect(
    () => connection.rpc.handle('/ai-novel', createAiNovelRpcHandler(
      installer,
      workspaces,
      error => { ctx.logger.error('dsh-ai-novel-writer: request failed: %o', error) },
    ), { authority: 'loopback' }),
    'ai-novel-writer: setup and read-only context RPC',
  )
}
