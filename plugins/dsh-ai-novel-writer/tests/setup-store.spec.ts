import { describe, expect, it, vi } from 'vitest'
import { PresetSetupController, PresetSetupDisconnectedError } from '../src/client/setup-store.ts'

describe('preset setup client state', () => {
  it('represents loading, not-installed, installed, conflict, error, and disconnected', async () => {
    const status = vi.fn()
      .mockResolvedValueOnce({ status: 'not-installed' })
      .mockResolvedValueOnce({ status: 'conflict' })
      .mockRejectedValueOnce(new Error('host failed'))
      .mockRejectedValueOnce(new PresetSetupDisconnectedError())
    const install = vi.fn().mockResolvedValue({ status: 'installed', changed: true })
    const controller = new PresetSetupController({ status, install }, vi.fn())

    expect(controller.getSnapshot()).toEqual({ status: 'idle', open: false })
    const first = controller.load()
    expect(controller.getSnapshot()).toEqual({ status: 'loading', open: false })
    await first
    expect(controller.getSnapshot()).toEqual({ status: 'not-installed', open: false })
    controller.open()
    expect(controller.getSnapshot().open).toBe(true)
    await controller.install()
    expect(controller.getSnapshot()).toEqual({ status: 'installed', open: true, changed: true })
    await controller.load()
    expect(controller.getSnapshot()).toEqual({ status: 'conflict', open: true })
    await controller.load()
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', open: true, message: 'host failed' })
    await controller.load()
    expect(controller.getSnapshot()).toEqual({ status: 'disconnected', open: true })
    controller.close()
    expect(controller.getSnapshot().open).toBe(false)
  })

  it('does not let a stale response overwrite a newer disconnected state', async () => {
    let resolveStatus: ((value: { status: 'installed' }) => void) | undefined
    let statusSignal: AbortSignal | undefined
    const pending = new Promise<{ status: 'installed' }>((resolve) => { resolveStatus = resolve })
    const controller = new PresetSetupController({
      status: signal => {
        statusSignal = signal
        return pending
      },
      install: async () => ({ status: 'installed', changed: true }),
    }, vi.fn())

    const loading = controller.load()
    await vi.waitFor(() => { expect(statusSignal).toBeDefined() })
    controller.disconnected()
    expect(statusSignal?.aborted).toBe(true)
    resolveStatus?.({ status: 'installed' })
    await loading

    expect(controller.getSnapshot()).toEqual({ status: 'disconnected', open: false })
  })

  it('aborts superseded work and waits for it before starting the replacement', async () => {
    let finishInstall: (() => void) | undefined
    let installSignal: AbortSignal | undefined
    const calls: string[] = []
    const controller = new PresetSetupController({
      status: async signal => {
        calls.push('status')
        expect(signal.aborted).toBe(false)
        return { status: 'installed' }
      },
      install: signal => {
        calls.push('install')
        installSignal = signal
        return new Promise(resolve => {
          finishInstall = () => { resolve({ status: 'installed', changed: true }) }
        })
      },
    }, vi.fn())

    const installing = controller.install()
    await vi.waitFor(() => { expect(calls).toEqual(['install']) })
    const loading = controller.load()
    expect(installSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(calls).toEqual(['install'])
    finishInstall?.()
    await Promise.all([installing, loading])

    expect(calls).toEqual(['install', 'status'])
    expect(controller.getSnapshot()).toEqual({ status: 'installed', open: false, changed: false })
  })

  it('aborts and awaits active work during disposal', async () => {
    let finishStatus: (() => void) | undefined
    let statusSignal: AbortSignal | undefined
    const controller = new PresetSetupController({
      status: signal => {
        statusSignal = signal
        return new Promise(resolve => {
          finishStatus = () => { resolve({ status: 'not-installed' }) }
        })
      },
      install: async () => ({ status: 'installed', changed: true }),
    }, vi.fn())
    const loading = controller.load()
    await vi.waitFor(() => { expect(statusSignal).toBeDefined() })

    let disposed = false
    const disposing = controller.dispose().then(() => { disposed = true })
    expect(statusSignal?.aborted).toBe(true)
    await Promise.resolve()
    expect(disposed).toBe(false)
    finishStatus?.()
    await Promise.all([loading, disposing])

    expect(disposed).toBe(true)
  })

  it('reports a failing listener without starving the remaining listeners', () => {
    const report = vi.fn()
    const healthy = vi.fn()
    const controller = new PresetSetupController({
      status: async () => ({ status: 'not-installed' }),
      install: async () => ({ status: 'installed', changed: true }),
    }, report)
    controller.subscribe(() => { throw new Error('broken subscriber') })
    controller.subscribe(healthy)

    expect(() => { controller.open() }).not.toThrow()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'broken subscriber' }))
    expect(healthy).toHaveBeenCalledOnce()
  })
})
