import { describe, expect, it } from 'vitest'

import {
  CHAPTER_WORDS_TARGET_MAX,
  CHAPTER_WORDS_TARGET_MIN,
  createChapterInfoFromDialogInput,
  normalizeChapterWordsTarget,
} from '../chapter-creation-parameters'

describe('chapter creation parameters', () => {
  it('clamps target words at the shared UI and workflow boundary', () => {
    expect(normalizeChapterWordsTarget(99, 3000)).toBe(CHAPTER_WORDS_TARGET_MIN)
    expect(normalizeChapterWordsTarget(20_001, 3000)).toBe(CHAPTER_WORDS_TARGET_MAX)
    expect(normalizeChapterWordsTarget(undefined, 30_000)).toBe(CHAPTER_WORDS_TARGET_MAX)
  })

  it('passes the bounded user-selected target into the created ChapterInfo', () => {
    const chapterInfo = createChapterInfoFromDialogInput({
      projectPath: 'C:\\novels\\single-chapter-target',
      chapterNumber: 2,
      title: '第二章',
      role: '发展',
      purpose: '推进冲突',
      keyEvents: '主角发现线索',
      characters: '林岚，周砚',
      userGuidance: '结尾留下悬念',
      knowledgeQueryHint: '航班编号',
      wordsTarget: 25_000,
      defaultWordsTarget: 6000,
    })

    expect(chapterInfo).toMatchObject({
      chapterNumber: 2,
      title: '第二章',
      characters: ['林岚', '周砚'],
      wordsTarget: CHAPTER_WORDS_TARGET_MAX,
    })
  })
})
