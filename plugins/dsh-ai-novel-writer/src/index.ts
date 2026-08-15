/** Host entry and public domain exports for the AI novel bundle. */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { readNovelContext } from './context-window.ts'
import { createPresetInstaller } from './preset-installer.ts'

export { openNovelProject } from './novel-project.ts'
export type { NovelProjectOptions } from './novel-project.ts'
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

/** Minimal read face consumed from the Host Workspace registry. */
export interface NovelWorkspaceRegistry {
  /**
   * @param workspaceId Opaque Workspace identity received from the browser.
   * @returns The registered canonical directory, or undefined for an unknown id.
   */
  get(workspaceId: WorkspaceId): Pick<Workspace, 'path'> | undefined
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
 * @returns A handler whose context endpoint accepts only opaque Workspace identity and chapter number.
 */
export function createAiNovelRpcHandler(
  installer: ReturnType<typeof createPresetInstaller>,
  workspaces: NovelWorkspaceRegistry,
  reportFailure: (error: unknown) => void = () => {},
): ConnectionRpcHandler {
  const setup = createPresetSetupRpcHandler(installer, reportFailure)
  return async (endpoint, payload, signal) => {
    if (endpoint === 'preset/status' || endpoint === 'preset/install') {
      return setup(endpoint, payload, signal)
    }
    if (endpoint !== 'context/read') return badRequest(`Unknown AI novel endpoint: ${endpoint}`)
    const request = contextRequest(payload)
    if (request === undefined) {
      return badRequest('Novel context payload must contain only a Workspace UUID and a positive chapter')
    }
    const workspace = workspaces.get(request.workspaceId)
    if (workspace === undefined) return badRequest(`Unknown Workspace: ${request.workspaceId}`)
    try {
      return { ok: true, value: await readNovelContext(workspace.path, request.chapter, signal) }
    } catch (error) {
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'Novel context request was cancelled', details: {} } }
      }
      reportInternalFailure(reportFailure, error)
      return internalFailure('Novel context request failed')
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
