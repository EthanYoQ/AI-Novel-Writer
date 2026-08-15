// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { act, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconListPenOutline16: () => <span aria-hidden="true" />,
}))
const WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174111')
const SESSION_ID = SessionId('session-1')
import {
  PresetSetupBody,
  apply,
  createNovelContextPort,
  createPresetSetupPort,
  inject,
  installNovelContextStyle,
  novelContextCss,
} from '../src/client/index.ts'
import type { PresetSetupState } from '../src/client/setup-store.ts'

async function loadSlotRegistry(): Promise<new (ctx: Context) => {
  register(options: unknown, component: unknown): () => void
  entries(key: string): ReadonlyArray<{
    component: unknown
    inject?: (...args: never[]) => Record<string, unknown>
  }>
}> {
  let handoff: { factory(require: (specifier: string) => unknown): Record<string, unknown> } | undefined
  ;(window as unknown as { __ModuleLoader__: { load(value: typeof handoff): void } }).__ModuleLoader__ = {
    load: value => { handoff = value },
  }
  await import('@deepseek-ai/dsh-client-runtime/client')
  if (handoff === undefined) throw new Error('Client runtime bundle did not register')
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/cordis', await import('@deepseek-ai/cordis')],
    ['@deepseek-ai/dsh-client-ui-slots', await import('@deepseek-ai/dsh-client-ui-slots')],
  ])
  const runtime = handoff.factory(specifier => {
    if (!modules.has(specifier)) throw new Error(`Unexpected client runtime external: ${specifier}`)
    return modules.get(specifier)
  })
  return runtime.SlotRegistry as new (ctx: Context) => {
    register(options: unknown, component: unknown): () => void
    entries(key: string): ReadonlyArray<{
      component: unknown
      inject?: (...args: never[]) => Record<string, unknown>
    }>
  }
}

function mutableSource<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    set: (next: T) => { value = next; for (const listener of listeners) listener() },
  }
}

function provideNovelContextSources(ctx: Context, selected = false) {
  const conversation = mutableSource({
    nodes: [] as Array<{ kind: 'tool-result'; seq: number; call: { name: string } | null }>,
  })
  const sessions = mutableSource({ current: selected ? SESSION_ID : undefined as SessionId | undefined })
  const workspaces = mutableSource({
    items: selected ? [{ workspaceId: WORKSPACE_ID, sessionIds: [SESSION_ID] }] : [],
  })
  ctx.provide('sessions' as never, {
    list: sessions,
    binding: (id: SessionId) => id === SESSION_ID ? { session: conversation } : undefined,
  } as never)
  ctx.provide('workspaces' as never, { list: workspaces } as never)
  return { conversation, sessions, workspaces }
}

describe('preset setup browser integration', () => {
  it('maps the opaque context read endpoint and rejects invalid wire values', async () => {
    const ready = {
      status: 'ready',
      project: {
        projectId: '123e4567-e89b-42d3-a456-426614174000', title: '潮汐来信', language: 'zh-CN', genre: '悬疑',
        plannedChapters: 2, targetWordsPerChapter: 2_000, creativeStrategy: 'auto', updatedAt: '2026-08-16T00:00:00.000Z',
      },
      progress: { selectedChapter: 1, plannedChapters: 2, status: 'planned', draftPresent: false, draftBytes: 0 },
      characters: [], storyBlueprint: null, chapterBlueprint: null, draft: null, omittedSources: [],
    }
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: ready })
      .mockResolvedValueOnce({ ok: true, value: { ...ready, project: { ...ready.project, path: 'C:\\secret' } } })
      .mockRejectedValueOnce(new Error('network down'))
    const port = createNovelContextPort({ call })
    const signals = Array.from({ length: 3 }, () => new AbortController().signal)

    await expect(port.read(WORKSPACE_ID, 1, signals[0]!)).resolves.toEqual(ready)
    await expect(port.read(WORKSPACE_ID, 1, signals[1]!)).rejects.toThrow('context response is invalid')
    await expect(port.read(WORKSPACE_ID, 1, signals[2]!)).rejects.toMatchObject({ name: 'NovelContextDisconnectedError' })
    expect(call.mock.calls.map(args => args.slice(0, 3))).toEqual([
      ['/ai-novel', 'context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }],
      ['/ai-novel', 'context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }],
      ['/ai-novel', 'context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }],
    ])
    expect(call.mock.calls.map(args => args[3])).toEqual(signals)
  })

  it('maps the two closed RPC endpoints and distinguishes transport loss', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { status: 'not-installed' } })
      .mockResolvedValueOnce({ ok: true, value: { status: 'installed', changed: true } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'host failed', details: {} } })
      .mockRejectedValueOnce(new Error('network down'))
    const port = createPresetSetupPort({ call })

    const signals = Array.from({ length: 4 }, () => new AbortController().signal)
    await expect(port.status(signals[0]!)).resolves.toEqual({ status: 'not-installed' })
    await expect(port.install(signals[1]!)).resolves.toEqual({ status: 'installed', changed: true })
    await expect(port.status(signals[2]!)).rejects.toThrow('internal: host failed')
    await expect(port.status(signals[3]!)).rejects.toMatchObject({ name: 'PresetSetupDisconnectedError' })
    expect(call.mock.calls.map(callArgs => callArgs.slice(0, 3))).toEqual([
      ['/ai-novel', 'preset/status', {}],
      ['/ai-novel', 'preset/install', {}],
      ['/ai-novel', 'preset/status', {}],
      ['/ai-novel', 'preset/status', {}],
    ])
    expect(call.mock.calls.map(callArgs => callArgs[3])).toEqual(signals)
  })

  it('registers and removes the sidebar trigger and shell overlay', async () => {
    const ctx = new Context()
    const entries: Array<{ options: { name: string; id?: string } }> = []
    class TestSlots extends Service {
      constructor(owner: Context) { super(owner, 'slots') }
      inject(_name: string, mount: () => () => void): void { this.ctx.effect(mount, 'test slot mount') }
      register(options: { name: string; id?: string }): () => void {
        const entry = { options }
        entries.push(entry)
        return () => { entries.splice(entries.indexOf(entry), 1) }
      }
    }
    new TestSlots(ctx)
    provideNovelContextSources(ctx)
    const connection = {
      rpc: { call: vi.fn().mockResolvedValue({ ok: true, value: { status: 'not-installed' } }) },
      hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    } as unknown as ConnectionHandle
    ctx.provide('connection' as never, connection as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(inject).toEqual(['slots', 'connection', 'sessions', 'workspaces'])
    expect(entries.find(entry => entry.options.name === 'sidebar.footer.action')?.options.id).toBe('ai-novel-context')
    expect(entries.find(entry => entry.options.name === 'shell.overlay')?.options.id).toBe('ai-novel-context')
    await fiber.dispose()
    expect(entries).toHaveLength(0)
  })

  it('stops observers, aborts setup and context RPCs, and awaits both when its client fiber unloads', async () => {
    const ctx = new Context()
    interface InjectedControllers {
      setupController: { load(): Promise<void> }
      contextController: { open(): Promise<void> }
    }
    const entries: Array<{ options: { name: string; inject?: () => InjectedControllers } }> = []
    class TestSlots extends Service {
      constructor(owner: Context) { super(owner, 'slots') }
      inject(_name: string, mount: () => () => void): void { this.ctx.effect(mount, 'test slot mount') }
      register(options: { name: string; inject?: () => InjectedControllers }): () => void {
        const entry = { options }
        entries.push(entry)
        return () => { entries.splice(entries.indexOf(entry), 1) }
      }
    }
    new TestSlots(ctx)
    provideNovelContextSources(ctx, true)
    const signals = new Map<string, AbortSignal>()
    const finishes = new Map<string, () => void>()
    const connection = {
      rpc: {
        call: vi.fn((_channel, endpoint: string, _payload, requestSignal: AbortSignal) => {
          signals.set(endpoint, requestSignal)
          return new Promise(resolve => {
            finishes.set(endpoint, () => {
              resolve({
                ok: true,
                value: endpoint === 'context/read' ? { status: 'not-initialized' } : { status: 'not-installed' },
              })
            })
          })
        }),
      },
      hostDescription: { getSnapshot: () => ({}), subscribe: () => () => {} },
    } as unknown as ConnectionHandle
    ctx.provide('connection' as never, connection as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const controllers = entries[0]!.options.inject!()
    const loading = Promise.all([controllers.setupController.load(), controllers.contextController.open()])
    await vi.waitFor(() => { expect(signals.size).toBe(2) })

    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect([...signals.values()].every(signal => signal.aborted)).toBe(true) })
    await Promise.resolve()
    expect(disposed).toBe(false)
    for (const finish of finishes.values()) finish()
    await Promise.all([loading, disposing])
    expect(disposed).toBe(true)
  })

  it('runs trigger, focus scope, Escape, and cleanup through real slot registrations', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const ctx = new Context()
    const SlotRegistry = await loadSlotRegistry()
    const slots = new SlotRegistry(ctx)
    slots.register({
      name: 'root',
      children: {
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    const contextSources = provideNovelContextSources(ctx, true)
    const call = vi.fn((_channel: string, endpoint: string) => Promise.resolve({
      ok: true,
      value: endpoint === 'context/read' ? { status: 'not-initialized' } : { status: 'not-installed' },
    }))
    const connection = {
      rpc: { call },
      hostDescription: { getSnapshot: () => ({}), subscribe: () => () => {} },
    } as unknown as ConnectionHandle
    ctx.provide('connection' as never, connection as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const triggerEntry = slots.entries('sidebar.footer.action')[0]!
    const overlayEntry = slots.entries('shell.overlay')[0]!
    const Trigger = triggerEntry.component as ComponentType<Record<string, unknown>>
    const Overlay = overlayEntry.component as ComponentType<Record<string, unknown>>
    const injected = triggerEntry.inject!() as {
      contextController: { whenIdle(): Promise<void> }
      setupController: unknown
    }
    const sessionState = {
      ids: [SESSION_ID],
      byId: {
        'session-1': {
          id: 'session-1', displayTitle: '第一章', blank: false, running: false, updatedAt: 1,
        },
      },
      current: SESSION_ID, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }
    const workspaceState = {
      items: [{
        workspaceId: WORKSPACE_ID, path: 'not-exposed-to-rpc', title: '小说',
        createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
        sessionIds: [SESSION_ID],
      }],
      archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: WORKSPACE_ID,
    }
    const standard = {
      useSessions: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
      useWorkspaces: (selector: (state: typeof workspaceState) => unknown) => selector(workspaceState),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<><Trigger wide {...injected} {...standard} /><Overlay {...injected} {...standard} /></>)
    })
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
    trigger.focus()
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const close = container.querySelector<HTMLButtonElement>('[aria-label^="关闭"]')!
    expect(document.activeElement).toBe(close)
    expect(dialog.getAttribute('aria-modal')).toBe('false')
    expect(call).toHaveBeenCalledWith(
      '/ai-novel', 'context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }, expect.any(AbortSignal),
    )
    await act(async () => {
      contextSources.conversation.set({
        nodes: [{ kind: 'tool-result', seq: 1, call: { name: 'novel_apply_change' } }],
      })
      await injected.contextController.whenIdle()
    })
    expect(call.mock.calls.filter(args => args[1] === 'context/read')).toHaveLength(2)
    await act(async () => {
      ctx.emit('connection/reset')
      await injected.contextController.whenIdle()
    })
    expect(call.mock.calls.filter(args => args[1] === 'context/read')).toHaveLength(3)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    await act(async () => {
      root.unmount()
      await fiber.dispose()
    })
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(document.querySelector('style[data-plugin-css="@ethanyoq/dsh-ai-novel-writer/context-window"]')).toBeNull()
    container.remove()
  })

  it('installs and removes only its owned token styles', () => {
    const remove = vi.fn()
    const style = { dataset: {} as Record<string, string>, textContent: '', remove }
    const appendChild = vi.fn()
    const target = {
      createElement: vi.fn(() => style),
      head: { appendChild },
    } as unknown as Document

    const dispose = installNovelContextStyle(target)

    expect(style.dataset).toEqual({
      plugin: '@ethanyoq/dsh-ai-novel-writer',
      pluginCss: '@ethanyoq/dsh-ai-novel-writer/context-window',
    })
    expect(style.textContent).toBe(novelContextCss)
    expect(appendChild).toHaveBeenCalledWith(style)
    dispose()
    expect(remove).toHaveBeenCalledOnce()
  })

  it.each([
    [{ status: 'loading', open: true }, '正在检查安装状态'],
    [{ status: 'not-installed', open: true }, '安装 AI 小说作家 Preset'],
    [{ status: 'installed', open: true, changed: true }, 'Preset 已安装'],
    [{ status: 'conflict', open: true }, '检测到同名 Preset 冲突'],
    [{ status: 'error', open: true, message: 'host failed' }, 'host failed'],
    [{ status: 'disconnected', open: true }, 'Harness 连接已断开'],
  ] satisfies readonly [PresetSetupState, string][])('renders accessible state %#', (state, text) => {
    const html = renderToStaticMarkup(<PresetSetupBody state={state} install={() => {}} retry={() => {}} />)
    expect(html).toContain(text)
    expect(html).not.toContain('path=')
  })
})
