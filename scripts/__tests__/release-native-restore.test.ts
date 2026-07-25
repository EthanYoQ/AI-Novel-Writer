import { describe, expect, it, vi } from 'vitest'
import { restoreNativeWithIndependentFallback } from '../release-native-restore.mjs'

describe('release native-runtime restoration fallback', () => {
  it('runs the independent restore when failed status is visible before monitor exit', async () => {
    const monitorState = {
      status: 'failed',
      alive: true,
    }
    const calls: string[] = []
    const monitoredError = new Error('monitor status is already failed')
    const restoreMonitored = vi.fn(async () => {
      calls.push(`monitored:${monitorState.status}:${monitorState.alive}`)
      throw monitoredError
    })
    const restoreIndependent = vi.fn(async () => {
      calls.push(`independent:${monitorState.status}:${monitorState.alive}`)
    })

    const result = await restoreNativeWithIndependentFallback({
      restoreMonitored,
      restoreIndependent,
    })

    expect(result).toEqual({
      usedIndependentFallback: true,
      monitoredError,
    })
    expect(restoreMonitored).toHaveBeenCalledOnce()
    expect(restoreIndependent).toHaveBeenCalledOnce()
    expect(calls).toEqual([
      'monitored:failed:true',
      'independent:failed:true',
    ])
  })

  it('repeats the full independent operation even if the monitored attempt partially ran', async () => {
    const calls: string[] = []
    const result = await restoreNativeWithIndependentFallback({
      restoreMonitored: async () => {
        calls.push('monitored:restore')
        calls.push('monitored:verify')
        throw new Error('failed status won the exit race')
      },
      restoreIndependent: async () => {
        calls.push('independent:restore')
        calls.push('independent:verify')
      },
    })

    expect(result.usedIndependentFallback).toBe(true)
    expect(calls).toEqual([
      'monitored:restore',
      'monitored:verify',
      'independent:restore',
      'independent:verify',
    ])
  })

  it('does not duplicate restoration after a successful monitored run', async () => {
    const restoreIndependent = vi.fn()
    const result = await restoreNativeWithIndependentFallback({
      restoreMonitored: vi.fn(async () => undefined),
      restoreIndependent,
    })

    expect(result.usedIndependentFallback).toBe(false)
    expect(restoreIndependent).not.toHaveBeenCalled()
  })
})
