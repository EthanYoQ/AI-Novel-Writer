/**
 * 正文栏（v2）标签容器的结构、交互与视觉契约。
 *
 * 这是「UI 新构造」的核心：正文栏不再是「一个视图跟着侧栏选中项走」，
 * 而是浏览器式的标签容器 —— .tabbar / .tabs / .tab 是 demo 的真实 DOM，
 * 外观来自 shell.css 的原生规则，不再依赖穿透 React 内联样式的补丁。
 *
 * 用例同时把渲染结果截图存档（__screenshots__/），用于和 demo 比对。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/redesign/v2-index.css'

import type { ProjectData } from '../../../shared/ipc-channels'
import EditorArea from '../EditorArea'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useUiVersionStore } from '../../../stores/ui-version-store'

const PROJECT_PATH = 'C:\\novels\\v2-tabs'
const originalEditorState = useEditorStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalUiVersionState = useUiVersionStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

function project(): ProjectData {
  return {
    id: 'v2-tabs',
    sessionLease: 'v2-tabs-lease',
    name: '天女伏魔录',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '仙侠',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 10,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

beforeEach(() => {
  // v2 的令牌与覆盖样式挂在 html[data-ui='v2'] 上（Radix Portal 也靠它继承皮肤）
  document.documentElement.setAttribute('data-ui', 'v2')
  document.documentElement.setAttribute('data-v2-theme', 'paper')

  useLocaleStore.setState({ ...originalLocaleState, locale: 'zh-CN' })
  useUiVersionStore.setState({ uiVersion: 'v2' })
  useProjectStore.setState({ currentProject: project(), fileTree: [], loading: false })
  useLayoutStore.setState({
    sidebarView: 'characters',
    activeRailItem: 'characters',
    sidebarOpen: true,
    aiPanelOpen: true,
    focusMode: false,
  })
  useEditorStore.setState({
    tabs: [
      { id: 'draft-6', name: '第 6 章 · 装敛疑云', type: 'outline', content: '纸面正文占位。' },
      { id: 'character-editor', name: '人物档案', type: 'character', projectKey: PROJECT_PATH },
      { id: 'knowledge-editor', name: '知识库', type: 'knowledge', projectKey: PROJECT_PATH },
    ],
    activeTabId: 'draft-6',
    draftLedgers: {},
  })

  container = document.createElement('div')
  container.style.width = '1100px'
  container.style.height = '640px'
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
  useEditorStore.setState(originalEditorState)
  useLayoutStore.setState(originalLayoutState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useUiVersionStore.setState(originalUiVersionState)
})

async function renderEditorArea(): Promise<void> {
  await act(async () => {
    root?.render(<EditorArea onNewProject={() => {}} />)
  })
}

function tabsInDom(): HTMLElement[] {
  return Array.from(container?.querySelectorAll<HTMLElement>('.tabbar > .tabs > .tab') ?? [])
}

async function clickTab(index: number): Promise<void> {
  const tab = tabsInDom()[index]
  if (!tab) throw new Error(`没有第 ${index} 个标签`)
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('v2 正文栏：demo 的 .tabbar 真实 DOM', () => {
  it('标签栏用 demo 的类名结构，而不是内联样式的仿制品', async () => {
    await renderEditorArea()

    const tabbar = container?.querySelector('.tabbar')
    expect(tabbar).toBeTruthy()
    expect(tabbar?.querySelector('.tabs')).toBeTruthy()
    expect(tabbar?.querySelector('.tb-side')).toBeTruthy()

    // demo 的 .tabbar 高度就是 --h-tab:36px
    expect(getComputedStyle(tabbar as HTMLElement).height).toBe('36px')
  })

  it('每个打开的子菜单都出现在标签栏上，且只有一个是激活态', async () => {
    await renderEditorArea()

    const labels = tabsInDom().map((tab) => tab.querySelector('.tn')?.textContent)
    expect(labels).toContain('第 6 章 · 装敛疑云')
    expect(labels).toContain('人物档案')
    expect(labels).toContain('知识库')
    // 「打开项目即自动开小说配置」是产品既有行为，换壳不改 —— 它同样以标签形式出现
    expect(labels).toContain('小说配置')

    const active = tabsInDom().filter((tab) => tab.classList.contains('on'))
    expect(active).toHaveLength(1)
  })

  it('正文栏有 demo 的 .edit-body 语义容器，标签栏在其上方', async () => {
    await renderEditorArea()

    const page_ = container?.querySelector('.skin-workspace-page')
    const tabbar = page_?.querySelector(':scope > .tabbar')
    const editBody = page_?.querySelector(':scope > .edit-body')

    expect(tabbar).toBeTruthy()
    expect(editBody).toBeTruthy()
    if (!tabbar || !editBody) throw new Error('正文栏缺少 .tabbar 或 .edit-body')
    // 标签栏紧挨在正文容器上方：结构与 demo 的 .editor > .tabbar + .edit-body 一致
    expect(tabbar.nextElementSibling).toBe(editBody)
  })
})

describe('v2 正文栏：点页签换纸面并把侧栏语境带过去', () => {
  it('切到人物档案：纸面换人，左侧高亮跟着走到「人物」', async () => {
    await renderEditorArea()

    await clickTab(tabsInDom().findIndex((tab) => tab.textContent?.includes('人物档案')))

    expect(useEditorStore.getState().activeTabId).toBe('character-editor')
    expect(useLayoutStore.getState().activeRailItem).toBe('characters')
  })

  it('切到知识库：知识库是标签，不再盖住标签栏', async () => {
    await renderEditorArea()

    await clickTab(tabsInDom().findIndex((tab) => tab.textContent?.includes('知识库')))

    expect(useEditorStore.getState().activeTabId).toBe('knowledge-editor')
    expect(useLayoutStore.getState().sidebarView).toBe('knowledge')
    // 标签栏始终在：知识库页也必须有页签
    expect(container?.querySelector('.tabbar')).toBeTruthy()
  })

  it('未保存标记挂在 .tx 上，悬停才换成 ×', async () => {
    useEditorStore.setState((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === 'character-editor' ? { ...tab, dirty: true } : tab)),
    }))
    await renderEditorArea()

    const dirtyTab = tabsInDom().find((tab) => tab.textContent?.includes('人物档案'))
    const close = dirtyTab?.querySelector('.tx')
    expect(close?.getAttribute('data-dirty')).toBe('true')
    expect(close?.querySelector('.tx-dot')).toBeTruthy()
    expect(close?.querySelector('.tx-x')).toBeTruthy()
  })
})

describe('v2 正文栏：截图存档', () => {
  it('渲染一份整屏标签栏供与 demo 比对', async () => {
    await page.viewport(1100, 640)
    await renderEditorArea()
    // 产物落在仓库根的 artifacts/（不进版本库）
    await page.screenshot({ path: '../../../../artifacts/v2-editor-tabs.png' })
  })

  it('单独截标签栏一条，尺寸与 demo 的 #tabbar 一致，可逐像素比对', async () => {
    await page.viewport(1100, 640)
    // demo 在 1100 视口下，正文栏被「书脊 60 + 侧栏 258 + 助手 302 + 两条 grip」挤到 472px，
    // 这里把容器对齐成同一个宽度，两张标签栏才能逐像素比。
    if (container) container.style.width = '472px'
    await renderEditorArea()

    const tabbar = container?.querySelector('.tabbar')
    const box = tabbar?.getBoundingClientRect()
    expect(box).toBeTruthy()
    expect(Math.round(box?.height ?? 0)).toBe(36)

    await page.screenshot({ path: '../../../../artifacts/v2-tabbar-at-demo-width.png' })
  })
})
