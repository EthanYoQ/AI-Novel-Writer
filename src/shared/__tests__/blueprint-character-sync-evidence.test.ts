import { describe, expect, it } from 'vitest'

import { blueprintCharacterSyncFactError } from '../blueprint-character-sync-evidence'
import type { BlueprintCharacterSyncRosterFact } from '../blueprint-character-sync-evidence'

const blueprints = [{
  chapterNumber: 1,
  characters: ['林岚', '周砚'],
  relationshipHints: [{ from: '林岚', to: '周砚', relation: '临时盟友' }],
}]

function roster(overrides: BlueprintCharacterSyncRosterFact[] = []): BlueprintCharacterSyncRosterFact[] {
  return [
    { name: '林岚', relationships: [{ target: '周砚', relation: '临时盟友' }] },
    { name: '周砚', relationships: [{ target: '林岚', relation: '临时盟友' }] },
    ...overrides,
  ]
}

describe('blueprint character-sync fact evidence', () => {
  it('accepts a roster containing every frozen character and bidirectional relationship fact', () => {
    expect(blueprintCharacterSyncFactError(blueprints, roster())).toBeUndefined()
  })

  it('does not require a blueprint-only name to become a roster character', () => {
    expect(blueprintCharacterSyncFactError(blueprints, roster().slice(0, 1)))
      .toBeUndefined()
  })

  it('rejects a roster that omits either direction of a frozen relationship', () => {
    expect(blueprintCharacterSyncFactError(blueprints, [
      roster()[0],
      { name: '周砚', relationships: [] },
    ])).toMatch(/临时盟友/u)
  })

  it('does not force legacy relationship prose into a lossy structured conversion', () => {
    expect(blueprintCharacterSyncFactError(blueprints, [
      { name: '林岚', relationships: [], legacyRelationshipNotes: '作者手工关系原文' },
      { name: '周砚', relationships: [], legacyRelationshipNotes: '作者手工关系原文' },
    ])).toBeUndefined()
  })
})
