import { describe, expect, it } from 'vitest'
import { chapterAuthorOutlineBlock } from '../chapter-author-outline'

describe('chapterAuthorOutlineBlock', () => {
  it('marks the outline as author facts in Chinese prompts', () => {
    const block = chapterAuthorOutlineBlock('zh-CN', '场景1：主角发现异常。')
    expect(block).toContain('【作者章节大纲：作者事实与要求】')
    expect(block).toContain('场景1：主角发现异常。')
    expect(block.endsWith('【作者章节大纲结束】')).toBe(true)
  })

  it('marks the outline as author facts in English prompts', () => {
    const block = chapterAuthorOutlineBlock('en-US', 'Scene 1: the protagonist notices the anomaly.')
    expect(block).toContain('[Author chapter outline — author facts and requirements]')
    expect(block).toContain('Scene 1: the protagonist notices the anomaly.')
    expect(block.endsWith('[End author chapter outline]')).toBe(true)
  })

  it('rejects a blank outline', () => {
    expect(() => chapterAuthorOutlineBlock('zh-CN', '   \n  ')).toThrow('GENERATION_CHAPTER_AUTHOR_OUTLINE_EMPTY')
  })
})
