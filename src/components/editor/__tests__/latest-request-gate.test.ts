import { describe, expect, it } from 'vitest'

import { LatestRequestGate } from '../latest-request-gate'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('LatestRequestGate', () => {
  it('prevents an older same-project refresh from overwriting a newer response', async () => {
    const gate = new LatestRequestGate()
    const older = deferred<string>()
    const newer = deferred<string>()
    let visibleValue = ''

    const refresh = async (request: Promise<string>) => {
      const requestId = gate.begin()
      const value = await request
      if (gate.isLatest(requestId)) visibleValue = value
    }

    const olderRefresh = refresh(older.promise)
    const newerRefresh = refresh(newer.promise)
    newer.resolve('newer')
    await newerRefresh
    older.resolve('older')
    await olderRefresh

    expect(visibleValue).toBe('newer')
  })
})
