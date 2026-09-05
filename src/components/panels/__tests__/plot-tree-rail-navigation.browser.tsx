import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useProjectStore } from '../../../stores/project-store'
import LeftToolWindowBar from '../../layout/LeftToolWindowBar'
import { openBuiltinEditor } from '../sidebar/sidebar-file-openers'
import EditorArea from '../EditorArea'

const PROJECT_PATH = 'C:\\novels\\plot-tree-rail'
const PROJECT_B_PATH = 'C:\\novels\\plot-tree-rail-b'
let root: Root | undefined
let container: HTMLDivElement | undefined

const originalEditorState = useEditorStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalLLMState = useLLMStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function button(label: string): HTMLButtonElement {
  const match = Array.from(container!.querySelectorAll('button'))
    .find(candidate => candidate.textContent?.trim() === label)
  if (!match) throw new Error(`button not found: ${label}`)
  return match
}

function selectedTab(label: string): boolean {
  return container!
    .querySelector<HTMLElement>(`[role="tab"][aria-selected="true"]`)
    ?.textContent?.trim() === label
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  const project: ProjectData = {
    id: 'plot-tree-rail-project',
    name: '剧情树导航测试',
    path: PROJECT_PATH,
    sessionLease: 'plot-tree-rail-lease',
    novelConfig: {
      genre: '',
      subGenre: '',
      targetAudience: '',
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
  useProjectStore.setState({ currentProject: project, fileTree: [], loading: false })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useLayoutStore.setState({ sidebarOpen: true, sidebarView: 'project', activeRailItem: 'project' })
  useLLMStore.setState({
    models: [],
    defaultModelId: null,
    loaded: true,
  })
  setActiveProjectSessionContext({
    projectId: project.id,
    leaseId: project.sessionLease!,
    projectPath: project.path,
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'db:plot-tree-read') {
          return {
            writingLanguage: 'zh-CN',
            synopsis: { content: '' },
            blueprints: [],
            finalizedChapters: [],
            narrativeThreads: [],
            sourceRevision: '0'.repeat(64),
            snapshot: null,
          }
        }
        if (channel === 'db:narrative-thread-list') return []
        if (channel === 'db:draft-list-all') return []
        if (channel === 'db:blueprint-get-all') return []
        throw new Error(`unexpected IPC ${channel}`)
      }),
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(
    <div>
      <LeftToolWindowBar />
      <EditorArea onNewProject={vi.fn()} />
    </div>,
  ))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(originalEditorState)
  useLayoutStore.setState(originalLayoutState)
  useLLMStore.setState(originalLLMState)
  useProjectStore.setState(originalProjectState)
})

describe('plot-tree left rail navigation', () => {
  it('opens a project-scoped chapter blueprint tab after switching projects', async () => {
    await act(async () => button('蓝图').click())
    await vi.waitFor(() => expect(useEditorStore.getState().tabs)
      .toContainEqual(expect.objectContaining({ type: 'chapter-card', projectKey: PROJECT_PATH })))

    const projectA = useProjectStore.getState().currentProject!
    const projectB = {
      ...projectA,
      id: 'plot-tree-rail-project-b',
      name: '剧情树导航测试 B',
      path: PROJECT_B_PATH,
      sessionLease: 'plot-tree-rail-lease-b',
    }
    await act(async () => {
      useProjectStore.setState({ currentProject: projectB })
      setActiveProjectSessionContext({
        projectId: projectB.id,
        leaseId: projectB.sessionLease,
        projectPath: projectB.path,
      })
    })

    await act(async () => button('蓝图').click())
    await vi.waitFor(() => {
      const state = useEditorStore.getState()
      expect(state.tabs.find(tab => tab.id === state.activeTabId))
        .toMatchObject({ type: 'chapter-card', projectKey: PROJECT_B_PATH })
    })

    expect(useEditorStore.getState().tabs.filter(tab => tab.type === 'chapter-card'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ projectKey: PROJECT_PATH }),
        expect.objectContaining({ projectKey: PROJECT_B_PATH }),
      ]))
    expect(container?.textContent).not.toContain('此标签属于另一个项目')
  })

  it('returns an existing narrative editor to plot tree without losing the plan form', async () => {
    await act(async () => button('剧情').click())
    await vi.waitFor(() => expect(selectedTab('剧情树')).toBe(true))

    await act(async () => button('计划清单').click())
    expect(selectedTab('计划清单')).toBe(true)
    const title = container!.querySelector<HTMLInputElement>('input')!
    await act(async () => setInputValue(title, '不应丢失的计划'))
    expect(title.value).toBe('不应丢失的计划')

    await act(async () => button('剧情').click())
    await vi.waitFor(() => expect(selectedTab('剧情树')).toBe(true))

    await act(async () => button('计划清单').click())
    expect(container!.querySelector<HTMLInputElement>('input')?.value)
      .toBe('不应丢失的计划')

    await act(async () => openBuiltinEditor(
      'narrative-thread-editor',
      '伏笔与叙事线索',
      'narrative-thread',
    ))
    await vi.waitFor(() => expect(selectedTab('计划清单')).toBe(true))
    expect(container!.querySelector<HTMLInputElement>('input')?.value)
      .toBe('不应丢失的计划')
  })
})
