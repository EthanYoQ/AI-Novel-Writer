import { describe, expect, it } from 'vitest'
import { parseNovelAssetReadResult } from '../src/context-types.ts'

describe('novel asset browser wire parser', () => {
  it('brands a strict path-free asset response', () => {
    expect(parseNovelAssetReadResult({
      target: { kind: 'characters' },
      revision: 'a'.repeat(64),
      text: '{"characters":[]}\n',
      bytes: 18,
    })).toEqual({
      target: { kind: 'characters' },
      revision: 'a'.repeat(64),
      text: '{"characters":[]}\n',
      bytes: 18,
    })
  })

  it.each([
    { target: { kind: 'unknown' }, revision: 'absent', text: '', bytes: 0 },
    { target: { kind: 'chapter-draft', chapter: 0 }, revision: 'absent', text: '', bytes: 0 },
    { target: { kind: 'project' }, revision: 'not-a-revision', text: '{}\n', bytes: 3 },
    { target: { kind: 'project' }, revision: 'a'.repeat(64), text: '{}\n', bytes: 3, source: 'project.json' },
  ])('rejects an invalid or path-bearing response %#', value => {
    expect(() => parseNovelAssetReadResult(value)).toThrow('AI novel context response is invalid')
  })
})
