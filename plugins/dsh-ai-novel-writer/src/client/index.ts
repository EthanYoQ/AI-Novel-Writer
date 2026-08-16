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
import { installNovelContextStyle } from './setup-style.ts'
import {
  NovelWorkbenchController,
  NovelWorkbenchDisconnectedError,
  type NovelWorkbenchPort,
} from './workbench-store.ts'

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
  ctx.effect(() => {
    const stopObserving = observeNovelContextSources({
      sessions,
      workspaces,
    } satisfies NovelContextSelectionSources, workbenchController)
    return async () => {
      stopObserving()
      await Promise.all([controller.dispose(), workbenchController.dispose()])
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
      })
    }
    const stopDescription = connection.hostDescription.subscribe(() => {
      if (connection.hostDescription.getSnapshot() === undefined) {
        controller.disconnected()
        workbenchController.disconnected()
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

  const workbenchInjected = (): NovelWorkbenchInjected => ({ workbenchController, setupController: controller })
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
