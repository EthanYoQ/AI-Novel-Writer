import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EditorArea from '../EditorArea'
import { useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'

const previousEditor = useEditorStore.getState(), previousProject = useProjectStore.getState(), previousLocale = useLocaleStore.getState()
const previousBridge = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount()); container?.remove()
  useEditorStore.setState(previousEditor, true); useProjectStore.setState(previousProject, true); useLocaleStore.setState(previousLocale, true)
  if (previousBridge) Object.defineProperty(window, 'aiNovelAPI', previousBridge)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
  vi.restoreAllMocks()
})

it.each(['merged', 'discarded'])('已%s的审修结果在实际编辑器只读显示，不能进入物理文件保存', async status => {
  const invoke = vi.fn(async () => { throw new Error('Readonly revision must not write') })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  const projectPath = 'C:/合成只读审修'
  useProjectStore.setState({ currentProject: { id: '只读审修', path: projectPath, name: '只读审修', sessionLease: '当前会话', novelConfig: {} } as never })
  useLocaleStore.setState({ locale: 'zh-CN' })
  // The author has already opened this saved result; suppress the initial config-tab navigation in this screen fixture.
  useEditorStore.setState({ tabs: [{ id: '已保存修稿', name: `已${status}修稿`, type: 'chapter', filePath: 'ai-novel://revision/9',
    content: '林岚从海港带回了信。', savedContent: '林岚从海港带回了信。', dirty: false, projectKey: projectPath, draftStatus: 'archived' }],
    activeTabId: '已保存修稿', openFile: vi.fn() })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<EditorArea onNewProject={() => {}} />))
  await vi.waitFor(() => expect(container!.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false'))
  expect(container.textContent).toContain('林岚从海港带回了信。')
  const content = container.querySelector<HTMLElement>('.cm-content')!
  await act(async () => { content.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })) })
  expect(invoke).not.toHaveBeenCalled()
  expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: false, content: '林岚从海港带回了信。' })
  expect(container.querySelector('button[title="保存（⌘S）"]')).toBeNull()
})
