import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import { useLocaleStore } from '../../../stores/locale-store'
import PromptSettings from '../PromptSettings'
import { Badge } from '../../ui/Badge'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface TestVelaApi {
  invoke: ReturnType<typeof vi.fn>
  on: () => () => void
  once: () => void
  send: () => void
  setZoomLevel: () => void
  setZoomFactor: () => void
  getZoomLevel: () => number
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  document.documentElement.classList.remove('paper', 'light', 'galaxy', 'dark')
  const { useProjectStore } = await import('../../../stores/project-store')
  useProjectStore.setState({ currentProject: null })
})

describe('PromptSettings readable warning copy', () => {
  it('keeps warning copy readable while retaining the decorative warning semantic in every theme', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'prompt:load-global') return { templates: [], diagnostics: [] }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })
    ;(window as unknown as { velaAPI: TestVelaApi }).velaAPI = {
      invoke,
      on: () => () => {},
      once: () => {},
      send: () => {},
      setZoomLevel: () => {},
      setZoomFactor: () => {},
      getZoomLevel: () => 0,
    }

    useLocaleStore.setState({ locale: 'zh-CN' })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<PromptSettings />))
    await act(async () => {
      await page.getByRole('button', { name: /全文配置生成/ }).click()
      await page.getByRole('textbox').fill('已移除必需变量')
    })

    const warningCopy = Array.from(container.querySelectorAll('span'))
      .find((element) => element.textContent?.includes('以下变量在原模板中使用'))
    const warning = warningCopy?.parentElement
    const warningIcon = warning?.querySelector('svg')
    expect(warning).not.toBeNull()
    expect(warningIcon).not.toBeNull()

    for (const [theme, expectedText, expectedDecoration] of [
      ['light', 'rgb(122, 84, 20)', 'rgb(198, 138, 58)'],
      ['paper', 'rgb(122, 84, 20)', 'rgb(198, 138, 58)'],
      ['galaxy', 'rgb(251, 191, 36)', 'rgb(251, 191, 36)'],
      ['dark', 'rgb(204, 167, 0)', 'rgb(204, 167, 0)'],
    ] as const) {
      container.className = theme
      expect(getComputedStyle(warning!).color, `${theme} warning copy`).toBe(expectedText)
      expect(getComputedStyle(warningIcon!).color, `${theme} warning decoration`).toBe(expectedDecoration)
    }
  })

  it.each([
    ['light', 'rgb(122, 84, 20)'],
    ['paper', 'rgb(122, 84, 20)'],
    ['galaxy', 'rgb(251, 191, 36)'],
    ['dark', 'rgb(204, 167, 0)'],
  ])('renders warning badge copy with readable %s theme text', async (theme, expectedText) => {
    container = document.createElement('div')
    container.className = theme
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<Badge variant="warning">需要处理</Badge>))

    expect(getComputedStyle(container.querySelector('span')!).color).toBe(expectedText)
  })

  it.each([
    ['light', 'rgb(23, 32, 51)'],
    ['paper', 'rgb(34, 29, 23)'],
    ['galaxy', 'rgb(245, 250, 255)'],
    ['dark', 'rgb(250, 250, 250)'],
  ])('maps %s image-skin warning copy to its high-contrast text semantic', async (theme, expectedText) => {
    container = document.createElement('div')
    container.className = theme
    container.dataset.theme = theme
    container.dataset.skinReadability = 'high-contrast'
    container.classList.add('app-skin-root')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<Badge variant="warning">需要处理</Badge>))

    expect(getComputedStyle(container.querySelector('span')!).color).toBe(expectedText)
  })

  it.each([
    ['light', 'rgb(56, 96, 66)', 'rgb(143, 48, 32)'],
    ['paper', 'rgb(56, 96, 66)', 'rgb(143, 48, 32)'],
    ['galaxy', 'rgb(74, 222, 128)', 'rgb(251, 113, 133)'],
    ['dark', 'rgb(137, 209, 133)', 'rgb(255, 138, 138)'],
  ])('renders success and error badge information with readable %s theme semantics', async (theme, successText, errorText) => {
    container = document.createElement('div')
    container.className = theme
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<><Badge variant="success">Success</Badge><Badge variant="error">Error</Badge></>))

    const badges = container.querySelectorAll('span')
    expect(getComputedStyle(badges[0]).color).toBe(successText)
    expect(getComputedStyle(badges[1]).color).toBe(errorText)
  })
})
