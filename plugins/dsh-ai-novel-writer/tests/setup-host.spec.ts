import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import { apply, createAiNovelHostRpcLifecycle, inject } from '../src/index.ts'
import { makeTestWorkspace } from './test-workspace.ts'

describe('preset setup Host RPC', () => {
  it('rejects new commands during HMR disposal and waits for an in-flight command to settle', async () => {
    let release: (() => void) | undefined
    const started = Promise.withResolvers<void>()
    const pending = new Promise<void>(resolve => { release = resolve })
    const lifecycle = createAiNovelHostRpcLifecycle(async () => {
      started.resolve()
      await pending
      return { ok: true, value: { status: 'settled' } }
    })
    const signal = new AbortController().signal

    const inFlight = lifecycle.handler('preset/status', {}, signal)
    await started.promise
    const disposing = lifecycle.dispose()
    await expect(lifecycle.handler('preset/status', {}, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    let settled = false
    void disposing.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    release?.()
    await expect(inFlight).resolves.toEqual({ ok: true, value: { status: 'settled' } })
    await expect(disposing).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  it('registers one loopback channel, dispatches status and install, and disposes it', async () => {
    const presetRoot = await makeTestWorkspace('preset-host-')
    let handler: ConnectionRpcHandler | undefined
    const dispose = vi.fn(async () => {})
    const handle = vi.fn((channel: string, candidate: ConnectionRpcHandler, options: { authority: string }) => {
      expect(channel).toBe('/ai-novel')
      expect(options).toEqual({ authority: 'loopback' })
      handler = candidate
      return dispose
    })
    const ctx = new Context()
    ctx.provide('connection', { rpc: { handle } } as unknown as HostConnectionHandle)
    ctx.provide('workspaceRegistry' as never, { get: () => undefined } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { presetRoot })
    await fiber.await()

    expect(handler).toBeDefined()
    const signal = new AbortController().signal
    await expect(handler?.('preset/status', {}, signal)).resolves.toEqual({
      ok: true,
      value: { status: 'not-installed' },
    })
    await expect(handler?.('preset/install', {}, signal)).resolves.toEqual({
      ok: true,
      value: { status: 'installed', changed: true },
    })
    await expect(handler?.('unknown', {}, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })

    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('creates a fresh accepting lifecycle when Cordis re-registers the same effect after disposal', async () => {
    const presetRoot = await makeTestWorkspace('preset-host-reregister-')
    const handlers: ConnectionRpcHandler[] = []
    const registrations: Array<() => () => Promise<void>> = []
    const unregister = vi.fn(async () => {})
    const handle = vi.fn((_channel: string, handler: ConnectionRpcHandler) => {
      handlers.push(handler)
      return unregister
    })
    const ctx = {
      get(service: string): unknown {
        if (service === 'connection') return { rpc: { handle } }
        if (service === 'workspaceRegistry') return { get: () => undefined }
        throw new Error(`unexpected Host service: ${service}`)
      },
      effect(registration: () => () => Promise<void>): void {
        registrations.push(registration)
      },
      logger: { error: vi.fn() },
    } as unknown as Context

    apply(ctx, { presetRoot })
    const firstDispose = registrations[0]!()
    await firstDispose()
    const secondDispose = registrations[0]!()

    expect(handle).toHaveBeenCalledTimes(2)
    await expect(handlers[0]!('preset/status', {}, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    await expect(handlers[1]!('preset/status', {}, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: { status: 'not-installed' },
    })
    await secondDispose()
  })
})
