import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import DraftEditor from '../DraftEditor'

const PROJECT_PATH = 'C:\\novels\\revision-source'
const PROJECT_SESSION = Object.freeze({
  projectId: 'revision-source-project',
  leaseId: 'revision-source-lease',
  projectPath: PROJECT_PATH,
})
const SOURCE = '生成修订时的源稿 A。'
const CURRENT = `${SOURCE}作者后来保存的 B。`
const REVISION = 'AI 基于 A 生成的修订稿。'

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
const originalEditorState = useEditorStore.getState()
const originalProjectState = useProjectStore.getState()
const originalWorkflowState = useWorkflowStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:draft-get-meta') {
      return {
        id: 7,
        chapterNumber: 1,
        version: 1,
        status: 'draft',
        source: 'write',
        contentId: 70,
        wordCount: CURRENT.length,
        createdAt: '',
        updatedAt: '',
      }
    }
    if (channel === 'db:blueprint-get-all' || channel === 'db:review-list') return []
    if (channel === 'db:draft-list') return [{ id: 7, version: 1 }]
    if (channel === 'db:revision-get-pending') {
      return [{
        id: 31,
        baseDraftId: 7,
        revisionIndex: 1,
        revisionType: 'refine',
        status: 'pending',
        mergedToDraftId: null,
        userPrompt: '',
        reviewSourceId: null,
        sourceDraft: {
          id: 7,
          chapterNumber: 1,
          version: 1,
          status: 'draft',
          content: SOURCE,
        },
        contentId: 71,
        wordCount: REVISION.length,
        createdAt: '',
        updatedAt: '',
      }]
    }
    if (channel === 'db:revision-get-full') {
      return {
        id: 31,
        baseDraftId: 7,
        revisionIndex: 1,
        revisionType: 'refine',
        status: 'pending',
        mergedToDraftId: null,
        userPrompt: '',
        reviewSourceId: null,
        sourceDraft: {
          id: 7,
          chapterNumber: 1,
          version: 1,
          status: 'draft',
          content: SOURCE,
        },
        contentId: 71,
        wordCount: REVISION.length,
        createdAt: '',
        updatedAt: '',
        content: REVISION,
      }
    }
    if (channel === 'db:draft-get-full') return { id: 7, content: CURRENT }
    throw new Error(`Unexpected IPC channel: ${channel}`)
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
  useProjectStore.setState({
    currentProject: {
      id: PROJECT_SESSION.projectId,
      name: 'Revision source',
      path: PROJECT_PATH,
      sessionLease: PROJECT_SESSION.leaseId,
      novelConfig: { writingLanguage: 'zh-CN' },
    } as never,
  })
  setActiveProjectSessionContext(PROJECT_SESSION)
  useEditorStore.setState({
    tabs: [{
      id: 'draft-7',
      name: 'Chapter 1',
      type: 'chapter',
      filePath: 'vela://draft/7',
      content: CURRENT,
      savedContent: CURRENT,
      dirty: false,
      draftId: 7,
      draftStatus: 'draft',
      chapterNumber: 1,
      projectKey: PROJECT_PATH,
      projectSessionLease: PROJECT_SESSION.leaseId,
      contentRevision: 0,
    }],
    activeTabId: 'draft-7',
  })
  useWorkflowStore.setState({ activeRuns: [] })

  await act(async () => root.render(
    <DraftEditor
      tabId="draft-7"
      filePath="vela://draft/7"
      content={CURRENT}
      projectKey={PROJECT_PATH}
    />,
  ))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'velaAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.getState().clearTabs()
  useEditorStore.setState(originalEditorState)
  useProjectStore.setState(originalProjectState)
  useWorkflowStore.setState(originalWorkflowState)
})

describe('DraftEditor revision source binding', () => {
  it('shows an old revision against its frozen source but refuses to merge it into a newer saved draft', async () => {
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain('待合并(1)'))
      await page.getByRole('button', { name: '待合并(1)' }).click()
    })

    await expect.element(page.getByText('当前草稿已不是该修订稿的生成时源稿，修订仍可查看但不能合并。')).toBeVisible()
    const merge = document.querySelector('.three-way-merge')
    expect(merge?.textContent).toContain(SOURCE)
    expect(merge?.textContent).toContain(REVISION)

    await act(async () => page.getByRole('button', { name: '完成合并' }).click())
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:revision-merge')).toBe(false)
  })

  it('saves each dirty draft through its own retained handler after switching the active tab', async () => {
    await act(async () => root.unmount())
    root = createRoot(container)

    const firstContent = '第一章后台修改。'
    const secondContent = '第二章当前修改。'
    const tabs = [
      {
        id: 'draft-7', name: 'Chapter 1', type: 'chapter' as const,
        filePath: 'vela://draft/7', content: firstContent, savedContent: SOURCE,
        dirty: true, draftId: 7, draftStatus: 'draft' as const, chapterNumber: 1,
        projectKey: PROJECT_PATH, projectSessionLease: PROJECT_SESSION.leaseId, contentRevision: 1,
      },
      {
        id: 'draft-8', name: 'Chapter 2', type: 'chapter' as const,
        filePath: 'vela://draft/8', content: secondContent, savedContent: '第二章旧稿。',
        dirty: true, draftId: 8, draftStatus: 'draft' as const, chapterNumber: 2,
        projectKey: PROJECT_PATH, projectSessionLease: PROJECT_SESSION.leaseId, contentRevision: 1,
      },
    ]
    useEditorStore.setState({ tabs, activeTabId: 'draft-7', draftLedgers: {} })
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:draft-get-meta') {
        const id = Number(args[0])
        return {
          id,
          chapterNumber: id === 7 ? 1 : 2,
          version: 1,
          status: 'draft',
          source: 'write',
          contentId: id * 10,
          wordCount: id === 7 ? firstContent.length : secondContent.length,
          createdAt: '',
          updatedAt: '',
        }
      }
      if (channel === 'db:draft-list') return [{ id: 7, version: 1 }, { id: 8, version: 1 }]
      if (channel === 'db:blueprint-get-all' || channel === 'db:review-list' || channel === 'db:revision-get-pending') return []
      if (channel === 'db:draft-update-content') return { success: true }
      throw new Error(`Unexpected IPC channel: ${channel}`)
    })

    await act(async () => root.render(
      <DraftEditor key="draft-7" tabId="draft-7" filePath="vela://draft/7" content={firstContent} projectKey={PROJECT_PATH} />,
    ))
    useEditorStore.getState().setActiveTab('draft-8')
    await act(async () => root.render(
      <DraftEditor key="draft-8" tabId="draft-8" filePath="vela://draft/8" content={secondContent} projectKey={PROJECT_PATH} />,
    ))

    await act(async () => saveDirtyEditorChangesForExit(PROJECT_PATH))

    const writes = invoke.mock.calls.filter(([channel]) => channel === 'db:draft-update-content')
    expect(writes.map(([, id, content]) => [id, content])).toEqual([
      [7, firstContent],
      [8, secondContent],
    ])
    expect(useEditorStore.getState().activeTabId).toBe('draft-8')
    expect(useEditorStore.getState().tabs.every(tab => !tab.dirty)).toBe(true)
  })
})
