import { describe, expect, it } from 'vitest'

import { isCharacterExtractionReady } from '../character-extraction-policy'

const readyState = {
  projectKey: 'C:\\novels\\A',
  dataProjectKey: 'C:\\novels\\A',
  loadingProjectKey: null,
  lastError: null,
  characterCount: 0,
}

describe('character extraction readiness', () => {
  it('allows extraction only for a successfully bound empty current project', () => {
    expect(isCharacterExtractionReady(readyState)).toBe(true)
  })

  it.each([
    { dataProjectKey: null },
    { dataProjectKey: 'C:\\novels\\B' },
    { loadingProjectKey: 'C:\\novels\\A' },
    { lastError: 'database busy' },
    { characterCount: 1 },
  ])('blocks extraction while character emptiness is not trustworthy: %o', override => {
    expect(isCharacterExtractionReady({ ...readyState, ...override })).toBe(false)
  })
})
