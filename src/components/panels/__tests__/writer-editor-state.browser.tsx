import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'
import EditorArea from '../EditorArea'

const projectPath = 'C:\\novels\\writer-editor-state'
const originalEditorState = useEditorStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalProjectState = useProjectStore.getState()
const originalBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(async () => {
  useProjectStore.setState({
    currentProject: {
      id: 'writer-editor-state',
      name: '保留编辑状态',
      path: projectPath,
      sessionLease: 'writer-editor-state-lease',
      novelConfig: {},
    } as never,
  })
  useEditorStore.setState({
    tabs: [{
      id: 'chapter-1',
      name: '第一章',
      type: 'chapter',
      filePath: `${projectPath}\\第一章.md`,
      projectKey: projectPath,
      content: '甲乙丙',
      savedContent: '甲乙丙',
      dirty: false,
    }],
    activeTabId: 'chapter-1',
    openFile: vi.fn(),
  })
  useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project' })
  invoke = vi.fn(async (channel: string) => channel === 'update:get-state'
    ? { status: 'disabled', currentVersion: '', isReminderDeferred: false }
    : { success: true })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
    },
  })
  container = document.createElement('div')
  container.style.height = '600px'
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<EditorArea onNewProject={vi.fn()} />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useEditorStore.setState(originalEditorState, true)
  useLayoutStore.setState(originalLayoutState, true)
  useProjectStore.setState(originalProjectState, true)
  if (originalBridge) Object.defineProperty(window, 'aiNovelAPI', originalBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
})

it('栏目往返保留同一正文编辑器、选区与 undo 历史', async () => {
  const editorNode = container.querySelector<HTMLElement>('.cm-editor')!
  const view = EditorView.findFromDOM(editorNode)!
  await act(async () => view.dispatch({
    changes: { from: 1, insert: '新' },
    selection: { anchor: 2 },
  }))
  expect(view.state.doc.toString()).toBe('甲新乙丙')
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: '甲新乙丙', dirty: true })

  await act(async () => useLayoutStore.setState({ sidebarView: 'home', activeRailItem: 'home' }))
  expect(container.textContent).toContain('新建项目')
  const retainedWorkspace = editorNode.closest<HTMLElement>('.skin-workspace-page')!
  expect(retainedWorkspace.hidden).toBe(true)
  expect(getComputedStyle(retainedWorkspace).display).toBe('none')

  await act(async () => useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project' }))
  const returnedNode = container.querySelector<HTMLElement>('.cm-editor')!
  const returnedView = EditorView.findFromDOM(returnedNode)!
  expect(returnedNode).toBe(editorNode)
  expect(returnedView.state.doc.toString()).toBe('甲新乙丙')
  expect(returnedView.state.selection.main.head).toBe(2)
  expect(retainedWorkspace.hidden).toBe(false)
  expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
  await act(async () => {
    returnedNode.querySelector<HTMLElement>('.cm-content')!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }))
  })
  expect(returnedView.state.doc.toString()).toBe('甲乙丙')
})

it('普通正文保存失败可重试，按钮与快捷键不会产生未处理拒绝', async () => {
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!
  await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: '新稿' } }))
  invoke.mockResolvedValueOnce({ success: false, error: '磁盘已满' })

  const saveButton = container.querySelector<HTMLButtonElement>('[title="保存（⌘S）"]')!
  await act(async () => saveButton.click())
  await vi.waitFor(() => expect(container.textContent).toContain('保存失败'))
  expect(useEditorStore.getState().tabs[0].dirty).toBe(true)

  await act(async () => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
    key: 's', ctrlKey: true, bubbles: true, cancelable: true,
  })))
  await vi.waitFor(() => expect(container.textContent).toContain('已保存'))
  expect(useEditorStore.getState().tabs[0].dirty).toBe(false)
})
