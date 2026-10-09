import { describe, expect, it } from 'vitest'
import { validPlotOutlineEntry, plotOutlineConfirmedPrefix, renderPlotOutlineRange, renderPlotOutlineSynopsis, validPlotOutlineAuthorPrefix } from '../plot-outline-contract'
import type { ProjectCoreSynopsisExpected } from '../../../electron/repositories/project-core-repository'
import { synopsisForDraftChapter } from '../../services/workflows/commands/generate-draft.command'

describe('chapter Markdown outline contract', () => {
  it.each([
    ['## 第一章：起点\n当前章事实。', '## 第二章：后续\n后续章事实。'],
    ['- 第1章：起点\n当前章事实。', '- 第2章：后续\n后续章事实。'],
    ['# 第1章：起点\n当前章事实。', '## 第2章：后续\n后续章事实。'],
  ])('rejects chapter styles whose real draft consumer would retain the whole outline', (first, second) => {
    const synopsis = `${first}\n\n${second}`
    expect(synopsisForDraftChapter(synopsis, 1)).toBe(synopsis)
    expect([first, second].every((entry, index) => validPlotOutlineEntry(entry, index + 1))).toBe(false)
  })
  it('counts the full entry in Unicode code points without truncating a 1201 point entry', () => {
    const heading = '## 第1章：标题\n'
    const maximum = heading + '😀'.repeat(1200 - [...heading].length)
    expect([...maximum]).toHaveLength(1200)
    expect(maximum.length).toBeGreaterThan(1200)
    expect(validPlotOutlineEntry(maximum, 1)).toBe(true)
    expect(validPlotOutlineEntry(`${maximum}尾`, 1)).toBe(true)
  })
  it.each([
    '第1–2章：组\n正文', 'Chapters 1-2: Group\nBody', 'Chapters 1: Group\nBody',
    '前言\n第1章：题\n正文', '第1章：题\n正文\nChapter 2: Other\nBody',
    '第1章：题\n正文\n## 章外概览\n正文', '第1章：题', '第2章：错章\n正文',
    '第1章：题\n正文\n> 后续概览：第二章', '```\n第1章：题\n正文\n```',
  ])('refuses a structurally ambiguous or extra-chapter entry: %s', text => {
    expect(validPlotOutlineEntry(text, 1)).toBe(false)
  })
  it.each(['## 第1章：起点\n行动和结果。', '## Chapter 1: Beginning\nAction and result.'])('accepts a uniform single chapter heading: %s', text => {
    expect(validPlotOutlineEntry(text, 1)).toBe(true)
  })
  it('retains a confirmed prefix and the untouched tail when replacing an earlier chapter', () => {
    const expected: ProjectCoreSynopsisExpected = { synopsis: '', premise: '前提', charactersArch: '角色', worldbuilding: '世界',
      genre: '悬疑', totalChapters: 3, wordsPerChapter: 2000, writingLanguage: 'zh-CN', plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' }
    const prefix = '## 第1章：作者已确认\n原事实必须保留。'
    expected.synopsis = renderPlotOutlineSynopsis(prefix, 1, expected)
    expect(plotOutlineConfirmedPrefix(expected, { from: 2, to: 3 })).toBe(prefix)
    expect(() => plotOutlineConfirmedPrefix(expected, { from: 3, to: 3 })).toThrow('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
    expected.synopsis = renderPlotOutlineSynopsis(`${prefix}\n\n## 第2章：确认尾部\n不能丢失。`, 2, expected)
    expect(plotOutlineConfirmedPrefix(expected, { from: 1, to: 1 })).toBe('')
    const replacement = renderPlotOutlineRange('## 第1章：新章\n替换首章。', { from: 1, to: 1 }, expected)
    expect(replacement.slice(replacement.indexOf('## 第2章'))).toBe(expected.synopsis.slice(expected.synopsis.indexOf('## 第2章')))
  })
  it('accepts only a complete continuous author prefix within the original selection and keeps prior author chapters exact', () => {
    const expected: ProjectCoreSynopsisExpected = { synopsis: '', premise: '前提', charactersArch: '角色', worldbuilding: '世界',
      genre: '悬疑', totalChapters: 4, wordsPerChapter: 2000, writingLanguage: 'zh-CN', plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' }
    const confirmedPrefix = '## 第1章：已确认\n保留原章。'
    expected.synopsis = renderPlotOutlineSynopsis(confirmedPrefix, 1, expected)
    const progress = { range: { from: 2, to: 3 }, sourceExpected: expected, confirmedPrefix }
    const authored = '## 第2章：补齐\n完整作者内容。'
    expect(validPlotOutlineAuthorPrefix(renderPlotOutlineSynopsis(`${confirmedPrefix}\n\n${authored}`, 2, expected), progress, { from: 2, to: 2 })).toBe(true)
    for (const body of [authored, `${confirmedPrefix}\n\n## 第2章：\n`, `${confirmedPrefix}\n\n## 第3章：跳章\n完整作者内容。`,
      `${confirmedPrefix.replace('保留原章', '替换原章')}\n\n${authored}`, `${confirmedPrefix}\n\n${authored}\n\n## 第4章：越界\n未来。`]) {
      expect(validPlotOutlineAuthorPrefix(renderPlotOutlineSynopsis(body, 2, expected), progress, { from: 2, to: 2 })).toBe(false)
    }
  })
})
