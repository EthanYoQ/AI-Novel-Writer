import { describe, expect, it } from 'vitest'
import { validPlotOutlineEntry, plotOutlineConfirmedPrefix, plotOutlineRangeEffect, renderPlotOutlineRange, renderPlotOutlineSynopsis, validPlotOutlineAuthorPrefix, isPlotOutlineCoverageNote,
  plotOutlineNextChapter, plotOutlineRequestContract, derivePlotOutlineCursor, plotOutlineRecoveryDraft, PLOT_OUTLINE_CONTENT, PLOT_OUTLINE_PROTOCOL } from '../plot-outline-contract'
import { outlineProgress } from '../plot-outline-checkpoint'
import type { ProjectCoreSynopsisExpected } from '../../../electron/repositories/project-core-repository'
import { synopsisForDraftChapter } from '../../services/workflows/commands/generate-draft.command'

describe('chapter Markdown outline contract', () => {
  it('作者手动调过章节顺序（1、5、2、3、4）时按范围重写会丢掉第 2 章：判无效，开跑与写回都拒绝', () => {
    const source = { synopsis: `# 情节大纲\n\n${[1, 5, 2, 3, 4].map(n => `## 第${n}章：第${n}夜\n这一夜的事。`).join('\n\n')}`, totalChapters: 12, writingLanguage: 'zh-CN' as const }
    expect(plotOutlineRangeEffect(source, { from: 3, to: 5 })).toEqual({ kind: 'invalid', lastChapter: 5, hasEntries: true, orderIssue: { kind: 'unordered' } })
    expect(() => plotOutlineConfirmedPrefix(source, { from: 3, to: 5 })).toThrow('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
    expect(() => renderPlotOutlineRange('## 第3章：新\n新事。\n\n## 第4章：新\n新事。\n\n## 第5章：新\n新事。', { from: 3, to: 5 }, source))
      .toThrow('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  })

  it('同一章号出现两次（1、2、3、2）时判无效并指出重复的是第 2 章', () => {
    const source = { synopsis: `# 情节大纲\n\n${[1, 2, 3, 2].map(n => `## 第${n}章：第${n}夜\n这一夜的事。`).join('\n\n')}`, totalChapters: 12, writingLanguage: 'zh-CN' as const }
    expect(plotOutlineRangeEffect(source, { from: 4, to: 5 })).toEqual({ kind: 'invalid', lastChapter: 3, hasEntries: true, orderIssue: { kind: 'duplicate', chapter: 2 } })
  })

  it.each(['第0章', '第零章', '第〇章', 'Chapter 0'])('带「%s」序章的大纲从第 1 章起重写：有效并保留序章；序章真重复时仍拒绝', prologue => {
    const synopsis = `# 情节大纲\n\n## ${prologue}：序章\n灯塔熄灭前夜。\n\n${[1, 2].map(n => `## 第${n}章：第${n}夜\n这一夜的事。`).join('\n\n')}`
    const source = { synopsis, totalChapters: 2, writingLanguage: 'zh-CN' as const }
    expect(plotOutlineRangeEffect(source, { from: 1, to: 2 })).toEqual({ kind: 'overwrite', whole: false, from: 1, to: 2, lastChapter: 2, prologue: true })
    expect(plotOutlineRangeEffect(source, { from: 3, to: 4 }).kind).toBe('invalid')
    expect(renderPlotOutlineRange('## 第1章：新\n新事。\n\n## 第2章：新\n新事。', { from: 1, to: 2 }, source))
      .toBe(`# 情节大纲\n\n## ${prologue}：序章\n灯塔熄灭前夜。\n\n## 第1章：新\n新事。\n\n## 第2章：新\n新事。`)
    const repeated = { ...source, synopsis: synopsis.replace('## 第1章', `## ${prologue}：又一个序章\n重复。\n\n## 第1章`) }
    expect(plotOutlineRangeEffect(repeated, { from: 1, to: 2 })).toEqual({ kind: 'invalid', lastChapter: 2, hasEntries: true, orderIssue: { kind: 'duplicate', chapter: 0 } })
  })

  it.each([
    ['只有序章', 'zh-CN', '# 情节大纲\n\n## 第0章：序章\n灯塔熄灭前夜。', '## 第1章：新\n新事。\n\n## 第2章：新\n新事。',
      '# 情节大纲\n\n## 第0章：序章\n灯塔熄灭前夜。\n\n## 第1章：新\n新事。\n\n## 第2章：新\n新事。\n\n> 本大纲已覆盖至第 2 章（全书 5 章），其余章节将在后续批次继续生成。'],
    ['only a prologue', 'en-US', '# Plot Outline\n\n## Chapter 0: Prologue\nThe night before the lighthouse went dark.', '## Chapter 1: New\nNew event.\n\n## Chapter 2: New\nNew event.',
      '# Plot Outline\n\n## Chapter 0: Prologue\nThe night before the lighthouse went dark.\n\n## Chapter 1: New\nNew event.\n\n## Chapter 2: New\nNew event.\n\n> This outline covers chapters 1-2 of 5; the remaining chapters will be generated in later batches.'],
    ['序章加非章节说明文字', 'zh-CN', '# 情节大纲\n\n全书基调：冷。\n\n## 第0章：序章\n灯塔熄灭前夜。\n\n> 作者备注：序章不改。', '## 第1章：新\n新事。\n\n## 第2章：新\n新事。',
      '# 情节大纲\n\n全书基调：冷。\n\n## 第0章：序章\n灯塔熄灭前夜。\n\n> 作者备注：序章不改。\n\n## 第1章：新\n新事。\n\n## 第2章：新\n新事。\n\n> 本大纲已覆盖至第 2 章（全书 5 章），其余章节将在后续批次继续生成。'],
    ['a prologue with notes', 'en-US', '# Plot Outline\n\nTone: cold.\n\n## Chapter 0: Prologue\nThe night before.\n\nNote: keep the prologue.', '## Chapter 1: New\nNew event.\n\n## Chapter 2: New\nNew event.',
      '# Plot Outline\n\nTone: cold.\n\n## Chapter 0: Prologue\nThe night before.\n\nNote: keep the prologue.\n\n## Chapter 1: New\nNew event.\n\n## Chapter 2: New\nNew event.\n\n> This outline covers chapters 1-2 of 5; the remaining chapters will be generated in later batches.'],
    ['序章后有第 3 章', 'zh-CN', '# 情节大纲\n\n## 第0章：序章\n灯塔熄灭前夜。\n\n## 第3章：旧\n旧事。', '## 第1章：新\n新事。\n\n## 第2章：新\n新事。',
      '# 情节大纲\n\n## 第0章：序章\n灯塔熄灭前夜。\n\n## 第1章：新\n新事。\n\n## 第2章：新\n新事。\n\n## 第3章：旧\n旧事。'],
    ['a prologue followed by chapter 3', 'en-US', '# Plot Outline\n\n## Chapter 0: Prologue\nThe night before.\n\n## Chapter 3: Old\nOld event.', '## Chapter 1: New\nNew event.\n\n## Chapter 2: New\nNew event.',
      '# Plot Outline\n\n## Chapter 0: Prologue\nThe night before.\n\n## Chapter 1: New\nNew event.\n\n## Chapter 2: New\nNew event.\n\n## Chapter 3: Old\nOld event.'],
  ] as const)('生成第 1–2 章时序章原样保留在最前面（%s）', (_, writingLanguage, synopsis, body, saved) => {
    const expected: ProjectCoreSynopsisExpected = { synopsis, premise: '前提', charactersArch: '角色', worldbuilding: '世界',
      genre: '悬疑', totalChapters: 5, wordsPerChapter: 2000, writingLanguage, plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' }
    const range = { from: 1, to: 2 }
    expect(renderPlotOutlineRange(body, range, expected)).toBe(saved)
    expect(validPlotOutlineAuthorPrefix(saved, { range, sourceExpected: expected, confirmedPrefix: '' }, range)).toBe(true)
  })

  const prologueBook = (language: 'zh-CN' | 'en-US', prologue: string) => {
    const zh = language === 'zh-CN'
    const chapter = (n: number, title: string, body: string) => zh ? `## 第${n}章：${title}\n${body}` : `## Chapter ${n}: ${title}\n${body}`
    const chapters: Record<number, string> = zh
      ? { 1: chapter(1, '雨夜', '找到信件。'), 2: chapter(2, '码头', '追到码头。'), 3: chapter(3, '灯塔', '登上灯塔。'), 4: chapter(4, '钟声', '听见钟声。'), 5: chapter(5, '天亮', '守塔人离开。') }
      : { 1: chapter(1, 'Rain', 'A letter.'), 2: chapter(2, 'Dock', 'The chase.'), 3: chapter(3, 'Lighthouse', 'The climb.'), 4: chapter(4, 'Bell', 'The bell.'), 5: chapter(5, 'Dawn', 'The keeper leaves.') }
    const tail = (n: number) => zh ? `> 本大纲已覆盖至第 ${n} 章（全书 24 章），其余章节将在后续批次继续生成。` : `> This outline covers chapters 1-${n} of 24; the remaining chapters will be generated in later batches.`
    const title = zh ? '# 情节大纲' : '# Plot Outline'
    const head = zh ? `${title}\n\n## ${prologue}：序章\n灯塔熄灭前夜。` : `${title}\n\n## ${prologue}: Prologue\nThe night before.`
    const expected = (synopsis: string): ProjectCoreSynopsisExpected => ({ synopsis, premise: '前提', charactersArch: '角色', worldbuilding: '世界',
      genre: '悬疑', totalChapters: 24, wordsPerChapter: 2000, writingLanguage: language, plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' })
    const join = (...numbers: number[]) => numbers.map(n => chapters[n]).join('\n\n')
    return { head, tail, expected, join, chapters }
  }

  it.each([
    ['zh-CN', '第0章'], ['zh-CN', '第零章'], ['zh-CN', '第〇章'], ['en-US', 'Chapter 0'],
  ] as const)('只有「%s / %s」序章的作品生成第 1–2 章后：部分完成 2 / 24、下一批从第 3 章续写，续写与恢复都保留序章', (language, prologue) => {
    const { head, tail, expected, join } = prologueBook(language, prologue)
    const afterFirst = `${head}\n\n${join(1, 2)}\n\n${tail(2)}`
    expect(renderPlotOutlineRange(join(1, 2), { from: 1, to: 2 }, expected(head))).toBe(afterFirst)

    const source = expected(afterFirst)
    expect(outlineProgress(afterFirst, null, language, 24)).toEqual({ kind: 'partial', coveredTo: 2, total: 24 })
    expect(plotOutlineNextChapter(source)).toBe(3)
    expect(plotOutlineRangeEffect(source, { from: 3, to: 4 })).toEqual({ kind: 'continue', after: 2 })
    const confirmedPrefix = `${head.slice(head.indexOf('## '))}\n\n${join(1, 2)}`
    expect(plotOutlineConfirmedPrefix(source, { from: 3, to: 4 })).toBe(confirmedPrefix)
    expect(derivePlotOutlineCursor({ from: 3, to: 4 }, 0, [])).toEqual({ kind: 'request', chapterNumber: 3, attempt: 'normal' })

    const afterSecond = `${head}\n\n${join(1, 2, 3, 4)}\n\n${tail(4)}`
    expect(renderPlotOutlineRange(join(3, 4), { from: 3, to: 4 }, source)).toBe(afterSecond)
    expect(outlineProgress(afterSecond, null, language, 24)).toEqual({ kind: 'partial', coveredTo: 4, total: 24 })
    const progress = { range: { from: 3, to: 4 }, sourceExpected: source, confirmedPrefix }
    expect(validPlotOutlineAuthorPrefix(afterSecond, progress, { from: 3, to: 4 })).toBe(true)
    expect(validPlotOutlineAuthorPrefix(`${head}\n\n${join(1, 2, 3)}\n\n${tail(3)}`, progress, { from: 3, to: 3 })).toBe(true)

    const recovery = plotOutlineRecoveryDraft({ ...progress, protocol: PLOT_OUTLINE_PROTOCOL, content: PLOT_OUTLINE_CONTENT, targetUnits: 600,
      cursor: { kind: 'stopped', chapterNumber: 3, reason: 'attempts-exhausted' }, composition: null }, join(3))
    expect(recovery).toBe(`${head}\n\n${join(1, 2, 3)}\n\n${tail(3)}`)
  })

  it.each([
    ['没有顶层标题', 'zh-CN', '## 第0章：序章\n灯塔熄灭前夜。'],
    ['no top-level title', 'en-US', '## Chapter 0: Prologue\nThe night before.'],
    ['自定义顶层标题', 'zh-CN', '# 灯塔纪事\n\n## 第0章：序章\n灯塔熄灭前夜。'],
    ['a custom top-level title', 'en-US', '# The Lighthouse\n\n## Chapter 0: Prologue\nThe night before.'],
  ] as const)('只有序章、%s的作品生成第 1–2 章后补上标准标题，能从第 3 章续写，序章与第 1–2 章逐字不变', (_, language, authored) => {
    const { tail, expected, join } = prologueBook(language, '')
    const title = language === 'zh-CN' ? '# 情节大纲' : '# Plot Outline'
    const afterFirst = `${title}\n\n${authored}\n\n${join(1, 2)}\n\n${tail(2)}`
    expect(renderPlotOutlineRange(join(1, 2), { from: 1, to: 2 }, expected(authored))).toBe(afterFirst)
    expect(validPlotOutlineAuthorPrefix(afterFirst, { range: { from: 1, to: 2 }, sourceExpected: expected(authored), confirmedPrefix: '' }, { from: 1, to: 2 })).toBe(true)

    const source = expected(afterFirst)
    expect(outlineProgress(afterFirst, null, language, 24)).toEqual({ kind: 'partial', coveredTo: 2, total: 24 })
    expect(plotOutlineNextChapter(source)).toBe(3)
    expect(plotOutlineRangeEffect(source, { from: 3, to: 4 })).toEqual({ kind: 'continue', after: 2 })
    expect(renderPlotOutlineRange(join(3, 4), { from: 3, to: 4 }, source)).toBe(`${title}\n\n${authored}\n\n${join(1, 2, 3, 4)}\n\n${tail(4)}`)
  })

  it.each([
    ['zh-CN', '# 情节大纲\n\n## 第0章：序章\n灯塔熄灭前夜。', '> 本大纲已覆盖至第 2 章（全书 30 章），其余章节将在后续批次继续生成。'],
    ['zh-CN', '## 第0章：序章\n灯塔熄灭前夜。', '> 本大纲已覆盖至第 5 章（全书 24 章），其余章节将在后续批次继续生成。'],
    ['en-US', '# Plot Outline\n\n## Chapter 0: Prologue\nThe night before.', '> This outline covers chapters 1-2 of 30; the remaining chapters will be generated in later batches.'],
  ] as const)('只有序章、末尾还留着旧覆盖说明（%s）：生成第 1–2 章后旧说明去掉，新说明只在最后一行', (language, prologueText, staleTail) => {
    const { tail, expected, join } = prologueBook(language, '')
    const title = language === 'zh-CN' ? '# 情节大纲' : '# Plot Outline'
    const saved = renderPlotOutlineRange(join(1, 2), { from: 1, to: 2 }, expected(`${prologueText}\n\n${staleTail}`))
    expect(saved).toBe(`${title}\n\n${prologueText.replace(`${title}\n\n`, '')}\n\n${join(1, 2)}\n\n${tail(2)}`)
    expect(saved.split('\n').filter(line => line.startsWith('> ')).length).toBe(1)
    expect(saved.split('\n').at(-1)).toBe(tail(2))
  })

  it.each([['zh-CN', '第0章'], ['en-US', 'Chapter 0']] as const)('序章加第 1–5 章（%s）从第 3 章重写第 3–5 章：有效，序章与第 1–2 章原样保留', (language, prologue) => {
    const { head, tail, expected, join } = prologueBook(language, prologue)
    const source = expected(`${head}\n\n${join(1, 2, 3, 4, 5)}\n\n${tail(5)}`)
    expect(plotOutlineRangeEffect(source, { from: 3, to: 5 })).toEqual({ kind: 'overwrite', whole: false, from: 3, to: 5, lastChapter: 5, prologue: true })
    const rewritten = language === 'zh-CN' ? '## 第3章：新\n新事。\n\n## 第4章：新\n新事。\n\n## 第5章：新\n新事。' : '## Chapter 3: New\nNew.\n\n## Chapter 4: New\nNew.\n\n## Chapter 5: New\nNew.'
    expect(renderPlotOutlineRange(rewritten, { from: 3, to: 5 }, source)).toBe(`${head}\n\n${join(1, 2)}\n\n${rewritten}\n\n${tail(5)}`)
  })

  it.each([
    ['第 0 章出现两次（0、1、2、0）', [0, 1, 2, 0], { kind: 'duplicate', chapter: 0 }],
    ['第 0 章不在最前（1、0、2）', [1, 0, 2], { kind: 'unordered' }],
  ] as const)('%s：续写第 3–4 章仍判无效并给出对应原因', (_, order, orderIssue) => {
    const synopsis = `# 情节大纲\n\n${order.map(n => `## 第${n}章：第${n}夜\n这一夜的事。`).join('\n\n')}\n\n> 本大纲已覆盖至第 2 章（全书 24 章），其余章节将在后续批次继续生成。`
    const source = { synopsis, totalChapters: 24, writingLanguage: 'zh-CN' as const }
    expect(plotOutlineRangeEffect(source, { from: 3, to: 4 })).toEqual({ kind: 'invalid', lastChapter: 2, hasEntries: true, orderIssue })
    expect(() => plotOutlineConfirmedPrefix(source, { from: 3, to: 4 })).toThrow('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
    expect(plotOutlineNextChapter(source)).toBe(1)
  })

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

  describe('只有序章时开头的标准标题与末尾旧覆盖说明（#418）', () => {
    const expected = (synopsis: string) => ({ synopsis, totalChapters: 24, writingLanguage: 'zh-CN' as const })
    const zhNote = (n: number) => `> 本大纲已覆盖至第 ${n} 章（全书 24 章），其余章节将在后续批次继续生成。`
    const body = '## 第1章：新\n新事。\n\n## 第2章：新\n新事。'
    const saved = (authored: string) => `# 情节大纲\n\n${authored}\n\n${body}\n\n${zhNote(2)}`

    it('夹着十万行空白时清理旧说明仍是线性耗时', () => {
      for (const filler of ['\n', '\n \t']) {
        const synopsis = `# 情节大纲\n\n## 第0章：序章\n灯塔熄灭前夜。${filler.repeat(100_000)}\n备注`
        const started = performance.now()
        const result = renderPlotOutlineRange(body, { from: 1, to: 2 }, expected(synopsis))
        expect(performance.now() - started).toBeLessThan(1_000)
        expect(result.startsWith('# 情节大纲\n\n## 第0章：序章\n灯塔熄灭前夜。')).toBe(true)
        expect(result.endsWith(`备注\n\n${body}\n\n${zhNote(2)}`)).toBe(true)
      }
    })

    it('CRLF 换行的大纲生成后开头只有一行标准标题，旧覆盖说明（可连续多条）都去掉', () => {
      const crlf = (text: string) => text.replaceAll('\n', '\r\n')
      const synopsis = crlf(`# 情节大纲\n\n## 第0章：序章\n灯塔熄灭前夜。\n\n${zhNote(3)}\n\n${zhNote(5)}`)
      const result = renderPlotOutlineRange(body, { from: 1, to: 2 }, expected(synopsis))
      expect(result.match(/# 情节大纲/gu)).toHaveLength(1)
      expect(result).toBe(saved('## 第0章：序章\r\n灯塔熄灭前夜。'))
    })

    it('前言写在标准标题之前时，生成后也只有一行标准标题，前言原样保留', () => {
      const result = renderPlotOutlineRange(body, { from: 1, to: 2 }, expected('全书基调：冷。\n\n# 情节大纲\n\n## 第0章：序章\n灯塔熄灭前夜。'))
      expect(result).toBe(saved('全书基调：冷。\n\n## 第0章：序章\n灯塔熄灭前夜。'))
    })

    it('与覆盖说明只差几个字的作者末行不当作旧说明删掉', () => {
      const authored = `## 第0章：序章\n灯塔熄灭前夜。\n\n${zhNote(3).replace('继续生成', '慢慢生成')}`
      expect(renderPlotOutlineRange(body, { from: 1, to: 2 }, expected(`# 情节大纲\n\n${authored}`))).toBe(saved(authored))
    })

    it('写入的覆盖说明能被同一来源认出：中英文、任意章数', () => {
      for (const language of ['zh-CN', 'en-US'] as const) {
        const tail = renderPlotOutlineSynopsis('', 7, { totalChapters: 30, writingLanguage: language }).split('\n').at(-1)!
        expect(isPlotOutlineCoverageNote(tail)).toBe(true)
        expect(isPlotOutlineCoverageNote(`${tail} `)).toBe(false)
      }
    })
  })

  describe('只有序章的大纲（#417）', () => {
    const prologueOnly = (language: 'zh-CN' | 'en-US') => language === 'zh-CN'
      ? `# 情节大纲\n\n## 第0章：序章\n${'守塔人听见第十三声钟，灯塔在那一夜熄灭。'.repeat(4)}`
      : `# Plot Outline\n\n## Chapter 0: Prologue\n${'The keeper hears the thirteenth bell and the lighthouse goes dark. '.repeat(2)}`

    it.each(['zh-CN', 'en-US'] as const)('超过 50 字也算还没开始生成（%s），不是已完成', language => {
      expect(outlineProgress(prologueOnly(language), null, language, 24)).toEqual({ kind: 'empty' })
    })

    it('没有按章标题的整份大纲仍算已完成', () => {
      expect(outlineProgress(`# 情节大纲\n\n${'全书分三幕，林舟追查失踪者。'.repeat(6)}`, null, 'zh-CN', 24)).toEqual({ kind: 'complete' })
    })

    it('从第 1 章起写是接在序章之后续写；重写中间几章时说明序章也保留', () => {
      const source = { synopsis: prologueOnly('zh-CN'), totalChapters: 24, writingLanguage: 'zh-CN' as const }
      expect(plotOutlineRangeEffect(source, { from: 1, to: 5 })).toEqual({ kind: 'continue', after: 0 })
      expect(plotOutlineNextChapter(source)).toBe(1)
      const withChapters = { ...source, synopsis: `${source.synopsis}\n\n${[1, 2, 3, 4, 5].map(n => `## 第${n}章：第${n}夜\n这一夜的事。`).join('\n\n')}` }
      expect(plotOutlineRangeEffect(withChapters, { from: 3, to: 5 })).toEqual({ kind: 'overwrite', whole: false, from: 3, to: 5, lastChapter: 5, prologue: true })
    })
  })

  describe('从第 1 章起生成时发给模型的已接受前缀（#417）', () => {
    const request = (synopsis: string) => {
      const sourceExpected: ProjectCoreSynopsisExpected = { synopsis, premise: '前提', charactersArch: '角色', worldbuilding: '世界',
        genre: '悬疑', totalChapters: 24, wordsPerChapter: 2000, writingLanguage: 'zh-CN', plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' }
      const range = { from: 1, to: 2 }
      const prompt = plotOutlineRequestContract({ protocol: PLOT_OUTLINE_PROTOCOL, range, content: PLOT_OUTLINE_CONTENT, targetUnits: 600,
        cursor: { kind: 'request', chapterNumber: 1, attempt: 'normal' }, sourceExpected, confirmedPrefix: plotOutlineConfirmedPrefix(sourceExpected, range), composition: null }, 1, 'normal')
      return prompt.slice(prompt.indexOf('【已接受大纲前缀】'), prompt.indexOf('【已接受大纲前缀结束】') + '【已接受大纲前缀结束】'.length)
    }
    const PROLOGUE = '## 第0章：序章\n守塔人听见第十三声钟。'

    it('有序章时模型写第 1 章能看到作者的序章，看不到被替换的旧章与覆盖说明', () => {
      expect(request(`# 情节大纲\n\n${PROLOGUE}\n\n> 本大纲已覆盖至第 2 章（全书 24 章），其余章节将在后续批次继续生成。`))
        .toBe(`【已接受大纲前缀】\n${PROLOGUE}\n【已接受大纲前缀结束】`)
      expect(request(`# 情节大纲\n\n${PROLOGUE}\n\n## 第1章：旧\n旧事。\n\n## 第3章：留\n留下。`))
        .toBe(`【已接受大纲前缀】\n${PROLOGUE}\n【已接受大纲前缀结束】`)
    })

    it('没有序章时前缀仍为空', () => {
      expect(request('# 情节大纲\n\n## 第1章：旧\n旧事。')).toBe('【已接受大纲前缀】\n\n【已接受大纲前缀结束】')
      expect(request('')).toBe('【已接受大纲前缀】\n\n【已接受大纲前缀结束】')
    })
  })
})
