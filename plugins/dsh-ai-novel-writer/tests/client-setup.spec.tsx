// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { act, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconListPenOutline16: () => <span aria-hidden="true" />,
}))
import {
  PresetSetupBody,
  apply,
  createPresetSetupPort,
  inject,
  installPresetSetupStyle,
  presetSetupCss,
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

describe('preset setup browser integration', () => {
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
    const connection = {
      rpc: { call: vi.fn().mockResolvedValue({ ok: true, value: { status: 'not-installed' } }) },
      hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    } as unknown as ConnectionHandle
    ctx.provide('connection' as never, connection as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(inject).toEqual(['slots', 'connection'])
    expect(entries.find(entry => entry.options.name === 'sidebar.footer.action')?.options.id).toBe('ai-novel-preset')
    expect(entries.find(entry => entry.options.name === 'shell.overlay')?.options.id).toBe('ai-novel-preset')
    await fiber.dispose()
    expect(entries).toHaveLength(0)
  })

  it('aborts and awaits a pending setup RPC when its client fiber unloads', async () => {
    const ctx = new Context()
    const entries: Array<{ options: { name: string; inject?: () => { controller: { load(): Promise<void> } } } }> = []
    class TestSlots extends Service {
      constructor(owner: Context) { super(owner, 'slots') }
      inject(_name: string, mount: () => () => void): void { this.ctx.effect(mount, 'test slot mount') }
      register(options: { name: string; inject?: () => { controller: { load(): Promise<void> } } }): () => void {
        const entry = { options }
        entries.push(entry)
        return () => { entries.splice(entries.indexOf(entry), 1) }
      }
    }
    new TestSlots(ctx)
    let signal: AbortSignal | undefined
    let finish: (() => void) | undefined
    const connection = {
      rpc: {
        call: vi.fn((_channel, _endpoint, _payload, requestSignal: AbortSignal) => {
          signal = requestSignal
          return new Promise(resolve => { finish = () => { resolve({ ok: true, value: { status: 'not-installed' } }) } })
        }),
      },
      hostDescription: { getSnapshot: () => ({}), subscribe: () => () => {} },
    } as unknown as ConnectionHandle
    ctx.provide('connection' as never, connection as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const controller = entries[0]!.options.inject!().controller
    const loading = controller.load()
    await vi.waitFor(() => { expect(signal).toBeDefined() })

    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finish?.()
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
    const connection = {
      rpc: { call: vi.fn().mockResolvedValue({ ok: true, value: { status: 'not-installed' } }) },
      hostDescription: { getSnapshot: () => ({}), subscribe: () => () => {} },
    } as unknown as ConnectionHandle
    ctx.provide('connection' as never, connection as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const triggerEntry = slots.entries('sidebar.footer.action')[0]!
    const overlayEntry = slots.entries('shell.overlay')[0]!
    const Trigger = triggerEntry.component as ComponentType<Record<string, unknown>>
    const Overlay = overlayEntry.component as ComponentType<Record<string, unknown>>
    const injected = triggerEntry.inject!()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<><Trigger wide {...injected} /><Overlay {...injected} /></>)
    })
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
    trigger.focus()
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const close = container.querySelector<HTMLButtonElement>('[aria-label^="关闭"]')!
    const install = [...dialog.querySelectorAll('button')].find(button => button.textContent?.startsWith('安装'))!
    expect(document.activeElement).toBe(close)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(install)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(close)
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
    expect(document.querySelector('style[data-plugin-css="@ethanyoq/dsh-ai-novel-writer/preset-setup"]')).toBeNull()
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

    const dispose = installPresetSetupStyle(target)

    expect(style.dataset).toEqual({
      plugin: '@ethanyoq/dsh-ai-novel-writer',
      pluginCss: '@ethanyoq/dsh-ai-novel-writer/preset-setup',
    })
    expect(style.textContent).toBe(presetSetupCss)
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
