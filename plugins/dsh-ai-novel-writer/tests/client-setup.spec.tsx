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
  IconChevronLeftOutline14: () => <span aria-hidden="true" />,
  IconListPenOutline16: () => <span aria-hidden="true" />,
}))
const WORKSPACE_ID = WorkspaceId('123e4567-e89b-42d3-a456-426614174111')
const SESSION_ID = SessionId('session-1')
import {
  PresetSetupBody,
  apply,
  createNovelContextPort,
  createPresetSetupPort,
  createNovelWorkbenchPort,
  inject,
  installNovelContextStyle,
  novelContextCss,
} from '../src/client/index.ts'
import type { PresetSetupState } from '../src/client/setup-store.ts'

const v2State = {
  projectId: '123e4567-e89b-42d3-a456-426614174000', workspaceId: WORKSPACE_ID, globalRevision: 1, readOnly: false,
  storage: { applicationId: 1, userVersion: 2, foreignKeys: true, journalMode: 'wal', synchronous: 'full', lockingMode: 'normal' },
  project: {
    revision: 1, title: '潮汐来信', language: 'zh-CN', genre: '悬疑', plannedChapters: 12, targetWordsPerChapter: 3000,
    creativeStrategy: 'auto', structureMode: 'three-act', narrativePov: 'third-limited', globalGuidance: '',
    createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
  },
  architecture: { revision: 1, premise: '', characterGraph: '', world: '', plotOutline: '', styleConstraints: '', referenceWorks: [] },
  characters: { revision: 1, items: [], relationships: [] }, chapters: [], artifacts: [], chapterFinals: [], tasks: [], changes: [], proposals: [], migration: undefined,
}

let cachedSlotRegistry: (new (ctx: Context) => {
  register(options: unknown, component: unknown): () => void
  entries(key: string): ReadonlyArray<{
    component: unknown
    inject?: (...args: never[]) => Record<string, unknown>
    options: { id?: string }
  }>
}) | undefined

async function loadSlotRegistry(): Promise<new (ctx: Context) => {
  register(options: unknown, component: unknown): () => void
  entries(key: string): ReadonlyArray<{
    component: unknown
    inject?: (...args: never[]) => Record<string, unknown>
    options: { id?: string }
  }>
}> {
  if (cachedSlotRegistry !== undefined) return cachedSlotRegistry
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
  cachedSlotRegistry = runtime.SlotRegistry as new (ctx: Context) => {
    register(options: unknown, component: unknown): () => void
    entries(key: string): ReadonlyArray<{
      component: unknown
      inject?: (...args: never[]) => Record<string, unknown>
      options: { id?: string }
    }>
  }
  return cachedSlotRegistry
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

function provideNovelContextSources(ctx: Context, selected = false, agentPreset = 'ai-novel-writer') {
  const conversation = mutableSource({
    nodes: [] as Array<{ kind: 'tool-result'; seq: number; call: { name: string } | null }>,
  })
  const sessions = mutableSource({
    current: selected ? SESSION_ID : undefined as SessionId | undefined,
    byId: selected
      ? {
          [SESSION_ID]: {
            agentPreset,
            projectionValues: { permissions: { currentValue: 'workspace-write' } },
          },
        }
      : {},
  })
  const workspaces = mutableSource({
    items: selected ? [{ workspaceId: WORKSPACE_ID, sessionIds: [SESSION_ID] }] : [],
  })
  const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
  ctx.provide('sessions' as never, {
    list: sessions,
    binding: (id: SessionId) => id === SESSION_ID ? { session: { ...conversation, prompt } } : undefined,
  } as never)
  ctx.provide('workspaces' as never, { list: workspaces } as never)
  return { conversation, sessions, workspaces, prompt }
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
    await expect(port.read(WORKSPACE_ID, 1, signals[2]!)).rejects.toMatchObject({ name: 'NovelWorkbenchDisconnectedError' })
    expect(call.mock.calls.map(args => args.slice(0, 3))).toEqual([
      ['/ai-novel', 'context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }],
      ['/ai-novel', 'context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }],
      ['/ai-novel', 'context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }],
    ])
    expect(call.mock.calls.map(args => args[3])).toEqual(signals)
  })

  it('submits proposals only through the selected Session face and exposes no browser mutation operation', async () => {
    const rpc = { call: vi.fn() }
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const port = createNovelWorkbenchPort(rpc, {
      binding: id => id === SESSION_ID ? { session: { prompt } } as never : undefined,
    })

    await expect(port.prompt(SESSION_ID, 'exact proposal')).resolves.toEqual({ ok: true, value: { accepted: true } })
    await expect(port.prompt(SessionId('missing'), 'never sent')).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-unavailable' },
    })

    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: 'exact proposal' }], 'queue')
    expect(rpc.call).not.toHaveBeenCalled()
    expect(Object.keys(port).sort()).toEqual(['prompt', 'read', 'readAsset'])
  })

  it('reads one recognized asset through the path-free Host endpoint', async () => {
    const text = '{\n  "characters": []\n}\n'
    const signal = new AbortController().signal
    const call = vi.fn().mockResolvedValue({
      ok: true,
      value: { target: { kind: 'characters' }, revision: 'absent', text, bytes: new TextEncoder().encode(text).byteLength },
    })
    const port = createNovelContextPort({ call })

    await expect(port.readAsset(WORKSPACE_ID, { kind: 'characters' }, signal)).resolves.toMatchObject({
      target: { kind: 'characters' }, revision: 'absent', text,
    })
    expect(call).toHaveBeenCalledWith(
      '/ai-novel', 'asset/read', { workspaceId: WORKSPACE_ID, target: { kind: 'characters' } }, signal,
    )
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

  it('registers and removes the workbench trigger, overlay, and Plugin Configuration card', async () => {
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
    expect(entries.find(entry => entry.options.name === 'sidebar.footer.action')?.options.id).toBe('ai-novel-workbench')
    expect(entries.find(entry => entry.options.name === 'shell.overlay')?.options.id).toBe('ai-novel-workbench')
    expect(entries.find(entry => entry.options.name === 'settings.plugin.item')?.options.id).toBe('ai-novel-writer')
    await fiber.dispose()
    expect(entries).toHaveLength(0)
  })

  it('stops observers, aborts setup and context RPCs, and awaits both when its client fiber unloads', async () => {
    const ctx = new Context()
    interface InjectedControllers {
      setupController: { load(): Promise<void> }
      workbenchController: { open(): Promise<void> }
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
    const loading = Promise.all([controllers.setupController.load(), controllers.workbenchController.open()])
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

  it('restarts setup and context reads when Host description recovers without a reset event', async () => {
    const ctx = new Context()
    interface InjectedControllers {
      setupController: { load(): Promise<void> }
      workbenchController: { open(): Promise<void>; whenIdle(): Promise<void> }
    }
    const entries: Array<{ options: { inject?: () => InjectedControllers } }> = []
    class TestSlots extends Service {
      constructor(owner: Context) { super(owner, 'slots') }
      inject(_name: string, mount: () => () => void): void { this.ctx.effect(mount, 'test slot mount') }
      register(options: { inject?: () => InjectedControllers }): () => void {
        const entry = { options }
        entries.push(entry)
        return () => { entries.splice(entries.indexOf(entry), 1) }
      }
    }
    new TestSlots(ctx)
    provideNovelContextSources(ctx, true)
    const hostDescription = mutableSource<object | undefined>({})
    const call = vi.fn((_channel: string, endpoint: string) => Promise.resolve({
      ok: true,
      value: endpoint === 'context/read' ? { status: 'not-initialized' } : { status: 'installed' },
    }))
    ctx.provide('connection' as never, {
      rpc: { call },
      hostDescription,
    } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const controllers = entries[0]!.options.inject!()
    await Promise.all([controllers.setupController.load(), controllers.workbenchController.open()])
    const beforeDisconnect = call.mock.calls.length

    await act(async () => { hostDescription.set(undefined) })
    hostDescription.set({})
    await vi.waitFor(() => { expect(call.mock.calls.length).toBeGreaterThan(beforeDisconnect) })
    await controllers.workbenchController.whenIdle()

    expect(call.mock.calls.filter(args => args[1] === 'preset/status')).toHaveLength(2)
    expect(call.mock.calls.filter(args => args[1] === 'context/read').length).toBeGreaterThanOrEqual(3)
    await fiber.dispose()
  })

  it('disconnects and reconnects the active V2 workbench through the Host connection observer', async () => {
    const ctx = new Context()
    interface InjectedControllers {
      v2WorkbenchController: {
        open(): Promise<void>
        whenIdle(): Promise<void>
        getSnapshot(): { status: string; open: boolean; message?: string }
      }
    }
    const entries: Array<{ options: { inject?: () => InjectedControllers } }> = []
    class TestSlots extends Service {
      constructor(owner: Context) { super(owner, 'slots') }
      inject(_name: string, mount: () => () => void): void { this.ctx.effect(mount, 'test slot mount') }
      register(options: { inject?: () => InjectedControllers }): () => void {
        const entry = { options }
        entries.push(entry)
        return () => { entries.splice(entries.indexOf(entry), 1) }
      }
    }
    new TestSlots(ctx)
    provideNovelContextSources(ctx, true, 'ai-novel-writer-v2')
    const hostDescription = mutableSource<object | undefined>({})
    const call = vi.fn((_channel: string, endpoint: string) => Promise.resolve({
      ok: true,
      value: endpoint === 'state/read' ? v2State : endpoint === 'proposal/list' ? { proposals: [] } : { status: 'installed' },
    }))
    ctx.provide('connection' as never, { rpc: { call }, hostDescription } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const controller = entries[0]!.options.inject!().v2WorkbenchController
    await controller.open()
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', open: true })
    const stateReadsBeforeDisconnect = call.mock.calls.filter(args => args[1] === 'state/read').length

    hostDescription.set(undefined)
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', open: true, message: expect.stringContaining('Harness 连接已断开') })
    hostDescription.set({})
    await vi.waitFor(() => {
      expect(call.mock.calls.filter(args => args[1] === 'state/read').length).toBeGreaterThan(stateReadsBeforeDisconnect)
    })
    await controller.whenIdle()
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', open: true })
    await fiber.dispose()
  })

  it('renders V2 project evidence in the Plugin Configuration card across disconnect and reconnect', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const ctx = new Context()
    interface InjectedControllers {
      workbenchController: unknown
      v2WorkbenchController: unknown
      workbenchRoute: unknown
      setupController: unknown
    }
    const entries: Array<{ options: { id?: string; inject?: () => InjectedControllers }; component: unknown }> = []
    class TestSlots extends Service {
      constructor(owner: Context) { super(owner, 'slots') }
      inject(_name: string, mount: () => () => void): void { this.ctx.effect(mount, 'test slot mount') }
      register(options: { id?: string; inject?: () => InjectedControllers }, component: unknown): () => void {
        const entry = { options, component }
        entries.push(entry)
        return () => { entries.splice(entries.indexOf(entry), 1) }
      }
    }
    new TestSlots(ctx)
    provideNovelContextSources(ctx, true, 'ai-novel-writer-v2')
    const hostDescription = mutableSource<object | undefined>({})
    const call = vi.fn((_channel: string, endpoint: string) => Promise.resolve({
      ok: true,
      value: endpoint === 'state/read' ? v2State : endpoint === 'proposal/list' ? { proposals: [] } : { status: 'installed' },
    }))
    ctx.provide('connection' as never, { rpc: { call }, hostDescription } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = entries.find(candidate => candidate.options.id === 'ai-novel-writer')!
    const Card = entry.component as ComponentType<Record<string, unknown>>
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<Card {...entry.options.inject!()} />) })
    await vi.waitFor(() => {
      expect(container.textContent).toContain('V2 单列工作台')
      expect(container.textContent).toContain('项目已加载（V2）')
    })

    await act(async () => { hostDescription.set(undefined) })
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Host 已断开')
      expect(container.textContent).toContain('项目状态不可用')
    })
    await act(async () => { hostDescription.set({}) })
    const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === '刷新状态')!
    await act(async () => { refresh.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await vi.waitFor(() => { expect(container.textContent).toContain('项目已加载（V2）') })
    await act(async () => { root.unmount() })
    container.remove()
    await fiber.dispose()
  })

  it('keeps the V1 preset workbench, focus scope, Escape, and cleanup through real slot registrations', async () => {
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
      workbenchController: { whenIdle(): Promise<void> }
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
      root.render(<>
        <Trigger wide {...injected} {...standard} />
        <div data-test-shell-frame><div data-shell-overlay><Overlay {...injected} {...standard} /></div></div>
      </>)
    })
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
    trigger.focus()
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(container.querySelector('[role="dialog"]')).toBeNull()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const close = document.body.querySelector<HTMLButtonElement>('[aria-label^="关闭"]')!
    expect(document.activeElement).toBe(close)
    expect(dialog.getAttribute('aria-modal')).toBe('false')
    expect(container.querySelector('[data-test-shell-frame]')?.classList.contains('aiNovelWorkbenchFrameOpen')).toBe(true)
    expect(dialog.textContent).toContain('初始化小说项目')
    expect(call).toHaveBeenCalledWith(
      '/ai-novel', 'context/read', { workspaceId: WORKSPACE_ID, chapter: 1 }, expect.any(AbortSignal),
    )
    expect(call.mock.calls.map(args => args[1])).not.toContain('state/read')
    expect(call.mock.calls.map(args => args[1])).not.toContain('proposal/list')
    expect(contextSources.prompt).not.toHaveBeenCalled()
    expect(call.mock.calls.map(args => args[1])).not.toContain('command/commit')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(container.querySelector('[data-test-shell-frame]')?.classList.contains('aiNovelWorkbenchFrameOpen')).toBe(false)

    await act(async () => {
      root.unmount()
      await fiber.dispose()
    })
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(document.querySelector('style[data-plugin-css="@ethanyoq/dsh-ai-novel-writer/context-window"]')).toBeNull()
    container.remove()
  })

  it('renders mounted evidence and opens the workbench through the real Plugin Configuration slot', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const ctx = new Context()
    const SlotRegistry = await loadSlotRegistry()
    const slots = new SlotRegistry(ctx)
    slots.register({
      name: 'root',
      children: {
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'settings.plugin.item': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    provideNovelContextSources(ctx, true)
    const call = vi.fn((_channel: string, endpoint: string) => Promise.resolve({
      ok: true,
      value: endpoint === 'context/read' ? { status: 'not-initialized' } : { status: 'installed' },
    }))
    ctx.provide('connection' as never, {
      rpc: { call },
      hostDescription: { getSnapshot: () => ({}), subscribe: () => () => {} },
    } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = slots.entries('settings.plugin.item')[0]!
    const overlayEntry = slots.entries('shell.overlay')[0]!
    const Card = entry.component as ComponentType<Record<string, unknown>>
    const Overlay = overlayEntry.component as ComponentType<Record<string, unknown>>
    const injected = entry.inject!() as Record<string, unknown>
    const sessionState = {
      ids: [SESSION_ID],
      byId: { 'session-1': { id: 'session-1', displayTitle: '第一章', blank: false, running: false, updatedAt: 1 } },
      current: SESSION_ID, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }
    const workspaceState = {
      items: [{
        workspaceId: WORKSPACE_ID, path: 'not-exposed-to-rpc', title: '小说',
        createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z', sessionIds: [SESSION_ID],
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
    await act(async () => { root.render(<>
      <Card {...injected} />
      <div data-test-shell-frame><div data-shell-overlay><Overlay {...injected} {...standard} /></div></div>
    </>) })
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Host 已连接')
      expect(container.textContent).toContain('Preset 已安装')
      expect(container.textContent).toContain('Workspace 已选择')
      expect(container.textContent).toContain('项目未初始化')
    })

    const open = [...container.querySelectorAll('button')]
      .find(button => button.textContent === '打开小说工作台')!
    open.focus()
    await act(async () => { open.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.querySelector('[data-test-shell-frame]')?.classList.contains('aiNovelWorkbenchFrameOpen')).toBe(true)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(open)
    expect(slots.entries('settings.plugin.item').map(item => item.options.id)).toEqual(['ai-novel-writer'])
    expect(call.mock.calls.some(args => args[1] === 'context/read')).toBe(true)

    await act(async () => {
      root.unmount()
      await fiber.dispose()
    })
    expect(slots.entries('settings.plugin.item')).toHaveLength(0)
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
