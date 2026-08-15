/** Host entry and public domain exports for the AI novel bundle. */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
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
export const inject = ['connection']

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

function internalFailure(error: unknown): Awaited<ReturnType<ConnectionRpcHandler>> {
  return {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
  }
}

function isEmptyObject(value: unknown): value is Record<PropertyKey, never> {
  return typeof value === 'object'
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 0
}

/**
 * Create the loopback preset setup RPC handler.
 *
 * @param installer Preset installer owned by the Host plugin instance.
 * @returns A handler for the two closed setup endpoints.
 */
export function createPresetSetupRpcHandler(
  installer: ReturnType<typeof createPresetInstaller>,
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
      return internalFailure(error)
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
  ctx.effect(
    () => connection.rpc.handle('/ai-novel', createPresetSetupRpcHandler(installer), { authority: 'loopback' }),
    'ai-novel-writer: preset setup RPC',
  )
}
