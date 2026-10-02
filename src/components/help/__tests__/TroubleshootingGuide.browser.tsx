import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'
import { useHelpStore } from '../../../stores/help-store'
import { useLocaleStore } from '../../../stores/locale-store'
import TroubleshootingGuide from '../TroubleshootingGuide'

/**
 * 常见错误排查面板的契约：
 *   · 打开就列出条目，能按报错原文 / 关键字 / 错误码搜到；
 *   · 每条都能展开看「你可能会看到 / 为什么 / 怎么办」；
 *   · Esc 与点遮罩都能关掉。
 */
const originalHelpState = useHelpStore.getState()
const originalLocaleState = useLocaleStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function topics(): string[] {
  return Array.from(container.querySelectorAll('[data-help-topic]'))
    .map(node => node.getAttribute('data-help-topic') ?? '')
}

beforeEach(async () => {
  await page.viewport(1000, 800)
  useLocaleStore.setState({ ...originalLocaleState, locale: 'zh-CN', initialized: true })
  useHelpStore.setState({ open: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useHelpStore.setState(originalHelpState)
  useLocaleStore.setState(originalLocaleState)
})

async function render(): Promise<void> {
  await act(async () => root.render(<TroubleshootingGuide />))
}

describe('troubleshooting guide', () => {
  it('lists every topic when it opens', async () => {
    await render()
    expect(topics().length).toBeGreaterThan(10)
    expect(container.textContent).toContain('常见错误排查')
  })

  it('finds an entry by the error text the author actually saw', async () => {
    await render()
    const search = page.getByRole('textbox', { name: '搜索常见错误' })

    // 「长度上限」这条的症状就是产品抛出的原文
    await act(async () => { await search.fill('达到模型最大长度') })
    expect(topics()).toEqual(['length-limit'])
  })

  it('finds an entry by provider error code and by keyword', async () => {
    await render()
    const search = page.getByRole('textbox', { name: '搜索常见错误' })

    await act(async () => { await search.fill('SOURCE_DRAFT_CHANGED') })
    expect(topics()).toContain('source-draft-changed')

    await act(async () => { await search.fill('向量') })
    expect(topics()).toContain('embedding-missing')

    await act(async () => { await search.fill('完全搜不到的东西') })
    expect(topics()).toEqual([])
    expect(container.textContent).toContain('没有匹配的条目')
  })

  it('expands a topic into symptom, cause and fix', async () => {
    await render()

    const header = container.querySelector<HTMLButtonElement>('[data-help-topic="length-limit"] button')!
    await act(async () => { header.click() })

    expect(container.textContent).toContain('你可能会看到')
    expect(container.textContent).toContain('为什么')
    expect(container.textContent).toContain('怎么办')
    // 展开后能看到条目的错误码，便于和界面上的报错对上
    expect(container.textContent).toContain('DEADLINE_EXHAUSTED')
  })

  it('filters by category', async () => {
    await render()
    const chip = container.querySelector<HTMLButtonElement>('[data-help-category="knowledge"]')!
    await act(async () => { chip.click() })

    const ids = topics()
    expect(ids).toContain('embedding-missing')
    expect(ids).not.toContain('length-limit')
  })

  it('closes on Escape and on a click outside the panel', async () => {
    await render()
    expect(container.querySelector('[data-help-panel]')).not.toBeNull()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(useHelpStore.getState().open).toBe(false)

    await act(async () => { useHelpStore.setState({ open: true }) })
    expect(container.querySelector('[data-help-panel]')).not.toBeNull()

    // 点面板外面的遮罩
    const backdrop = container.firstElementChild as HTMLElement
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useHelpStore.getState().open).toBe(false)
  })
})
