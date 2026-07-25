import { describe, expect, it } from 'vitest'

import { LatestRequestGate } from '../../../editor/latest-request-gate'
import { beginProjectTreeIdentityTransition } from '../project-tree-refresh-policy'

describe('ProjectTree project identity refresh gate', () => {
  it('invalidates a deferred A response after detach and before reopening the same A path', async () => {
    const gate = new LatestRequestGate()
    let resolveFirstA!: (value: string) => void
    const firstAResponse = new Promise<string>(resolve => { resolveFirstA = resolve })
    beginProjectTreeIdentityTransition(gate, 'C:\\novels\\A', 1)
    const firstARequestId = gate.begin()
    let visibleStatus = 'old A status'
    const firstARefresh = (async () => {
      const status = await firstAResponse
      if (gate.isLatest(firstARequestId)) visibleStatus = status
    })()

    const detached = beginProjectTreeIdentityTransition(gate, undefined, 1)
    visibleStatus = 'cleared'
    const reopenedA = beginProjectTreeIdentityTransition(gate, 'C:\\novels\\A', 2)
    const reopenedARequestId = gate.begin()
    if (gate.isLatest(reopenedARequestId)) visibleStatus = 'reopened A status'

    resolveFirstA('stale first A status')
    await firstARefresh

    expect(detached.hasProject).toBe(false)
    expect(reopenedA.hasProject).toBe(true)
    expect(gate.isLatest(firstARequestId)).toBe(false)
    expect(gate.isLatest(detached.requestId)).toBe(false)
    expect(gate.isLatest(reopenedARequestId)).toBe(true)
    expect(visibleStatus).toBe('reopened A status')
  })

  it('treats a successful same-path open with a new session epoch as a new identity', () => {
    const gate = new LatestRequestGate()
    const firstSession = beginProjectTreeIdentityTransition(
      gate,
      'C:\\novels\\A',
      10,
    )
    const reopenedSession = beginProjectTreeIdentityTransition(
      gate,
      'C:\\novels\\A',
      11,
    )

    expect(firstSession.projectSessionEpoch).toBe(10)
    expect(reopenedSession.projectSessionEpoch).toBe(11)
    expect(gate.isLatest(firstSession.requestId)).toBe(false)
    expect(gate.isLatest(reopenedSession.requestId)).toBe(true)
  })
})
