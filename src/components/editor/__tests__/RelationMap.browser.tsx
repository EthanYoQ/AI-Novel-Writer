/* eslint-disable react-refresh/only-export-components -- 浏览器测试文件里同时声明测试外壳组件与辅助函数，本文件不参与 HMR 热更新 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../styles/redesign/v2-index.css'
import { useLocaleStore } from '../../../stores/locale-store'
import RelationMap, { type RelationMapCharacter } from '../RelationMap'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 「李莉莉」为视角人物，另有：
 *   李子瞻 —— 直连 + 兄妹（家人）        → 次大圈圈
 *   王德海 —— 直连 + 少爷 / 司机 / 接送   → 中等圈圈
 *   陈家旺 —— 隔一层（李子瞻的老搭档）    → 卫星小头像
 *   何川   —— 完全不可达                 → 远处小点
 * 五个人正好覆盖 main / important / normal / satellite / far 五档。
 */
const ROSTER: RelationMapCharacter[] = [
  {
    name: '李莉莉',
    role: 'protagonist',
    relationships: JSON.stringify([
      { target: '李子瞻', relation: '兄妹' },
      { target: '王德海', relation: '少爷 / 司机 / 接送' },
    ]),
    age: '19',
    background: '李家的独女，正跟着师傅学喃呒。',
    personality: '谨慎又好奇。',
  },
  { name: '李子瞻', role: 'supporting', relationships: '' },
  { name: '王德海', role: 'minor', relationships: '' },
  { name: '陈家旺', role: 'supporting', relationships: JSON.stringify([{ target: '李子瞻', relation: '旧识' }]) },
  { name: '何川', role: 'supporting', relationships: '' },
]

let root: Root
let container: HTMLDivElement
const originalLocaleState = useLocaleStore.getState()

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function nodeFor(name: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`.relation-node[data-node="${name}"]`)
  if (!node) throw new Error(`node ${name} not found`)
  return node
}

function portraitOf(name: string): HTMLElement {
  const portrait = nodeFor(name).querySelector<HTMLElement>('.portrait')
  if (!portrait) throw new Error(`portrait of ${name} not found`)
  return portrait
}

function stageTransform(): string {
  const stage = container.querySelector<HTMLElement>('.relation-stage')
  return stage?.style.transform ?? ''
}

function zoomLabel(): string {
  return container.querySelector('.relation-zoom button:nth-child(2)')?.textContent ?? ''
}

/** 在某个节点上完成一次「按下 → 移动 → 松手」。 */
async function dragNode(name: string, dx: number, dy: number) {
  const node = nodeFor(name)
  const rect = node.getBoundingClientRect()
  const startX = rect.left + rect.width / 2
  const startY = rect.top + rect.height / 2

  node.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, pointerId: 1, button: 0, clientX: startX, clientY: startY,
  }))
  node.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerId: 1, clientX: startX + dx, clientY: startY + dy,
  }))
  await nextFrame()
  node.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, pointerId: 1, clientX: startX + dx, clientY: startY + dy,
  }))
  await nextFrame()
}

/** 在画布空白处完成一次拖动。 */
async function dragCanvas(dx: number, dy: number) {
  const canvas = container.querySelector<HTMLElement>('.relation-canvas')
  if (!canvas) throw new Error('canvas not found')
  const rect = canvas.getBoundingClientRect()
  const startX = rect.left + 4
  const startY = rect.top + 4

  canvas.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, pointerId: 2, button: 0, clientX: startX, clientY: startY,
  }))
  canvas.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, pointerId: 2, clientX: startX + dx, clientY: startY + dy,
  }))
  await nextFrame()
  canvas.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, pointerId: 2, clientX: startX + dx, clientY: startY + dy,
  }))
  await nextFrame()
}

interface HarnessProps {
  onOpenProfile?: (name: string) => void
  onDeleteAll?: () => void
  characters?: RelationMapCharacter[]
}

/** 受控外壳：点圈圈换视角的行为与产品里完全一致。 */
function Harness({ onOpenProfile = () => {}, onDeleteAll = () => {}, characters = ROSTER }: HarnessProps) {
  const [center, setCenter] = useState(characters[0]?.name ?? '')
  return (
    <RelationMap
      characters={characters}
      center={center}
      onSelectCenter={setCenter}
      onOpenProfile={onOpenProfile}
      onDeleteAll={onDeleteAll}
      deleteAllDisabled={false}
    />
  )
}

async function render(ui: ReactElement) {
  await act(async () => { root.render(ui) })
  await nextFrame()
}

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  // v2 皮肤只挂在 html[data-ui='v2'] 上；关系图谱的版式与分档尺寸都在那里。
  document.documentElement.setAttribute('data-ui', 'v2')
  // 默认没有任何角色上传过头像，于是全部回落到「姓名首字 + 色调」。
  ;(window as unknown as { velaAPI: unknown }).velaAPI = {
    invoke: vi.fn(async () => ({ success: true, avatar: null })),
    on: () => () => {},
    once: () => {},
    send: () => {},
    setZoomLevel: () => {},
    setZoomFactor: () => {},
    getZoomLevel: () => 0,
  }
  container = document.createElement('div')
  container.style.width = '1000px'
  container.style.height = '700px'
  container.style.position = 'fixed'
  container.style.left = '0'
  container.style.top = '0'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.removeAttribute('data-ui')
  delete (window as unknown as { velaAPI?: unknown }).velaAPI
  useLocaleStore.setState(originalLocaleState)
  vi.restoreAllMocks()
})

describe('关系图谱 · 版式与分档', () => {
  it('空名单时给双语空态', async () => {
    await render(<RelationMap characters={[]} center="" onSelectCenter={() => {}} onOpenProfile={() => {}} onDeleteAll={() => {}} deleteAllDisabled />)
    expect(container.textContent).toContain('暂无角色数据')

    useLocaleStore.setState({ locale: 'en-US' })
    await render(<RelationMap characters={[]} center="" onSelectCenter={() => {}} onOpenProfile={() => {}} onDeleteAll={() => {}} deleteAllDisabled />)
    expect(container.textContent).toContain('No character data')
  })

  it('页头与「人物档案」同源：同一组类名 → 同一套字体、字号、字重、位置', async () => {
    await render(<Harness />)

    const strip = container.querySelector<HTMLElement>('.pagehead-strip')
    expect(strip).not.toBeNull()
    expect(strip?.querySelector('.ph-k')?.textContent).toBe('CAST · 人物关系图谱')
    expect(strip?.querySelector('h1')?.textContent).toBe('人物关系图谱')
    expect(strip?.querySelector('.ph-d')?.textContent).toContain('以「李莉莉」为中心')

    const kicker = strip?.querySelector<HTMLElement>('.ph-k')
    const title = strip?.querySelector<HTMLElement>('h1')
    const description = strip?.querySelector<HTMLElement>('.ph-d')

    // 下面这几个值就是 shell.css 261–266 行（demo 的 .pagehead）的定义，
    // 与「CAST · 人物档案 / 李莉莉 / 主角 · 最近更新：第 11 章」完全同源 ——
    // 眉标 9px/700、标题衬线 21px/700、说明 11.5px。
    expect(getComputedStyle(kicker as HTMLElement).fontSize).toBe('9px')
    expect(getComputedStyle(kicker as HTMLElement).fontWeight).toBe('700')
    expect(getComputedStyle(title as HTMLElement).fontSize).toBe('21px')
    expect(getComputedStyle(title as HTMLElement).fontWeight).toBe('700')
    expect(getComputedStyle(title as HTMLElement).fontFamily).toContain('Georgia')
    expect(getComputedStyle(description as HTMLElement).fontSize).toBe('11.5px')

    // 位置（先生定）：图谱是一整幅画布，标头靠正文栏左侧、距边框 15px，
    // 不跟着其它子菜单居中在 1024px 里。
    const stripStyle = getComputedStyle(strip as HTMLElement)
    expect(stripStyle.maxWidth).toBe('none')
    expect(stripStyle.marginLeft).toBe('0px')
    expect(stripStyle.paddingLeft).toBe('15px')
    expect(stripStyle.paddingRight).toBe('15px')

    // 先生：「重置 / 适应 / 删除全部角色与关系」不许越过右侧人物简介栏的地界。
    // 页头只占画布那一列，按钮组的右边缘停在侧栏左边缘往左 15px 处；
    // 右侧简介栏则跨满两行（从页头顶部到底部），保持 demo 的全高版式。
    const actions = strip?.querySelector<HTMLElement>('.ph-a')
    const side = container.querySelector<HTMLElement>('.relation-side')
    expect(actions).not.toBeNull()
    expect(side).not.toBeNull()
    const actionsRect = actions!.getBoundingClientRect()
    const sideRect = side!.getBoundingClientRect()
    expect(actionsRect.right).toBeLessThanOrEqual(sideRect.left)
    expect(sideRect.left - actionsRect.right).toBeGreaterThanOrEqual(14)
    expect(sideRect.top).toBeCloseTo(strip!.getBoundingClientRect().top, 1)

    // 先生：这几个按钮的样式就该按 demo 来 —— .relation-tool 是无边框、方角、
    // 浅灰文字的轻量按钮，悬浮才转朱砂；不能退化成产品页头那套 25px 圆角 .btn。
    const tool = strip?.querySelector<HTMLElement>('.relation-tool')
    expect(tool).not.toBeNull()
    const toolStyle = getComputedStyle(tool as HTMLElement)
    expect(toolStyle.borderStyle).toBe('none')
    expect(toolStyle.borderRadius).toBe('0px')
    expect(toolStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(toolStyle.fontSize).toBe('9.5px')
    expect(toolStyle.color).toBe('rgb(143, 136, 118)')
    // 三颗都在 .relation-tools 里，间距 2px（demo 999 行）。
    expect(getComputedStyle(strip!.querySelector('.relation-tools') as HTMLElement).columnGap).toBe('2px')
    expect(strip!.querySelectorAll('.relation-tool')).toHaveLength(3)
  })

  it('按亲疏把五档圈圈摆出来：主视角、次大、中等、卫星、远点', async () => {
    await render(<Harness />)

    expect(nodeFor('李莉莉').dataset.tier).toBe('main')
    expect(nodeFor('李子瞻').dataset.tier).toBe('important')
    expect(nodeFor('王德海').dataset.tier).toBe('normal')
    expect(nodeFor('陈家旺').dataset.tier).toBe('satellite')
    expect(nodeFor('何川').dataset.tier).toBe('far')
  })

  it('圈圈直径与分档一致（主视角最大，越远越小）', async () => {
    await render(<Harness />)

    expect(getComputedStyle(portraitOf('李莉莉')).width).toBe('104px')
    expect(getComputedStyle(portraitOf('李子瞻')).width).toBe('82px')
    expect(getComputedStyle(portraitOf('王德海')).width).toBe('50px')
    expect(getComputedStyle(portraitOf('陈家旺')).width).toBe('30px')
    expect(getComputedStyle(portraitOf('何川')).width).toBe('15px')
  })

  it('按关系距离给出显示透明度', async () => {
    await render(<Harness />)

    expect(nodeFor('李莉莉').style.getPropertyValue('--rel-opacity')).toBe('1')
    expect(nodeFor('李子瞻').style.getPropertyValue('--rel-opacity')).toBe('1')
    expect(nodeFor('陈家旺').style.getPropertyValue('--rel-opacity')).toBe('0.48')
    expect(nodeFor('何川').style.getPropertyValue('--rel-opacity')).toBe('0.09')
    // 变量确实被消费成真实透明度，而不只是写在内联样式里。
    expect(Number(getComputedStyle(nodeFor('何川')).opacity)).toBeCloseTo(0.09, 2)
  })

  it('主视角钉在画布中央，直连的绕内环、其余沿外弧收束', async () => {
    await render(<Harness />)

    expect(nodeFor('李莉莉').style.left).toBe('50%')
    expect(nodeFor('李莉莉').style.top).toBe('50%')

    const radius = (name: string) => {
      const node = nodeFor(name)
      const x = Number.parseFloat(node.style.left)
      const y = Number.parseFloat(node.style.top)
      return Math.hypot(x - 50, y - 50)
    }
    // 直连的两人绕内环，隔一层与不可达的沿同一条外弧对称收束。
    expect(radius('李子瞻')).toBeCloseTo(radius('王德海'), 1)
    expect(radius('李子瞻')).toBeLessThan(radius('陈家旺'))
    expect(radius('陈家旺')).toBeCloseTo(radius('何川'), 1)
  })

  it('没有自定义头像时用姓名首字，且每人一色以作区别', async () => {
    await render(<Harness />)

    const lili = portraitOf('李莉莉').querySelector('span')
    const zizhan = portraitOf('李子瞻').querySelector('span')
    const wang = portraitOf('王德海').querySelector('span')
    expect(lili?.textContent).toBe('李')
    expect(zizhan?.textContent).toBe('李')
    expect(wang?.textContent).toBe('王')
    // 姓名首字可能重名（李家两兄妹都姓李），所以更要靠底色把人分开。
    expect(lili?.style.background).not.toBe(zizhan?.style.background)
    expect(zizhan?.style.background).not.toBe(wang?.style.background)
  })

  it('上传过头像的角色用真实图片', async () => {
    (window as unknown as { velaAPI: Record<string, unknown> }).velaAPI = {
      invoke: vi.fn(async (channel: string, name: string) => (
        channel === 'character-avatar:read' && name === '李莉莉'
          ? { success: true, avatar: { name, mime: 'image/png', base64: btoa('png-bytes') } }
          : { success: true, avatar: null }
      )),
      on: () => () => {},
      once: () => {},
      send: () => {},
      setZoomLevel: () => {},
      setZoomFactor: () => {},
      getZoomLevel: () => 0,
    }

    await render(<Harness />)
    await act(async () => { await Promise.resolve() })
    await nextFrame()

    const image = portraitOf('李莉莉').querySelector('img')
    expect(image).not.toBeNull()
    expect(portraitOf('李子瞻').querySelector('img')).toBeNull()
  })
})

describe('关系图谱 · 交互', () => {
  it('点一下圈圈就切到他的视角，并展开他的关系网络', async () => {
    await render(<Harness />)

    expect(nodeFor('李莉莉').dataset.tier).toBe('main')
    expect(container.querySelector('.relation-side h2')?.textContent).toBe('李莉莉')

    await dragNode('李子瞻', 0, 0)

    // 他成了新的主视角：居中、最大圈，右侧简介同步换成他。
    expect(nodeFor('李子瞻').dataset.tier).toBe('main')
    expect(nodeFor('李子瞻').style.left).toBe('50%')
    expect(nodeFor('李子瞻').style.top).toBe('50%')
    expect(container.querySelector('.relation-side h2')?.textContent).toBe('李子瞻')
    // 原主视角退成他的直接关系，隔着一个人的陈家旺从卫星升成直连的中等圈。
    expect(nodeFor('李莉莉').dataset.tier).not.toBe('main')
    expect(nodeFor('陈家旺').dataset.tier).toBe('normal')
  })

  it('拖动某个圈圈只移动它自己，松手不算点击', async () => {
    await render(<Harness />)
    const beforeSelf = nodeFor('王德海').style.left
    const beforeOther = nodeFor('李子瞻').style.left

    await dragNode('王德海', 60, 0)

    expect(nodeFor('王德海').style.left).not.toBe(beforeSelf)
    expect(nodeFor('李子瞻').style.left).toBe(beforeOther)
    // 位置变了就是拖动，不能顺手把视角也换掉。
    expect(nodeFor('李莉莉').dataset.tier).toBe('main')
  })

  it('抓空白处可以平移整个图谱', async () => {
    await render(<Harness />)
    expect(stageTransform()).toContain('translate(0px, 0px)')

    await dragCanvas(80, 40)

    expect(stageTransform()).toContain('translate(80px, 40px)')
    // 平移只动视图，不动任何圈圈自己的坐标。
    expect(nodeFor('李莉莉').style.left).toBe('50%')
  })

  it('滚轮缩放整幅图谱，并有一键复位', async () => {
    await render(<Harness />)
    const canvas = container.querySelector<HTMLElement>('.relation-canvas')
    if (!canvas) throw new Error('canvas not found')

    expect(zoomLabel()).toBe('100%')

    await act(async () => {
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }))
    })
    expect(zoomLabel()).toBe('110%')
    expect(stageTransform()).toContain('scale(1.1)')

    await act(async () => {
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }))
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }))
    })
    expect(zoomLabel()).toBe('90%')

    const resetButton = container.querySelector('.relation-zoom button:nth-child(4)')
    await act(async () => { (resetButton as HTMLElement).click() })
    expect(zoomLabel()).toBe('100%')
    expect(stageTransform()).toContain('scale(1)')
  })

  it('重置会重新排版并把视图归位', async () => {
    await render(<Harness />)
    const originalLeft = nodeFor('李子瞻').style.left

    await dragNode('李子瞻', 90, 30)
    await dragCanvas(50, 50)
    expect(stageTransform()).toContain('translate(50px, 50px)')

    const resetTool = Array.from(container.querySelectorAll('.relation-tool'))
      .find(button => button.textContent?.includes('重置'))
    await act(async () => { (resetTool as HTMLElement).click() })

    expect(nodeFor('李子瞻').style.left).toBe(originalLeft)
    expect(stageTransform()).toContain('translate(0px, 0px)')
  })
})

describe('关系图谱 · 右侧人物简介面板', () => {
  it('显示姓名、定位、年龄与关系数量', async () => {
    await render(<Harness />)

    const panel = container.querySelector('.relation-side')
    expect(panel?.textContent).toContain('李莉莉')
    expect(panel?.textContent).toContain('主角')
    expect(panel?.textContent).toContain('19')
    expect(panel?.textContent).toContain('2 人')
  })

  it('列出该角色的关键关系（互为对向只保留一条）', async () => {
    await render(<Harness />)

    const items = container.querySelectorAll('.relation-key-item')
    const labels = Array.from(items).map(item => item.textContent)
    expect(labels).toEqual([
      '李子瞻 兄妹',
      '王德海 少爷 / 司机 / 接送',
    ])
  })

  it('没有关系记录时给出说明而不是空白', async () => {
    await render(<Harness />)
    await dragNode('何川', 0, 0)

    expect(container.querySelector('.relation-key-empty')?.textContent)
      .toBe('暂无明确关系记录')
  })

  it('可以收起，也能从顶栏再展开', async () => {
    await render(<Harness />)
    expect(container.querySelector('.relation-side')).not.toBeNull()

    const closeButton = container.querySelector('.relation-character-top .rct-btn')
    await act(async () => { (closeButton as HTMLElement).click() })
    expect(container.querySelector('.relation-side')).toBeNull()
    expect(container.querySelector('.relation-view')?.classList.contains('relation-view-full')).toBe(true)

    const reopen = Array.from(container.querySelectorAll('.relation-tool'))
      .find(button => button.textContent?.includes('人物简介'))
    await act(async () => { (reopen as HTMLElement).click() })
    expect(container.querySelector('.relation-side')).not.toBeNull()
  })

  it('「查看详细档案」把当前视角人物交回档案页', async () => {
    const onOpenProfile = vi.fn()
    await render(<Harness onOpenProfile={onOpenProfile} />)

    await dragNode('陈家旺', 0, 0)
    const detail = container.querySelector('.relation-detail-btn')
    await act(async () => { (detail as HTMLElement).click() })

    expect(onOpenProfile).toHaveBeenCalledWith('陈家旺')
  })

  it('「删除全部角色与关系」仍然是图谱上的可达动作', async () => {
    const onDeleteAll = vi.fn()
    await render(<Harness onDeleteAll={onDeleteAll} />)

    const danger = Array.from(container.querySelectorAll('.relation-tool'))
      .find(button => button.textContent?.includes('删除全部角色与关系'))
    expect(danger?.textContent).toContain('删除全部角色与关系')
    await act(async () => { (danger as HTMLElement).click() })

    expect(onDeleteAll).toHaveBeenCalledTimes(1)
  })
})

describe('关系图谱 · 无障碍与可读性', () => {
  it('画布的替代文本包含完整关系说法，而不只是被截断的标签', async () => {
    const longRelation = '长期合作并共同调查校园系统背后的数据操控真相'
    await render(
      <Harness characters={[
        { name: '林墨', role: 'protagonist', relationships: JSON.stringify([{ target: '周砧', relation: longRelation }]) },
        { name: '周砧', role: 'supporting', relationships: '' },
      ]} />,
    )

    const canvas = container.querySelector('.relation-canvas')
    expect(canvas?.getAttribute('aria-label'))
      .toBe(`角色关系图谱。完整关系：林墨 对 周砧：${longRelation}`)

    useLocaleStore.setState({ locale: 'en-US' })
    await render(
      <Harness characters={[
        { name: '林墨', role: 'protagonist', relationships: JSON.stringify([{ target: '周砧', relation: longRelation }]) },
        { name: '周砧', role: 'supporting', relationships: '' },
      ]} />,
    )
    expect(container.querySelector('.relation-canvas')?.getAttribute('aria-label'))
      .toBe(`Character relationship graph. Full relationships: 林墨 to 周砧: ${longRelation}`)
  })

  it('连线标签按码点截断，长关系不会糊住画布', async () => {
    const longRelation = '长期合作并共同调查校园系统背后的数据操控真相'
    await render(
      <Harness characters={[
        { name: '林墨', role: 'protagonist', relationships: JSON.stringify([{ target: '周砧', relation: longRelation }]) },
        { name: '周砧', role: 'supporting', relationships: '' },
      ]} />,
    )

    const label = container.querySelector('.relation-edge-label-html')
    expect(label?.textContent).toBe('长期合作并共同调查校…')
    expect(label?.textContent).not.toBe(longRelation)
  })

  it('互为对向的关系只画一条连线', async () => {
    await render(
      <Harness characters={[
        { name: '林墨', role: 'protagonist', relationships: JSON.stringify([{ target: '周砧', relation: '共同追查' }]) },
        { name: '周砧', role: 'supporting', relationships: JSON.stringify([{ target: '林墨', relation: '尊重她的执着' }]) },
      ]} />,
    )

    expect(container.querySelectorAll('.relation-edge')).toHaveLength(1)
    expect(container.querySelectorAll('.relation-edge-label-html')).toHaveLength(1)
  })

  it('姓名使用主题正文色、关系标签使用次级文字色', async () => {
    await render(<Harness />)

    // 主视角的名字是朱砂（demo 的 .relation-node.main .name），普通角色才是正文墨色。
    const nameColor = getComputedStyle(nodeFor('李子瞻').querySelector('.name') as HTMLElement).color
    const mainNameColor = getComputedStyle(nodeFor('李莉莉').querySelector('.name') as HTMLElement).color
    const labelColor = getComputedStyle(
      container.querySelector('.relation-edge-label-html') as HTMLElement,
    ).color

    // v2 浅色主题的墨色（--ink #2A261E）与朱砂（--seal #A93226）；
    // 关系标签走 --ink2 的 82% 混色。三条都必须是能读出来的实色 ——
    // 旧 Canvas 实现在 galaxy / dark 主题下曾把姓名画成对比度不足 3:1 的灰蓝，
    // 这套断言就是守它的。
    expect(nameColor).toBe('rgb(42, 38, 30)')
    expect(mainNameColor).toBe('rgb(169, 50, 38)')
    expect(labelColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(labelColor).not.toBe('rgb(0, 0, 0)')
  })
})
