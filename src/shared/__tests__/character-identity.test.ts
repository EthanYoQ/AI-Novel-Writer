import { describe, it, expect } from 'vitest'
import { resolveScopedCharacterIdentity, type ScopedCharacterAlias } from '../character-identity'
const alias = (id: string, sourceKey = 'source-a'): ScopedCharacterAlias => ({ characterId: id, name: '队长', projectId: 'p', sourceKey, validFrom: 1, validThrough: null })
describe('source-scoped character identity', () => {
  it('requires evidence even for a unique name', () => {
    expect(resolveScopedCharacterIdentity([alias('a')], { name: '队长', projectId: 'p', revision: 1 })).toEqual({ status: 'unresolved', candidateIds: ['a'] })
    expect(resolveScopedCharacterIdentity([alias('a')], { name: '队长', projectId: 'p', sourceKey: 'source-a', revision: 1 })).toEqual({ status: 'resolved', characterId: 'a' })
  })
  it('does not collapse two people sharing an alias or two origins', () => {
    const aliases = [alias('a'), alias('b'), alias('c', 'source-b')]
    expect(resolveScopedCharacterIdentity(aliases, { name: '队长', projectId: 'p', sourceKey: 'source-a', revision: 1 })).toEqual({ status: 'ambiguous', candidateIds: ['a', 'b'] })
    expect(resolveScopedCharacterIdentity(aliases, { name: '队长', projectId: 'p', sourceKey: 'source-b', revision: 1 })).toEqual({ status: 'resolved', characterId: 'c' })
  })
  it('honors project and version and never uses approximate names', () => {
    const aliases = [{ ...alias('a'), validThrough: 2 }]
    for (const lookup of [{ name: '队长', projectId: 'p', revision: 3 }, { name: '队长', projectId: 'other', revision: 1 }, { name: '队 长', projectId: 'p', revision: 1 }])
      expect(resolveScopedCharacterIdentity(aliases, { ...lookup, sourceKey: 'source-a' }).status).toBe('unresolved')
  })
})

it('does not turn a recovered old candidate name into a current identity without its original source scope', () => {
  const aliases = [alias('new-owner', 'new-author-source')]
  expect(resolveScopedCharacterIdentity(aliases, { name: '队长', projectId: 'p', sourceKey: 'old-candidate-source', revision: 1 })).toEqual({ status: 'unresolved', candidateIds: [] })
})

it.each([
  { characterId: '' }, { characterId: ' ' }, { projectId: '' }, { sourceKey: '' },
  { validFrom: Infinity }, { validFrom: -1 }, { validFrom: 1.5 }, { validThrough: 0 }, { validThrough: Infinity },
])('rejects invalid alias evidence %j', invalid => {
  expect(() => resolveScopedCharacterIdentity([{ ...alias('a'), ...invalid }], { name: '队长', projectId: 'p', sourceKey: 'source-a', revision: 1 })).toThrow('INVALID_CHARACTER_LOOKUP')
})
it.each([Infinity, NaN, -1, 0.5])('rejects invalid lookup revision %s', revision => {
  expect(() => resolveScopedCharacterIdentity([alias('a')], { name: '队长', projectId: 'p', sourceKey: 'source-a', revision })).toThrow('INVALID_CHARACTER_LOOKUP')
})
