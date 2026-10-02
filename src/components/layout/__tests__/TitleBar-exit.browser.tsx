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
    // 「取消退出」不再单设按钮：右上角的 X（无障碍名「关闭」）就是它。
    await act(async () => page.getByRole('button', { name: '关闭' }).click())
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

    await act(async () => page.getByRole('button', { name: '关闭' }).click())

    // 关闭（X）本身不是禁用按钮，处理期间重复点它由 exitBusy 早退挡住；
    // 两个真正的出口必须锁死。
    await expect.element(page.getByRole('button', { name: '放弃并退出' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: '处理中...' })).toBeDisabled()
    await act(async () => cancellation.resolve({ success: true }))
    await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull())
  })

  it('names the editor that still holds unsaved edits and jumps there on request', async () => {
    useProjectStore.setState({
      recentProjects: [{ name: '本机退出验证', path: PROJECT, updatedAt: '' }],
    })
    useEditorStore.setState({
      tabs: [{
        id: 'chapter-b',
        name: '第七章 · 雪夜',
        type: 'chapter',
        projectKey: PROJECT,
        content: '未保存正文',
        dirty: true,
      }],
      activeTabId: null,
    })
    await act(async () => root.render(<TitleBar />))
    await act(async () => closeRequested?.({ requestId: 'close-detail' }))

    // 哪部作品、哪个地方 —— 两样都要说清楚，而不是笼统一句「未保存内容」
    await expect.element(page.getByText('本机退出验证')).toBeVisible()
    await expect.element(page.getByText('章节正文')).toBeVisible()
    await expect.element(page.getByText('第七章 · 雪夜')).toBeVisible()

    await act(async () => page.getByRole('button', { name: '前往此处' }).click())

    // 去看一眼不等于要退出：先撤销关窗请求，再把人送到那条内容所在的页面
    expect(invoke).toHaveBeenCalledWith('window:resolve-close', 'close-detail', 'cancel')
    expect(invoke).not.toHaveBeenCalledWith('window:resolve-close', 'close-detail', 'proceed')
    expect(useEditorStore.getState().activeTabId).toBe('chapter-b')
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true)
    await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull())
  })

  it('labels another work that still holds unsaved drafts', async () => {
    const otherWork = 'C:\\novels\\another-work'
    useProjectStore.setState({
      recentProjects: [
        { name: '本机退出验证', path: PROJECT, updatedAt: '' },
        { name: '海上花', path: otherWork, updatedAt: '' },
      ],
    })
    // 后台草稿账本：上一部作品的配置改了没保存，页面已经收起来了
    useEditorStore.setState({
      tabs: [],
      draftLedgers: {
        config: JSON.stringify({
          version: 1,
          projects: [{ projectKey: otherWork, baseValue: {}, draftValue: { genre: '未保存配置' } }],
        }),
      },
    })
    await act(async () => root.render(<TitleBar />))
    await act(async () => closeRequested?.({ requestId: 'close-other-work' }))

    await expect.element(page.getByText('海上花')).toBeVisible()
    await expect.element(page.getByText(otherWork)).toBeVisible()
    await expect.element(page.getByText('小说配置')).toBeVisible()
    // 「另一部作品」是那条草稿的归属徽标 —— 作品名与徽标文案不同名，这里才定位唯一
    await expect.element(page.getByText('另一部作品')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '前往此处' })).toBeVisible()
  })

  it('blocks native close while the current project has an active workflow', async () => {
    useEditorStore.setState({ tabs: [], draftLedgers: {} })
    useWorkflowStore.setState({
      activeRuns: [{ projectPath: PROJECT, status: 'running' }] as never,
    })
    await act(async () => root.render(<TitleBar />))

    await act(async () => closeRequested?.({ requestId: 'close-workflow' }))

    // h1 是弹窗标头的可见标题；sr-only 的无障碍标题同为这句，故按层级定位
    await expect.element(page.getByRole('heading', { level: 1, name: '创作任务仍在运行' })).toBeVisible()
    await expect.element(page.getByText('请先等待当前创作任务完成，或在任务面板中取消任务后再退出。')).toBeVisible()
    expect(invoke).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(1)
    expect(useWorkflowStore.getState().activeRuns[0]?.status).toBe('running')
    await expect.element(page.getByRole('button', { name: '放弃并退出' })).not.toBeInTheDocument()
    await act(async () => page.getByRole('button', { name: '知道了' }).click())
    expect(invoke).toHaveBeenCalledWith('window:resolve-close', 'close-workflow', 'cancel')
  })
})
