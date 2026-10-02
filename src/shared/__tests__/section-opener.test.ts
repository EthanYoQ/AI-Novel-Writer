/**
 * 栏目元数据表 · 契约测试。
 *
 * 这张表是「栏目 → 编号 / 名称 / 颜色」的唯一来源，而书脊的
 * `nth-child(n)` 编号与 `--mag-sec-n` 色标是**照它的顺序硬编码**在 CSS 里的。
 * 顺序一旦在表里被改动而不动书脊，编号与颜色就会错位 —— 这里把两者锁在一起。
 *
 * 它同时驱动栏目**背景**（编辑区底色 / 巨号水印 / 左缘色带）与切栏目那一道
 * **扫线**，所以下面也验了「底色、水印、扫线的取值口径」。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SECTION_COUNT,
  SECTION_ORDER,
  SECTION_SWEEP_MS,
  SECTIONS,
  sectionForRail,
  shouldPlaySectionSweep,
} from '../section-opener'

const spineSource = readFileSync(
  resolve(process.cwd(), 'src/components/layout/v2/SpineNav.tsx'),
  'utf8',
)

/**
 * 书脊的**主导航**部分（任务 / 日志 / 模型那三个工具按钮之前的那一段）。
 *
 * 只取前半段是刻意的：工具按钮同样调 goRail 之外的动作，但它们不是栏目，
 * 不该出现在栏目顺序里 —— 契约的边界就是这里。
 */
const spineMainSource = spineSource.slice(0, spineSource.indexOf('const bottomItems'))

/** 从书脊源码里按出现顺序取出栏目键、中文名、英文名。 */
function spineEntries(): Array<{ key: string; zh: string; en: string }> {
  return [...spineMainSource.matchAll(
    /key: '([^']+)',\s*icon: \w+,\s*zh: '([^']+)',\s*en: '([^']+)'/g,
  )].map((match) => ({ key: match[1], zh: match[2], en: match[3] }))
}

describe('栏目表 · 结构', () => {
  it('七个创作栏目各有一份元数据，键与表内 key 自洽', () => {
    expect(SECTION_ORDER).toHaveLength(7)
    expect(SECTION_COUNT).toBe(7)
    for (const key of SECTION_ORDER) {
      expect(SECTIONS[key].key).toBe(key)
    }
    expect(Object.keys(SECTIONS).sort()).toEqual([...SECTION_ORDER].sort())
  })

  it('刊内编号按顺序 01–07，不跳号不重复', () => {
    expect(SECTION_ORDER.map((key) => SECTIONS[key].no))
      .toEqual(['01', '02', '03', '04', '05', '06', '07'])
  })

  it('栏目色标按顺序 1–7 —— 与 mag-palette.css 的 --mag-sec-N 一一对应', () => {
    expect(SECTION_ORDER.map((key) => SECTIONS[key].mark)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('每栏都有中英定位句（开篇页标题下压的那行小字）', () => {
    for (const key of SECTION_ORDER) {
      expect(SECTIONS[key].zhLede.length).toBeGreaterThan(0)
      expect(SECTIONS[key].enLede.length).toBeGreaterThan(0)
    }
  })
})

describe('栏目表 · 与书脊的契约', () => {
  it('表内顺序 = 书脊按钮顺序（nth-child 编号与色标靠它对齐）', () => {
    expect(spineEntries().map((entry) => entry.key)).toEqual([...SECTION_ORDER])
  })

  it('栏目中英名与书脊完全一致 —— 开篇页不许给栏目另起名字', () => {
    for (const entry of spineEntries()) {
      expect(SECTIONS[entry.key as keyof typeof SECTIONS].zh).toBe(entry.zh)
      expect(SECTIONS[entry.key as keyof typeof SECTIONS].en).toBe(entry.en)
    }
  })
})

describe('栏目背景 · 取色口径', () => {
  it('书脊高亮项能换出栏目元数据', () => {
    expect(sectionForRail('characters')?.no).toBe('03')
    expect(sectionForRail('characters')?.mark).toBe(3)
    expect(sectionForRail('knowledge')?.no).toBe('07')
  })

  it('工具区不是栏目：任务 / 日志 / 模型 / 设置一律没有颜色', () => {
    for (const tool of ['tasks', 'log', 'models', 'settings']) {
      expect(sectionForRail(tool)).toBeNull()
    }
  })
})

describe('扫线 · 该不该播', () => {
  const base = { magazine: true, hasProject: true, sameButton: false }

  it('v3 + 已打开作品 + 真的换了栏目 → 扫', () => {
    expect(shouldPlaySectionSweep(base)).toBe(true)
  })

  it('v2 / v1 一律不扫（墨纸书斋与经典界面逐像素不变）', () => {
    expect(shouldPlaySectionSweep({ ...base, magazine: false })).toBe(false)
  })

  it('还没打开作品时不扫 —— 那时正文栏并不换页，扫线会与眼前的书架错位', () => {
    expect(shouldPlaySectionSweep({ ...base, hasProject: false })).toBe(false)
  })

  it('同一个按钮的第二次点击不扫 —— 那是折叠侧栏，不是切栏目', () => {
    expect(shouldPlaySectionSweep({ ...base, sameButton: true })).toBe(false)
  })
})

describe('扫线 · 时长与动画同源', () => {
  const backdropCss = readFileSync(
    resolve(process.cwd(), 'src/styles/magazine/mag-backdrop.css'),
    'utf8',
  )

  it('CSS 的扫线动画是 300ms，React 的摘节点余量比它大（不抢在动画中间收走）', () => {
    const sweepMs = Number(backdropCss.match(/animation:\s*mag-sweep\s+(\d+)ms/)?.[1])
    expect(sweepMs).toBe(300)
    expect(SECTION_SWEEP_MS).toBeGreaterThan(sweepMs)
  })

  it('栏目背景是常驻的：底色过渡在 200ms 一档，不能是慢过场', () => {
    const transition = backdropCss.match(
      /\.editor\[data-sec\]\s*\{[\s\S]*?transition:\s*background-color\s+(\d+)ms/,
    )?.[1]
    expect(Number(transition)).toBeLessThanOrEqual(240)
  })
})
