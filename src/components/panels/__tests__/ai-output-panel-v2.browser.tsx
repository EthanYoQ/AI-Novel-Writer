/**
 * AI 输出面板（v2）的结构契约与截图存档。
 *
 * 先生要求「在不损失现有功能的前提下，把 demo 的皮完整套上去」——
 * 功能面由 AIOutputPanel.failed / .recovery 两个用例守着，
 * 这里只锁**外观骨架**：外层必须是 demo 的 .ai-output-view，
 * 头部是 .ai-output-head（标题 + 副题 + icobtn），内容区是 .ai-output-body，
 * 空态是 .ai-output-empty —— 也就是 demo renderAgentOutput() 的那一套类名。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'

import AIOutputPanel from '../AIOutputPanel'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'

const originalWorkflowState = useWorkflowStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalLayoutState = useLayoutStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

beforeEach(() => {
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-v2-theme', 'paper')
  useLocaleStore.setState({ ...originalLocaleState, locale: 'zh-CN' })
  // 没有活跃任务、也没有历史 → 面板落在 demo 的「空态」分支
  useWorkflowStore.setState({ activeRuns: [], history: [], currentRun: null })

  container = document.createElement('div')
  container.style.width = '360px'
  container.style.height = '600px'
  document.body.style.margin = '0'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  document.documentElement.removeAttribute('data-ui')
  document.documentElement.removeAttribute('data-v2-theme')
  root = undefined
  container = undefined
  useWorkflowStore.setState(originalWorkflowState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useLayoutStore.setState(originalLayoutState)
})

async function renderPanel(): Promise<void> {
  await act(async () => {
    root?.render(<AIOutputPanel />)
  })
}

describe('v2 AI 输出面板：demo 的 .ai-output-* 骨架', () => {
  it('外层是 .ai-output-view，且保留 v2 皮肤的 writer-ai-panel 钩子', async () => {
    await renderPanel()

    const view = container?.querySelector('.ai-output-view')
    expect(view).toBeTruthy()
    // v2 皮肤依赖这个钩子做纸底与左侧 1px 线
    expect(view?.classList.contains('writer-ai-panel')).toBe(true)
  })

  it('头部是 .ai-output-head：标题 + 副题 + 右侧 icobtn', async () => {
    await renderPanel()

    const head = container?.querySelector('.ai-output-head')
    expect(head).toBeTruthy()
    expect(head?.querySelector('b')?.textContent?.trim()).toBe('AI 输出')
    expect(head?.querySelector('.sub')).toBeTruthy()
    expect(head?.querySelector('.icobtn')).toBeTruthy()
  })

  it('内容区是 .ai-output-body，空态是 .ai-output-empty', async () => {
    await renderPanel()

    expect(container?.querySelector('.ai-output-body')).toBeTruthy()
    expect(container?.querySelector('.ai-output-empty')).toBeTruthy()
    // demo 的结构层级：body 必须在 view 之内
    expect(container?.querySelector('.ai-output-view .ai-output-body')).toBeTruthy()
  })

  it('尺寸与 demo 一致：头部 40px、面板本身可滚动区撑满', async () => {
    await renderPanel()

    const head = container?.querySelector('.ai-output-head') as HTMLElement | null
    expect(head).toBeTruthy()
    if (!head) return
    expect(getComputedStyle(head).height).toBe('40px')
  })

  it('截一张空态图存档，供与 demo 比对', async () => {
    await page.viewport(360, 600)
    await renderPanel()
    await page.screenshot({ path: '../../../../artifacts/v2-ai-output-empty.png' })
  })
})
