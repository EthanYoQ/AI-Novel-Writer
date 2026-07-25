import { describe, expect, it } from 'vitest'

import { LLMDataRequestGate } from '../llm-data-request-gate'

describe('LLMDataRequestGate', () => {
  it('rejects a late stats response after the same logical path reopens with a new lease', () => {
    const gate = new LLMDataRequestGate()
    const oldSession = {
      projectId: 'novel-A',
      leaseId: 'lease-old',
      projectPath: 'C:\\Novels\\A',
    }
    const ticket = gate.begin(oldSession)

    expect(gate.isCurrent(ticket, {
      projectId: 'novel-A',
      leaseId: 'lease-new',
      projectPath: 'c:/novels/a/',
    })).toBe(false)
  })

  it('rejects an earlier request after a later request begins for the same session', () => {
    const gate = new LLMDataRequestGate()
    const session = {
      projectId: 'novel-A',
      leaseId: 'lease-current',
      projectPath: 'C:\\Novels\\A',
    }
    const earlier = gate.begin(session)
    gate.begin(session)

    expect(gate.isCurrent(earlier, session)).toBe(false)
  })
})
