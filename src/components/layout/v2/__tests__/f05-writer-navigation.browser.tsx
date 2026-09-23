/* eslint-disable react-refresh/only-export-components */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import ShellV2 from '../ShellV2'
import LeftToolWindowBar from '../../LeftToolWindowBar'
import StatusBar from '../../StatusBar'
import EditorArea from '../../../panels/EditorArea'
import SettingsModal from '../../../settings/SettingsModal'
import { useAppearanceStore } from '../../../../stores/appearance-bootstrap'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { ProjectData } from '../../../../shared/ipc-channels'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalAppearance = useAppearanceStore.getState()
const originalEditor = useEditorStore.getState()
const originalLayout = useLayoutStore.getState()
const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()
const originalBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
const project = { id: 'f05', name: '雨夜来信', path: 'C:/f05/rain', sessionLease: 'f05-lease', novelConfig: {} } as ProjectData

let host: HTMLDivElement
let root: Root

function WriterFixture({ editor = <p>写作区</p> }: { editor?: React.ReactNode }) {
  const settingsOpen = useLayoutStore(state => state.settingsOpen)
  const closeSettings = useLayoutStore(state => state.closeSettings)
  return <>
    <ShellV2 presentation="writer" theme="paper" titleBar={<p>雨夜来信</p>}
      rail={<LeftToolWindowBar />} sidebar={<p>作品资料</p>} editor={editor}
      aiPanel={<textarea aria-label="助手输入" defaultValue="未发送的问题" />}
      bottom={<p>任务与日志</p>} statusBar={<StatusBar />} />
    <SettingsModal open={settingsOpen} onClose={closeSettings} />
  </>
}

async function render(editor?: React.ReactNode) {
  await act(async () => root.render(<WriterFixture editor={editor} />))
  expect(host.querySelector('[data-shell-presentation="writer"]')).toBeTruthy()
}

async function click(button: HTMLElement | null) {
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}

beforeEach(() => {
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: {
    invoke: vi.fn(async (channel: string) => channel === 'llm:list-models' ? [] : { success: true }),
    on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(),
  } })
  useAppearanceStore.setState({ resolvedShell: 'writer' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project', sidebarOpen: true,
    settingsOpen: false, settingsSection: 'llm', aiPanelOpen: true, bottomPanelOpen: true })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: null, recentProjects: [] })
  host = document.createElement('div')
  host.style.height = '800px'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useAppearanceStore.setState(originalAppearance, true)
  useEditorStore.setState(originalEditor, true)
  useLayoutStore.setState(originalLayout, true)
  useLocaleStore.setState(originalLocale, true)
  useProjectStore.setState(originalProject, true)
  if (originalBridge) Object.defineProperty(window, 'aiNovelAPI', originalBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('U03.A01 Writer 侧栏设置按钮打开真实设置页', async () => {
  await render()
  await click(host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="设置"]'))
  expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'llm' })
  expect(host.querySelector('h2')?.textContent).toBe('AI 生成模型')
})

it('U03.A02 Writer 状态栏模型入口打开真实设置页', async () => {
  await render()
  await click(host.querySelector<HTMLButtonElement>('.writer-statusbar [title="点击配置模型"]'))
  expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'llm' })
  expect(host.querySelector('h2')?.textContent).toBe('AI 生成模型')
})

it('U07.A01 Writer 首页和小说栏目从真实侧栏进入（部分证据）', async () => {
  await render(<EditorArea onNewProject={vi.fn()} />)
  await click(host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="欢迎页"]'))
  expect(useLayoutStore.getState()).toMatchObject({ sidebarView: 'home', activeRailItem: 'home' })
  expect(host.textContent).toContain('写作书房')
  await click(host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="小说"]'))
  expect(useLayoutStore.getState()).toMatchObject({ sidebarView: 'knowledge', activeRailItem: 'knowledge' })
})

it('U07.A01 Writer 世界观入口打开当前核心的故事架构编辑器', async () => {
  useProjectStore.setState({ currentProject: project })
  await render()
  await click(host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="世界观"]'))
  expect(useLayoutStore.getState()).toMatchObject({ sidebarView: 'project', activeRailItem: 'world' })
  const activeTab = useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)
  expect(activeTab).toMatchObject({ name: '故事架构', type: 'world-building', projectKey: project.path })
  expect(activeTab?.id).toMatch(/^world-building-editor:/)
})

it('U15.A01 Writer 版本历史入口打开当前项目的版本历史', async () => {
  useProjectStore.setState({ currentProject: project })
  await render(<EditorArea onNewProject={vi.fn()} />)

  await click(host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="版本历史"]'))

  const activeTab = useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)
  expect(activeTab).toMatchObject({ name: '版本历史', type: 'version-history', projectKey: project.path })
  await vi.waitFor(() => expect(host.textContent).toContain('章节列表'))
})

it('U07.A04 Writer 编辑器标签前后页切换活跃正文', async () => {
  useProjectStore.setState({ currentProject: project })
  await render(<EditorArea onNewProject={vi.fn()} />)
  await act(async () => {
    useEditorStore.getState().openFile({ id: 'f05-a', name: '第一页', type: 'outline', content: '甲', projectKey: project.path })
    useEditorStore.getState().openFile({ id: 'f05-b', name: '第二页', type: 'outline', content: '乙', projectKey: project.path })
  })
  expect(useEditorStore.getState().activeTabId).toBe('f05-b')
  await click(host.querySelector<HTMLButtonElement>('button[title="上一个编辑器"]'))
  expect(useEditorStore.getState().activeTabId).toBe('f05-a')
  expect(host.textContent).toContain('甲')
  await click(host.querySelector<HTMLButtonElement>('button[title="下一个编辑器"]'))
  expect(useEditorStore.getState().activeTabId).toBe('f05-b')
  expect(host.textContent).toContain('乙')
})

it('U07.A05 Writer 已打开标签列表可重新选择标签', async () => {
  useProjectStore.setState({ currentProject: project })
  await render(<EditorArea onNewProject={vi.fn()} />)
  await act(async () => {
    useEditorStore.getState().openFile({ id: 'f05-a', name: '第一页', type: 'outline', content: '甲', projectKey: project.path })
    useEditorStore.getState().openFile({ id: 'f05-b', name: '第二页', type: 'outline', content: '乙', projectKey: project.path })
  })
  await click(host.querySelector<HTMLButtonElement>('button[title="已打开的编辑器"]'))
  const item = [...host.querySelectorAll<HTMLButtonElement>('.fixed.z-\\[9999\\] button')]
    .find(button => button.textContent?.includes('第一页'))
  await click(item ?? null)
  expect(useEditorStore.getState().activeTabId).toBe('f05-a')
  expect(host.textContent).toContain('甲')
})

it('Writer 草稿标签切换后点击角色栏目不会被旧标签 effect 拉回项目结构', async () => {
  useProjectStore.setState({ currentProject: project })
  await render(<EditorArea onNewProject={vi.fn()} />)
  await act(async () => {
    useEditorStore.getState().openFile({ id: 'f05-draft', name: '草稿', type: 'outline', content: '正文', projectKey: project.path })
    useEditorStore.getState().setActiveTab('config:' + encodeURIComponent(project.path))
  })
  await act(async () => {
    useEditorStore.getState().setActiveTab('f05-draft')
    host.querySelector<HTMLButtonElement>('.writer-left-rail button[title="角色"]')!.click()
  })
  expect(useEditorStore.getState().activeTabId).toBe('f05-draft')
  expect(useLayoutStore.getState()).toMatchObject({ sidebarView: 'characters', activeRailItem: 'characters' })
})
