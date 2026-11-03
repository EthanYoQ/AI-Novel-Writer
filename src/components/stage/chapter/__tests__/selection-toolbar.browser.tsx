import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLocaleStore } from '../../../../stores/locale-store'
import { useThemeStore } from '../../../../stores/theme-store'
import CodeMirrorEditor from '../../../editor/CodeMirrorEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalTheme = useThemeStore.getState()
let root: Root | undefined
let host: HTMLDivElement | undefined

const LONG = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段：雨从傍晚开始就没有停过。`).join('\n\n')

beforeEach(async () => {
  await page.viewport(1280, 900)
  useLocaleStore.setState({ locale: 'zh-CN' })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  useThemeStore.setState(originalTheme, true)
})

async function mount(node: React.ReactNode, style: string) {
  host = document.createElement('div')
  host.style.cssText = style
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
}

const toolbar = () => document.querySelector<HTMLElement>('[role="toolbar"]')

describe('选区工具条', () => {
  it('旧外壳里没有纸墨作用域时自带纸墨令牌与深色主题，五个操作是纸墨按钮', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' })
    await mount(<CodeMirrorEditor content="原文段落" mode="prose" />, 'height:400px')
    await act(async () => page.getByText('原文段落').click({ clickCount: 3 }))
    await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' })).toBeVisible()
    const bar = toolbar()!
    expect([bar.classList.contains('paper-ink'), bar.dataset.theme]).toEqual([true, 'dark'])
    expect([...bar.querySelectorAll('button')].map(button => [button.textContent, button.classList.contains('pi-btn')]))
      .toEqual([['润色', true], ['扩写', true], ['续写', true], ['改成对话', true], ['按意见改', true]])
    expect(getComputedStyle(bar).backgroundColor).toBe('rgb(24, 24, 28)')
  })

  it('编辑器随内容长高、由外层纸面滚动时，选区滚出纸面可见范围后工具条收起', async () => {
    await mount(
      <div data-testid="scroller" style={{ height: 300, overflow: 'auto' }}>
        <CodeMirrorEditor content={LONG} mode="prose" fitContent />
      </div>,
      'height:300px',
    )
    const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!
    expect(scroller.scrollHeight).toBeGreaterThan(1000)
    await act(async () => page.getByText('第 1 段：雨从傍晚开始就没有停过。').click({ clickCount: 3 }))
    await expect.element(page.getByRole('toolbar', { name: '选中文字的操作' })).toBeVisible()
    await act(async () => {
      scroller.scrollTop = 1200
      scroller.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => toolbar()).toBeNull()
  })
})
