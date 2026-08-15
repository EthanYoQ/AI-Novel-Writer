/** Browser entry for the bundle. */

import type { ClientConnectionRpc, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  PresetSetupController,
  PresetSetupDisconnectedError,
  type PresetSetupPort,
} from './setup-store.ts'
import { PresetSetupOverlay, PresetSetupTrigger } from './setup-view.tsx'
import { installPresetSetupStyle } from './setup-style.ts'

export { PresetSetupBody, PresetSetupOverlay, PresetSetupTrigger } from './setup-view.tsx'
export type { PresetSetupBodyProps } from './setup-view.tsx'
export {
  PresetSetupController,
  PresetSetupDisconnectedError,
} from './setup-store.ts'
export type { PresetSetupPort, PresetSetupState } from './setup-store.ts'
export { installPresetSetupStyle, presetSetupCss } from './setup-style.ts'

/** Required browser services. */
export const inject = ['slots', 'connection']

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
  ctx.effect(() => async () => { await controller.dispose() }, 'ai-novel-writer: preset setup lifecycle')
  if (typeof document !== 'undefined') {
    ctx.effect(() => installPresetSetupStyle(document), 'ai-novel-writer: setup styles')
  }

  ctx.effect(() => connection.hostDescription.subscribe(() => {
    if (connection.hostDescription.getSnapshot() === undefined) controller.disconnected()
  }), 'ai-novel-writer: observe Host connection')
  ctx.effect(() => ctx.on('connection/reset', () => {
    if (controller.getSnapshot().status !== 'idle') void controller.load()
  }), 'ai-novel-writer: refresh preset setup after reconnect')

  const setupInjected = (): { readonly controller: PresetSetupController } => ({ controller })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'ai-novel-preset',
    order: 90,
    label: 'AI 小说作家 Preset',
    inject: setupInjected,
  }, PresetSetupTrigger))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'ai-novel-preset',
    order: 90,
    inject: setupInjected,
  }, PresetSetupOverlay))
}
