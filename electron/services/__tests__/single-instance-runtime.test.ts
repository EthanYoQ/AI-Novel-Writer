import { describe, expect, it, vi } from 'vitest'

import { configureSingleInstanceRuntime } from '../single-instance-runtime'

describe('single-instance runtime', () => {
  it('does not interfere with isolated packaged release smoke processes', () => {
    const requestLock = vi.fn(() => false)
    const quit = vi.fn()
    const onSecondInstance = vi.fn()

    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: true,
      requestLock,
      quit,
      onSecondInstance,
      getWindow: () => null,
    })).toBe(true)
    expect(requestLock).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    expect(onSecondInstance).not.toHaveBeenCalled()
  })

  it('quits an ordinary secondary instance before startup work begins', () => {
    const quit = vi.fn()
    const onSecondInstance = vi.fn()

    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock: () => false,
      quit,
      onSecondInstance,
      getWindow: () => null,
    })).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(onSecondInstance).not.toHaveBeenCalled()
  })

  it('restores and focuses the primary window after a second launch', () => {
    let listener: (() => void) | undefined
    const restore = vi.fn()
    const show = vi.fn()
    const focus = vi.fn()

    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock: () => true,
      quit: vi.fn(),
      onSecondInstance: next => { listener = next },
      getWindow: () => ({
        isDestroyed: () => false,
        isMinimized: () => true,
        restore,
        show,
        focus,
      }),
    })).toBe(true)

    listener?.()
    expect(restore).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
  })
})
