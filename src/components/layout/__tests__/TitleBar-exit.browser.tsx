import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import {
  registerEditorExitSaveHandler,
  useEditorStore,
} from '../../../stores/editor-store'
import TitleBar from '../TitleBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = 'C:\\novels\\native-exit'
const originalEditorState = useEditorStore.getState()
const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let closeRequested: ((payload: { requestId: string }) => void) | undefined

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

beforeEach(() => {
  useEditorStore.getState().clearTabs()
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({
    currentProject: {
      id: 'native-exit',
      sessionLease: 'native-exit-lease',
      name: 'Native exit',
      path: PROJECT,
      novelConfig: {},
    } as never,
  })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useWorkflowStore.setState({ activeRuns: [] })
  invoke = vi.fn(async () => ({ success: true }))
  closeRequested = undefined
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn((channel: string, callback: (payload: { requestId: string }) => void) => {
        if (channel === 'window:close-requested') closeRequested = callback
        return () => { closeRequested = undefined }
      }),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useEditorStore.setState(originalEditorState)
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState(originalLocaleState)
  Reflect.deleteProperty(window, 'velaAPI')
})

describe('TitleBar native exit settlement', () => {
  it('lets a clean system close proceed without prompting', async () => {
    await act(async () => root.render(<TitleBar />))

    await act(async () => closeRequested?.({ requestId: 'close-clean' }))

    expect(invoke).toHaveBeenCalledWith('window:resolve-close', 'close-clean', 'proceed')
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('supports cancel, save, and discard without losing a failed or newly edited draft', async () => {
    useEditorStore.setState({
      tabs: [{
        id: 'draft-a',
        name: '第一章',
        type: 'chapter',
        projectKey: PROJECT,
        content: 'AB',
        contentRevision: 2,
        dirty: true,
      }],
    })
    await act(async () => root.render(<TitleBar />))

    await act(async () => closeRequested?.({ requestId: 'close-cancel' }))
    await expect.element(page.getByRole('dialog')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '取消' }).click())
    expect(invoke).toHaveBeenCalledWith('window:resolve-close', 'close-cancel', 'cancel')
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true)

    registerEditorExitSaveHandler({
      tabId: 'draft-a',
      type: 'chapter',
      projectKey: PROJECT,
      save: async () => {
        useEditorStore.getState().updateTabContent('draft-a', 'ABC')
        useEditorStore.getState().settleTabSave('draft-a', { content: 'AB', contentRevision: 2 })
      },
    })
    await act(async () => closeRequested?.({ requestId: 'close-save-race' }))
    await act(async () => page.getByRole('button', { name: '保存并退出' }).click())
    await expect.element(page.getByText('保存期间仍有未保存修改，已取消退出')).toBeVisible()
    expect(invoke).not.toHaveBeenCalledWith('window:resolve-close', 'close-save-race', 'proceed')
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'ABC', dirty: true })
    useEditorStore.setState({
      draftLedgers: {
        config: JSON.stringify({
          version: 1,
          projects: [{ projectKey: PROJECT, baseValue: {}, draftValue: { genre: '未保存配置' } }],
        }),
      },
    })
    let ledgerWasClearedBeforeReclose = false
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'window:close') {
        ledgerWasClearedBeforeReclose = JSON.parse(
          useEditorStore.getState().draftLedgers.config,
        ).projects.length === 0
        closeRequested?.({ requestId: 'close-after-discard' })
      }
      return { success: true }
    })

    await act(async () => page.getByRole('button', { name: '放弃并退出' }).click())
    expect(invoke).toHaveBeenCalledWith('window:resolve-close', 'close-save-race', 'cancel')
    expect(invoke).toHaveBeenCalledWith('window:close')
    expect(invoke).toHaveBeenCalledWith('window:resolve-close', 'close-after-discard', 'proceed')
    expect(ledgerWasClearedBeforeReclose).toBe(true)
    expect(useEditorStore.getState().tabs.some(tab => tab.dirty)).toBe(false)
    expect(JSON.parse(useEditorStore.getState().draftLedgers.config).projects).toEqual([])
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it.each([
    ['business failure', () => Promise.resolve({ success: false }), '退出请求已失效，请重试'],
    ['transport rejection', () => Promise.reject(new Error('IPC unavailable')), 'IPC unavailable'],
  ] as const)('keeps unsaved changes when discard-and-exit hits a %s', async (_label, failure, errorText) => {
    useEditorStore.setState({
      tabs: [{
        id: 'draft-a',
        name: '第一章',
        type: 'chapter',
        projectKey: PROJECT,
        content: '未保存正文',
        dirty: true,
      }],
    })
    invoke.mockImplementationOnce(failure)
    await act(async () => root.render(<TitleBar />))

    await act(async () => closeRequested?.({ requestId: 'close-rejected' }))
    await act(async () => page.getByRole('button', { name: '放弃并退出' }).click())

    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      content: '未保存正文',
      dirty: true,
    })
    await expect.element(page.getByText(errorText)).toBeVisible()
  })

  it('locks every exit action while cancellation is settling', async () => {
    useEditorStore.setState({
      tabs: [{ id: 'draft-a', name: '第一章', type: 'chapter', projectKey: PROJECT, dirty: true }],
    })
    const cancellation = deferred<{ success: boolean }>()
    invoke.mockReturnValueOnce(cancellation.promise)
    await act(async () => root.render(<TitleBar />))
    await act(async () => closeRequested?.({ requestId: 'close-busy' }))

    await act(async () => page.getByRole('button', { name: '取消' }).click())

    await expect.element(page.getByRole('button', { name: '取消' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: '放弃并退出' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: '处理中...' })).toBeDisabled()
    await act(async () => cancellation.resolve({ success: true }))
    await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull())
  })

  it('blocks native close while the current project has an active workflow', async () => {
    useEditorStore.setState({ tabs: [], draftLedgers: {} })
    useWorkflowStore.setState({
      activeRuns: [{ projectPath: PROJECT, status: 'running' }] as never,
    })
    await act(async () => root.render(<TitleBar />))

    await act(async () => closeRequested?.({ requestId: 'close-workflow' }))

    await expect.element(page.getByText('创作任务仍在运行')).toBeVisible()
    await expect.element(page.getByText('请先等待当前创作任务完成，或在任务面板中取消任务后再退出。')).toBeVisible()
    expect(invoke).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(1)
    expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('running')
    await expect.element(page.getByRole('button', { name: '放弃并退出' })).not.toBeInTheDocument()
    await act(async () => page.getByRole('button', { name: '知道了' }).click())
    expect(invoke).toHaveBeenCalledWith('window:resolve-close', 'close-workflow', 'cancel')
  })
})
