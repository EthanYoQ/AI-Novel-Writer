/* eslint-disable react-refresh/only-export-components */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ShellV2 from '../ShellV2'
import TitleBar from '../../TitleBar'
import LeftToolWindowBar from '../../LeftToolWindowBar'
import RightToolWindowBar from '../../RightToolWindowBar'
import EditorArea from '../../../panels/EditorArea'
import AIPanel from '../../../panels/AIPanel'
import { useAppearanceStore } from '../../../../stores/appearance-bootstrap'
import { useAgentStore } from '../../../../stores/agent-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { ProjectData } from '../../../../shared/ipc-channels'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalAppearance = useAppearanceStore.getState()
const originalAgent = useAgentStore.getState()
const originalEditor = useEditorStore.getState()
const originalLayout = useLayoutStore.getState()
const originalLLM = useLLMStore.getState()
const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()
const originalBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
const project = { id: 'f05', name: '雨夜来信', path: 'C:/f05/rain', sessionLease: 'f05-lease', novelConfig: {} } as ProjectData
let host: HTMLDivElement
let root: Root

function WriterFixture() {
  const layout = useLayoutStore()
  return <ShellV2 presentation="writer" theme="paper" titleBar={<TitleBar />}
    rail={<LeftToolWindowBar />} rightRail={<RightToolWindowBar />}
    sidebar={<p>作品资料</p>} editor={<EditorArea onNewProject={vi.fn()} />}
    aiPanel={<AIPanel />}
    bottom={<p>任务与日志</p>} statusBar={<p>状态</p>}
    sidebarOpen={layout.sidebarOpen} aiPanelOpen={layout.aiPanelOpen}
    bottomOpen={layout.bottomPanelOpen} immersive={layout.immersive} />
}

async function click(selector: string) {
  const button = host.querySelector<HTMLElement>(selector)
  expect(button, selector).toBeTruthy()
  await act(async () => button!.click())
}

beforeEach(() => {
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: {
    invoke: vi.fn(async () => ({ success: true })), on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(),
  } })
  useAppearanceStore.setState({ resolvedShell: 'writer' })
  useAgentStore.setState({ showHistory: false, conversations: [], activeConversationId: null })
  useLLMStore.setState({ loaded: true })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project', sidebarOpen: true,
    aiPanelOpen: true, bottomPanelOpen: true, immersive: false, preImmersivePanels: null })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project })
  host = document.createElement('div')
  host.style.height = '800px'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useAppearanceStore.setState(originalAppearance, true)
  useAgentStore.setState(originalAgent, true)
  useEditorStore.setState(originalEditor, true)
  useLayoutStore.setState(originalLayout, true)
  useLLMStore.setState(originalLLM, true)
  useLocaleStore.setState(originalLocale, true)
  useProjectStore.setState(originalProject, true)
  if (originalBridge) Object.defineProperty(window, 'aiNovelAPI', originalBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('U07.A06 标签选择同步 Writer 栏目高亮与正文', async () => {
  await act(async () => root.render(<WriterFixture />))
  await act(async () => {
    useEditorStore.getState().openFile({ id: 'f05-blueprint', name: '章节蓝图', type: 'chapter-card', projectKey: project.path })
    useEditorStore.getState().openFile({ id: 'f05-outline', name: '大纲正文', type: 'outline', content: '测试大纲', projectKey: project.path })
  })
  const blueprintTab = [...host.querySelectorAll('.skin-workspace-page span')]
    .find(node => node.textContent === '章节蓝图')?.parentElement
  expect(blueprintTab).toBeTruthy()
  await act(async () => blueprintTab!.click())
  expect(useLayoutStore.getState()).toMatchObject({ sidebarView: 'project', activeRailItem: 'blueprint' })
  expect(host.querySelector('.writer-left-rail button[title="章节蓝图"]')?.className).toContain('is-active')
  await click('button[title="下一个编辑器"]')
  expect(useLayoutStore.getState()).toMatchObject({ sidebarView: 'project', activeRailItem: 'project' })
  expect(host.textContent).toContain('测试大纲')
})

it('U07.A07/A08 沉浸进入退出，打开助手退出且未发送输入仍在', async () => {
  await act(async () => root.render(<WriterFixture />))
  const input = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="输入消息，@ 提及，/ 使用工作流..."]')!
  expect(input).toBeTruthy()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(input, '草稿里的未发送提问')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(input.value).toBe('草稿里的未发送提问')
  await click('button[title="进入沉浸写作"]')
  expect(useLayoutStore.getState()).toMatchObject({ immersive: true, sidebarOpen: false, aiPanelOpen: false, bottomPanelOpen: false })
  expect(host.querySelector('[data-writer-immersive="true"]')).toBeTruthy()
  expect(host.querySelector('textarea[placeholder="输入消息，@ 提及，/ 使用工作流..."]')).toBe(input)
  await click('button[title="退出沉浸写作"]')
  expect(useLayoutStore.getState()).toMatchObject({ immersive: false, sidebarOpen: true, aiPanelOpen: true, bottomPanelOpen: true })
  await click('button[title="进入沉浸写作"]')
  await click('button[title="AI Agent 面板"]')
  expect(useLayoutStore.getState()).toMatchObject({ immersive: false, aiPanelOpen: true, rightView: 'agent' })
  expect(host.querySelector('textarea[placeholder="输入消息，@ 提及，/ 使用工作流..."]')).toBe(input)
  expect(input.value).toBe('草稿里的未发送提问')
})
