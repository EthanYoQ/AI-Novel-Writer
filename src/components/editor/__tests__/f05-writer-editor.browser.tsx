import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { userEvent } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import '../../../index.css'
import ShellV2 from '../../layout/v2/ShellV2'
import EditorArea from '../../panels/EditorArea'
import { useAppearanceStore } from '../../../stores/appearance-bootstrap'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalEditor = useEditorStore.getState()
const originalAppearance = useAppearanceStore.getState()
const originalLayout = useLayoutStore.getState()
const originalLocale = useLocaleStore.getState()
const originalProject = useProjectStore.getState()
const originalBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
const projectPath = 'C:/f05/writer-editor'

const isMac = /Mac/.test(navigator.platform)

let host: HTMLDivElement
let root: Root

async function renderChapter(content: string) {
  useEditorStore.setState({
    tabs: [{
      id: 'chapter-1', name: '第一章 雨夜', type: 'chapter',
      filePath: `${projectPath}/第一章.md`, projectKey: projectPath,
      content, savedContent: content, dirty: false,
    }],
    activeTabId: 'chapter-1',
  })
  await act(async () => root.render(
    <ShellV2 theme="paper"
      titleBar={<span>雨夜来信</span>} rail={<span>导航</span>}
      sidebar={<span>作品资料</span>} editor={<EditorArea onNewProject={vi.fn()} />}
      aiPanel={<span>助手</span>} bottom={<span>任务</span>} statusBar={<span>状态</span>} />,
  ))
  await act(async () => useEditorStore.getState().setActiveTab('chapter-1'))
  expect(host.querySelector('[data-shell-presentation="writer"]')).toBeTruthy()
  return EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
}

beforeEach(() => {
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: {
    invoke: vi.fn(async () => ({ success: true })), on: vi.fn(() => () => {}),
  } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useAppearanceStore.setState({ resolvedShell: 'writer' })
  useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project' })
  useProjectStore.setState({ currentProject: {
    id: 'f05-writer-editor', name: '雨夜来信', path: projectPath,
    sessionLease: 'f05-editor-lease', novelConfig: {},
  } as never })
  host = document.createElement('div')
  host.style.height = '800px'
  host.style.setProperty('--font-writing', 'Georgia, serif')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useEditorStore.setState(originalEditor, true)
  useAppearanceStore.setState(originalAppearance, true)
  useLayoutStore.setState(originalLayout, true)
  useLocaleStore.setState(originalLocale, true)
  useProjectStore.setState(originalProject, true)
  if (originalBridge) Object.defineProperty(window, 'aiNovelAPI', originalBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('U06.A01 Writer 正文编辑时实时预览 Markdown，源文本仍完整', async () => {
  const view = await renderChapter('# 雨夜\n\n林岚看见 **灯火**。\n\n雨声渐远。')
  await act(async () => view.focus())
  await act(async () => userEvent.keyboard(isMac ? '{Meta>}{ArrowDown}{/Meta}' : '{Control>}{End}{/Control}'))
  await vi.waitFor(() => {
    const heading = host.querySelector<HTMLElement>('.cm-lp-h1')?.cloneNode(true) as HTMLElement | undefined
    heading?.querySelector('.cm-lp-paperhead')?.remove()
    expect(heading?.textContent?.trim()).toBe('雨夜')
    expect(host.querySelector('.cm-lp-paperhead')?.textContent).toContain('第一章 雨夜')
    expect(host.querySelector('.cm-lp-strong')?.textContent).toBe('灯火')
  })
  await act(async () => userEvent.keyboard('风'))
  await vi.waitFor(() => expect(view.state.doc.toString()).toBe('# 雨夜\n\n林岚看见 **灯火**。\n\n雨声渐远。风'))
  expect(host.querySelector('.cm-lp-strong')?.textContent).toBe('灯火')
})

it('U06.A02 Writer 章节纸页展示页眉与首字下沉', async () => {
  await renderChapter('林岚推开窗。\n\n雨还在下。')
  await vi.waitFor(() => expect(host.querySelector('.cm-lp-dropcap-char')?.textContent).toBe('林'))
  expect(host.querySelector('.cm-lp-paperhead')?.textContent ?? '').toContain('第一章 雨夜')
})

it('U06.A06 Writer Tab 插入两字宽缩进并使用写作字体', async () => {
  const view = await renderChapter('林岚推开窗。')
  const content = host.querySelector<HTMLElement>('.cm-content')!
  await act(async () => view.focus())
  await act(async () => userEvent.keyboard(isMac ? '{Meta>}{ArrowUp}{/Meta}{Tab}' : '{Control>}{Home}{/Control}{Tab}'))
  expect.soft(view.state.doc.toString()).toBe('\u2003\u2003林岚推开窗。')
  expect(view.state.selection.main.head).toBe(2)
  expect(getComputedStyle(content).fontFamily).toContain('Georgia')
})

it('U06.A06 Writer Tab 对多行选区保留原行缩进', async () => {
  const view = await renderChapter('甲行\n乙行')
  await act(async () => {
    view.focus()
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
  })
  await act(async () => userEvent.keyboard('{Tab}'))
  expect(view.state.doc.toString()).toBe('  甲行\n  乙行')
})

it('U06.A07 Writer 字数随正文编辑更新', async () => {
  const view = await renderChapter('林岚 walked.')
  await vi.waitFor(() => expect(host.textContent).toContain('3 字'))
  await act(async () => view.focus())
  await act(async () => userEvent.keyboard(isMac ? '{Meta>}{ArrowDown}{/Meta}又' : '{Control>}{End}{/Control}又'))
  await vi.waitFor(() => {
    expect(view.state.doc.toString()).toBe('林岚 walked.又')
    expect(host.textContent).toContain('4 字')
  })
})
