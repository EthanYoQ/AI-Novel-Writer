import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'
import {
  FIGURE_HEIGHT,
  FIGURE_WIDTH,
  PlateChecks,
  PlateLibrary,
  PlateThreads,
  PlateTicks,
} from '../magazine/PlateFigures'

/**
 * 数据图形 · 契约测试。
 *
 * 这三个图形不是装饰，是各页「最该被看见的那件事」——所以它们必须**诚实**：
 *   · 没有数据就画空态，不许凭空长出方块
 *   · 数量对得上（几项画几个）
 *   · 状态对得上（伏笔五种状态的线型各不相同）
 *   · 尺寸统一（168×66，与关系缩略网同高，数据行才能横向对齐）
 */
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

const svg = () => container.querySelector('svg') as SVGSVGElement

beforeEach(async () => {
  await page.viewport(1200, 800)
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const name of ['data-mag', 'data-ui', 'data-v2-theme']) {
    document.documentElement.removeAttribute(name)
  }
})

describe('三个图形共同的规矩', () => {
  it('尺寸统一 168×66 —— 与关系缩略网同高，数据行才对齐', async () => {
    await render(<PlateTicks items={[{ label: '甲', value: 3 }]} />)
    expect(svg().getAttribute('viewBox')).toBe(`0 0 ${FIGURE_WIDTH} ${FIGURE_HEIGHT}`)
    expect(svg().getAttribute('width')).toBe(String(FIGURE_WIDTH))
    expect(svg().getAttribute('height')).toBe(String(FIGURE_HEIGHT))
  })

  it('每个图形都带可读的 aria-label（读屏用户也要知道画的是什么）', async () => {
    await render(<PlateTicks items={[{ label: '地理', value: 4 }]} />)
    expect(svg().getAttribute('aria-label')).toContain('地理 4')
  })
})

describe('PlateTicks · 竖刻线读数量', () => {
  it('几项画几根，值为 0 的不画（没有的东西不占版面）', async () => {
    await render(
      <PlateTicks items={[
        { label: '甲', value: 5 },
        { label: '乙', value: 2 },
        { label: '丙', value: 0 },
      ]} />,
    )
    const ticks = container.querySelectorAll('.mp-fig-tick')
    expect(ticks).toHaveLength(2)
  })

  it('最高的那根用满色点出来（一眼找到多数派）', async () => {
    await render(
      <PlateTicks items={[{ label: '甲', value: 5 }, { label: '乙', value: 2 }]} />,
    )
    const peaks = container.querySelectorAll('.mp-fig-tick.is-peak')
    expect(peaks).toHaveLength(1)
    // 高度确实比另一根高
    const heights = Array.from(container.querySelectorAll('.mp-fig-tick'))
      .map((node) => Number(node.getAttribute('height')))
    expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights))
  })

  it('没有任何数据：只留一条基线，不画假的块', async () => {
    await render(<PlateTicks items={[]} />)
    expect(container.querySelectorAll('.mp-fig-tick')).toHaveLength(0)
    expect(container.querySelectorAll('.mp-fig-base')).toHaveLength(1)
    expect(svg().getAttribute('aria-label')).toBe('暂无数据')
  })
})

describe('PlateChecks · 方格读完成度', () => {
  it('几项画几个格，已定的带 is-done', async () => {
    await render(
      <PlateChecks items={[
        { label: '题材', done: true },
        { label: '大纲', done: false },
        { label: '世界观', done: true },
      ]} />,
    )
    expect(container.querySelectorAll('.mp-fig-check')).toHaveLength(3)
    expect(container.querySelectorAll('.mp-fig-check.is-done')).toHaveLength(2)
  })

  it('读数说清楚「已定几项、共几项」', async () => {
    await render(
      <PlateChecks items={[{ label: '甲', done: true }, { label: '乙', done: false }]} />,
    )
    expect(svg().getAttribute('aria-label')).toBe('已定 1 项，共 2 项')
  })
})

describe('PlateLibrary · 文献结构（文档 → 切片）', () => {
  it('有几份资料画几个方块，有几片就画几根刻线', async () => {
    await render(<PlateLibrary documents={4} chunks={12} />)
    expect(container.querySelectorAll('.mp-fig-doc')).toHaveLength(4)
    expect(container.querySelectorAll('.mp-fig-chunk')).toHaveLength(12)
  })

  it('超出上限的部分收成一行「+N」，图里不挤成一片', async () => {
    await render(<PlateLibrary documents={20} chunks={900} documentLimit={6} chunkLimit={26} />)
    expect(container.querySelectorAll('.mp-fig-doc')).toHaveLength(6)
    expect(container.querySelectorAll('.mp-fig-chunk')).toHaveLength(26)
    const more = Array.from(container.querySelectorAll('.mp-fig-more')).map((node) => node.textContent)
    expect(more).toContain('+14')
    expect(more).toContain('+874')
  })

  it('切片一律等高 —— 它们本来就被切成等长，画成高低起伏是骗人', async () => {
    await render(<PlateLibrary documents={3} chunks={8} />)
    const heights = new Set(
      Array.from(container.querySelectorAll('.mp-fig-chunk')).map((node) => node.getAttribute('height')),
    )
    expect(heights.size).toBe(1)
  })

  it('空库：只留那条引线，一个方块一根刻线都不画', async () => {
    await render(<PlateLibrary documents={0} chunks={0} />)
    expect(container.querySelectorAll('.mp-fig-doc')).toHaveLength(0)
    expect(container.querySelectorAll('.mp-fig-chunk')).toHaveLength(0)
    expect(svg().getAttribute('aria-label')).toBe('0 份资料切成 0 个语义切片')
  })

  it('资料没超上限时不显示「+N」', async () => {
    await render(<PlateLibrary documents={6} chunks={10} documentLimit={6} chunkLimit={26} />)
    expect(container.querySelectorAll('.mp-fig-more')).toHaveLength(0)
  })
})

describe('PlateThreads · 线型读状态', () => {
  it('五种状态各有自己的类名 —— 已收 / 推进 / 已埋 / 计划 / 弃置一眼可分', async () => {
    await render(
      <PlateThreads threads={[
        { label: '已收的', state: 'resolved' },
        { label: '推进中的', state: 'progressing' },
        { label: '已埋的', state: 'planted' },
        { label: '计划中的', state: 'planned' },
        { label: '弃置的', state: 'abandoned' },
      ]} />,
    )
    for (const state of ['resolved', 'progressing', 'planted', 'planned', 'abandoned']) {
      expect(container.querySelectorAll(`.mp-fig-thread.is-${state}`)).toHaveLength(1)
    }
  })

  it('超过上限的伏笔截断（图里不挤成一片，其余留给读数文字）', async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      label: `伏笔 ${index}`,
      state: 'planned' as const,
    }))
    await render(<PlateThreads threads={many} limit={12} />)
    expect(container.querySelectorAll('.mp-fig-thread')).toHaveLength(12)
  })

  it('一条伏笔都没有：只画主线', async () => {
    await render(<PlateThreads threads={[]} />)
    expect(container.querySelectorAll('.mp-fig-thread')).toHaveLength(0)
    expect(container.querySelectorAll('.mp-fig-thread-line')).toHaveLength(1)
    expect(svg().getAttribute('aria-label')).toBe('暂无伏笔')
  })
})
