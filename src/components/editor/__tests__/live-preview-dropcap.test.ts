import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { resolveDropcapRange } from '../live-preview'

/**
 * 首字下沉的落点。
 *
 * 先生的事故反馈：段落若以标点起笔，标点被放大成了朱砂大字 ——
 * 例如「「他说……」」会把左引号放大，「（一）开篇」会把括号放大。
 * 要求标点不参与，落到第一个真正的字上。
 */
function dropcapOf(lines: string[], minLine = 1): string | null {
  const doc = Text.of(lines)
  const range = resolveDropcapRange(doc, minLine)
  return range ? doc.sliceString(range.from, range.to) : null
}

describe('resolveDropcapRange', () => {
  it('takes the first character of a plain Chinese paragraph', () => {
    expect(dropcapOf(['这是一段正文。'])).toBe('这')
  })

  it('skips leading indentation whitespace', () => {
    expect(dropcapOf(['\u3000\u3000夜色沉了下来。'])).toBe('夜')
    expect(dropcapOf(['       夜色沉了下来。'])).toBe('夜')
  })

  it('never drops the cap onto a leading punctuation mark', () => {
    expect(dropcapOf(['「他说过不会回来。」'])).toBe('他')
    // 括号被跳过，落到括号内的第一个实义字符（序号「一」也是实义字符）
    expect(dropcapOf(['（一）开篇'])).toBe('一')
    expect(dropcapOf(['（上）开篇'])).toBe('上')
    expect(dropcapOf(['「『引号套引号』」'])).toBe('引')
    expect(dropcapOf(['……序章'])).toBe('序')
    expect(dropcapOf(['—— 转折'])).toBe('转')
    expect(dropcapOf(['"Hello world"'])).toBe('H')
    expect(dropcapOf(['《书名》之后'])).toBe('书')
  })

  it('skips whitespace that sits between the leading punctuation and the first word', () => {
    expect(dropcapOf(['「  他低声说」'])).toBe('他')
    expect(dropcapOf(['\u3000\u3000—— 他终于开口'])).toBe('他')
  })

  it('reports nothing to drop when the paragraph holds no real character', () => {
    expect(dropcapOf(['。，！？；：'])).toBeNull()
    expect(dropcapOf(['\u3000\u3000\u3000'])).toBeNull()
  })

  it('still skips heading lines and lands on the first body paragraph', () => {
    // 「第 6 章 …」是纯文本中文章回标题，首字下沉必须落在它下面的正文段。
    expect(dropcapOf(['第 6 章 装敛疑云', '夜色沉了下来。'])).toBe('夜')
    expect(dropcapOf(['# 标题', '正文开头'])).toBe('正')
  })

  it('keeps a surrogate pair (emoji / rare hanzi) intact', () => {
    expect(dropcapOf(['𠀋字开头的段落'])).toBe('𠀋')
  })
})
