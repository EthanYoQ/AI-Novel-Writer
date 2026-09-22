import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useOnboardingStore } from '../../../stores/onboarding-store'
import { useProjectStore } from '../../../stores/project-store'
import QuickStartGuide from '../QuickStartGuide'

/**
 * 新手引导的交互契约：
 *   · 每一步都能跳过（单步跳过 / 跳过全部），从不拦着作者干活；
 *   · 动作按钮只把界面开到该去的地方，**不推进步骤** —— 操作完回来接着讲；
 *   · 需要作品才能实施的动作，在还没有作品时把作者送回「建立作品」那一步。
 */
const PROJECT_PATH = 'C:\\novels\\quick-start'
const originalLayoutState = useLayoutStore.getState()
const originalEditorState = useEditorStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalOnboardingState = useOnboardingStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function project(): ProjectData {
  return {
    id: 'quick-start',
    sessionLease: 'quick-start-lease',
    name: 'Quick start',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '', subGenre: '', targetAudience: '', totalChapters: 12, wordsPerChapter: 2500,
      plotStructure: 'three_act', narrativePOV: 'third_limited',
      coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '', createdAt: '', updatedAt: '',
  }
}

/** 当前显示的是哪一步。 */
function currentStep(): string | null {
  return container.querySelector('[data-quick-start-step]')?.getAttribute('data-quick-start-step') ?? null
}

async function renderGuide(): Promise<void> {
  await act(async () => root.render(<QuickStartGuide />))
}

beforeEach(async () => {
  await page.viewport(900, 700)
  useLayoutStore.setState(originalLayoutState)
  useEditorStore.setState({ ...originalEditorState, tabs: [], activeTabId: null })
  useLocaleStore.setState({ ...originalLocaleState, locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ ...originalProjectState, currentProject: null })
  useOnboardingStore.setState({
    ...originalOnboardingState,
    status: 'pending',
    open: true,
    // 既有用例讲的是「我想自己写」那条线；路线选择屏另有专门用例覆盖。
    track: 'self',
    stepIndex: 0,
    skippedSteps: [],
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useLayoutStore.setState(originalLayoutState)
  useEditorStore.setState(originalEditorState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useOnboardingStore.setState(originalOnboardingState)
  vi.restoreAllMocks()
})

describe('quick start guide', () => {
  it('asks the author to choose between writing and importing before any step', async () => {
    useOnboardingStore.setState({ ...useOnboardingStore.getState(), track: 'choose' })
    await renderGuide()

    expect(currentStep()).toBe('choose')
    expect(container.textContent).toContain('我想自己写')
    expect(container.textContent).toContain('我想导入小说')
    // 选择屏不算步骤：这里不该出现「第 x / N 步」。
    expect(container.textContent).not.toContain('第 1 /')
  })

  it('routes the import path through both model settings in order', async () => {
    useOnboardingStore.setState({ ...useOnboardingStore.getState(), track: 'choose' })
    await renderGuide()

    await act(async () => { await page.getByRole('button', { name: /我想导入小说/ }).click() })

    expect(useOnboardingStore.getState().track).toBe('import')
    expect(currentStep()).toBe('import-intro')
    // 第一步是纯讲解，不该弹出任何面板。
    expect(useLayoutStore.getState().settingsOpen).toBe(false)

    await act(async () => { await page.getByRole('button', { name: '下一步' }).click() })
    expect(currentStep()).toBe('import-models')

    await act(async () => { await page.getByRole('button', { name: '下一步' }).click() })
    // 「配置主模型」这一步进来就把设置开到「AI 生成模型」栏。
    expect(currentStep()).toBe('import-llm')
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(useLayoutStore.getState().settingsSection).toBe('llm')

    await act(async () => { await page.getByRole('button', { name: '下一步' }).click() })
    // 紧接着切到「向量模型」栏 —— 两者是同一个设置窗口里的两栏。
    expect(currentStep()).toBe('import-embedding')
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(useLayoutStore.getState().settingsSection).toBe('embedding')
  })

  it('explains what each of the two models does for an import', async () => {
    useOnboardingStore.setState({
      ...useOnboardingStore.getState(),
      track: 'import',
      stepIndex: 1,
    })
    await renderGuide()

    expect(currentStep()).toBe('import-models')
    // 这条线最要紧的一屏：主模型管拆解、向量模型管检索，分工必须写清楚。
    expect(container.textContent).toContain('AI 生成模型')
    expect(container.textContent).toContain('向量模型')
    expect(container.textContent).toContain('检索')
  })

  it('keeps the writing path untouched when that option is picked', async () => {
    useOnboardingStore.setState({ ...useOnboardingStore.getState(), track: 'choose' })
    await renderGuide()

    await act(async () => { await page.getByRole('button', { name: /我想自己写/ }).click() })

    expect(useOnboardingStore.getState().track).toBe('self')
    expect(currentStep()).toBe('welcome')
  })

  it('points at the real element on screen and lists the model settings steps', async () => {
    // 模拟界面上的「模型胶囊」：引导应当把高亮环套在它身上，而不是固定在屏幕中间。
    const anchor = document.createElement('div')
    anchor.setAttribute('data-tour', 'model-pill')
    anchor.style.cssText = 'position:fixed;left:120px;top:40px;width:160px;height:28px'
    document.body.append(anchor)

    useOnboardingStore.setState({ ...useOnboardingStore.getState(), stepIndex: 1 })
    await renderGuide()

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-quick-start-anchor]')).not.toBeNull()
      }, { timeout: 3000 })
    })
    const ring = container.querySelector<HTMLElement>('[data-quick-start-anchor]')!
    // 高亮环套住目标并外扩 4px
    expect(ring.style.left).toBe('116px')
    expect(ring.style.top).toBe('36px')
    expect(ring.style.width).toBe('168px')
    // 模型这一步要给出一份照着做的分步清单
    expect(container.querySelectorAll('ol li').length).toBeGreaterThanOrEqual(5)

    anchor.remove()
  })

  it('draws its own mark instead of borrowing the product seal', async () => {
    await renderGuide()
    const card = container.querySelector('[data-quick-start-step="welcome"]')!
    expect(card.querySelector('svg')).not.toBeNull()
    expect(card.querySelector('img')).toBeNull()
  })

  it('can be dragged out of the way', async () => {
    await renderGuide()
    const card = container.querySelector<HTMLElement>('[data-quick-start-step="welcome"]')!
    const before = card.style.left
    const header = card.firstElementChild as HTMLElement

    await act(async () => {
      header.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 400, clientY: 300 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 460, clientY: 340 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    // 拖动整张卡片（顶部一行是把手）：位置随之改变，作者可以把它挪开。
    expect(card.style.left).not.toBe(before)
  })

  it('starts on the welcome step and walks forward and back', async () => {
    await renderGuide()
    expect(currentStep()).toBe('welcome')

    await act(async () => { await page.getByRole('button', { name: '下一步' }).click() })
    expect(currentStep()).toBe('model')

    await act(async () => { await page.getByRole('button', { name: '上一步' }).click() })
    expect(currentStep()).toBe('welcome')
  })

  it('skips a single step and remembers that it was skipped', async () => {
    await renderGuide()
    await act(async () => { await page.getByRole('button', { name: '跳过这一步' }).click() })

    expect(currentStep()).toBe('model')
    expect(useOnboardingStore.getState().skippedSteps).toEqual([0])
    expect(container.textContent).toContain('已跳过 1 步')
  })

  it('automatically opens the model settings as soon as the model step is reached', async () => {
    await renderGuide()
    await act(async () => { await page.getByRole('button', { name: '下一步' }).click() })

    expect(currentStep()).toBe('model')
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(useLayoutStore.getState().settingsSection).toBe('llm')
  })

  it('closes that modal again on the way to the next step, and opens the next one', async () => {
    await renderGuide()
    await act(async () => { await page.getByRole('button', { name: '下一步' }).click() })
    expect(useLayoutStore.getState().settingsOpen).toBe(true)

    await act(async () => { await page.getByRole('button', { name: '下一步' }).click() })

    expect(currentStep()).toBe('project')
    // 离开模型那一步要把设置收起来，免得后面几步一直被面板压着……
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
    // ……而「建立作品」这一步进来就把新建项目对话框弹出来。
    expect(useLayoutStore.getState().newProjectOpen).toBe(true)
  })

  it('keeps the manual button as a fallback after the author closed the panel', async () => {
    await renderGuide()
    await act(async () => { await page.getByRole('button', { name: '下一步' }).click() })
    await act(async () => { useLayoutStore.getState().closeSettings() })
    expect(useLayoutStore.getState().settingsOpen).toBe(false)

    await act(async () => { await page.getByRole('button', { name: '打开模型设置' }).click() })

    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    // 点按钮只把面板打开，不推进步骤。
    expect(currentStep()).toBe('model')
  })

  it('finishes on the last step and never auto-opens again', async () => {
    // 最后一步要打开目录，所以先给一个项目；否则它会（按设计）先弹回「建立作品」。
    useProjectStore.setState({ ...originalProjectState, currentProject: project() })
    // 「我想自己写」这条线现在是 8 步（welcome / model / project / config / arch /
    // arch-generate / blueprint / write），最后一步的下标是 7。
    useOnboardingStore.setState({ ...useOnboardingStore.getState(), stepIndex: 7 })
    await renderGuide()

    await act(async () => { await page.getByRole('button', { name: '完成' }).click() })

    expect(useOnboardingStore.getState().status).toBe('completed')
    expect(useOnboardingStore.getState().open).toBe(false)
    expect(container.querySelector('[data-quick-start-step]')).toBeNull()
  })

  it('closes the whole guide from the top-right corner', async () => {
    await renderGuide()
    await act(async () => { await page.getByTitle('跳过全部，不再自动出现').click() })

    expect(useOnboardingStore.getState().status).toBe('skipped')
    expect(useOnboardingStore.getState().open).toBe(false)
  })

  it('returns to creating a project automatically when a step needs one', async () => {
    useOnboardingStore.setState({ ...useOnboardingStore.getState(), stepIndex: 4 })
    await renderGuide()

    // 还没有作品：进入「故事架构」这一步会自己回到「建立作品」，而不是打开一个空编辑器。
    await act(async () => {
      await vi.waitFor(() => expect(currentStep()).toBe('project'), { timeout: 3000 })
    })
    // 此时「建立作品」的自动动作已经把新建项目对话框弹了出来。
    expect(useLayoutStore.getState().newProjectOpen).toBe(true)
  })

  it('opens the architecture editor automatically once a project exists', async () => {
    useProjectStore.setState({ ...originalProjectState, currentProject: project() })
    useOnboardingStore.setState({ ...useOnboardingStore.getState(), stepIndex: 4 })
    await renderGuide()

    await act(async () => {
      await vi.waitFor(() => {
        expect(useEditorStore.getState().tabs.some(tab => tab.type === 'world-building')).toBe(true)
      })
    })
    expect(currentStep()).toBe('arch')
  })
})
