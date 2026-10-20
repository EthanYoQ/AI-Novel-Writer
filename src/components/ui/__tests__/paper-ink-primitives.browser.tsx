import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, StrictMode, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page, userEvent } from 'vitest/browser'
import { Ellipsis } from 'lucide-react'

import '../../../index.css'
import { Button } from '../Button'
import { Check } from '../Check'
import { DangerConfirm } from '../DangerConfirm'
import { EmptyState } from '../EmptyState'
import { InlineConfirm } from '../InlineConfirm'
import { Lifecycle } from '../Lifecycle'
import { Menu } from '../Menu'
import { Notice } from '../Notice'
import { Popover } from '../Popover'
import { SegmentedControl } from '../SegmentedControl'
import { Sheet } from '../Sheet'
import { StatGrid } from '../StatGrid'
import { composite, contrast, luminance } from './color-contrast'
import { useAnchoredLayer } from '../use-anchored-layer'
import { withReducedMotion } from './reduced-motion'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHOTS = '../../../../.runtime/rd1-shots'
const ACCENT = { light: 'rgb(44, 74, 140)', dark: 'rgb(169, 190, 240)' }
const DANGER = { light: 'rgb(180, 35, 24)', dark: 'rgb(240, 138, 126)' }
const PRESS = {
  light: { primary: 'color(srgb 0.115922 0.196314 0.37851)', dangerSolid: 'color(srgb 0.545804 0.12502 0.0961569)', sink: 'rgba(23, 23, 26, 0.2)' },
  dark: { primary: 'color(srgb 0.567373 0.636549 0.80251)', dangerSolid: 'color(srgb 0.766275 0.446275 0.410196)', sink: 'rgba(0, 0, 0, 0.45)' },
}

let root: Root | undefined
let host: HTMLDivElement | undefined

async function mount(node: ReactNode, theme: 'light' | 'dark' = 'light') {
  host = document.createElement('div')
  host.className = 'paper-ink'
  host.dataset.theme = theme
  host.style.cssText = 'padding: 32px; min-height: 480px; width: 900px;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

const settle = () => act(async () => {})
const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, element: host! })
const focused = () => document.activeElement as HTMLElement
const finishAnimations = (element: Element) => Promise.all(element.getAnimations().map((animation) => animation.finished))

function tokenColor(scope: HTMLElement, name: string) {
  const probe = document.createElement('span')
  probe.style.color = `var(${name})`
  scope.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

/** 焦点环由令牌 --focus-ring 绘制：外圈为强调色。 */
function expectFocusRing(element: Element, theme: 'light' | 'dark' = 'light') {
  expect(getComputedStyle(element).boxShadow).toContain(ACCENT[theme])
}

beforeEach(async () => {
  await page.viewport(1000, 720)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('Button 纸墨六种', () => {
  const six = (
    <div style={{ display: 'flex', gap: 12 }}>
      <Button variant="primary">写作此章</Button>
      <Button variant="secondary">重新生成</Button>
      <Button variant="text">稍后</Button>
      <Button variant="danger">删除作品…</Button>
      <Button variant="danger-solid">永久删除</Button>
      <Button variant="icon" aria-label="更多操作"><Ellipsis size={16} aria-hidden /></Button>
    </div>
  )

  it.each(['light', 'dark'] as const)('%s 主题下六种按钮依次可 Tab 到达且焦点环可见', async (theme) => {
    const container = await mount(six, theme)
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((button) => button.className.match(/pi-btn--[\w-]+/)?.[0])).toEqual([
      'pi-btn--primary', 'pi-btn--secondary', 'pi-btn--text', 'pi-btn--danger', 'pi-btn--danger-solid', 'pi-btn--icon',
    ])
    for (const button of buttons) {
      await userEvent.tab()
      expect(focused()).toBe(button)
      expectFocusRing(button, theme)
    }
    expect(buttons.every((button) => button.type === 'button')).toBe(true)
    expect(buttons[5].getAttribute('aria-label')).toBe('更多操作')
    ;(document.activeElement as HTMLElement).blur()
    await shot(`rd1-buttons-${theme}`)
  })

  it('主按钮为黛蓝实心，危险按钮从不使用强调色且外形与主按钮不同', async () => {
    const container = await mount(six)
    const [primary, , , danger, dangerSolid] = [...container.querySelectorAll('button')].map((b) => getComputedStyle(b))
    expect(primary.backgroundColor).toBe(ACCENT.light)
    expect(danger.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(danger.color).toBe(DANGER.light)
    expect(danger.borderTopStyle).toBe('solid')
    expect(dangerSolid.backgroundColor).toBe(DANGER.light)
    expect([danger.color, danger.backgroundColor, dangerSolid.backgroundColor]).not.toContain(ACCENT.light)
  })

  it.each(['light', 'dark'] as const)('%s 主题正文与说明文字在外框、面板、悬停底、纸面上对比度都不低于 4.5:1，墨色仍分得出层级', async (theme) => {
    const container = await mount(<p>正文</p>, theme)
    const tokens = getComputedStyle(container)
    const value = (name: string) => tokenColor(container, name)
    for (const surface of ['--paper', '--surface', '--surface-2', '--frame']) {
      const [ink, ink2, ink3, ink4] = ['--ink', '--ink-2', '--ink-3', '--ink-4'].map((name) => contrast(value(name), value(surface)))
      expect(ink).toBeGreaterThanOrEqual(4.5)
      expect(ink2).toBeGreaterThanOrEqual(4.5)
      expect(ink3).toBeGreaterThanOrEqual(4.5)
      // 说明文字提亮后不能贴上次要文字，也不能和占位一样淡：相邻两级的对比度至少差 1.25 倍
      expect(ink / ink2).toBeGreaterThanOrEqual(1.25)
      expect(ink2 / ink3).toBeGreaterThanOrEqual(1.25)
      expect(ink3 / ink4).toBeGreaterThanOrEqual(1.25)
    }
    expect(contrast(value('--accent-ink'), value('--accent'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(value('--danger-ink'), value('--danger'))).toBeGreaterThanOrEqual(4.5)
    expect(tokens.color).toBe(value('--ink'))
  })

  it.each(['light', 'dark'] as const)('%s 主题禁用按钮是没上墨的平面：不透明、墨色薄雾底、撤掉受光', async (theme) => {
    const container = await mount(
      <div style={{ display: 'flex', gap: 12 }}>
        <Button variant="primary" disabled>写作此章</Button>
        <Button variant="secondary" disabled>重新生成</Button>
      </div>,
      theme,
    )
    for (const button of container.querySelectorAll('button')) {
      const style = getComputedStyle(button)
      expect(style.opacity).toBe('1')
      expect(style.backgroundColor).toBe(tokenColor(container, '--wash'))
      expect(style.backgroundImage).toBe('none')
      expect(style.color).toBe(tokenColor(container, '--ink-3'))
    }
  })

  it('主按钮与次按钮带 ≤2% 的纵向受光，危险按钮是平的', async () => {
    const container = await mount(six)
    const [primary, secondary, , danger, dangerSolid] = [...container.querySelectorAll('button')].map((b) => getComputedStyle(b))
    expect(primary.backgroundImage).toContain('linear-gradient')
    expect(secondary.backgroundImage).toContain('linear-gradient')
    for (const flat of [danger, dangerSolid]) {
      expect(flat.backgroundImage).toBe('none')
      expect(flat.boxShadow.match(/rgba?\([^)]*\)/g)!.every((color) => color === 'rgba(0, 0, 0, 0)')).toBe(true)
    }
  })

  it('主按钮悬停、次按钮按下时受光渐变与底色、投影同步过渡，不瞬切', async () => {
    const container = await mount(
      <div style={{ display: 'flex', gap: 12 }}>
        <Button variant="primary">写作此章</Button>
        <Button variant="secondary">重新生成</Button>
      </div>,
    )
    const [primary, secondary] = container.querySelectorAll('button')
    const midway = async (button: HTMLButtonElement, change: () => Promise<unknown>) => {
      const rest = getComputedStyle(button).backgroundImage
      await change()
      const transitions = button.getAnimations()
      expect(new Set(transitions.map((animation) => animation.effect!.getTiming().duration))).toEqual(new Set([140]))
      transitions.forEach((animation) => { animation.pause(); animation.currentTime = 70 })
      const middle = getComputedStyle(button).backgroundImage
      transitions.forEach((animation) => animation.finish())
      const end = getComputedStyle(button).backgroundImage
      expect(end).not.toBe(rest)
      expect(middle).not.toBe(end)
      expect(middle).not.toBe(rest)
    }
    await midway(primary, () => userEvent.hover(primary))
    secondary.focus()
    await midway(secondary, () => userEvent.keyboard('[Space>]'))
    await userEvent.keyboard('[/Space]')
  })

  it.each(['light', 'dark'] as const)('%s 主题指针停在按钮上按下：按下态压过悬停态，实心按钮比悬停更深，次按钮内凹', async (theme) => {
    const container = await mount(six, theme)
    const [primary, secondary, text, , dangerSolid, icon] = [...container.querySelectorAll('button')]
    const look = (button: HTMLButtonElement) => {
      button.getAnimations().forEach((animation) => animation.finish())
      const style = getComputedStyle(button)
      return { bg: style.backgroundColor, shadow: style.boxShadow }
    }
    const pressed = async (button: HTMLButtonElement) => {
      button.focus()
      await userEvent.keyboard('[Space>]')
      const state = look(button)
      await userEvent.keyboard('[/Space]')
      return state
    }
    for (const button of [primary, secondary, text, dangerSolid, icon]) {
      await userEvent.hover(container, { position: { x: 4, y: 4 } })
      const pressOnly = await pressed(button)
      await userEvent.hover(button)
      const hover = look(button)
      const hoverAndPress = await pressed(button)
      expect(hoverAndPress).toEqual(pressOnly)
      expect(hoverAndPress.bg).not.toBe(hover.bg)
    }
    const darker = async (button: HTMLButtonElement) => {
      await userEvent.hover(button)
      const hover = look(button)
      const press = await pressed(button)
      return luminance(press.bg) < luminance(hover.bg)
    }
    expect(await darker(primary)).toBe(true)
    expect(await darker(dangerSolid)).toBe(true)
    expect(await darker(secondary)).toBe(true)
    await userEvent.hover(primary)
    expect((await pressed(primary)).bg).toBe(PRESS[theme].primary)
    await userEvent.hover(dangerSolid)
    expect((await pressed(dangerSolid)).bg).toBe(PRESS[theme].dangerSolid)
    await userEvent.hover(secondary)
    expect((await pressed(secondary)).shadow).toContain(`${PRESS[theme].sink} 0px 2px 4px 0px inset`)
  })

  it('减少动态效果设置下按下不再下沉或缩小', async () => {
    const container = await mount(
      <div style={{ display: 'flex', gap: 12 }}>
        <Button variant="primary">写作此章</Button>
        <Button variant="secondary">重新生成</Button>
        <Button variant="icon" aria-label="更多"><Ellipsis aria-hidden /></Button>
      </div>,
    )
    const [primary, secondary, icon] = container.querySelectorAll('button')
    const pressedTransform = async (button: HTMLButtonElement) => {
      button.focus()
      await userEvent.keyboard('[Space>]')
      button.getAnimations().forEach((animation) => animation.finish())
      const transform = getComputedStyle(button).transform
      await userEvent.keyboard('[/Space]')
      return transform
    }
    expect(await pressedTransform(primary)).toBe('matrix(1, 0, 0, 1, 0, 1)')
    expect(await pressedTransform(icon)).toBe('matrix(0.96, 0, 0, 0.96, 0, 0)')
    await withReducedMotion(async () => {
      for (const button of [primary, secondary, icon]) expect(await pressedTransform(button)).toBe('none')
    })
  })

  it('加载中的按钮保留原样并在底沿画墨线', async () => {
    const container = await mount(<Button variant="primary" disabled aria-busy>保存中</Button>)
    const button = container.querySelector('button')!
    expect(getComputedStyle(button).backgroundColor).toBe(ACCENT.light)
    expect(getComputedStyle(button, '::after').animationName).toBe('pi-ink-draw')
  })

  it('加载中的按钮悬停不变色，墨线落在底沿 3px 内', async () => {
    const container = await mount(
      <div style={{ display: 'flex', gap: 12 }}>
        <Button variant="primary" disabled aria-busy>保存中</Button>
        <Button variant="secondary" size="sm" disabled aria-busy>导出中</Button>
      </div>,
    )
    const [primary, small] = container.querySelectorAll('button')
    await userEvent.hover(primary)
    primary.getAnimations().forEach((animation) => animation.finish())
    expect(getComputedStyle(primary).backgroundColor).toBe(ACCENT.light)
    expect(getComputedStyle(primary, '::after').bottom).toBe('3px')
    expect(getComputedStyle(small, '::after').bottom).toBe('2px')
  })

  it('英文界面下按钮字距收到 .01em', async () => {
    const container = await mount(<Button variant="primary">Write chapter</Button>)
    const button = container.querySelector('button')!
    const original = document.documentElement.lang
    try {
      document.documentElement.lang = 'zh-CN'
      expect(getComputedStyle(button).letterSpacing).toBe('0.65px')
      document.documentElement.lang = 'en-US'
      expect(getComputedStyle(button).letterSpacing).toBe('0.13px')
    } finally {
      document.documentElement.lang = original
    }
  })

  it('在新外壳里 Tab 到主按钮，焦点环与材质同时在 box-shadow 里', async () => {
    const container = await mount(<div className="stage-shell"><Button variant="primary">写作此章</Button></div>)
    await userEvent.tab()
    const shadow = getComputedStyle(focused()).boxShadow
    expect(shadow).toContain(ACCENT.light)
    expect(shadow).toContain(tokenColor(container, '--hi'))
  })

  it('拆分按钮主体禁用时整组退成未上墨，箭头仍可点', async () => {
    const onToggle = vi.fn()
    const container = await mount(
      <div className="pi-split pi-split--main-off">
        <Button variant="primary" className="pi-split-main" disabled>按 0 项意见修稿</Button>
        <Button variant="primary" className="pi-split-toggle" aria-label="更多修稿方式" onClick={onToggle}><Ellipsis aria-hidden /></Button>
      </div>,
    )
    const toggle = container.querySelector<HTMLButtonElement>('.pi-split-toggle')!
    expect(getComputedStyle(toggle).backgroundColor).toBe(tokenColor(container, '--wash'))
    expect(getComputedStyle(container.querySelector('.pi-split')!).boxShadow).toBe('none')
    await userEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('沿用旧变体名的调用方也画成纸墨按钮', async () => {
    const container = await mount(<Button variant="outline">旧按钮</Button>)
    expect(container.querySelector('button')!.className).toBe('pi-btn pi-btn--secondary pi-btn--sm')
  })
})

describe('Sheet', () => {
  function Harness({ onClose = () => {}, initiallyOpen = false }: { onClose?: () => void; initiallyOpen?: boolean }) {
    const [open, setOpen] = useState(initiallyOpen)
    const [tab, setTab] = useState('a')
    return (
      <div style={{ display: 'flex', gap: 16, height: 400, alignItems: 'flex-start' }}>
        <Button variant="secondary" onClick={() => setOpen(true)}>打开蓝图</Button>
        <Sheet
          open={open}
          title="第 4 章"
          subtitle="蓝图"
          closeLabel="关闭侧页"
          onClose={() => {
            onClose()
            setOpen(false)
          }}
          tabs={{ items: [{ id: 'a', label: '蓝图' }, { id: 'b', label: '要求' }, { id: 'c', label: '设定' }], active: tab, onChange: setTab }}
        >
          正文
        </Sheet>
        <Button variant="text">侧页之后</Button>
      </div>
    )
  }

  it('打开时焦点移到标题，Esc 或关闭按钮关闭后焦点回到打开它的按钮', async () => {
    const onClose = vi.fn()
    const container = await mount(<Harness onClose={onClose} />)
    const trigger = container.querySelector('button')!

    await userEvent.click(trigger)
    const sheet = container.querySelector('aside')!
    const heading = container.querySelector('h2')!
    expect(sheet.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(focused()).toBe(heading)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(container.querySelector('aside')).toBeNull()
    expect(focused()).toBe(trigger)

    await userEvent.keyboard('{Enter}')
    expect(focused()).toBe(container.querySelector('h2'))
    await userEvent.tab()
    expect(focused().getAttribute('aria-label')).toBe('关闭侧页')
    expectFocusRing(focused())
    await userEvent.keyboard('{Enter}')
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(focused()).toBe(trigger)

    await userEvent.click(trigger)
    await userEvent.click(page.getByText('正文'))
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(focused()).toBe(trigger)
  })

  it('StrictMode 下以打开状态挂载，关闭后焦点回到挂载前的元素', async () => {
    const outside = document.createElement('button')
    outside.textContent = '挂载前'
    document.body.append(outside)
    outside.focus()
    try {
      const container = await mount(<StrictMode><Harness initiallyOpen /></StrictMode>)
      expect(focused()).toBe(container.querySelector('h2'))
      await userEvent.keyboard('{Escape}')
      expect(container.querySelector('aside')).toBeNull()
      expect(focused()).toBe(outside)
    } finally {
      outside.remove()
    }
  })

  it('分页用方向键切换，只有当前分页在 Tab 顺序里，面板以当前分页命名', async () => {
    const container = await mount(<Harness initiallyOpen />)
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const panel = container.querySelector('[role="tabpanel"]')!
    const expectActive = (index: number) => {
      expect(focused()).toBe(tabs[index])
      expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(tabs.map((_, i) => String(i === index)))
      expect(tabs.map((tab) => tab.tabIndex)).toEqual(tabs.map((_, i) => (i === index ? 0 : -1)))
      expect(panel.getAttribute('aria-labelledby')).toBe(tabs[index].id)
      expect(tabs[index].getAttribute('aria-controls')).toBe(panel.id)
    }

    await userEvent.tab()
    await userEvent.tab()
    expect(focused()).toBe(tabs[0])
    expectFocusRing(tabs[0])
    // Tab 若走出测试文档，Shift+Tab 回到哪里取决于外层页面与浏览器，所以在侧页之后放一个可聚焦元素。
    await userEvent.tab()
    expect(focused()).toBe(page.getByRole('button', { name: '侧页之后' }).element())
    await userEvent.tab({ shift: true })
    expectActive(0)

    await userEvent.keyboard('{ArrowRight}')
    expectActive(1)
    await userEvent.keyboard('{End}')
    expectActive(2)
    await userEvent.keyboard('{ArrowRight}')
    expectActive(0)
    await userEvent.keyboard('{ArrowLeft}')
    expectActive(2)
    await userEvent.keyboard('{Home}')
    expectActive(0)
    await userEvent.keyboard('{ArrowRight}')
    await shot('rd1-sheet')
  })

  it.each(['light', 'dark'] as const)('%s 主题下分段页签的选中项 Tab 聚焦时焦点环叠在浮起的阴影上', async (theme) => {
    const container = await mount(
      <div style={{ display: 'flex', height: 400 }}>
        <Sheet open title="第 4 章" closeLabel="关闭侧页" onClose={() => {}}
          tabs={{ items: [{ id: 'a', label: '运行' }, { id: 'b', label: '诊断' }], active: 'a', onChange: () => {}, style: 'segmented' }}>
          正文
        </Sheet>
      </div>,
      theme,
    )
    const selected = container.querySelector<HTMLElement>('.pi-sheet-tab[aria-selected="true"]')!
    await userEvent.tab()
    await userEvent.tab()
    expect(focused()).toBe(selected)
    const paper = tokenColor(container, '--paper')
    const seg = { light: 'rgba(23, 23, 26, 0.12) 0px 1px 2px 0px', dark: 'rgba(0, 0, 0, 0.5) 0px 1px 2px 0px' }[theme]
    expect(getComputedStyle(selected).boxShadow).toBe(`${paper} 0px 0px 0px 2px, ${ACCENT[theme]} 0px 0px 0px 4px, ${seg}`)
  })

  it('滑入动画只在状态变化时出现，并在减少动态效果设置下关闭', async () => {
    const container = await mount(<Harness initiallyOpen />)
    expect(getComputedStyle(container.querySelector('aside')!).animationName).toBe('pi-sheet-in')
    const reducedRules = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules]
      } catch {
        return []
      }
    }).filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion: reduce'))
    const paperInkRule = reducedRules.flatMap((rule) => [...rule.cssRules] as CSSStyleRule[])
      .find((rule) => rule.selectorText?.includes('.paper-ink *'))
    expect(paperInkRule?.style.getPropertyValue('animation-name')).toBe('none')
    expect(paperInkRule?.style.getPropertyPriority('animation-name')).toBe('important')
  })
})

describe('Menu', () => {
  it('键盘打开并移动焦点，危险分组在分隔线之后且为危险色，Esc 关闭并把焦点还给触发按钮', async () => {
    const onDelete = vi.fn()
    const container = await mount(
      <div style={{ height: 300 }}>
        <Menu
          label="作品操作"
          icon={<Ellipsis size={16} aria-hidden />}
          groups={[
            { id: 'main', items: [{ id: 'rename', label: '重命名', onSelect: () => {} }, { id: 'export', label: '导出…', onSelect: () => {} }] },
            { id: 'danger', tone: 'danger', label: '危险操作', items: [{ id: 'delete', label: '删除作品…', onSelect: onDelete }] },
          ]}
        />
      </div>,
    )
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    expect(trigger.getAttribute('aria-label')).toBe('作品操作')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    await userEvent.tab()
    expect(focused()).toBe(trigger)
    expectFocusRing(trigger)
    await userEvent.keyboard('{Enter}')
    await settle()
    const menu = container.querySelector('[role="menu"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id)
    expect(focused().textContent).toBe('重命名')

    await userEvent.keyboard('{End}')
    const dangerItem = focused()
    expect(dangerItem.textContent).toBe('删除作品…')
    expect(getComputedStyle(dangerItem).color).toBe(DANGER.light)
    expect(dangerItem.closest('[role="group"]')!.previousElementSibling!.getAttribute('role')).toBe('separator')
    await shot('rd1-menu')

    await userEvent.keyboard('{ArrowDown}')
    expect(focused().textContent).toBe('重命名')
    await userEvent.keyboard('{Escape}')
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(focused()).toBe(trigger)

    await userEvent.keyboard('{ArrowDown}')
    await settle()
    await userEvent.keyboard('{ArrowUp}{Enter}')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(focused()).toBe(trigger)
  })
})

describe('危险分组里的禁用项', () => {
  it('悬停不显示危险底色，回到静止的未上墨样子', async () => {
    const container = await mount(
      <div style={{ height: 300 }}>
        <Menu
          label="作品操作"
          icon={<Ellipsis size={16} aria-hidden />}
          groups={[
            { id: 'main', items: [{ id: 'rename', label: '重命名', onSelect: () => {} }] },
            { id: 'danger', tone: 'danger', items: [{ id: 'delete', label: '删除作品…', disabled: true, onSelect: () => {} }] },
          ]}
        />
      </div>,
    )
    await userEvent.click(container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!)
    await settle()
    const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === '删除作品…')!
    expect(item.disabled).toBe(true)
    await userEvent.hover(item)
    expect(item.matches(':hover')).toBe(true)
    expect(getComputedStyle(item).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(item).color).toBe(tokenColor(container, '--ink-3'))
  })
})

describe('侧页内的菜单', () => {
  const onRename = vi.fn()
  const groups = [
    { id: 'main', items: [{ id: 'rename', label: '重命名', onSelect: onRename }, { id: 'export', label: '导出…', onSelect: () => {} }] },
    { id: 'danger', tone: 'danger' as const, label: '危险操作', items: [{ id: 'delete', label: '删除作品…', onSelect: () => {} }] },
  ]

  function Harness() {
    return (
      <div style={{ display: 'flex', height: 360, transform: 'translateZ(0)' }}>
        <Sheet open title="第 4 章" closeLabel="关闭侧页" onClose={() => {}}>
          <div style={{ height: 230, flex: 'none' }}>蓝图</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Menu label="段落操作" icon={<Ellipsis size={16} aria-hidden />} groups={groups} align="end" />
            <Button variant="text" size="sm">下一项</Button>
          </div>
          <div style={{ height: 400, flex: 'none' }}>更多内容</div>
        </Sheet>
      </div>
    )
  }

  async function openMenu(container: HTMLElement) {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    await finishAnimations(container.querySelector('aside')!)
    await act(async () => trigger.click())
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!
    await finishAnimations(menu)
    return { trigger, menu }
  }

  it('祖先带 transform 时菜单越过侧页滚动区下沿仍可见可点，且不撑出滚动条', async () => {
    const container = await mount(<Harness />)
    const body = container.querySelector<HTMLElement>('.pi-sheet-body')!
    const scrollHeight = body.scrollHeight
    const { trigger, menu } = await openMenu(container)

    const bodyRect = body.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const triggerRect = trigger.getBoundingClientRect()
    expect(menuRect.bottom).toBeGreaterThan(bodyRect.bottom)
    expect(menuRect.top).toBeCloseTo(triggerRect.bottom + 6, 0)
    expect(menuRect.left).toBe(8)
    expect(menuRect.right).toBeGreaterThan(triggerRect.right)
    const lastItem = page.getByRole('menuitem', { name: '删除作品…' }).element().getBoundingClientRect()
    expect(lastItem.top).toBeGreaterThan(bodyRect.bottom)
    expect(document.elementFromPoint(lastItem.left + lastItem.width / 2, lastItem.top + lastItem.height / 2)?.textContent).toBe('删除作品…')
    expect(body.scrollHeight).toBe(scrollHeight)
    expect(getComputedStyle(menu).backgroundColor).toBe(tokenColor(container, '--layer'))
    await shot('rd1-menu-in-sheet')

    await userEvent.click(page.getByRole('menuitem', { name: '重命名' }))
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('Esc 只关菜单不关侧页，焦点回到触发按钮；Tab 离开菜单后焦点到触发按钮的下一项', async () => {
    const container = await mount(<Harness />)
    const { trigger } = await openMenu(container)
    ;(container.querySelector('[role="menuitem"]') as HTMLElement).focus()
    await userEvent.keyboard('{Escape}')
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(container.querySelector('aside')).not.toBeNull()
    expect(focused()).toBe(trigger)

    await userEvent.keyboard('{ArrowDown}')
    await settle()
    expect(focused().getAttribute('role')).toBe('menuitem')
    await userEvent.tab()
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(focused().textContent).toBe('下一项')
    await userEvent.tab({ shift: true })
    expect(focused()).toBe(trigger)
  })

  it('鼠标打开菜单后焦点留在触发按钮，按 Tab 菜单关闭，焦点到下一项', async () => {
    const container = await mount(<Harness />)
    await finishAnimations(container.querySelector('aside')!)
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    await userEvent.click(trigger)
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    expect(focused()).toBe(trigger)
    await userEvent.tab()
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(focused().textContent).toBe('下一项')
  })

  it('菜单项多到视口放不下时菜单停在视口内，项在菜单内部滚动', async () => {
    const many = [{ id: 'all', items: Array.from({ length: 30 }, (_, index) => ({ id: `ch-${index}`, label: `第 ${index + 1} 章`, onSelect: () => {} })) }]
    const container = await mount(<div style={{ paddingTop: 120 }}><Menu label="跳到章节" groups={many} /></div>)
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(document.documentElement.clientHeight - 8)
    expect(menu.scrollHeight).toBeGreaterThan(menu.clientHeight)
    const last = page.getByRole('menuitem', { name: '第 30 章' }).element()
    last.scrollIntoView({ block: 'nearest' })
    await settle()
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.elementFromPoint(last.getBoundingClientRect().left + 20, last.getBoundingClientRect().top + 10)).toBe(last)
  })

  it('滚动侧页时菜单关闭，不与触发按钮脱节', async () => {
    const container = await mount(<Harness />)
    await openMenu(container)
    const body = container.querySelector<HTMLElement>('.pi-sheet-body')!
    await act(async () => {
      body.scrollTop = 80
      await new Promise((resolve) => body.addEventListener('scroll', resolve, { once: true }))
    })
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('别处的滚动区自己滚动（比如运行日志跟到最新一行）时菜单不关，触发按钮没有动', async () => {
    const container = await mount(<><Harness /><div className="log" style={{ height: 80, overflow: 'auto' }}><div style={{ height: 400 }} /></div></>)
    await openMenu(container)
    const log = container.querySelector<HTMLElement>('.log')!
    await act(async () => {
      log.scrollTop = 200
      await new Promise((resolve) => log.addEventListener('scroll', resolve, { once: true }))
    })
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
  })
})

describe('Popover', () => {
  it('键盘打开后焦点进入弹层，Esc 关闭且焦点回到触发按钮', async () => {
    const container = await mount(
      <div style={{ height: 260 }}>
        <Popover label="版本 v3" title="草稿版本"><p>v3 修稿于今天 14:20。</p></Popover>
      </div>,
    )
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await userEvent.tab()
    expectFocusRing(trigger)
    await userEvent.keyboard('{Enter}')
    await settle()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h3')!.id)
    expect(focused()).toBe(dialog)
    await shot('rd1-popover')

    await userEvent.keyboard('{Escape}')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(focused()).toBe(trigger)
  })

  it('弹层定位之后、监听挂上之前触发按钮被滚走：弹层随后关闭，不留在旧位置与按钮脱节', async () => {
    function ScrolledRightAfterOpen() {
      const layer = useAnchoredLayer('start')
      const scroller = useRef<HTMLDivElement>(null)
      // 排在 useAnchoredLayer 的定位之后：打开的同一次提交里，弹层按旧位置定好，滚动区才把按钮带走
      useLayoutEffect(() => {
        if (layer.open && scroller.current) scroller.current.scrollTop = 80
      }, [layer.open])
      return (
        <div ref={scroller} style={{ height: 200, overflow: 'auto' }}>
          <div style={{ height: 600, paddingTop: 100 }}>
            <div className="pi-anchor" ref={layer.anchorRef}>
              <Button ref={layer.triggerRef} variant="secondary" onClick={layer.toggle}>版本 v3</Button>
              {layer.open && layer.renderLayer(<div ref={layer.layerRef} role="dialog" aria-label="草稿版本" tabIndex={-1} className="pi-popover">v3</div>)}
            </div>
          </div>
        </div>
      )
    }
    const container = await mount(<ScrolledRightAfterOpen />)
    await userEvent.click(page.getByRole('button', { name: '版本 v3' }))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const layer = container.querySelector<HTMLElement>('[role="dialog"]')
    const trigger = container.querySelector('button')!.getBoundingClientRect()
    expect(layer === null || Math.abs(layer.getBoundingClientRect().top - (trigger.bottom + 6)) < 1, JSON.stringify({ layerTop: layer?.getBoundingClientRect().top, triggerBottom: trigger.bottom }))
      .toBe(true)
  })

  it('弹层 Portal 到纸墨根后，Tab 顺序仍接在触发按钮之后', async () => {
    const container = await mount(
      <div style={{ display: 'flex', gap: 8 }}>
        <Popover label="版本 v3" title="草稿版本"><Button variant="text" size="sm">恢复此版本</Button></Popover>
        <Button variant="text">下一项</Button>
      </div>,
    )
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    await settle()
    expect(focused().getAttribute('role')).toBe('dialog')
    await userEvent.tab()
    expect(focused().textContent).toBe('恢复此版本')
    await userEvent.tab({ shift: true })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(focused()).toBe(trigger)

    await userEvent.keyboard('{Enter}')
    await settle()
    await userEvent.tab()
    await userEvent.tab()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(focused().textContent).toBe('下一项')
  })

  it('Tab 跳过折叠起来的控件：最后一个看得见的控件之后再 Tab，弹层关闭，焦点到触发按钮的下一项', async () => {
    const container = await mount(
      <div style={{ display: 'flex', gap: 8 }}>
        <Popover label="本次写作选项" title="本次写作选项">
          <Button variant="text" size="sm">恢复默认</Button>
          <details><summary>更多</summary><input aria-label="知识库检索关键词" /></details>
        </Popover>
        <Button variant="text">下一项</Button>
      </div>,
    )
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    await settle()
    await userEvent.tab()
    await userEvent.tab()
    expect(focused().textContent).toBe('更多')
    await userEvent.tab()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(focused().textContent).toBe('下一项')
  })

  it('靠近视口下沿放不下时向上展开；上下都放不下时取较大一侧并在弹层内部滚动，内部滚动不关闭弹层', async () => {
    const tall = <div style={{ height: 700 }}>九条预检提醒</div>
    const container = await mount(
      <div style={{ paddingTop: 560 }}>
        <Popover label="写第 5 章" title="本次写作选项">{tall}</Popover>
      </div>,
    )
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    await act(async () => trigger.click())
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    await finishAnimations(dialog)
    const triggerRect = trigger.getBoundingClientRect()
    const rect = dialog.getBoundingClientRect()
    expect(Math.abs(rect.bottom - (triggerRect.top - 6))).toBeLessThanOrEqual(1)
    expect(getComputedStyle(dialog).animationName).toBe('pi-drop')
    expect(rect.top).toBeGreaterThanOrEqual(8)
    expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight)
    await act(async () => {
      dialog.scrollTop = dialog.scrollHeight
      await new Promise((resolve) => dialog.addEventListener('scroll', resolve, { once: true }))
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('点击弹层外部关闭', async () => {
    const container = await mount(<Popover label="版本" title="草稿版本">内容</Popover>)
    await act(async () => container.querySelector('button')!.click())
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('SegmentedControl 与 Check', () => {
  function Harness() {
    const [scope, setScope] = useState<'chapter' | 'book'>('chapter')
    const [checked, setChecked] = useState(false)
    const [on, setOn] = useState(false)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
        <SegmentedControl label="审稿范围" options={[{ value: 'chapter', label: '本章' }, { value: 'book', label: '全书' }]} value={scope} onChange={setScope} />
        <Check checked={checked} onChange={setChecked} label="同时检查人物一致性" />
        <Check kind="switch" checked={on} onChange={setOn} label="自动保存" />
      </div>
    )
  }

  it.each(['light', 'dark'] as const)('%s 主题未选中项在凹陷底叠加到各表面后对比度不低于 4.5:1', async (theme) => {
    const container = await mount(<Harness />, theme)
    const seg = container.querySelector<HTMLElement>('.pi-seg')!
    const unpressed = seg.querySelector('[aria-pressed="false"]')!
    expect(getComputedStyle(seg).backgroundColor).toBe(tokenColor(container, '--sunken'))
    for (const surface of ['--frame', '--surface', '--paper']) {
      const background = composite(getComputedStyle(seg).backgroundColor, tokenColor(container, surface))
      expect(contrast(getComputedStyle(unpressed).color, background)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('带 Alt、Ctrl、Meta、Shift 的方向键与 Home/End 不换选，也不拦下按键，留给系统与外层快捷键', async () => {
    const container = await mount(<Harness />)
    const segments = [...container.querySelectorAll<HTMLButtonElement>('.pi-seg button')]
    await userEvent.tab()
    const press = (key: string, modifiers: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
      act(() => { focused().dispatchEvent(event) })
      return event.defaultPrevented
    }
    const prevented = (['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const)
      .flatMap(modifier => ['ArrowRight', 'ArrowLeft', 'End', 'Home'].map(key => press(key, { [modifier]: true })))
    expect([prevented.filter(Boolean).length, segments.map(s => s.getAttribute('aria-pressed')), focused()]).toEqual([0, ['true', 'false'], segments[0]])

    expect(press('ArrowRight')).toBe(true)
    expect([segments.map(s => s.getAttribute('aria-pressed')), focused()]).toEqual([['false', 'true'], segments[1]])
  })

  it('选中态与 aria-pressed、checked 一致，全部键盘可达且焦点环可见', async () => {
    const container = await mount(<Harness />)
    const group = container.querySelector('[role="group"]')!
    expect(group.getAttribute('aria-label')).toBe('审稿范围')
    const segments = [...group.querySelectorAll('button')]
    expect(segments.map((s) => s.getAttribute('aria-pressed'))).toEqual(['true', 'false'])

    await userEvent.tab()
    expect(focused()).toBe(segments[0])
    await userEvent.keyboard('{ArrowRight}')
    expect(focused()).toBe(segments[1])
    expectFocusRing(segments[1])
    expect(segments.map((s) => s.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    expect(getComputedStyle(segments[1]).fontWeight).toBe('500')

    await userEvent.tab()
    const checkbox = focused() as HTMLInputElement
    expect(checkbox.type).toBe('checkbox')
    expect(checkbox.getAttribute('role')).toBeNull()
    expectFocusRing(checkbox.nextElementSibling!)
    await userEvent.keyboard(' ')
    expect(checkbox.checked).toBe(true)
    expect(getComputedStyle(checkbox.nextElementSibling!).backgroundColor).toBe(ACCENT.light)

    await userEvent.tab()
    const toggle = focused() as HTMLInputElement
    expect(toggle.getAttribute('role')).toBe('switch')
    expectFocusRing(toggle.nextElementSibling!)
    await userEvent.keyboard(' ')
    expect(toggle.checked).toBe(true)
    ;(document.activeElement as HTMLElement).blur()
    await shot('rd1-seg')
  })
})

describe('禁用的勾选与输入框', () => {
  it.each(['light', 'dark'] as const)('%s 主题是没上墨的平面：不用 opacity，墨色薄雾底，字退到 --ink-3', async (theme) => {
    const container = await mount(
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
        <Check checked={false} disabled onChange={() => {}} label="故事架构与大纲" />
        <Check checked disabled onChange={() => {}} label="章节蓝图" />
        <input className="pi-input" disabled defaultValue="灯塔" />
      </div>,
      theme,
    )
    for (const box of container.querySelectorAll<HTMLElement>('.pi-check-box')) {
      expect(getComputedStyle(box).opacity).toBe('1')
      expect(getComputedStyle(box).backgroundColor).toBe(tokenColor(container, '--wash-strong'))
      expect(getComputedStyle(box.nextElementSibling!).opacity).toBe('1')
      expect(getComputedStyle(box.nextElementSibling!).color).toBe(tokenColor(container, '--ink-3'))
    }
    const input = container.querySelector<HTMLInputElement>('.pi-input')!
    expect(getComputedStyle(input).backgroundColor).toBe(tokenColor(container, '--wash'))
    expect(getComputedStyle(input).borderTopColor).toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(input).color).toBe(tokenColor(container, '--ink-3'))
  })
})

describe('禁用的开关', () => {
  it.each(['light', 'dark'] as const)('%s 主题开着也退成墨色薄雾的轨道，不留强调色，不用 opacity', async (theme) => {
    const container = await mount(
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
        <Check kind="switch" checked disabled onChange={() => {}} label="写完自动打开下一章" />
        <Check kind="switch" checked={false} disabled onChange={() => {}} label="启动时检查更新" />
      </div>,
      theme,
    )
    const [on, off] = [...container.querySelectorAll<HTMLElement>('.pi-switch')]
    for (const track of [on, off]) {
      expect(getComputedStyle(track).opacity).toBe('1')
      expect(getComputedStyle(track).backgroundColor).toBe(tokenColor(container, '--wash-strong'))
    }
    expect(getComputedStyle(on, '::after').transform).not.toBe(getComputedStyle(off, '::after').transform)
    expect(getComputedStyle(on.nextElementSibling!).color).toBe(tokenColor(container, '--ink-3'))
  })
})

describe('StatGrid、Notice、Lifecycle', () => {
  it('统计格是带名称的描述列表，数字为 Instrument Serif', async () => {
    const container = await mount(
      <StatGrid label="作品统计" items={[{ id: 'c', label: '已定稿章节', value: '12' }, { id: 'w', label: '总字数', value: '86,400', hint: '含草稿' }]} />,
    )
    const list = container.querySelector('dl')!
    expect(list.getAttribute('aria-label')).toBe('作品统计')
    expect([...list.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['已定稿章节', '总字数'])
    expect(getComputedStyle(list.querySelector('.pi-stat-value')!).fontFamily).toContain('Instrument Serif')
  })

  it('提示条以 status 播报，按语气取图标与底色，动作可键盘到达', async () => {
    const container = await mount(
      <Notice tone="warn" title="有 2 处与设定冲突" actions={<Button variant="secondary" size="sm">查看</Button>}>可在审稿报告中处理。</Notice>,
    )
    const notice = container.querySelector('[role="status"]')!
    expect(notice.getAttribute('data-tone')).toBe('warn')
    expect(notice.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    expect(getComputedStyle(notice).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(notice).boxShadow).toBe('none')
    expect(getComputedStyle(notice.querySelector('.pi-notice-title')!).fontFamily).toContain('Noto Serif SC')
    await userEvent.tab()
    expect(focused().textContent).toBe('查看')
    expectFocusRing(focused())
  })

  it('生命周期标出当前步骤', async () => {
    const container = await mount(<Lifecycle label="第 4 章进度" steps={['写作', '审稿', '修稿', '定稿']} current={2} />)
    const steps = [...container.querySelectorAll('li')]
    expect(container.querySelector('ol')!.getAttribute('aria-label')).toBe('第 4 章进度')
    expect(steps.map((li) => li.dataset.state)).toEqual(['done', 'done', 'current', 'todo'])
    expect(steps.map((li) => li.getAttribute('aria-current'))).toEqual([null, null, 'step', null])
    expect(getComputedStyle(steps[2]).color).toBe(ACCENT.light)
  })

  it.each(['light', 'dark'] as const)('%s 主题未开始步骤为轨道色条，标签对纸面、面板、外框对比度不低于 4.5:1', async (theme) => {
    const container = await mount(<Lifecycle label="第 4 章进度" steps={['写作', '审稿', '修稿', '定稿']} current={2} />, theme)
    const todo = container.querySelectorAll('li')[3]
    expect(getComputedStyle(todo.querySelector('.pi-life-bar')!).backgroundColor).toBe(tokenColor(container, '--track'))
    for (const surface of ['--paper', '--surface', '--frame']) {
      expect(contrast(getComputedStyle(todo).color, tokenColor(container, surface))).toBeGreaterThanOrEqual(4.5)
    }
    await shot(`rd1-lifecycle-${theme}`)
  })
})

describe('InlineConfirm', () => {
  it('出现时焦点在取消上，写明后果，Esc 取消，确认为危险描边按钮', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const container = await mount(
      <InlineConfirm message="清空后无法恢复这 12 条日志。" confirmLabel="清空" cancelLabel="取消" onConfirm={onConfirm} onCancel={onCancel} returnFocusRef={{ current: null }} />,
    )
    const group = container.querySelector('[role="group"]')!
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent).toBe('清空后无法恢复这 12 条日志。')
    expect(focused().textContent).toBe('取消')
    await userEvent.tab()
    expect(focused().className).toContain('pi-btn--danger')
    expectFocusRing(focused())
    await userEvent.keyboard('{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  /** 照运行侧页「清空日志…」：确认条出现期间触发按钮禁用，清空后再也不可用。 */
  function ClearLog() {
    const [lines, setLines] = useState(12)
    const [confirming, setConfirming] = useState(false)
    const trigger = useRef<HTMLButtonElement>(null)
    return (
      <aside tabIndex={-1} aria-label="运行侧页">
        <Button ref={trigger} variant="text" disabled={lines === 0 || confirming} onClick={() => setConfirming(true)}>清空日志…</Button>
        {confirming && (
          <InlineConfirm message={`清空后这 ${lines} 行日志无法找回。`} confirmLabel="清空" cancelLabel="保留"
            onConfirm={() => { setConfirming(false); setLines(0) }} onCancel={() => setConfirming(false)} returnFocusRef={trigger} />
        )}
      </aside>
    )
  }

  it('取消后焦点回到打开它的按钮；确认后那个按钮不可用时，焦点落到最近的可聚焦祖先，不落到 body', async () => {
    const container = await mount(<ClearLog />)
    const trigger = page.getByRole('button', { name: '清空日志…' }).element()
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    expect(focused().textContent).toBe('保留')
    await userEvent.keyboard('{Escape}')
    expect(focused()).toBe(trigger)

    await userEvent.keyboard('{Enter}')
    await userEvent.tab()
    expect(focused().textContent).toBe('清空')
    await userEvent.keyboard('{Enter}')
    expect(container.querySelector('[role="group"]')).toBeNull()
    expect(focused()).toBe(container.querySelector('aside'))
  })

  it('确认条替换掉了打开它的按钮时，取消后焦点回到重新出现的按钮', async () => {
    function Discard() {
      const [confirming, setConfirming] = useState(false)
      const trigger = useRef<HTMLButtonElement>(null)
      return (
        <article tabIndex={-1} aria-label="可恢复的内容">
          {confirming
            ? <InlineConfirm message="放弃后这 300 字无法找回。" confirmLabel="放弃" cancelLabel="保留" onConfirm={() => setConfirming(false)} onCancel={() => setConfirming(false)} returnFocusRef={trigger} />
            : <Button ref={trigger} variant="danger" onClick={() => setConfirming(true)}>放弃…</Button>}
        </article>
      )
    }
    await mount(<Discard />)
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('{Escape}')
    expect(focused().textContent).toBe('放弃…')
  })
})

describe('DangerConfirm', () => {
  function Harness({ onConfirm }: { onConfirm: () => void }) {
    const [open, setOpen] = useState(true)
    return (
      <div style={{ minHeight: 440 }}>
        <DangerConfirm
          open={open}
          onOpenChange={setOpen}
          title="删除《灯塔》"
          consequence="将删除全部章节、蓝图与设定。"
          recoverability="删除后无法恢复。"
          confirmLabel="永久删除"
          cancelLabel="取消"
          onConfirm={onConfirm}
          typeToConfirm={{ expected: '灯塔', label: '输入作品名「灯塔」以确认' }}
        />
      </div>
    )
  }

  it('名称不符时确认按钮禁用，输入作品名后可确认', async () => {
    const onConfirm = vi.fn()
    const container = await mount(<Harness onConfirm={onConfirm} />)
    await settle()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('删除《灯塔》')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toContain('删除后无法恢复。')
    const input = dialog.querySelector('input')!
    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent === '永久删除')!
    expect(focused()).toBe(input)
    expect(confirm.className).toContain('pi-btn--danger-solid')
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-recover')!).color).toBe(DANGER.light)
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-title')!).color).not.toBe(DANGER.light)

    await userEvent.keyboard('灯')
    expect(confirm.disabled).toBe(true)
    await shot('rd1-danger')
    await userEvent.keyboard('塔')
    expect(confirm.disabled).toBe(false)
    await userEvent.tab()
    await userEvent.tab()
    expect(focused()).toBe(confirm)
    expectFocusRing(confirm)
    await userEvent.keyboard('{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it.each(['light', 'dark'] as const)('%s 主题祖先带 transform 时对话框仍居中于视口，并取到纸墨令牌', async (theme) => {
    const container = await mount(
      <div style={{ transform: 'translateX(0)', width: 240, height: 120, overflow: 'hidden', position: 'relative', zIndex: 0 }}>
        <Harness onConfirm={() => {}} />
      </div>,
      theme,
    )
    await settle()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const rect = dialog.getBoundingClientRect()
    expect(rect.left + rect.width / 2).toBeCloseTo(document.documentElement.clientWidth / 2, 0)
    expect(rect.top + rect.height / 2).toBeCloseTo(document.documentElement.clientHeight / 2, 0)
    expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + 20)?.closest('[role="dialog"]')).toBe(dialog)
    expect(getComputedStyle(dialog).backgroundColor).toBe(tokenColor(container, '--layer'))
  })

  it('Esc 关闭对话框且不确认', async () => {
    const onConfirm = vi.fn()
    const container = await mount(<Harness onConfirm={onConfirm} />)
    await settle()
    await userEvent.keyboard('{Escape}')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  function Opener({ onConfirm = () => {} }: { onConfirm?: () => void }) {
    const [open, setOpen] = useState(false)
    return (
      <div style={{ minHeight: 440 }}>
        <Button variant="danger" onClick={() => setOpen(true)}>关闭标签</Button>
        <DangerConfirm open={open} onOpenChange={setOpen} title="放弃未保存的修改？" consequence="修改会丢失。" recoverability="无法恢复。"
          confirmLabel="放弃并关闭" cancelLabel="继续编辑" onConfirm={onConfirm} />
      </div>
    )
  }

  it('没有 Dialog.Trigger 时，Esc 或取消关闭后焦点回到打开前的元素，不落到 body', async () => {
    const container = await mount(<Opener />)
    const opener = container.querySelector('button')!
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(focused()).toBe(opener)

    await userEvent.keyboard('{Enter}')
    await userEvent.click(page.getByRole('button', { name: '继续编辑' }))
    expect(focused()).toBe(opener)
  })

  it('确认后打开它的元素已被移除时，焦点落到最近仍在的可聚焦祖先', async () => {
    function RemovedOnConfirm() {
      const [tabs, setTabs] = useState(['第 3 章'])
      const [open, setOpen] = useState(false)
      return (
        <section tabIndex={-1} aria-label="内容区" style={{ minHeight: 440 }}>
          {tabs.map((tab) => <Button key={tab} variant="text" onClick={() => setOpen(true)}>{tab}</Button>)}
          <DangerConfirm open={open} onOpenChange={setOpen} title="放弃未保存的修改？" consequence="修改会丢失。" recoverability="无法恢复。"
            confirmLabel="放弃并关闭" cancelLabel="继续编辑" onConfirm={() => setTabs([])} />
        </section>
      )
    }
    const container = await mount(<RemovedOnConfirm />)
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(page.getByRole('button', { name: '放弃并关闭' }))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(focused()).toBe(container.querySelector('section'))
  })

  it('确认关掉对话框的同时打开了拿焦点的弹层：对话框不把焦点还回打开前的元素，弹层不被这次还焦点关掉', async () => {
    function OpensPopoverOnConfirm() {
      const [open, setOpen] = useState(false)
      const layer = useAnchoredLayer('start')
      useEffect(() => {
        if (layer.open) layer.layerRef.current?.focus()
      }, [layer.open, layer.layerRef])
      return (
        <div style={{ minHeight: 440 }}>
          <Button variant="text" onClick={() => setOpen(true)}>历史</Button>
          <div className="pi-anchor" ref={layer.anchorRef}>
            <Button ref={layer.triggerRef} variant="secondary">写第 4 章</Button>
            {layer.open && layer.renderLayer(<div ref={layer.layerRef} role="dialog" aria-label="本次写作选项" tabIndex={-1} className="pi-popover">弹层</div>)}
          </div>
          <DangerConfirm open={open} onOpenChange={setOpen} title="放弃未保存的修改？" consequence="修改会丢失。" recoverability="无法恢复。"
            confirmLabel="放弃修改" cancelLabel="继续编辑" onConfirm={() => { setOpen(false); layer.show() }} />
        </div>
      )
    }
    await mount(<OpensPopoverOnConfirm />)
    await userEvent.click(page.getByRole('button', { name: '历史' }))
    await userEvent.click(page.getByRole('button', { name: '放弃修改' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    const popover = document.querySelector('[aria-label="本次写作选项"]')
    expect([popover !== null, focused().getAttribute('aria-label')]).toEqual([true, '本次写作选项'])
  })

  it('父组件不经 onOpenChange 直接关闭再打开，输入框是空的', async () => {
    let setOpen: (open: boolean) => void = () => {}
    function ParentControlled() {
      const [open, set] = useState(true)
      setOpen = set
      return (
        <div style={{ minHeight: 440 }}>
          <DangerConfirm open={open} onOpenChange={set} title="删除《灯塔》" consequence="将删除全部章节。" recoverability="删除后无法恢复。"
            confirmLabel="永久删除" cancelLabel="取消" onConfirm={() => {}} typeToConfirm={{ expected: '灯塔', label: '输入作品名「灯塔」以确认' }} />
        </div>
      )
    }
    const container = await mount(<ParentControlled />)
    await settle()
    await userEvent.keyboard('灯塔')
    expect(container.querySelector('input')!.value).toBe('灯塔')
    await act(async () => setOpen(false))
    await act(async () => setOpen(true))
    expect(container.querySelector('input')!.value).toBe('')
    expect(page.getByRole('button', { name: '永久删除' }).element()).toHaveProperty('disabled', true)
  })
})

describe('EmptyState', () => {
  it('衬线标题、说明与一个可键盘到达的动作', async () => {
    const container = await mount(
      <EmptyState heading="还没有作品" description="从一个前提开始。" action={<Button variant="primary">新建作品</Button>} />,
    )
    const heading = container.querySelector('h3')!
    expect(getComputedStyle(heading).fontFamily).toContain('Noto Serif SC')
    expect(container.querySelectorAll('button')).toHaveLength(1)
    await userEvent.tab()
    expect(focused().textContent).toBe('新建作品')
    expectFocusRing(focused())
    ;(document.activeElement as HTMLElement).blur()
    await shot('rd1-empty')
  })
})

describe('字体', () => {
  it('Instrument Serif 与 Noto Serif SC 从本地 /fonts 加载，不请求外部字体服务', async () => {
    const container = await mount(
      <div>
        <span className="pi-num" style={{ fontSize: 56 }}>3</span>
        <h1 className="pi-display" style={{ fontSize: 30 }}>雨夜车站</h1>
      </div>,
    )
    const [italicNumber] = await document.fonts.load('italic 56px "Instrument Serif"', '3')
    const [serifTitle] = await document.fonts.load('600 30px "Noto Serif SC"', '雨夜')
    expect(italicNumber?.status).toBe('loaded')
    expect(serifTitle?.status).toBe('loaded')
    expect(getComputedStyle(container.querySelector('.pi-num')!).fontFamily).toContain('Instrument Serif')
    expect(getComputedStyle(container.querySelector('h1')!).fontFamily).toContain('Noto Serif SC')
    const fontRequests = performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /\.(woff2?|ttf|otf)(\?|$)/.test(name))
    expect(fontRequests.some((name) => name.includes('/fonts/InstrumentSerif-Latin-Italic.woff2'))).toBe(true)
    expect(fontRequests.every((name) => new URL(name).origin === location.origin)).toBe(true)
    await shot('rd1-fonts')
  })
})
