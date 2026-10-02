import { describe, expect, it } from 'vitest'

import {
  STICKY_DRAW_MAX_COUNT,
  STICKY_IDEA_MAX_CHARS,
  appendStickyBlock,
  clampStickyIdea,
  composeStickyIdeaBlock,
  mergeStickyAppendedBlocks,
  stickyIdeaSourceLine,
  stickyNoteIdFromTabPath,
  stickyTabPath,
} from '../sticky-note'

describe('便利贴 · 点子裁剪', () => {
  it('不超过上限时原样保留（只去首尾空白）', () => {
    expect(clampStickyIdea('  一个点子  ')).toBe('一个点子')
    expect(clampStickyIdea('x'.repeat(STICKY_IDEA_MAX_CHARS))).toHaveLength(STICKY_IDEA_MAX_CHARS)
  })

  it('超限时截断并留下省略号，让人看得出被剪过', () => {
    const clamped = clampStickyIdea('字'.repeat(STICKY_IDEA_MAX_CHARS + 200))
    expect(clamped).toHaveLength(STICKY_IDEA_MAX_CHARS)
    expect(clamped.endsWith('…')).toBe(true)
  })

  it('上限就是先生定的 500，抽卡上限是 10', () => {
    expect(STICKY_IDEA_MAX_CHARS).toBe(500)
    expect(STICKY_DRAW_MAX_COUNT).toBe(10)
  })
})

describe('便利贴 · 来源行', () => {
  it('带引用时列出条目名', () => {
    const line = stickyIdeaSourceLine({
      at: '2026-09-20T14:30:00',
      mentions: [
        { type: 'character', name: '顾舟' },
        { type: 'world-setting', name: '势力' },
      ],
    })
    expect(line).toContain('灵感')
    expect(line).toContain('顾舟 / 势力')
  })

  it('没有引用时只剩时刻，不留一个孤零零的分隔符', () => {
    const line = stickyIdeaSourceLine({ at: '2026-09-20T14:30:00', mentions: [] })
    expect(line.startsWith('—— 灵感 · ')).toBe(true)
    expect(line).not.toContain(' / ')
  })

  it('时刻解析不了也照样给出行，绝不因为来源行让追加失败', () => {
    expect(stickyIdeaSourceLine({ at: '不是时间', mentions: [] })).toContain('不是时间')
  })
})

describe('便利贴 · 追加', () => {
  it('首条点子前面不留空行', () => {
    expect(appendStickyBlock('', '甲')).toBe('甲')
  })

  it('后续点子之间恒空一行', () => {
    expect(appendStickyBlock('甲', '乙')).toBe('甲\n\n乙')
  })

  it('追加前先削掉正文末尾的空白，避免越攒越多的空行', () => {
    expect(appendStickyBlock('甲\n\n\n', '乙')).toBe('甲\n\n乙')
  })

  it('空段落是空操作 —— 不该凭空空出一行', () => {
    expect(appendStickyBlock('甲', '')).toBe('甲')
  })

  it('拼出来的一块 = 来源行 + 空行 + 正文', () => {
    const block = composeStickyIdeaBlock({
      idea: '雨夜那场戏可以让她先开口',
      at: '2026-09-20T14:30:00',
      mentions: [],
    })
    const [sourceLine, blank, body] = block.split('\n')
    expect(sourceLine.startsWith('—— 灵感')).toBe(true)
    expect(blank).toBe('')
    expect(body).toBe('雨夜那场戏可以让她先开口')
  })
})

describe('便利贴 · 把新段落接进作者手里的正文', () => {
  /**
   * 先生（2026-09-20）：「如果便利贴中本来有内容，那加入的内容会自然分段地加入在原本内容中。」
   *
   * 这一组守的正是那件事 —— 抽到的点子和找回的点子，都要接在作者当前内容后面，
   * 段落之间空一行；同时绝不覆盖他还没保存的字。
   */
  it('本来没有内容时，新段落就是全部', () => {
    expect(mergeStickyAppendedBlocks('', ['甲'])).toBe('甲')
  })

  it('本来有内容时接在后面，并空一行 —— 这就是「自然分段」', () => {
    expect(mergeStickyAppendedBlocks('我今天想到的一点', ['甲']))
      .toBe('我今天想到的一点\n\n甲')
  })

  it('一次接多段，段段之间都空一行', () => {
    expect(mergeStickyAppendedBlocks('已有', ['甲', '乙'])).toBe('已有\n\n甲\n\n乙')
  })

  it('作者结尾多打了几个空行，接上去也不会越积越多', () => {
    expect(mergeStickyAppendedBlocks('已有\n\n\n', ['甲'])).toBe('已有\n\n甲')
  })

  it('没有新段落时是空操作 —— 不该凭空空出一行', () => {
    expect(mergeStickyAppendedBlocks('已有', [])).toBe('已有')
    expect(mergeStickyAppendedBlocks('已有', [''])).toBe('已有')
  })

  it('作者正在写的字一个都不能少', () => {
    const typed = '标题\n\n第一段\n第二段'
    expect(mergeStickyAppendedBlocks(typed, ['甲']).startsWith(typed)).toBe(true)
  })
})

describe('便利贴 · 标签路径', () => {
  it('路径与还原互为逆运算', () => {
    expect(stickyNoteIdFromTabPath(stickyTabPath('note-1'))).toBe('note-1')
  })

  it('不是便利贴标签的路径一律返回 null', () => {
    expect(stickyNoteIdFromTabPath(undefined)).toBeNull()
    expect(stickyNoteIdFromTabPath('vela://draft/42')).toBeNull()
    expect(stickyNoteIdFromTabPath('vela://sticky/')).toBeNull()
  })
})
