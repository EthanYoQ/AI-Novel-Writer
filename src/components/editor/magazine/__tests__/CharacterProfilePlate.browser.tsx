import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../../index.css'
import '../../../../styles/redesign/v2-index.css'
import '../../../../styles/magazine/mag-index.css'
import { useLocaleStore } from '../../../../stores/locale-store'
import CharacterProfilePlate from '../CharacterProfilePlate'

/**
 * 肖像框 · 契约测试（v3「时尚杂志」）。
 *
 * 先生：「你把我的角色头像那弄没了？你可以设置一个符合杂志感觉的新头像，
 * 设置弄新的头像交互谱。**但不能把我本来的功能给阉割掉了。**」
 *
 * 所以这个文件盯的不是好不好看，是**功能一条都不能少**：
 *   ① 有自定义头像就显示图、没有就回落姓名首字（原行为）
 *   ② 换头像入口只在编辑态出现（原权限规则：阅览态不给入口）
 *   ③ 忙碌时按钮 disabled 且 aria-busy（原行为）
 *   ④ 点一下真的回调（原行为）
 * 另外钉住 v2 的分家：v2 下这套记号一个都不出（v2 仍是自己的 75px 圆头像）。
 */
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLocaleState = useLocaleStore.getState()

let container: HTMLDivElement
let root: Root

function props(overrides: Record<string, unknown> = {}) {
  return {
    name: '布兰·史塔克',
    roleName: '主角',
    roleKind: 'protagonist',
    updatedAtChapter: 2,
    relationships: JSON.stringify([{ target: '艾莉亚', relation: '兄妹' }]),
    rosterNames: ['布兰·史塔克', '艾莉亚'],
    avatarUrl: null as string | null,
    avatarInitial: '布',
    avatarBusy: false,
    canChooseAvatar: true,
    onChooseAvatar: () => {},
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
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  container = document.createElement('div')
  /**
   * 挂载点做成编辑区那一层：`data-sec` 决定 `--mag-sec`（当前栏目色），
   * 肖像框、角标、覆盖层全都取这个值 —— 不给它，量到的就是透明。
   */
  container.className = 'editor'
  container.setAttribute('data-sec', '3')
  container.setAttribute('data-sec-no', '03')
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

describe('肖像框 · 杂志版式', () => {
  it('方框 + 墨线外框，尺寸比 v2 的 75px 圆头像更大', async () => {
    await render(<CharacterProfilePlate {...props()} />)
    const portrait = container.querySelector('.mag-plate .mp-portrait') as HTMLElement
    expect(portrait).not.toBeNull()

    const style = getComputedStyle(portrait)
    expect(style.borderRadius).toBe('0px')
    expect(style.borderTopWidth).toBe('2px')
    expect(parseFloat(style.width)).toBeGreaterThanOrEqual(90)
    expect(style.width).toBe(style.height)
  })

  it('没有自定义头像时回落姓名首字，并取当前栏目色', async () => {
    await render(<CharacterProfilePlate {...props()} />)
    const initial = container.querySelector('.mp-portrait-initial') as HTMLElement
    expect(initial.textContent).toBe('布')
    expect(parseFloat(getComputedStyle(initial).fontSize)).toBeGreaterThanOrEqual(40)
  })

  it('有自定义头像时渲染图片而不是首字', async () => {
    await render(<CharacterProfilePlate {...props({ avatarUrl: 'vela://avatar/1.png' })} />)
    expect(container.querySelector('.mp-portrait img')).not.toBeNull()
    expect(container.querySelector('.mp-portrait-initial')).toBeNull()
  })

  it('角标：杂志图片的印记（静默提示「这块能点」）', async () => {
    await render(<CharacterProfilePlate {...props()} />)
    const corner = container.querySelector('.mp-portrait-corner') as HTMLElement
    expect(corner).not.toBeNull()
    expect(getComputedStyle(corner).backgroundColor).toBe('rgb(168, 132, 47)')
  })
})

describe('肖像框 · 功能一条都不能少', () => {
  it('编辑态：换头像入口在，且带自绘图标与字样（不再是看不见的一块透明层）', async () => {
    await render(<CharacterProfilePlate {...props({ canChooseAvatar: true })} />)
    const hit = container.querySelector('.mp-portrait-hit') as HTMLButtonElement
    expect(hit).not.toBeNull()
    expect(hit.disabled).toBe(false)
    // 自绘图标：前框实心、后框描边（「原来的照片」与「换上的照片」）
    expect(hit.querySelector('.mp-swap-front')).not.toBeNull()
    expect(hit.querySelector('.mp-swap-back')).not.toBeNull()
    expect(hit.querySelector('.mp-portrait-label')?.textContent).toBe('更换头像')
  })

  it('阅览态：一个入口都不出（原权限规则不变）', async () => {
    await render(<CharacterProfilePlate {...props({ canChooseAvatar: false })} />)
    expect(container.querySelector('.mp-portrait-hit')).toBeNull()
    // 头像本身照常显示 —— 收起的是入口，不是头像
    expect(container.querySelector('.mp-portrait')).not.toBeNull()
  })

  it('忙碌时按钮 disabled 且声明 aria-busy（原行为）', async () => {
    await render(<CharacterProfilePlate {...props({ avatarBusy: true })} />)
    const hit = container.querySelector('.mp-portrait-hit') as HTMLButtonElement
    expect(hit.disabled).toBe(true)
    expect(hit.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('.mp-portrait-label')?.textContent).toBe('处理中')
  })

  it('点一下真的回调（原行为）', async () => {
    const onChooseAvatar = vi.fn()
    await render(<CharacterProfilePlate {...props({ onChooseAvatar })} />)
    const hit = container.querySelector('.mp-portrait-hit') as HTMLButtonElement
    await act(async () => {
      hit.click()
    })
    expect(onChooseAvatar).toHaveBeenCalledTimes(1)
  })
})

describe('肖像框 · 分家', () => {
  it('这份版式只在 v3 生效：v2 下肖像框没有任何 mag 层样式', async () => {
    document.documentElement.removeAttribute('data-mag')
    await render(<CharacterProfilePlate {...props()} />)
    const portrait = container.querySelector('.mag-plate .mp-portrait') as HTMLElement
    // v2 下这些规则都不匹配：没有墨线外框、也不锁尺寸
    expect(getComputedStyle(portrait).borderTopWidth).toBe('0px')
  })
})
