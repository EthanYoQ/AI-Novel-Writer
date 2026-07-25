import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scheduleReminderRefresh } from '../use-update-state'

const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('update reminder refresh scheduling', () => {
  it('refreshes state exactly when a seven-day reminder expires', async () => {
    const refresh = vi.fn()
    scheduleReminderRefresh('2026-07-08T00:00:00.000Z', refresh)

    await vi.advanceTimersByTimeAsync(7 * DAY_MS - 1)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('chains timers so a thirty-day reminder does not overflow setTimeout', async () => {
    const refresh = vi.fn()
    scheduleReminderRefresh('2026-07-31T00:00:00.000Z', refresh)

    await vi.advanceTimersByTimeAsync(29 * DAY_MS)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DAY_MS)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('cancels the old reminder when its version changes or the hook unmounts', async () => {
    const refresh = vi.fn()
    const cancel = scheduleReminderRefresh('2026-07-08T00:00:00.000Z', refresh)

    cancel()
    await vi.advanceTimersByTimeAsync(8 * DAY_MS)

    expect(refresh).not.toHaveBeenCalled()
  })
})
