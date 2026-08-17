import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'
import { makeTestWorkspace } from './test-workspace.ts'

describe('preset setup Host RPC', () => {
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
})
