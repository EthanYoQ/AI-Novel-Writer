import { describe, expect, it } from 'vitest'

import { createChapterInfoFromDialogInput } from '../ChapterCreationDialog'

describe('ChapterCreationDialog chapter information boundary', () => {
  it('passes the user-selected target into the created ChapterInfo', () => {
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
      wordsTarget: 3000,
      defaultWordsTarget: 6000,
    })

    expect(chapterInfo).toMatchObject({
      chapterNumber: 2,
      title: '第二章',
      characters: ['林岚', '周砚'],
      wordsTarget: 3000,
    })
  })
})
