import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useEditorStore } from '../../../stores/editor-store'
import DirectChapterImportDialog from '../DirectChapterImportDialog'

const PROJECT_PATH = 'C:\\novels\\direct-chapter-import'
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()
const originalEditorState = useEditorStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let onClose: ReturnType<typeof vi.fn>
let invoke: ReturnType<typeof vi.fn>

function project(): ProjectData {
  return {
    id: 'direct-chapter-import',
    sessionLease: 'direct-chapter-import-lease',
    name: '直接新增章节测试项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '奇幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 5,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '完整的故事构想',
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

function installIpc() {
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'db:draft-authority-sequence') {
          return {
            status: 'continuous',
            lastChapterNumber: 2,
            nextChapterNumber: 3,
            duplicateChapterNumbers: [],
            authorityFingerprint: 'a'.repeat(64),
          }
        }
        if (channel === 'db:blueprint-get') return null
        if (channel === 'db:blueprint-upsert') return { success: true }
        if (channel === 'db:draft-create') return { success: true, id: 42 }
        if (channel === 'db:draft-get-meta') {
          return {
            id: 42,
            chapterNumber: 3,
            version: 2,
            status: 'draft',
            source: 'write',
            contentId: 9,
            wordCount: 5,
            sourceDependencies: [],
            dependenciesStale: false,
            createdAt: '',
            updatedAt: '',
          }
        }
        if (channel === 'fs:list-dir') return []
        if (channel === 'db:draft-list-all') return []
        throw new Error(`Unexpected IPC channel: ${channel}`)
      }),
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
  invoke = window.aiNovelAPI!.invoke as unknown as ReturnType<typeof vi.fn>
}

function chapterNumberInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="number"]')
  if (!input) throw new Error('Missing chapter number input')
  return input
}

async function renderDialog() {
  await act(async () => root?.render(<DirectChapterImportDialog isOpen onClose={onClose} />))
}

async function clickSave() {
  await act(async () => page.getByRole('button', { name: '保存为草稿' }).click())
}

beforeEach(() => {
  onClose = vi.fn()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project() })
  setActiveProjectSessionContext({
    projectId: 'direct-chapter-import',
    leaseId: 'direct-chapter-import-lease',
    projectPath: PROJECT_PATH,
  })
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

describe('DirectChapterImportDialog', () => {
  it('defaults the chapter number to the authoritative next chapter', async () => {
    await renderDialog()
    await vi.waitFor(() => expect(chapterNumberInput().value).toBe('3'))
  })

  it('rejects an empty body without touching persistence', async () => {
    await renderDialog()
    await vi.waitFor(() => expect(chapterNumberInput().value).toBe('3'))
    await clickSave()
    await vi.waitFor(() => expect(document.body.textContent).toContain('正文不能为空'))
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:draft-create')).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('saves blueprint and draft, opens the editor tab and closes', async () => {
    await renderDialog()
    await vi.waitFor(() => expect(chapterNumberInput().value).toBe('3'))
    await page.getByPlaceholder('粘贴本章完整正文...').fill('林岚推开门，雪落了满肩。')
    await clickSave()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())

    const channels = invoke.mock.calls.map(([channel]) => channel)
    expect(channels).toContain('db:blueprint-upsert')
    expect(channels).toContain('db:draft-create')
    const created = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')
    expect(created![1]).toMatchObject({ chapterNumber: 3, source: 'write' })

    const tabs = useEditorStore.getState().tabs
    expect(tabs.some(tab => tab.filePath === 'ai-novel://draft/42')).toBe(true)
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
  useEditorStore.setState(originalEditorState, true)
})
