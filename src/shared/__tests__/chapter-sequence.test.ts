import { describe, expect, it } from 'vitest'

import { chapterSequenceFrom, writableChapterNumbers, type ChapterSequence } from '../chapter-sequence'

const none = new Set<number>()

describe('chapterSequenceFrom', () => {
  it.each<[string, number[], ReadonlySet<number>, ChapterSequence]>([
    ['空书从第 1 章开始', [], none,
      { status: 'empty', lastChapterNumber: 0, nextChapterNumber: 1, gaps: [], duplicateChapterNumbers: [] }],
    ['连续定稿接着写下一章', [1, 2, 3], none,
      { status: 'continuous', lastChapterNumber: 3, nextChapterNumber: 4, gaps: [], duplicateChapterNumbers: [] }],
    ['删掉第 1 章后缺口合法，下一章仍是最大章号加一', [2], new Set([1]),
      { status: 'gapped', lastChapterNumber: 2, nextChapterNumber: 3, gaps: [{ from: 1, to: 1, cause: 'deleted' }], duplicateChapterNumbers: [] }],
    ['没有删除记录的缺口记为来历不明', [1, 4], none,
      { status: 'gapped', lastChapterNumber: 4, nextChapterNumber: 5, gaps: [{ from: 2, to: 3, cause: 'unexplained' }], duplicateChapterNumbers: [] }],
    ['多段缺口各自成段，段内任一章删过就算删除', [1, 4, 7], new Set([3]),
      { status: 'gapped', lastChapterNumber: 7, nextChapterNumber: 8,
        gaps: [{ from: 2, to: 3, cause: 'deleted' }, { from: 5, to: 6, cause: 'unexplained' }], duplicateChapterNumbers: [] }],
    ['最后一章删掉不留缺口，下一章退回', [1, 2], new Set([3]),
      { status: 'continuous', lastChapterNumber: 2, nextChapterNumber: 3, gaps: [], duplicateChapterNumbers: [] }],
    ['同一章多行定稿仍然无效，不给下一章', [3, 1, 3, 2, 1], none,
      { status: 'invalid', lastChapterNumber: 3, gaps: [], duplicateChapterNumbers: [1, 3] }],
    ['重复与缺口同时出现时以重复为准', [1, 1, 3], new Set([2]),
      { status: 'invalid', lastChapterNumber: 3, gaps: [{ from: 2, to: 2, cause: 'deleted' }], duplicateChapterNumbers: [1] }],
  ])('%s', (_name, finalized, deleted, expected) => {
    expect(chapterSequenceFrom(finalized, deleted)).toEqual(expected)
  })
})

describe('writableChapterNumbers', () => {
  it('每段缺口只开放段首，再加下一章', () => {
    const sequence = chapterSequenceFrom([1, 4, 7], none)
    if (sequence.status === 'invalid') throw new Error('unexpected invalid sequence')

    expect(writableChapterNumbers(sequence)).toEqual([2, 5, 8])
  })

  it('没有缺口时只能写下一章', () => {
    const sequence = chapterSequenceFrom([1, 2], none)
    if (sequence.status === 'invalid') throw new Error('unexpected invalid sequence')

    expect(writableChapterNumbers(sequence)).toEqual([3])
  })
})
