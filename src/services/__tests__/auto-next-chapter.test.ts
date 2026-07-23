import { describe, expect, it } from 'vitest'

import { getAutoNextChapterPrefill } from '../auto-next-chapter'

const blueprint = {
  chapterNumber: 2,
  title: '雨夜来信',
  role: '发展',
  purpose: '推进调查',
  keyEvents: '收到密信',
  characters: ['林舟', '苏雨'],
  userGuidance: '保留悬念',
}

describe('getAutoNextChapterPrefill', () => {
  it('opens the immediate next blueprint only when the user enabled the setting', () => {
    expect(getAutoNextChapterPrefill(true, 1, blueprint, false)).toEqual({
      chapterNumber: 2,
      title: '雨夜来信',
      role: '发展',
      purpose: '推进调查',
      keyEvents: '收到密信',
      characters: '林舟、苏雨',
      userGuidance: '保留悬念',
    })
  })

  it.each([
    [false, 1, blueprint, false],
    [true, 1, { ...blueprint, chapterNumber: 3 }, false],
    [true, 1, blueprint, true],
  ])('does not open an unsafe or unavailable next chapter', (enabled, completedChapter, nextBlueprint, hasDraft) => {
    expect(getAutoNextChapterPrefill(enabled, completedChapter, nextBlueprint, hasDraft)).toBeNull()
  })
})
