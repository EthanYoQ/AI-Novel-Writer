/**
 * v3 书脊：**长书名的自适应** —— 纯函数契约（第十五轮）。
 *
 * 先生：「书籍现在有些名字特别长的，书架上书脊会显示不全或者特别难看，
 * 帮我记住，这种长名字的书，就可以把书变宽一点，或者书名字小点，
 * 让他名字能显示全且美观。」
 *
 * 量出来的事实（`_probe-v3-r15.mjs`，量 dist 的 computed 值 + Range 绘制盒）：
 *   · 书名竖排，一列放得下 **12 个字**（可用高 161px ÷ 每字 12.5px）；
 *   · 第 13 个字起浏览器自动折第二列，而书脊只有 27px 宽 —— 两列各自越界，
 *     被 `overflow: hidden` 削掉（这就是「显示不全」）。
 * 修法在 `planSpineTitle()`：先降字号、再按列数加宽书脊。
 *
 * 这份契约钉住三件事，别让后人在数字上「加戏」：
 *   ① 短名一律 12px 单列、书脊不加宽（先生第十三轮定的基准，不许动）；
 *   ② 折列时必须**同时**加宽书脊，否则等于没修；
 *   ③ v2 的尺寸逐像素不变（分家）。
 */
import { describe, expect, it } from 'vitest'

import { spineDimensions, type ShelfBook } from '../bookShelfSpine'

function book(title: string, chapters = 80): ShelfBook {
  return { id: title, title, chapters }
}

/** 先生定稿的 v3 基准宽度区间（第十三轮「整体大 3px」之后）。 */
const BASE_MIN = 25
const BASE_MAX = 31

describe('v3 书脊 · 长书名自适应', () => {
  it('短书名（一列放得下）：12px 单列，书脊宽度一寸不加', () => {
    for (const title of ['一', '长夜将明', '带着仓库到大明', '我在明朝当锦衣卫']) {
      const dim = spineDimensions(book(title), 'v3')
      expect(dim.titleColumns, `「${title}」不该折列`).toBe(1)
      expect(dim.titlePx, `「${title}」的字号必须还是基准 12px`).toBe(12)
      expect(dim.w).toBeGreaterThanOrEqual(BASE_MIN)
      expect(dim.w).toBeLessThanOrEqual(BASE_MAX)
    }
  })

  it('略长的书名：只降字号、不折列、不加宽（宁可字小一点也不要折列）', () => {
    // 12 个字刚好占满一列；13–14 个字用 12px 会折列，用 11px 仍是单列
    const dim = spineDimensions(book('我在无限流里当咸鱼的那些日子'), 'v3') // 14 字
    expect(dim.titleColumns).toBe(1)
    expect(dim.titlePx).toBeLessThan(12)
    expect(dim.w).toBeLessThanOrEqual(BASE_MAX)
  })

  it('长书名：折成两列，同时把书脊加宽到容得下两列', () => {
    for (const title of ['穿成反派他妹后我靠美食征服全星际', '诸天万界从一条蛇开始不断进化吞噬']) {
      const dim = spineDimensions(book(title), 'v3') // 16 字
      expect(dim.titleColumns, `「${title}」该折成两列`).toBe(2)
      // 关键：折列而不加宽 = 第二列照样被裁掉，等于没修
      expect(dim.w, `「${title}」折列了却没加宽书脊`).toBeGreaterThan(BASE_MAX)
      expect(dim.w).toBeGreaterThanOrEqual(34)
    }
  })

  it('12 字以内一律是先生定的 12px（基准档不许被自适应带跑）', () => {
    for (const title of ['长夜将明', '带着仓库到大明', '重生之我在异世界当咸鱼王']) {
      expect(spineDimensions(book(title), 'v3').titlePx, `「${title}」`).toBe(12)
    }
  })

  it('书脊再宽也不许回到「大胖子」区间', () => {
    const titles = ['', '一', '普通书名', '我在无限流里当咸鱼的那些日子', '这本书的名字特别特别长用来测试溢出效果到底会怎么样呢']
    for (const title of titles) {
      const dim = spineDimensions(book(title), 'v3')
      expect(dim.w, `「${title}」的书脊宽 ${dim.w}px 太胖了`).toBeLessThan(52)
    }
  })

  it('空书名与超长书名都不许抛错', () => {
    expect(() => spineDimensions(book(''), 'v3')).not.toThrow()
    expect(() => spineDimensions(book('名'.repeat(200)), 'v3')).not.toThrow()
    expect(spineDimensions(book('名'.repeat(200)), 'v3').w).toBeLessThan(52)
  })

  it('字号永远不低于 10px（书脊窄，再小就读不出来）', () => {
    for (const title of ['一', '重生之我在异世界当咸鱼王', '名'.repeat(60)]) {
      expect(spineDimensions(book(title), 'v3').titlePx).toBeGreaterThanOrEqual(10)
    }
  })
})

describe('v2 书脊 · 分家', () => {
  it('v2 的尺寸逐像素不变（含新增字段的默认值）', () => {
    const dim = spineDimensions(book('长夜将明'), 'v2')
    // 200000 字 → pages 400 → spineMm 26.6
    expect(dim.w).toBe(24)
    expect(dim.h).toBe(208 + 11)
    expect(dim.depth).toBe(6 + 3)
    expect(dim.titlePx).toBe(12)
    expect(dim.titleColumns).toBe(1)
  })

  it('v1 与不传版本时都走 v2 那套', () => {
    const v1 = spineDimensions(book('长夜将明'), 'v1')
    const fallback = spineDimensions(book('长夜将明'))
    expect(v1).toEqual(fallback)
  })

  it('长书名在 v2 下不触发加宽（v2 的书脊本来就够宽）', () => {
    const dim = spineDimensions(book('我在无限流里当咸鱼的那些日子'), 'v2')
    expect(dim.w).toBeLessThanOrEqual(30)
  })
})
