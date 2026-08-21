import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../shared/ipc-channels'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useProjectStore } from '../../../stores/project-store'
import ChapterCardEditor from '../ChapterCardEditor'

const PROJECT_PATH = 'C:\\novels\\chapter-write-entry'
const originalEditorState = useEditorStore.getState()
const originalLayoutState = useLayoutStore.getState()
const originalProjectState = useProjectStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

function project(): ProjectData {
  return {
    id: 'chapter-write-entry',
    sessionLease: 'chapter-write-entry-lease',
    name: '章节入口测试项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 1,
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

function blueprint(chapterNumber: number): ChapterBlueprint {
  return {
    chapterNumber,
    title: '雨夜启程',
    role: '建置',
    purpose: '建立主角的首个目标。',
    keyEvents: '收到匿名信。',
    characters: ['沈砺'],
    suspenseHook: '信封背面出现陌生署名。',
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
  }
}

function installIpc() {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:blueprint-get-all') return [blueprint(1)]
    if (channel === 'db:draft-get-max-finalized-chapter') return null
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
}

async function renderEditor() {
  await act(async () => {
    root?.render(<ChapterCardEditor projectKey={PROJECT_PATH} />)
  })
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useLayoutStore.setState({ chapterCreationOpen: false, chapterCreationPrefill: null })
  useProjectStore.setState({ currentProject: project(), fileTree: [], loading: false })
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'velaAPI')
  useEditorStore.setState(originalEditorState)
  useLayoutStore.setState(originalLayoutState)
  useProjectStore.setState(originalProjectState)
})

describe('ChapterCardEditor writing entry', () => {
  it('shows Write Chapter 1 after blueprints are available and opens the chapter-creation workbench', async () => {
    await renderEditor()

    await vi.waitFor(() => {
      expect(container?.textContent).toContain('写作第1章')
    })
    const writeButton = Array.from(container?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.includes('写作第1章'))

    expect(writeButton).toBeDefined()
    await act(async () => writeButton?.click())

    expect(useLayoutStore.getState()).toMatchObject({
      chapterCreationOpen: true,
      chapterCreationPrefill: expect.objectContaining({ chapterNumber: 1, title: '雨夜启程' }),
    })
  })
})
