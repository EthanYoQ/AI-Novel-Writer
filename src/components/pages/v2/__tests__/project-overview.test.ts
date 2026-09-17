/**
 * 首页项目卡的数据派生契约。
 *
 * 这些纯函数决定卡片上显示什么数字、以及书名会不会把「书名 + 题材」那一行挤爆，
 * 所以单独锁住行为。
 */
import { describe, expect, it } from 'vitest'
import {
  currentTitleFontSize,
  firstSentence,
  pickFocusChapter,
  summarizeTail,
} from '../useProjectOverview'
import type { DraftsByChapter } from '../../../../stores/draft-store'

describe('卡片书名的自适应字号', () => {
  it('短书名用 demo 的 52px', () => {
    expect(currentTitleFontSize('天女伏魔录')).toBe(52)
  })

  it('长书名按可用宽度缩小，保证「书名 + 题材」仍在一行', () => {
    const long = '这个奇奇怪怪超能力的世界快点完蛋吧！'
    const genres = '都市 · 超能力'
    const size = currentTitleFontSize(long, genres.length)

    expect(size).toBeLessThan(52)
    expect(size).toBeGreaterThanOrEqual(18)
    // 真正的性质：书名 + 题材 + 间距必须装得进卡片内容宽（940）
    const occupied = size * [...long].length + Math.min(260, genres.length * 13) + 18
    expect(occupied).toBeLessThanOrEqual(941)
  })

  it('题材标签越长，书名可用宽度越小', () => {
    const title = '一个中等长度的书名测试'
    expect(currentTitleFontSize(title, 20)).toBeLessThanOrEqual(currentTitleFontSize(title, 0))
  })

  it('超长书名不会缩到看不清（有下限）', () => {
    const huge = '这是一部书名极其漫长的长篇小说测试用例'.repeat(3)
    expect(currentTitleFontSize(huge, 8)).toBe(18)
  })
})

describe('「上一笔停在」的摘要', () => {
  it('取正文最后一行并去掉 markdown 标记', () => {
    expect(summarizeTail('第一段。\n\n**最后一段。**')).toBe('最后一段。')
  })

  it('最后一行是标题时往上取一行', () => {
    expect(summarizeTail('正文的一句话。\n## 下一章')).toBe('正文的一句话。')
  })

  it('超长行截断并加省略号', () => {
    const long = '字'.repeat(200)
    const result = summarizeTail(long)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(65)
  })

  it('空正文返回空串，不返回 undefined', () => {
    expect(summarizeTail('')).toBe('')
    expect(summarizeTail('\n\n')).toBe('')
  })
})

describe('一句话简介', () => {
  it('取第一句', () => {
    expect(firstSentence('第一句话。第二句话。')).toBe('第一句话。')
  })

  it('没有句号时整段截断', () => {
    const result = firstSentence('字'.repeat(300))
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(97)
  })

  it('空值安全', () => {
    expect(firstSentence(undefined)).toBe('')
    expect(firstSentence('   ')).toBe('')
  })
})

describe('焦点章的选择', () => {
  const drafts: DraftsByChapter = {
    1: [{
      id: 1, chapterNumber: 1, version: 1, status: 'finalized', wordCount: 4243,
      source: 'write', filePath: 'vela://draft/1', fileName: 'draft_v1.md',
      createdAt: '2026-01-01', updatedAt: '2026-01-05',
    }],
    3: [{
      id: 9, chapterNumber: 3, version: 1, status: 'draft', wordCount: 800,
      source: 'write', filePath: 'vela://draft/9', fileName: 'draft_v1.md',
      createdAt: '2026-02-01', updatedAt: '2026-02-10',
    }],
  }

  it('正在编辑的那一章优先', () => {
    expect(pickFocusChapter(drafts, 1)).toBe(1)
  })

  it('没有在编辑的章节时取最近改动的一章', () => {
    expect(pickFocusChapter(drafts, undefined)).toBe(3)
  })

  it('正在编辑的章还没有草稿时退回最近改动的一章', () => {
    expect(pickFocusChapter(drafts, 7)).toBe(3)
  })

  it('一章草稿都没有时返回 null（新项目）', () => {
    expect(pickFocusChapter({}, undefined)).toBeNull()
  })
})
