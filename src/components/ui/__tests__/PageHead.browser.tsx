import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'
import '../../../styles/magazine/mag-index.css'
import { useLocaleStore } from '../../../stores/locale-store'
import { useUiVersionStore } from '../../../stores/ui-version-store'
import PageHead from '../PageHead'

/**
 * 浮层页头 · 真渲染契约。
 *
 * 全站 9 处浮层页头（新建项目 / 导入小说 / 退出确认 / 三个角色卡对话框 /
 * 两个设定候选对话框 / 侧栏设定面板）都挂这一个组件，所以它的分家必须钉死：
 *
 *   v2「墨纸书斋」→ 旧的 `.pagehead`（逐像素不变）
 *   v3「时尚杂志」→ **紧凑铭牌** `.mag-plate.is-compact`
 *                    （左缘色标 + 眉标 + 标题 + 说明 + 操作组；
 *                      竖排英文名、徽记、期刊化大数字**一律不出现** —— 那是页面级的排场）
 */
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalLocaleState = useLocaleStore.getState()

let container: HTMLDivElement
let root: Root

function props(overrides: Record<string, unknown> = {}) {
  return {
    kicker: 'CAST · 导入角色卡',
    title: '导入角色卡',
    description: '从资料里提取角色卡，逐个确认后再写入档案',
    ...overrides,
  }
}

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

beforeEach(async () => {
  await page.viewport(1000, 800)
  useLocaleStore.setState({ ...originalLocaleState, locale: 'zh-CN', initialized: true })
  useUiVersionStore.setState({ uiVersion: 'v3' })
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-mag', '1')
  document.documentElement.setAttribute('data-v2-theme', '0')

  container = document.createElement('div')
  container.className = 'editor'
  container.setAttribute('data-sec', '3')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  /**
   * **必须把全局 store 恢复原状**。
   *
   * 浏览器测试是同一个浏览器实例里顺序跑所有文件的（`fileParallelism: false`），
   * 这里把 uiVersion 设成 v3 却不还原，后面每个测试文件都会在 v3 下跑 ——
   * 实测代价：真渲染全量里凭空多出 4 个「英文渲染 / 分隔符」的失败。
   */
  useUiVersionStore.setState({ uiVersion: 'v2' })
  useLocaleStore.setState(originalLocaleState)
  for (const name of ['data-mag', 'data-ui', 'data-v2-theme']) {
    document.documentElement.removeAttribute(name)
  }
})

describe('v3 · 紧凑铭牌', () => {
  it('眉标 / 标题 / 说明 / 操作组四件都在', async () => {
    await render(<PageHead {...props({ actions: <button type="button">导入</button> })} />)

    const plate = container.querySelector('.mag-plate.is-compact')
    expect(plate).not.toBeNull()
    expect(plate?.querySelector('.mp-kicker')?.textContent).toBe('CAST · 导入角色卡')
    expect(plate?.querySelector('.mp-name')?.textContent).toBe('导入角色卡')
    expect(plate?.querySelector('.mp-lede')?.textContent)
      .toBe('从资料里提取角色卡，逐个确认后再写入档案')
    expect(plate?.querySelector('.mp-actions button')?.textContent).toBe('导入')
  })

  it('页面级的那套排场一律不出现（竖排栏目名 / 徽记 / 大数字）', async () => {
    await render(<PageHead {...props()} />)
    expect(container.querySelector('.mp-spine')).toBeNull()
    expect(container.querySelector('.mp-sigil')).toBeNull()
    expect(container.querySelector('.mp-chapter')).toBeNull()
  })

  it('尺寸比页面级轻一档：标题 22px、收口线 1px', async () => {
    await render(<PageHead {...props()} />)
    const name = container.querySelector('.mag-plate.is-compact .mp-name') as HTMLElement
    expect(parseFloat(getComputedStyle(name).fontSize)).toBeLessThanOrEqual(24)

    const plate = container.querySelector('.mag-plate.is-compact') as HTMLElement
    expect(getComputedStyle(plate).borderBottomWidth).toBe('1px')
  })

  it('左缘一道栏目色竖条（代替徽记，省掉 26px 宽度）', async () => {
    await render(<PageHead {...props()} />)
    const plate = container.querySelector('.mag-plate.is-compact') as HTMLElement
    const bar = getComputedStyle(plate, '::before')
    expect(bar.width).toBe('3px')
    // 对话框里 --mag-sec 不在继承链上时会回落到全站强调色
    expect(bar.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  })

  it('没有说明时也不塌（说明是可选的）', async () => {
    await render(<PageHead kicker="CAST · 合并角色卡" title="合并角色卡" />)
    expect(container.querySelector('.mag-plate.is-compact .mp-lede')).toBeNull()
    expect(container.querySelector('.mag-plate.is-compact .mp-name')?.textContent).toBe('合并角色卡')
  })

  it('descriptionRich 仍按语言选择节点（原来那套双语逻辑没丢）', async () => {
    await render(
      <PageHead
        {...props({ description: undefined })}
        descriptionRich={{ zhCN: <>以「<b>布兰</b>」为中心</>, enUS: <>Centred on <b>Bran</b></> }}
      />,
    )
    expect(container.querySelector('.mp-lede b')?.textContent).toBe('布兰')
  })

  it('children（状态徽标之类）仍有位置', async () => {
    await render(
      <PageHead {...props()}>
        <span className="badge">就绪</span>
      </PageHead>,
    )
    expect(container.querySelector('.mag-plate.is-compact .badge')?.textContent).toBe('就绪')
  })
})

describe('v2 / v1 · 原路径', () => {
  it('v2 走旧的 .pagehead，一个铭牌节点都不出现', async () => {
    useUiVersionStore.setState({ uiVersion: 'v2' })
    await render(<PageHead {...props()} />)

    expect(container.querySelector('.pagehead')).not.toBeNull()
    expect(container.querySelector('.ph-k')?.textContent).toBe('CAST · 导入角色卡')
    expect(container.querySelector('.mag-plate')).toBeNull()
  })

  it('v1 经典界面走简单标题路径（不套 .pagehead 三段式）', async () => {
    useUiVersionStore.setState({ uiVersion: 'v1' })
    await render(<PageHead {...props()} />)

    expect(container.querySelector('h2')).not.toBeNull()
    expect(container.querySelector('.pagehead')).toBeNull()
    expect(container.querySelector('.mag-plate')).toBeNull()
  })
})
