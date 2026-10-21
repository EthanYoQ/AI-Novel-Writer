import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { ChevronDown } from 'lucide-react'
import { Button } from '../../ui/Button'
import { withReducedMotion } from '../../ui/__tests__/reduced-motion'
import { ProgressRing } from '../ProgressRing'
import StageTabs from '../StageTabs'
import StageTopBar from '../StageTopBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

async function mount(element: ReactElement) {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
  return host
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

/** 返回一个函数：截 element 的图，数接近 --accent 的像素（每通道差之和不超过 60）。 */
function accentPixels(element: HTMLElement) {
  const probe = document.createElement('span')
  probe.style.color = 'var(--accent)'
  element.append(probe)
  const [r, g, b] = getComputedStyle(probe).color.match(/\d+/g)!.map(Number)
  probe.remove()
  return async () => {
    const base64 = await page.screenshot({ element, save: false })
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    let count = 0
    for (let index = 0; index < data.length; index += 4) {
      if (Math.abs(data[index] - r) + Math.abs(data[index + 1] - g) + Math.abs(data[index + 2] - b) <= 60) count++
    }
    return count
  }
}

const tab = (fields: Partial<EditorTab> & Pick<EditorTab, 'id' | 'type' | 'name'>): EditorTab => ({ projectKey: 'C:\\novels\\visual', ...fields })

describe('新外壳的外观细节', () => {
  it('外壳里的纸墨按钮保留自己的字号与字重，不被外壳按钮的字体重置压掉', async () => {
    const container = await mount(<Button variant="secondary" size="sm">继续编辑</Button>)
    const style = getComputedStyle(container.querySelector('button')!)
    expect([style.fontSize, style.fontWeight]).toEqual(['12px', '500'])
  })

  it('阶段与资料页的标签用流程脊上的名字；正文与恢复草稿沿用自己的名字', async () => {
    const tabs = [
      tab({ id: 'config', type: 'config', name: '小说配置' }),
      tab({ id: 'world', type: 'world-building', name: '故事架构' }),
      tab({ id: 'cards', type: 'chapter-card', name: '章节蓝图' }),
      tab({ id: 'plot', type: 'narrative-thread', name: '剧情树与叙事线索' }),
      tab({ id: 'draft', type: 'chapter', name: '第 3 章 · 雾钟' }),
      tab({ id: 'recovery', type: 'chapter-card', name: '蓝图恢复草稿', planningRecovery: {} as EditorTab['planningRecovery'] }),
    ]
    const container = await mount(<StageTabs tabs={tabs} activeTabId="draft" onSelect={() => undefined} onClose={() => undefined}
      tabDomId={id => `tab-${id}`} panelId="panel" />)
    expect([...container.querySelectorAll('[role="tab"]')].map(node => node.textContent))
      .toEqual(['设定', '架构', '蓝图', '剧情与伏笔', '第 3 章 · 雾钟', '蓝图恢复草稿'])
    expect(container.querySelector('[aria-label^="关闭「设定」"]')).not.toBeNull()
  })

  it('顶栏的沉浸写作开关与退出按钮用按钮原语', async () => {
    const container = await mount(<StageTopBar crumbs={['正文']} library={false} focus={false} focusTitle={{ title: '' }} workMenu={[]} onToggleFocus={() => undefined} />)
    expect(container.querySelector('[aria-label="进入沉浸写作"]')?.className).toContain('pi-btn--icon')
    await act(async () => root!.render(<StageTopBar crumbs={[]} library={false} focus focusTitle={{ chapter: 3, title: '雾钟' }} workMenu={[]} onToggleFocus={() => undefined} />))
    expect(container.querySelector('[aria-label="退出沉浸写作"]')?.className).toContain('pi-btn--secondary')
  })

  it('顶栏作品名被省略号截断时，悬停能看到全名', async () => {
    const restore = useProjectStore.getState()
    const name = '雾钟每晚提前一刻响起'.repeat(8)
    useProjectStore.setState({ currentProject: { id: 'long', sessionLease: 'l', name, path: 'C:/novels/long', novelConfig: {} } as unknown as ProjectData })
    const container = await mount(<div style={{ width: 1024 }}><StageTopBar crumbs={[]} library={false} focus={false} focusTitle={{ title: '' }} workMenu={[]} onToggleFocus={() => undefined} /></div>)
    expect(container.querySelector('.stage-work-name')?.getAttribute('title')).toBe(name)
    useProjectStore.setState(restore, true)
  })

  it('顶栏的保存状态只看这部作品：别的作品留着的未保存草稿不算', async () => {
    const restore = [useEditorStore.getState(), useProjectStore.getState()] as const
    const here = 'C:\\novels\\here'
    useProjectStore.setState({ currentProject: { id: 'here', sessionLease: 'l', name: '这里', path: here, novelConfig: {} } as unknown as ProjectData })
    useEditorStore.setState({ draftLedgers: {}, activeTabId: null, tabs: [tab({ id: 'other', type: 'chapter', name: '别处', projectKey: 'C:\\novels\\elsewhere', dirty: true })] })
    const container = await mount(<StageTopBar crumbs={[]} library={false} focus={false} focusTitle={{ title: '' }} workMenu={[]} onToggleFocus={() => undefined} />)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('已保存')
    await act(async () => useEditorStore.setState(state => ({ tabs: [...state.tabs, tab({ id: 'mine', type: 'chapter', name: '这里', projectKey: here, dirty: true })] })))
    expect(container.querySelector('[role="status"]')?.textContent).toBe('未保存')
    useEditorStore.setState(restore[0], true)
    useProjectStore.setState(restore[1], true)
  })

  it('Tab 到激活标签时焦点环套住整个标签（含关闭按钮），画在标签内侧，离开底边接缝；鼠标点标签不出环', async () => {
    const tabs = [tab({ id: 'a', type: 'chapter', name: '第 1 章' }), tab({ id: 'b', type: 'chapter', name: '第 2 章' })]
    const container = await mount(<StageTabs tabs={tabs} activeTabId="b" onSelect={() => undefined} onClose={() => undefined} tabDomId={id => `tab-${id}`} panelId="panel" />)
    await userEvent.tab()
    const label = container.querySelector<HTMLElement>('#tab-b')!
    const whole = label.parentElement!
    expect(document.activeElement).toBe(label)
    expect([getComputedStyle(label).boxShadow, getComputedStyle(label).outlineStyle]).toEqual(['none', 'none'])
    const ring = getComputedStyle(whole, '::after')
    expect([ring.borderTopColor, ring.borderTopWidth, ring.borderBottomWidth]).toEqual(['rgb(44, 74, 140)', '2px', '2px'])
    const box = whole.getBoundingClientRect()
    const inset = [ring.top, ring.right, ring.bottom, ring.left].map(parseFloat)
    const close = whole.querySelector('.stage-tab-close')!.getBoundingClientRect()
    expect(inset).toEqual([2, 2, 3, 2])
    expect(close.right).toBeLessThanOrEqual(box.right - inset[1] - 2)
    expect(label.getBoundingClientRect().left).toBe(box.left)

    const other = container.querySelector<HTMLElement>('#tab-a')!
    await userEvent.click(other)
    expect(document.activeElement).toBe(other)
    expect(getComputedStyle(other.parentElement!, '::after').content).toBe('none')
  })

  it('Tab 到选中的书与当前章规划行时，焦点环叠在选中态之上，与只选中时看得出不同', async () => {
    const container = await mount(
      <div>
        <div className="stage-book" data-tone="paper" data-selected=""><button type="button" className="stage-book-cover">灯塔</button></div>
        <button type="button" className="stage-bp-plan-item" aria-current="true">雾钟</button>
      </div>,
    )
    const book = container.querySelector<HTMLElement>('.stage-book-cover')!
    const row = container.querySelector<HTMLElement>('.stage-bp-plan-item')!
    const resting = [getComputedStyle(book).boxShadow, getComputedStyle(row).boxShadow]
    await userEvent.tab()
    expect(document.activeElement).toBe(book)
    const focusedBook = getComputedStyle(book).boxShadow
    await userEvent.tab()
    expect(document.activeElement).toBe(row)
    const focusedRow = getComputedStyle(row).boxShadow
    expect([focusedBook === resting[0], focusedRow === resting[1]]).toEqual([false, false])
  })

  it('章节规划行聚焦时整圈焦点环都画得出来（行在 content-visibility 的列表项里，环在行外会被裁得只剩四角），当前章只选中时没有这圈环', async () => {
    const container = await mount(
      <aside className="stage-bp-plan" style={{ height: 300 }}>
        <ol className="stage-bp-plan-list">
          <li><button type="button" className="stage-bp-plan-item" aria-current="true"><span className="stage-bp-plan-no">3</span><span className="stage-bp-plan-name">雾钟</span></button></li>
          <li><button type="button" className="stage-bp-plan-item"><span className="stage-bp-plan-no">4</span><span className="stage-bp-plan-name">守塔人</span></button></li>
        </ol>
      </aside>,
    )
    const [current, other] = container.querySelectorAll<HTMLElement>('.stage-bp-plan-item')
    const accent = accentPixels(container)
    // 截图按测试页缩放，像素数不是固定值：拿同一时刻去掉列表项 content-visibility（不裁）的截图当整圈的参照
    const ringShown = async () => {
      const shown = await accent()
      container.querySelectorAll('li').forEach(item => { item.style.contentVisibility = 'visible' })
      const unclipped = await accent()
      container.querySelectorAll('li').forEach(item => { item.style.contentVisibility = '' })
      return { shown, unclipped }
    }
    const resting = await accent()
    await userEvent.tab()
    expect(document.activeElement).toBe(current)
    const onCurrent = await ringShown()
    await userEvent.tab()
    expect(document.activeElement).toBe(other)
    const onOther = await ringShown()
    const whole = ({ shown, unclipped }: { shown: number; unclipped: number }) => shown >= unclipped * 0.95 && unclipped - resting > 200
    expect([whole(onCurrent), whole(onOther), resting < 20], JSON.stringify({ resting, onCurrent, onOther })).toEqual([true, true, true])
  })

  it('旧面板用旧按钮做的标签页：选中的那个除了强调色边线，底边还有一道强调色线，不只靠颜色区分', async () => {
    const container = await mount(
      <div role="tablist" aria-label="剧情编辑器视图">
        <Button size="sm" variant="default" role="tab" aria-selected>剧情树</Button>
        <Button size="sm" variant="outline" role="tab" aria-selected={false}>计划清单</Button>
      </div>,
    )
    const [selected, other] = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map(tab => getComputedStyle(tab).boxShadow)
    const accent = getComputedStyle(container.querySelector('[role="tab"]')!).borderTopColor
    expect([selected.includes(`${accent} 0px -2px 0px 0px inset`), other.includes('-2px 0px 0px inset')]).toEqual([true, false])
  })

  it('鼠标停在书房起步卡上再按 Tab 聚焦它，焦点环仍画得出来，不被悬停样式盖掉', async () => {
    const container = await mount(
      <div className="stage-library">
        <button type="button" className="stage-start">新建作品</button>
      </div>,
    )
    const start = container.querySelector<HTMLElement>('.stage-start')!
    await userEvent.hover(start)
    await userEvent.tab()
    expect(document.activeElement).toBe(start)
    expect(getComputedStyle(start).boxShadow).toContain('rgb(44, 74, 140) 0px 0px 0px 4px')
  })

  it('减少动态效果时书封悬停仍有反馈：不抬起，但投影变了', async () => {
    await withReducedMotion(async () => {
      const container = await mount(
        <div style={{ display: 'flex', gap: 40 }}>
          <button type="button">别处</button>
          <div className="stage-book" data-tone="paper" style={{ width: 120 }}><button type="button" className="stage-book-cover">灯塔</button></div>
        </div>,
      )
      const cover = container.querySelector<HTMLElement>('.stage-book-cover')!
      // 指针可能还停在上一条用例留下的位置，先挪到别处
      await userEvent.hover(page.getByRole('button', { name: '别处' }))
      await new Promise(resolve => setTimeout(resolve, 300))
      const resting = getComputedStyle(cover).boxShadow
      await userEvent.hover(cover)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect([getComputedStyle(cover).transform, getComputedStyle(cover).boxShadow === resting]).toEqual(['none', false])
    })
  })

  it('外壳里的菜单项聚焦时是菜单自己的内侧环，不是压到相邻项上的外圈', async () => {
    const container = await mount(
      <div role="menu" aria-label="作品">
        <button type="button" role="menuitem" className="pi-menu-item">导出…</button>
        <button type="button" role="menuitem" className="pi-menu-item">回到书房</button>
      </div>,
    )
    await userEvent.tab()
    const item = container.querySelector<HTMLElement>('.pi-menu-item')!
    expect(document.activeElement).toBe(item)
    expect(getComputedStyle(item).boxShadow).toBe('rgb(44, 74, 140) 0px 0px 0px 2px inset')
  })

  it('拆分主按钮的下拉箭头居中，不吃图标加文字时的 2px 左移', async () => {
    const container = await mount(
      <Button variant="primary" className="pi-split-toggle" aria-label="本次写作选项"><ChevronDown size={14} aria-hidden /></Button>,
    )
    const button = container.querySelector('button')!.getBoundingClientRect()
    const icon = container.querySelector('svg')!.getBoundingClientRect()
    // 按钮与图标宽度奇偶不同时居中差半像素
    expect(Math.abs((icon.left + icon.right) / 2 - (button.left + button.right) / 2)).toBeLessThanOrEqual(0.5)
  })

  it('激活标签在标签条可视区外时滚进来', async () => {
    const tabs = Array.from({ length: 24 }, (_, index) => tab({ id: `t${index}`, type: 'chapter', name: `第 ${index + 1} 章 · 很长很长的章节名` }))
    const props = { tabs, onSelect: () => undefined, onClose: () => undefined, tabDomId: (id: string) => `tab-${id}`, panelId: 'panel' }
    const container = await mount(<div style={{ width: 640 }}><StageTabs {...props} activeTabId="t0" /></div>)
    const strip = container.querySelector<HTMLElement>('.stage-tabs')!
    const visible = (id: string) => {
      const box = strip.getBoundingClientRect()
      const rect = container.querySelector(`#tab-${id}`)!.parentElement!.getBoundingClientRect()
      return rect.left >= box.left - 1 && rect.right <= box.right + 1
    }
    expect(visible('t23')).toBe(false)
    await act(async () => root!.render(<div style={{ width: 640 }}><StageTabs {...props} activeTabId="t23" /></div>))
    expect(visible('t23')).toBe(true)
    await act(async () => root!.render(<div style={{ width: 640 }}><StageTabs {...props} activeTabId="t0" /></div>))
    expect(visible('t0')).toBe(true)
  })

  it('作品名很长时顶栏标题以省略号收尾，窗口按钮仍在视口内', async () => {
    await page.viewport(1024, 640)
    const restore = useProjectStore.getState()
    const name = '雾钟'.repeat(40)
    useProjectStore.setState({ currentProject: { id: 'long', sessionLease: 'l', name, path: 'C:\\novels\\long', novelConfig: {} } as unknown as ProjectData })
    try {
      const container = await mount(<div style={{ width: 1024 }}><StageTopBar crumbs={['正文', '第 3 章']} library={false} focus={false} focusTitle={{ title: '' }} workMenu={[]} onToggleFocus={() => undefined} /></div>)
      const close = page.getByRole('button', { name: '关闭', exact: true }).element().getBoundingClientRect()
      expect(close.right).toBeLessThanOrEqual(1024)
      const title = container.querySelector<HTMLElement>('.stage-work-name')!
      expect(title.textContent).toBe(name)
      expect(getComputedStyle(title).textOverflow).toBe('ellipsis')
      expect(title.scrollWidth).toBeGreaterThan(title.clientWidth)
    } finally {
      useProjectStore.setState(restore, true)
    }
  })

  it('进度环半径按画板取 size / 2 - stroke：流程脊 22 / 2.5 为 8.5，运行胶囊 18 / 2 为 7', async () => {
    const container = await mount(<><ProgressRing size={22} stroke={2.5} ratio={0.5} /><ProgressRing size={18} stroke={2} ratio={0.5} /></>)
    expect([...container.querySelectorAll('svg')].map(svg => svg.querySelector('circle')?.getAttribute('r'))).toEqual(['8.5', '7'])
  })
})
