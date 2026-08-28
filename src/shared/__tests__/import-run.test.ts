import { describe, expect, it } from 'vitest'

import {
  createImportRunChapterBatchCheckpointId,
  expectedImportRunEffectKey,
  parseImportRunChapterBatchCheckpointId,
} from '../import-run'

describe('import-run chapter batch checkpoint IDs', () => {
  const chapters = [
    { number: 7, contentFingerprint: 'a'.repeat(64) },
    { number: 8, contentFingerprint: 'b'.repeat(64) },
  ]

  it('uses one canonical range-and-content identity for blueprint checkpoints and receipt keys', () => {
    const checkpointId = createImportRunChapterBatchCheckpointId(chapters)

    expect(checkpointId).toBe('7-8-aaaaaaaa.bbbbbbbb')
    expect(parseImportRunChapterBatchCheckpointId(checkpointId)).toEqual({
      startChapter: 7,
      endChapter: 8,
      contentFingerprintPrefixes: ['aaaaaaaa', 'bbbbbbbb'],
    })
    expect(expectedImportRunEffectKey('chapter-blueprint-range', 'blueprints', checkpointId))
      .toBe(`blueprints:${checkpointId}`)
  })

  it.each([
    '7-8',
    '7-8-aaaaaaaa',
    '8-7-aaaaaaaa.bbbbbbbb',
    '07-8-aaaaaaaa.bbbbbbbb',
    '7-8-AAAAAAAA.bbbbbbbb',
    '7-8-aaaaaaaa.bbbbbbbz',
  ])('rejects a non-canonical checkpoint ID: %s', checkpointId => {
    expect(parseImportRunChapterBatchCheckpointId(checkpointId)).toBeNull()
    expect(expectedImportRunEffectKey('chapter-blueprint-range', 'blueprints', checkpointId)).toBeNull()
  })

  it('rejects non-contiguous chapters and invalid content fingerprints at construction', () => {
    expect(() => createImportRunChapterBatchCheckpointId([
      chapters[0]!,
      { ...chapters[1]!, number: 9 },
    ])).toThrow(/连续/)
    expect(() => createImportRunChapterBatchCheckpointId([
      { number: 7, contentFingerprint: 'not-a-sha256' },
    ])).toThrow(/指纹/)
  })
})
