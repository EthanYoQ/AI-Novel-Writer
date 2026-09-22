import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useUiVersionStore } from '../../../../stores/ui-version-store'
import { SECTION_ORDER } from '../../../../shared/section-opener'
import PagePlate from '../magazine/PagePlate'
import SectionSigil from '../magazine/SectionSigil'

/**
 * 页面铭牌 · 真渲染契约（v3「时尚杂志」）。
 *
 * 这一层是全站页头的**总入口**（页面级页头一律走 PagePlate），所以两件事必须钉死：
 *
 *   ① **分家**：v3 渲染铭牌，v2 渲染旧的 `.pagehead` —— 一个字符都不许串
 *   ② **七徽记**：七个栏目各一个手绘 SVG（先生：「都不敢自己做点 SVG 效果」），
 *      图形必须两两不同，而且取当前栏目色 —— 徽记跟版面同色是这套版式的骨架
 */
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLocaleState = useLocaleStore.getState()

let container: HTMLDivElement
let root: Root

function plateProps(overrides: Record<string, unknown> = {}) {
  return {
    kicker: 'CAST · 人物档案',
    title: '人物档案',
    description: '档案、关系，以及他们彼此没说出口的部分',
    ...overrides,
  }
}

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

beforeEach(async () => {
  await page.viewport(1200, 800)
  useLocaleStore.setState({ ...originalLocaleState, locale: 'zh-CN', initialized: true })
  useUiVersionStore.setState({ uiVersion: 'v3' })

  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  container = document.createElement('div')
  container.style.width = '1000px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  /**
   * 全局 store 必须还原 —— 浏览器测试是同一实例顺序跑所有文件，
   * 留着 v3 会让后面的文件全部在 v3 下运行（实测会凭空多出几个失败）。
   */
  useUiVersionStore.setState({ uiVersion: 'v2' })
  useLocaleStore.setState(originalLocaleState)
  for (const name of ['data-mag', 'data-ui', 'data-v2-theme']) {
    document.documentElement.removeAttribute(name)
  }
})

describe('页面铭牌 · 版式', () => {
  it('竖排栏目名 + 徽记 + 大标题 + 定位句，四件都在', async () => {
    await render(<PagePlate {...plateProps({ section: 'characters' })} />)

    expect(container.querySelector('.mag-plate')).not.toBeNull()
    // 竖排栏目名取英文栏目名（与书脊同一份栏目表）
    const spine = container.querySelector('.mag-plate .mp-spine') as HTMLElement
    expect(spine.textContent).toBe('CAST')
    expect(getComputedStyle(spine).writingMode).toContain('vertical')
    // 徽记是自绘 SVG，不是图标库
    expect(container.querySelector('.mp-sigil svg')).not.toBeNull()
    expect(container.querySelector('.mag-plate .mp-name')?.textContent).toBe('人物档案')
    expect(container.querySelector('.mag-plate .mp-lede')?.textContent)
      .toBe('档案、关系，以及他们彼此没说出口的部分')
  })

  it('期刊化读数：右侧一枚大数字', async () => {
    await render(
      <PagePlate
        {...plateProps({ section: 'blueprint', metric: { label: '章', value: '07' } })}
      />,
    )
    const value = container.querySelector('.mag-plate .mp-chapter-no') as HTMLElement
    expect(value.textContent).toBe('07')
    expect(parseFloat(getComputedStyle(value).fontSize)).toBeGreaterThanOrEqual(36)
  })

  it('操作组仍在（换版式不许顺手换功能）', async () => {
    await render(
      <PagePlate
        {...plateProps({ section: 'characters', actions: <button type="button">编辑档案</button> })}
      />,
    )
    expect(container.querySelector('.mp-actions button')?.textContent).toBe('编辑档案')
  })
})

describe('七栏目徽记', () => {
  it('七个栏目各画一个，图形两两不同', async () => {
    const drawn: string[] = []
    for (const section of SECTION_ORDER) {
      await render(
        <div className="editor" data-sec="3">
          <SectionSigil section={section} />
        </div>,
      )
      const svg = container.querySelector('svg') as SVGElement
      expect(svg).not.toBeNull()
      expect(svg.getAttribute('viewBox')).toBe('0 0 26 26')
      drawn.push(svg.innerHTML)
    }
    expect(drawn).toHaveLength(7)
    expect(new Set(drawn).size).toBe(7)
  })

  it('徽记取当前栏目色 —— 与背景、色带是同一个值', async () => {
    await render(
      <div className="editor" data-sec="5">
        <SectionSigil section="plot-tree" />
      </div>,
    )
    const node = container.querySelector('.mp-sigil-node.is-lead') as SVGElement
    // --mag-sec-5 是「伏笔」的藕紫 #7A5B7E
    expect(getComputedStyle(node).fill).toBe('rgb(122, 91, 126)')
  })
})

describe('页面铭牌 · 分家', () => {
  it('v2 墨纸书斋：渲染旧 PageHead，一个铭牌节点都不出现', async () => {
    useUiVersionStore.setState({ uiVersion: 'v2' })
    await render(<PagePlate {...plateProps({ section: 'characters' })} />)

    expect(container.querySelector('.pagehead')).not.toBeNull()
    expect(container.querySelector('.mag-plate')).toBeNull()
    expect(container.querySelector('.mp-spine')).toBeNull()
  })

  it('v3：反过来 —— 旧 .pagehead 一个节点都不出现', async () => {
    await render(<PagePlate {...plateProps({ section: 'characters' })} />)

    expect(container.querySelector('.mag-plate')).not.toBeNull()
    expect(container.querySelector('.pagehead')).toBeNull()
  })
})
