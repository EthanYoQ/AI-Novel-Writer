import { describe, expect, it } from 'vitest'

import {
  normalizeWorkflowResourceKeys,
  workflowResourceClaimsConflict,
} from '../workflow-resource-claims'

describe('workflow read/write resource claims', () => {
  it('normalizes empty and duplicate keys', () => {
    expect(normalizeWorkflowResourceKeys([' chapter:1 ', '', 'chapter:1']))
      .toEqual(['chapter:1'])
  })

  it('allows multiple readers of the same dependency', () => {
    expect(workflowResourceClaimsConflict(
      { readResourceKeys: ['blueprints'] },
      { readResourceKeys: ['blueprints'] },
    )).toBe(false)
  })

  it.each([
    [
      { resourceKeys: ['blueprints'] },
      { readResourceKeys: ['blueprints'] },
    ],
    [
      { readResourceKeys: ['blueprints'] },
      { resourceKeys: ['blueprints'] },
    ],
    [
      { resourceKeys: ['architecture'] },
      { resourceKeys: ['architecture'] },
    ],
  ])('rejects read/write or write/write overlap', (active, requested) => {
    expect(workflowResourceClaimsConflict(active, requested)).toBe(true)
  })

  it('keeps different chapters concurrent when both only read shared project facts', () => {
    expect(workflowResourceClaimsConflict(
      { resourceKeys: ['chapter:1'], readResourceKeys: ['architecture', 'blueprints'] },
      { resourceKeys: ['chapter:2'], readResourceKeys: ['architecture', 'blueprints'] },
    )).toBe(false)
  })
})
