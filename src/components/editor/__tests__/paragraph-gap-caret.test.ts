/**
 * 段间距（段落之间那个空行）的鼠标吸附落点。
 *
 * 先生（第四次报障）：「鼠标能把光标移动到两个段落中间，导致上下文抖动。」
 * 抖动来自「光标落进空行 → `.cm-lp-caret-empty` 把空行展开 → 下方内容整体下移」。
 * 修法是把段间距从鼠标命中区里摘出去：落在空行上的点吸附到相邻段落的文字上。
 *
 * 这里守的是**吸附落点**这条纯逻辑（不需要浏览器）。
 * 真实点击与版面不动的端到端验证在 `CodeMirrorEditor-paragraph-gap-click.browser.tsx`。
 */
import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import {
  resolveParagraphGapAnchor,
  resolveParagraphGapCaret,
  resolveParagraphGapClick,
} from '../paragraph-gap-caret'

function docOf(...lines: string[]): Text {
  return Text.of(lines)
}

/** 把绝对位置说成「第几行 + 行内第几个字符」，断言读起来才像话。 */
function locate(doc: Text, pos: number): string {
  const line = doc.lineAt(pos)
  return `第${line.number}行+${pos - line.from}`
}

/** 皮肤里的段间距行块：高 1.2em（约 20px）。上下边界固定，方便对上下半做算术。 */
const GAP_RECT = { top: 100, bottom: 120 }
const GAP_TOP = 104
const GAP_BOTTOM = 116
const GAP_MIDDLE = 110

describe('段间距的落点：朝指定方向找最近的正文行', () => {
  const doc = docOf('第一段正文。', '', '第二段正文。')

  it('向上 = 上一段的末尾', () => {
    expect(locate(doc, resolveParagraphGapAnchor(doc, 2, true)!)).toBe('第1行+6')
  })

  it('向下 = 下一段的第一个字之前', () => {
    expect(locate(doc, resolveParagraphGapAnchor(doc, 2, false)!)).toBe('第3行+0')
  })

  it('向下跳过行首缩进字符（em 空格）—— 落在缩进里光标会离文字一整格', () => {
    const indented = docOf('第一段正文。', '', '\u2003\u2003第二段正文。')
    expect(locate(indented, resolveParagraphGapAnchor(indented, 2, false)!)).toBe('第3行+2')
  })

  it('向下同样跳过全角空格缩进', () => {
    const indented = docOf('第一段正文。', '', '\u3000\u3000第二段正文。')
    expect(locate(indented, resolveParagraphGapAnchor(indented, 2, false)!)).toBe('第3行+2')
  })

  it('只有空白的行也算段间距，跨过连续空行找最近的正文行', () => {
    const spaced = docOf('甲。', '', '   ', '乙。')
    expect(locate(spaced, resolveParagraphGapAnchor(spaced, 2, false)!)).toBe('第4行+0')
    expect(locate(spaced, resolveParagraphGapAnchor(spaced, 3, true)!)).toBe('第1行+2')
  })

  it('该方向没有正文行时返回 null', () => {
    expect(resolveParagraphGapAnchor(docOf('', '正文。'), 1, true)).toBeNull()
    expect(resolveParagraphGapAnchor(docOf('正文。', ''), 2, false)).toBeNull()
    expect(resolveParagraphGapAnchor(docOf('', ''), 1, true)).toBeNull()
    expect(resolveParagraphGapAnchor(docOf('', ''), 1, false)).toBeNull()
  })

  it('换方向兜底：文档首尾的空行也能找到正文', () => {
    const leading = docOf('', '正文。')
    expect(locate(leading, resolveParagraphGapCaret(leading, 1, true)!)).toBe('第2行+0')

    const trailing = docOf('正文。', '')
    expect(locate(trailing, resolveParagraphGapCaret(trailing, 2, false)!)).toBe('第1行+3')
  })

  it('整篇都是空行时没有可落笔的段落 —— 返回 null，由调用方保留原位置', () => {
    expect(resolveParagraphGapCaret(docOf('', ''), 1, true)).toBeNull()
  })
})

describe('点击落点：只动段间距，别的一概不碰', () => {
  const doc = docOf('第一段正文。', '', '第二段正文。')
  const gapPos = doc.line(2).from

  it('点空行上半 → 上一段末尾', () => {
    expect(locate(doc, resolveParagraphGapClick(doc, gapPos, GAP_TOP, GAP_RECT))).toBe('第1行+6')
  })

  it('点空行下半 → 下一段开头', () => {
    expect(locate(doc, resolveParagraphGapClick(doc, gapPos, GAP_BOTTOM, GAP_RECT))).toBe('第3行+0')
  })

  it('正好点在中点上 → 归到下一段（上半用严格小于判定）', () => {
    expect(locate(doc, resolveParagraphGapClick(doc, gapPos, GAP_MIDDLE, GAP_RECT))).toBe('第3行+0')
  })

  it('点的是正文行 → 原样返回，绝不挪动', () => {
    const textPos = doc.line(1).from + 2
    expect(resolveParagraphGapClick(doc, textPos, GAP_TOP, GAP_RECT)).toBe(textPos)
  })

  it('点的是纸页下方的留白（落在行块之外）→ 原样返回，那是「落到文末继续写」的入口', () => {
    expect(resolveParagraphGapClick(doc, gapPos, GAP_RECT.bottom + 40, GAP_RECT)).toBe(gapPos)
    expect(resolveParagraphGapClick(doc, gapPos, GAP_RECT.top - 40, GAP_RECT)).toBe(gapPos)
  })

  it('行块边界上有 1px 容差：贴着边界点也算点在段间距里', () => {
    expect(locate(doc, resolveParagraphGapClick(doc, gapPos, GAP_RECT.top - 1, GAP_RECT))).toBe('第1行+6')
    expect(locate(doc, resolveParagraphGapClick(doc, gapPos, GAP_RECT.bottom + 1, GAP_RECT))).toBe('第3行+0')
  })

  it('量不出行块时不猜 —— 原样返回', () => {
    expect(resolveParagraphGapClick(doc, gapPos, GAP_TOP, null)).toBe(gapPos)
  })

  it('整篇空行：没有段落可吸附，保留原位置', () => {
    const blank = docOf('', '')
    expect(resolveParagraphGapClick(blank, 0, GAP_TOP, GAP_RECT)).toBe(0)
  })
})
