import { describe, expect, it } from 'vitest'

import { ChapterCreationLoadGate } from '../chapter-creation-load-gate'

describe('chapter creation history load gate', () => {
  it('rejects a delayed project A response after project B starts loading', () => {
    const gate = new ChapterCreationLoadGate()
    const projectA = gate.begin('C:/projects/A')
    const projectB = gate.begin('C:/projects/B')

    expect(gate.isCurrent(projectA, 'C:/projects/B')).toBe(false)
    expect(gate.isCurrent(projectB, 'C:/projects/B')).toBe(true)
  })

  it('rejects an in-flight response after unmount cleanup', () => {
    const gate = new ChapterCreationLoadGate()
    const request = gate.begin('C:/projects/A')

    gate.invalidate(request)

    expect(gate.isCurrent(request, 'C:/projects/A')).toBe(false)
  })
})
