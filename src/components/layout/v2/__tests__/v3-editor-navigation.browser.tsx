import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'

import '../../../../index.css'
import EditorArea from '../../../panels/EditorArea'
import LeftToolWindowBar from '../../LeftToolWindowBar'
import { useAppearanceStore } from '../../../../stores/appearance-bootstrap'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useProjectStore } from '../../../../stores/project-store'
import ShellV2 from '../ShellV2'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const editorBefore = useEditorStore.getState()
const layoutBefore = useLayoutStore.getState()
const projectBefore = useProjectStore.getState()
const appearanceBefore = useAppearanceStore.getState()
const bridgeBefore = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
const projectPath = 'C:/v3/editor-journey'
const initialBody = '# 雨夜\n\n林岚发现 **线索**。'

afterEach(() => {
  useEditorStore.setState(editorBefore, true)
  useLayoutStore.setState(layoutBefore, true)
  useProjectStore.setState(projectBefore, true)
  useAppearanceStore.setState(appearanceBefore, true)
  if (bridgeBefore) Object.defineProperty(window, 'aiNovelAPI', bridgeBefore)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('V3 real editor keeps preview, dirty/undo and save through shelf navigation', async () => {
  function Fixture() {
    const home = useLayoutStore(state => state.sidebarView === 'home')
    return <ShellV2 theme="light" home={home}
      titleBar={<span>雨夜来信</span>} rail={<LeftToolWindowBar />}
      sidebar={<span>项目结构</span>} editor={<EditorArea onNewProject={vi.fn()} />}
      aiPanel={<span>写作助手</span>} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />
  }
  await page.viewport(1440, 900)
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:draft-get-meta') return { id: 1, version: 1, chapterNumber: 1, status: 'draft', source: 'write' }
    if (channel === 'db:draft-update-content') return { success: true }
    return []
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: vi.fn(() => () => {}) } })
  useAppearanceStore.setState({ resolvedShell: 'writer' })
  useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project' })
  useProjectStore.setState({ currentProject: {
    id: 'v3-editor', name: '雨夜来信', path: projectPath, sessionLease: 'v3-editor-lease', novelConfig: {},
  } as never })
  useEditorStore.setState({ tabs: [{ id: 'draft-1', name: '第一章', type: 'chapter',
    filePath: 'ai-novel://draft/1', projectKey: projectPath, content: initialBody,
    savedContent: initialBody, dirty: false, draftStatus: 'draft' }], activeTabId: 'draft-1' })

  const host = document.createElement('div')
  host.style.height = '900px'
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Fixture />))
    await act(async () => useEditorStore.getState().setActiveTab('draft-1'))
    await vi.waitFor(() => expect(host.querySelector('.cm-editor')).toBeTruthy())
    const editor = host.querySelector<HTMLElement>('.cm-editor')!
    const view = EditorView.findFromDOM(editor)!
    expect(view.state.doc.toString()).toBe(initialBody)
    expect(getComputedStyle(editor).borderTopWidth).toBe('3px')
    await vi.waitFor(() => expect(host.querySelector('.cm-lp-strong')?.textContent).toBe('线索'))

    await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '新句' } }))
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true)
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="欢迎页"]')!.click())
    expect(host.querySelector('.cm-editor')).toBe(editor)
    expect(view.state.doc.toString()).toBe(initialBody + '新句')
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="项目"]')!.click())
    expect(host.querySelector('.cm-editor')).toBe(editor)
    await act(async () => view.focus())
    await act(async () => userEvent.keyboard(/Mac/.test(navigator.platform) ? '{Meta>}z{/Meta}' : '{Control>}z{/Control}'))
    expect(view.state.doc.toString()).toBe(initialBody)
    await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '新句' } }))
    expect(view.state.doc.toString()).toBe(initialBody + '新句')
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="保存（⌘S）"]')!.click())
    await vi.waitFor(() => expect(useEditorStore.getState().tabs[0]?.dirty).toBe(false))
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:draft-update-content')).toBe(true)
    await page.screenshot({ path: '../../../../../.runtime/.cache/novel-quality-modernization/v3-editor-navigation-browser.png' })
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
