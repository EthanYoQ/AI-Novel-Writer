import { act } from 'react'
import { EditorView } from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../../stores/editor-store'
import { toast } from '../../ui/Toast'
import ArchFileViewer from '../ArchFileViewer'

const PROJECT_PATH = 'C:\\novels\\arch-locale'
const project: ProjectData = {
  id: 'arch-locale-project',
  sessionLease: 'arch-locale-lease',
  name: 'Architecture locale',
  path: PROJECT_PATH,
  novelConfig: {
    genre: '', subGenre: '', targetAudience: '', totalChapters: 4, wordsPerChapter: 2500,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '',
    goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  },
  characterStates: '',
  createdAt: '',
  updatedAt: '',
}

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalEditorState = useEditorStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  useLocaleStore.setState({ locale: 'en-US', initialized: true })
  useProjectStore.setState({ currentProject: project, fileTree: [], loading: false })
  setActiveProjectSessionContext({
    projectId: project.id,
    leaseId: project.sessionLease!,
    projectPath: PROJECT_PATH,
  })
  invoke = vi.fn().mockResolvedValue({ success: true })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useEditorStore.setState(originalEditorState)
  vi.restoreAllMocks()
})

describe('ArchFileViewer locale', () => {
  it.each([
    ['premise', '故事前提'],
    ['characters', '角色图谱'],
    ['worldbuilding', '世界观'],
    ['synopsis', '情节大纲'],
  ])('recognizes the actual core protocol %s and restores generation controls', async (key, label) => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    await act(async () => root.render(
      <ArchFileViewer tabId={`arch-${key}`} filePath={`vela://core/${key}`}
        projectKey={PROJECT_PATH} content="" savedContent="" />,
    ))
    expect(container.textContent).toContain(label)
    expect(container.querySelector(`[title="AI 生成「${label}」"]`)).not.toBeNull()
    if (key === 'characters') {
      expect(container.textContent).toContain('角色图谱由角色名单自动生成，只读展示')
      expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
      const editor = container.querySelector('.cm-editor') as HTMLElement
      const view = EditorView.findFromDOM(editor)!
      expect(view.state.readOnly).toBe(true)
      await act(async () => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', code: 'Tab', bubbles: true, cancelable: true,
      })))
      expect(view.state.doc.toString()).toBe('')
      expect(container.querySelector('[title="保存（Cmd+S）"]')).toBeNull()
    } else if (key === 'premise') {
      const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
      expect(view.state.readOnly).toBe(false)
      await act(async () => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', code: 'Tab', bubbles: true, cancelable: true,
      })))
      expect(view.state.doc.toString()).toBe('  ')
    }
  })

  it('reports a rejected save without clearing the draft and rejects exit-save', async () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => {})
    invoke.mockResolvedValue({ success: false, error: '磁盘已满' })
    useEditorStore.setState({ tabs: [{
      id: 'arch-save-error', name: '故事前提', type: 'arch-file',
      projectKey: PROJECT_PATH, filePath: 'vela://core/premise',
      content: '未保存的故事前提', savedContent: '', dirty: true,
    }], draftLedgers: {} })
    await act(async () => root.render(
      <ArchFileViewer tabId="arch-save-error" filePath="vela://core/premise"
        projectKey={PROJECT_PATH} content="未保存的故事前提" savedContent="" />,
    ))
    await act(async () => (container.querySelector('[title="保存（Cmd+S）"]') as HTMLButtonElement).click())
    expect(errorToast).toHaveBeenCalledWith(expect.stringContaining('磁盘已满'))
    expect(container.textContent).toContain('未保存的故事前提')
    expect(container.querySelector('[title="有未保存的修改"]')).not.toBeNull()
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ dirty: true, savedContent: '' })
    await act(async () => {
      await expect(saveDirtyEditorChangesForExit(PROJECT_PATH)).rejects.toThrow('磁盘已满')
    })
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
  })

  it('renders document controls and empty guidance in English', async () => {
    const generatedContent = 'A'.repeat(60)
    await act(async () => root.render(
      <ArchFileViewer
        tabId="arch-premise"
        filePath="C:\\novels\\premise.md"
        projectKey={PROJECT_PATH}
        content={generatedContent}
        savedContent=""
      />,
    ))

    await vi.waitFor(() => expect(container.textContent).toContain('characters'))
    expect(container.textContent).toContain('Save')
    expect(container.textContent).toContain('AI Regenerate')
    expect(container.querySelector('[title="Unsaved changes"]')).not.toBeNull()
    expect(container.querySelector('[title="Save (Cmd+S)"]')).not.toBeNull()
    expect(container.querySelector('[title="AI Regenerate “Premise”"]')).not.toBeNull()
    expect(container.textContent).not.toMatch(/字|保存|重新生成/)

    let finishSave: ((value: { success: true }) => void) | undefined
    invoke.mockImplementation(() => new Promise(resolve => { finishSave = resolve }))
    await act(async () => Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.includes('Save'))?.click())
    await vi.waitFor(() => expect(container.textContent).toContain('Saving...'))
    await act(async () => finishSave?.({ success: true }))

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => root.render(
      <ArchFileViewer
        tabId="arch-empty-premise"
        filePath="C:\\novels\\premise.md"
        projectKey={PROJECT_PATH}
        content=""
        savedContent=""
      />,
    ))

    await vi.waitFor(() => expect(container.textContent).toContain('AI Generate'))
    expect(container.querySelector('[title="AI Generate “Premise”"]')).not.toBeNull()
    expect(container.textContent).toContain('No content yet. Click “AI Generate” in the top-right or start editing here...')
    expect(container.textContent).not.toMatch(/尚未生成内容|AI 生成/)
  })
})
